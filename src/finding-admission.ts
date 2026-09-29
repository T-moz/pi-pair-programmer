import { createHash } from "node:crypto";
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { z } from "zod";
import {
  notify,
  observeJudgment,
  type ModelCallObserver,
} from "./model-usage.js";
import type { DedupJudgment, JudgmentObserver } from "./pair-stats.js";
import type { ProposedFinding } from "./review-runner.js";
import type { ReviewStore, Finding, StoredFinding } from "./review-store.js";

interface FindingScope {
  file: string;
  reviewer: string;
  revision: string;
}

interface AdmissionRequest extends FindingScope {
  findings: readonly ProposedFinding[];
  signal: AbortSignal;
  onModelCall?: ModelCallObserver;
  onJudgment?: JudgmentObserver;
  isCurrent: () => Promise<boolean>;
}

type Observers = Pick<
  AdmissionRequest,
  "signal" | "onModelCall" | "onJudgment"
>;
type Candidate = Finding & { duplicateKey: string };

const DUPLICATE_THRESHOLD = 0.5;
const dedupSchema = z.object({
  answers: z.object({
    duplicate: z.object({ noul: z.number().min(0).max(1) }),
  }),
});
let jevClient: TypeSafeClient | undefined;

function hash(parts: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

export function findingId(
  scope: FindingScope,
  proposed: ProposedFinding,
): string {
  return candidateOf(scope, proposed).id;
}

function candidateOf(
  request: FindingScope,
  proposed: ProposedFinding,
): Candidate {
  const duplicateKey = hash([
    request.file,
    request.reviewer,
    proposed.title.toLowerCase().trim(),
    proposed.quote.trim(),
  ]);
  const evidence = `${proposed.quote} — ${proposed.evidence}`;
  return {
    id: hash([duplicateKey, request.revision, evidence]),
    duplicateKey,
    reviewer: request.reviewer,
    file: request.file,
    revision: request.revision,
    line: proposed.line,
    title: proposed.title,
    evidence,
  };
}

function sameProblem(candidate: Candidate, finding: Finding): boolean {
  return candidate.duplicateKey === (finding.duplicateKey ?? finding.id);
}

async function judgeNovelty(
  candidate: Candidate,
  history: readonly StoredFinding[],
  earlier: readonly Candidate[],
  { signal, onModelCall }: Observers,
): Promise<DedupJudgment> {
  const priors = [...history.map(({ finding }) => finding), ...earlier];
  const matching = priors.filter((finding) => sameProblem(candidate, finding));
  const judgment = (
    decision: DedupJudgment["decision"],
    reason: DedupJudgment["reason"],
  ): DedupJudgment => ({
    stage: "dedup",
    decision,
    reason,
    findingId: candidate.id,
    duplicateKey: candidate.duplicateKey,
    line: candidate.line,
    title: candidate.title,
    history: history.map(({ finding }) => finding.id),
    candidates: earlier.map(({ id }) => id),
    sameKey: matching.map(({ id }) => id),
  });
  if (matching.some(({ evidence }) => evidence === candidate.evidence))
    return judgment("drop", "unchanged");
  if (priors.length === 0) return judgment("keep", "first");
  const fallback = matching.length === 0 ? "keep" : "drop";
  let response: unknown;
  try {
    jevClient ??= new TypeSafeClient({ logLevel: "off" });
    const client = jevClient;
    response = await observeJudgment("dedup", signal, onModelCall, () =>
      client.systemOne(
        {
          model: "jev-latest",
          state: {
            candidate: { ...candidate },
            history: history.map(({ finding, verdict, reason }) => ({
              ...finding,
              duplicateKey: finding.duplicateKey ?? finding.id,
              verdict: verdict ?? null,
              reason: reason ?? null,
            })),
            earlierCandidates: earlier.map((finding) => ({ ...finding })),
          },
          questions: {
            duplicate: noul(
              "Is the candidate the same underlying problem with unchanged evidence as any history finding or earlier candidate? Previously accepted or rejected history findings count as duplicates. A material change to the evidence after a fix is not a duplicate.",
              {
                true: "Same root problem with unchanged evidence, even if wording or line number differs",
                false: "Distinct root problem or materially changed evidence",
              },
            ),
          },
        },
        { signal, timeout: 30_000, retry: { maxRetries: 0 } },
      ),
    );
  } catch {
    return judgment(fallback, signal.aborted ? "cancelled" : "request_failed");
  }
  const parsed = dedupSchema.safeParse(response);
  if (!parsed.success) return judgment(fallback, "response_invalid");
  const score = parsed.data.answers.duplicate.noul;
  return {
    ...judgment(score < DUPLICATE_THRESHOLD ? "keep" : "drop", "judged"),
    score,
    threshold: DUPLICATE_THRESHOLD,
  };
}

async function novelFindings(
  candidates: readonly Candidate[],
  history: readonly StoredFinding[],
  compareCandidates: boolean,
  observers: Observers,
): Promise<Candidate[]> {
  const novel: Candidate[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (observers.signal.aborted) break;
    const earlier = compareCandidates ? candidates.slice(0, index) : [];
    const judgment = await judgeNovelty(candidate, history, earlier, observers);
    notify(observers.onJudgment, judgment);
    if (judgment.decision === "keep") novel.push(candidate);
  }
  return novel;
}

export class FindingAdmission {
  private readonly store: ReviewStore;

  constructor(store: ReviewStore) {
    this.store = store;
  }

  async admit(
    request: AdmissionRequest,
  ): Promise<"obsolete" | "unchanged" | "added"> {
    const { file, signal } = request;
    let history = this.store.history(file);
    let novel = await novelFindings(
      request.findings.map((finding) => candidateOf(request, finding)),
      history,
      true,
      request,
    );
    for (;;) {
      if (!(await request.isCurrent()) || signal.aborted) return "obsolete";
      const latest = this.store.history(file);
      const added = latest.slice(history.length);
      if (novel.length === 0 || added.length === 0) break;
      history = latest;
      novel = await novelFindings(novel, added, false, request);
    }
    let result: "unchanged" | "added" = "unchanged";
    for (const finding of novel) {
      if (this.store.add(finding)) result = "added";
    }
    return result;
  }
}
