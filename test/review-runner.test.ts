import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import {
  deduplicate,
  isInherited,
  reviewFile,
  type Host,
  type ProposedFinding,
} from "../src/review-runner.js";
import type { ChangeEvidence } from "../src/change-evidence.js";
import type { Finding, StoredFinding } from "../src/review-store.js";

interface JudgmentRequest {
  model: string;
  state: {
    candidate?: Finding;
    finding?: ProposedFinding;
    taskStartSource?: { file: string; source: string };
    currentSource?: { file: string; source: string };
    history?: (Finding & {
      verdict: "accept" | "reject" | null;
      reason: string | null;
    })[];
    earlierCandidates?: Finding[];
  };
  questions: {
    duplicate?: { type: "noul"; instructions?: unknown; criteria?: unknown };
    category?: { type: "choice"; instructions?: unknown; criteria?: unknown };
  };
}

interface JudgmentOptions {
  signal: AbortSignal;
  timeout: number;
  retry: { maxRetries: number };
}

interface JudgmentResponse {
  answers: { duplicate: { noul: number } };
}

const systemOne = vi.hoisted(() =>
  vi.fn<
    (_input: JudgmentRequest, _options: JudgmentOptions) => Promise<unknown>
  >(),
);

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("@typesafe-ai/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TypeSafeClient: class {
    readonly systemOne = systemOne;
  },
}));

interface FakeChild extends PassThrough {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: Mock;
}

function subprocess(): { child: FakeChild; input: string[] } {
  const emitter = new PassThrough();
  const stdin = new PassThrough();
  const input: string[] = [];
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => input.push(chunk));
  const child = Object.assign(emitter, {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => emitter.emit("close", null));
      return true;
    }),
  });
  vi.mocked(spawn).mockReturnValue(
    child as unknown as ChildProcessWithoutNullStreams,
  );
  return { child, input };
}

interface TestReviewRequest {
  host: Host;
  cwd: string;
  model: string;
  prompt: string;
  file: string;
  source: string;
  signal: AbortSignal;
}

function request(
  host: Host = "omp",
  source = "const user = null;\nconsole.log(user.name);\n",
): TestReviewRequest {
  return {
    host,
    cwd: process.cwd(),
    model: "openai/gpt-5",
    prompt: "Find concrete runtime errors",
    file: "src/example.ts",
    source,
    signal: new AbortController().signal,
  };
}

const valid: ProposedFinding = {
  line: 2,
  title: "Null dereference",
  quote: "user.name",
  evidence: "The user can be null at runtime",
};

function finish(child: FakeChild, findings: unknown): void {
  child.stdout.write(JSON.stringify({ findings }));
  child.emit("close", 0);
}

function finding(
  id: string,
  evidence = "user.name — Dereferences nullable user",
): Finding {
  return {
    id,
    reviewer: "correctness",
    file: "src/example.ts",
    revision: "revision-1",
    line: 2,
    title: "Null dereference",
    evidence,
  };
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
  systemOne.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it.each(["pi", "omp"] as const)(
  "isolates %s reviewer execution and sends source only over stdin",
  async (host) => {
    const original = [...process.argv];
    const script = path.join(process.cwd(), "pi-entry.mjs");
    process.argv[1] = script;
    try {
      const { child, input } = subprocess();
      const secret = "never-put-this-source-on-argv";
      const pending = reviewFile(
        request(host, `const key = '${secret}';\nconsole.log(user.name);`),
      );
      const [command, args, options] = vi.mocked(spawn).mock.calls[0] ?? [];
      expect(command).toBe(process.execPath);
      expect(args).toContain("--no-session");
      expect(args).toContain("--no-tools");
      expect(args).toContain("--no-extensions");
      expect(args).toContain("--no-skills");
      expect(args).toContain(
        host === "pi" ? "--no-context-files" : "--no-rules",
      );
      expect(args).not.toContain(
        host === "pi" ? "--no-rules" : "--no-context-files",
      );
      expect(args?.[0]).toBe(host === "pi" ? script : "--no-session");
      expect(args).toContain("--print");
      expect(args?.join(" ")).not.toContain(secret);
      expect(args?.join(" ")).not.toContain("console.log");
      expect(options).toEqual(
        expect.objectContaining({
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
          killSignal: "SIGKILL",
        }),
      );
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      expect(input.join("")).toContain(`1: const key = '${secret}';`);
      finish(child, [valid]);
      await expect(pending).resolves.toEqual([valid]);
    } finally {
      process.argv.splice(0, process.argv.length, ...original);
    }
  },
);

it.each([undefined, ""])(
  "fails when the Pi script path is %s",
  async (script) => {
    const original = [...process.argv];
    if (script === undefined) process.argv.length = 1;
    else process.argv[1] = script;
    try {
      await expect(reviewFile(request("pi"))).rejects.toThrow(
        "Pi executable is unavailable",
      );
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      process.argv.splice(0, process.argv.length, ...original);
    }
  },
);

it("drops malformed proposals even when one verified finding is present", async () => {
  const invalid: unknown[] = [
    null,
    false,
    { ...valid, line: "2" },
    { ...valid, line: 2.5 },
    { ...valid, line: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, line: -1 },
    { ...valid, line: 0 },
    { ...valid, title: 2 },
    { ...valid, title: " " },
    { ...valid, title: "t".repeat(161) },
    { ...valid, quote: 2 },
    { ...valid, quote: " " },
    { ...valid, quote: "q".repeat(241) },
    { ...valid, evidence: 2 },
    { ...valid, evidence: " " },
    { ...valid, evidence: "e".repeat(501) },
    { line: 2, title: valid.title, quote: valid.quote },
    { ...valid, line: 4 },
    { ...valid, line: 1 },
    { ...valid, quote: "other.name" },
  ];
  for (const proposal of invalid) {
    const { child } = subprocess();
    const pending = reviewFile(request());
    finish(child, [proposal, valid]);
    await expect(pending).resolves.toEqual([valid]);
  }
});

it("accepts exact maximum field lengths and verifies the full source quote", async () => {
  const quote = "q".repeat(240);
  const boundary = {
    line: 1,
    title: "t".repeat(160),
    quote,
    evidence: "e".repeat(500),
  };
  const { child } = subprocess();
  const pending = reviewFile(request("omp", `${quote}\n`));
  finish(child, [boundary]);
  await expect(pending).resolves.toEqual([boundary]);
});

it("accepts empty findings and retains valid proposal data with extra fields", async () => {
  const empty = subprocess();
  const noFindings = reviewFile(request());
  empty.child.stdout.write('{"findings":[],"metadata":"ignored"}');
  empty.child.emit("close", 0);
  await expect(noFindings).resolves.toEqual([]);

  const extra = {
    ...valid,
    metadata: "unchanged",
    quote: "  console.log(user.name);",
  };
  const { child } = subprocess();
  const pending = reviewFile(
    request("omp", "const user = null;\n  console.log(user.name);\n"),
  );
  finish(child, [extra]);
  await expect(pending).resolves.toEqual([extra]);
});

it.each([
  "42",
  "null",
  "[]",
  "{}",
  '{"findings":null}',
  '{"findings":"[]"}',
  '{"findings":{}}',
  '{"findings":[{},{},{},{},{},{}]}',
])("rejects invalid reviewer JSON contracts: %s", async (output) => {
  const { child } = subprocess();
  const pending = reviewFile(request());
  child.stdout.write(output);
  child.emit("close", 0);
  await expect(pending).rejects.toThrow(/findings array/u);
});

it.each(["```json\n", "```\n", "```JSON\r\n"])(
  "accepts a sole %s fenced reviewer response",
  async (opening) => {
    const { child } = subprocess();
    const pending = reviewFile(request("omp"));
    const lineEnding = opening.endsWith("\r\n") ? "\r\n" : "\n";
    child.stdout.write(
      `${opening}${JSON.stringify({ findings: [valid] })}${lineEnding}\`\`\`\n`,
    );
    child.emit("close", 0);
    await expect(pending).resolves.toEqual([valid]);
  },
);

it.each([
  "",
  'Findings:\n```json\n{"findings":[]}\n```',
  '```json\n{"findings":[]}\n```\nAdditional text',
  '```yaml\n{"findings":[]}\n```',
  '```json\n{"findings":[]}\n```\n```json\n{"findings":[]}\n```',
])(
  "rejects empty output, unrelated text, or ambiguous fences: %s",
  async (output) => {
    const { child } = subprocess();
    const pending = reviewFile(request("omp"));
    child.stdout.write(output);
    child.emit("close", 0);
    await expect(pending).rejects.toThrow();
  },
);

it("rejects non-JSON output and omits source beyond the excerpt limit", async () => {
  const secret = "source-outside-bounded-excerpt";
  const { child, input } = subprocess();
  const pending = reviewFile(request("omp", `${"x".repeat(60_000)}${secret}`));
  expect(input.join("")).not.toContain(secret);
  child.stdout.write("not json");
  child.emit("close", 0);
  await expect(pending).rejects.toThrow();
});

it("bounds stdout, drains late data, and terminates a noisy reviewer", async () => {
  const { child } = subprocess();
  const pending = reviewFile(request());
  child.stdout.write(Buffer.alloc(256_001));
  child.stdout.write(Buffer.alloc(10));
  await expect(pending).rejects.toThrow("Reviewer output exceeded limit");
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});

it("reports bounded stderr on a failed reviewer and a fallback for no stderr", async () => {
  const failed = subprocess();
  const pending = reviewFile(request());
  failed.child.stderr.write("s".repeat(3000));
  failed.child.emit("close", 2);
  await expect(pending).rejects.toThrow("s".repeat(2048));

  const silent = subprocess();
  const next = reviewFile(request());
  silent.child.emit("close", null);
  await expect(next).rejects.toThrow("Reviewer exited null");
});

it("rejects input pipe failures and kills the child", async () => {
  const { child } = subprocess();
  const pending = reviewFile(request());
  child.stdin.emit("error", new Error("stdin closed"));
  await expect(pending).rejects.toThrow("stdin closed");
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});

it("propagates parent abort and deadline abort through the child signal", async () => {
  const timeout = new AbortController();
  const timeoutFactory = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(timeout.signal);
  for (const deadline of [false, true]) {
    const { child } = subprocess();
    const parent = new AbortController();
    const pending = reviewFile({ ...request(), signal: parent.signal });
    const options = vi.mocked(spawn).mock.lastCall?.[2];
    expect(timeoutFactory).toHaveBeenCalledWith(90_000);
    if (deadline) timeout.abort(new Error("review deadline"));
    else parent.abort(new Error("review cancelled"));
    expect(options?.signal?.aborted).toBe(true);
    child.emit("error", new Error("Reviewer aborted"));
    await expect(pending).rejects.toThrow("Reviewer aborted");
  }
});

it("skips the network when no comparison exists", async () => {
  const first = finding("first");
  const signal = new AbortController().signal;
  await expect(
    deduplicate({ candidates: [], history: [], signal }),
  ).resolves.toEqual([]);
  await expect(
    deduplicate({ candidates: [first], history: [], signal }),
  ).resolves.toEqual([first]);
  expect(systemOne).not.toHaveBeenCalled();
});

it("compares each candidate only against history and strictly earlier candidates", async () => {
  const prior = finding("history");
  const stored: StoredFinding = {
    finding: prior,
    verdict: "reject",
    reason: "Known false positive",
  };
  const approved = finding(
    "approved",
    "user.name — Confirmed null dereference",
  );
  const accepted: StoredFinding = {
    finding: approved,
    verdict: "accept",
    reason: "Confirmed on missing users",
  };
  const history = [
    { ...prior, verdict: "reject", reason: "Known false positive" },
    { ...approved, verdict: "accept", reason: "Confirmed on missing users" },
  ];
  const repeated = finding("same-id");
  const fixed = finding("same-id", "user?.name — Null checked before access");
  systemOne
    .mockResolvedValueOnce({ answers: { duplicate: { noul: 0.94 } } })
    .mockResolvedValueOnce({ answers: { duplicate: { noul: 0.04 } } });
  const signal = new AbortController().signal;
  await expect(
    deduplicate({
      candidates: [repeated, fixed],
      history: [stored, accepted],
      signal,
    }),
  ).resolves.toEqual([fixed]);
  expect(systemOne).toHaveBeenCalledTimes(2);
  const first = systemOne.mock.calls[0];
  const second = systemOne.mock.calls[1];
  expect(first?.[0]).toMatchObject({
    model: "jev-latest",
    state: { candidate: repeated, history, earlierCandidates: [] },
    questions: { duplicate: { type: "noul" } },
  });
  expect(first?.[0].state).not.toHaveProperty("candidates");
  expect(second?.[0].state).toEqual({
    candidate: fixed,
    history,
    earlierCandidates: [repeated],
  });
  expect(first?.[1]).toEqual({
    signal,
    timeout: 30_000,
    retry: { maxRetries: 0 },
  });
  expect(second?.[1]).toEqual({
    signal,
    timeout: 30_000,
    retry: { maxRetries: 0 },
  });
});

it("deduplicates later same-id findings without comparing a candidate to itself", async () => {
  const first = finding("same-id");
  const repeated = finding("same-id");
  const changed = finding(
    "same-id",
    "user.name — New entry point also dereferences null",
  );
  systemOne
    .mockResolvedValueOnce({ answers: { duplicate: { noul: 0.99 } } })
    .mockResolvedValueOnce({ answers: { duplicate: { noul: 0.01 } } });
  await expect(
    deduplicate({
      candidates: [first, repeated, changed],
      history: [],
      signal: new AbortController().signal,
    }),
  ).resolves.toEqual([first, changed]);
  expect(systemOne.mock.calls[0]?.[0].state.earlierCandidates).toEqual([first]);
  expect(systemOne.mock.calls[1]?.[0].state.earlierCandidates).toEqual([
    first,
    repeated,
  ]);
});

it("rechecks already-distinct candidates only against newly stored findings", async () => {
  const stored = finding("stored");
  const [first, second] = [finding("first"), finding("second")];
  systemOne
    .mockResolvedValueOnce({ answers: { duplicate: { noul: 0.9 } } })
    .mockResolvedValueOnce({ answers: { duplicate: { noul: 0.1 } } });
  const signal = new AbortController().signal;
  await expect(
    deduplicate({
      candidates: [first, second],
      history: [{ finding: stored }],
      compareCandidates: false,
      signal,
    }),
  ).resolves.toEqual([second]);
  expect(
    systemOne.mock.calls.map(([input]) => input.state.earlierCandidates),
  ).toEqual([[], []]);
  await expect(
    deduplicate({
      candidates: [first, second],
      history: [],
      compareCandidates: false,
      signal,
    }),
  ).resolves.toEqual([first, second]);
  expect(systemOne).toHaveBeenCalledTimes(2);
});

it("cancels an in-flight Jev judgment without retrying", async () => {
  const controller = new AbortController();
  systemOne.mockImplementationOnce(
    (_input: unknown, options: { signal: AbortSignal }) => {
      const { promise, reject } = Promise.withResolvers<JudgmentResponse>();
      options.signal.addEventListener(
        "abort",
        () => {
          reject(options.signal.reason);
        },
        { once: true },
      );
      return promise;
    },
  );
  const pending = deduplicate({
    candidates: [finding("new")],
    history: [{ finding: finding("old") }],
    signal: controller.signal,
  });
  controller.abort(new Error("review cancelled"));
  await expect(pending).rejects.toThrow("review cancelled");
  expect(systemOne).toHaveBeenCalledOnce();
});

const changeEvidence: ChangeEvidence = {
  status: "available",
  before: {
    file: "old.ts",
    source: "const user = null;\nconsole.log(user.name);\n",
  },
  after: {
    file: "new.ts",
    source: "const user = null;\nconsole.log(user.name);\n",
  },
  diff: "--- old.ts\n+++ new.ts\n const user = null;\n console.log(user.name);\n",
  origins: [
    { file: "old.ts", source: "const user = null;\nconsole.log(user.name);\n" },
  ],
  reason: null,
};

const inheritedAnswer = {
  choice: "inherited",
  confidence: 1,
  probabilities: { inherited: 1, introduced: 0, unknown: 0 },
};

it.each([
  [0, 1, false],
  [0.5, 1, false],
  [0.949999, 1, false],
  [0.95, 1, true],
  [1, 1, true],
  [1, 0.949999, false],
  [1, 0.95, true],
] as const)(
  "suppresses inherited evidence only at high confidence %s and probability %s",
  async (confidence, inheritedProbability, suppressed) => {
    systemOne.mockResolvedValueOnce({
      answers: {
        category: {
          ...inheritedAnswer,
          confidence,
          probabilities: {
            inherited: inheritedProbability,
            introduced: 1 - inheritedProbability,
            unknown: 0,
          },
        },
      },
    });
    await expect(
      isInherited({
        finding: valid,
        evidence: changeEvidence,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(suppressed);
  },
);

it.each([
  {
    ...inheritedAnswer,
    choice: "introduced",
    probabilities: { inherited: 0, introduced: 1, unknown: 0 },
  },
  {
    ...inheritedAnswer,
    choice: "unknown",
    probabilities: { inherited: 0, introduced: 0, unknown: 1 },
  },
  {
    ...inheritedAnswer,
    probabilities: { inherited: 0.5, introduced: 0.5, unknown: 0 },
  },
])(
  "retains introduced, uncertain, or inconsistent categories: %j",
  async (category) => {
    systemOne.mockResolvedValueOnce({ answers: { category } });
    await expect(
      isInherited({
        finding: valid,
        evidence: changeEvidence,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(false);
  },
);

it.each([
  null,
  {},
  { answers: null },
  { answers: { category: null } },
  { answers: { category: { ...inheritedAnswer, choice: "other" } } },
  { answers: { category: { ...inheritedAnswer, probabilities: null } } },
  {
    answers: {
      category: { ...inheritedAnswer, probabilities: { inherited: 1 } },
    },
  },
  {
    answers: {
      category: {
        ...inheritedAnswer,
        probabilities: { inherited: 1, introduced: 1, unknown: 1 },
      },
    },
  },
  ...[-1, 1.01, NaN, Infinity, -Infinity, "1", true].flatMap((value) => [
    { answers: { category: { ...inheritedAnswer, confidence: value } } },
    {
      answers: {
        category: {
          ...inheritedAnswer,
          probabilities: { ...inheritedAnswer.probabilities, inherited: value },
        },
      },
    },
  ]),
])(
  "retains findings on malformed attribution responses: %j",
  async (response) => {
    systemOne.mockResolvedValueOnce(response);
    await expect(
      isInherited({
        finding: valid,
        evidence: changeEvidence,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(false);
  },
);

it.each([
  {
    ...changeEvidence,
    status: "unavailable" as const,
    reason: "ambiguous context",
  },
  { ...changeEvidence, diff: null },
  { ...changeEvidence, before: null, origins: [] },
])(
  "does not suppress without complete actual origin evidence: %j",
  async (evidence) => {
    await expect(
      isInherited({
        finding: valid,
        evidence,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(false);
    expect(systemOne).not.toHaveBeenCalled();
  },
);

it("judges a cross-file origin without requiring an old destination file", async () => {
  systemOne.mockResolvedValueOnce({ answers: { category: inheritedAnswer } });
  await expect(
    isInherited({
      finding: valid,
      evidence: { ...changeEvidence, before: null },
      signal: new AbortController().signal,
    }),
  ).resolves.toBe(true);
});

it("keeps findings when attribution is unavailable or cancelled", async () => {
  systemOne.mockRejectedValueOnce(new Error("Jev unavailable"));
  await expect(
    isInherited({
      finding: valid,
      evidence: changeEvidence,
      signal: new AbortController().signal,
    }),
  ).resolves.toBe(false);
  const controller = new AbortController();
  systemOne.mockImplementationOnce((_request, options) => {
    const { promise, reject } = Promise.withResolvers<unknown>();
    options.signal.addEventListener(
      "abort",
      () => {
        reject(new Error("cancelled"));
      },
      { once: true },
    );
    return promise;
  });
  const pending = isInherited({
    finding: valid,
    evidence: changeEvidence,
    signal: controller.signal,
  });
  controller.abort();
  await expect(pending).resolves.toBe(false);
});

it("surfaces Jev failures for the host fallback instead of silently retaining findings", async () => {
  const previous = finding("old");
  systemOne.mockRejectedValueOnce(new Error("Jev unavailable"));
  await expect(
    deduplicate({
      candidates: [finding("new")],
      history: [{ finding: previous }],
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Jev unavailable");
  expect(systemOne.mock.calls[0]?.[0].state.history).toEqual([
    { ...previous, verdict: null, reason: null },
  ]);
});
