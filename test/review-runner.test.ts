import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import {
  isInherited,
  reviewFile,
  ReviewTimeoutError,
  type Host,
  type ProposedFinding,
} from "../src/review-runner.js";
import type { ChangeEvidence } from "../src/change-evidence.js";
import type { ModelCallObservation } from "../src/model-usage.js";

interface JudgmentRequest {
  model: string;
  state: {
    finding?: ProposedFinding;
    taskStartSource?: { file: string; source: string };
    currentSource?: { file: string; source: string };
  };
  questions: {
    category?: { type: "choice"; instructions?: unknown; criteria?: unknown };
  };
}

interface JudgmentOptions {
  signal: AbortSignal;
  timeout: number;
  retry: { maxRetries: number };
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

function finishText(child: FakeChild, text: string): void {
  const message = {
    role: "assistant",
    provider: "openai",
    model: "gpt-5",
    timestamp: 1,
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: {
      input: 12,
      output: 8,
      cacheRead: 4,
      cacheWrite: 0,
      totalTokens: 24,
      cost: { total: 0.001 },
    },
  };
  child.stdout.write(`${JSON.stringify({ type: "message_end", message })}\n`);
  child.stdout.write(
    `${JSON.stringify({ type: "agent_end", messages: [message] })}\n`,
  );
  child.emit("close", 0);
}

function finish(child: FakeChild, findings: unknown): void {
  finishText(child, JSON.stringify({ findings }));
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
  finishText(empty.child, '{"findings":[],"metadata":"ignored"}');
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
  finishText(child, output);
  await expect(pending).rejects.toThrow(/findings array/u);
});

it.each(["```json\n", "```\n", "```JSON\r\n"])(
  "accepts a sole %s fenced reviewer response",
  async (opening) => {
    const { child } = subprocess();
    const pending = reviewFile(request("omp"));
    const lineEnding = opening.endsWith("\r\n") ? "\r\n" : "\n";
    finishText(
      child,
      `${opening}${JSON.stringify({ findings: [valid] })}${lineEnding}\`\`\`\n`,
    );
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
    finishText(child, output);
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

it("bounds unframed stdout, drains late data, and terminates a noisy reviewer", async () => {
  const { child } = subprocess();
  const pending = reviewFile(request());
  child.stdout.write(Buffer.alloc(1024 * 1024 + 1));
  child.stdout.write(Buffer.alloc(10));
  await expect(pending).rejects.toThrow("Reviewer output exceeded limit");
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});

it("accepts supported multibyte source echoes and repeated JSON lifecycle traffic", async () => {
  const { child, input } = subprocess();
  const observer = vi.fn();
  const source = `const value = "${"漢".repeat(50_000)}";\n`;
  const pending = reviewFile({
    ...request("omp", source),
    onModelCall: observer,
  });
  const user = {
    role: "user",
    content: [{ type: "text", text: input.join("") }],
  };
  for (const type of ["message_start", "message_end"])
    child.stdout.write(`${JSON.stringify({ type, message: user })}\n`);
  child.stdout.write(
    `${JSON.stringify({ type: "message_start", message: { role: "assistant" } })}\n`,
  );
  for (let count = 0; count < 2000; count += 1)
    child.stdout.write(
      `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "x".repeat(200) } })}\n`,
    );
  finish(child, []);
  await expect(pending).resolves.toEqual([]);
  expect(child.kill).not.toHaveBeenCalled();
  expect(observer).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
        totalTokens: 24,
        costUsd: 0.001,
      },
    }),
  );
});

it("rejects oversized individual JSON records and decoded answers", async () => {
  const first = subprocess();
  const untrusted = reviewFile(request());
  first.child.stdout.write(
    `${JSON.stringify({ type: "message_end", message: { role: "user", content: "x".repeat(1024 * 1024) } })}\n`,
  );
  await expect(untrusted).rejects.toThrow("Reviewer output exceeded limit");
  const second = subprocess();
  const answer = reviewFile(request());
  finishText(second.child, "漢".repeat(90_000));
  await expect(answer).rejects.toThrow("invalid JSON event stream");
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

it.each(["pi", "omp"] as const)(
  "returns %s findings alongside one redacted usage observation",
  async (host) => {
    const { child } = subprocess();
    const observations: ModelCallObservation[] = [];
    const pending = reviewFile({
      ...request(host),
      onModelCall: (event) => {
        observations.push(event);
      },
    });
    finish(child, [valid]);
    await expect(pending).resolves.toEqual([valid]);
    expect(observations).toEqual([
      {
        stage: "review",
        requestedModel: "openai/gpt-5",
        model: "gpt-5",
        provider: "openai",
        outcome: "success",
        durationMs: expect.any(Number) as unknown,
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          cacheReadTokens: 4,
          cacheWriteTokens: 0,
          totalTokens: 24,
          costUsd: 0.001,
        },
      },
    ]);
  },
);

it("retains failed reviewer usage without turning a failed response into findings", async () => {
  const { child } = subprocess();
  const onModelCall = vi.fn();
  const pending = reviewFile({ ...request(), onModelCall });
  child.stdout.write(
    `${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        model: "actual-fallback",
        stopReason: "error",
        usage: { input: 9, output: 2 },
        content: [
          { type: "text", text: JSON.stringify({ findings: [valid] }) },
        ],
        errorMessage: "private error",
      },
    })}\n`,
  );
  child.emit("close", 1);
  await expect(pending).rejects.toThrow("Reviewer exited 1");
  expect(onModelCall).toHaveBeenCalledExactlyOnceWith({
    stage: "review",
    requestedModel: "openai/gpt-5",
    model: "actual-fallback",
    outcome: "failed",
    durationMs: expect.any(Number) as unknown,
    usage: { inputTokens: 9, outputTokens: 2 },
  });
});

it("records an unfinished provider call as failed without measuring streamed estimates", async () => {
  const { child } = subprocess();
  const observer = vi.fn();
  const pending = reviewFile({ ...request(), onModelCall: observer });
  child.stdout.write(
    `${JSON.stringify({ type: "message_start", message: { role: "assistant", model: "observed" } })}\n`,
  );
  child.stdout.write(
    `${JSON.stringify({ type: "message_update", usage: { input: 12 } })}\n`,
  );
  child.emit("close", 2);
  await expect(pending).rejects.toThrow("Reviewer exited 2");
  expect(observer).toHaveBeenCalledExactlyOnceWith({
    stage: "review",
    requestedModel: "openai/gpt-5",
    model: "observed",
    outcome: "failed",
    durationMs: expect.any(Number) as unknown,
  });
});

it.each([false, true])(
  "leaves nonfinal usage unknown on reviewer interruption (deadline=%s)",
  async (deadline) => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const controller = new AbortController();
    const { child } = subprocess();
    const onModelCall = vi.fn();
    const pending = reviewFile({
      ...request(),
      signal: controller.signal,
      onModelCall,
    });
    child.stdout.write(
      `${JSON.stringify({ type: "message_start", message: { role: "assistant", model: "observed" } })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ type: "message_update", usage: { input: 7 } })}\n`,
    );
    if (deadline) timeout.abort();
    else controller.abort();
    child.emit("error", new Error("interrupted"));
    child.emit("close", null);
    await expect(pending).rejects.toThrow("interrupted");
    expect(onModelCall).toHaveBeenCalledExactlyOnceWith({
      stage: "review",
      requestedModel: "openai/gpt-5",
      model: "observed",
      outcome: deadline ? "timeout" : "cancelled",
      durationMs: expect.any(Number) as unknown,
    });
  },
);

it.each([false, true])(
  "classifies a startup deadline without inventing a model call (parent also aborted=%s)",
  async (cancelled) => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const parent = new AbortController();
    const { child } = subprocess();
    const onModelCall = vi.fn();
    const pending = reviewFile({
      ...request(),
      signal: parent.signal,
      onModelCall,
    });
    timeout.abort();
    if (cancelled) parent.abort();
    const error = new Error("Reviewer aborted");
    child.emit("error", error);
    if (cancelled) await expect(pending).rejects.toBe(error);
    else await expect(pending).rejects.toBeInstanceOf(ReviewTimeoutError);
    expect(onModelCall).not.toHaveBeenCalled();
  },
);

it("decodes UTF-8 split across subprocess chunks before validating exact quotes", async () => {
  const proposal = { ...valid, line: 1, quote: "élève.name" };
  const { child } = subprocess();
  const pending = reviewFile(request("omp", "élève.name"));
  const bytes = Buffer.from(
    `${JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ findings: [proposal] }) }] } })}\n`,
  );
  const split = bytes.indexOf(Buffer.from("é")) + 1;
  child.stdout.write(bytes.subarray(0, split));
  child.stdout.write(bytes.subarray(split));
  child.emit("close", 0);
  await expect(pending).resolves.toEqual([proposal]);
});

it("keeps attribution decisions while accounting real SDK usage and ignoring unavailable evidence", async () => {
  const onModelCall = vi.fn();
  const input = {
    finding: valid,
    evidence: changeEvidence,
    signal: new AbortController().signal,
    onModelCall,
  };
  systemOne.mockResolvedValueOnce({
    answers: { category: inheritedAnswer },
    model: "jev-actual",
    usage: { input_tokens: 81, output_tokens: 3 },
  });
  await expect(isInherited(input)).resolves.toBe(true);
  expect(onModelCall).toHaveBeenCalledExactlyOnceWith({
    stage: "attribution",
    requestedModel: "jev-latest",
    model: "jev-actual",
    outcome: "success",
    durationMs: expect.any(Number) as unknown,
    usage: { inputTokens: 81, outputTokens: 3 },
  });
  await expect(
    isInherited({ ...input, evidence: { ...changeEvidence, diff: null } }),
  ).resolves.toBe(false);
  expect(onModelCall).toHaveBeenCalledOnce();
});

it("retains fail-open attribution when accounting fails or the provider fails", async () => {
  const input = {
    finding: valid,
    evidence: changeEvidence,
    signal: new AbortController().signal,
  };
  systemOne.mockResolvedValueOnce({
    answers: { category: inheritedAnswer },
    model: "jev-actual",
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  await expect(
    isInherited({
      ...input,
      onModelCall: () => {
        throw new Error("storage unavailable");
      },
    }),
  ).resolves.toBe(true);
  const onModelCall = vi.fn();
  systemOne.mockRejectedValueOnce(new Error("private provider failure"));
  await expect(isInherited({ ...input, onModelCall })).resolves.toBe(false);
  expect(onModelCall).toHaveBeenCalledExactlyOnceWith({
    stage: "attribution",
    requestedModel: "jev-latest",
    outcome: "failed",
    durationMs: expect.any(Number) as unknown,
  });
});
