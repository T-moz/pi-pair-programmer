import { describe, expect, it } from "vitest";
import type { ModelCallObservation } from "../src/model-usage.js";
import { PairStats, STATS_ENTRY } from "../src/pair-stats.js";

function call(
  overrides: Partial<ModelCallObservation> = {},
): ModelCallObservation {
  return {
    stage: "review",
    requestedModel: "requested/model",
    outcome: "success",
    durationMs: 10,
    ...overrides,
  };
}

function ledger(sessionId = "session"): {
  stats: PairStats;
  entries: unknown[];
} {
  const entries: unknown[] = [];
  return {
    entries,
    stats: new PairStats(sessionId, (data) => {
      entries.push({ type: "custom", customType: STATS_ENTRY, data });
    }),
  };
}

describe("PairStats", () => {
  it("separates running, finalized and interrupted work without double-finalizing cancellations", () => {
    const { stats, entries } = ledger();
    stats.start("running");
    stats.start("cancelled");
    stats.finish("cancelled", "cancelled", 20);
    stats.finish("cancelled", "success", 200);
    stats.finish("unknown", "failed", 1);
    for (const outcome of [
      "success",
      "failed",
      "timeout",
      "obsolete",
    ] as const) {
      stats.start(outcome);
      stats.finish(outcome, outcome, 10);
    }
    expect(stats.snapshot()).toMatchObject({
      reviews: {
        running: 1,
        interrupted: 0,
        success: 1,
        failed: 1,
        timeout: 1,
        cancelled: 1,
        obsolete: 1,
      },
      finished: 5,
      durationMs: 60,
      maxDurationMs: 20,
    });
    const resumed = ledger().stats;
    resumed.restore(entries);
    expect(resumed.snapshot()).toMatchObject({
      reviews: { running: 0, interrupted: 1, cancelled: 1 },
      finished: 5,
    });

    stats.restore(entries);
    resumed.restore(entries);
    expect(stats.snapshot().reviews.running).toBe(1);
    expect(resumed.snapshot().finished).toBe(5);
  });

  it("keeps partial and unavailable metrics distinct from measured zero for each stage and observed model", () => {
    const { stats, entries } = ledger();
    stats.observe(
      "job",
      call({
        model: "actual",
        provider: "provider",
        usage: { inputTokens: 20, outputTokens: 0, costUsd: 0 },
      }),
    );
    stats.observe(
      "job",
      call({
        model: "actual",
        provider: "provider",
        outcome: "failed",
        usage: {
          inputTokens: 10,
          cacheReadTokens: 5,
          cacheWriteTokens: 2,
          totalTokens: 17,
        },
      }),
    );
    stats.observe(
      "job",
      call({ model: "actual", provider: "provider", outcome: "cancelled" }),
    );
    stats.observe(
      "job",
      call({
        stage: "dedup",
        model: "judge",
        outcome: "timeout",
        usage: { inputTokens: 8, outputTokens: 3 },
      }),
    );
    stats.observe("job", call({ stage: "attribution" }));
    stats.observe("job", call({ model: "other" }));
    const groups = stats.snapshot().usage;
    expect(groups).toHaveLength(4);
    expect(groups[0]).toMatchObject({
      stage: "review",
      model: "actual",
      provider: "provider",
      calls: 3,
      durationMs: 30,
      outcomes: { success: 1, failed: 1, cancelled: 1, timeout: 0 },
      inputTokens: { value: 30, measured: 2 },
      outputTokens: { value: 0, measured: 1 },
      cacheReadTokens: { value: 5, measured: 1 },
      cacheWriteTokens: { value: 2, measured: 1 },
      totalTokens: { value: 17, measured: 1 },
      costUsd: { value: 0, measured: 1 },
    });
    expect(groups[1]).toMatchObject({
      stage: "dedup",
      model: "judge",
      inputTokens: { value: 8, measured: 1 },
      costUsd: { value: 0, measured: 0 },
    });
    expect(groups[2]).toMatchObject({
      stage: "attribution",
      requestedModel: "requested/model",
      inputTokens: { value: 0, measured: 0 },
    });
    expect(groups[2]).not.toHaveProperty("model");
    const restored = ledger().stats;
    restored.restore(entries);
    expect(restored.snapshot().usage).toEqual(groups);
  });

  it("retains late incurred usage in its originating session and ignores foreign or malformed records", () => {
    const first = ledger("first");
    first.stats.start("old-job");
    first.stats.finish("old-job", "cancelled", 40);
    const second = ledger("second");
    first.stats.observe("old-job", call({ usage: { inputTokens: 100 } }));
    const bad = {
      type: "custom",
      customType: STATS_ENTRY,
      data: {
        action: "call",
        id: "bad",
        sessionId: "first",
        jobId: "job",
        observation: call({ durationMs: -1 }),
      },
    };
    second.stats.restore([
      ...first.entries,
      bad,
      {},
      { type: "custom", customType: "other", data: {} },
    ]);
    expect(second.stats.snapshot().usage).toEqual([]);
    expect(second.stats.snapshot().finished).toBe(0);
    first.stats.restore([bad]);
    expect(first.stats.snapshot().usage[0]?.inputTokens).toEqual({
      value: 100,
      measured: 1,
    });
    expect(first.stats.snapshot().reviews.cancelled).toBe(1);
  });

  it("persists incomplete cancellation until deferred origin-owned records are flushed", () => {
    const entries: unknown[] = [];
    let ownsJournal = true;
    const stats = new PairStats("origin", (data) => {
      if (!ownsJournal) return false;
      entries.push({ type: "custom", customType: STATS_ENTRY, data });
      return true;
    });
    stats.start("job");
    stats.finish("job", "cancelled", 5, false);
    ownsJournal = false;
    stats.observe("job", call({ usage: { inputTokens: 20 } }));
    stats.settle("job");
    stats.settle("job");
    stats.settle("unknown");
    stats.flush();
    expect(stats.snapshot()).toMatchObject({
      incompleteJobs: 0,
      pendingWrites: 2,
    });
    const reopened = new PairStats("origin", () => true);
    reopened.restore(entries);
    expect(reopened.snapshot()).toMatchObject({
      incompleteJobs: 1,
      usage: [],
      reviews: { cancelled: 1 },
    });
    ownsJournal = true;
    stats.flush();
    stats.flush();
    reopened.restore(entries);
    expect(stats.snapshot().pendingWrites).toBe(0);
    expect(reopened.snapshot()).toMatchObject({
      incompleteJobs: 0,
      usage: [{ inputTokens: { value: 20, measured: 1 } }],
    });
    stats.start("completed");
    stats.finish("completed", "success", 1);
    stats.settle("completed");
    expect(stats.snapshot().finished).toBe(2);
  });

  it("never persists completion ahead of a missing call after storage recovers", () => {
    const entries: unknown[] = [];
    let failCalls = true;
    const stats = new PairStats("origin", (data) => {
      if (data.action === "call" && failCalls)
        throw new Error("temporary disk failure");
      entries.push({ type: "custom", customType: STATS_ENTRY, data });
    });
    stats.start("job");
    stats.observe("job", call({ usage: { inputTokens: 9 } }));
    stats.finish("job", "success", 5);
    const cold = new PairStats("origin", () => true);
    cold.restore(entries);
    expect(cold.snapshot()).toMatchObject({
      incompleteJobs: 1,
      reviews: { interrupted: 1, success: 0 },
      usage: [],
    });
    failCalls = false;
    stats.flush();
    cold.restore(entries);
    expect(cold.snapshot()).toMatchObject({
      incompleteJobs: 0,
      reviews: { success: 1 },
      usage: [{ inputTokens: { value: 9, measured: 1 } }],
    });
  });

  it("retains current-process facts when custom-entry persistence fails", () => {
    const stats = new PairStats("session", () => {
      throw new Error("storage unavailable");
    });
    stats.start("job");
    stats.observe("job", call());
    stats.finish("job", "failed", 5);
    expect(stats.snapshot()).toMatchObject({
      reviews: { failed: 1 },
      persistenceFailures: 3,
      finished: 1,
    });
    expect(stats.snapshot().usage[0]?.calls).toBe(1);
  });
});
