import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Host = "pi" | "omp";

/** Pi exposes `streamSimple` on its model registry; OMP does not. */
export function hostOf(ctx: Pick<ExtensionContext, "modelRegistry">): Host {
  return typeof ctx.modelRegistry.streamSimple === "function" ? "pi" : "omp";
}

/**
 * Whether the host can float a non-capturing overlay. OMP reports
 * `mode: "tui"` but ignores `nonCapturing`, so its overlays steal typing.
 */
export function canFloat(ctx: ExtensionContext): boolean {
  return (
    ctx.hasUI &&
    (ctx as Partial<ExtensionContext>).mode === "tui" &&
    hostOf(ctx) === "pi"
  );
}
