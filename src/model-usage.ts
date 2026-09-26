import { APIError, APITimeoutError, APIUserAbortError } from "@typesafe-ai/sdk";

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface ModelCallObservation {
  stage: "review" | "attribution" | "dedup";
  requestedModel: string;
  model?: string;
  provider?: string;
  outcome: "success" | "failed" | "cancelled" | "timeout";
  durationMs: number;
  usage?: ModelUsage;
}

export type ModelCallObserver = (observation: ModelCallObservation) => void;
type Outcome = ModelCallObservation["outcome"];
type Metadata = Pick<ModelCallObservation, "model" | "provider" | "usage">;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numeric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function metadata(value: unknown, judge = false): Metadata {
  const message = record(value);
  const result: Metadata = {};
  const model =
    !judge && typeof message?.["responseModel"] === "string"
      ? message["responseModel"]
      : message?.["model"];
  if (typeof model === "string") result.model = model;
  if (typeof message?.["provider"] === "string") {
    result.provider = message["provider"];
  }
  const raw = record(message?.["usage"]);
  if (raw === undefined) return result;
  const usage: ModelUsage = {};
  const fields: [keyof ModelUsage, unknown][] = judge
    ? [
        ["inputTokens", raw["input_tokens"]],
        ["outputTokens", raw["output_tokens"]],
      ]
    : [
        ["inputTokens", raw["input"]],
        ["outputTokens", raw["output"]],
        ["cacheReadTokens", raw["cacheRead"]],
        ["cacheWriteTokens", raw["cacheWrite"]],
        ["totalTokens", raw["totalTokens"]],
        ["costUsd", record(raw["cost"])?.["total"]],
      ];
  for (const [key, value] of fields) {
    if (numeric(value) && (key === "costUsd" || Number.isSafeInteger(value))) {
      Object.defineProperty(usage, key, { value, enumerable: true });
    }
  }
  if (Object.keys(usage).length > 0) result.usage = usage;
  return result;
}

function notify(
  observer: ModelCallObserver | undefined,
  event: ModelCallObservation,
): void {
  try {
    observer?.(event);
  } catch {}
}

export async function observeJudgment<T>(
  stage: "attribution" | "dedup",
  signal: AbortSignal,
  observer: ModelCallObserver | undefined,
  invoke: () => PromiseLike<T>,
): Promise<T> {
  const start = performance.now();
  let details: Metadata = {};
  let outcome: Outcome = "success";
  try {
    const response = await invoke();
    details = metadata(response, true);
    return response;
  } catch (error) {
    if (signal.aborted || error instanceof APIUserAbortError) {
      outcome = "cancelled";
    } else {
      outcome = error instanceof APITimeoutError ? "timeout" : "failed";
    }
    if (error instanceof APIError) details = metadata(error.body, true);
    throw error;
  } finally {
    notify(observer, {
      stage,
      requestedModel: "jev-latest",
      ...details,
      outcome,
      durationMs: performance.now() - start,
    });
  }
}

export class ReviewEventStream {
  private readonly model: string;
  private readonly observer: ModelCallObserver | undefined;
  private readonly outcome: () => Exclude<Outcome, "success">;
  private readonly started = performance.now();
  private readonly seen = new Set<string>();
  private buffer = "";
  private invalid = false;
  private sequence = 0;
  private pending: { started: number; details: Metadata } | undefined;
  private answer: string | undefined;
  private finished = false;

  constructor(
    model: string,
    observer: ModelCallObserver | undefined,
    outcome: () => Exclude<Outcome, "success">,
  ) {
    this.model = model;
    this.observer = observer;
    this.outcome = outcome;
  }

  push(chunk: string): void {
    if (this.finished) return;
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      this.checkRecordSize(line);
      this.accept(line);
      newline = this.buffer.indexOf("\n");
    }
    this.checkRecordSize(this.buffer);
  }

  private checkRecordSize(record: string): void {
    if (Buffer.byteLength(record) <= 1024 * 1024) {
      return;
    }

    this.buffer = "";
    this.invalid = true;
    throw new Error("Reviewer output exceeded limit");
  }

  finish(): void {
    if (this.finished) return;
    if (this.buffer.trim().length > 0) this.accept(this.buffer.trim());
    this.buffer = "";
    this.finished = true;
    if (this.pending === undefined) {
      return;
    }

    delete this.pending.details.usage;
    this.emit(this.pending.details, this.outcome());
  }

  text(): string {
    this.finish();
    if (this.invalid)
      throw new Error("Reviewer returned an invalid JSON event stream");
    if (this.answer === undefined)
      throw new Error("Reviewer returned no successful assistant answer");
    return this.answer;
  }

  private accept(line: string): void {
    if (line.length === 0) return;
    try {
      const event = record(JSON.parse(line) as unknown);
      if (typeof event?.["type"] !== "string") {
        this.invalid = true;
        return;
      }
      this.event(event);
    } catch {
      this.invalid = true;
    }
  }

  private event(event: Record<string, unknown>): void {
    const message = record(event["message"]);
    switch (event["type"]) {
      case "message_start":
        if (message?.["role"] === "assistant") {
          this.sequence += 1;
          this.answer = undefined;
          this.pending = {
            started: performance.now(),
            details: metadata(message),
          };
        }
        break;
      case "message_update": {
        this.answer = undefined;
        this.pending ??= { started: performance.now(), details: {} };
        const details = metadata(message ?? event);
        delete details.usage;
        this.pending.details = { ...this.pending.details, ...details };
        break;
      }
      case "message_end":
        if (message === undefined) this.invalid = true;
        else if (message["role"] === "assistant")
          this.endMessage(event, message);
        break;
      default:
        break;
    }
  }

  private endMessage(
    event: Record<string, unknown>,
    message: Record<string, unknown>,
  ): void {
    const identity =
      typeof event["messageId"] === "string"
        ? event["messageId"]
        : `${String(this.sequence)}:${JSON.stringify(message)}`;
    if (this.seen.has(identity)) return;
    this.seen.add(identity);
    const reason = message["stopReason"];
    const successful =
      reason === "stop" || reason === "length" || reason === "toolUse";
    let outcome: Outcome = successful ? "success" : "failed";
    if (reason === "aborted") {
      outcome = this.outcome() === "timeout" ? "timeout" : "cancelled";
    }
    this.emit({ ...this.pending?.details, ...metadata(message) }, outcome);
    this.answer = undefined;
    if (!successful) return;
    const content = message["content"];
    if (!Array.isArray(content)) {
      this.invalid = true;
      return;
    }
    this.answer = content
      .flatMap((block: unknown) => {
        const part = record(block);
        return part?.["type"] === "text" && typeof part["text"] === "string"
          ? [part["text"]]
          : [];
      })
      .join("\n");
    if (Buffer.byteLength(this.answer) <= 256_000) {
      return;
    }

    this.answer = undefined;
    this.invalid = true;
  }

  private emit(details: Metadata, outcome: Outcome): void {
    if (
      outcome !== "success" &&
      details.usage !== undefined &&
      Object.values(details.usage).every((value) => value <= 0)
    ) {
      delete details.usage;
    }
    notify(this.observer, {
      stage: "review",
      requestedModel: this.model,
      ...details,
      outcome,
      durationMs: performance.now() - (this.pending?.started ?? this.started),
    });
    this.pending = undefined;
  }
}
