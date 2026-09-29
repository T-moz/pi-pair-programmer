import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import {
  sliceByColumn,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { z } from "zod";
import { truncatePath } from "./format.js";

export const ACCEPTED_MESSAGE = "pair-programmer-accepted";

const CardDetails = z.object({
  title: z.string(),
  file: z.string(),
  line: z.number(),
  evidence: z.string(),
  reason: z.string(),
  reviewer: z.string().optional(),
});
export type CardDetails = z.infer<typeof CardDetails>;

type Painter = Pick<Theme, "fg" | "bold">;
/** The transcript message a card renders; stable across Pi's rebuilds. */
type CardKey = Parameters<MessageRenderer>[0];

/**
 * An accepted finding: bold title plus location. Expanding reveals the
 * evidence and the agent's reason.
 */
export function cardLines(
  details: CardDetails,
  theme: Painter,
  width: number,
  expanded: boolean,
  pad = 0,
): string[] {
  const indent = " ".repeat(Math.max(0, Math.min(pad, width - 4)));
  const inner = Math.max(1, width - visibleWidth(indent) - 2);
  const marker = theme.fg("dim", expanded ? " ▾" : " ▸");
  const title = wrapTextWithAnsi(details.title, Math.max(1, inner - 2));
  const lines = title.map((part, index) => {
    const first = index === 0 ? theme.fg("warning", "◆") : " ";
    return `${first} ${theme.bold(part)}${index === title.length - 1 ? marker : ""}`;
  });
  const location = `:${String(details.line)}`;
  const by = details.reviewer === undefined ? "" : ` · ${details.reviewer}`;
  const path = truncatePath(
    details.file,
    Math.max(1, inner - visibleWidth(location + by)),
  );
  lines.push(`  ${theme.fg("dim", path + location + by)}`);
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
 * state when clicked, so a later ctrl+o overrides the toggle.
 */
const toggled = new WeakMap<CardKey, { open: boolean; base: boolean }>();

function isOpen(key: CardKey, expanded: boolean): boolean {
  const state = toggled.get(key);
  return state?.base === expanded ? state.open : expanded;
}

/** Accepted findings; unknown payloads fall back to Pi's default rendering. */
export const renderAccepted: MessageRenderer = (
  message,
  options,
  theme,
): Component | undefined => {
  const parsed = CardDetails.safeParse(message.details);
  if (!parsed.success) return;
  const { expanded, outputPad } = options;
  return {
    render: (width: number): string[] =>
      cardLines(
        parsed.data,
        theme,
        width,
        isOpen(message, expanded),
        outputPad,
      ),
    handleMouse(event) {
      if (event.type !== "click" || event.button !== "left") return;
      toggled.set(message, {
        open: !isOpen(message, expanded),
        base: expanded,
      });
      return { handled: true, render: true };
    },
    invalidate(): void {
      return;
    },
  };
};
