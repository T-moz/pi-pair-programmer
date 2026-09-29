import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Keeps the end of a path: drop whole leading directories first, then characters. */
export function truncatePath(file: string, width: number): string {
  if (visibleWidth(file) <= width) return file;
  const parts = file.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const tail = `…/${parts.slice(index).join("/")}`;
    if (visibleWidth(tail) <= width) return tail;
  }
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(file),
    ({ segment }) => segment,
  );
  const start = graphemes.findIndex(
    (_, index) => visibleWidth(`…${graphemes.slice(index).join("")}`) <= width,
  );
  return start === -1 ? "…" : `…${graphemes.slice(start).join("")}`;
}

export interface Frame {
  /** Columns available to content inside the border and padding. */
  inner: number;
  /** Truncates and pads each line, then wraps the rows in a rounded border. */
  render(lines: readonly string[]): string[];
}

/** A rounded border `width` columns wide with `padding` spaces inside each side. */
export function frame(
  theme: Pick<Theme, "fg">,
  width: number,
  padding: number,
): Frame {
  const inner = Math.max(1, width - 2 - 2 * padding);
  const space = " ".repeat(padding);
  const side = theme.fg("borderMuted", "│");
  const rule = "─".repeat(Math.max(0, width - 2));
  return {
    inner,
    render: (lines) => [
      theme.fg("borderMuted", `╭${rule}╮`),
      ...lines.map((text) => {
        const clipped = truncateToWidth(text, inner, "…");
        const pad = " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
        return `${side}${space}${clipped}${pad}${space}${side}`;
      }),
      theme.fg("borderMuted", `╰${rule}╯`),
    ],
  };
}
