import { execFile } from "node:child_process";
import type * as FileSystem from "node:fs/promises";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  buildChangeEvidence,
  captureBaseline,
  type TaskBaseline,
} from "../src/change-evidence.js";

const fileSystem = vi.hoisted(() => ({
  changing: new Map<string, string>(),
  onOpen: undefined as (() => void) | undefined,
  failWrite: false,
  failRemove: false,
  failIteration: false,
  created: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FileSystem>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      fileSystem.onOpen?.();
      const handle = await original.open(...args);
      const replacement = fileSystem.changing.get(String(args[0]));
      if (replacement !== undefined) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
          const before = await stat();
          await original.writeFile(args[0], replacement);
          await original.utimes(args[0], 1, 1);
          return before;
        });
      }
      return handle;
    },
    mkdtemp: async (prefix: string) => {
      const directory = await original.mkdtemp(prefix);
      fileSystem.created.push(directory);
      return directory;
    },
    writeFile: async (...args: Parameters<typeof original.writeFile>) => {
      if (fileSystem.failWrite) throw new Error("disk full");
      await original.writeFile(...args);
    },
    rm: async (...args: Parameters<typeof original.rm>) => {
      if (fileSystem.failRemove) throw new Error("busy");
      await original.rm(...args);
    },
    opendir: async (...args: Parameters<typeof original.opendir>) => {
      const directory = await original.opendir(...args);
      if (!fileSystem.failIteration) return directory;
      return {
        async *[Symbol.asyncIterator]() {
          await directory.close();
          yield* [];
          throw new Error("directory changed during iteration");
        },
      };
    },
  };
});

const execute = promisify(execFile);
let root: string;
const baselines: TaskBaseline[] = [];
const legacy = [
  "export function loadCustomer(customerId: string) {",
  "  const cacheKey = `customer-record:${customerId}`;",
  "  const cachedRecord = customerCache.get(cacheKey);",
  "  return JSON.parse(cachedRecord.serializedValue);",
  "}",
  "",
].join("\n");
const quote = "JSON.parse(cachedRecord.serializedValue)";

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pair-programmer-baseline-"));
});

afterEach(async () => {
  fileSystem.changing.clear();
  fileSystem.onOpen = undefined;
  fileSystem.failWrite = false;
  fileSystem.failRemove = false;
  fileSystem.failIteration = false;
  vi.restoreAllMocks();
  await Promise.all(baselines.splice(0).map((baseline) => baseline.dispose()));
  await chmod(root, 0o755);
  await rm(root, { recursive: true, force: true });
});

async function capture(
  directory = root,
  signal?: AbortSignal,
): Promise<TaskBaseline> {
  const result = await captureBaseline(directory, signal);
  if (result.status === "unavailable") throw new Error(result.reason);
  baselines.push(result.baseline);
  return result.baseline;
}

async function failure(
  directory = root,
  signal?: AbortSignal,
): Promise<string> {
  const result = await captureBaseline(directory, signal);
  if (result.status === "available") {
    baselines.push(result.baseline);
    return "available";
  }
  return result.reason;
}

async function initializeGit(): Promise<void> {
  await execute("git", ["init", "--initial-branch=main", "--quiet"], {
    cwd: root,
  });
}

async function commitFiles(): Promise<void> {
  await execute("git", ["add", "."], { cwd: root });
  await execute(
    "git",
    [
      "-c",
      "user.name=Baseline Test",
      "-c",
      "user.email=baseline@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "baseline",
    ],
    { cwd: root },
  );
}

it("finds committed main code after its original file has been deleted", async () => {
  await initializeGit();
  await writeFile(path.join(root, "original.ts"), legacy);
  await commitFiles();
  const index = await readFile(path.join(root, ".git/index"));
  const baseline = await capture();
  expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
  expect(await readFile(path.join(root, "original.ts"), "utf8")).toBe(legacy);
  await rename(path.join(root, "original.ts"), path.join(root, "moved.ts"));
  const evidence = await buildChangeEvidence(
    baseline,
    "moved.ts",
    legacy,
    4,
    quote,
  );
  expect(evidence).toMatchObject({
    status: "available",
    before: null,
    after: { file: "moved.ts", source: legacy },
    origins: [{ file: "original.ts", source: legacy }],
    reason: null,
  });
  expect(evidence.diff).toContain("--- original.ts\n+++ moved.ts");
});

it("attributes against a repository whose eligible sources exceed four megabytes", async () => {
  await initializeGit();
  await Promise.all(
    Array.from({ length: 80 }, (_, index) =>
      writeFile(
        path.join(root, `filler-${String(index)}.ts`),
        `export const filler${String(index)} = "${"x".repeat(60_000)}";\n`,
      ),
    ),
  );
  await writeFile(path.join(root, "original.ts"), legacy);
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules/vendored.ts"), legacy);
  await commitFiles();
  const baseline = await capture();
  expect(baseline.fileCount).toBe(81);
  expect(baseline.complete).toBe(true);
  await rename(path.join(root, "original.ts"), path.join(root, "moved.ts"));
  const signal = new AbortController().signal;
  expect(
    await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote, signal),
  ).toMatchObject({
    status: "available",
    origins: [{ file: "original.ts", source: legacy }],
  });
  const edited = legacy.replace("serializedValue", "payload");
  await writeFile(path.join(root, "filler-0.ts"), edited);
  expect(
    await buildChangeEvidence(
      baseline,
      "filler-0.ts",
      edited,
      4,
      "JSON.parse(cachedRecord.payload)",
    ),
  ).toMatchObject({
    status: "available",
    before: { file: "filler-0.ts" },
  });
});

it("freezes dirty, staged, untracked, and deleted paths without touching the repository", async () => {
  await initializeGit();
  for (const file of ["dirty.ts", "staged.ts", "deleted.ts"])
    await writeFile(path.join(root, file), legacy);
  await commitFiles();
  const dirty = legacy.replace("customerCache", "dirtyCache");
  const staged = legacy.replace("customerCache", "stagedCache");
  const untracked = legacy.replace("customerCache", "untrackedCache");
  await writeFile(path.join(root, "dirty.ts"), dirty);
  await writeFile(path.join(root, "staged.ts"), staged);
  await execute("git", ["add", "staged.ts"], { cwd: root });
  await writeFile(path.join(root, "untracked.ts"), untracked);
  await rm(path.join(root, "deleted.ts"));
  const status = await execute("git", ["status", "--porcelain"], {
    cwd: root,
  });
  const index = await readFile(path.join(root, ".git/index"));
  const created = fileSystem.created.length;
  const baseline = await capture();
  const storage = fileSystem.created.at(created);
  if (storage === undefined) throw new Error("Missing baseline storage");
  expect(path.relative(root, storage).startsWith("..")).toBe(true);
  expect(await readFile(path.join(root, ".git/index"))).toEqual(index);
  expect(
    await execute("git", ["status", "--porcelain"], { cwd: root }),
  ).toEqual(status);
  expect(baseline.overlayCount).toBe(4);
  expect(baseline.fileCount).toBe(3);
  const current = legacy.replace("customerCache", "currentCache");
  for (const file of ["dirty.ts", "staged.ts", "untracked.ts", "deleted.ts"])
    await writeFile(path.join(root, file), current);
  const before = async (file: string): Promise<string | undefined> =>
    (await buildChangeEvidence(baseline, file, current, 4, quote)).before
      ?.source;
  expect(await before("dirty.ts")).toBe(dirty);
  expect(await before("staged.ts")).toBe(staged);
  expect(await before("untracked.ts")).toBe(untracked);
  expect(
    await buildChangeEvidence(baseline, "deleted.ts", legacy, 4, quote),
  ).toMatchObject({ before: null, status: "unavailable", origins: [] });
  await baseline.dispose();
  await expect(stat(storage)).rejects.toThrow();
  expect(
    await buildChangeEvidence(baseline, "dirty.ts", current, 4, quote),
  ).toMatchObject({
    status: "unavailable",
    reason: "Task-start state of this file is unknown",
  });
});

it("uses the working copy of files Git is told to assume unchanged", async () => {
  await initializeGit();
  await writeFile(path.join(root, "flagged.ts"), legacy);
  await commitFiles();
  const local = legacy.replace("customerCache", "localCache");
  await writeFile(path.join(root, "flagged.ts"), local);
  await execute("git", ["update-index", "--assume-unchanged", "flagged.ts"], {
    cwd: root,
  });
  const baseline = await capture();
  expect(
    (await buildChangeEvidence(baseline, "flagged.ts", legacy, 4, quote)).before
      ?.source,
  ).toBe(local);
});

it("captures a repository without commits and a subdirectory missing from HEAD", async () => {
  await initializeGit();
  await writeFile(path.join(root, "original.ts"), legacy);
  const unborn = await capture();
  expect(
    (await buildChangeEvidence(unborn, "original.ts", legacy, 4, quote)).before
      ?.source,
  ).toBe(legacy);
  await commitFiles();
  await mkdir(path.join(root, "fresh"));
  await writeFile(path.join(root, "fresh/original.ts"), legacy);
  const nested = await capture(path.join(root, "fresh"));
  expect(
    await buildChangeEvidence(nested, "moved.ts", legacy, 4, quote),
  ).toMatchObject({
    status: "available",
    origins: [{ file: "original.ts", source: legacy }],
  });
});

it("scopes a subdirectory baseline to its own committed files", async () => {
  await initializeGit();
  await mkdir(path.join(root, "package"));
  await writeFile(path.join(root, "package/original.ts"), legacy);
  await writeFile(path.join(root, "outside.ts"), legacy);
  await commitFiles();
  const baseline = await capture(path.join(root, "package"));
  expect(baseline.fileCount).toBe(1);
  expect(
    await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote),
  ).toMatchObject({
    status: "available",
    origins: [{ file: "original.ts", source: legacy }],
  });
  expect(
    (await buildChangeEvidence(baseline, "original.ts", legacy, 4, quote))
      .before?.source,
  ).toBe(legacy);
});

it("keeps committed symlinks, binaries, and undecodable blobs unattributed", async () => {
  await initializeGit();
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/original.ts"), legacy);
  await symlink("src", path.join(root, "linked"));
  await writeFile(
    path.join(root, "binary.ts"),
    Buffer.concat([Buffer.from(legacy), Buffer.from([0])]),
  );
  await writeFile(
    path.join(root, "invalid.ts"),
    Buffer.concat([Buffer.from(legacy), Buffer.from([0xff])]),
  );
  await commitFiles();
  const baseline = await capture();
  for (const file of ["linked/new.ts", "linked", "binary.ts", "invalid.ts"])
    expect(
      (await buildChangeEvidence(baseline, file, legacy, 4, quote)).status,
    ).toBe("unavailable");
  expect(
    await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote),
  ).toMatchObject({
    status: "unavailable",
    reason: "Incomplete baseline cannot prove a unique cross-file origin",
  });
  expect(
    (await buildChangeEvidence(baseline, "src/original.ts", legacy, 4, quote))
      .status,
  ).toBe("available");
});

it("cannot prove a cross-file origin when a matching committed file is oversized", async () => {
  await initializeGit();
  await writeFile(path.join(root, "huge.ts"), `${legacy}${"x".repeat(64_001)}`);
  await commitFiles();
  const baseline = await capture();
  expect(
    await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote),
  ).toMatchObject({
    status: "unavailable",
    reason: "Incomplete baseline cannot prove a unique cross-file origin",
  });
  expect(
    await buildChangeEvidence(baseline, "huge.ts", legacy, 4, quote),
  ).toMatchObject({
    status: "unavailable",
    reason: "Task-start state of this file is unknown",
  });
});

it("fails open when pinned Git objects disappear", async () => {
  await initializeGit();
  await writeFile(path.join(root, "original.ts"), legacy);
  await commitFiles();
  const baseline = await capture();
  const { stdout } = await execute("git", ["rev-parse", "HEAD:original.ts"], {
    cwd: root,
  });
  const oid = stdout.trim();
  await rm(path.join(root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
  expect(
    await buildChangeEvidence(baseline, "original.ts", legacy, 4, quote),
  ).toMatchObject({
    status: "unavailable",
    reason: "Task baseline could not be read",
  });
  expect(
    await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote),
  ).toMatchObject({
    status: "unavailable",
    reason: "Incomplete baseline cannot prove a unique cross-file origin",
  });
  const tree = (
    await execute("git", ["rev-parse", "HEAD^{tree}"], { cwd: root })
  ).stdout.trim();
  await rm(path.join(root, ".git/objects", tree.slice(0, 2), tree.slice(2)));
  expect(
    await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote),
  ).toMatchObject({
    status: "unavailable",
    reason: "Task baseline could not be read",
  });
});

it("captures preexisting dirty tracked content rather than committed blobs", async () => {
  await initializeGit();
  await writeFile(
    path.join(root, "original.ts"),
    "export const clean = true;\n",
  );
  await commitFiles();
  await writeFile(path.join(root, "original.ts"), legacy);
  const baseline = await capture();
  await rm(path.join(root, "original.ts"));
  expect(
    await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote),
  ).toMatchObject({
    status: "available",
    origins: [{ file: "original.ts", source: legacy }],
  });
});

it("captures eligible preexisting untracked sources and honors Git ignores", async () => {
  await initializeGit();
  await writeFile(path.join(root, ".gitignore"), "private/\n");
  await mkdir(path.join(root, "private"));
  await writeFile(path.join(root, "private/duplicate.ts"), legacy);
  await writeFile(path.join(root, "untracked.ts"), legacy);
  const baseline = await capture();
  await rm(path.join(root, "untracked.ts"));
  expect(
    await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote),
  ).toMatchObject({
    status: "available",
    origins: [{ file: "untracked.ts", source: legacy }],
  });
});

it("does not acquire provenance from code generated and moved after capture", async () => {
  const baseline = await capture();
  await writeFile(path.join(root, "generated.ts"), legacy);
  await rename(path.join(root, "generated.ts"), path.join(root, "moved.ts"));
  expect(
    await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote),
  ).toMatchObject({
    status: "unavailable",
    before: null,
    origins: [],
    diff: null,
  });
});

it("retains the frozen task-start copy across repeated edits and deletion", async () => {
  await writeFile(path.join(root, "original.ts"), legacy);
  const baseline = await capture();
  const first = legacy.replace(
    "cachedRecord.serializedValue",
    "cachedRecord.payload",
  );
  const second = legacy.replace(
    "cachedRecord.serializedValue",
    "cachedRecord.newPayload",
  );
  await writeFile(path.join(root, "original.ts"), first);
  await buildChangeEvidence(
    baseline,
    "original.ts",
    first,
    4,
    "cachedRecord.payload",
  );
  await rm(path.join(root, "original.ts"));
  const evidence = await buildChangeEvidence(
    baseline,
    path.join(root, "original.ts"),
    second,
    4,
    "cachedRecord.newPayload",
  );
  expect(evidence.before).toEqual({ file: "original.ts", source: legacy });
  expect(evidence.after).toEqual({ file: "original.ts", source: second });
  expect(evidence.diff).toContain(
    "-  return JSON.parse(cachedRecord.serializedValue);",
  );
  expect(evidence.diff).toContain(
    "+  return JSON.parse(cachedRecord.newPayload);",
  );
  expect(evidence.diff).not.toContain("cachedRecord.payload");
});

it("keeps complete execution context when a block is moved into a changed wrapper", async () => {
  await writeFile(
    path.join(root, "original.ts"),
    `// Invoked only for administrators.\n${legacy}`,
  );
  const baseline = await capture();
  const current = `// Invoked for anonymous requests.\n${legacy}\nservePublicly(loadCustomer);\n`;
  const evidence = await buildChangeEvidence(
    baseline,
    "public.ts",
    current,
    5,
    quote,
  );
  expect(evidence.status).toBe("available");
  expect(evidence.origins[0]?.source).toContain("only for administrators");
  expect(evidence.after.source).toContain("servePublicly(loadCustomer)");
  expect(evidence.diff).toContain("+// Invoked for anonymous requests.");
  expect(evidence.diff).toContain("-// Invoked only for administrators.");
});

it("does not claim the new buggy statement in an otherwise moved block existed", async () => {
  await writeFile(path.join(root, "original.ts"), legacy);
  const baseline = await capture();
  const changed = legacy.replace(
    "JSON.parse(cachedRecord.serializedValue)",
    "JSON.parse(userProvidedPayload)",
  );
  expect(
    await buildChangeEvidence(
      baseline,
      "moved.ts",
      changed,
      4,
      "JSON.parse(userProvidedPayload)",
    ),
  ).toMatchObject({
    status: "unavailable",
    origins: [],
  });
});

it("does not identify an origin from a short common quote alone", async () => {
  await writeFile(
    path.join(root, "original.ts"),
    "function original() {\n  return value;\n}\n",
  );
  const baseline = await capture();
  expect(
    (
      await buildChangeEvidence(
        baseline,
        "new.ts",
        "function unrelated() {\n  return value;\n}\n",
        2,
        "return value",
      )
    ).status,
  ).toBe("unavailable");
  expect(
    (await buildChangeEvidence(baseline, "new.ts", "}\n", 1, "}")).status,
  ).toBe("unavailable");
});

it.each(["separate files", "the same file", "committed and untracked files"])(
  "fails open when matching blocks occur in %s",
  async (location) => {
    if (location === "committed and untracked files") {
      await initializeGit();
      await writeFile(path.join(root, "first.ts"), legacy);
      await commitFiles();
    } else {
      await writeFile(
        path.join(root, "first.ts"),
        location === "the same file" ? legacy + legacy : legacy,
      );
    }
    if (location !== "the same file") {
      await writeFile(path.join(root, "second.ts"), legacy);
    }
    const baseline = await capture();
    expect(
      await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote),
    ).toMatchObject({
      status: "unavailable",
      diff: null,
    });
  },
);

it("supports indentation-only movement without dropping original context", async () => {
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/original.ts"), legacy);
  const baseline = await capture();
  const indented = legacy
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  expect(
    await buildChangeEvidence(baseline, "moved.ts", indented, 4, quote),
  ).toMatchObject({
    status: "available",
    origins: [{ file: "src/original.ts", source: legacy }],
    after: { file: "moved.ts", source: indented },
  });
});

it("reports why a baseline is unavailable", async () => {
  expect(
    (await buildChangeEvidence(undefined, "moved.ts", legacy, 4, quote)).status,
  ).toBe("unavailable");
  expect(await failure(path.join(root, "absent"))).toBe("root-unavailable");
  expect(await failure(root, AbortSignal.abort())).toBe("aborted");
  const expired = new AbortController();
  expired.abort(new DOMException("deadline", "TimeoutError"));
  vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(expired.signal);
  expect(await failure()).toBe("timeout");
});

it("removes partial storage when copying the overlay fails or is cancelled", async () => {
  await writeFile(path.join(root, "first.ts"), legacy);
  await writeFile(path.join(root, "second.ts"), legacy);
  const created = fileSystem.created.length;
  fileSystem.failWrite = true;
  expect(await failure()).toBe("storage-failed");
  fileSystem.failWrite = false;
  const controller = new AbortController();
  fileSystem.onOpen = () => {
    controller.abort();
  };
  expect(await failure(root, controller.signal)).toBe("aborted");
  const storage = fileSystem.created.slice(created);
  expect(storage).toHaveLength(2);
  for (const directory of storage)
    await expect(stat(directory)).rejects.toThrow();
});

it("reports unreadable and unstable directory listings outside Git", async () => {
  await mkdir(path.join(root, "locked"));
  await chmod(path.join(root, "locked"), 0o000);
  expect(await failure()).toBe("enumeration-failed");
  await chmod(path.join(root, "locked"), 0o755);
  fileSystem.failIteration = true;
  expect(await failure()).toBe("unexpected-error");
});

it("never rejects when the frozen overlay cannot be removed", async () => {
  const baseline = await capture();
  fileSystem.failRemove = true;
  await expect(baseline.dispose()).resolves.toBeUndefined();
  fileSystem.failRemove = false;
});

it.each(["../outside.ts", "..", ".", String.raw`sub\file.ts`, "bad\nfile.ts"])(
  "rejects unsafe finding path %j",
  async (file) => {
    await writeFile(path.join(root, "original.ts"), legacy);
    expect(
      (await buildChangeEvidence(await capture(), file, legacy, 4, quote))
        .status,
    ).toBe("unavailable");
  },
);

it.each([
  { line: 0, quote },
  { line: 1.5, quote },
  { line: 40, quote },
  { line: 4, quote: "not in the source" },
  { line: 4, quote: " " },
])("rejects unanchored finding $line/$quote", async (finding) => {
  await writeFile(path.join(root, "original.ts"), legacy);
  expect(
    (
      await buildChangeEvidence(
        await capture(),
        "original.ts",
        legacy,
        finding.line,
        finding.quote,
      )
    ).status,
  ).toBe("unavailable");
});

it("does not traverse symlinks or attribute findings inside symlink directories", async () => {
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/original.ts"), legacy);
  await symlink("src/original.ts", path.join(root, "alias.ts"));
  await symlink("src", path.join(root, "linked"));
  await symlink(tmpdir(), path.join(root, "outside"));
  const baseline = await capture();
  for (const file of ["alias.ts", "linked/new.ts", "outside/new.ts"])
    expect(
      (await buildChangeEvidence(baseline, file, legacy, 4, quote)).status,
    ).toBe("unavailable");
  expect(
    (await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote)).status,
  ).toBe("available");
});

it("does not expose ignored dependencies, output files, or known credential files", async () => {
  for (const directory of ["node_modules", "dist", ".git"]) {
    await mkdir(path.join(root, directory));
    await writeFile(path.join(root, directory, "duplicate.ts"), legacy);
  }
  for (const file of [
    ".env",
    ".env.local",
    "private.key",
    ".npmrc",
    "package-lock.json",
  ]) {
    await writeFile(path.join(root, file), legacy);
  }
  await writeFile(path.join(root, "original.ts"), legacy);
  const baseline = await capture();
  expect(
    (await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote)).status,
  ).toBe("available");
  expect(
    (await buildChangeEvidence(baseline, ".env", legacy, 4, quote)).status,
  ).toBe("unavailable");
  expect(baseline.fileCount).toBe(1);
});

it("fails open rather than approximate ignore semantics outside Git", async () => {
  await writeFile(path.join(root, ".gitignore"), "private.ts\n");
  await writeFile(path.join(root, "private.ts"), legacy);
  expect(await failure()).toBe("ignore-rules-without-git");
});

it("excludes binary content without losing a real source origin", async () => {
  await writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(root, "original.ts"), legacy);
  const baseline = await capture();
  expect(
    (await buildChangeEvidence(baseline, "image.bin", legacy, 4, quote)).status,
  ).toBe("unavailable");
  expect(
    (await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote)).status,
  ).toBe("available");
});

it("fails open for oversized sources and incomplete cross-file context", async () => {
  await writeFile(path.join(root, "oversize.ts"), "x".repeat(64_001));
  await writeFile(path.join(root, "original.ts"), legacy);
  const baseline = await capture();
  expect(baseline.complete).toBe(false);
  const status = async (file: string, source = legacy): Promise<string> =>
    (await buildChangeEvidence(baseline, file, source, 4, quote)).status;
  expect(await status("oversize.ts")).toBe("unavailable");
  expect(await status("moved.ts")).toBe("unavailable");
  expect(await status("original.ts")).toBe("available");
  expect(await status("original.ts", legacy + "x".repeat(64_001))).toBe(
    "unavailable",
  );
});

it("treats an unreadable frozen copy as an incomplete origin search", async () => {
  await writeFile(path.join(root, "original.ts"), legacy);
  await writeFile(path.join(root, "other.ts"), legacy);
  const baseline = await capture();
  const storage = fileSystem.created.at(-1);
  if (storage === undefined) throw new Error("Missing baseline storage");
  for (const name of await readdir(storage))
    if ((await readFile(path.join(storage, name), "utf8")) === legacy)
      await rm(path.join(storage, name));
  expect(
    await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote),
  ).toMatchObject({
    status: "unavailable",
    reason: "Incomplete baseline cannot prove a unique cross-file origin",
  });
});

it("does not treat invalid UTF-8 as stable textual origin evidence", async () => {
  await writeFile(path.join(root, "invalid.ts"), Buffer.from([0xff, 0xfe]));
  await writeFile(path.join(root, "original.ts"), legacy);
  const baseline = await capture();
  expect(
    (await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote)).status,
  ).toBe("unavailable");
});

it("reports a Git failure when the index cannot be read", async () => {
  await initializeGit();
  await writeFile(path.join(root, ".git/index"), "corrupted index");
  expect(await failure()).toBe("git-failed");
});

it("excludes non-regular files without reading a pipe or losing real origins", async () => {
  await execute("mkfifo", [path.join(root, "stream.ts")]);
  await writeFile(path.join(root, "original.ts"), legacy);
  const baseline = await capture();
  expect(
    (await buildChangeEvidence(baseline, "stream.ts", legacy, 4, quote)).status,
  ).toBe("unavailable");
  expect(
    (await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote)).status,
  ).toBe("available");
});

it.each([
  legacy + "// Concurrently appended data\n",
  legacy.replace("customerCache", "registryCache"),
])(
  "does not use a file modified during capture as baseline provenance",
  async (replacement) => {
    const original = path.join(root, "original.ts");
    await writeFile(original, legacy);
    fileSystem.changing.set(await realpath(original), replacement);
    const baseline = await capture();
    expect(
      (
        await buildChangeEvidence(
          baseline,
          "original.ts",
          replacement,
          4,
          quote,
        )
      ).status,
    ).toBe("unavailable");
    expect(
      (await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote))
        .status,
    ).toBe("unavailable");
    expect(await readFile(original, "utf8")).toBe(replacement);
  },
);

it("filters credential and unsafe paths returned by Git without losing real origins", async () => {
  await initializeGit();
  await writeFile(path.join(root, ".env"), legacy);
  await writeFile(path.join(root, "bad\nfile.ts"), legacy);
  await writeFile(path.join(root, "original.ts"), legacy);
  const baseline = await capture();
  expect(
    (await buildChangeEvidence(baseline, ".env", legacy, 4, quote)).status,
  ).toBe("unavailable");
  expect(
    (await buildChangeEvidence(baseline, "bad\nfile.ts", legacy, 4, quote))
      .status,
  ).toBe("unavailable");
  expect(
    await buildChangeEvidence(baseline, "moved.ts", legacy, 4, quote),
  ).toMatchObject({
    status: "available",
    origins: [{ file: "original.ts", source: legacy }],
  });
});

it("bounds non-Git enumeration but freezes a Git repository of any size", async () => {
  for (let batch = 0; batch < 101; batch += 1) {
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(path.join(root, `${String(batch * 100 + index)}.ts`), ""),
      ),
    );
  }
  expect(await failure()).toBe("entry-limit");
  await initializeGit();
  await writeFile(path.join(root, "original.ts"), legacy);
  await commitFiles();
  const git = await capture();
  expect(git.fileCount).toBe(10_101);
  expect(
    (await buildChangeEvidence(git, "moved.ts", legacy, 4, quote)).status,
  ).toBe("available");
});

it("keeps before and after evidence for insertion and removal near file boundaries", async () => {
  await writeFile(path.join(root, "original.ts"), legacy);
  const baseline = await capture();
  const insertion = `const publicRoute = true;\n${legacy}`;
  const inserted = await buildChangeEvidence(
    baseline,
    "original.ts",
    insertion,
    5,
    quote,
  );
  expect(inserted.diff).toContain("+const publicRoute = true;");
  const removal = legacy.split("\n").slice(1).join("\n");
  const removed = await buildChangeEvidence(
    baseline,
    "original.ts",
    removal,
    3,
    quote,
  );
  expect(removed.diff).toContain(
    "-export function loadCustomer(customerId: string) {",
  );
  expect(removed.before?.source).toBe(legacy);
});
