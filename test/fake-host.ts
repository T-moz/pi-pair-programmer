import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  Component,
  OverlayHandle,
  OverlayOptions,
  TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { vi, type Mock } from "vitest";

type Custom = ExtensionContext["ui"]["custom"];
type Factory = Parameters<Custom>[0];
type CustomOptions = NonNullable<Parameters<Custom>[1]>;

export interface Overlay {
  component: Component;
  options: OverlayOptions | undefined;
  /** Resolves `ui.custom`, as Pi's `done()` does, whether or not it is shown. */
  settled: boolean;
}

export interface FakeHost {
  ctx: ExtensionContext;
  custom: Mock<Custom>;
  setWidget: Mock<(key: string, lines: string[] | undefined) => void>;
  notify: Mock;
  requestRender: Mock;
  /** Visible overlays, bottom to top. */
  stack: Overlay[];
  /** Every overlay ever created, oldest first. */
  created: Overlay[];
  /** Holds the factory until `release()` when deferred. */
  defer(): void;
  release(): void;
  /** A fresh per-event context sharing this host's UI, like Pi's runner. */
  event(): ExtensionContext;
  top(): Overlay | undefined;
  render(overlay: Overlay | undefined, width: number): string[];
  click(overlay: Overlay | undefined, y: number): unknown;
}

interface HostOptions {
  host?: "pi" | "omp";
  mode?: string | undefined;
  rows?: number;
  hasUI?: boolean;
  theme?: unknown;
  /** Omit `onHandle`, like hosts older than Pi's overlay handles. */
  handles?: boolean;
}

const plain = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function handleFor(stack: Overlay[], entry: Overlay): OverlayHandle {
  return {
    hide: () => {
      const index = stack.indexOf(entry);
      if (index !== -1) stack.splice(index, 1);
    },
  } as OverlayHandle;
}

/**
 * Mirrors Pi 0.87.1's `showExtensionCustom`: `done()` pops the *topmost*
 * overlay, and `onHandle` exposes a `hide()` that removes only its own.
 */
export function fakeHost(options: HostOptions = {}): FakeHost {
  const {
    host = "pi",
    mode = "tui",
    rows = 20,
    hasUI = true,
    theme = plain,
    handles = true,
  } = options;
  const stack: Overlay[] = [];
  const created: Overlay[] = [];
  const requestRender = vi.fn();
  const tui = { requestRender, terminal: { rows } };
  let deferred: (() => void)[] | undefined;
  const custom = vi.fn(
    (factory: Factory, opts?: CustomOptions): Promise<unknown> =>
      new Promise((resolve) => {
        let closed = false;
        const run = (): void => {
          let overlay: Overlay | undefined;
          const done = (result: unknown): void => {
            if (closed) return;
            closed = true;
            stack.pop();
            if (overlay !== undefined) overlay.settled = true;
            resolve(result);
          };
          void Promise.resolve(
            factory(
              tui as unknown as Parameters<Factory>[0],
              theme as Parameters<Factory>[1],
              {} as Parameters<Factory>[2],
              done,
            ),
          ).then((component) => {
            if (closed) return;
            const resolved =
              typeof opts?.overlayOptions === "function"
                ? opts.overlayOptions()
                : opts?.overlayOptions;
            overlay = { component, options: resolved, settled: false };
            created.push(overlay);
            stack.push(overlay);
            if (handles) opts?.onHandle?.(handleFor(stack, overlay));
            return overlay;
          });
        };
        if (deferred === undefined) run();
        else deferred.push(run);
      }),
  );
  const setWidget = vi.fn<(key: string, lines: string[] | undefined) => void>();
  const notify = vi.fn();
  const ui = {
    custom,
    setWidget,
    notify,
    ...(theme === plain ? {} : { theme }),
  };
  const event = (): ExtensionContext =>
    ({
      hasUI,
      mode,
      ui,
      modelRegistry: host === "pi" ? { streamSimple: vi.fn() } : {},
    }) as unknown as ExtensionContext;
  return {
    ctx: event(),
    custom,
    setWidget,
    notify,
    requestRender,
    stack,
    created,
    defer: () => {
      deferred = [];
    },
    release: () => {
      const pending = deferred ?? [];
      deferred = undefined;
      for (const run of pending) run();
    },
    event,
    top: () => stack.at(-1),
    render: (overlay, width) => overlay?.component.render(width) ?? [],
    click: (overlay, y) =>
      overlay?.component.handleMouse?.({
        type: "click",
        button: "left",
        y,
      } as TuiMouseEvent),
  };
}

/** Opens a capturing overlay such as `/pair-stats` on the host. */
export function openCapturing(host: FakeHost): {
  closed: () => boolean;
  close: () => void;
} {
  let done: ((value: undefined) => void) | undefined;
  let closed = false;
  void host.ctx.ui
    .custom<undefined>(
      (_tui, _theme, _keys, finish) => {
        done = finish;
        return {
          render: () => ["stats"],
          invalidate: () => {
            return;
          },
        };
      },
      { overlay: true },
    )
    .then(() => {
      closed = true;
      return closed;
    });
  return {
    closed: () => closed,
    close: () => done?.(undefined),
  };
}

export const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));
