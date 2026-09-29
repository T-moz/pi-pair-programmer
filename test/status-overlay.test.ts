import { describe, expect, it } from "vitest";
import { StatusOverlay } from "../src/status-overlay.js";
import { fakeHost, flush, openCapturing } from "./fake-host.js";

const colored = {
  fg: (color: string, text: string) => `<${color}>${text}`,
  bold: (text: string) => text,
};

describe("StatusOverlay", () => {
  it("pins a non-capturing badge to the top-right and updates in place", async () => {
    const tui = fakeHost({ theme: colored });
    const overlay = new StatusOverlay();
    overlay.show(tui.ctx, { tone: "success", text: "watching" });
    await flush();
    const badge = tui.top();
    expect(badge?.options).toMatchObject({
      anchor: "top-right",
      width: 19,
      nonCapturing: true,
    });
    expect(badge?.options?.visible?.(39, 20)).toBe(false);
    expect(badge?.options?.visible?.(40, 20)).toBe(true);
    expect(tui.render(badge, 80)).toEqual([
      " <success>◆ <muted>pair · watching ",
    ]);
    overlay.show(tui.event(), {
      tone: "warning",
      text: "2 awaiting decision",
    });
    expect(tui.custom).toHaveBeenCalledTimes(1);
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
    expect(tui.render(badge, 80)[0]).toContain("<warning>◆");
    expect(tui.render(badge, 5)[0]).toContain("…");
    expect(tui.setWidget).not.toHaveBeenCalledWith(
      "pair-programmer",
      expect.anything(),
    );
    overlay.dispose();
    expect(tui.stack).toEqual([]);
    badge?.component.invalidate();
  });

  it("never dismisses another overlay or remounts for fresh event contexts", async () => {
    const tui = fakeHost();
    const overlay = new StatusOverlay();
    overlay.show(tui.ctx, { tone: "success", text: "watching" });
    await flush();
    const badge = tui.top();
    const stats = openCapturing(tui);
    await flush();
    overlay.show(tui.event(), { tone: "accent", text: "reviewing · 1" });
    await flush();
    expect(tui.custom).toHaveBeenCalledTimes(2);
    expect(tui.stack).toHaveLength(2);
    overlay.dispose();
    await flush();
    expect(tui.stack.map((entry) => tui.render(entry, 40))).toEqual([
      ["stats"],
    ]);
    expect(stats.closed()).toBe(false);
    stats.close();
    await flush();
    expect(stats.closed()).toBe(true);
    expect(badge?.settled).toBe(false);
  });

  it("closes a badge disposed before the host mounts it", async () => {
    const tui = fakeHost();
    tui.defer();
    const overlay = new StatusOverlay();
    overlay.show(tui.ctx, { tone: "dim", text: "paused" });
    overlay.dispose();
    const stats = openCapturing(tui);
    tui.release();
    await flush();
    await flush();
    expect(tui.stack.map((entry) => tui.render(entry, 40))).toEqual([
      ["stats"],
    ]);
    expect(stats.closed()).toBe(false);
  });

  it("closes through done() on hosts that provide no overlay handle", async () => {
    const tui = fakeHost({ handles: false });
    const overlay = new StatusOverlay();
    overlay.show(tui.ctx, { tone: "dim", text: "paused" });
    await flush();
    expect(tui.stack).toHaveLength(1);
    overlay.dispose();
    await flush();
    expect(tui.stack).toEqual([]);
    expect(tui.setWidget).not.toHaveBeenCalledWith(
      "pair-programmer",
      expect.anything(),
    );
  });

  it.each([
    { host: "pi", mode: "rpc" },
    { host: "pi", mode: "print" },
    // OMP reports "tui" but ignores nonCapturing, so a badge would eat typing.
    { host: "omp", mode: "tui" },
  ] as const)(
    "uses a widget line on $host in $mode mode without mounting an overlay",
    ({ host, mode }) => {
      const tui = fakeHost({ host, mode });
      const overlay = new StatusOverlay();
      overlay.show(tui.ctx, { tone: "dim", text: "paused" });
      expect(tui.custom).not.toHaveBeenCalled();
      expect(tui.setWidget).toHaveBeenLastCalledWith("pair-programmer", [
        "◆ pair · paused",
      ]);
      Object.assign(tui.ctx.ui, { theme: colored });
      overlay.show(tui.event(), { tone: "accent", text: "1 queued" });
      expect(tui.setWidget).toHaveBeenLastCalledWith("pair-programmer", [
        "<accent>◆ <muted>pair · 1 queued",
      ]);
      overlay.dispose();
      expect(tui.setWidget).toHaveBeenLastCalledWith(
        "pair-programmer",
        undefined,
      );
    },
  );

  it("falls back to a widget when the host cannot keep the overlay", async () => {
    for (const fail of [false, true]) {
      const tui = fakeHost();
      tui.custom.mockImplementationOnce(() =>
        fail ? Promise.reject(new Error("no")) : Promise.resolve(undefined),
      );
      const overlay = new StatusOverlay();
      overlay.show(tui.ctx, { tone: "success", text: "watching" });
      await flush();
      expect(tui.setWidget).toHaveBeenLastCalledWith("pair-programmer", [
        "◆ pair · watching",
      ]);
      overlay.show(tui.event(), { tone: "dim", text: "paused" });
      expect(tui.custom).toHaveBeenCalledTimes(1);
      expect(tui.setWidget).toHaveBeenLastCalledWith("pair-programmer", [
        "◆ pair · paused",
      ]);
    }
  });

  it("moves between host UIs and ignores the old one's completions", async () => {
    const first = fakeHost();
    const overlay = new StatusOverlay();
    overlay.show(first.ctx, { tone: "success", text: "watching" });
    await flush();
    const rpc = fakeHost({ mode: "rpc" });
    overlay.show(rpc.ctx, { tone: "success", text: "watching" });
    await flush();
    expect(first.stack).toEqual([]);
    expect(rpc.setWidget).toHaveBeenLastCalledWith("pair-programmer", [
      "◆ pair · watching",
    ]);
    const second = fakeHost();
    overlay.show(second.ctx, { tone: "dim", text: "paused" });
    await flush();
    expect(rpc.setWidget).toHaveBeenLastCalledWith(
      "pair-programmer",
      undefined,
    );
    expect(second.stack).toHaveLength(1);
    overlay.dispose();
  });

  it("clears the previous widget line when moving between widget hosts", () => {
    const first = fakeHost({ mode: "rpc" });
    const second = fakeHost({ host: "omp" });
    const overlay = new StatusOverlay();
    overlay.show(first.ctx, { tone: "dim", text: "paused" });
    overlay.show(second.ctx, { tone: "dim", text: "paused" });
    expect(first.setWidget).toHaveBeenLastCalledWith(
      "pair-programmer",
      undefined,
    );
    expect(second.setWidget).toHaveBeenLastCalledWith("pair-programmer", [
      "◆ pair · paused",
    ]);
  });

  it("does nothing on dispose before any session", () => {
    expect(() => {
      new StatusOverlay().dispose();
    }).not.toThrow();
  });

  it("skips overlays for headless contexts", () => {
    const tui = fakeHost({ hasUI: false });
    new StatusOverlay().show(tui.ctx, { tone: "dim", text: "paused" });
    expect(tui.custom).not.toHaveBeenCalled();
  });
});
