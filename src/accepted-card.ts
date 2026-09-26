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
  const path = truncatePath(
    details.file,
    Math.max(1, inner - visibleWidth(location)),
  );
  const title = wrapTextWithAnsi(details.title, inner);
  const lines = [
    ...title.map(
      (part, index) =>
        `${index === 0 ? theme.fg("warning", "◆") : " "} ${theme.bold(part)}`,
    ),
    `  ${theme.fg("dim", path + location)}`,
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

/** Renders accepted findings as a compact card; unknown payloads fall back to Pi's default. */
export const renderAccepted: MessageRenderer = (message, options, theme) => {
  const parsed = AcceptedDetails.safeParse(message.details);
  if (!parsed.success) return;
  return {
    render: (width: number): string[] =>
      acceptedLines(
        parsed.data,
        theme,
        width,
        options.expanded,
        options.outputPad,
      ),
    invalidate(): void {
      return;
    },
  };
};
