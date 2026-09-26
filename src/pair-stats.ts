import { createHash, randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { ModelCallObservation } from "./model-usage.js";

export const STATS_ENTRY = "pair-programmer-stats";
const pendingStatsKey = Symbol.for("pi-pair-programmer.pending-stats.v1");
const retainedStats = Reflect.get(globalThis, pendingStatsKey) as
  Map<string, PairStats> | undefined;
const pendingStats = retainedStats ?? new Map<string, PairStats>();
const Count = z.number().nonnegative();
const Outcome = z.enum([
  "success",
  "failed",
  "cancelled",
  "timeout",
  "obsolete",
]);
const Observation = z.object({
  stage: z.enum(["review", "attribution", "dedup"]),
  requestedModel: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
  outcome: z.enum(["success", "failed", "cancelled", "timeout"]),
  durationMs: Count,
  usage: z
    .object({
      inputTokens: Count.optional(),
      outputTokens: Count.optional(),
      cacheReadTokens: Count.optional(),
      cacheWriteTokens: Count.optional(),
      totalTokens: Count.optional(),
      costUsd: Count.optional(),
    })
    .optional(),
});
const Event = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    id: z.string(),
    sessionId: z.string(),
  }),
  z.object({
    action: z.literal("finish"),
    id: z.string(),
    sessionId: z.string(),
    outcome: Outcome,
    durationMs: Count,
    settled: z.boolean(),
  }),
  z.object({
    action: z.literal("settled"),
    id: z.string(),
    sessionId: z.string(),
  }),
  z.object({
    action: z.literal("call"),
    id: z.string(),
    sessionId: z.string(),
    jobId: z.string(),
    observation: Observation,
  }),
]);
const Entry = z.object({
  type: z.literal("custom"),
  customType: z.literal(STATS_ENTRY),
  data: Event,
});

type StatsEvent = z.infer<typeof Event>;
export type ReviewOutcome = z.infer<typeof Outcome>;
export interface MeasuredTotal {
  value: number;
  measured: number;
}
export interface UsageGroup {
  stage: ModelCallObservation["stage"];
  requestedModel: string;
  model?: string;
  provider?: string;
  calls: number;
  outcomes: Record<ModelCallObservation["outcome"], number>;
  durationMs: number;
  inputTokens: MeasuredTotal;
  outputTokens: MeasuredTotal;
  cacheReadTokens: MeasuredTotal;
  cacheWriteTokens: MeasuredTotal;
  totalTokens: MeasuredTotal;
  costUsd: MeasuredTotal;
}
export interface StatsSnapshot {
  reviews: Record<ReviewOutcome | "running" | "interrupted", number>;
  durationMs: number;
  finished: number;
  maxDurationMs: number;
  usage: UsageGroup[];
  persistenceFailures: number;
  pendingWrites: number;
  incompleteJobs: number;
}

export class PairStats {
  readonly sessionId: string;
  private append: (event: StatsEvent) => unknown;
  private readonly records = new Map<string, StatsEvent>();
  private readonly pending = new Map<string, StatsEvent>();
  private readonly live = new Set<string>();
  private persistenceFailures = 0;

  constructor(sessionId: string, append: (event: StatsEvent) => unknown) {
    this.sessionId = sessionId;
    this.append = append;
  }

  setAppender(append: (event: StatsEvent) => unknown): void {
    this.append = append;
  }

  restore(entries: readonly unknown[]): void {
    for (const entry of entries) {
      const parsed = Entry.safeParse(entry);
      if (!parsed.success || parsed.data.data.sessionId !== this.sessionId)
        continue;
      const event = parsed.data.data;
      this.records.set(`${event.action}:${event.id}`, event);
    }
  }

  start(id: string): void {
    this.live.add(id);
    this.record({ action: "start", id, sessionId: this.sessionId });
  }

  finish(
    id: string,
    outcome: ReviewOutcome,
    durationMs: number,
    settled = true,
  ): void {
    if (!this.live.delete(id)) return;
    this.record({
      action: "finish",
      id,
      sessionId: this.sessionId,
      outcome,
      durationMs,
      settled,
    });
  }

  settle(id: string): void {
    const finished = this.records.get(`finish:${id}`);
    if (
      finished?.action !== "finish" ||
      finished.settled ||
      this.records.has(`settled:${id}`)
    )
      return;
    this.record({ action: "settled", id, sessionId: this.sessionId });
  }

  flush(): void {
    for (const [key, event] of this.pending) {
      if (!this.persist(key, event)) break;
    }
  }

  observe(jobId: string, observation: ModelCallObservation): void {
    this.record({
      action: "call",
      id: randomUUID(),
      sessionId: this.sessionId,
      jobId,
      observation,
    });
  }

  snapshot(): StatsSnapshot {
    const result: StatsSnapshot = {
      reviews: {
        running: 0,
        interrupted: 0,
        success: 0,
        failed: 0,
        cancelled: 0,
        timeout: 0,
        obsolete: 0,
      },
      durationMs: 0,
      finished: 0,
      maxDurationMs: 0,
      usage: [],
      persistenceFailures: this.persistenceFailures,
      pendingWrites: this.pending.size,
      incompleteJobs: 0,
    };
    const groups = new Map<string, UsageGroup>();
    for (const event of this.records.values()) {
      switch (event.action) {
        case "start": {
          if (!this.records.has(`finish:${event.id}`)) {
            if (this.live.has(event.id)) result.reviews.running += 1;
            else result.reviews.interrupted += 1;
            result.incompleteJobs += 1;
          }

          break;
        }
        case "finish": {
          result.reviews[event.outcome] += 1;
          result.durationMs += event.durationMs;
          result.maxDurationMs = Math.max(
            result.maxDurationMs,
            event.durationMs,
          );
          result.finished += 1;
          if (!event.settled && !this.records.has(`settled:${event.id}`))
            result.incompleteJobs += 1;

          break;
        }
        case "call": {
          addObservation(groups, event.observation);

          break;
        }
        case "settled":
          break;
      }
    }
    result.usage = [...groups.values()];
    return result;
  }

  private record(event: StatsEvent): void {
    const key = `${event.action}:${event.id}`;
    this.records.set(key, event);
    this.pending.set(key, event);
    this.flush();
  }

  private persist(key: string, event: StatsEvent): boolean {
    try {
      if (this.append(event) === false) return false;
      this.pending.delete(key);
      return true;
    } catch {
      this.persistenceFailures += 1;
      return false;
    }
  }
}

export class SessionAccounting {
  private readonly appendEvent = this.append.bind(this);
  private current = new PairStats(randomUUID(), this.appendEvent);
  private journal:
    | {
        sessionId: string;
        manager: Partial<ExtensionContext["sessionManager"]>;
        append: (data: unknown) => void;
        onPersistenceFailure: () => void;
      }
    | undefined;

  constructor() {
    Reflect.set(globalThis, pendingStatsKey, pendingStats);
  }

  get stats(): PairStats {
    return this.current;
  }

  suspend(): void {
    this.journal = undefined;
  }

  activate(
    manager: Partial<ExtensionContext["sessionManager"]>,
    append: (data: unknown) => void,
    onPersistenceFailure: () => void,
  ): void {
    const sessionId = createHash("sha256")
      .update(
        manager.getSessionId?.() ?? manager.getHeader?.()?.id ?? randomUUID(),
      )
      .digest("hex");
    const retained = pendingStats.get(sessionId);
    this.current = retained ?? new PairStats(sessionId, this.appendEvent);
    retained?.setAppender(this.appendEvent);
    this.current.restore(manager.getEntries?.() ?? []);
    this.journal = { sessionId, manager, append, onPersistenceFailure };
    this.current.flush();
    this.retain(this.current);
  }

  retain(stats: PairStats): void {
    const snapshot = stats.snapshot();
    if (snapshot.incompleteJobs > 0 || snapshot.pendingWrites > 0)
      pendingStats.set(stats.sessionId, stats);
    else pendingStats.delete(stats.sessionId);
  }

  private append(data: StatsEvent): boolean {
    const journal = this.journal;
    if (data.sessionId !== journal?.sessionId) return false;
    try {
      const currentId =
        journal.manager.getSessionId?.() ?? journal.manager.getHeader?.()?.id;
      if (
        currentId !== undefined &&
        createHash("sha256").update(currentId).digest("hex") !== data.sessionId
      )
        return false;
    } catch {
      return false;
    }
    try {
      journal.append(data);
      return true;
    } catch (error) {
      journal.onPersistenceFailure();
      throw error;
    }
  }
}

function addObservation(
  groups: Map<string, UsageGroup>,
  call: z.infer<typeof Observation>,
): void {
  const key = JSON.stringify([
    call.stage,
    call.requestedModel,
    call.provider,
    call.model,
  ]);
  let group = groups.get(key);
  if (group === undefined) {
    group = {
      stage: call.stage,
      requestedModel: call.requestedModel,
      ...(call.model === undefined ? {} : { model: call.model }),
      ...(call.provider === undefined ? {} : { provider: call.provider }),
      calls: 0,
      outcomes: { success: 0, failed: 0, cancelled: 0, timeout: 0 },
      durationMs: 0,
      inputTokens: { value: 0, measured: 0 },
      outputTokens: { value: 0, measured: 0 },
      cacheReadTokens: { value: 0, measured: 0 },
      cacheWriteTokens: { value: 0, measured: 0 },
      totalTokens: { value: 0, measured: 0 },
      costUsd: { value: 0, measured: 0 },
    };
    groups.set(key, group);
  }
  group.calls += 1;
  group.outcomes[call.outcome] += 1;
  group.durationMs += call.durationMs;
  addMeasured(group.inputTokens, call.usage?.inputTokens);
  addMeasured(group.outputTokens, call.usage?.outputTokens);
  addMeasured(group.cacheReadTokens, call.usage?.cacheReadTokens);
  addMeasured(group.cacheWriteTokens, call.usage?.cacheWriteTokens);
  addMeasured(group.totalTokens, call.usage?.totalTokens);
  addMeasured(group.costUsd, call.usage?.costUsd);
}

function addMeasured(total: MeasuredTotal, value: number | undefined): void {
  if (value === undefined) return;
  total.value += value;
  total.measured += 1;
}
