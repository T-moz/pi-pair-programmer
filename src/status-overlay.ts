import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { canFloat } from "./host.js";
import { OverlaySlot } from "./overlay-slot.js";

export type StatusTone = "dim" | "accent" | "warning" | "success";
export interface StatusState {
  tone: StatusTone;
  text: string;
}

const KEY = "pair-programmer";

type UI = ExtensionContext["ui"];

interface Painter {
  fg(color: StatusTone | "muted", text: string): string;
}

function styled(theme: Painter, state: StatusState): string {
  const label = "pair · " + state.text;
  return `${theme.fg(state.tone, "◆")} ${theme.fg("muted", label)}`;
}

/**
 * Permanent, non-focusable top-right badge in Pi's TUI; a widget line above
 * the editor elsewhere (RPC, OMP) or when the host cannot keep the overlay.
 */
export class StatusOverlay {
  private state: StatusState = { tone: "success", text: "watching" };
  private readonly slot = new OverlaySlot();
  /** UI showing the widget line instead of the badge. */
  private widgetUi: UI | undefined;

  show(ctx: ExtensionContext, state: StatusState): void {
    this.state = state;
    const ui = ctx.ui;
    if (this.widgetUi !== ui && canFloat(ctx)) {
      if (this.slot.ui === ui) this.slot.requestRender();
      else this.float(ctx);
      return;
    }
    if (this.slot.ui !== undefined) this.slot.close();
    if (this.widgetUi !== undefined && this.widgetUi !== ui) this.clearWidget();
    this.widgetUi = ui;
    this.widget();
  }

  dispose(): void {
    this.slot.close();
    this.clearWidget();
  }

  private label(): string {
    return `◆ pair · ${this.state.text}`;
  }

  private clearWidget(): void {
    this.widgetUi?.setWidget(KEY, undefined);
    this.widgetUi = undefined;
  }

  private widget(): void {
    const ui = this.widgetUi;
    // SAFETY: OMP and test hosts may omit Pi's theme; plain text remains valid.
    const theme = (ui as Partial<UI> | undefined)?.theme;
    ui?.setWidget(KEY, [
      theme === undefined ? this.label() : styled(theme, this.state),
    ]);
  }

  private float(ctx: ExtensionContext): void {
    this.clearWidget();
    const ui = ctx.ui;
    this.slot.open(
      ctx,
      (_tui, theme) => ({
        render: (width: number): string[] => {
          const body = " " + styled(theme, this.state) + " ";
          return [truncateToWidth(body, Math.max(1, width), "…")];
        },
        invalidate(): void {
          return;
        },
      }),
      () => ({
        anchor: "top-right",
        width: visibleWidth(this.label()) + 2,
        margin: { top: 0, right: 1 },
        nonCapturing: true,
        visible: (columns: number) => columns >= 40,
      }),
      () => {
        // The host could not keep the badge: fall back to the widget line.
        this.widgetUi = ui;
        this.widget();
      },
    );
  }
}
