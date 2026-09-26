import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi, type Mock } from "vitest";
import { StatusOverlay } from "../src/status-overlay.js";

type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
interface Options {
  overlayOptions: () => {
    anchor: string;
    width: number;
    nonCapturing: boolean;
    visible: (columns: number) => boolean;
  };
}

interface Host {
  ctx: ExtensionContext;
  custom: Mock<(factory: Factory, opts: Options) => Promise<undefined>>;
  setWidget: ReturnType<typeof vi.fn>;
  requestRender: ReturnType<typeof vi.fn>;
  closed: ReturnType<typeof vi.fn>;
  render: (width: number) => string[] | undefined;
  options: () => ReturnType<Options["overlayOptions"]> | undefined;
}

function host(mode: string | undefined = "tui"): Host {
  const requestRender = vi.fn();
  const setWidget = vi.fn();
  const closed = vi.fn();
  let render: ((width: number) => string[]) | undefined;
  let options: Options | undefined;
  const custom = vi.fn(
    async (factory: Factory, opts: Options): Promise<undefined> => {
      options = opts;
      const done = Promise.withResolvers<undefined>();
      const component = await factory(
        { requestRender } as unknown as Parameters<Factory>[0],
        {
          fg: (color: string, text: string) => `<${color}>${text}`,
        } as unknown as Parameters<Factory>[1],
        {} as Parameters<Factory>[2],
        () => {
          closed();
          done.resolve(undefined);
        },
      );
      render = (width) => component.render(width);
      component.invalidate();
      return done.promise;
    },
  );
  const ctx = {
    hasUI: true,
    mode,
    ui: { custom, setWidget },
  } as unknown as ExtensionContext;
  return {
    ctx,
    custom,
    setWidget,
    requestRender,
    closed,
    render: (width: number) => render?.(width),
    options: () => options?.overlayOptions(),
  };
}

describe("StatusOverlay", () => {
  it("pins a non-capturing badge to the top-right and updates in place", async () => {
    const tui = host();
    const overlay = new StatusOverlay();
    overlay.show(tui.ctx, { tone: "success", text: "watching" });
    await Promise.resolve();
    expect(tui.options()).toMatchObject({
      anchor: "top-right",
      width: 19,
      nonCapturing: true,
    });
    expect(tui.options()?.visible(39)).toBe(false);
    expect(tui.options()?.visible(40)).toBe(true);
    expect(tui.render(80)).toEqual([" <success>◆ <muted>pair · watching "]);
    overlay.show(tui.ctx, { tone: "warning", text: "2 awaiting decision" });
    expect(tui.custom).toHaveBeenCalledTimes(1);
    expect(tui.requestRender).toHaveBeenCalledTimes(2);
    expect(tui.render(80)?.[0]).toContain("<warning>◆");
    expect(tui.options()?.width).toBe(30);
    expect(tui.render(5)?.[0]).toContain("…");
    expect(tui.setWidget).not.toHaveBeenCalledWith(
      "pair-programmer",
      expect.anything(),
    );
    overlay.dispose();
    expect(tui.closed).toHaveBeenCalledTimes(1);
    expect(tui.setWidget).toHaveBeenLastCalledWith(
      "pair-programmer",
      undefined,
    );
  });

  it("closes a badge disposed before the host mounts it", async () => {
    const tui = host();
    let mount: (() => void) | undefined;
    tui.custom.mockImplementationOnce(
      (factory: Factory): Promise<undefined> => {
        return new Promise<undefined>((resolve) => {
          mount = () => {
            const component = factory(
              { requestRender: vi.fn() } as unknown as Parameters<Factory>[0],
              {} as Parameters<Factory>[1],
              {} as Parameters<Factory>[2],
              () => {
                resolve(undefined);
              },
            );
            expect(component).toBeDefined();
          };
        });
      },
    );
    const overlay = new StatusOverlay();
    overlay.show(tui.ctx, { tone: "dim", text: "paused" });
    overlay.dispose();
    mount?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tui.setWidget).toHaveBeenLastCalledWith(
      "pair-programmer",
      undefined,
    );
  });

  it.each(["rpc", "print"])(
    "falls back to a widget in %s mode without mounting an overlay",
    (mode) => {
      const tui = host(mode);
      const overlay = new StatusOverlay();
      overlay.show(tui.ctx, { tone: "dim", text: "paused" });
      expect(tui.custom).not.toHaveBeenCalled();
      expect(tui.setWidget).toHaveBeenLastCalledWith("pair-programmer", [
        "◆ pair · paused",
      ]);
      Object.assign(tui.ctx.ui, {
        theme: { fg: (color: string, text: string) => `<${color}>${text}` },
      });
      overlay.show(tui.ctx, { tone: "accent", text: "1 queued" });
      expect(tui.setWidget).toHaveBeenLastCalledWith("pair-programmer", [
        "<accent>◆ <muted>pair · 1 queued",
      ]);
    },
  );

  it("falls back to a widget when the host cannot keep the overlay", async () => {
    for (const fail of [false, true]) {
      const tui = host();
      tui.custom.mockImplementationOnce((): Promise<undefined> =>
        fail ? Promise.reject(new Error("no")) : Promise.resolve(undefined),
      );
      const overlay = new StatusOverlay();
      overlay.show(tui.ctx, { tone: "success", text: "watching" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(tui.setWidget).toHaveBeenLastCalledWith("pair-programmer", [
        "◆ pair · watching",
      ]);
      overlay.show(tui.ctx, { tone: "dim", text: "paused" });
      expect(tui.setWidget).toHaveBeenLastCalledWith("pair-programmer", [
        "◆ pair · paused",
      ]);
    }
  });

  it("ignores stale host completions after moving to a new session", async () => {
    const first = host();
    const pending = Promise.withResolvers<undefined>();
    first.custom.mockReturnValueOnce(pending.promise);
    const overlay = new StatusOverlay();
    overlay.show(first.ctx, { tone: "success", text: "watching" });
    const second = host("rpc");
    overlay.show(second.ctx, { tone: "success", text: "watching" });
    pending.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.setWidget).toHaveBeenLastCalledWith(
      "pair-programmer",
      undefined,
    );
  });

  it("does nothing on dispose before any session", () => {
    expect(() => {
      new StatusOverlay().dispose();
    }).not.toThrow();
  });

  it("skips overlays for headless contexts", () => {
    const tui = host();
    tui.ctx.hasUI = false;
    new StatusOverlay().show(tui.ctx, { tone: "dim", text: "paused" });
    expect(tui.custom).not.toHaveBeenCalled();
  });
});
