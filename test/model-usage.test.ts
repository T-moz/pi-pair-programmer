import { APIError, APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";
import { afterEach, expect, it, vi } from "vitest";
import {
  observeJudgment,
  ReviewEventStream,
  type ModelCallObservation,
} from "../src/model-usage.js";

const usage = {
  input: 100,
  output: 20,
  cacheRead: 50,
  cacheWrite: 5,
  totalTokens: 175,
  cost: { total: 0.002 },
};
const message = {
  role: "assistant",
  model: "observed-model",
  provider: "observed-provider",
  timestamp: 1,
  stopReason: "stop",
  content: [{ type: "text", text: '{"findings":[]}' }],
  usage,
};

function push(stream: ReviewEventStream, event: unknown): void {
  stream.push(`${JSON.stringify(event)}\n`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

it.each(["pi", "omp"])(
  "counts authoritative %s usage once rather than streamed or repeated snapshots",
  (host) => {
    const observer = vi.fn<(event: ModelCallObservation) => void>();
    const stream = new ReviewEventStream(
      "requested-alias",
      observer,
      () => "failed",
    );
    let clock = 10;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    push(stream, { type: "session", id: "session" });
    push(stream, {
      type: "message_start",
      message: { role: "user", content: "private prompt" },
    });
    push(stream, {
      type: "message_end",
      message: { role: "user", content: "private prompt" },
    });
    push(stream, {
      type: "message_start",
      message: { ...message, content: [], usage: {} },
    });
    clock = 20;
    const update =
      host === "pi"
        ? { usage: { ...usage, output: 200 } }
        : { message: { ...message, usage: { ...usage, output: 200 } } };
    push(stream, {
      type: "message_update",
      ...update,
      assistantMessageEvent: { type: "text_delta", delta: "private answer" },
    });
    push(stream, { type: "message_update", ...update });
    clock = 45;
    push(stream, { type: "message_end", message });
    push(stream, { type: "message_end", message });
    push(stream, { type: "turn_end", message });
    push(stream, { type: "agent_end", messages: [message] });
    push(stream, { type: "agent_end", messages: [message] });
    expect(stream.text()).toBe('{"findings":[]}');
    expect(observer.mock.calls).toEqual([
      [
        {
          stage: "review",
          requestedModel: "requested-alias",
          model: "observed-model",
          provider: "observed-provider",
          outcome: "success",
          durationMs: 35,
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 50,
            cacheWriteTokens: 5,
            totalTokens: 175,
            costUsd: 0.002,
          },
        },
      ],
    ]);
  },
);

it("uses provider-resolved identities rather than merging request aliases", () => {
  const observer = vi.fn<(event: ModelCallObservation) => void>();
  const stream = new ReviewEventStream("alias", observer, () => "failed");
  push(stream, {
    type: "message_end",
    message: { ...message, responseModel: "actual-1" },
  });
  push(stream, {
    type: "message_end",
    message: { ...message, responseModel: "actual-2" },
  });
  expect(observer.mock.calls.map(([call]) => call.model)).toEqual([
    "actual-1",
    "actual-2",
  ]);
});

it("honors explicit message identity without suppressing distinct calls", () => {
  const observer = vi.fn<(event: ModelCallObservation) => void>();
  const stream = new ReviewEventStream("requested", observer, () => "failed");
  push(stream, { type: "message_end", messageId: "first", message });
  push(stream, {
    type: "message_end",
    messageId: "first",
    message: { ...message, content: [{ type: "text", text: "duplicate" }] },
  });
  push(stream, { type: "message_end", messageId: "second", message });
  expect(stream.text()).toBe('{"findings":[]}');
  expect(
    observer.mock.calls.map(
      ([call]: [ModelCallObservation]) => call.usage?.inputTokens,
    ),
  ).toEqual([100, 100]);
});

it("counts separate started calls even when their final payloads are identical", () => {
  const observer = vi.fn<(event: ModelCallObservation) => void>();
  const stream = new ReviewEventStream("requested", observer, () => "failed");
  for (let call = 0; call < 2; call += 1) {
    push(stream, { type: "message_start", message: { role: "assistant" } });
    push(stream, { type: "message_end", message });
  }
  expect(stream.text()).toBe('{"findings":[]}');
  expect(observer.mock.calls.map(([call]) => call.usage?.outputTokens)).toEqual(
    [20, 20],
  );
});

it("treats failed zero defaults without a start event as unavailable", () => {
  const observer = vi.fn<(event: ModelCallObservation) => void>();
  const stream = new ReviewEventStream("requested", observer, () => "failed");
  push(stream, {
    type: "message_end",
    message: {
      ...message,
      stopReason: "error",
      usage: { input: 0, output: 0 },
    },
  });
  stream.finish();
  expect(observer).toHaveBeenCalledWith({
    stage: "review",
    requestedModel: "requested",
    model: "observed-model",
    provider: "observed-provider",
    outcome: "failed",
    durationMs: expect.any(Number) as unknown,
  });
});

it("uses LF framing across chunks without splitting Unicode separators or leaking thinking blocks", () => {
  const stream = new ReviewEventStream("requested", undefined, () => "failed");
  const final = JSON.stringify({
    type: "message_end",
    message: {
      ...message,
      content: [
        null,
        false,
        [],
        { type: "thinking", thinking: "private" },
        { type: "text", text: "first\u{2028}part\u{2029}" },
        { type: "text", text: 1 },
        { type: "text", text: "second" },
      ],
    },
  });
  stream.push(" \r\n");
  stream.push(final.slice(0, 21));
  stream.push(`${final.slice(21)}\r`);
  stream.push("\n");
  expect(stream.text()).toBe("first\u{2028}part\u{2029}\nsecond");
  push(stream, { type: "message_end", message: { ...message, timestamp: 2 } });
  expect(stream.text()).toBe("first\u{2028}part\u{2029}\nsecond");
});

it.each([
  [undefined, undefined],
  [null, undefined],
  [[], undefined],
  [
    {
      input: -1,
      output: 1.5,
      cacheRead: "12",
      cacheWrite: null,
      totalTokens: Infinity,
      cost: { total: -1 },
    },
    undefined,
  ],
  [
    { input: 0, output: 0 },
    { inputTokens: 0, outputTokens: 0 },
  ],
  [{ input: 8 }, { inputTokens: 8 }],
  [
    { cacheRead: 0, cacheWrite: 14 },
    { cacheReadTokens: 0, cacheWriteTokens: 14 },
  ],
  [{ cost: { total: 0 } }, { costUsd: 0 }],
  [
    { cost: { total: 0.12345 }, output: 2 },
    { costUsd: 0.12345, outputTokens: 2 },
  ],
])(
  "keeps each unavailable counter independent from measured zero: %j",
  (raw, expected) => {
    const observer = vi.fn<(event: ModelCallObservation) => void>();
    const stream = new ReviewEventStream("requested", observer, () => "failed");
    stream.push(
      JSON.stringify({
        type: "message_end",
        message: { ...message, model: null, provider: 1, usage: raw },
      }),
    );
    expect(stream.text()).toBe('{"findings":[]}');
    expect(observer).toHaveBeenCalledWith({
      stage: "review",
      requestedModel: "requested",
      outcome: "success",
      durationMs: expect.any(Number) as unknown,
      ...(expected === undefined ? {} : { usage: expected }),
    });
  },
);

it("accounts failed calls before a retry succeeds without reusing the failed answer", () => {
  const observer = vi.fn<(event: ModelCallObservation) => void>();
  const stream = new ReviewEventStream("requested", observer, () => "failed");
  push(stream, {
    type: "message_end",
    message: {
      ...message,
      stopReason: "error",
      errorMessage: "private failure",
      usage: { input: 10 },
    },
  });
  expect(() => stream.text()).toThrow("no successful assistant answer");
  const retry = new ReviewEventStream("requested", observer, () => "failed");
  push(retry, {
    type: "message_end",
    message: {
      ...message,
      stopReason: "error",
      timestamp: 2,
      usage: { input: 10 },
    },
  });
  push(retry, { type: "message_start", message: { role: "assistant" } });
  push(retry, {
    type: "message_end",
    message: { ...message, timestamp: 3, stopReason: "length" },
  });
  expect(retry.text()).toBe('{"findings":[]}');
  expect(
    observer.mock.calls.map(([call]: [ModelCallObservation]) => [
      call.outcome,
      call.usage?.inputTokens,
    ]),
  ).toEqual([
    ["failed", 10],
    ["failed", 10],
    ["success", 100],
  ]);
});

it.each(["cancelled", "timeout", "failed"] as const)(
  "leaves interrupted %s usage unknown despite streaming estimates",
  (outcome) => {
    const observer = vi.fn<(event: ModelCallObservation) => void>();
    const stream = new ReviewEventStream("requested", observer, () => outcome);
    push(stream, { type: "message_start", message: { ...message, usage: {} } });
    push(stream, { type: "message_update", usage: { input: 7, output: 1 } });
    push(stream, { type: "message_update", usage: { input: 7, output: 3 } });
    stream.finish();
    stream.finish();
    push(stream, { type: "message_end", message });
    expect(observer).toHaveBeenCalledExactlyOnceWith({
      stage: "review",
      requestedModel: "requested",
      model: "observed-model",
      provider: "observed-provider",
      outcome,
      durationMs: expect.any(Number) as unknown,
    });
    expect(() => stream.text()).toThrow("no successful assistant answer");
  },
);

it("recovers partial metadata from older OMP cumulative snapshots without a start event", () => {
  const observer = vi.fn<(event: ModelCallObservation) => void>();
  const stream = new ReviewEventStream(
    "requested",
    observer,
    () => "cancelled",
  );
  push(stream, {
    type: "message_update",
    message: { ...message, usage: { output: 4 } },
  });
  stream.finish();
  expect(observer).toHaveBeenCalledWith(
    expect.objectContaining({
      model: "observed-model",
      provider: "observed-provider",
      outcome: "cancelled",
    }),
  );
});

it.each(["cancelled", "timeout"] as const)(
  "classifies finalized abort as %s and preserves measured usage",
  (outcome) => {
    const observer = vi.fn<(event: ModelCallObservation) => void>();
    const stream = new ReviewEventStream("requested", observer, () => outcome);
    push(stream, {
      type: "message_end",
      message: { ...message, stopReason: "aborted" },
    });
    expect(() => stream.text()).toThrow();
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 50,
          cacheWriteTokens: 5,
          totalTokens: 175,
          costUsd: 0.002,
        },
      }),
    );
  },
);

it.each([false, true])(
  "does not mistake failed host zero defaults for measurements (partial=%s)",
  (partial) => {
    const observer = vi.fn<(event: ModelCallObservation) => void>();
    const stream = new ReviewEventStream("requested", observer, () => "failed");
    push(stream, {
      type: "message_start",
      message: { role: "assistant", usage: { input: 0, output: 0 } },
    });
    if (partial)
      push(stream, { type: "message_update", usage: { input: 12, output: 1 } });
    push(stream, {
      type: "message_end",
      message: {
        ...message,
        stopReason: "error",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { total: 0 },
        },
      },
    });
    stream.finish();
    expect(observer).toHaveBeenCalledWith({
      stage: "review",
      requestedModel: "requested",
      model: "observed-model",
      provider: "observed-provider",
      outcome: "failed",
      durationMs: expect.any(Number) as unknown,
    });
  },
);

it("does not return an earlier answer if a subsequent call never finalizes", () => {
  const observer = vi.fn<(event: ModelCallObservation) => void>();
  const stream = new ReviewEventStream("requested", observer, () => "failed");
  push(stream, { type: "message_end", message });
  push(stream, { type: "message_start", message: { role: "assistant" } });
  expect(() => stream.text()).toThrow("no successful assistant answer");
  expect(
    observer.mock.calls.map(([call]: [ModelCallObservation]) => call.outcome),
  ).toEqual(["success", "failed"]);
});

it.each([
  "not json",
  "null",
  "[]",
  "42",
  "{}",
  '{"type":1}',
  '{"type":"message_end"}',
  '{"type":"message_end","message":[]}',
])("rejects malformed protocol while retaining later usage: %s", (line) => {
  const observer = vi.fn<(event: ModelCallObservation) => void>();
  const stream = new ReviewEventStream("requested", observer, () => "failed");
  stream.push(`${line}\n`);
  push(stream, { type: "message_end", message });
  expect(() => stream.text()).toThrow("invalid JSON event stream");
  expect(observer).toHaveBeenCalledOnce();
});

it.each(["pending", "unknown", undefined])(
  "never accepts a nonfinal assistant stop reason %s",
  (stopReason) => {
    const observer = vi.fn<(event: ModelCallObservation) => void>();
    const stream = new ReviewEventStream("requested", observer, () => "failed");
    push(stream, { type: "message_end", message: { ...message, stopReason } });
    expect(() => stream.text()).toThrow("no successful assistant answer");
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
    );
  },
);

it("rejects invalid assistant content even if usage is available", () => {
  const observer = vi.fn<(event: ModelCallObservation) => void>();
  const stream = new ReviewEventStream("requested", observer, () => "failed");
  push(stream, { type: "message_end", message: { ...message, content: null } });
  expect(() => stream.text()).toThrow("invalid JSON event stream");
  expect(observer).toHaveBeenCalledWith(
    expect.objectContaining({
      usage: expect.objectContaining({ inputTokens: 100 }) as unknown,
    }),
  );
});

it("does not invent a model call for headers or user messages alone", () => {
  const observer = vi.fn<(event: ModelCallObservation) => void>();
  const stream = new ReviewEventStream("requested", observer, () => "failed");
  push(stream, { type: "session" });
  push(stream, { type: "message_start" });
  push(stream, { type: "message_end", message: { role: "user" } });
  expect(() => stream.text()).toThrow("no successful assistant answer");
  expect(observer).not.toHaveBeenCalled();
});

it("isolates failing observers from parsing and tool-use finalization", () => {
  const stream = new ReviewEventStream(
    "requested",
    () => {
      throw new Error("journal unavailable");
    },
    () => "failed",
  );
  push(stream, {
    type: "message_end",
    message: { ...message, stopReason: "toolUse" },
  });
  expect(stream.text()).toBe('{"findings":[]}');
});

it("records SDK-provided model and independent token counts without fabricating cache counters or cost", async () => {
  const observer = vi.fn<(event: ModelCallObservation) => void>();
  vi.spyOn(performance, "now")
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(175);
  const response = {
    model: "jev-1.13",
    usage: { input_tokens: 42, output_tokens: 0 },
    answers: { private: true },
  };
  await expect(
    observeJudgment("attribution", new AbortController().signal, observer, () =>
      Promise.resolve(response),
    ),
  ).resolves.toBe(response);
  expect(observer).toHaveBeenCalledExactlyOnceWith({
    stage: "attribution",
    requestedModel: "jev-latest",
    model: "jev-1.13",
    outcome: "success",
    durationMs: 75,
    usage: { inputTokens: 42, outputTokens: 0 },
  });
});

it.each([
  null,
  {},
  { model: null, usage: {} },
  { usage: { input_tokens: -1, output_tokens: Infinity } },
])(
  "preserves SDK response behavior when usage is unavailable: %j",
  async (response) => {
    const observer = vi.fn<(event: ModelCallObservation) => void>();
    await expect(
      observeJudgment("dedup", new AbortController().signal, observer, () =>
        Promise.resolve(response),
      ),
    ).resolves.toBe(response);
    expect(observer).toHaveBeenCalledWith({
      stage: "dedup",
      requestedModel: "jev-latest",
      outcome: "success",
      durationMs: expect.any(Number) as unknown,
    });
  },
);

it.each([
  [new Error("private failure"), "failed"],
  [new APITimeoutError(30_000), "timeout"],
  [new APIUserAbortError(), "cancelled"],
] as const)(
  "classifies SDK errors without exposing their text",
  async (error, outcome) => {
    const observer = vi.fn<(event: ModelCallObservation) => void>();
    await expect(
      observeJudgment("dedup", new AbortController().signal, observer, () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(observer).toHaveBeenCalledExactlyOnceWith({
      stage: "dedup",
      requestedModel: "jev-latest",
      outcome,
      durationMs: expect.any(Number) as unknown,
    });
  },
);

it("retains usage explicitly supplied in an API failure body", async () => {
  const observer = vi.fn<(event: ModelCallObservation) => void>();
  const error = new APIError(
    500,
    {
      model: "jev-actual",
      usage: { input_tokens: 8 },
      error: "private provider prose",
    },
    new Headers(),
  );
  await expect(
    observeJudgment("attribution", new AbortController().signal, observer, () =>
      Promise.reject(error),
    ),
  ).rejects.toBe(error);
  expect(observer).toHaveBeenCalledWith({
    stage: "attribution",
    requestedModel: "jev-latest",
    model: "jev-actual",
    outcome: "failed",
    durationMs: expect.any(Number) as unknown,
    usage: { inputTokens: 8 },
  });
});

it("prioritizes caller cancellation and never lets a throwing observer alter it", async () => {
  const controller = new AbortController();
  const observer = vi.fn(() => {
    throw new Error("storage failed");
  });
  const error = new Error("cancelled");
  const pending = observeJudgment(
    "attribution",
    controller.signal,
    observer,
    () => {
      controller.abort();
      return Promise.reject(error);
    },
  );
  await expect(pending).rejects.toBe(error);
  expect(observer).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "cancelled" }),
  );
  await expect(
    observeJudgment("dedup", new AbortController().signal, undefined, () =>
      Promise.resolve(42),
    ),
  ).resolves.toBe(42);
});
