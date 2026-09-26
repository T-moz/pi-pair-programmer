import { createHash } from "node:crypto";
import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { observeJudgment, type ModelCallObserver } from "./model-usage.js";
import type { ProposedFinding } from "./review-runner.js";
import type { ReviewStore, Finding, StoredFinding } from "./review-store.js";

interface AdmissionRequest {
  file: string;
  reviewer: string;
  revision: string;
  findings: readonly ProposedFinding[];
  signal: AbortSignal;
  onModelCall?: ModelCallObserver;
  isCurrent: () => Promise<boolean>;
}

type Candidate = Finding & { duplicateKey: string };

let jevClient: TypeSafeClient | undefined;

function hash(parts: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

function candidateOf(
  request: AdmissionRequest,
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

async function isNovel(
  candidate: Candidate,
  history: readonly StoredFinding[],
  earlier: readonly Candidate[],
  signal: AbortSignal,
  onModelCall: ModelCallObserver | undefined,
): Promise<boolean> {
  const matches = (finding: Finding): boolean =>
    sameProblem(candidate, finding);
  const unchanged = (finding: Finding): boolean =>
    matches(finding) && candidate.evidence === finding.evidence;
  if (
    history.some(({ finding }) => unchanged(finding)) ||
    earlier.some(unchanged)
  )
    return false;
  if (history.length === 0 && earlier.length === 0) return true;
  try {
    jevClient ??= new TypeSafeClient({ logLevel: "off" });
    const client = jevClient;
    const response = await observeJudgment("dedup", signal, onModelCall, () =>
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
    return response.answers.duplicate.noul < 0.5;
  } catch {
    return (
      history.every(({ finding }) => !matches(finding)) &&
      earlier.every((finding) => !matches(finding))
    );
  }
}

async function novelFindings(
  candidates: readonly Candidate[],
  history: readonly StoredFinding[],
  compareCandidates: boolean,
  signal: AbortSignal,
  onModelCall: ModelCallObserver | undefined,
): Promise<Candidate[]> {
  const novel: Candidate[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (signal.aborted) break;
    const earlier = compareCandidates ? candidates.slice(0, index) : [];
    if (await isNovel(candidate, history, earlier, signal, onModelCall))
      novel.push(candidate);
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
      signal,
      request.onModelCall,
    );
    for (;;) {
      if (!(await request.isCurrent()) || signal.aborted) return "obsolete";
      const latest = this.store.history(file);
      const added = latest.slice(history.length);
      if (novel.length === 0 || added.length === 0) break;
      history = latest;
      novel = await novelFindings(
        novel,
        added,
        false,
        signal,
        request.onModelCall,
      );
    }
    let result: "unchanged" | "added" = "unchanged";
    for (const finding of novel) {
      if (this.store.add(finding)) result = "added";
    }
    return result;
  }
}
