import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import * as changeEvidence from "../src/change-evidence.js";
import pairProgrammer from "../src/index.js";
import { PairStats, type StatsSnapshot } from "../src/pair-stats.js";
import {
  isInherited,
  reviewFile,
  ReviewTimeoutError,
  type ProposedFinding,
} from "../src/review-runner.js";
import type { Finding } from "../src/review-store.js";
import * as reviewerModule from "../src/reviewers.js";

const lifecycleLog = vi.hoisted(() => vi.fn());
vi.mock("../src/logger.js", () => ({
  createPairLogger: () =>
    Promise.resolve({
      log: lifecycleLog,
      close: () => Promise.resolve(),
    }),
}));

const realpathPauses = vi.hoisted(() => new Map<string, Promise<null>[]>());
const matchingCalls = vi.hoisted(() => new Map<string, number>());
const statCalls = vi.hoisted(() => new Map<string, number>());
const realpathCompletions = vi.hoisted(() => new Map<string, number>());
const realpathCalls = vi.hoisted(() => new Map<string, number>());
const realpathFinished = vi.hoisted(() => new Map<string, number>());
const sourceReadPauses = vi.hoisted(() => new Map<string, Promise<null>[]>());
const sourceReadCalls = vi.hoisted(() => new Map<string, number>());
const sourceReadFinished = vi.hoisted(() => new Map<string, number>());

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof fsPromises>();
  return {
    ...original,
    realpath: async (requested: string) => {
      realpathCalls.set(requested, (realpathCalls.get(requested) ?? 0) + 1);
      const pause = realpathPauses.get(requested)?.shift();
      try {
        if (pause !== undefined) await pause;
        return await original.realpath(requested);
      } finally {
        realpathFinished.set(
          requested,
          (realpathFinished.get(requested) ?? 0) + 1,
        );
        if (pause !== undefined)
          realpathCompletions.set(
            requested,
            (realpathCompletions.get(requested) ?? 0) + 1,
          );
      }
    },
    stat: async (requested: string) => {
      const result = await original.stat(requested);
      statCalls.set(requested, (statCalls.get(requested) ?? 0) + 1);
      return result;
    },
    readFile: async (requested: string, encoding: "utf8") => {
      sourceReadCalls.set(requested, (sourceReadCalls.get(requested) ?? 0) + 1);
      const pause = sourceReadPauses.get(requested)?.shift();
      try {
        if (pause !== undefined) await pause;
        return await original.readFile(requested, encoding);
      } finally {
        sourceReadFinished.set(
          requested,
          (sourceReadFinished.get(requested) ?? 0) + 1,
        );
      }
    },
  };
});

vi.mock("../src/reviewers.js", async (importOriginal) => {
  const original = await importOriginal<typeof reviewerModule>();
  return {
    ...original,
    matchingReviewers: (
      file: string,
      reviewers: readonly reviewerModule.ReviewerConfig[],
    ) => {
      matchingCalls.set(file, (matchingCalls.get(file) ?? 0) + 1);
      return original.matchingReviewers(file, reviewers);
    },
  };
});

vi.mock("../src/review-runner.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  reviewFile: vi.fn(),
  isInherited: vi.fn(),
}));

const systemOne = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock("@typesafe-ai/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TypeSafeClient: class {
    readonly systemOne = systemOne;
  },
}));

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
interface DecisionTool {
  execute: (
    id: string,
    params: {
      findingId: string;
      decision: "accept" | "reject";
      reason: string;
    },
  ) => Promise<{ details: { saved: boolean } }>;
}

interface JournalEntry {
  type: "custom";
  customType: "pair-programmer";
  data: {
    action: string;
    finding?: Finding;
    id?: string;
    ids?: string[];
    enabled?: boolean;
  };
}

function findings(entries: JournalEntry[]): Finding[] {
  return entries.flatMap((entry) =>
    entry.data.action === "add" && entry.data.finding
      ? [entry.data.finding]
      : [],
  );
}

async function advanceReviews(assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await vi.advanceTimersByTimeAsync(150);
    assertion();
  });
}

async function pauseSourceRead(
  file: string,
  previousResolutions: number,
): Promise<{ resolve: (value: null) => void; canonical: string }> {
  const canonical = path.join(
    await fsPromises.realpath(path.dirname(file)),
    path.basename(file),
  );
  const previousReads = sourceReadCalls.get(canonical) ?? 0;
  await vi.waitFor(() => {
    expect(realpathFinished.get(file)).toBe(previousResolutions + 1);
  });
  const paused = Promise.withResolvers<null>();
  sourceReadPauses.set(canonical, [paused.promise]);
  await advanceReviews(() => {
    expect(sourceReadCalls.get(canonical)).toBe(previousReads + 1);
  });
  return { resolve: paused.resolve, canonical };
}

async function pausePreparation(
  file: string,
  previousResolutions: number,
): Promise<{ resolve: (value: null) => void; canonical: string }> {
  const canonical = path.join(
    await fsPromises.realpath(path.dirname(file)),
    path.basename(file),
  );
  const previousCanonicalCalls = realpathCalls.get(canonical) ?? 0;
  await vi.waitFor(() => {
    expect(realpathFinished.get(file)).toBe(previousResolutions + 1);
  });
  const paused = Promise.withResolvers<null>();
  realpathPauses.set(canonical, [paused.promise]);
  await advanceReviews(() => {
    expect(realpathCalls.get(canonical)).toBe(previousCanonicalCalls + 1);
  });
  return { resolve: paused.resolve, canonical };
}

const directories: string[] = [];
let testSession = "";

async function setup(
  host: "pi" | "omp" = "pi",
  aliasedCwd = false,
  useDefaults = false,
  beforeStart?: (
    cwd: string,
    ctx: ExtensionContext,
    emit: (name: string, event?: unknown) => Promise<unknown>,
  ) => Promise<void>,
): Promise<{
  cwd: string;
  ctx: ExtensionContext;
  emit: (name: string, event?: unknown) => Promise<unknown>;
  command: (name: string) => Promise<void>;
  decide: DecisionTool["execute"];
  sendMessage: Mock<ExtensionAPI["sendMessage"]>;
  isIdle: Mock<() => boolean>;
  notify: ReturnType<typeof vi.fn>;
  entries: JournalEntry[];
  statsEntries: unknown[];
  activateStatsJournal: (sessionId: string) => unknown[];
  custom: Mock<ExtensionContext["ui"]["custom"]>;
  failEntry: (error?: Error) => void;
  entryAttempts: () => number;
}> {
  const directory = await fsPromises.mkdtemp(
    path.join(tmpdir(), "pair-programmer-extension-"),
  );
  directories.push(directory);
  const cwd = aliasedCwd ? path.join(directory, "aliased-cwd") : directory;
  if (aliasedCwd) await fsPromises.symlink(directory, cwd, "dir");
  if (!useDefaults) {
    await fsPromises.writeFile(
      path.join(cwd, "pair-programmer.reviewers.json"),
      JSON.stringify({
        reviewers: [
          {
            model: "current",
            prompt: "Review behavior",
            include: ["**/*"],
            exclude: [],
          },
          {
            model: "current",
            prompt: "Review risks",
            include: ["**/*"],
            exclude: [],
          },
        ],
      }),
    );
  }
  const hooks = new Map<string, Handler>();
  const commands = new Map<
    string,
    Parameters<ExtensionAPI["registerCommand"]>[1]
  >();
  const entries: JournalEntry[] = [];
  const statsEntries: unknown[] = [];
  let activeStatsEntries = statsEntries;
  const statsJournals = new Map<string, unknown[]>([
    [testSession, statsEntries],
  ]);
  const custom = vi.fn<ExtensionContext["ui"]["custom"]>();
  const transcript: unknown[] = [];
  let entryError: Error | undefined;
  let entryAttempts = 0;
  const notify = vi.fn();
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  const isIdle = vi.fn<() => boolean>(() => false);
  let decide: DecisionTool["execute"] | undefined;
  pairProgrammer({
    on(name: string, handler: Handler) {
      hooks.set(name, handler);
    },
    registerTool(tool: DecisionTool) {
      decide = tool.execute;
    },
    registerCommand(
      name: string,
      command: Parameters<ExtensionAPI["registerCommand"]>[1],
    ) {
      commands.set(name, command);
    },
    sendMessage,
    appendEntry(customType: string, data: unknown) {
      if (customType === "pair-programmer-stats") {
        if (entryError !== undefined) throw entryError;
        const entry = { type: "custom", customType, data };
        activeStatsEntries.push(entry);
        transcript.push(entry);
        return;
      }
      entryAttempts += 1;
      if (entryError !== undefined) throw entryError;
      if (customType !== "pair-programmer")
        throw new Error(`Unexpected entry ${customType}`);
      const entry: JournalEntry = {
        type: "custom",
        customType,
        data: data as JournalEntry["data"],
      };
      entries.push(entry);
      transcript.push(entry);
    },
  } as unknown as ExtensionAPI);
  if (decide === undefined) throw new Error("Decision tool not registered");
  const ctx = {
    cwd,
    model: { provider: "openai", id: "gpt-5" },
    modelRegistry: host === "pi" ? { streamSimple: vi.fn() } : {},
    isIdle,
    sessionManager: {
      getLeafId: () => null,
      getBranch: () => entries,
      getHeader: vi.fn(() => ({ id: testSession })),
      getEntries: vi.fn(() => transcript),
    },
    hasUI: true,
    mode: host === "pi" ? "tui" : undefined,
    ui: { notify, custom },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown = {}): Promise<unknown> => {
    const handler = hooks.get(name);
    if (!handler) throw new Error(`Missing ${name} hook`);
    return await handler(event, ctx);
  };
  await beforeStart?.(cwd, ctx, emit);
  await emit("session_start", host === "pi" ? { reason: "startup" } : {});
  return {
    cwd,
    ctx,
    emit,
    command: async (name: string) => {
      const registered = commands.get(name);
      if (!registered) throw new Error(`Missing ${name} command`);
      await registered.handler("", ctx as ExtensionCommandContext);
    },
    decide,
    sendMessage,
    isIdle,
    notify,
    entries,
    statsEntries,
    activateStatsJournal: (sessionId: string) => {
      let journal = statsJournals.get(sessionId);
      if (journal === undefined) {
        journal = [];
        statsJournals.set(sessionId, journal);
      }
      activeStatsEntries = journal;
      Object.assign(ctx.sessionManager, {
        getHeader: () => ({ id: sessionId }),
        getEntries: () => activeStatsEntries,
      });
      return journal;
    },
    custom,
    failEntry: (error?: Error) => {
      entryError = error;
    },
    entryAttempts: () => entryAttempts,
  };
}

function resettableSession(ctx: ExtensionContext): (type: string) => void {
  const journal = ctx.sessionManager.getEntries() as { type: string }[];
  Object.assign(ctx.sessionManager, {
    getBranch: () => journal,
    getLeafId: () => (journal.length === 0 ? null : String(journal.length - 1)),
    getEntry: (id: string) => {
      const entry = journal[Number(id)];
      return entry === undefined
        ? undefined
        : {
            ...entry,
            id,
            parentId: Number(id) === 0 ? null : String(Number(id) - 1),
          };
    },
  });
  return (type) => {
    journal.push({ type });
  };
}

function persistedStats(
  entries: readonly unknown[],
  sessionId = testSession,
): StatsSnapshot {
  const stats = new PairStats(
    createHash("sha256").update(sessionId).digest("hex"),
    vi.fn(),
  );
  stats.restore(entries);
  return stats.snapshot();
}

type StatsFactory = Parameters<ExtensionContext["ui"]["custom"]>[0];
async function openStatistics(environment: {
  custom: Mock<ExtensionContext["ui"]["custom"]>;
  command: (name: string) => Promise<void>;
}): Promise<string[]> {
  let lines: string[] = [];
  environment.custom.mockImplementation(
    async (factory: StatsFactory): Promise<void> => {
      const component = await factory(
        {
          terminal: { rows: 100 },
          requestRender: vi.fn(),
        } as unknown as Parameters<StatsFactory>[0],
        {} as Parameters<StatsFactory>[1],
        {} as Parameters<StatsFactory>[2],
        vi.fn(),
      );
      lines = component.render(240);
      component.dispose?.();
    },
  );
  await environment.command("pair-stats");
  return lines;
}

beforeEach(() => {
  testSession = randomUUID();
  lifecycleLog.mockClear();
  realpathPauses.clear();
  matchingCalls.clear();
  statCalls.clear();
  realpathCompletions.clear();
  realpathCalls.clear();
  realpathFinished.clear();
  sourceReadPauses.clear();
  sourceReadCalls.clear();
  sourceReadFinished.clear();
  vi.useFakeTimers();
  vi.mocked(reviewFile).mockReset();
  vi.mocked(isInherited).mockReset();
  vi.mocked(isInherited).mockResolvedValue(false);
  systemOne.mockReset();
  systemOne.mockResolvedValue({ answers: { duplicate: { noul: 0 } } });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        fsPromises.rm(directory, { recursive: true, force: true }),
      ),
  );
});

it.each(["success", "failed", "timeout", "cancelled"] as const)(
  "accounts for %s reviewer calls without background terminal output",
  async (outcome) => {
    const environment = await setup("pi", false, true);
    vi.mocked(reviewFile).mockImplementation((request) => {
      request.onModelCall?.({
        stage: "review",
        requestedModel: request.model,
        model: "observed-model",
        provider: "observed-provider",
        outcome,
        durationMs: 15,
        usage: { inputTokens: 11, outputTokens: 2, costUsd: 0.003 },
      });
      return Promise.resolve([]);
    });
    await fsPromises.writeFile(
      path.join(environment.cwd, "private-file.ts"),
      "const privateSource = 'must not log';\n",
    );
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: "private-file.ts" },
      isError: false,
    });
    await advanceReviews(() => {
      expect(persistedStats(environment.statsEntries).finished).toBe(1);
    });
    const snapshot = persistedStats(environment.statsEntries);
    expect(snapshot.reviews).toMatchObject({ [outcome]: 1 });
    expect(snapshot.usage[0]).toMatchObject({
      model: "observed-model",
      provider: "observed-provider",
      inputTokens: { value: 11, measured: 1 },
      costUsd: { value: 0.003, measured: 1 },
    });
    expect(environment.notify).not.toHaveBeenCalled();
    expect(environment.custom).not.toHaveBeenCalled();
    expect(environment.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(lifecycleLog.mock.calls)).not.toContain(
      "private-file",
    );
    expect(JSON.stringify(lifecycleLog.mock.calls)).not.toContain(
      "must not log",
    );
    expect(JSON.stringify(lifecycleLog.mock.calls)).not.toContain(
      "observed-model",
    );
    const lines = await openStatistics(environment);
    expect(lines.join("\n")).toContain("observed-provider/observed-model");
    await environment.emit("session_shutdown");
  },
);

it("does not acquire baseline or resume activity when shutdown races with journal restoration", async () => {
  const capture = vi.spyOn(changeEvidence, "captureBaseline");
  const environment = await setup("pi", false, true, (_cwd, ctx, emit) => {
    Object.assign(ctx.sessionManager, {
      getBranch: () => {
        void emit("session_shutdown");
        return [];
      },
    });
    return Promise.resolve();
  });
  expect(capture).not.toHaveBeenCalled();
  expect(environment.notify).not.toHaveBeenCalled();
  expect(environment.sendMessage).not.toHaveBeenCalled();
  expect(
    lifecycleLog.mock.calls.some(([event]) => event === "session.start"),
  ).toBe(false);
  capture.mockRestore();
});

it("keeps attribution fail-open while recording its failed call separately from the completed review", async () => {
  const environment = await setup("pi", false, true);
  vi.mocked(reviewFile).mockResolvedValue([
    {
      line: 1,
      title: "Broken call",
      quote: "broken()",
      evidence: "Throws on invocation",
    },
  ]);
  vi.mocked(isInherited).mockImplementation((request) => {
    request.onModelCall?.({
      stage: "attribution",
      requestedModel: "jev-latest",
      outcome: "failed",
      durationMs: 4,
    });
    return Promise.resolve(false);
  });
  await fsPromises.writeFile(
    path.join(environment.cwd, "change.ts"),
    "broken();\n",
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(persistedStats(environment.statsEntries).reviews.success).toBe(1);
  });
  expect(findings(environment.entries).map((finding) => finding.title)).toEqual(
    ["Broken call"],
  );
  expect(persistedStats(environment.statsEntries).usage).toMatchObject([
    { stage: "attribution", outcomes: { failed: 1 }, costUsd: { measured: 0 } },
  ]);
  await environment.emit("session_shutdown");
});

it("never wakes the main agent from idle lifecycle events while review is disabled", async () => {
  const environment = await setup("omp", false, true);
  await environment.command("pair-programmer");
  await environment.emit("agent_settled");
  await environment.emit("agent_end");
  expect(environment.sendMessage).not.toHaveBeenCalled();
  expect(reviewFile).not.toHaveBeenCalled();
  await environment.emit("session_shutdown");
});

it("records a reviewer timeout before model startup without inventing a model call", async () => {
  const environment = await setup("pi", false, true);
  vi.mocked(reviewFile).mockRejectedValue(
    new ReviewTimeoutError("process deadline"),
  );
  await fsPromises.writeFile(
    path.join(environment.cwd, "change.ts"),
    "export const x = 1;\n",
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(persistedStats(environment.statsEntries).reviews.timeout).toBe(1);
  });
  expect(persistedStats(environment.statsEntries).usage).toEqual([]);
  await environment.emit("session_shutdown");
});

it("keeps late usage on the originating session after cancellation and session switching", async () => {
  const environment = await setup("omp", false, true);
  const pending = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile).mockImplementation(async (request) => {
    const findings = await pending.promise;
    request.onModelCall?.({
      stage: "review",
      requestedModel: request.model,
      outcome: "cancelled",
      durationMs: 50,
      usage: { inputTokens: 30 },
    });
    return findings;
  });
  await fsPromises.writeFile(
    path.join(environment.cwd, "change.ts"),
    "export const x = 1;\n",
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledOnce();
  });
  expect((await openStatistics(environment)).join("\n")).toContain("Running 1");
  await environment.emit("session_before_switch");
  const newJournal = environment.activateStatsJournal("new-session");
  await environment.emit("session_switch", { reason: "new" });
  expect(persistedStats(environment.statsEntries)).toMatchObject({
    reviews: { cancelled: 1 },
    incompleteJobs: 1,
  });
  pending.resolve([]);
  await vi.waitFor(() => {
    expect(vi.mocked(reviewFile).mock.settledResults[0]?.type).toBe(
      "fulfilled",
    );
  });

  expect(persistedStats(environment.statsEntries)).toMatchObject({
    incompleteJobs: 1,
    usage: [],
  });
  expect(newJournal).toEqual([]);
  expect((await openStatistics(environment)).join("\n")).toContain(
    "No finalized extension model calls",
  );
  environment.activateStatsJournal(testSession);
  await environment.emit("session_switch", { reason: "resume" });
  await vi.waitFor(() => {
    expect(persistedStats(environment.statsEntries).incompleteJobs).toBe(0);
  });
  expect(
    persistedStats(environment.statsEntries).usage[0]?.inputTokens.value,
  ).toBe(30);
  expect(newJournal).toEqual([]);
  const resumed = (await openStatistics(environment)).join("\n");
  expect(resumed).toContain("Cancelled 1");
  expect(resumed).toContain("30 (complete 1/1)");
  expect(environment.sendMessage).not.toHaveBeenCalled();
  await environment.emit("session_shutdown");
});

it("rebinds late origin usage after Pi replaces and reloads extension factories", async () => {
  const old = await setup("pi", false, true);
  const pending = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile).mockImplementation(async (request) => {
    const findings = await pending.promise;
    request.onModelCall?.({
      stage: "review",
      requestedModel: request.model,
      outcome: "cancelled",
      durationMs: 10,
      usage: { inputTokens: 23 },
    });
    return findings;
  });
  await fsPromises.writeFile(
    path.join(old.cwd, "change.ts"),
    "export const x = 1;\n",
  );
  await old.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledOnce();
  });
  await old.emit("session_before_switch");
  await old.emit("session_shutdown");
  const other = await setup("pi", false, true, (_cwd, ctx) => {
    Object.assign(ctx.sessionManager, {
      getHeader: () => ({ id: "other-session" }),
    });
    return Promise.resolve();
  });
  pending.resolve([]);
  await vi.waitFor(() => {
    expect(vi.mocked(reviewFile).mock.settledResults[0]?.type).toBe(
      "fulfilled",
    );
  });
  expect(persistedStats(old.statsEntries)).toMatchObject({
    incompleteJobs: 1,
    usage: [],
  });
  expect(other.statsEntries).toEqual([]);
  await other.emit("session_shutdown");
  const resumed = await setup("pi", false, true, (_cwd, ctx) => {
    Object.assign(ctx.sessionManager, { getEntries: () => old.statsEntries });
    return Promise.resolve();
  });
  expect(
    persistedStats([...old.statsEntries, ...resumed.statsEntries]),
  ).toMatchObject({
    incompleteJobs: 0,
    reviews: { cancelled: 1 },
    usage: [{ inputTokens: { value: 23, measured: 1 } }],
  });
  expect(other.statsEntries).toEqual([]);
  expect(resumed.sendMessage).not.toHaveBeenCalled();
  await resumed.emit("session_shutdown");
});

it("counts a recovered reviewer job as completed while retaining both model call outcomes", async () => {
  const environment = await setup("pi", false, true);
  vi.mocked(reviewFile).mockImplementation((request) => {
    for (const outcome of ["failed", "success"] as const)
      request.onModelCall?.({
        stage: "review",
        requestedModel: request.model,
        outcome,
        durationMs: 5,
        usage: { inputTokens: 2 },
      });
    return Promise.resolve([]);
  });
  await fsPromises.writeFile(
    path.join(environment.cwd, "change.ts"),
    "export const x = 1;\n",
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(persistedStats(environment.statsEntries).reviews.success).toBe(1);
  });
  expect(persistedStats(environment.statsEntries)).toMatchObject({
    reviews: { failed: 0 },
    usage: [
      {
        calls: 2,
        outcomes: { failed: 1, success: 1 },
        inputTokens: { value: 4, measured: 2 },
      },
    ],
  });
  await environment.emit("session_shutdown");
});

it.each(["changed", "invalid", "unavailable"] as const)(
  "guards asynchronous accounting when the journal manager becomes %s",
  async (mode) => {
    let managerState = "valid";
    const environment = await setup("pi", false, true, (_cwd, ctx) => {
      Object.assign(ctx.sessionManager, {
        getSessionId: () => {
          if (managerState === "invalid") throw new Error("replaced context");
          if (managerState === "changed") return "another-journal";
          return managerState === "unavailable" ? undefined : testSession;
        },
        getHeader: () =>
          managerState === "unavailable" ? undefined : { id: testSession },
      });
      return Promise.resolve();
    });
    const pending = Promise.withResolvers<ProposedFinding[]>();
    vi.mocked(reviewFile).mockImplementation(async (request) => {
      const result = await pending.promise;
      request.onModelCall?.({
        stage: "review",
        requestedModel: request.model,
        outcome: "success",
        durationMs: 1,
        usage: { inputTokens: 19 },
      });
      return result;
    });
    await fsPromises.writeFile(
      path.join(environment.cwd, "change.ts"),
      "export const x = 1;\n",
    );
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: "change.ts" },
      isError: false,
    });
    await advanceReviews(() => {
      expect(reviewFile).toHaveBeenCalledOnce();
    });
    managerState = mode;
    pending.resolve([]);
    await vi.waitFor(() => {
      expect(vi.mocked(reviewFile).mock.settledResults[0]?.type).toBe(
        "fulfilled",
      );
    });
    if (mode !== "unavailable")
      expect(persistedStats(environment.statsEntries)).toMatchObject({
        incompleteJobs: 1,
        usage: [],
      });
    managerState = "valid";
    await environment.emit("session_start", { reason: "resume" });
    await vi.waitFor(() => {
      expect(persistedStats(environment.statsEntries)).toMatchObject({
        incompleteJobs: 0,
        usage: [{ inputTokens: { value: 19, measured: 1 } }],
      });
    });
    await environment.emit("session_shutdown");
  },
);

it("keeps the original journal writable when a pre-switch event is followed by a cancelled switch", async () => {
  const environment = await setup("pi", false, true);
  const pending = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile).mockImplementation(async (request) => {
    const result = await pending.promise;
    request.onModelCall?.({
      stage: "review",
      requestedModel: request.model,
      outcome: request.signal.aborted ? "cancelled" : "success",
      durationMs: 5,
      usage: { inputTokens: 7 },
    });
    return result;
  });
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const x = 1;\n");
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledOnce();
  });
  await environment.emit("session_before_switch");
  pending.resolve([]);
  await vi.waitFor(() => {
    expect(persistedStats(environment.statsEntries).incompleteJobs).toBe(0);
  });
  expect(
    persistedStats(environment.statsEntries).usage[0]?.inputTokens.value,
  ).toBe(7);
  await fsPromises.writeFile(file, "export const x = 2;\n");
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(persistedStats(environment.statsEntries).reviews.success).toBe(1);
  });
  expect(
    persistedStats(environment.statsEntries).usage[0]?.inputTokens.value,
  ).toBe(14);
  await environment.emit("session_shutdown");
});

it("restores selected-branch findings without rewinding session-incurred review activity", async () => {
  const environment = await setup("pi", false, true);
  vi.mocked(reviewFile).mockResolvedValue([
    {
      line: 1,
      title: "Fault",
      quote: "broken()",
      evidence: "Fails on invocation",
    },
  ]);
  await fsPromises.writeFile(
    path.join(environment.cwd, "change.ts"),
    "broken();\n",
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(1);
  });
  await environment.emit("turn_end");
  const branchPoint = [...environment.entries];
  const finding = findings(environment.entries)[0];
  if (finding === undefined) throw new Error("missing finding");
  await environment.decide("decision", {
    findingId: finding.id,
    decision: "accept",
    reason: "confirmed",
  });
  expect((await openStatistics(environment)).join("\n")).toContain(
    "Accepted 1",
  );
  Object.assign(environment.ctx.sessionManager, {
    getBranch: () => branchPoint,
  });
  await environment.emit("session_tree");
  const snapshot = (await openStatistics(environment)).join("\n");
  expect(snapshot).toContain("Accepted 0");
  expect(snapshot).toContain("awaiting decision 1");
  expect(snapshot).toContain("completed 1");
  await environment.emit("session_shutdown");
});

it("keeps review behavior and in-memory accounting when diagnostic persistence is unavailable", async () => {
  const environment = await setup("pi", false, true);
  environment.failEntry(new Error("private filesystem details"));
  vi.mocked(reviewFile).mockImplementation((request) => {
    request.onModelCall?.({
      stage: "review",
      requestedModel: request.model,
      outcome: "success",
      durationMs: 10,
    });
    return Promise.resolve([]);
  });
  await fsPromises.writeFile(
    path.join(environment.cwd, "change.ts"),
    "export const ok = 1;\n",
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(lifecycleLog).toHaveBeenCalledWith(
      "review.finished",
      expect.objectContaining({ outcome: "success" }),
    );
  });
  const snapshot = (await openStatistics(environment)).join("\n");
  expect(snapshot).toContain("completed 1");
  expect(snapshot).toContain("Storage unavailable for 3 record(s)");
  expect(environment.notify).not.toHaveBeenCalled();
  expect(JSON.stringify(lifecycleLog.mock.calls)).not.toContain(
    "private filesystem details",
  );
  environment.failEntry();
  await environment.emit("session_shutdown");
});

const inheritedSource = [
  "export function displayProfile(user: { name: string } | null) {",
  "  const normalized = user.name.trim().toLowerCase();",
  "  return `Profile display name: ${normalized}`;",
  "}",
  "displayProfile(null);",
  "",
].join("\n");
const inheritedProposal: ProposedFinding = {
  line: 2,
  title: "Inherited null dereference",
  quote: "user.name",
  evidence: "Calling displayProfile(null) throws before rendering the profile",
};

it("starts every reviewer at once and separates attribution and deduplication without adding model context", async () => {
  const environment = await setup("pi", false, false, async (cwd) => {
    await fsPromises.writeFile(
      path.join(cwd, "pair-programmer.reviewers.json"),
      JSON.stringify({
        reviewers: [0, 1, 2].map((index) => ({
          model: "current",
          prompt: `private-prompt-${String(index)}`,
          include: ["**/*"],
          exclude: [],
        })),
      }),
    );
  });
  const reviews = Array.from({ length: 3 }, () =>
    Promise.withResolvers<ProposedFinding[]>(),
  );
  const attributions = Array.from({ length: 2 }, () =>
    Promise.withResolvers<boolean>(),
  );
  let reviewIndex = 0;
  let attributionIndex = 0;
  vi.mocked(reviewFile).mockImplementation(async () => {
    const pending = reviews[reviewIndex++];
    if (pending === undefined) throw new Error("Unexpected review");
    return await pending.promise;
  });
  vi.mocked(isInherited).mockImplementation(async () => {
    const pending = attributions[attributionIndex++];
    if (pending === undefined) throw new Error("Unexpected attribution");
    return await pending.promise;
  });
  await fsPromises.writeFile(
    path.join(environment.cwd, "change.ts"),
    inheritedSource,
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(3);
  });
  reviews[0]?.resolve([inheritedProposal]);
  await vi.waitFor(() => {
    expect(isInherited).toHaveBeenCalledTimes(1);
  });
  reviews[1]?.resolve([inheritedProposal]);
  await vi.waitFor(() => {
    expect(isInherited).toHaveBeenCalledTimes(2);
  });
  attributions[0]?.resolve(false);
  await vi.waitFor(() => {
    expect(findings(environment.entries)).toHaveLength(1);
  });
  attributions[1]?.resolve(false);
  reviews[2]?.resolve([]);
  await vi.waitFor(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  expect(environment.sendMessage).not.toHaveBeenCalled();
  expect(environment.notify).not.toHaveBeenCalled();
  expect(
    await environment.emit("context", {
      messages: [{ role: "user", content: "Continue" }],
    }),
  ).toBeUndefined();
  await environment.emit("before_agent_start");
  expect(environment.sendMessage).toHaveBeenCalledOnce();
  for (const finding of findings(environment.entries))
    expect(environment.sendMessage.mock.calls[0]?.[0].content).toContain(
      finding.id,
    );
  await environment.emit("session_shutdown");
});

it("delivers a finding once when concurrent reviewers report it before either stores", async () => {
  const environment = await setup();
  systemOne.mockResolvedValue({ answers: { duplicate: { noul: 1 } } });
  vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
  await fsPromises.writeFile(
    path.join(environment.cwd, "change.ts"),
    inheritedSource,
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(systemOne.mock.settledResults[0]?.type).toBe("fulfilled");
  });
  expect(findings(environment.entries)).toHaveLength(1);
  await environment.emit("turn_end");
  await environment.emit("tool_call", { toolName: "bash", input: {} });
  expect(environment.sendMessage).toHaveBeenCalledOnce();
  expect(
    environment.entries.flatMap((entry) =>
      entry.data.action === "deliver" ? (entry.data.ids ?? []) : [],
    ),
  ).toEqual([findings(environment.entries)[0]?.id]);
  await environment.emit("session_shutdown");
});

it.each(["pi", "omp"] as const)(
  "%s wakes an idle agent once for a burst of completions",
  async (host) => {
    const environment = await setup(host);
    environment.isIdle.mockReturnValue(true);
    const reviews = Array.from({ length: 4 }, () =>
      Promise.withResolvers<ProposedFinding[]>(),
    );
    let index = 0;
    vi.mocked(reviewFile).mockImplementation(
      () => reviews[index++]?.promise ?? Promise.resolve([]),
    );
    for (const name of ["first.ts", "second.ts"]) {
      await fsPromises.writeFile(
        path.join(environment.cwd, name),
        "export const value = 1;\n",
      );
      await environment.emit("tool_result", {
        toolName: "write",
        input: { path: name },
        isError: false,
      });
    }
    await advanceReviews(() => {
      expect(reviewFile).toHaveBeenCalledTimes(4);
    });
    for (const [position, review] of reviews.entries())
      review.resolve([
        {
          line: 1,
          title: `Issue ${String(position)}`,
          quote: "value",
          evidence: "Concrete consequence",
        },
      ]);
    await vi.waitFor(() => {
      expect(findings(environment.entries)).toHaveLength(4);
    });
    expect(environment.sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    await environment.emit("agent_settled");
    expect(environment.sendMessage).toHaveBeenCalledOnce();
    expect(environment.sendMessage.mock.calls[0]?.[1]).toEqual(
      host === "pi"
        ? { triggerTurn: true }
        : { deliverAs: "nextTurn", triggerTurn: true },
    );
    for (const finding of findings(environment.entries))
      expect(environment.sendMessage.mock.calls[0]?.[0].content).toContain(
        finding.id,
      );
    vi.mocked(reviewFile).mockResolvedValue([
      { line: 1, title: "Later", quote: "value", evidence: "Next burst" },
    ]);
    await fsPromises.writeFile(
      path.join(environment.cwd, "second.ts"),
      "export const value = 2;\n",
    );
    await environment.emit("tool_result", {
      toolName: "edit",
      input: { path: "second.ts" },
      isError: false,
    });
    await environment.emit("agent_start");
    await advanceReviews(() => {
      expect(reviewFile).toHaveBeenCalledTimes(6);
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(environment.sendMessage).toHaveBeenCalledOnce();
    await environment.emit("session_shutdown");
  },
);

it("defers completions of a busy agent to the next boundary and wakes when its run settles", async () => {
  const environment = await setup("pi");
  vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
  await fsPromises.writeFile(
    path.join(environment.cwd, "change.ts"),
    inheritedSource,
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  await vi.advanceTimersByTimeAsync(300);
  expect(environment.sendMessage).not.toHaveBeenCalled();
  await environment.emit("turn_end");
  expect(environment.sendMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ customType: "pair-programmer-findings" }),
    { deliverAs: "nextTurn", triggerTurn: false },
  );
  environment.isIdle.mockReturnValue(true);
  await environment.emit("agent_settled");
  expect(environment.sendMessage).toHaveBeenCalledTimes(2);
  expect(environment.sendMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ customType: "pair-programmer-findings" }),
    { triggerTurn: true },
  );
  await environment.emit("agent_start");
  await environment.emit("agent_settled");
  expect(environment.sendMessage).toHaveBeenCalledTimes(2);
  await environment.emit("session_shutdown");
});

it("does not wake an idle agent for findings superseded before the wake", async () => {
  const environment = await setup("pi");
  environment.isIdle.mockReturnValue(true);
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, inheritedSource);
  vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await vi.advanceTimersByTimeAsync(150);
  await vi.waitFor(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  vi.mocked(reviewFile).mockResolvedValue([]);
  await fsPromises.writeFile(file, "export const fixed = true;\n");
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await vi.advanceTimersByTimeAsync(130);
  await vi.waitFor(() => {
    expect(reviewFile).toHaveBeenCalledTimes(4);
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(environment.sendMessage).not.toHaveBeenCalled();
  await environment.emit("session_shutdown");
});

it("does not wake an agent that already saw its outstanding findings", async () => {
  const environment = await setup("pi");
  vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
  await fsPromises.writeFile(
    path.join(environment.cwd, "change.ts"),
    inheritedSource,
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  await environment.emit("before_agent_start");
  const [message] = environment.sendMessage.mock.calls[0] ?? [];
  await environment.emit("context", {
    messages: [{ ...message, role: "custom" }],
  });
  environment.isIdle.mockReturnValue(true);
  await environment.emit("agent_settled");
  expect(environment.sendMessage).toHaveBeenCalledOnce();
  await environment.emit("tool_call", { toolName: "bash", input: {} });
  expect(environment.sendMessage).toHaveBeenCalledOnce();
  await environment.emit("session_shutdown");
});

it.each([
  { willContinue: true, wakes: false },
  { willContinue: false, wakes: true },
  { willContinue: undefined, wakes: true },
])(
  "OMP wakes at a final agent end ($willContinue) even before reporting idle",
  async ({ willContinue, wakes }) => {
    const environment = await setup("omp");
    vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
    await fsPromises.writeFile(
      path.join(environment.cwd, "change.ts"),
      inheritedSource,
    );
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: "change.ts" },
      isError: false,
    });
    await advanceReviews(() => {
      expect(findings(environment.entries)).toHaveLength(2);
    });
    await environment.emit("agent_end", { messages: [], willContinue });
    expect(environment.sendMessage.mock.calls).toEqual(
      wakes
        ? [
            [
              expect.objectContaining({
                customType: "pair-programmer-findings",
              }),
              { deliverAs: "nextTurn", triggerTurn: true },
            ],
          ]
        : [],
    );
    await environment.emit("session_shutdown");
  },
);

it("treats a stale host context as busy and ignores Pi agent end", async () => {
  const environment = await setup("pi");
  environment.isIdle.mockImplementation(() => {
    throw new Error("stale extension context");
  });
  vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
  await fsPromises.writeFile(
    path.join(environment.cwd, "change.ts"),
    inheritedSource,
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  await vi.advanceTimersByTimeAsync(1000);
  await environment.emit("agent_end", { messages: [] });
  await environment.emit("agent_settled");
  environment.isIdle.mockReturnValue(true);
  await environment.command("pair-programmer");
  await environment.emit("agent_settled");
  expect(environment.sendMessage).not.toHaveBeenCalled();
  await environment.emit("session_shutdown");
});

it("cancels every in-flight reviewer on disable, whether it rejects or resolves late", async () => {
  const environment = await setup("pi", false, false, async (cwd) => {
    await fsPromises.writeFile(
      path.join(cwd, "pair-programmer.reviewers.json"),
      JSON.stringify({
        reviewers: [0, 1, 2].map((index) => ({
          model: "current",
          prompt: `Review criterion ${String(index)}`,
          include: ["**/*"],
          exclude: [],
        })),
      }),
    );
  });
  const pending = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile)
    .mockImplementationOnce(({ signal }) => {
      const cancelled = Promise.withResolvers<ProposedFinding[]>();
      signal.addEventListener(
        "abort",
        () => {
          cancelled.reject(new DOMException("Reviewer aborted", "AbortError"));
        },
        { once: true },
      );
      return cancelled.promise;
    })
    .mockReturnValue(pending.promise);
  await fsPromises.writeFile(
    path.join(environment.cwd, "change.ts"),
    inheritedSource,
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(3);
  });
  await environment.command("pair-programmer");
  expect(
    vi
      .mocked(reviewFile)
      .mock.calls.every(([request]) => request.signal.aborted),
  ).toBe(true);
  pending.resolve([inheritedProposal]);
  await vi.advanceTimersByTimeAsync(0);
  await environment.emit("turn_end");
  await environment.emit("before_agent_start");
  expect(reviewFile).toHaveBeenCalledTimes(3);
  expect(findings(environment.entries)).toEqual([]);
  expect(environment.sendMessage).not.toHaveBeenCalled();
  await environment.emit("session_shutdown");
});

it("aborts baseline acquisition on shutdown and ignores its late completion", async () => {
  const environment = await setup("omp", false, true);
  const delayed = Promise.withResolvers<changeEvidence.BaselineCapture>();
  const capture = vi
    .spyOn(changeEvidence, "captureBaseline")
    .mockReturnValueOnce(delayed.promise);
  Object.assign(environment.ctx.sessionManager, {
    getHeader: () => ({ id: "capturing-session" }),
    getEntries: () => [],
  });
  const starting = environment.emit("session_start", { reason: "new" });
  await vi.waitFor(() => {
    expect(capture).toHaveBeenCalledOnce();
  });
  await environment.emit("session_shutdown");
  expect(capture.mock.calls[0]?.[1]?.aborted).toBe(true);
  delayed.resolve(await changeEvidence.captureBaseline(environment.cwd));
  await starting;
  expect(reviewFile).not.toHaveBeenCalled();
  expect(environment.sendMessage).not.toHaveBeenCalled();
  capture.mockRestore();
});

it("stores no finding and holds no coding when evidence building fails", async () => {
  const environment = await setup("pi", false, true);
  const evidence = vi
    .spyOn(changeEvidence, "buildChangeEvidence")
    .mockImplementation(() => {
      throw new Error("Evidence unavailable");
    });
  vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
  await fsPromises.writeFile(
    path.join(environment.cwd, "change.ts"),
    inheritedSource,
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: "change.ts" },
    isError: false,
  });
  await advanceReviews(() => {
    expect(evidence).toHaveBeenCalledOnce();
  });
  await vi.advanceTimersByTimeAsync(150);
  expect(isInherited).not.toHaveBeenCalled();

  expect(findings(environment.entries)).toEqual([]);
  expect(
    await environment.emit("tool_call", { toolName: "bash" }),
  ).toBeUndefined();
  evidence.mockRestore();
  await environment.emit("session_shutdown");
});

it.each(["pi", "omp"] as const)(
  "%s filters inherited committed and dirty moves but keeps generated code and uncertain findings",
  async (host) => {
    const environment = await setup(host, false, true, async (cwd) => {
      await promisify(execFile)("git", ["init", "--quiet"], { cwd });
      await Promise.all(
        Array.from({ length: 80 }, (_, index) =>
          fsPromises.writeFile(
            path.join(cwd, `filler-${String(index)}.ts`),
            `export const filler = "${"x".repeat(60_000)}";\n`,
          ),
        ),
      );
      await fsPromises.writeFile(
        path.join(cwd, "committed.ts"),
        inheritedSource,
      );
      await fsPromises.writeFile(
        path.join(cwd, "dirty.ts"),
        "export const safe = true;\n",
      );
      await promisify(execFile)("git", ["add", "."], { cwd });
      await promisify(execFile)(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "Baseline",
        ],
        { cwd },
      );
      await fsPromises.writeFile(
        path.join(cwd, "dirty.ts"),
        inheritedSource.replaceAll("displayProfile", "displayDirtyProfile"),
      );
      await fsPromises.writeFile(
        path.join(cwd, "untracked.ts"),
        inheritedSource.replaceAll("displayProfile", "displayUntrackedProfile"),
      );
    });
    vi.mocked(reviewFile).mockResolvedValue([
      inheritedProposal,
      {
        ...inheritedProposal,
        title: "Uncertain consequence",
        quote: "user.name",
      },
    ]);
    vi.mocked(isInherited).mockImplementation(({ finding, evidence }) =>
      Promise.resolve(
        evidence.status === "available" &&
          finding.title === "Inherited null dereference",
      ),
    );
    for (const original of ["committed", "dirty", "untracked"]) {
      const source = await fsPromises.readFile(
        path.join(environment.cwd, `${original}.ts`),
        "utf8",
      );
      await fsPromises.rm(path.join(environment.cwd, `${original}.ts`));
      const moved = path.join(environment.cwd, `${original}-moved.ts`);
      await fsPromises.writeFile(moved, source);
      await environment.emit("tool_result", {
        toolName: "write",
        input: { path: moved },
        isError: false,
      });
    }
    await advanceReviews(() => {
      expect(
        findings(environment.entries).map((finding) => finding.title),
      ).toEqual(Array.from({ length: 3 }, () => "Uncertain consequence"));
    });
    await environment.command("pair-programmer");
    const generated = path.join(environment.cwd, "generated.ts");
    await fsPromises.writeFile(
      generated,
      inheritedSource.replaceAll("displayProfile", "generatedProfile"),
    );
    await environment.command("pair-programmer");
    await fsPromises.rename(
      generated,
      path.join(environment.cwd, "generated-moved.ts"),
    );
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: "generated-moved.ts" },
      isError: false,
    });
    await advanceReviews(() => {
      expect(
        findings(environment.entries).some(
          (finding) =>
            finding.file === "generated-moved.ts" &&
            finding.title === inheritedProposal.title,
        ),
      ).toBe(true);
    });
    await environment.emit("turn_end");
    for (const finding of findings(environment.entries).filter(
      (entry) => entry.file !== "generated-moved.ts",
    )) {
      expect(finding.title).toBe("Uncertain consequence");
    }
    expect(JSON.stringify(environment.sendMessage.mock.calls)).toContain(
      "Uncertain consequence",
    );
    await environment.emit("session_shutdown");
  },
);

it.each(["revision", "off", "shutdown"] as const)(
  "discards attribution completing after %s without holding coding",
  async (change) => {
    const environment = await setup("pi", false, true);
    const file = path.join(environment.cwd, "change.ts");
    await fsPromises.writeFile(file, inheritedSource);
    vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
    const judgment = Promise.withResolvers<boolean>();
    vi.mocked(isInherited).mockReturnValueOnce(judgment.promise);
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: file },
      isError: false,
    });
    await advanceReviews(() => {
      expect(isInherited).toHaveBeenCalledOnce();
    });
    expect(
      await environment.emit("tool_call", { toolName: "bash" }),
    ).toBeUndefined();
    if (change === "revision")
      await fsPromises.writeFile(file, "export const fixed = true;\n");
    else if (change === "off") await environment.command("pair-programmer");
    else await environment.emit("session_shutdown");
    judgment.resolve(false);
    await vi.waitFor(() => {
      expect(vi.mocked(isInherited).mock.settledResults[0]?.type).toBe(
        "fulfilled",
      );
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(findings(environment.entries)).toEqual([]);

    await environment.emit("session_shutdown");
  },
);

it.each([
  "resume",
  "fork",
  "history",
  "missing-header",
  "null-header",
  "missing-entries",
  "parent",
] as const)(
  "keeps attribution unknown on %s rather than rebaselining generated work",
  async (mode) => {
    const environment = await setup("omp", false, true);
    const file = path.join(environment.cwd, "change.ts");
    await fsPromises.writeFile(file, inheritedSource);
    const header = {
      id: "different-session",
      parentSession: mode === "parent" ? "parent" : undefined,
    };
    Object.assign(environment.ctx.sessionManager, {
      getHeader:
        mode === "missing-header"
          ? undefined
          : () => (mode === "null-header" ? null : header),
      getEntries:
        mode === "missing-entries"
          ? undefined
          : () => (mode === "history" ? [{ type: "message" }] : []),
    });
    await environment.emit(
      mode === "fork" ? "session_branch" : "session_switch",
      {
        reason: ["resume", "fork"].includes(mode) ? mode : "new",
      },
    );
    vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
    vi.mocked(isInherited).mockImplementation(({ evidence }) =>
      Promise.resolve(evidence.status === "available"),
    );
    await environment.emit("tool_result", {
      toolName: "edit",
      input: { path: file },
      isError: false,
    });
    await advanceReviews(() => {
      expect(findings(environment.entries)).toHaveLength(1);
    });
    await environment.emit("turn_end");
    expect(environment.sendMessage).toHaveBeenCalledOnce();
    await environment.emit("session_shutdown");
  },
);

it.each([
  {
    label: "model metadata",
    history: [{ type: "model_change" }, { type: "service_tier_change" }],
    inherited: true,
  },
  {
    label: "review journal",
    history: [
      {
        type: "custom",
        customType: "pair-programmer",
        data: { stage: "baseline" },
      },
    ],
    inherited: false,
  },
  {
    label: "coding messages",
    history: [
      { type: "message", message: { role: "assistant" } },
      { type: "message", message: { role: "toolResult" } },
    ],
    inherited: false,
  },
])(
  "only treats safe metadata as fresh when history contains $label",
  async ({ history, inherited }) => {
    const environment = await setup("omp", false, true, async (cwd, ctx) => {
      await fsPromises.writeFile(path.join(cwd, "change.ts"), inheritedSource);
      Object.assign(ctx.sessionManager, { getEntries: () => history });
    });
    await fsPromises.writeFile(
      path.join(environment.cwd, "change.ts"),
      `${inheritedSource}// task edit\n`,
    );
    vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
    vi.mocked(isInherited).mockImplementation(({ evidence }) =>
      Promise.resolve(evidence.status === "available"),
    );
    await environment.emit("tool_result", {
      toolName: "edit",
      input: { path: "change.ts" },
      isError: false,
    });
    await advanceReviews(() => {
      expect(vi.mocked(isInherited).mock.settledResults[0]?.type).toBe(
        "fulfilled",
      );
      expect(findings(environment.entries)).toHaveLength(inherited ? 0 : 1);
    });
    await environment.emit("session_shutdown");
  },
);

it("starts a new OMP baseline from metadata-only history and preserves it on repeated starts", async () => {
  const environment = await setup("omp", false, true);
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, inheritedSource);
  Object.assign(environment.ctx.sessionManager, {
    getHeader: () => ({ id: "new-session" }),
    getEntries: () => [
      { type: "model_change" },
      { type: "thinking_level_change" },
    ],
  });
  await environment.emit("session_switch", { reason: "new" });
  await fsPromises.writeFile(
    file,
    `${inheritedSource}// changed after capture\n`,
  );
  await environment.emit("session_start");
  vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
  vi.mocked(isInherited).mockImplementation(({ evidence }) =>
    Promise.resolve(evidence.before?.source === inheritedSource),
  );
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(vi.mocked(isInherited).mock.settledResults[0]?.type).toBe(
      "fulfilled",
    );
  });
  expect(findings(environment.entries)).toEqual([]);
  await environment.emit("session_shutdown");
});

it("does not let an older root resolution replace the active workspace", async () => {
  const environment = await setup("omp", false, true);
  const newerRoot = await fsPromises.mkdtemp(
    path.join(tmpdir(), "pair-programmer-newer-"),
  );
  directories.push(newerRoot);
  const paused = Promise.withResolvers<null>();
  realpathPauses.set(environment.cwd, [paused.promise]);
  const earlier = environment.emit("session_start");
  environment.ctx.cwd = newerRoot;
  Object.assign(environment.ctx.sessionManager, {
    getHeader: () => ({ id: "newer-session" }),
  });
  await environment.emit("session_switch", { reason: "new" });
  paused.resolve(null);
  await earlier;
  const file = path.join(newerRoot, "change.ts");
  await fsPromises.writeFile(file, inheritedSource);
  vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(
      findings(environment.entries).map((finding) => finding.file),
    ).toEqual(["change.ts"]);
  });
  await environment.emit("turn_end");
  expect(environment.sendMessage).toHaveBeenCalledOnce();
  await environment.emit("session_shutdown");
});

it.each(["resolve", "reject"] as const)(
  "preserves active reviewers when an old configuration load %ss",
  async (outcome) => {
    const environment = await setup("omp", false, true);
    const paused = Promise.withResolvers<reviewerModule.ReviewerConfig[]>();
    const entered = Promise.withResolvers<null>();
    const load = vi
      .spyOn(reviewerModule, "loadReviewers")
      .mockImplementationOnce(() => {
        entered.resolve(null);
        return paused.promise;
      })
      .mockResolvedValueOnce([
        {
          model: "current",
          prompt: "Current reviewer",
          include: ["**/*.ts"],
          exclude: [],
        },
      ]);
    const earlier = environment.emit("session_start");
    await entered.promise;
    Object.assign(environment.ctx.sessionManager, {
      getHeader: () => ({ id: "newer-session" }),
    });
    await environment.emit("session_switch", { reason: "new" });
    if (outcome === "resolve") paused.resolve([]);
    else paused.reject(new Error("old configuration invalid"));
    await earlier;
    load.mockRestore();
    const file = path.join(environment.cwd, "change.ts");
    await fsPromises.writeFile(file, inheritedSource);
    vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: file },
      isError: false,
    });
    await advanceReviews(() => {
      expect(findings(environment.entries)).toHaveLength(1);
    });
    expect(environment.notify).not.toHaveBeenCalled();
    await environment.emit("session_shutdown");
  },
);

it.each(["resolve", "reject"] as const)(
  "ignores a baseline capture that %ss after a newer session starts",
  async (outcome) => {
    const environment = await setup("omp", false, true);
    const file = path.join(environment.cwd, "change.ts");
    await fsPromises.writeFile(file, inheritedSource);
    const snapshot = await changeEvidence.captureBaseline(environment.cwd);
    const delayed = Promise.withResolvers<changeEvidence.BaselineCapture>();
    const capture = vi
      .spyOn(changeEvidence, "captureBaseline")
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(
        outcome === "resolve"
          ? { status: "unavailable", reason: "timeout" }
          : snapshot,
      );
    let sessionId = "delayed-session";
    Object.assign(environment.ctx.sessionManager, {
      getHeader: () => ({ id: sessionId }),
    });
    const earlier = environment.emit("session_switch", { reason: "new" });
    await vi.waitFor(() => {
      expect(capture).toHaveBeenCalledOnce();
    });
    sessionId = "current-session";
    await environment.emit("session_switch", { reason: "new" });
    if (outcome === "resolve") delayed.resolve(snapshot);
    else delayed.reject(new Error("cancelled acquisition"));
    await earlier;
    capture.mockRestore();
    vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
    vi.mocked(isInherited).mockImplementation(({ evidence }) =>
      Promise.resolve(evidence.status === "available"),
    );
    await environment.emit("tool_result", {
      toolName: "edit",
      input: { path: file },
      isError: false,
    });
    await advanceReviews(() => {
      expect(vi.mocked(isInherited).mock.settledResults[0]?.type).toBe(
        "fulfilled",
      );
      expect(findings(environment.entries)).toHaveLength(
        outcome === "resolve" ? 1 : 0,
      );
    });
    await environment.emit("session_shutdown");
  },
);

it("keeps ordinary reviews working after a failed baseline capture", async () => {
  const capture = vi
    .spyOn(changeEvidence, "captureBaseline")
    .mockRejectedValueOnce(new Error("snapshot unreadable"));
  const environment = await setup("pi", false, true);
  capture.mockRestore();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, inheritedSource);
  vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(1);
  });
  await environment.emit("turn_end");
  expect(environment.sendMessage).toHaveBeenCalledOnce();
  await environment.emit("session_shutdown");
});

it("runs one built-in reviewer for a write without project configuration", async () => {
  const environment = await setup("pi", false, true);
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  vi.mocked(reviewFile).mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledOnce();
  });
  expect(vi.mocked(reviewFile).mock.calls[0]?.[0].model).toBe("openai/gpt-5");
  await environment.emit("session_shutdown");
});

it.each(["pi", "omp"] as const)(
  "%s gates coding until a direct or routed decision is persisted with a reason",
  async (host) => {
    const environment = await setup(host);
    const file = path.join(environment.cwd, "change.ts");
    await fsPromises.writeFile(
      file,
      "const user = null;\nconsole.log(user.name);\n",
    );
    const { promise, resolve } = Promise.withResolvers<ProposedFinding[]>();
    vi.mocked(reviewFile).mockReturnValueOnce(promise).mockResolvedValue([]);

    expect(
      await environment.emit("tool_result", {
        toolName: "write",
        input: { path: file },
        isError: false,
      }),
    ).toBeUndefined();
    expect(
      await environment.emit("tool_call", { toolName: "edit" }),
    ).toBeUndefined();
    await advanceReviews(() => {
      expect(reviewFile).toHaveBeenCalledTimes(2);
    });
    resolve([
      {
        line: 2,
        title: "Null dereference",
        quote: "user.name",
        evidence: "A missing user throws",
      },
    ]);
    await advanceReviews(() => {
      expect(findings(environment.entries)).toHaveLength(1);
    });
    await environment.emit("turn_end");
    expect(environment.sendMessage).toHaveBeenCalledOnce();
    const blocked = await environment.emit("tool_call", { toolName: "edit" });
    if (
      typeof blocked !== "object" ||
      blocked === null ||
      !("reason" in blocked)
    ) {
      throw new Error("Expected a blocked tool");
    }
    expect(blocked).toMatchObject({ block: true });
    expect(blocked.reason).toContain("Null dereference");
    const identifier = findings(environment.entries)[0]?.id;
    if (identifier === undefined || identifier.length === 0)
      throw new Error("Missing recorded finding");
    const params = {
      findingId: identifier,
      decision: "reject" as const,
      reason: "The input is always present",
    };
    const decisionCall =
      host === "pi"
        ? { toolName: "pair_programmer_decide", input: params }
        : {
            toolName: "write",
            input: {
              path: "xd://pair_programmer_decide",
              content: JSON.stringify(params),
            },
          };
    const gatedCalls = [
      { toolName: "read", input: { path: "xd://another_tool" } },
      { toolName: "read", input: {} },
      { toolName: "bash", input: { command: "npm run check" } },
      { toolName: "todo", input: { op: "done", task: "Verify" } },
      { toolName: "edit", input: { path: "xd://pair_programmer_decide" } },
      { toolName: "write", input: {} },
      ...[
        file,
        "xd://another_tool",
        "xd://pair_programmer_decide/",
        "xd://pair_programmer_decide?extra=true",
        "xd://Pair_Programmer_Decide",
        "xd://pair_programmer_decide_extra",
      ].map((target) => ({
        toolName: "write",
        input: { path: target, content: JSON.stringify(params) },
      })),
    ];
    for (const call of gatedCalls) {
      expect(await environment.emit("tool_call", call)).toMatchObject({
        block: true,
      });
    }
    for (const target of [
      "xd://pair_programmer_decide",
      " XD://pair_programmer_decide\n",
    ]) {
      expect(
        await environment.emit("tool_call", {
          toolName: "read",
          input: { path: target },
        }),
      ).toBeUndefined();
    }
    expect(await environment.emit("tool_call", decisionCall)).toBeUndefined();
    expect(
      (await environment.decide("decision", { ...params, reason: " \n " }))
        .details.saved,
    ).toBe(false);
    expect(
      environment.entries.some((entry) => entry.data.action === "decide"),
    ).toBe(false);
    expect(await environment.emit("tool_call", gatedCalls[0])).toMatchObject({
      block: true,
    });

    environment.failEntry(new Error("Session storage unavailable"));
    await expect(async () => {
      await environment.decide("decision", params);
    }).rejects.toThrow("Session storage unavailable");
    expect(await environment.emit("tool_call", gatedCalls[0])).toMatchObject({
      block: true,
    });
    environment.failEntry();

    expect(await environment.emit("tool_call", decisionCall)).toBeUndefined();
    expect((await environment.decide("decision", params)).details.saved).toBe(
      true,
    );
    expect(environment.entries.at(-1)?.data).toEqual({
      action: "decide",
      id: identifier,
      verdict: "reject",
      reason: params.reason,
    });
    expect(
      environment.sendMessage.mock.calls.filter(([message]) => message.display),
    ).toHaveLength(0);
    for (const call of gatedCalls) {
      expect(await environment.emit("tool_call", call)).toBeUndefined();
    }
    await environment.emit("session_start");
    for (const call of gatedCalls) {
      expect(await environment.emit("tool_call", call)).toBeUndefined();
    }
    await environment.emit("session_shutdown");
  },
);

it("turns activity off and back on without changing reviewer configuration", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  await environment.command("pair-programmer");
  expect(environment.notify).toHaveBeenLastCalledWith(
    "Pair Programmer off.",
    "info",
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await vi.advanceTimersByTimeAsync(150);
  expect(reviewFile).not.toHaveBeenCalled();
  await environment.command("pair-programmer");
  expect(environment.notify).toHaveBeenLastCalledWith(
    "Pair Programmer on.",
    "info",
  );
  vi.mocked(reviewFile).mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalled();
  });
  expect(vi.mocked(reviewFile).mock.calls[0]?.[0].model).toBe("openai/gpt-5");
  await environment.emit("session_shutdown");
});

it("ignores reviewer failures without blocking coding or delivering findings", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  vi.mocked(reviewFile).mockRejectedValueOnce(new Error("model unavailable"));
  vi.mocked(reviewFile).mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  expect(
    await environment.emit("tool_call", { toolName: "bash" }),
  ).toBeUndefined();
  expect(environment.sendMessage).not.toHaveBeenCalled();
  await environment.emit("session_shutdown");
});

it("coalesces bursts, skips completed unchanged revisions, and drops stale reviewer results", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    {
      line: 1,
      title: "First value",
      quote: "value = 1",
      evidence: "Original evidence",
    },
  ]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  vi.mocked(reviewFile).mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await vi.advanceTimersByTimeAsync(150);
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });

  const pending = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile).mockReturnValueOnce(pending.promise);
  await fsPromises.writeFile(file, "export const value = 2;\n");
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await environment.emit("turn_end");
  expect(environment.sendMessage).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
  await environment.emit("turn_end");
  expect(environment.sendMessage).not.toHaveBeenCalled();
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(4);
  });
  await fsPromises.writeFile(file, "export const value = 3;\n");
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  pending.resolve([
    {
      line: 1,
      title: "Old value",
      quote: "value = 2",
      evidence: "Stale evidence",
    },
  ]);
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(6);
  });
  expect(findings(environment.entries)).toHaveLength(2);
  expect(
    findings(environment.entries).some(
      (finding) => finding.title === "Old value",
    ),
  ).toBe(false);
  expect(environment.sendMessage).not.toHaveBeenCalled();
  await environment.emit("session_shutdown");
});

it("ignores failed writes, other tools, and paths outside the workspace", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  const outside = await fsPromises.mkdtemp(
    path.join(tmpdir(), "pair-programmer-outside-"),
  );
  directories.push(outside);
  await fsPromises.writeFile(file, "export const value = 1;\n");
  await fsPromises.writeFile(
    path.join(outside, "change.ts"),
    "export const value = 1;\n",
  );
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: true,
  });
  await environment.emit("tool_result", {
    toolName: "read",
    input: { path: file },
    isError: false,
  });
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: 12 },
    isError: false,
  });
  await environment.emit("tool_result", {
    toolName: "write",
    input: {},
    isError: false,
  });
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: path.join(outside, "change.ts") },
    isError: false,
  });
  await vi.advanceTimersByTimeAsync(150);
  expect(reviewFile).not.toHaveBeenCalled();
  expect(environment.entries).toHaveLength(0);
  await environment.emit("session_shutdown");
});

it("reviews writes from a symlinked working directory under its canonical root", async () => {
  const environment = await setup("pi", true);
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  vi.mocked(reviewFile).mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  expect(
    vi
      .mocked(reviewFile)
      .mock.calls.every(([request]) => request.file === "change.ts"),
  ).toBe(true);
  await environment.emit("session_shutdown");
});

it("rejects symlink escapes and shares one review key across in-workspace aliases", async () => {
  const environment = await setup();
  const outside = await fsPromises.mkdtemp(
    path.join(tmpdir(), "pair-programmer-outside-"),
  );
  directories.push(outside);
  const externalFile = path.join(outside, "escape.ts");
  const externalAlias = path.join(environment.cwd, "escape.ts");
  await fsPromises.writeFile(externalFile, "export const outside = true;\n");
  await fsPromises.symlink(externalFile, externalAlias);
  vi.mocked(reviewFile).mockResolvedValue([
    {
      line: 1,
      title: "Alias finding",
      quote: "inside",
      evidence: "Canonical evidence",
    },
  ]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: externalAlias },
    isError: false,
  });
  await vi.advanceTimersByTimeAsync(150);
  expect(reviewFile).not.toHaveBeenCalled();

  const file = path.join(environment.cwd, "change.ts");
  const alias = path.join(environment.cwd, "alias.ts");
  await fsPromises.writeFile(file, "export const inside = true;\n");
  await fsPromises.symlink(file, alias);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: alias },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await vi.waitFor(() => {
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
  await vi.advanceTimersByTimeAsync(150);
  await vi.waitFor(() => {
    expect(matchingCalls.get("change.ts")).toBe(2);
  });
  expect(reviewFile).toHaveBeenCalledTimes(2);
  expect(
    vi
      .mocked(reviewFile)
      .mock.calls.every(([request]) => request.file === "change.ts"),
  ).toBe(true);
  await environment.emit("session_shutdown");
});

it("discards ready findings if a changed source disappears before review", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    {
      line: 1,
      title: "Old finding",
      quote: "value",
      evidence: "Obsolete issue",
    },
  ]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  await fsPromises.rm(file);
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(
      environment.entries.filter((entry) => entry.data.action === "discard"),
    ).toHaveLength(1);
  });
  await environment.emit("turn_end");
  expect(environment.sendMessage).not.toHaveBeenCalled();
  await environment.emit("session_shutdown");
});

it.each(["pi", "omp"] as const)(
  "%s /pair-clear cancels running and scheduled reviews without blocking fresh work",
  async (host) => {
    const environment = await setup(host, false, true);
    const running = path.join(environment.cwd, "running.ts");
    const queued = path.join(environment.cwd, "queued.ts");
    await fsPromises.writeFile(running, "export const value = 1;\n");
    await fsPromises.writeFile(queued, "export const queued = 1;\n");
    const abandoned = Promise.withResolvers<ProposedFinding[]>();
    vi.mocked(reviewFile).mockReturnValue(abandoned.promise);
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: running },
      isError: false,
    });
    await advanceReviews(() => {
      expect(reviewFile).toHaveBeenCalledOnce();
    });
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: queued },
      isError: false,
    });
    await vi.waitFor(() => {
      expect(realpathFinished.get(queued)).toBe(1);
    });
    await environment.command("pair-clear");
    expect(vi.mocked(reviewFile).mock.calls[0]?.[0].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reviewFile).toHaveBeenCalledOnce();
    expect(persistedStats(environment.statsEntries).reviews.cancelled).toBe(1);

    vi.mocked(reviewFile).mockResolvedValue([]);
    await environment.emit("tool_result", {
      toolName: "edit",
      input: { path: running },
      isError: false,
    });
    await advanceReviews(() => {
      expect(reviewFile).toHaveBeenCalledTimes(2);
    });
    abandoned.resolve([
      { line: 1, title: "Old finding", quote: "value", evidence: "Obsolete" },
    ]);
    await vi.waitFor(() => {
      expect(persistedStats(environment.statsEntries).incompleteJobs).toBe(0);
    });
    await vi.advanceTimersByTimeAsync(1000);
    await environment.emit("turn_end");
    expect(findings(environment.entries)).toEqual([]);
    expect(environment.sendMessage).not.toHaveBeenCalled();
    expect(
      await environment.emit("tool_call", { toolName: "write", input: {} }),
    ).toBeUndefined();
    await environment.emit("session_shutdown");
  },
);

it.each(["pi", "omp"] as const)(
  "%s /pair-clear removes queued and outstanding findings across reloads",
  async (host) => {
    const environment = await setup(host, false, true);
    const file = path.join(environment.cwd, "change.ts");
    await fsPromises.writeFile(file, "export const value = 1;\n");
    const proposals = Array.from({ length: 5 }, (_, index) => ({
      line: 1,
      title: `Problem ${String(index)}`,
      quote: "value",
      evidence: `Distinct problem ${String(index)}`,
    }));
    vi.mocked(reviewFile).mockResolvedValue(proposals);
    const write = {
      toolName: "write",
      input: { path: file },
      isError: false,
    };
    await environment.emit("tool_result", write);
    await advanceReviews(() => {
      expect(findings(environment.entries)).toHaveLength(5);
    });
    expect(
      await environment.emit("tool_call", { toolName: "write", input: {} }),
    ).toMatchObject({ block: true });
    const oldMessage = environment.sendMessage.mock.calls[0]?.[0];
    const priorReviews = persistedStats(environment.statsEntries).reviews;
    await environment.command("pair-clear");
    expect(persistedStats(environment.statsEntries).reviews).toEqual(
      priorReviews,
    );
    environment.sendMessage.mockClear();
    environment.isIdle.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1000);
    await environment.emit("turn_end");
    expect(environment.sendMessage).not.toHaveBeenCalled();
    expect(
      await environment.emit("tool_call", { toolName: "write", input: {} }),
    ).toBeUndefined();
    expect(
      await environment.emit("context", {
        messages: [{ ...oldMessage, role: "custom" }],
      }),
    ).toEqual({ messages: [] });
    await environment.emit("session_start");
    expect(
      await environment.emit("tool_call", { toolName: "write", input: {} }),
    ).toBeUndefined();
    expect(environment.sendMessage).not.toHaveBeenCalled();
    await environment.emit("tool_result", write);
    await advanceReviews(() => {
      expect(findings(environment.entries)).toHaveLength(10);
    });
    await environment.emit("session_shutdown");
  },
);

it("OMP does not treat an unavailable journal entry as a review reset", async () => {
  const environment = await setup("omp", false, true);
  const journal = environment.ctx.sessionManager.getEntries() as unknown[];
  journal.push({
    type: "custom",
    customType: "pair-programmer",
    data: {
      action: "add",
      finding: {
        id: "waiting",
        reviewer: "logic",
        file: "change.ts",
        revision: "old",
        line: 1,
        title: "Existing issue",
        evidence: "Still requires a decision",
      },
    },
  });
  const append = resettableSession(environment.ctx);
  await environment.emit("session_start");
  const toolCall = { toolName: "write", input: {} };
  expect(await environment.emit("tool_call", toolCall)).toMatchObject({
    block: true,
  });
  append("model_change");
  vi.spyOn(environment.ctx.sessionManager, "getEntry").mockReturnValueOnce(
    undefined,
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(await environment.emit("tool_call", toolCall)).toMatchObject({
    block: true,
  });
  append("reset_boundary");
  await vi.advanceTimersByTimeAsync(100);
  expect(await environment.emit("tool_call", toolCall)).toBeUndefined();
  await environment.emit("session_shutdown");
});

it("OMP /clear cancels idle reviews and their late results without a session event", async () => {
  const environment = await setup("omp", false, true);
  const append = resettableSession(environment.ctx);
  await environment.emit("session_start");
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  const abandoned = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile).mockReturnValue(abandoned.promise);
  const write = { toolName: "write", input: { path: file }, isError: false };
  await environment.emit("tool_result", write);
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledOnce();
  });
  append("reset_boundary");
  append("model_change");
  await vi.advanceTimersByTimeAsync(100);
  expect(vi.mocked(reviewFile).mock.calls[0]?.[0].signal.aborted).toBe(true);
  expect(persistedStats(environment.statsEntries).reviews.cancelled).toBe(1);
  vi.mocked(reviewFile).mockResolvedValue([]);
  await environment.emit("tool_result", write);
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  abandoned.resolve([
    { line: 1, title: "Old finding", quote: "value", evidence: "Obsolete" },
  ]);
  await vi.waitFor(() => {
    expect(persistedStats(environment.statsEntries).incompleteJobs).toBe(0);
  });
  await environment.emit("agent_end", { willContinue: false });
  expect(findings(environment.entries)).toEqual([]);
  expect(environment.sendMessage).not.toHaveBeenCalled();
  await environment.emit("session_before_switch");
  append("reset_boundary");
  await vi.advanceTimersByTimeAsync(200);
  expect(persistedStats(environment.statsEntries).reviews.cancelled).toBe(1);
  await environment.emit("session_shutdown");
});

it.each(["decision", "delivery", "context"])(
  "OMP /clear removes old findings before %s without waiting for the monitor",
  async (action) => {
    const environment = await setup("omp", false, true);
    const append = resettableSession(environment.ctx);
    await environment.emit("session_start");
    const file = path.join(environment.cwd, "change.ts");
    await fsPromises.writeFile(file, "export const value = 1;\n");
    vi.mocked(reviewFile).mockResolvedValue([
      { line: 1, title: "Old finding", quote: "value", evidence: "Old issue" },
    ]);
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: file },
      isError: false,
    });
    await advanceReviews(() => {
      expect(findings(environment.entries)).toHaveLength(1);
    });
    const finding = findings(environment.entries)[0];
    if (finding === undefined) throw new Error("Expected finding");
    if (action !== "delivery") await environment.emit("turn_end");
    environment.sendMessage.mockClear();
    append("reset_boundary");
    if (action === "decision") {
      expect(
        await environment.decide("old", {
          findingId: finding.id,
          decision: "accept",
          reason: "Stale",
        }),
      ).toEqual(expect.objectContaining({ details: { saved: false } }));
    } else if (action === "delivery") {
      await environment.emit("agent_end", { willContinue: false });
    } else {
      expect(
        await environment.emit("context", {
          messages: [
            {
              role: "custom",
              customType: "pair-programmer-findings",
              content: finding.id,
            },
          ],
        }),
      ).toEqual({ messages: [] });
    }
    expect(environment.sendMessage).not.toHaveBeenCalled();
    await environment.emit("session_start");
    expect(
      await environment.emit("tool_call", { toolName: "write", input: {} }),
    ).toBeUndefined();
    await environment.emit("turn_end");
    expect(environment.sendMessage).not.toHaveBeenCalled();
    await environment.emit("session_shutdown");
  },
);

it("aborts in-flight work when switched off and suppresses queued finding messages", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const broken = true;\n");
  const review = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile).mockReturnValue(review.promise);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  await environment.command("pair-programmer");
  expect(
    vi
      .mocked(reviewFile)
      .mock.calls.every(([request]) => request.signal.aborted),
  ).toBe(true);
  review.resolve([
    {
      line: 1,
      title: "Late finding",
      quote: "broken",
      evidence: "No delivery after off",
    },
  ]);
  await environment.emit("turn_end");
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(0);
  });
  expect(environment.sendMessage).not.toHaveBeenCalled();
  expect(
    await environment.emit("tool_call", { toolName: "write", input: {} }),
  ).toBeUndefined();
  const suppressed = await environment.emit("context", {
    messages: [
      {
        role: "custom",
        customType: "pair-programmer-findings",
        content: "Review findings:",
        display: true,
      },
      { role: "user", content: "Other conversation" },
    ],
  });
  expect(suppressed).toEqual({
    messages: [{ role: "user", content: "Other conversation" }],
  });
  await environment.command("pair-programmer");
  vi.mocked(reviewFile).mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(4);
  });
  await environment.emit("session_shutdown");
});

it("starts fresh reviews after on even when an aborted reviewer never settles", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  const abandoned = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile).mockReturnValue(abandoned.promise);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  await environment.command("pair-programmer");
  await environment.command("pair-programmer");
  vi.mocked(reviewFile).mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(4);
  });
  abandoned.resolve([
    { line: 1, title: "Abandoned", quote: "value", evidence: "Stale job" },
  ]);
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(0);
  });
  expect(
    await environment.emit("tool_call", { toolName: "write", input: {} }),
  ).toBeUndefined();
  await environment.emit("session_shutdown");
});

it("restores delivered decisions after session start and removes decided findings from model context", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const broken = true;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    { line: 1, title: "First", quote: "broken", evidence: "First issue" },
    { line: 1, title: "Second", quote: "true", evidence: "Second issue" },
  ]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(4);
  });
  await environment.emit("turn_end");
  const first = findings(environment.entries)[0];
  const second = findings(environment.entries)[1];
  if (!first || !second) throw new Error("Missing findings");
  expect(environment.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      customType: "pair-programmer-findings",
      display: false,
    }),
    expect.anything(),
  );
  expect(
    (
      await environment.decide("decision", {
        findingId: first.id,
        decision: "accept",
        reason: "Confirmed by caller",
      })
    ).details.saved,
  ).toBe(true);
  expect(environment.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      customType: "pair-programmer-accepted",
      display: true,
    }),
    expect.objectContaining({ triggerTurn: false }),
  );
  const published = environment.sendMessage.mock.calls.filter(
    ([message]) => message.display,
  );
  expect(published).toHaveLength(1);
  expect(published[0]?.[0].content).toContain("Confirmed by caller");
  expect(published[0]?.[0].content).toContain("First issue");
  expect(published[0]?.[0].content).toContain("change.ts:1");
  expect(
    (
      await environment.decide("decision", {
        findingId: first.id,
        decision: "accept",
        reason: "Tried twice",
      })
    ).details.saved,
  ).toBe(false);
  expect(
    environment.sendMessage.mock.calls.filter(([message]) => message.display),
  ).toHaveLength(1);
  const context = await environment.emit("context", {
    messages: [
      {
        role: "custom",
        customType: "pair-programmer-findings",
        content: `Review findings:\n- ${first.id}\n- ${second.id}`,
        display: true,
      },
    ],
  });
  expect(JSON.stringify(context)).toContain(second.id);
  expect(JSON.stringify(context)).not.toContain(first.id);
  await environment.emit("session_start");
  expect(
    await environment.emit("tool_call", { toolName: "write", input: {} }),
  ).toMatchObject({ block: true });
  expect(
    (
      await environment.decide("decision", {
        findingId: first.id,
        decision: "reject",
        reason: "Duplicate decision",
      })
    ).details.saved,
  ).toBe(false);
  for (const finding of findings(environment.entries).slice(1)) {
    expect(
      (
        await environment.decide("decision", {
          findingId: finding.id,
          decision: "reject",
          reason: "Investigated and safe",
        })
      ).details.saved,
    ).toBe(true);
  }
  expect(
    await environment.emit("tool_call", { toolName: "write", input: {} }),
  ).toBeUndefined();
  await environment.emit("session_shutdown");
});

it("reviews every written file at once and sends the next finding batch only after decisions", async () => {
  const environment = await setup();
  await fsPromises.writeFile(
    path.join(environment.cwd, "pair-programmer.reviewers.json"),
    JSON.stringify({
      reviewers: [
        {
          model: "current",
          prompt: "Find correctness defects",
          include: ["**/*.ts"],
          exclude: [],
        },
      ],
    }),
  );
  await environment.emit("session_start");
  const firstFile = path.join(environment.cwd, "first.ts");
  const secondFile = path.join(environment.cwd, "second.ts");
  const thirdFile = path.join(environment.cwd, "third.ts");
  await Promise.all(
    [firstFile, secondFile, thirdFile].map((file) =>
      fsPromises.writeFile(file, "export const value = true;\n"),
    ),
  );
  const first = Promise.withResolvers<ProposedFinding[]>();
  const second = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockResolvedValue([]);
  for (const file of [firstFile, secondFile, thirdFile]) {
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: file },
      isError: false,
    });
  }
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(3);
  });
  expect(
    await environment.emit("tool_call", { toolName: "bash" }),
  ).toBeUndefined();
  first.resolve(
    Array.from({ length: 5 }, (_, index) => ({
      line: 1,
      title: `Issue ${String(index)}`,
      quote: "value",
      evidence: `Distinct problem ${String(index)}`,
    })),
  );
  second.resolve([]);
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(5);
  });
  await environment.emit("turn_end");
  expect(environment.sendMessage).toHaveBeenCalledTimes(1);
  expect(
    environment.entries.find((entry) => entry.data.action === "deliver")?.data
      .ids,
  ).toHaveLength(4);
  expect(
    await environment.emit("tool_call", { toolName: "write", input: {} }),
  ).toMatchObject({ block: true });
  for (const finding of findings(environment.entries).slice(0, 4)) {
    expect(
      (
        await environment.decide("decision", {
          findingId: finding.id,
          decision: "accept",
          reason: "Confirmed in source",
        })
      ).details.saved,
    ).toBe(true);
  }
  expect(
    await environment.emit("tool_call", { toolName: "write", input: {} }),
  ).toMatchObject({ block: true });
  expect(
    environment.entries.filter((entry) => entry.data.action === "deliver"),
  ).toHaveLength(2);
  const last = findings(environment.entries)[4];
  if (!last) throw new Error("Missing final finding");
  expect(
    (
      await environment.decide("decision", {
        findingId: last.id,
        decision: "reject",
        reason: "Mitigated elsewhere",
      })
    ).details.saved,
  ).toBe(true);
  expect(
    await environment.emit("tool_call", { toolName: "write", input: {} }),
  ).toBeUndefined();
  await environment.emit("session_shutdown");
});

it("warns on invalid configuration without running unconfigured reviewers", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  await fsPromises.writeFile(
    path.join(environment.cwd, "pair-programmer.reviewers.json"),
    "{bad JSON",
  );
  await environment.emit("session_start");
  const warning: unknown = environment.notify.mock.calls[0]?.[0];
  expect(warning).toContain("invalid JSON");
  expect(environment.notify.mock.calls[0]?.[1]).toBe("warning");
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await vi.advanceTimersByTimeAsync(150);
  expect(reviewFile).not.toHaveBeenCalled();
  await environment.emit("session_shutdown");
});

it("dispatches reviews through the OMP host when Pi streaming is unavailable", async () => {
  const environment = await setup("omp");
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  vi.mocked(reviewFile).mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  expect(
    vi
      .mocked(reviewFile)
      .mock.calls.every(([request]) => request.host === "omp"),
  ).toBe(true);
  await environment.emit("session_shutdown");
});

it("restores the off state across session changes without rereading reviewer settings on toggles", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  await environment.command("pair-programmer");
  await environment.emit("session_start");
  vi.mocked(reviewFile).mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await vi.advanceTimersByTimeAsync(150);
  expect(reviewFile).not.toHaveBeenCalled();
  await environment.command("pair-programmer");
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  await environment.emit("session_shutdown");
});

it("deduplicates old evidence after edits even if the Jev call fails", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const broken = true;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    { line: 1, title: "Bug", quote: "broken", evidence: "Same defect" },
  ]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  await environment.emit("turn_end");
  for (const finding of findings(environment.entries)) {
    expect(
      (
        await environment.decide("decision", {
          findingId: finding.id,
          decision: "reject",
          reason: "Known false positive",
        })
      ).details.saved,
    ).toBe(true);
  }
  systemOne.mockReset();
  systemOne.mockRejectedValue(new Error("Jev unavailable"));
  vi.mocked(reviewFile).mockResolvedValue([
    {
      line: 1,
      title: "Bug",
      quote: "broken",
      evidence: "Reworded same defect",
    },
  ]);
  await fsPromises.writeFile(
    file,
    "export const broken = true;\nexport const next = true;\n",
  );
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(4);
  });
  await advanceReviews(() => {
    const { calls, settledResults } = systemOne.mock;
    expect(calls).toHaveLength(2);
    expect(settledResults.every(({ type }) => type !== "incomplete")).toBe(
      true,
    );
  });
  await vi.advanceTimersByTimeAsync(150);
  expect(findings(environment.entries)).toHaveLength(2);
  expect(
    await environment.emit("tool_call", { toolName: "write", input: {} }),
  ).toBeUndefined();
  await environment.emit("session_shutdown");
});

it.each(["accept", "reject"] as const)(
  "delivers and independently decides novel evidence after an earlier %s",
  async (decision) => {
    const environment = await setup("pi", false, true);
    const file = path.join(environment.cwd, "change.ts");
    await fsPromises.writeFile(file, inheritedSource);
    vi.mocked(reviewFile).mockResolvedValue([inheritedProposal]);
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: file },
      isError: false,
    });
    await advanceReviews(() => {
      expect(findings(environment.entries)).toHaveLength(1);
    });
    await environment.emit("turn_end");
    const first = findings(environment.entries)[0];
    if (first === undefined) throw new Error("Missing original finding");
    await environment.decide("original", {
      findingId: first.id,
      decision,
      reason: "Original consequence reviewed",
    });
    await fsPromises.writeFile(
      file,
      `${inheritedSource}displayProfile(null);\n`,
    );
    vi.mocked(reviewFile).mockResolvedValue([
      {
        ...inheritedProposal,
        evidence: "A newly added caller passes null again",
      },
    ]);
    await environment.emit("tool_result", {
      toolName: "edit",
      input: { path: file },
      isError: false,
    });
    await advanceReviews(() => {
      expect(findings(environment.entries)).toHaveLength(2);
    });
    await environment.emit("turn_end");
    const second = findings(environment.entries)[1];
    if (second === undefined) throw new Error("Missing changed finding");
    expect(second.id).not.toBe(first.id);
    expect(
      (
        await environment.decide("changed", {
          findingId: second.id,
          decision: "accept",
          reason: "New caller confirmed",
        })
      ).details.saved,
    ).toBe(true);
    const accepted = environment.sendMessage.mock.calls.filter(
      ([message]) => message.customType === "pair-programmer-accepted",
    );
    expect(accepted.map(([message]) => message.content)).toEqual(
      expect.arrayContaining([expect.stringContaining("New caller confirmed")]),
    );
    expect(accepted).toHaveLength(decision === "accept" ? 2 : 1);
    await environment.emit("session_start");
    expect(
      await environment.emit("tool_call", { toolName: "bash", input: {} }),
    ).toBeUndefined();
    expect(
      (
        await environment.decide("again", {
          findingId: first.id,
          decision: "accept",
          reason: "Already reviewed",
        })
      ).details.saved,
    ).toBe(false);
    await environment.emit("session_shutdown");
  },
);

it("does not dispatch current-model reviewers without a model", async () => {
  const environment = await setup();
  environment.ctx.model = undefined;
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await vi.waitFor(() => {
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
  await vi.advanceTimersByTimeAsync(150);
  await vi.waitFor(() => {
    expect(matchingCalls.get("change.ts")).toBe(1);
  });
  expect(reviewFile).not.toHaveBeenCalled();
  expect(
    await environment.emit("tool_call", { toolName: "bash" }),
  ).toBeUndefined();
  await environment.emit("session_shutdown");
});

it("runs a configured explicit reviewer without an active host model", async () => {
  const environment = await setup();
  const reviewer = {
    model: "anthropic/claude-sonnet",
    prompt: "Review correctness",
    include: ["**/*.ts"],
    exclude: [],
  };
  await fsPromises.writeFile(
    path.join(environment.cwd, "pair-programmer.reviewers.json"),
    JSON.stringify({ reviewers: [reviewer] }),
  );
  await environment.emit("session_start");
  environment.ctx.model = undefined;
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = true;\n");
  vi.mocked(reviewFile).mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledOnce();
  });
  expect(vi.mocked(reviewFile).mock.calls[0]?.[0].model).toBe(
    "anthropic/claude-sonnet",
  );
  await environment.emit("session_shutdown");
});

it("does not expose review messages without active findings and disables decisions while off", async () => {
  const environment = await setup();
  expect(
    await environment.emit("context", {
      messages: [{ role: "user", content: "Continue" }],
    }),
  ).toBeUndefined();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const broken = true;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    { line: 1, title: "Broken", quote: "broken", evidence: "Observed fault" },
  ]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  await environment.emit("before_agent_start");
  expect(environment.sendMessage).toHaveBeenCalledOnce();
  const finding = findings(environment.entries)[0];
  if (finding === undefined) throw new Error("Missing finding");
  await environment.command("pair-programmer");
  expect(
    (
      await environment.decide("decision", {
        findingId: finding.id,
        decision: "accept",
        reason: "Confirmed",
      })
    ).details.saved,
  ).toBe(false);
  expect(
    await environment.emit("context", {
      messages: [
        {
          role: "custom",
          customType: "pair-programmer-findings",
          content: finding.id,
        },
      ],
    }),
  ).toEqual({ messages: [] });
  await environment.emit("session_shutdown");
});

it.each(["revision", "session", "off", "shutdown"] as const)(
  "drops admission after %s changes while Jev is judging",
  async (change) => {
    const environment = await setup("pi", false, true);
    const file = path.join(environment.cwd, "change.ts");
    await fsPromises.writeFile(file, "export const vulnerable = true;\n");
    vi.mocked(reviewFile).mockResolvedValue([
      {
        line: 1,
        title: "Unsafe",
        quote: "vulnerable",
        evidence: "Old evidence",
      },
      {
        line: 1,
        title: "Other issue",
        quote: "true",
        evidence: "More evidence",
      },
    ]);
    const judgment = Promise.withResolvers<unknown>();
    systemOne.mockReturnValueOnce(judgment.promise);
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: file },
      isError: false,
    });
    await advanceReviews(() => {
      expect(systemOne).toHaveBeenCalledOnce();
    });
    switch (change) {
      case "revision":
        await fsPromises.writeFile(file, "export const vulnerable = false;\n");
        break;
      case "session":
        await environment.emit("session_start");
        break;
      case "off":
        await environment.command("pair-programmer");
        break;
      case "shutdown":
        await environment.emit("session_shutdown");
        break;
    }
    judgment.resolve({ answers: { duplicate: { noul: 0 } } });
    await advanceReviews(() => {
      expect(systemOne.mock.settledResults[0]?.type).toBe("fulfilled");
    });
    expect(findings(environment.entries)).toEqual([]);
    expect(environment.sendMessage).not.toHaveBeenCalled();
    await environment.emit("session_shutdown");
  },
);

it.each(["off", "session", "revision"] as const)(
  "does not persist when %s invalidates the final source freshness read",
  async (change) => {
    const environment = await setup("pi", false, true);
    const file = path.join(environment.cwd, "change.ts");
    await fsPromises.writeFile(file, inheritedSource);
    const review = Promise.withResolvers<ProposedFinding[]>();
    vi.mocked(reviewFile)
      .mockReturnValueOnce(review.promise)
      .mockResolvedValue([]);
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: file },
      isError: false,
    });
    await advanceReviews(() => {
      expect(reviewFile).toHaveBeenCalledOnce();
    });
    const canonical = await fsPromises.realpath(file);
    const before = sourceReadCalls.get(canonical) ?? 0;
    const reading = Promise.withResolvers<null>();
    sourceReadPauses.set(canonical, [
      Promise.resolve(null),
      Promise.resolve(null),
      reading.promise,
    ]);
    review.resolve([inheritedProposal]);
    await vi.waitFor(() => {
      expect(sourceReadCalls.get(canonical)).toBe(before + 3);
    });
    if (change === "off") await environment.command("pair-programmer");
    else if (change === "session") await environment.emit("session_start");
    else {
      const beforeSchedule = realpathFinished.get(file) ?? 0;
      await environment.emit("tool_result", {
        toolName: "edit",
        input: { path: file },
        isError: false,
      });
      await vi.waitFor(() => {
        expect(realpathFinished.get(file)).toBe(beforeSchedule + 1);
      });
    }
    reading.resolve(null);
    await vi.waitFor(() => {
      expect(sourceReadFinished.get(canonical)).toBe(before + 3);
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(findings(environment.entries)).toEqual([]);
    expect(environment.sendMessage).not.toHaveBeenCalled();
    await environment.emit("session_shutdown");
  },
);

it("stores one file's findings while dropping another file changed during deduplication", async () => {
  const environment = await setup();
  const reviewer = {
    model: "current",
    prompt: "Correctness review",
    include: ["**/*.ts"],
    exclude: [],
  };
  await fsPromises.writeFile(
    path.join(environment.cwd, "pair-programmer.reviewers.json"),
    JSON.stringify({ reviewers: [reviewer] }),
  );
  await environment.emit("session_start");
  const first = path.join(environment.cwd, "first.ts");
  const second = path.join(environment.cwd, "second.ts");
  await fsPromises.writeFile(first, "export const first = true;\n");
  await fsPromises.writeFile(second, "export const second = true;\n");
  vi.mocked(reviewFile).mockImplementation((request) =>
    Promise.resolve([
      { line: 1, title: request.file, quote: "true", evidence: "Source issue" },
      {
        line: 1,
        title: `Additional ${request.file}`,
        quote: "true",
        evidence: "Other issue",
      },
    ]),
  );
  const judgments = [0, 1].map(() => Promise.withResolvers<unknown>());
  for (const judgment of judgments)
    systemOne.mockReturnValueOnce(judgment.promise);
  for (const file of [first, second])
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: file },
      isError: false,
    });
  await advanceReviews(() => {
    expect(systemOne).toHaveBeenCalledTimes(2);
  });
  await fsPromises.writeFile(second, "export const second = false;\n");
  for (const judgment of judgments)
    judgment.resolve({ answers: { duplicate: { noul: 0 } } });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  await vi.advanceTimersByTimeAsync(150);
  expect(findings(environment.entries).map((finding) => finding.file)).toEqual([
    "first.ts",
    "first.ts",
  ]);
  await environment.emit("turn_end");
  expect(environment.sendMessage).toHaveBeenCalledOnce();
  await environment.emit("session_shutdown");
});

it("discards a reviewer result when its source disappears before completion", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const old = true;\n");
  const oldReview = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile)
    .mockReturnValueOnce(oldReview.promise)
    .mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  const canonicalFile = await fsPromises.realpath(file);
  const previousChecks = realpathFinished.get(canonicalFile) ?? 0;
  await fsPromises.rm(file);
  oldReview.resolve([
    {
      line: 1,
      title: "Deleted finding",
      quote: "old",
      evidence: "No longer present",
    },
  ]);
  await vi.waitFor(() => {
    expect(realpathFinished.get(canonicalFile)).toBeGreaterThan(previousChecks);
  });
  await fsPromises.writeFile(file, "export const next = true;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    {
      line: 1,
      title: "Current finding",
      quote: "next",
      evidence: "New file revision",
    },
  ]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(
      findings(environment.entries).some(
        (finding) => finding.title === "Current finding",
      ),
    ).toBe(true);
  });
  expect(
    findings(environment.entries).some(
      (finding) => finding.title === "Deleted finding",
    ),
  ).toBe(false);
  await environment.emit("session_shutdown");
});

it("aborts a running reviewer when the same file is written again", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  const oldReview = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile)
    .mockReturnValueOnce(oldReview.promise)
    .mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  const originalSignal = vi.mocked(reviewFile).mock.calls[0]?.[0].signal;
  const unrelated = path.join(environment.cwd, "unrelated.ts");
  await fsPromises.writeFile(unrelated, "export const unrelated = true;\n");
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: unrelated },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(4);
  });
  expect(originalSignal?.aborted).toBe(false);
  await fsPromises.writeFile(file, "export const value = 2;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    {
      line: 1,
      title: "Current value",
      quote: "value = 2",
      evidence: "Current revision",
    },
  ]);
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await vi.waitFor(() => {
    expect(originalSignal?.aborted).toBe(true);
  });
  oldReview.resolve([
    {
      line: 1,
      title: "Old value",
      quote: "value = 1",
      evidence: "Stale revision",
    },
  ]);
  await advanceReviews(() => {
    expect(
      findings(environment.entries).some(
        (finding) => finding.title === "Current value",
      ),
    ).toBe(true);
  });
  expect(
    findings(environment.entries).some(
      (finding) => finding.title === "Old value",
    ),
  ).toBe(false);
  await environment.emit("session_shutdown");
});

it("does not send a directory to reviewers after a write result", async () => {
  const environment = await setup();
  const directory = path.join(environment.cwd, "directory.ts");
  await fsPromises.mkdir(directory);
  vi.mocked(reviewFile).mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: directory },
    isError: false,
  });
  await vi.waitFor(() => {
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
  await vi.advanceTimersByTimeAsync(150);
  const file = path.join(environment.cwd, "actual.ts");
  await fsPromises.writeFile(file, "export const actual = true;\n");
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  expect(
    vi
      .mocked(reviewFile)
      .mock.calls.every(([request]) => request.file === "actual.ts"),
  ).toBe(true);
  await environment.emit("session_shutdown");
});

it("keeps only the newest revision when path resolution finishes out of order", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const latest = true;\n");
  const oldResolution = Promise.withResolvers<null>();
  realpathPauses.set(file, [oldResolution.promise]);
  vi.mocked(reviewFile).mockResolvedValue([]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await vi.waitFor(() => {
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
  oldResolution.resolve(null);
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  expect(
    vi
      .mocked(reviewFile)
      .mock.calls.every(([request]) => request.source.includes("latest")),
  ).toBe(true);
  await environment.emit("session_shutdown");
});

it("ignores workspace root aliases and paths to the canonical parent", async () => {
  const environment = await setup();
  const rootAlias = path.join(environment.cwd, "root-alias");
  const parentAlias = path.join(environment.cwd, "parent-alias");
  await fsPromises.symlink(environment.cwd, rootAlias, "dir");
  await fsPromises.symlink(path.dirname(environment.cwd), parentAlias, "dir");
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: environment.cwd },
    isError: false,
  });
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: rootAlias },
    isError: false,
  });
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: parentAlias },
    isError: false,
  });
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: path.dirname(environment.cwd) },
    isError: false,
  });
  await vi.advanceTimersByTimeAsync(150);
  expect(reviewFile).not.toHaveBeenCalled();
  expect(
    await environment.emit("tool_call", { toolName: "bash" }),
  ).toBeUndefined();
  await environment.emit("session_shutdown");
});

it("stops a pending debounce immediately when review is turned off", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = true;\n");
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await vi.waitFor(() => {
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
  await environment.command("pair-programmer");
  await vi.advanceTimersByTimeAsync(150);
  expect(reviewFile).not.toHaveBeenCalled();
  expect(
    await environment.emit("tool_call", { toolName: "edit" }),
  ).toBeUndefined();
  await environment.emit("session_shutdown");
});

it("rejects absolute paths returned by cross-volume relative resolution", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = true;\n");
  const actualRelative = path.relative.bind(path);
  const relative = vi.spyOn(path, "relative");
  relative.mockImplementationOnce(() => `${path.sep}other-volume.ts`);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  relative.mockRestore();
  const canonicalRelative = vi.spyOn(path, "relative");
  canonicalRelative
    .mockImplementationOnce((from, to) => actualRelative(from, to))
    .mockImplementationOnce(() => `${path.sep}other-volume.ts`);
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await vi.waitFor(() => {
    expect(canonicalRelative).toHaveBeenCalledTimes(2);
  });
  canonicalRelative.mockRestore();
  await vi.advanceTimersByTimeAsync(150);
  expect(reviewFile).not.toHaveBeenCalled();
  await environment.emit("session_shutdown");
});

it("stops before dispatch when review is disabled during a source read", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = true;\n");
  const previousResolutions = realpathFinished.get(file) ?? 0;
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  const reading = await pauseSourceRead(file, previousResolutions);
  await environment.command("pair-programmer");
  reading.resolve(null);
  await vi.waitFor(() => {
    expect(sourceReadFinished.get(reading.canonical)).toBe(1);
  });
  await Promise.resolve();
  expect(reviewFile).not.toHaveBeenCalled();
  expect(
    await environment.emit("tool_call", { toolName: "write", input: {} }),
  ).toBeUndefined();
  await environment.emit("session_shutdown");
});

it("ignores a superseded source read while reviewing the newest revision", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  const previousResolutions = realpathFinished.get(file) ?? 0;
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  const reading = await pauseSourceRead(file, previousResolutions);
  await fsPromises.writeFile(file, "export const value = 2;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    {
      line: 1,
      title: "Current revision",
      quote: "value = 2",
      evidence: "Updated issue",
    },
  ]);
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  reading.resolve(null);
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  expect(
    findings(environment.entries).every(
      (finding) => finding.title === "Current revision",
    ),
  ).toBe(true);
  expect(reviewFile).toHaveBeenCalledTimes(2);
  await environment.emit("session_shutdown");
});

it("does not discard a replacement directory after review is switched off", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = true;\n");
  const previousResolutions = realpathFinished.get(file) ?? 0;
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  const read = await pausePreparation(file, previousResolutions);
  await environment.command("pair-programmer");
  await fsPromises.rm(file);
  await fsPromises.mkdir(file);
  read.resolve(null);
  await vi.waitFor(() => {
    expect(statCalls.get(read.canonical)).toBe(1);
  });
  expect(reviewFile).not.toHaveBeenCalled();
  expect(
    environment.entries.some((entry) => entry.data.action === "discard"),
  ).toBe(false);
  await environment.emit("session_shutdown");
});

it("discards findings if a reviewed file vanishes after the debounce fires", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = true;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    {
      line: 1,
      title: "Original issue",
      quote: "value",
      evidence: "Outdated source",
    },
  ]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  const previousResolutions = realpathFinished.get(file) ?? 0;
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  const read = await pausePreparation(file, previousResolutions);
  await fsPromises.rm(file);
  read.resolve(null);
  await vi.waitFor(() => {
    expect(realpathCompletions.get(read.canonical)).toBe(1);
  });
  await vi.waitFor(() => {
    expect(
      environment.entries.some((entry) => entry.data.action === "discard"),
    ).toBe(true);
  });
  await environment.emit("turn_end");
  expect(environment.sendMessage).not.toHaveBeenCalled();
  await environment.emit("session_shutdown");
});

it("ignores a read failure from a session stopped during preparation", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = true;\n");
  const previousResolutions = realpathFinished.get(file) ?? 0;
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  const read = await pausePreparation(file, previousResolutions);
  await environment.command("pair-programmer");
  await fsPromises.rm(file);
  read.resolve(null);
  await vi.waitFor(() => {
    expect(realpathCompletions.get(read.canonical)).toBe(1);
  });
  await Promise.resolve();
  expect(
    environment.entries.some((entry) => entry.data.action === "discard"),
  ).toBe(false);
  expect(reviewFile).not.toHaveBeenCalled();
  await environment.emit("session_shutdown");
});

it("does not persist a failed read into a newly restored session", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = true;\n");
  const previousResolutions = realpathFinished.get(file) ?? 0;
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  const read = await pausePreparation(file, previousResolutions);
  await environment.emit("session_start");
  await fsPromises.rm(file);
  read.resolve(null);
  await vi.waitFor(() => {
    expect(realpathCompletions.get(read.canonical)).toBe(1);
  });
  await Promise.resolve();
  expect(
    environment.entries.some((entry) => entry.data.action === "discard"),
  ).toBe(false);
  expect(
    await environment.emit("tool_call", { toolName: "bash" }),
  ).toBeUndefined();
  await environment.emit("session_shutdown");
});

it("does not discard a replaced revision after a superseding write", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = true;\n");
  const previousResolutions = realpathFinished.get(file) ?? 0;
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  const read = await pausePreparation(file, previousResolutions);
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await vi.waitFor(() => {
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
  await fsPromises.rm(file);
  read.resolve(null);
  await vi.waitFor(() => {
    expect(realpathCompletions.get(read.canonical)).toBe(1);
  });
  await Promise.resolve();
  expect(
    environment.entries.some((entry) => entry.data.action === "discard"),
  ).toBe(false);
  await environment.emit("session_shutdown");
});

it("ignores failed path resolution after the extension is switched off", async () => {
  const environment = await setup();
  const missing = path.join(environment.cwd, "missing.ts");
  const lookup = Promise.withResolvers<null>();
  realpathPauses.set(missing, [lookup.promise]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: missing },
    isError: false,
  });
  await vi.waitFor(() => {
    expect(realpathPauses.get(missing)).toHaveLength(0);
  });
  await environment.command("pair-programmer");
  lookup.resolve(null);
  await vi.waitFor(() => {
    expect(realpathCompletions.get(missing)).toBe(1);
  });
  expect(
    environment.entries.some((entry) => entry.data.action === "discard"),
  ).toBe(false);
  expect(
    await environment.emit("tool_call", { toolName: "bash" }),
  ).toBeUndefined();
  await environment.emit("session_shutdown");
});

it("contains failed background persistence and resumes after storage recovers", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const obsolete = true;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    {
      line: 1,
      title: "Obsolete",
      quote: "obsolete",
      evidence: "Historical issue",
    },
  ]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(2);
  });
  const attempts = environment.entryAttempts();
  environment.failEntry(new Error("Session storage temporarily unavailable"));
  await fsPromises.rm(file);
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(environment.entryAttempts()).toBe(attempts + 1);
  });
  environment.failEntry();
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(
      environment.entries.some((entry) => entry.data.action === "discard"),
    ).toBe(true);
  });
  expect(
    await environment.emit("tool_call", { toolName: "read", input: {} }),
  ).toBeUndefined();
  await environment.emit("session_shutdown");
});

it("supersedes only the rewritten file's in-flight reviewers", async () => {
  const environment = await setup();
  const [first, second] = ["first.ts", "second.ts"].map((name) =>
    path.join(environment.cwd, name),
  );
  if (first === undefined || second === undefined)
    throw new Error("Missing files");
  for (const file of [first, second])
    await fsPromises.writeFile(file, "export const value = 1;\n");
  const stalled = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile).mockReturnValue(stalled.promise);
  for (const file of [first, second])
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: file },
      isError: false,
    });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(4);
  });
  const signals = (name: string): boolean[] =>
    vi
      .mocked(reviewFile)
      .mock.calls.filter(([request]) => request.file === name)
      .map(([request]) => request.signal.aborted);
  await fsPromises.writeFile(first, "export const value = 2;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    { line: 1, title: "Current", quote: "value = 2", evidence: "Fresh" },
  ]);
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: first },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(6);
  });
  expect(signals("first.ts")).toEqual([true, true, false, false]);
  expect(signals("second.ts")).toEqual([false, false]);
  stalled.resolve([
    { line: 1, title: "Stale", quote: "value = 1", evidence: "Old" },
  ]);
  await advanceReviews(() => {
    expect(
      findings(environment.entries).map((finding) => [
        finding.file,
        finding.title,
      ]),
    ).toEqual([
      ["first.ts", "Current"],
      ["first.ts", "Current"],
      ["second.ts", "Stale"],
      ["second.ts", "Stale"],
    ]);
  });
  await environment.emit("session_shutdown");
});

it("reviews identical reviewer configurations once per revision", async () => {
  const environment = await setup();
  const reviewer = {
    model: "current",
    prompt: "Correctness review",
    include: ["**/*.ts"],
    exclude: [],
  };
  await fsPromises.writeFile(
    path.join(environment.cwd, "pair-programmer.reviewers.json"),
    JSON.stringify({ reviewers: [reviewer, reviewer, reviewer] }),
  );
  await environment.emit("session_start");
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const value = 1;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    {
      line: 1,
      title: "Duplicate configuration",
      quote: "value",
      evidence: "One material issue",
    },
  ]);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(1);
  });
  expect(reviewFile).toHaveBeenCalledOnce();
  await environment.emit("turn_end");
  expect(environment.sendMessage).toHaveBeenCalledOnce();
  await environment.emit("session_shutdown");
});
