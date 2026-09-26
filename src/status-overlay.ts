import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type StatusTone = "dim" | "accent" | "warning" | "success";
export interface StatusState {
  tone: StatusTone;
  text: string;
}

const KEY = "pair-programmer";

interface Painter {
  fg(color: StatusTone | "muted", text: string): string;
}

function styled(theme: Painter, state: StatusState): string {
  const label = "pair · " + state.text;
  return `${theme.fg(state.tone, "◆")} ${theme.fg("muted", label)}`;
}

/** Permanent, non-focusable top-right badge; widget fallback outside Pi's TUI. */
export class StatusOverlay {
  private state: StatusState = { tone: "success", text: "watching" };
  private ctx: ExtensionContext | undefined;
  private close: (() => void) | undefined;
  private requestRender: (() => void) | undefined;

  show(ctx: ExtensionContext, state: StatusState): void {
    this.state = state;
    if (ctx !== this.ctx) this.mount(ctx);
    if (this.close === undefined) this.widget();
    else this.requestRender?.();
  }

  dispose(): void {
    this.close?.();
    this.close = undefined;
    this.requestRender = undefined;
    this.ctx?.ui.setWidget(KEY, undefined);
    this.ctx = undefined;
  }

  private label(): string {
    return `◆ pair · ${this.state.text}`;
  }

  private widget(): void {
    const ui = this.ctx?.ui;
    // SAFETY: OMP and test hosts may omit Pi's theme; plain text remains valid.
    const theme = (ui as Partial<ExtensionContext["ui"]> | undefined)?.theme;
    ui?.setWidget(KEY, [
      theme === undefined ? this.label() : styled(theme, this.state),
    ]);
  }

  private mount(ctx: ExtensionContext): void {
    this.dispose();
    this.ctx = ctx;
    if (!ctx.hasUI || (ctx as Partial<ExtensionContext>).mode !== "tui") return;
    let open = true;
    let mounted = false;
    this.close = () => {
      open = false;
    };
    const fallback = (): void => {
      if (mounted || this.ctx !== ctx) return;
      this.close = undefined;
      this.widget();
    };
    void Promise.resolve(
      ctx.ui.custom<undefined>(
        (tui, theme, _keys, done) => {
          mounted = true;
          this.requestRender = () => {
            tui.requestRender();
          };
          const finish = (): void => {
            done(undefined);
          };
          if (open) this.close = finish;
          else queueMicrotask(finish);
          return {
            render: (width: number): string[] => {
              const body = " " + styled(theme, this.state) + " ";
              return [truncateToWidth(body, Math.max(1, width), "…")];
            },
            invalidate(): void {
              return;
            },
          };
        },
        {
          overlay: true,
          overlayOptions: () => ({
            anchor: "top-right",
            width: visibleWidth(this.label()) + 2,
            margin: { top: 0, right: 1 },
            nonCapturing: true,
            visible: (columns: number) => columns >= 40,
          }),
        },
      ),
    ).then(fallback, fallback);
  }
}
