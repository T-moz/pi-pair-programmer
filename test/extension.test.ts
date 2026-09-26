import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import pairProgrammer from "../src/index.js";
import {
  deduplicate,
  reviewFile,
  type ProposedFinding,
} from "../src/review-runner.js";
import type { Finding } from "../src/review-store.js";
import type * as reviewerModule from "../src/reviewers.js";

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

vi.mock("../src/review-runner.js", () => ({
  reviewFile: vi.fn(),
  deduplicate: vi.fn(),
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

async function setup(
  host: "pi" | "omp" = "pi",
  aliasedCwd = false,
  useDefaults = false,
): Promise<{
  cwd: string;
  ctx: ExtensionContext;
  emit: (name: string, event?: unknown) => Promise<unknown>;
  command: (name: string) => Promise<void>;
  decide: DecisionTool["execute"];
  sendMessage: Mock<ExtensionAPI["sendMessage"]>;
  notify: ReturnType<typeof vi.fn>;
  entries: JournalEntry[];
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
  let entryError: Error | undefined;
  let entryAttempts = 0;
  const notify = vi.fn();
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
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
      entryAttempts += 1;
      if (entryError !== undefined) throw entryError;
      if (customType !== "pair-programmer")
        throw new Error(`Unexpected entry ${customType}`);
      entries.push({
        type: "custom",
        customType,
        data: data as JournalEntry["data"],
      });
    },
  } as unknown as ExtensionAPI);
  if (decide === undefined) throw new Error("Decision tool not registered");
  const ctx = {
    cwd,
    model: { provider: "openai", id: "gpt-5" },
    modelRegistry: host === "pi" ? { streamSimple: vi.fn() } : {},
    sessionManager: { getBranch: () => entries },
    ui: { notify },
  } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown = {}): Promise<unknown> => {
    const handler = hooks.get(name);
    if (!handler) throw new Error(`Missing ${name} hook`);
    return await handler(event, ctx);
  };
  await emit("session_start");
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
    notify,
    entries,
    failEntry: (error?: Error) => {
      entryError = error;
    },
    entryAttempts: () => entryAttempts,
  };
}

beforeEach(() => {
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
  vi.mocked(deduplicate).mockReset();
  vi.mocked(deduplicate).mockImplementation(({ candidates }) =>
    Promise.resolve(candidates),
  );
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

it("bounds concurrent reviews and sends the next finding batch only after decisions", async () => {
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
    expect(reviewFile).toHaveBeenCalledTimes(2);
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
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(3);
  });
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
  vi.mocked(deduplicate).mockRejectedValueOnce(new Error("Jev unavailable"));
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
    expect(deduplicate).toHaveBeenCalledTimes(4);
  });
  expect(findings(environment.entries)).toHaveLength(2);
  expect(
    await environment.emit("tool_call", { toolName: "write", input: {} }),
  ).toBeUndefined();
  await environment.emit("session_shutdown");
});

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

it("drops a review when the source changes while Jev is judging it", async () => {
  const environment = await setup();
  const file = path.join(environment.cwd, "change.ts");
  await fsPromises.writeFile(file, "export const vulnerable = true;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    { line: 1, title: "Unsafe", quote: "vulnerable", evidence: "Old evidence" },
  ]);
  const judgment = Promise.withResolvers<readonly Finding[]>();
  vi.mocked(deduplicate).mockReturnValueOnce(judgment.promise);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(deduplicate).toHaveBeenCalled();
  });
  await fsPromises.writeFile(file, "export const vulnerable = false;\n");
  vi.mocked(reviewFile).mockResolvedValue([
    {
      line: 1,
      title: "New issue",
      quote: "false",
      evidence: "Current evidence",
    },
  ]);
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: file },
    isError: false,
  });
  judgment.resolve(vi.mocked(deduplicate).mock.calls[0]?.[0].candidates ?? []);
  await advanceReviews(() => {
    expect(
      findings(environment.entries).some(
        (finding) => finding.title === "New issue",
      ),
    ).toBe(true);
  });
  expect(
    findings(environment.entries).some((finding) => finding.title === "Unsafe"),
  ).toBe(false);
  await environment.emit("session_shutdown");
});

it("ignores queued review results after their source changes before deduplication", async () => {
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
    ]),
  );
  const judgment = Promise.withResolvers<readonly Finding[]>();
  vi.mocked(deduplicate).mockReturnValueOnce(judgment.promise);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: first },
    isError: false,
  });
  await advanceReviews(() => {
    expect(deduplicate).toHaveBeenCalledOnce();
  });
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: second },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  await fsPromises.writeFile(second, "export const second = false;\n");
  judgment.resolve(vi.mocked(deduplicate).mock.calls[0]?.[0].candidates ?? []);
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(1);
  });
  await environment.emit("turn_end");
  expect(environment.sendMessage).toHaveBeenCalledOnce();
  expect(findings(environment.entries)[0]?.file).toBe("first.ts");
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

it("replaces only a changed file among queued reviewer jobs", async () => {
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
  const files = ["first.ts", "second.ts", "third.ts", "fourth.ts"].map((name) =>
    path.join(environment.cwd, name),
  );
  for (const file of files)
    await fsPromises.writeFile(file, "export const value = 1;\n");
  const first = Promise.withResolvers<ProposedFinding[]>();
  const second = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockResolvedValue([]);
  for (const file of files.slice(0, 2))
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: file },
      isError: false,
    });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  for (const file of files.slice(2))
    await environment.emit("tool_result", {
      toolName: "write",
      input: { path: file },
      isError: false,
    });
  await advanceReviews(() => {
    expect(matchingCalls.get("third.ts")).toBe(1);
    expect(matchingCalls.get("fourth.ts")).toBe(1);
  });
  const third = files[2];
  if (third === undefined) throw new Error("Missing queued file");
  await fsPromises.writeFile(third, "export const value = 2;\n");
  await environment.emit("tool_result", {
    toolName: "edit",
    input: { path: third },
    isError: false,
  });
  await advanceReviews(() => {
    expect(matchingCalls.get("third.ts")).toBe(2);
  });
  first.resolve([]);
  second.resolve([]);
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(4);
  });
  const dispatched = vi
    .mocked(reviewFile)
    .mock.calls.map(([request]) => request);
  expect(
    dispatched.find((request) => request.file === "third.ts")?.source,
  ).toContain("value = 2");
  expect(dispatched.some((request) => request.file === "fourth.ts")).toBe(true);
  await environment.emit("session_shutdown");
});

it("keeps the reviewer queue bounded when identical configured reviews finish", async () => {
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
  const first = Promise.withResolvers<ProposedFinding[]>();
  const second = Promise.withResolvers<ProposedFinding[]>();
  vi.mocked(reviewFile)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  await environment.emit("tool_result", {
    toolName: "write",
    input: { path: file },
    isError: false,
  });
  await advanceReviews(() => {
    expect(reviewFile).toHaveBeenCalledTimes(2);
  });
  first.resolve([
    {
      line: 1,
      title: "Duplicate configuration",
      quote: "value",
      evidence: "One material issue",
    },
  ]);
  await advanceReviews(() => {
    expect(findings(environment.entries)).toHaveLength(1);
  });
  second.resolve([]);
  await environment.emit("turn_end");
  expect(environment.sendMessage).toHaveBeenCalledOnce();
  expect(reviewFile).toHaveBeenCalledTimes(2);
  await environment.emit("session_shutdown");
});
