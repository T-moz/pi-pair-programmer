import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";

type UI = ExtensionContext["ui"];
type Custom = Parameters<UI["custom"]>[0];
type Factory = (
  ...args: Parameters<Custom> extends [...infer Rest, unknown] ? Rest : never
) => Awaited<ReturnType<Custom>>;

interface Mount {
  ui: UI;
  closed: boolean;
  handle?: OverlayHandle;
  done?: () => void;
  requestRender?: () => void;
}

/**
 * Owns at most one floating overlay. Pi's `done()` hides the topmost overlay,
 * not the caller's, so closing uses the overlay's own handle; `done()` is only
 * a fallback for hosts that never provide one. Each mount is its own token, so
 * a stale mount's late completion never affects a newer one.
 */
export class OverlaySlot {
  private mount: Mount | undefined;

  /** The host UI the current overlay belongs to. */
  get ui(): UI | undefined {
    return this.mount?.ui;
  }

  /**
   * Replaces any current overlay with one on `ctx.ui`. Per-event contexts
   * share one UI, so callers compare `ui` to avoid remounting. `onEnd` runs if
   * the host ends the overlay, with whether it was ever created.
   */
  open(
    ctx: ExtensionContext,
    factory: Factory,
    options: OverlayOptions | (() => OverlayOptions),
    onEnd: (created: boolean) => void,
  ): void {
    this.close();
    const mount: Mount = { ui: ctx.ui, closed: false };
    this.mount = mount;
    const end = (): void => {
      if (this.mount !== mount) return;
      this.mount = undefined;
      onEnd(mount.done !== undefined);
    };
    void Promise.resolve(
      ctx.ui.custom<undefined>(
        (tui, theme, keys, done) => {
          mount.done = () => {
            done(undefined);
          };
          mount.requestRender = () => {
            tui.requestRender();
          };
          if (mount.closed) setTimeout(settle(mount), 0);
          return factory(tui, theme, keys);
        },
        {
          overlay: true,
          overlayOptions: options,
          onHandle: (handle) => {
            mount.handle = handle;
            if (mount.closed) handle.hide();
          },
        },
      ),
    ).then(end, end);
  }

  requestRender(): void {
    this.mount?.requestRender?.();
  }

  close(): void {
    const mount = this.mount;
    if (mount === undefined) return;
    this.mount = undefined;
    mount.closed = true;
    // Without a handle yet, wait for the host to supply one before `done()`.
    if (mount.handle === undefined) setTimeout(settle(mount), 0);
    else mount.handle.hide();
  }
}

function settle(mount: Mount): () => void {
  return () => {
    if (mount.handle === undefined) mount.done?.();
    else mount.handle.hide();
  };
}
