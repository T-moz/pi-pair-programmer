import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { z } from "zod";
import { truncatePath } from "./review-sidebar.js";

export const ACCEPTED_MESSAGE = "pair-programmer-accepted";

const AcceptedDetails = z.object({
  title: z.string(),
  file: z.string(),
  line: z.number(),
  evidence: z.string(),
  reason: z.string(),
  reviewer: z.string().optional(),
});
export type AcceptedDetails = z.infer<typeof AcceptedDetails>;

type Painter = Pick<Theme, "fg" | "bold">;

/** Collapsed: title and location. Expanded: also evidence and the agent's reason. */
export function acceptedLines(
  details: AcceptedDetails,
  theme: Painter,
  width: number,
  expanded: boolean,
  pad = 0,
): string[] {
  const indent = " ".repeat(Math.max(0, Math.min(pad, width - 4)));
  const inner = Math.max(1, width - visibleWidth(indent) - 2);
  const location = `:${String(details.line)}`;
  const by = details.reviewer === undefined ? "" : ` · ${details.reviewer}`;
  const path = truncatePath(
    details.file,
    Math.max(1, inner - visibleWidth(location + by)),
  );
  const title = wrapTextWithAnsi(details.title, Math.max(1, inner - 2));
  const marker = theme.fg("dim", expanded ? " ▾" : " ▸");
  const lines = [
    ...title.map(
      (part, index) =>
        `${index === 0 ? theme.fg("warning", "◆") : " "} ${theme.bold(part)}${index === title.length - 1 ? marker : ""}`,
    ),
    `  ${theme.fg("dim", path + location + by)}`,
  ];
  if (expanded)
    lines.push(
      ...wrapTextWithAnsi(details.evidence, inner).map(
        (part) => `  ${theme.fg("muted", part)}`,
      ),
      ...wrapTextWithAnsi(`“${details.reason}”`, inner).map(
        (part) => `  ${theme.fg("dim", part)}`,
      ),
    );
  return lines.map((line) => sliceByColumn(indent + line, 0, width));
}

/**
 * A card's own click toggle, remembered per message because Pi rebuilds the
 * component on every expand or theme change. `base` records the global expand
 * state when clicked, so a later ctrl+o overrides the local toggle.
 */
const toggled = new WeakMap<object, { open: boolean; base: boolean }>();

/** Renders accepted findings as a compact card; unknown payloads fall back to Pi's default. */
export const renderAccepted: MessageRenderer = (message, options, theme) => {
  const parsed = AcceptedDetails.safeParse(message.details);
  if (!parsed.success) return;
  const open = (): boolean => {
    const state = toggled.get(message);
    return state?.base === options.expanded ? state.open : options.expanded;
  };
  return {
    render: (width: number): string[] =>
      acceptedLines(parsed.data, theme, width, open(), options.outputPad),
    handleMouse(event) {
      if (event.type !== "click" || event.button !== "left") return;
      toggled.set(message, { open: !open(), base: options.expanded });
      return { handled: true, render: true };
    },
    invalidate(): void {
      return;
    },
  };
};
