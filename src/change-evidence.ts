import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
const NoMatchSchema = z.object({ code: z.literal(1), stderr: z.string() });
const MAX_FILE_BYTES = 64_000;
const MAX_ENTRIES = 10_000;
const MAX_LISTING_BYTES = 256_000_000;
const CAPTURE_TIMEOUT_MS = 5000;
const gitEnvironment = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
const excludedDirectories: Record<string, true> = {
  ".git": true,
  ".hg": true,
  ".svn": true,
  node_modules: true,
  vendor: true,
  dist: true,
  build: true,
  coverage: true,
  target: true,
  ".next": true,
  ".nuxt": true,
  out: true,
  __pycache__: true,
  ".venv": true,
  venv: true,
  Pods: true,
  ".dart_tool": true,
};
const excludedFiles: Record<string, true> = {
  ".npmrc": true,
  ".netrc": true,
  ".pypirc": true,
  id_rsa: true,
  id_ed25519: true,
  "credentials.json": true,
  "package-lock.json": true,
  "yarn.lock": true,
  "pnpm-lock.yaml": true,
  "bun.lock": true,
  "Cargo.lock": true,
  "poetry.lock": true,
  "uv.lock": true,
};

interface SourceFile {
  file: string;
  source: string;
}

interface SourceLine {
  text: string;
  line: number;
}

export type CaptureFailure =
  | "aborted"
  | "timeout"
  | "root-unavailable"
  | "git-failed"
  | "ignore-rules-without-git"
  | "entry-limit"
  | "enumeration-failed"
  | "storage-failed"
  | "unexpected-error";

export type BaselineCapture =
  | { status: "available"; baseline: TaskBaseline }
  | { status: "unavailable"; reason: CaptureFailure };

type OverlayEntry =
  | { kind: "copy"; name: string }
  | { kind: "absent" }
  | { kind: "excluded" }
  | { kind: "unknown" };

interface HeadFile {
  oid: string;
  size: number;
}

interface PinnedHead {
  toplevel: string;
  files: ReadonlyMap<string, HeadFile>;
  tree: string;
}

type BeforeState =
  | { state: "present"; source: string }
  | { state: "absent" }
  | { state: "unknown" };

interface OriginSearch {
  origins: SourceFile[];
  complete: boolean;
}

export interface ChangeEvidence {
  status: "available" | "unavailable";
  before: SourceFile | null;
  after: SourceFile;
  diff: string | null;
  origins: readonly SourceFile[];
  reason: string | null;
}

class CaptureError extends Error {
  readonly reason: CaptureFailure;

  constructor(reason: CaptureFailure, cause?: unknown) {
    super(reason, { cause });
    this.reason = reason;
  }
}

async function attempt<T>(
  reason: CaptureFailure,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw new CaptureError(reason, error);
  }
}

function eligible(file: string): boolean {
  const parts = file.split("/");
  return (
    parts.every((part) => !Object.hasOwn(excludedDirectories, part)) &&
    !Object.hasOwn(excludedFiles, path.posix.basename(file)) &&
    !/(?:^|\/)\.env(?:\.|$)/iu.test(file) &&
    !/\.(?:pem|key|p12|pfx)$/iu.test(file)
  );
}

function relativeFile(root: string, file: string): string | undefined {
  const relative = path.relative(root, path.resolve(root, file));
  return relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative) ||
    file.includes("\\") ||
    /\p{Cc}/u.test(file)
    ? undefined
    : relative.split(path.sep).join("/");
}

function safeFiles(root: string, files: Iterable<string>): string[] {
  const result: string[] = [];
  for (const requested of files) {
    const file = relativeFile(root, requested);
    if (file !== undefined && eligible(file)) result.push(file);
  }
  return result;
}

function sourceLines(source: string): SourceLine[] {
  return source.split("\n").flatMap((text, index) => {
    const normalized = text.trim();
    return normalized.length >= 6 && /[\p{L}_$]/u.test(normalized)
      ? [{ text: normalized, line: index + 1 }]
      : [];
  });
}

function decodeText(bytes: Uint8Array): string | null {
  return bytes.includes(0)
    ? null
    : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function git(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  const { stdout } = await execute("git", args, {
    cwd,
    env: gitEnvironment,
    signal,
    maxBuffer: MAX_LISTING_BYTES,
  });
  return stdout;
}

function nulSeparated(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

async function readBlobs(
  toplevel: string,
  oids: readonly string[],
  signal: AbortSignal | undefined,
): Promise<Buffer[]> {
  const pending = execute("git", ["cat-file", "--batch"], {
    cwd: toplevel,
    env: gitEnvironment,
    encoding: "buffer",
    maxBuffer: oids.length * (MAX_FILE_BYTES + 128),
    ...(signal === undefined ? {} : { signal }),
  });
  pending.child.stdin?.end(`${oids.join("\n")}\n`);
  const { stdout } = await pending;
  const blobs: Buffer[] = [];
  let offset = 0;
  while (blobs.length < oids.length) {
    const end = stdout.indexOf(10, offset);
    const [, type, size] = stdout
      .subarray(offset, end)
      .toString("utf8")
      .split(" ", 3);
    if (type !== "blob") throw new Error("Git object is unavailable");
    offset = end + 1 + Number(size) + 1;
    blobs.push(stdout.subarray(end + 1, offset - 1));
  }
  return blobs;
}

function rejectUnsupported(entries: number, name: string): void {
  if (entries > MAX_ENTRIES) throw new CaptureError("entry-limit");
  if (name === ".gitignore") throw new CaptureError("ignore-rules-without-git");
}

async function directoryFiles(
  root: string,
  signal: AbortSignal,
): Promise<string[]> {
  const pending = [""];
  const files: string[] = [];
  let entries = 0;
  for (const directory of pending) {
    const contents = await attempt("enumeration-failed", () =>
      opendir(path.join(root, directory)),
    );
    for await (const entry of contents) {
      signal.throwIfAborted();
      entries += 1;
      rejectUnsupported(entries, entry.name);
      const file = path.posix.join(directory, entry.name);
      if (!eligible(file)) continue;
      if (entry.isDirectory()) pending.push(file);
      else files.push(file);
    }
  }
  return files;
}

async function isWorkTree(root: string, signal: AbortSignal): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--is-inside-work-tree"], signal);
    return true;
  } catch {
    signal.throwIfAborted();
    return false;
  }
}

async function optionalRevision(
  root: string,
  revision: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    return (
      await git(root, ["rev-parse", "--verify", "--quiet", revision], signal)
    ).trim();
  } catch {
    signal.throwIfAborted();
    return undefined;
  }
}

interface PinnedGit {
  head: PinnedHead | undefined;
  dirty: Set<string>;
  excluded: string[];
}

async function pinGit(root: string, signal: AbortSignal): Promise<PinnedGit> {
  const toplevel = (
    await git(root, ["rev-parse", "--show-toplevel"], signal)
  ).trim();
  const commit = await optionalRevision(root, "HEAD^{commit}", signal);
  const tree =
    commit === undefined
      ? undefined
      : await optionalRevision(root, `${commit}:./`, signal);
  const dirty = new Set<string>();
  for (const entry of nulSeparated(
    await git(
      root,
      ["ls-files", "-v", "-z", "--cached", "--others", "--exclude-standard"],
      signal,
    ),
  )) {
    if (tree === undefined || !entry.startsWith("H "))
      dirty.add(entry.slice(2));
  }
  if (commit === undefined || tree === undefined)
    return { head: undefined, dirty, excluded: [] };
  for (const file of nulSeparated(
    await git(
      root,
      [
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        "--ignore-submodules=all",
        "--relative",
        commit,
        "--",
      ],
      signal,
    ),
  ))
    dirty.add(file);
  const files = new Map<string, HeadFile>();
  const excluded: string[] = [];
  for (const entry of nulSeparated(
    await git(toplevel, ["ls-tree", "-r", "-l", "-z", tree], signal),
  )) {
    const tab = entry.indexOf("\t");
    const [mode, , oid = "", size] = entry.slice(0, tab).split(/ +/u, 4);
    const [file] = safeFiles(root, [entry.slice(tab + 1)]);
    if (file === undefined) continue;
    if (mode !== "100644" && mode !== "100755") {
      excluded.push(file);
      continue;
    }
    files.set(file, { oid, size: Number(size) });
  }
  return { head: { toplevel, files, tree }, dirty, excluded };
}

async function captureFile(
  root: string,
  file: string,
  buffer: Buffer,
): Promise<string | null | undefined> {
  const absolute = path.join(root, file);
  if ((await realpath(absolute)) !== absolute) {
    return null;
  }
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      return null;
    }
    if (before.size > MAX_FILE_BYTES) {
      return undefined;
    }
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    const stable =
      bytesRead === before.size &&
      after.size === before.size &&
      after.mtimeMs === before.mtimeMs &&
      after.ctimeMs === before.ctimeMs;
    return stable ? decodeText(buffer.subarray(0, bytesRead)) : undefined;
  } finally {
    await handle.close();
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

export class TaskBaseline {
  readonly root: string;
  readonly requestedRoot: string;
  readonly complete: boolean;
  private readonly head: PinnedHead | undefined;
  private readonly overlay: ReadonlyMap<string, OverlayEntry>;
  private readonly excluded: ReadonlySet<string>;
  private readonly storage: string;

  constructor(options: {
    root: string;
    requestedRoot: string;
    head: PinnedHead | undefined;
    overlay: ReadonlyMap<string, OverlayEntry>;
    excluded: ReadonlySet<string>;
    storage: string;
  }) {
    this.root = options.root;
    this.requestedRoot = options.requestedRoot;
    this.head = options.head;
    this.overlay = options.overlay;
    this.excluded = options.excluded;
    this.storage = options.storage;
    this.complete = true;
    for (const entry of options.overlay.values())
      if (entry.kind === "unknown") this.complete = false;
  }

  get fileCount(): number {
    let count = 0;
    for (const file of this.head?.files.keys() ?? [])
      if (!this.overlay.has(file)) count += 1;
    for (const entry of this.overlay.values())
      if (entry.kind === "copy") count += 1;
    return count;
  }

  get overlayCount(): number {
    return this.overlay.size;
  }

  async dispose(): Promise<void> {
    try {
      await rm(this.storage, { recursive: true, force: true });
    } catch {
      return;
    }
  }

  unattributable(file: string): boolean {
    const parts = file.split("/");
    return parts.some((_, index) => {
      const prefix = parts.slice(0, index + 1).join("/");
      const kind = this.overlay.get(prefix)?.kind;
      return kind === undefined
        ? this.excluded.has(prefix)
        : kind === "excluded" || kind === "unknown";
    });
  }

  async before(file: string, signal?: AbortSignal): Promise<BeforeState> {
    let source: string | null | undefined;
    const entry = this.overlay.get(file);
    const blob = this.head?.files.get(file);
    if (entry !== undefined) {
      if (entry.kind !== "copy") return { state: "absent" };
      source = await this.readCopy(entry.name);
    } else if (this.head === undefined || blob === undefined) {
      return { state: "absent" };
    } else if (blob.size <= MAX_FILE_BYTES) {
      [source] = await headTexts(this.head, [blob], signal);
    }
    return typeof source === "string"
      ? { state: "present", source }
      : { state: "unknown" };
  }

  async origins(
    file: string,
    lines: readonly SourceLine[],
    line: number,
    signal?: AbortSignal,
  ): Promise<OriginSearch> {
    const blocks = [...findingBlocks(lines, line)];
    const anchor = lines.find((entry) => entry.line === line)?.text;
    if (blocks.length === 0 || anchor === undefined)
      return { origins: [], complete: this.complete };
    const candidates: SourceFile[] = [];
    let complete = this.complete;
    for (const [origin, entry] of this.overlay) {
      if (origin === file || entry.kind !== "copy") continue;
      const source = await this.readCopy(entry.name);
      if (source === undefined) complete = false;
      else if (source.includes(anchor))
        candidates.push({ file: origin, source });
    }
    const head = await this.headCandidates(file, anchor, signal);
    complete &&= head.complete;
    candidates.push(...head.origins);
    candidates.sort((left, right) => left.file.localeCompare(right.file));
    return { origins: matchingOrigins(candidates, blocks), complete };
  }

  private async headCandidates(
    file: string,
    anchor: string,
    signal: AbortSignal | undefined,
  ): Promise<OriginSearch> {
    const head = this.head;
    if (head === undefined) return { origins: [], complete: true };
    const hits: { file: string; blob: HeadFile }[] = [];
    const search = await grepHead(head, anchor, signal);
    let complete = search.complete;
    for (const hit of search.hits) {
      const blob = head.files.get(hit);
      if (hit === file || blob === undefined || this.overlay.has(hit)) continue;
      if (blob.size > MAX_FILE_BYTES) complete = false;
      else hits.push({ file: hit, blob });
    }
    const sources = await headTexts(
      head,
      hits.map(({ blob }) => blob),
      signal,
    );
    const origins: SourceFile[] = [];
    for (const [index, { file: origin }] of hits.entries()) {
      const source = sources.at(index);
      if (typeof source === "string") origins.push({ file: origin, source });
      else complete = false;
    }
    return { origins, complete };
  }

  private async readCopy(name: string): Promise<string | undefined> {
    try {
      return await readFile(path.join(this.storage, name), "utf8");
    } catch {
      return undefined;
    }
  }
}

async function headTexts(
  head: PinnedHead,
  blobs: readonly HeadFile[],
  signal: AbortSignal | undefined,
): Promise<(string | null)[]> {
  if (blobs.length === 0) return [];
  const contents = await readBlobs(
    head.toplevel,
    blobs.map((blob) => blob.oid),
    signal,
  );
  return contents.map((bytes) => {
    try {
      return decodeText(bytes);
    } catch {
      return null;
    }
  });
}

async function grepHead(
  head: PinnedHead,
  anchor: string,
  signal: AbortSignal | undefined,
): Promise<{ hits: string[]; complete: boolean }> {
  let output: { stdout: string; stderr: string };
  try {
    output = await execute(
      "git",
      ["grep", "-z", "-l", "-F", "-I", "--no-color", "-e", anchor, head.tree],
      {
        cwd: head.toplevel,
        env: gitEnvironment,
        maxBuffer: MAX_LISTING_BYTES,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch (error) {
    const parsed = NoMatchSchema.safeParse(error);
    if (!parsed.success) throw error;
    output = { stdout: "", stderr: parsed.data.stderr };
  }
  return {
    hits: nulSeparated(output.stdout).map((hit) =>
      hit.slice(head.tree.length + 1),
    ),
    complete: output.stderr.length === 0,
  };
}

async function copyOverlay(
  root: string,
  files: Iterable<string>,
  signal: AbortSignal,
): Promise<{
  overlay: Map<string, OverlayEntry>;
  storage: string;
}> {
  const storage = await attempt("storage-failed", () =>
    mkdtemp(path.join(tmpdir(), "pi-pair-programmer-baseline-")),
  );
  const overlay = new Map<string, OverlayEntry>();
  const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
  try {
    for (const file of files) {
      signal.throwIfAborted();
      if (!(await exists(path.join(root, file)))) {
        overlay.set(file, { kind: "absent" });
        continue;
      }
      let source: string | null | undefined;
      try {
        source = await captureFile(root, file, buffer);
      } catch {
        source = undefined;
      }
      if (typeof source !== "string") {
        overlay.set(file, { kind: source === null ? "excluded" : "unknown" });
        continue;
      }
      const name = String(overlay.size);
      await attempt("storage-failed", () =>
        writeFile(path.join(storage, name), source, {
          mode: 0o600,
          flag: "wx",
        }),
      );
      overlay.set(file, { kind: "copy", name });
    }
  } catch (error) {
    await rm(storage, { recursive: true, force: true });
    throw error;
  }
  return { overlay, storage };
}

export async function captureBaseline(
  root: string,
  signal?: AbortSignal,
): Promise<BaselineCapture> {
  const deadline = AbortSignal.timeout(CAPTURE_TIMEOUT_MS);
  const captureSignal =
    signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  try {
    captureSignal.throwIfAborted();
    const canonical = await attempt("root-unavailable", () => realpath(root));
    const pinned: PinnedGit = (await isWorkTree(canonical, captureSignal))
      ? await attempt("git-failed", () => pinGit(canonical, captureSignal))
      : {
          head: undefined,
          dirty: new Set(await directoryFiles(canonical, captureSignal)),
          excluded: [],
        };
    const { overlay, storage } = await copyOverlay(
      canonical,
      safeFiles(canonical, pinned.dirty),
      captureSignal,
    );
    return {
      status: "available",
      baseline: new TaskBaseline({
        root: canonical,
        requestedRoot: path.resolve(root),
        head: pinned.head,
        overlay,
        excluded: new Set(pinned.excluded),
        storage,
      }),
    };
  } catch (error) {
    if (signal?.aborted === true)
      return { status: "unavailable", reason: "aborted" };
    if (deadline.aborted) return { status: "unavailable", reason: "timeout" };
    return {
      status: "unavailable",
      reason: error instanceof CaptureError ? error.reason : "unexpected-error",
    };
  }
}

function* findingBlocks(
  lines: readonly SourceLine[],
  line: number,
): Generator<{ lines: readonly SourceLine[]; anchor: number }> {
  const anchor = lines.findIndex((entry) => entry.line === line);
  if (anchor === -1) {
    return;
  }
  for (let length = 3; length <= 5; length += 1) {
    const first = Math.max(0, anchor - length + 1);
    for (let start = first; start <= anchor; start += 1) {
      const block = lines.slice(start, start + length);
      if (
        block.length === length &&
        block.reduce((size, entry) => size + entry.text.length, 0) >= 96
      ) {
        yield { lines: block, anchor: anchor - start };
      }
    }
  }
}

function* matchingOffsets(
  source: readonly SourceLine[],
  block: readonly SourceLine[],
): Generator<number> {
  for (let offset = 0; offset <= source.length - block.length; offset += 1) {
    if (
      block.every(
        (entry, index) => entry.text === source.at(offset + index)?.text,
      )
    ) {
      yield offset;
    }
  }
}

function matchingOrigins(
  candidates: readonly SourceFile[],
  blocks: readonly { lines: readonly SourceLine[]; anchor: number }[],
): SourceFile[] {
  const indexed = candidates.map((origin) => ({
    origin,
    lines: sourceLines(origin.source),
  }));
  const matches = new Map<string, SourceFile>();
  for (const block of blocks) {
    for (const { origin, lines } of indexed) {
      for (const offset of matchingOffsets(lines, block.lines)) {
        const key = `${origin.file}:${String(offset + block.anchor)}`;
        matches.set(key, origin);
        if (matches.size > 1) {
          return [...matches.values()];
        }
      }
    }
  }
  return [...matches.values()];
}

function sourceDiff(before: SourceFile, after: SourceFile): string {
  const oldLines = before.source.split("\n");
  const newLines = after.source.split("\n");
  let start = 0;
  while (start < oldLines.length && oldLines.at(start) === newLines.at(start)) {
    start += 1;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const contextStart = Math.max(0, start - 3);
  const contextEnd = Math.min(oldLines.length - oldEnd, 3);
  const changes = [
    ...oldLines.slice(contextStart, start).map((text) => ` ${text}`),
    ...oldLines.slice(start, oldEnd).map((text) => `-${text}`),
    ...newLines.slice(start, newEnd).map((text) => `+${text}`),
    ...oldLines.slice(oldEnd, oldEnd + contextEnd).map((text) => ` ${text}`),
  ];
  return `--- ${before.file}\n+++ ${after.file}\n@@ -${String(contextStart + 1)},${String(oldEnd - contextStart + contextEnd)} +${String(contextStart + 1)},${String(newEnd - contextStart + contextEnd)} @@\n${changes.join("\n")}`;
}

export async function buildChangeEvidence(
  baseline: TaskBaseline | undefined,
  file: string,
  source: string,
  line: number,
  quote: string,
  signal?: AbortSignal,
): Promise<ChangeEvidence> {
  const relative =
    baseline === undefined
      ? undefined
      : (relativeFile(baseline.root, file) ??
        relativeFile(baseline.requestedRoot, file));
  const evidence: ChangeEvidence = {
    status: "unavailable",
    before: null,
    after: { file: relative ?? file, source },
    diff: null,
    origins: [],
    reason: "Task baseline or eligible file is unavailable",
  };
  if (
    baseline === undefined ||
    relative === undefined ||
    !eligible(relative) ||
    baseline.unattributable(relative)
  ) {
    return evidence;
  }
  if (
    Buffer.byteLength(source) > MAX_FILE_BYTES ||
    !Number.isSafeInteger(line) ||
    line < 1 ||
    quote.trim().length === 0 ||
    source.split("\n")[line - 1]?.includes(quote) !== true
  ) {
    evidence.reason = "Current source is oversized or finding is not anchored";
    return evidence;
  }
  let before: BeforeState;
  let search: OriginSearch;
  try {
    [before, search] = await Promise.all([
      baseline.before(relative, signal),
      baseline.origins(relative, sourceLines(source), line, signal),
    ]);
  } catch {
    evidence.reason = "Task baseline could not be read";
    return evidence;
  }
  if (before.state === "unknown") {
    evidence.reason = "Task-start state of this file is unknown";
    return evidence;
  }
  if (before.state === "present")
    evidence.before = { file: relative, source: before.source };
  evidence.origins = search.origins;
  if (search.origins.length > 1) {
    evidence.reason = "Multiple baseline blocks match; origin is ambiguous";
    return evidence;
  }
  if (evidence.before === null && !search.complete) {
    evidence.reason =
      "Incomplete baseline cannot prove a unique cross-file origin";
    return evidence;
  }
  const original = evidence.before ?? search.origins[0];
  if (original === undefined) {
    evidence.reason =
      "No substantial matching baseline block or same-file source";
    return evidence;
  }
  evidence.diff = sourceDiff(original, evidence.after);
  evidence.status = "available";
  evidence.reason = null;
  return evidence;
}
