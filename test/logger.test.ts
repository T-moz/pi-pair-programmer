import * as fs from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createPairLogger,
  type PairLogEvent,
  type PairLogFields,
} from "../src/logger.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof fs>()),
}));

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pair-logger-"));
  directories.push(directory);
  return directory;
}

async function logRecords(
  directory: string,
): Promise<Record<string, unknown>[]> {
  const names = await readdir(directory);
  const contents = await Promise.all(
    names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => readFile(path.join(directory, name), "utf8")),
  );
  return contents.flatMap((content) =>
    content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it("prefers the injected native logger without touching the file destination", async () => {
  const directory = path.join(await temporaryDirectory(), "unused");
  const native = {
    calls: [] as unknown[],
    info(message: string, fields: unknown): void {
      this.calls.push([message, fields]);
    },
  };
  const logger = await createPairLogger({ logger: native }, { directory });
  logger.log("review.finished", {
    stage: "review",
    outcome: "success",
    count: 2,
  });
  await logger.close();
  logger.log("session.stop");
  await logger.close();
  expect(native.calls).toEqual([
    [
      "pair-programmer.review.finished",
      { stage: "review", outcome: "success", count: 2 },
    ],
  ]);
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("writes private Pi JSONL and flushes only to its explicit file", async () => {
  const directory = await temporaryDirectory();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const logger = await createPairLogger({}, { directory });
  logger.log("session.start");
  logger.log("model.finished", {
    sessionId: "abc123",
    jobId: "def456",
    reviewerId: "abcd",
    modelId: "aabb",
    stage: "dedup",
    outcome: "success",
    reasonCode: "completed",
    count: 0,
    durationMs: 1.5,
    inputTokens: 20,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 1,
    totalTokens: 26,
    costUsd: 0.001,
  });
  const firstClose = logger.close();
  expect(logger.close()).toBe(firstClose);
  await firstClose;
  logger.log("session.stop");
  expect(await logRecords(directory)).toEqual([
    {
      level: 30,
      time: expect.any(Number) as unknown,
      msg: "pair-programmer.session.start",
    },
    {
      level: 30,
      time: expect.any(Number) as unknown,
      msg: "pair-programmer.model.finished",
      sessionId: "abc123",
      jobId: "def456",
      reviewerId: "abcd",
      modelId: "aabb",
      stage: "dedup",
      outcome: "success",
      reasonCode: "completed",
      count: 0,
      durationMs: 1.5,
      inputTokens: 20,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 1,
      totalTokens: 26,
      costUsd: 0.001,
    },
  ]);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  for (const name of await readdir(directory)) {
    expect((await stat(path.join(directory, name))).mode & 0o777).toBe(0o600);
  }
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr).not.toHaveBeenCalled();
});

it("drops prose, secrets, paths, objects, invalid numbers, and unknown event codes", async () => {
  const directory = await temporaryDirectory();
  const logger = await createPairLogger({}, { directory });
  const unsafe = {
    sessionId: "/private/source.ts",
    jobId: "sk-secret",
    reviewerId: 23,
    modelId: "a".repeat(65),
    stage: "user prompt",
    outcome: "access token",
    reasonCode: "raw error message",
    durationMs: NaN,
    count: -1,
    totalTokens: Infinity,
    costUsd: "expensive",
    source: "private source",
    prompt: "private prompt",
    stderr: "private error output",
    error: new Error("private error"),
    arbitrary: { nested: "secret" },
    inputTokens: 0,
  } as unknown as PairLogFields;
  logger.log("review.finished", unsafe);
  logger.log("private event prose" as PairLogEvent);
  logger.log("review.finished", {
    stage: "constructor",
    outcome: "toString",
    reasonCode: "__proto__",
  } as unknown as PairLogFields);
  await logger.close();
  expect(await logRecords(directory)).toEqual([
    {
      level: 30,
      time: expect.any(Number) as unknown,
      msg: "pair-programmer.review.finished",
      inputTokens: 0,
    },
    {
      level: 30,
      time: expect.any(Number) as unknown,
      msg: "pair-programmer.review.finished",
    },
  ]);
});

it("applies the same redaction before invoking the native logger", async () => {
  const warn = vi.fn();
  const logger = await createPairLogger({ logger: { info: vi.fn(), warn } });
  logger.log("review.skipped", {
    reasonCode: "missing_model",
    path: "/secret",
    error: new Error("secret"),
  } as PairLogFields);
  expect(warn).toHaveBeenCalledWith("pair-programmer.review.skipped", {
    reasonCode: "missing_model",
  });
  await logger.close();
});

const severityCases: {
  event: PairLogEvent;
  fields: PairLogFields;
  level: "debug" | "info" | "warn" | "error";
  code: number;
}[] = [
  {
    event: "review.finished",
    fields: { outcome: "cancelled" },
    level: "debug",
    code: 20,
  },
  {
    event: "review.finished",
    fields: { outcome: "obsolete" },
    level: "debug",
    code: 20,
  },
  {
    event: "review.skipped",
    fields: { reasonCode: "unchanged" },
    level: "debug",
    code: 20,
  },
  {
    event: "finding.filtered",
    fields: { reasonCode: "inherited" },
    level: "debug",
    code: 20,
  },
  {
    event: "delivery.wake",
    fields: { reasonCode: "busy" },
    level: "debug",
    code: 20,
  },
  {
    event: "delivery.wake",
    fields: { reasonCode: "ready" },
    level: "info",
    code: 30,
  },
  { event: "session.start", fields: {}, level: "info", code: 30 },
  {
    event: "finding.verdict",
    fields: { outcome: "accept" },
    level: "info",
    code: 30,
  },
  {
    event: "review.finished",
    fields: { outcome: "timeout" },
    level: "warn",
    code: 40,
  },
  {
    event: "finding.verdict",
    fields: { outcome: "invalid" },
    level: "warn",
    code: 40,
  },
  {
    event: "finding.admission",
    fields: { outcome: "failed", reasonCode: "attribution_fallback" },
    level: "warn",
    code: 40,
  },
  {
    event: "finding.admission",
    fields: { reasonCode: "dedup_fallback" },
    level: "warn",
    code: 40,
  },
  {
    event: "extension.persistence_failed",
    fields: { outcome: "cancelled" },
    level: "error",
    code: 50,
  },
  {
    event: "review.finished",
    fields: { outcome: "failed" },
    level: "error",
    code: 50,
  },
  {
    event: "session.start",
    fields: { reasonCode: "configuration_failed" },
    level: "error",
    code: 50,
  },
  {
    event: "review.finished",
    fields: { reasonCode: "persistence_failed" },
    level: "error",
    code: 50,
  },
];

it("records expected interruptions quietly and distinguishes actionable warnings from failures", async () => {
  const directory = await temporaryDirectory();
  const logger = await createPairLogger({}, { directory });
  for (const scenario of severityCases) {
    logger.log(scenario.event, scenario.fields);
  }
  await logger.close();
  expect(
    (await logRecords(directory)).map((record) => ({
      event: record["msg"],
      level: record["level"],
    })),
  ).toEqual(
    severityCases.map((scenario) => ({
      event: `pair-programmer.${scenario.event}`,
      level: scenario.code,
    })),
  );
});

it("uses the native severity methods with the same failure and interruption precedence", async () => {
  const native = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const logger = await createPairLogger({ logger: native });
  for (const scenario of severityCases) {
    logger.log(scenario.event, scenario.fields);
  }
  await logger.close();
  for (const [level, method] of Object.entries(native)) {
    expect(method.mock.calls).toEqual(
      severityCases
        .filter((scenario) => scenario.level === level)
        .map((scenario) => [
          `pair-programmer.${scenario.event}`,
          scenario.fields,
        ]),
    );
  }
});

it("does not misclassify diagnostics when a native severity method is absent", async () => {
  const info = vi.fn();
  const logger = await createPairLogger({ logger: { info } });
  logger.log("review.finished", { outcome: "timeout" });
  logger.log("session.start");
  await logger.close();
  expect(info.mock.calls).toEqual([["pair-programmer.session.start", {}]]);
});

it("isolates native sink failures and hostile field accessors", async () => {
  const info = vi.fn(() => {
    throw new Error("sink failure");
  });
  const logger = await createPairLogger({ logger: { info } });
  logger.log("session.start");
  const fields = Object.defineProperty({}, "count", {
    enumerable: true,
    get() {
      throw new Error("getter failure");
    },
  });
  logger.log("review.finished", fields);
  expect(info).toHaveBeenCalledTimes(1);
  await logger.close();
});

it.each([
  null,
  3,
  {},
  { logger: null },
  { logger: 1 },
  { logger: {} },
  { logger: { info: 1 } },
])("uses a file when the host has no native logger: %j", async (host) => {
  const directory = await temporaryDirectory();
  const logger = await createPairLogger(host, { directory });
  logger.log("session.start");
  await logger.close();
  expect(await logRecords(directory)).toEqual([
    {
      level: 30,
      time: expect.any(Number) as unknown,
      msg: "pair-programmer.session.start",
    },
  ]);
});

it("uses the configured Pi state directory", async () => {
  const directory = await temporaryDirectory();
  vi.stubEnv("PI_CODING_AGENT_DIR", directory);
  const logger = await createPairLogger({});
  logger.log("session.start");
  await logger.close();
  expect(
    await logRecords(path.join(directory, "logs", "pair-programmer")),
  ).toEqual([
    {
      level: 30,
      time: expect.any(Number) as unknown,
      msg: "pair-programmer.session.start",
    },
  ]);
});

it("treats initialization failures as disabled diagnostics", async () => {
  const directory = await temporaryDirectory();
  const file = path.join(directory, "not-a-directory");
  await writeFile(file, "unchanged");
  const logger = await createPairLogger({}, { directory: file });
  logger.log("session.start");
  await logger.close();
  expect(await readFile(file, "utf8")).toBe("unchanged");
  const inaccessible = await createPairLogger({
    get logger() {
      throw new Error("host unavailable");
    },
  });
  inaccessible.log("session.start");
  await inaccessible.close();
});

it("bounds closed same-process sessions while preserving another active logger", async () => {
  const directory = await temporaryDirectory();
  const active = await createPairLogger({}, { directory });
  active.log("session.start", { count: 999 });
  for (let count = 0; count < 8; count += 1) {
    const logger = await createPairLogger({}, { directory });
    logger.log("session.start", { count });
    await logger.close();
  }
  expect(await readdir(directory)).toHaveLength(6);
  active.log("extension.shutdown", { count: 999 });
  await active.close();
  expect(await readdir(directory)).toHaveLength(5);
});

it("silently disables diagnostics when the initial private file cannot be opened", async () => {
  const directory = await temporaryDirectory();
  vi.spyOn(fs, "open").mockRejectedValueOnce(
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
  );
  const unavailable = await createPairLogger({}, { directory });
  unavailable.log("session.start");
  await unavailable.close();
  expect(await readdir(directory)).toEqual([]);
  const recovered = await createPairLogger({}, { directory });
  recovered.log("session.start");
  await recovered.close();
  expect(await logRecords(directory)).toEqual([
    {
      level: 30,
      time: expect.any(Number) as unknown,
      msg: "pair-programmer.session.start",
    },
  ]);
});

it("keeps five retired files without deleting live or unrelated files", async () => {
  const directory = await temporaryDirectory();
  vi.spyOn(process, "kill").mockImplementation((pid) => {
    if (pid === 999_999) {
      throw Object.assign(new Error("not running"), { code: "ESRCH" });
    }
    return true;
  });
  for (let index = 0; index < 7; index++) {
    await writeFile(
      path.join(
        directory,
        `pair-100000000000${String(index)}-999999-abcd-0.jsonl`,
      ),
      String(index),
    );
  }
  const live = "pair-1000000000000-1234-abcd-0.jsonl";
  await writeFile(path.join(directory, live), "live logger data");
  await writeFile(path.join(directory, "unrelated.jsonl"), "unrelated data");
  const logger = await createPairLogger({}, { directory });
  logger.log("session.start");
  await logger.close();
  const files = await readdir(directory);
  expect(files.filter((name) => name.includes("-999999-"))).toEqual([
    "pair-1000000000003-999999-abcd-0.jsonl",
    "pair-1000000000004-999999-abcd-0.jsonl",
    "pair-1000000000005-999999-abcd-0.jsonl",
    "pair-1000000000006-999999-abcd-0.jsonl",
  ]);
  expect(await readFile(path.join(directory, live), "utf8")).toBe(
    "live logger data",
  );
  expect(await readFile(path.join(directory, "unrelated.jsonl"), "utf8")).toBe(
    "unrelated data",
  );
});

it.each([
  Object.assign(new Error("permission denied"), { code: "EPERM" }),
  new Error("unknown"),
  "unknown",
])("preserves files when process liveness is uncertain: %s", async (error) => {
  const directory = await temporaryDirectory();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw error as Error;
  });
  const filename = "pair-1000000000000-1234-abcd-0.jsonl";
  await writeFile(path.join(directory, filename), "preserved");
  const logger = await createPairLogger({}, { directory });
  logger.log("session.start");
  await logger.close();
  expect(await readFile(path.join(directory, filename), "utf8")).toBe(
    "preserved",
  );
});

it("keeps logging when concurrent retired-file cleanup cannot unlink a file", async () => {
  const directory = await temporaryDirectory();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("not running"), { code: "ESRCH" });
  });
  for (let index = 0; index < 6; index++) {
    await mkdir(
      path.join(
        directory,
        `pair-100000000000${String(index)}-999999-abcd-0.jsonl`,
      ),
    );
  }
  const logger = await createPairLogger({}, { directory });
  logger.log("session.start");
  await logger.close();
  const names = await readdir(directory, { withFileTypes: true });
  const current = names.find((entry) => entry.isFile());
  expect(
    await readFile(path.join(directory, current?.name ?? "missing"), "utf8"),
  ).toContain("pair-programmer.session.start");
});

it("bounds queued data rather than blocking reviews on a slow disk", async () => {
  const directory = await temporaryDirectory();
  const logger = await createPairLogger({}, { directory });
  for (let count = 0; count < 10_000; count++) {
    logger.log("review.finished", { count });
  }
  await logger.close();
  const records = await logRecords(directory);
  expect(records[0]?.["count"]).toBe(0);
  expect(records.at(-1)?.["count"]).toBeLessThan(1000);
  const [name] = await readdir(directory);
  expect(
    (await stat(path.join(directory, name ?? "missing"))).size,
  ).toBeLessThanOrEqual(64 * 1024);
});

it("rotates bounded files and continues retaining recent diagnostics", async () => {
  const directory = await temporaryDirectory();
  const realOpen = fs.open;
  let written = (): void => undefined;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const write = handle.writeFile.bind(handle);
    vi.spyOn(handle, "writeFile").mockImplementation(async (...writeArgs) => {
      await write(...writeArgs);
      written();
    });
    return handle;
  });
  const logger = await createPairLogger({}, { directory });
  for (let batch = 0; batch < 200; batch++) {
    let remaining = 100;
    const drained = new Promise<void>((resolve) => {
      written = () => {
        remaining--;
        if (remaining === 0) {
          resolve();
        }
      };
    });
    for (let count = 0; count < 100; count++) {
      logger.log("review.finished", {
        count: batch * 100 + count,
        sessionId: "a".repeat(64),
        jobId: "b".repeat(64),
        reviewerId: "c".repeat(64),
        modelId: "d".repeat(64),
      });
    }
    await drained;
  }
  logger.log("extension.shutdown", { count: 99_999 });
  await logger.close();
  const names = await readdir(directory);
  expect(names).toHaveLength(5);
  for (const name of names) {
    const details = await stat(path.join(directory, name));
    expect(details.size).toBeLessThanOrEqual(1024 * 1024);
    expect(details.mode & 0o777).toBe(0o600);
  }
  const records = await logRecords(directory);
  expect(records.some((record) => record["count"] === 0)).toBe(false);
  expect(records.some((record) => record["count"] === 99_999)).toBe(true);
}, 20_000);

it("separates concurrently active logger files", async () => {
  const directory = await temporaryDirectory();
  const first = await createPairLogger({}, { directory });
  const second = await createPairLogger({}, { directory });
  first.log("review.finished", { count: 1 });
  second.log("review.finished", { count: 2 });
  await Promise.all([first.close(), second.close()]);
  expect(await readdir(directory)).toHaveLength(2);
  expect(
    (await logRecords(directory))
      .map((record) => record["count"])
      .toSorted((a, b) => Number(a) - Number(b)),
  ).toEqual([1, 2]);
});

it("isolates write failures and discards already queued diagnostics safely", async () => {
  const directory = await temporaryDirectory();
  const opens = vi.spyOn(fs, "open");
  const logger = await createPairLogger({}, { directory });
  const handle = await (opens.mock.results[0]?.value as Promise<fs.FileHandle>);
  vi.spyOn(handle, "writeFile").mockRejectedValue(
    new Error("disk unavailable"),
  );
  logger.log("session.start");
  logger.log("review.started");
  await new Promise<void>((resolve) => setImmediate(resolve));
  logger.log("review.finished");
  await logger.close();
  expect(await logRecords(directory)).toEqual([]);
});

it("isolates asynchronous finalization failure", async () => {
  const directory = await temporaryDirectory();
  const opens = vi.spyOn(fs, "open");
  const logger = await createPairLogger({}, { directory });
  const handle = await (opens.mock.results[0]?.value as Promise<fs.FileHandle>);
  const close = handle.close.bind(handle);
  vi.spyOn(handle, "close").mockImplementation(async () => {
    await close();
    throw new Error("close failed");
  });
  logger.log("session.start");
  await logger.close();
  expect(await logRecords(directory)).toEqual([
    {
      level: 30,
      time: expect.any(Number) as unknown,
      msg: "pair-programmer.session.start",
    },
  ]);
});
