import { describe, expect, it } from "vitest";
import { ReviewStore, type Finding } from "../src/review-store.js";

const finding = (id: string, file = "src/a.ts", revision = "one"): Finding => ({
  id,
  reviewer: "logic",
  file,
  revision,
  line: 12,
  title: `Issue ${id}`,
  evidence: `Evidence ${id}`,
});

function session(): {
  entries: unknown[];
  append: (data: unknown) => void;
  store: ReviewStore;
} {
  const entries: unknown[] = [];
  const append = (data: unknown): void => {
    entries.push({ type: "custom", customType: "pair-programmer", data });
  };
  return { entries, append, store: new ReviewStore(append) };
}

describe("ReviewStore", () => {
  it.each([true, false])(
    "clears finding history durably while preserving enabled=%s",
    (enabled) => {
      const { store, entries, append } = session();
      store.add(finding("pending"));
      store.add(finding("waiting"));
      store.add(finding("accepted"));
      store.deliver(["waiting", "accepted"]);
      store.decide("accepted", "accept", "Confirmed");
      store.setEnabled(enabled);
      store.clear();

      for (const current of [store, new ReviewStore(append, entries)]) {
        expect(current.enabled).toBe(enabled);
        expect(current.ready()).toEqual([]);
        expect(current.outstanding()).toEqual([]);
        expect(current.history("src/a.ts")).toEqual([]);
        expect(current.decide("waiting", "accept", "Too late")).toBe(false);
      }
      const restored = new ReviewStore(append, entries);
      restored.setEnabled(true);
      expect(restored.add(finding("accepted"))).toBe(true);
      expect(new ReviewStore(append, entries).ready()).toEqual([
        finding("accepted"),
      ]);
    },
  );

  it("restores only post-clear findings while preserving settings and earlier branches", () => {
    const { store, entries, append } = session();
    store.add(finding("waiting"));
    store.deliver(["waiting"]);
    store.add(finding("pending"));
    store.setEnabled(false);
    const beforeClear = [...entries];
    entries.push({ type: "reset_boundary" });
    const restored = new ReviewStore(append, entries);
    expect(restored.enabled).toBe(false);
    expect(restored.outstanding()).toEqual([]);
    expect(restored.history("src/a.ts")).toEqual([]);
    expect(new ReviewStore(append, beforeClear).outstanding()).toEqual([
      finding("waiting"),
    ]);
    restored.setEnabled(true);
    restored.add(finding("after-clear"));
    const reloaded = new ReviewStore(append, entries);
    expect(reloaded.ready()).toEqual([finding("after-clear")]);
    expect(reloaded.outstanding()).toEqual([]);
    expect(reloaded.history("src/a.ts")).toEqual([
      { finding: finding("after-clear") },
    ]);
  });

  it("derives mutually exclusive finding outcomes from the selected branch", () => {
    const { store, entries, append } = session();
    for (const id of [
      "pending",
      "waiting",
      "accepted",
      "rejected",
      "discarded",
    ])
      store.add(finding(id, `${id}.ts`));
    store.deliver(["waiting", "accepted", "rejected"]);
    const branchPoint = [...entries];
    store.decide("accepted", "accept", "Confirmed");
    store.decide("rejected", "reject", "Expected behavior");
    store.discardStale("discarded.ts", "new-revision");
    expect(store.summary()).toEqual({
      pending: 1,
      outstanding: 1,
      accepted: 1,
      rejected: 1,
      discarded: 1,
    });
    const branched = new ReviewStore(append, branchPoint);
    expect(branched.summary()).toEqual({
      pending: 2,
      outstanding: 3,
      accepted: 0,
      rejected: 0,
      discarded: 0,
    });
    branched.setEnabled(false);
    expect(branched.summary()).toEqual({
      pending: 0,
      outstanding: 3,
      accepted: 0,
      rejected: 0,
      discarded: 2,
    });
  });

  it("queues findings, delivers only selected ids, and preserves decisions in history", () => {
    const { store, entries } = session();
    const first = finding("first");
    const second = finding("second", "src/b.ts");

    expect(store.enabled).toBe(true);
    expect(store.add(first)).toBe(true);
    expect(store.add(second)).toBe(true);
    expect(store.add(finding("first", "src/other.ts"))).toBe(false);
    expect(store.ready()).toEqual([first, second]);
    expect(store.outstanding()).toEqual([]);
    expect(store.decide("first", "accept", "Agreed")).toBe(false);

    store.deliver(["first", "missing", "first"]);
    expect(store.ready()).toEqual([second]);
    expect(store.outstanding()).toEqual([first]);
    expect(store.decide("first", "accept", "Needs a guard")).toBe(true);
    expect(store.decide("first", "reject", "Changed my mind")).toBe(false);
    expect(store.outstanding()).toEqual([]);
    const replayed = new ReviewStore(() => {
      throw new Error("Replay must not append");
    }, entries);
    expect(replayed.ready()).toEqual([second]);
    expect(replayed.outstanding()).toEqual([]);
    expect(replayed.history("src/a.ts")).toEqual([
      { finding: first, verdict: "accept", reason: "Needs a guard" },
    ]);
    expect(replayed.history("src/b.ts")).toEqual([{ finding: second }]);
  });

  it("requires a reason for each delivered finding and rejects unknown ids", () => {
    const { store } = session();
    const first = finding("first");
    const second = finding("second");
    store.add(first);
    store.add(second);
    store.deliver(["first", "second"]);

    expect(store.decide("missing", "reject", "Explained")).toBe(false);
    expect(store.decide("first", "reject", " \t ")).toBe(false);
    expect(store.outstanding()).toEqual([first, second]);
    expect(store.decide("first", "reject", "Not reproducible")).toBe(true);
    expect(store.outstanding()).toEqual([second]);
    expect(store.decide("second", "accept", "Confirmed in production")).toBe(
      true,
    );
    expect(store.outstanding()).toEqual([]);
    expect(store.history("src/a.ts")).toEqual([
      { finding: first, verdict: "reject", reason: "Not reproducible" },
      { finding: second, verdict: "accept", reason: "Confirmed in production" },
    ]);
  });

  it("disables the queue without clearing delivered findings and does not resurrect discarded ids", () => {
    const { store, entries } = session();
    const delivered = finding("delivered");
    const pending = finding("pending");
    store.add(delivered);
    store.add(pending);
    store.deliver(["delivered"]);
    store.setEnabled(false);

    expect(store.enabled).toBe(false);
    expect(store.ready()).toEqual([]);
    expect(store.outstanding()).toEqual([delivered]);
    expect(store.add(finding("new"))).toBe(false);
    expect(store.decide("delivered", "reject", "False alarm")).toBe(true);
    store.setEnabled(true);
    expect(store.enabled).toBe(true);
    expect(store.ready()).toEqual([]);
    expect(store.add(pending)).toBe(false);
    const replayed = new ReviewStore(() => {
      throw new Error("Replay must not append");
    }, entries);
    expect(replayed.enabled).toBe(true);
    expect(replayed.ready()).toEqual([]);
    expect(replayed.outstanding()).toEqual([]);
    expect(replayed.add(pending)).toBe(false);
    expect(replayed.history("src/a.ts")).toEqual([
      { finding: delivered, verdict: "reject", reason: "False alarm" },
      { finding: pending },
    ]);
  });

  it("discards only stale undelivered findings for the requested file", () => {
    const { store, entries } = session();
    const stale = finding("stale");
    const outstanding = finding("outstanding");
    const current = finding("current", "src/a.ts", "two");
    const otherFile = finding("other", "src/b.ts");
    for (const item of [stale, outstanding, current, otherFile])
      store.add(item);
    store.deliver(["outstanding"]);
    store.discardStale("src/a.ts", "two");

    expect(store.ready()).toEqual([current, otherFile]);
    expect(store.outstanding()).toEqual([outstanding]);
    expect(store.history("src/a.ts")).toEqual([
      { finding: stale },
      { finding: outstanding },
      { finding: current },
    ]);
    store.discardStale("src/a.ts", "two");
    expect(store.add(stale)).toBe(false);

    const restored = new ReviewStore(() => {
      throw new Error("Replay must not append");
    }, entries);
    expect(restored.ready()).toEqual([current, otherFile]);
    expect(restored.outstanding()).toEqual([outstanding]);
  });

  it("replays delivery and decisions across revisions, including outstanding while disabled", () => {
    const { store, entries, append } = session();
    const accepted = finding("accepted");
    const waiting = finding("waiting", "src/a.ts", "two");
    const dropped = finding("dropped", "src/a.ts", "one");
    store.add(accepted);
    store.deliver(["accepted"]);
    store.decide("accepted", "accept", "Useful fix");
    store.add(waiting);
    store.deliver(["waiting"]);
    store.add(dropped);
    store.setEnabled(false);

    const restored = new ReviewStore(append, entries);
    expect(restored.enabled).toBe(false);
    expect(restored.outstanding()).toEqual([waiting]);
    expect(restored.history("src/a.ts")).toEqual([
      { finding: accepted, verdict: "accept", reason: "Useful fix" },
      { finding: waiting },
      { finding: dropped },
    ]);
    restored.setEnabled(true);
    expect(restored.ready()).toEqual([]);
    expect(restored.add(dropped)).toBe(false);
    const fresh = finding("fresh", "src/a.ts", "three");
    expect(restored.add(fresh)).toBe(true);
    expect(restored.ready()).toEqual([fresh]);
    expect(restored.decide("waiting", "reject", "Covered elsewhere")).toBe(
      true,
    );

    const again = new ReviewStore(append, entries);
    expect(again.ready()).toEqual([fresh]);
    expect(again.outstanding()).toEqual([]);
    expect(again.history("src/a.ts")[1]).toEqual({
      finding: waiting,
      verdict: "reject",
      reason: "Covered elsewhere",
    });
  });

  it("replays only events on the selected branch without reviving discarded findings", () => {
    const { store, entries, append } = session();
    const shared = finding("shared");
    const firstBranch = finding("first-branch");
    const secondBranch = finding("second-branch");
    store.add(shared);
    store.deliver(["shared"]);
    store.decide("shared", "reject", "Expected behavior");
    const branchPoint = [...entries];
    store.add(firstBranch);
    store.deliver(["first-branch"]);
    store.decide("first-branch", "accept", "Fix confirmed");

    const branched = new ReviewStore(append, branchPoint);
    branched.add(secondBranch);
    branched.setEnabled(false);
    branched.setEnabled(true);
    branched.deliver(["second-branch"]);
    expect(branched.add(secondBranch)).toBe(false);
    expect(branched.ready()).toEqual([]);
    expect(branched.history("src/a.ts")).toEqual([
      { finding: shared, verdict: "reject", reason: "Expected behavior" },
      { finding: secondBranch },
    ]);
    expect(store.history("src/a.ts")).toEqual([
      { finding: shared, verdict: "reject", reason: "Expected behavior" },
      { finding: firstBranch, verdict: "accept", reason: "Fix confirmed" },
    ]);
  });

  it("does not revive duplicates, discarded findings or deliveries recorded while off", () => {
    const saved = finding("saved");
    const discarded = finding("discarded");
    const fresh = finding("fresh");
    const whileOff = finding("while-off");
    const entry = (data: unknown): unknown => ({
      type: "custom",
      customType: "pair-programmer",
      data,
    });
    const branch = [
      entry({ action: "add", finding: saved }),
      entry({
        action: "add",
        finding: { ...saved, title: "Changed on replay" },
      }),
      entry({ action: "deliver", ids: ["saved", "missing"] }),
      entry({ action: "discard", ids: ["saved", "missing"] }),
      entry({
        action: "decide",
        id: "saved",
        verdict: "reject",
        reason: "Already addressed",
      }),
      entry({
        action: "decide",
        id: "saved",
        verdict: "accept",
        reason: "Contradiction",
      }),
      entry({ action: "add", finding: discarded }),
      entry({ action: "discard", ids: ["discarded"] }),
      entry({ action: "deliver", ids: ["discarded"] }),
      entry({ action: "add", finding: discarded }),
      entry({ action: "enabled", enabled: false }),
      entry({ action: "add", finding: whileOff }),
      entry({ action: "deliver", ids: ["discarded"] }),
      entry({ action: "enabled", enabled: true }),
      entry({ action: "add", finding: fresh }),
    ];
    const resumedBranch = [...branch];
    const store = new ReviewStore((data) => {
      resumedBranch.push(entry(data));
    }, branch);
    expect(store.ready()).toEqual([fresh]);
    expect(store.outstanding()).toEqual([]);
    expect(store.history("src/a.ts")).toEqual([
      { finding: saved, verdict: "reject", reason: "Already addressed" },
      { finding: discarded },
      { finding: fresh },
    ]);
    expect(store.add(whileOff)).toBe(true);
    store.setEnabled(true);
    const replayed = new ReviewStore(() => {
      throw new Error("Replay must not append");
    }, resumedBranch);
    expect(replayed.ready()).toEqual([fresh, whileOff]);
  });

  it("ignores unrelated and malformed historical entries without losing following events", () => {
    const first = finding("first");
    const later = finding("later");
    const entries: unknown[] = [
      null,
      {
        type: "custom",
        customType: "pair-programmer",
        data: { action: "unknown", finding: first },
      },
      {
        type: "custom",
        customType: "pair-programmer",
        data: { action: "enabled", enabled: "false" },
      },
      {
        type: "custom",
        customType: "other",
        data: { action: "add", finding: first },
      },
      {
        type: "message",
        customType: "pair-programmer",
        data: { action: "add", finding: first },
      },
      {
        type: "custom",
        customType: "pair-programmer",
        data: { action: "add", finding: { ...first, line: "bad" } },
      },
      {
        type: "custom",
        customType: "pair-programmer",
        data: { action: "add", finding: first },
      },
      {
        type: "custom",
        customType: "pair-programmer",
        data: {
          action: "decide",
          id: "first",
          verdict: "reject",
          reason: "premature",
        },
      },
      {
        type: "custom",
        customType: "pair-programmer",
        data: { action: "deliver", ids: ["first", 1] },
      },
      {
        type: "custom",
        customType: "pair-programmer",
        data: { action: "deliver", ids: ["first"] },
      },
      {
        type: "custom",
        customType: "pair-programmer",
        data: {
          action: "decide",
          id: "first",
          verdict: "accept",
          reason: "  ",
        },
      },
      {
        type: "custom",
        customType: "pair-programmer",
        data: { action: "decide", id: "first", verdict: "accept" },
      },
      {
        type: "custom",
        customType: "pair-programmer",
        data: {
          action: "decide",
          id: "first",
          verdict: "reject",
          reason: "Incorrect",
        },
      },
      {
        type: "custom",
        customType: "pair-programmer",
        data: { action: "add", finding: later },
      },
    ];
    const store = new ReviewStore(() => {
      throw new Error("Replay must not append");
    }, entries);
    expect(store.ready()).toEqual([later]);
    expect(store.outstanding()).toEqual([]);
    expect(store.history("src/a.ts")).toEqual([
      { finding: first, verdict: "reject", reason: "Incorrect" },
      { finding: later },
    ]);
  });
});
