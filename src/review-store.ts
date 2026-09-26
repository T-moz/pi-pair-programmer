import { z } from "zod";

const FindingSchema = z.object({
  id: z.string(),
  duplicateKey: z.string().optional(),
  reviewer: z.string(),
  file: z.string(),
  revision: z.string(),
  line: z.number(),
  title: z.string(),
  evidence: z.string(),
});

const VerdictSchema = z.enum(["accept", "reject"]);
const EventSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), finding: FindingSchema }),
  z.object({ action: z.literal("deliver"), ids: z.array(z.string()) }),
  z.object({
    action: z.literal("decide"),
    id: z.string(),
    verdict: VerdictSchema,
    reason: z.string().refine((reason) => reason.trim().length > 0),
  }),
  z.object({ action: z.literal("discard"), ids: z.array(z.string()) }),
  z.object({ action: z.literal("enabled"), enabled: z.boolean() }),
  z.object({ action: z.literal("clear") }),
]);
const EntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("custom"),
    customType: z.literal("pair-programmer"),
    data: EventSchema,
  }),
  z.object({ type: z.literal("reset_boundary") }),
]);

export type Finding = z.infer<typeof FindingSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
type Event = z.infer<typeof EventSchema>;

export interface StoredFinding {
  finding: Finding;
  verdict?: Verdict;
  reason?: string;
}

interface FindingState extends StoredFinding {
  delivered: boolean;
  discarded: boolean;
}

export class ReviewStore {
  private readonly findings = new Map<string, FindingState>();
  private readonly append: (data: unknown) => void;
  private active = true;

  constructor(
    append: (data: unknown) => void,
    branchEntries: readonly unknown[] = [],
  ) {
    this.append = append;
    for (const entry of branchEntries) {
      const parsed = EntrySchema.safeParse(entry);
      if (!parsed.success) continue;
      if (parsed.data.type === "reset_boundary") this.findings.clear();
      else this.apply(parsed.data.data);
    }
  }

  get enabled(): boolean {
    return this.active;
  }

  summary(): {
    pending: number;
    outstanding: number;
    accepted: number;
    rejected: number;
    discarded: number;
  } {
    const counts = {
      pending: 0,
      outstanding: 0,
      accepted: 0,
      rejected: 0,
      discarded: 0,
    };
    for (const state of this.findings.values()) {
      if (state.verdict === "accept") counts.accepted += 1;
      else if (state.verdict === "reject") counts.rejected += 1;
      else if (state.discarded) counts.discarded += 1;
      else if (state.delivered) counts.outstanding += 1;
      else counts.pending += 1;
    }
    return counts;
  }

  clear(): void {
    this.record({ action: "clear" });
  }

  setEnabled(enabled: boolean): void {
    if (this.active === enabled) return;
    if (!enabled) {
      const ids: string[] = [];
      for (const state of this.findings.values()) {
        if (!state.delivered && !state.discarded) ids.push(state.finding.id);
      }
      if (ids.length > 0) this.record({ action: "discard", ids });
    }
    this.record({ action: "enabled", enabled });
  }

  history(file: string): readonly StoredFinding[] {
    const result: StoredFinding[] = [];
    for (const state of this.findings.values()) {
      if (state.finding.file !== file) continue;
      result.push({
        finding: { ...state.finding },
        ...(state.verdict === undefined ? {} : { verdict: state.verdict }),
        ...(state.reason === undefined ? {} : { reason: state.reason }),
      });
    }
    return result;
  }

  add(finding: Finding): boolean {
    if (!this.active || this.findings.has(finding.id)) return false;
    this.record({ action: "add", finding: { ...finding } });
    return true;
  }

  ready(): readonly Finding[] {
    if (!this.active) return [];
    const result: Finding[] = [];
    for (const state of this.findings.values()) {
      if (!state.delivered && !state.discarded)
        result.push({ ...state.finding });
    }
    return result;
  }

  deliver(ids: readonly string[]): void {
    const eligible = [...new Set(ids)].filter((id) => {
      const state = this.findings.get(id);
      return (
        this.active &&
        state !== undefined &&
        !state.delivered &&
        !state.discarded
      );
    });
    if (eligible.length > 0) this.record({ action: "deliver", ids: eligible });
  }

  outstanding(): readonly Finding[] {
    const result: Finding[] = [];
    for (const state of this.findings.values()) {
      if (state.delivered && state.verdict === undefined) {
        result.push({ ...state.finding });
      }
    }
    return result;
  }

  deliveredFinding(id: string): Finding | undefined {
    const state = this.findings.get(id);
    return state?.delivered === true && state.verdict === undefined
      ? { ...state.finding }
      : undefined;
  }

  decide(id: string, verdict: Verdict, reason: string): boolean {
    const state = this.findings.get(id);
    if (
      state?.delivered !== true ||
      state.verdict !== undefined ||
      reason.trim().length === 0
    ) {
      return false;
    }
    this.record({ action: "decide", id, verdict, reason });
    return true;
  }

  discardStale(file: string, currentRevision: string): void {
    const ids: string[] = [];
    for (const state of this.findings.values()) {
      if (
        state.finding.file === file &&
        state.finding.revision !== currentRevision &&
        !state.delivered &&
        !state.discarded
      ) {
        ids.push(state.finding.id);
      }
    }
    if (ids.length > 0) this.record({ action: "discard", ids });
  }

  private record(event: Event): void {
    this.append(event);
    this.apply(event);
  }

  private apply(event: Event): void {
    switch (event.action) {
      case "add":
        this.applyAdd(event.finding);
        break;
      case "deliver":
        this.applyDelivery(event.ids);
        break;
      case "decide":
        this.applyDecision(event.id, event.verdict, event.reason);
        break;
      case "discard":
        this.applyDiscard(event.ids);
        break;
      case "enabled":
        this.applyEnabled(event.enabled);
        break;
      case "clear":
        this.findings.clear();
        break;
    }
  }

  private applyAdd(finding: Finding): void {
    if (!this.active || this.findings.has(finding.id)) return;
    this.findings.set(finding.id, {
      finding: { ...finding },
      delivered: false,
      discarded: false,
    });
  }

  private applyDelivery(ids: readonly string[]): void {
    if (!this.active) return;
    for (const id of ids) {
      const state = this.findings.get(id);
      if (state !== undefined && !state.discarded) state.delivered = true;
    }
  }

  private applyDecision(id: string, verdict: Verdict, reason: string): void {
    const state = this.findings.get(id);
    if (state?.delivered !== true || state.verdict !== undefined) return;
    state.verdict = verdict;
    state.reason = reason;
  }

  private applyDiscard(ids: readonly string[]): void {
    for (const id of ids) {
      const state = this.findings.get(id);
      if (state !== undefined && !state.delivered) state.discarded = true;
    }
  }

  private applyEnabled(enabled: boolean): void {
    this.active = enabled;
    if (!enabled) {
      for (const state of this.findings.values()) {
        if (!state.delivered) state.discarded = true;
      }
    }
  }
}
