import { beforeEach, expect, it, vi } from "vitest";
import { FindingAdmission } from "../src/finding-admission.js";
import type { ProposedFinding } from "../src/review-runner.js";
import { ReviewStore, type Finding } from "../src/review-store.js";

interface JudgmentRequest {
  state: {
    candidate: Finding;
    history: (Finding & {
      verdict: "accept" | "reject" | null;
      reason: string | null;
    })[];
    earlierCandidates: Finding[];
  };
}

const systemOne = vi.hoisted(() =>
  vi.fn<
    (
      request: JudgmentRequest,
      options: { signal: AbortSignal },
    ) => Promise<unknown>
  >(),
);

vi.mock("@typesafe-ai/sdk", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  TypeSafeClient: class {
    readonly systemOne = systemOne;
  },
}));

const proposal: ProposedFinding = {
  line: 2,
  title: "Null dereference",
  quote: "user.name",
  evidence: "The user can be null at runtime",
};

function request(
  findings: readonly ProposedFinding[] = [proposal],
): Parameters<FindingAdmission["admit"]>[0] {
  return {
    file: "src/example.ts",
    reviewer: "correctness",
    revision: "revision-1",
    findings,
    signal: new AbortController().signal,
    isCurrent: () => Promise.resolve(true),
  };
}

function session(entries: unknown[] = []): {
  store: ReviewStore;
  admission: FindingAdmission;
  entries: unknown[];
} {
  const store = new ReviewStore((data) => {
    entries.push({ type: "custom", customType: "pair-programmer", data });
  }, entries);
  return { store, admission: new FindingAdmission(store), entries };
}

function readyFinding(store: ReviewStore): Finding {
  const finding = store.ready()[0];
  if (finding === undefined) throw new Error("Expected a ready finding");
  return finding;
}

const novel = { answers: { duplicate: { noul: 0.01 } } };
const duplicate = { answers: { duplicate: { noul: 0.99 } } };

beforeEach(() => {
  systemOne.mockReset();
  systemOne.mockResolvedValue(novel);
});

it.each(["accept", "reject"] as const)(
  "admits materially changed evidence after %s with independent decisions and replay",
  async (verdict) => {
    const { admission, store, entries } = session();
    await admission.admit(request());
    const first = readyFinding(store);
    store.deliver([first.id]);
    store.decide(first.id, verdict, "Original consequence reviewed");
    const changed = {
      ...proposal,
      evidence: "A new public entry point now passes null to the same access",
    };
    systemOne.mockImplementation(({ state }) =>
      Promise.resolve(
        state.history.some(
          (finding) => finding.verdict === verdict && finding.reason !== null,
        )
          ? novel
          : duplicate,
      ),
    );
    expect(
      await admission.admit({ ...request([changed]), revision: "revision-2" }),
    ).toBe("added");
    const second = readyFinding(store);
    expect(second.id).not.toBe(first.id);
    store.deliver([second.id]);
    expect(store.decide(second.id, "accept", "New consequence confirmed")).toBe(
      true,
    );
    const restored = session(entries);
    expect(restored.store.history("src/example.ts")).toEqual([
      { finding: first, verdict, reason: "Original consequence reviewed" },
      {
        finding: second,
        verdict: "accept",
        reason: "New consequence confirmed",
      },
    ]);
    expect(restored.store.outstanding()).toEqual([]);
    expect(restored.store.ready()).toEqual([]);
    expect(
      await restored.admission.admit({
        ...request([changed]),
        revision: "revision-3",
      }),
    ).toBe("unchanged");
    expect(restored.store.ready()).toEqual([]);
  },
);

it("suppresses repeated evidence across revisions, lines, and a Jev outage", async () => {
  const { admission, store } = session();
  await admission.admit(request());
  const first = readyFinding(store);
  store.deliver([first.id]);
  store.decide(first.id, "reject", "Known false positive");
  systemOne.mockRejectedValue(new Error("Jev unavailable"));
  expect(
    await admission.admit({
      ...request([{ ...proposal, line: 20, title: " NULL DEREFERENCE " }]),
      revision: "revision-2",
    }),
  ).toBe("unchanged");
  expect(
    await admission.admit({
      ...request([{ ...proposal, evidence: "Reworded nullable access" }]),
      revision: "revision-3",
    }),
  ).toBe("unchanged");
  expect(systemOne).toHaveBeenCalledOnce();
  expect(store.ready()).toEqual([]);
  expect(store.history("src/example.ts")).toEqual([
    { finding: first, verdict: "reject", reason: "Known false positive" },
  ]);
});

it("keeps distinct findings during an outage while filtering duplicates within the same batch", async () => {
  const { admission, store } = session();
  systemOne.mockRejectedValue(new Error("Jev unavailable"));
  const other = { ...proposal, title: "Missing timeout", quote: "fetch(url)" };
  await admission.admit(
    request([
      proposal,
      { ...proposal },
      { ...proposal, evidence: "A reworded description" },
      other,
    ]),
  );
  expect(store.ready().map(({ title }) => title)).toEqual([
    proposal.title,
    other.title,
  ]);
});

it("requires semantic novelty for changed evidence within a batch and suppresses paraphrased duplicates", async () => {
  const { admission, store } = session();
  const changed = { ...proposal, evidence: "Another caller newly passes null" };
  const paraphrased = { ...proposal, title: "Unchecked nullable user" };
  systemOne.mockImplementation(({ state }) =>
    Promise.resolve(
      state.candidate.title === proposal.title ? novel : duplicate,
    ),
  );
  await admission.admit(request([proposal, changed, paraphrased]));
  expect(store.ready().map(({ evidence }) => evidence)).toEqual([
    `${proposal.quote} — ${proposal.evidence}`,
    `${changed.quote} — ${changed.evidence}`,
  ]);
});

it("retains legacy decisions and duplicate identity without rewriting historical entries", async () => {
  const legacy: Finding = {
    id: "f9b16cde9436291a",
    reviewer: "correctness",
    file: "src/example.ts",
    revision: "old-revision",
    line: 2,
    title: proposal.title,
    evidence: `${proposal.quote} — ${proposal.evidence}`,
  };
  const events = [
    { action: "add", finding: legacy },
    { action: "deliver", ids: [legacy.id] },
    {
      action: "decide",
      id: legacy.id,
      verdict: "accept",
      reason: "Fixed original bug",
    },
  ];
  const entries = events.map((data) => ({
    type: "custom",
    customType: "pair-programmer",
    data,
  }));
  const { admission, store } = session(entries);
  systemOne.mockRejectedValueOnce(new Error("Jev unavailable"));
  const changed = { ...proposal, evidence: "New caller triggers this access" };
  expect(await admission.admit(request([changed]))).toBe("unchanged");
  expect(entries.map(({ data }) => data)).toEqual(events);
  expect(await admission.admit(request([changed]))).toBe("added");
  const second = readyFinding(store);
  expect(second.id).not.toBe(legacy.id);
  expect(store.history(legacy.file)[0]).toEqual({
    finding: legacy,
    verdict: "accept",
    reason: "Fixed original bug",
  });
  expect(session(entries).store.ready()).toEqual([second]);
});

it("rechecks concurrent equivalent findings and never serializes unrelated files", async () => {
  const { admission, store } = session();
  const firstCheck = Promise.withResolvers<boolean>();
  const secondCheck = Promise.withResolvers<boolean>();
  const pendingFirst = admission.admit({
    ...request(),
    isCurrent: () => firstCheck.promise,
  });
  const pendingSecond = admission.admit({
    ...request([{ ...proposal, title: "Unchecked nullable user" }]),
    reviewer: "risks",
    isCurrent: () => secondCheck.promise,
  });
  expect(await admission.admit({ ...request(), file: "src/other.ts" })).toBe(
    "added",
  );
  firstCheck.resolve(true);
  expect(await pendingFirst).toBe("added");
  systemOne.mockResolvedValue(duplicate);
  secondCheck.resolve(true);
  expect(await pendingSecond).toBe("unchanged");
  expect(store.ready().map(({ file, title }) => ({ file, title }))).toEqual([
    { file: "src/other.ts", title: proposal.title },
    { file: "src/example.ts", title: proposal.title },
  ]);
});

it("keeps multiple distinct candidates after another review commits during judgment", async () => {
  const { admission, store } = session();
  const check = Promise.withResolvers<boolean>();
  const changed = { ...proposal, title: "Missing guard" };
  const pending = admission.admit({
    ...request([proposal, changed]),
    isCurrent: () => check.promise,
  });
  await admission.admit(request([{ ...proposal, title: "Missing timeout" }]));
  check.resolve(true);
  expect(await pending).toBe("added");
  expect(store.ready().map(({ title }) => title)).toEqual([
    "Missing timeout",
    proposal.title,
    changed.title,
  ]);
});

it.each(["obsolete", "abort", "disabled"] as const)(
  "does not append after a pending judgment becomes %s",
  async (change) => {
    const { admission, store, entries } = session();
    await admission.admit(request());
    const judgment = Promise.withResolvers<unknown>();
    systemOne.mockReturnValueOnce(judgment.promise);
    const controller = new AbortController();
    let current = true;
    const pending = admission.admit({
      ...request([{ ...proposal, evidence: "New consequence" }]),
      signal: controller.signal,
      isCurrent: () => Promise.resolve(current),
    });
    if (change === "obsolete") current = false;
    else if (change === "abort") controller.abort();
    else store.setEnabled(false);
    const previous = [...entries];
    judgment.resolve(novel);
    expect(await pending).toBe(
      change === "disabled" ? "unchanged" : "obsolete",
    );
    expect(entries).toEqual(previous);
  },
);

it("does not persist candidates after a judgment aborts and ignores already-aborted requests", async () => {
  const { admission, store } = session();
  await admission.admit(request());
  const first = readyFinding(store);
  const controller = new AbortController();
  systemOne.mockImplementationOnce((_request, { signal }) => {
    const { promise, reject } = Promise.withResolvers<unknown>();
    signal.addEventListener(
      "abort",
      () => {
        reject(new Error("cancelled"));
      },
      { once: true },
    );
    return promise;
  });
  const pending = admission.admit({
    ...request([
      { ...proposal, title: "New problem" },
      { ...proposal, title: "Another problem" },
    ]),
    signal: controller.signal,
  });
  controller.abort();
  expect(await pending).toBe("obsolete");
  expect(
    await admission.admit({ ...request(), signal: controller.signal }),
  ).toBe("obsolete");
  expect(store.ready()).toEqual([first]);
});

it("leaves the queue unchanged when no findings survive review", async () => {
  const { admission, store, entries } = session();
  expect(await admission.admit(request([]))).toBe("unchanged");
  expect(store.ready()).toEqual([]);
  expect(entries).toEqual([]);
});

it("accounts only real dedup calls and keeps deterministic duplicate fast paths silent", async () => {
  const { admission, store } = session();
  const onModelCall = vi.fn();
  await expect(admission.admit({ ...request(), onModelCall })).resolves.toBe(
    "added",
  );
  await expect(admission.admit({ ...request(), onModelCall })).resolves.toBe(
    "unchanged",
  );
  expect(onModelCall).not.toHaveBeenCalled();
  systemOne.mockResolvedValueOnce({
    ...novel,
    model: "jev-actual",
    usage: { input_tokens: 200, output_tokens: 0 },
  });
  await expect(
    admission.admit({
      ...request([{ ...proposal, title: "Other defect" }]),
      onModelCall,
    }),
  ).resolves.toBe("added");
  expect(store.ready().map(({ title }) => title)).toEqual([
    proposal.title,
    "Other defect",
  ]);
  expect(onModelCall).toHaveBeenCalledExactlyOnceWith({
    stage: "dedup",
    requestedModel: "jev-latest",
    model: "jev-actual",
    outcome: "success",
    durationMs: expect.any(Number) as unknown,
    usage: { inputTokens: 200, outputTokens: 0 },
  });
});

it("preserves deterministic fail-open decisions while recording unavailable judge usage", async () => {
  const { admission, store } = session();
  await admission.admit(request());
  const onModelCall = vi.fn();
  systemOne.mockRejectedValue(new Error("private provider outage"));
  await expect(
    admission.admit({
      ...request([{ ...proposal, evidence: "Changed wording" }]),
      onModelCall,
    }),
  ).resolves.toBe("unchanged");
  await expect(
    admission.admit({
      ...request([{ ...proposal, title: "Distinct defect" }]),
      onModelCall,
    }),
  ).resolves.toBe("added");
  expect(store.ready().map(({ title }) => title)).toEqual([
    proposal.title,
    "Distinct defect",
  ]);
  expect(onModelCall.mock.calls).toEqual(
    Array.from({ length: 2 }, () => [
      {
        stage: "dedup",
        requestedModel: "jev-latest",
        outcome: "failed",
        durationMs: expect.any(Number) as unknown,
      },
    ]),
  );
});

it("does not let an accounting exception alter a semantic duplicate decision", async () => {
  const { admission, store } = session();
  await admission.admit(request());
  const original = readyFinding(store);
  systemOne.mockResolvedValueOnce(duplicate);
  await expect(
    admission.admit({
      ...request([{ ...proposal, title: "Reworded defect" }]),
      onModelCall: () => {
        throw new Error("journal offline");
      },
    }),
  ).resolves.toBe("unchanged");
  expect(store.ready()).toEqual([original]);
});

it("records one cancelled dedup call without admitting its findings", async () => {
  const { admission, store } = session();
  await admission.admit(request());
  const original = readyFinding(store);
  const controller = new AbortController();
  const onModelCall = vi.fn();
  systemOne.mockImplementationOnce((_input, { signal }) => {
    const { promise, reject } = Promise.withResolvers<unknown>();
    signal.addEventListener(
      "abort",
      () => {
        reject(new Error("cancelled"));
      },
      { once: true },
    );
    return promise;
  });
  const pending = admission.admit({
    ...request([{ ...proposal, title: "Distinct defect" }]),
    signal: controller.signal,
    onModelCall,
  });
  controller.abort();
  await expect(pending).resolves.toBe("obsolete");
  expect(store.ready()).toEqual([original]);
  expect(onModelCall).toHaveBeenCalledExactlyOnceWith({
    stage: "dedup",
    requestedModel: "jev-latest",
    outcome: "cancelled",
    durationMs: expect.any(Number) as unknown,
  });
});

it("propagates journal failure without making an unrecorded finding deliverable", async () => {
  const store = new ReviewStore(() => {
    throw new Error("Journal unavailable");
  });
  const admission = new FindingAdmission(store);
  await expect(admission.admit(request())).rejects.toThrow(
    "Journal unavailable",
  );
  expect(store.ready()).toEqual([]);
});
