import type { ReviewOutcome } from "./pair-stats.js";

export type ReviewPhase = "running" | ReviewOutcome;

export interface FeedEntry {
  id: string;
  file: string;
  model: string;
  startedAt: number;
  phase: ReviewPhase;
  durationMs?: number;
  findingIds: readonly string[];
}

const LIMIT = 100;

/** In-memory, session-scoped history of review jobs, newest first. */
export class ReviewFeed {
  private entries: FeedEntry[] = [];

  start(
    id: string,
    job: { file: string; model: string },
    now = Date.now(),
  ): void {
    this.entries.unshift({
      id,
      file: job.file,
      model: job.model.slice(job.model.lastIndexOf("/") + 1),
      startedAt: now,
      phase: "running",
      findingIds: [],
    });
    this.entries.length = Math.min(this.entries.length, LIMIT);
  }

  finish(id: string, outcome: ReviewOutcome, durationMs: number): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry?.phase !== "running") return;
    entry.phase = outcome;
    entry.durationMs = durationMs;
  }

  attach(id: string, findingIds: readonly string[]): void {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry !== undefined)
      entry.findingIds = [...new Set([...entry.findingIds, ...findingIds])];
  }

  clear(): void {
    this.entries = [];
  }

  list(): readonly FeedEntry[] {
    return this.entries;
  }
}
