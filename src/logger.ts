import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pino } from "pino";

export type PairLogEvent =
  | "session.start"
  | "session.stop"
  | "extension.shutdown"
  | "extension.toggle"
  | "extension.persistence_failed"
  | "review.scheduled"
  | "review.started"
  | "review.finished"
  | "review.skipped"
  | "model.finished"
  | "finding.filtered"
  | "finding.admission"
  | "finding.verdict"
  | "delivery.sent"
  | "delivery.wake";

export interface PairLogFields {
  sessionId?: string;
  jobId?: string;
  reviewerId?: string;
  modelId?: string;
  stage?: "review" | "attribution" | "dedup";
  outcome?: keyof typeof outcomes;
  reasonCode?: keyof typeof reasonCodes;
  count?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface PairLogger {
  log(event: PairLogEvent, fields?: PairLogFields): void;
  close(): Promise<void>;
}

const events: Record<PairLogEvent, true> = {
  "session.start": true,
  "session.stop": true,
  "extension.shutdown": true,
  "extension.toggle": true,
  "extension.persistence_failed": true,
  "review.scheduled": true,
  "review.started": true,
  "review.finished": true,
  "review.skipped": true,
  "model.finished": true,
  "finding.filtered": true,
  "finding.admission": true,
  "finding.verdict": true,
  "delivery.sent": true,
  "delivery.wake": true,
};
const numericFields: Record<string, true> = {
  count: true,
  durationMs: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  totalTokens: true,
  costUsd: true,
};
const identifierFields: Record<string, true> = {
  sessionId: true,
  jobId: true,
  reviewerId: true,
  modelId: true,
};
const stages: Record<string, true> = {
  review: true,
  attribution: true,
  dedup: true,
};
const outcomes = {
  success: true,
  failed: true,
  cancelled: true,
  timeout: true,
  obsolete: true,
  added: true,
  unchanged: true,
  accept: true,
  reject: true,
  invalid: true,
  on: true,
  off: true,
};
const reasonCodes = {
  session_change: true,
  shutdown: true,
  disabled: true,
  superseded: true,
  stale: true,
  missing_model: true,
  unchanged: true,
  duplicate_config: true,
  scheduled: true,
  completed: true,
  no_findings: true,
  inherited: true,
  attribution_fallback: true,
  dedup_fallback: true,
  persistence_failed: true,
  wake_pending: true,
  busy: true,
  no_findings_ready: true,
  already_presented: true,
  ready: true,
  outstanding: true,
  passive: true,
  baseline_unavailable: true,
  configuration_failed: true,
  ui_unavailable: true,
};
const maxFileBytes = 1024 * 1024;
const maxBufferedBytes = 64 * 1024;
const retainedFiles = 5;
const filePattern = /^pair-\d+-(\d+)-[\da-f-]+\.jsonl$/u;
const activeFilesKey = Symbol.for("pi-pair-programmer.active-log-files.v1");
const retainedFilesInProcess = Reflect.get(globalThis, activeFilesKey) as
  Set<string> | undefined;
const activeFiles = retainedFilesInProcess ?? new Set<string>();

function safeFields(fields: PairLogFields): Record<string, string | number> {
  const safe: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields)) {
    const numeric =
      Object.hasOwn(numericFields, key) &&
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0;
    const identifier =
      Object.hasOwn(identifierFields, key) &&
      typeof value === "string" &&
      /^[\da-f-]{1,64}$/iu.test(value);
    const code =
      typeof value === "string" &&
      ((key === "stage" && Object.hasOwn(stages, value)) ||
        (key === "outcome" && Object.hasOwn(outcomes, value)) ||
        (key === "reasonCode" && Object.hasOwn(reasonCodes, value)));
    if (numeric || identifier || code)
      Object.defineProperty(safe, key, { value, enumerable: true });
  }
  return safe;
}

type LogLevel = "debug" | "info" | "warn" | "error";
const warningReasons: Record<string, true> = {
  attribution_fallback: true,
  dedup_fallback: true,
  missing_model: true,
  baseline_unavailable: true,
  ui_unavailable: true,
};

function severity(
  event: PairLogEvent,
  fields: Record<string, string | number>,
): LogLevel {
  const outcome = fields["outcome"];
  const reason = fields["reasonCode"];
  if (
    event === "extension.persistence_failed" ||
    reason === "persistence_failed" ||
    reason === "configuration_failed"
  ) {
    return "error";
  }
  if (
    outcome === "timeout" ||
    outcome === "invalid" ||
    Object.hasOwn(warningReasons, reason ?? "")
  ) {
    return "warn";
  }
  if (outcome === "failed") {
    return "error";
  }
  return outcome === "cancelled" ||
    outcome === "obsolete" ||
    event === "review.skipped" ||
    event === "finding.filtered" ||
    (event === "delivery.wake" && reason !== "ready")
    ? "debug"
    : "info";
}

function guardedLogger(
  emit: (event: PairLogEvent, fields: Record<string, string | number>) => void,
  finish: () => Promise<void>,
): PairLogger {
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    log(event, fields = {}) {
      try {
        if (!closed && Object.hasOwn(events, event)) {
          emit(event, safeFields(fields));
        }
      } catch {}
    },
    close() {
      closed = true;
      closing ??= (async () => {
        try {
          await finish();
        } catch {}
      })();
      return closing;
    },
  };
}

function nativeLogger(host: unknown): PairLogger | undefined {
  if (typeof host !== "object" || host === null || !("logger" in host)) {
    return undefined;
  }
  const logger: unknown = host.logger;
  if (
    typeof logger !== "object" ||
    logger === null ||
    !("info" in logger) ||
    typeof logger.info !== "function"
  ) {
    return undefined;
  }
  return guardedLogger(
    (event, fields) => {
      const method: unknown = Reflect.get(logger, severity(event, fields));
      if (typeof method !== "function") return;
      const emit = method as (
        message: string,
        context: Record<string, string | number>,
      ) => void;
      emit.call(logger, `pair-programmer.${event}`, fields);
    },
    () => Promise.resolve(),
  );
}

function processRetired(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

async function pruneRetiredFiles(directory: string): Promise<void> {
  const files = await readdir(directory);
  const retired: string[] = [];
  for (const name of files) {
    const match = filePattern.exec(name);
    if (match === null) {
      continue;
    }
    if (Number(match[1]) === process.pid) {
      if (!activeFiles.has(path.join(directory, name))) retired.push(name);
      continue;
    }
    if (processRetired(Number(match[1]))) retired.push(name);
  }
  retired.sort((a, b) => a.localeCompare(b));
  for (const name of retired.slice(
    0,
    Math.max(0, retired.length - retainedFiles),
  )) {
    try {
      await unlink(path.join(directory, name));
    } catch {}
  }
}

async function fileLogger(directory: string): Promise<PairLogger> {
  await mkdir(directory, { recursive: true, mode: 0o700 });

  await chmod(directory, 0o700);
  await pruneRetiredFiles(directory);
  const prefix = path.join(
    directory,
    `pair-${String(Date.now())}-${String(process.pid)}-${randomUUID()}`,
  );
  let generation = 0;
  let filename = `${prefix}-${String(generation)}.jsonl`;
  activeFiles.add(filename);
  let destination: Awaited<ReturnType<typeof open>>;
  try {
    destination = await open(filename, "wx", 0o600);
  } catch (error) {
    activeFiles.delete(filename);
    throw error;
  }
  const files = [filename];
  const state = { failed: false };
  let bytes = 0;
  let bufferedBytes = 0;
  let pending = Promise.resolve();
  const logger = pino(
    { base: null, level: "debug" },
    {
      write(line: string) {
        const length = Buffer.byteLength(line);
        if (state.failed || bufferedBytes + length > maxBufferedBytes) {
          return;
        }
        bufferedBytes += length;
        const previous = pending;
        pending = (async () => {
          await previous;
          try {
            if (state.failed) {
              return;
            }
            if (bytes + length > maxFileBytes) {
              await destination.close();
              generation++;
              filename = `${prefix}-${String(generation)}.jsonl`;
              activeFiles.add(filename);

              destination = await open(filename, "wx", 0o600);
              bytes = 0;
              files.push(filename);
              if (files.length > retainedFiles) {
                for (const retired of files.splice(0, 1)) {
                  activeFiles.delete(retired);

                  await unlink(retired);
                }
              }
            }
            await destination.writeFile(line);
            bytes += length;
          } catch {
            state.failed = true;
          } finally {
            bufferedBytes -= length;
          }
        })();
      },
    },
  );
  return guardedLogger(
    (event, fields) => {
      logger[severity(event, fields)](fields, `pair-programmer.${event}`);
    },
    async () => {
      await pending;
      try {
        await destination.close();
      } finally {
        for (const file of files) activeFiles.delete(file);
        activeFiles.delete(filename);
        await pruneRetiredFiles(directory);
      }
    },
  );
}

export async function createPairLogger(
  host: unknown,
  options: { directory?: string } = {},
): Promise<PairLogger> {
  Reflect.set(globalThis, activeFilesKey, activeFiles);
  try {
    const native = nativeLogger(host);
    if (native !== undefined) {
      return native;
    }
    const stateDirectory =
      process.env["PI_CODING_AGENT_DIR"] ??
      path.join(homedir(), ".pi", "agent");
    return await fileLogger(
      options.directory ?? path.join(stateDirectory, "logs", "pair-programmer"),
    );
  } catch {
    return guardedLogger(
      () => {
        return;
      },
      () => Promise.resolve(),
    );
  }
}
