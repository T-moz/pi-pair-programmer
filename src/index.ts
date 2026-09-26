import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import {
  buildChangeEvidence,
  captureBaseline,
  type TaskBaseline,
} from "./change-evidence.js";
import { FindingAdmission } from "./finding-admission.js";
import { isInherited, reviewFile, type Host } from "./review-runner.js";
import { ReviewStore, type Finding } from "./review-store.js";
import {
  DEFAULT_REVIEWERS,
  loadReviewers,
  matchingReviewers,
  reviewerKey,
  type ReviewerConfig,
} from "./reviewers.js";

const MAX_DELIVERY = 4;
const DECISION_TOOL = "pair_programmer_decide";
const WAKE_COALESCE_MS = 250;
const ToolPathSchema = z.string();
const ContinuingRunSchema = z.object({ willContinue: z.literal(true) });

const DecisionParameters = Type.Object({
  findingId: Type.String({ minLength: 1 }),
  decision: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
  reason: Type.String({ minLength: 1 }),
});

interface ReviewJob {
  file: string;
  fullPath: string;
  revision: string;
  source: string;
  model: string;
  reviewer: ReviewerConfig;
  session: number;
  version: number;
  key: string;
  host: Host;
  cwd: string;
  ctx: ExtensionContext;
}

function isFreshSession(
  reason: string | undefined,
  header: { parentSession?: string } | null | undefined,
  entries: readonly { type: string }[] | undefined,
): boolean {
  if (
    header === undefined ||
    header === null ||
    header.parentSession !== undefined
  )
    return false;
  return (
    [undefined, "startup", "new"].includes(reason) &&
    entries?.every((entry) =>
      [
        "model_change",
        "thinking_level_change",
        "mode_change",
        "service_tier_change",
      ].includes(entry.type),
    ) === true
  );
}

function decisionInteraction(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (toolName === DECISION_TOOL) return true;
  if (toolName !== "read" && toolName !== "write") return false;
  const target = input["path"];
  if (typeof target !== "string") return false;
  const device = target.trim();
  return (
    device.slice(0, 5).toLowerCase() === "xd://" &&
    device.slice(5) === DECISION_TOOL
  );
}

function hostOf(ctx: ExtensionContext): Host {
  return typeof ctx.modelRegistry.streamSimple === "function" ? "pi" : "omp";
}

function idle(ctx: ExtensionContext): boolean {
  try {
    return ctx.isIdle();
  } catch {
    return false;
  }
}

function revisionOf(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function describe(findings: readonly Finding[]): string {
  const lines = findings.map(
    (finding) =>
      `- ${finding.id} ${finding.file}:${String(finding.line)} ${finding.title}\n  ${finding.evidence}`,
  );
  return `Review findings:\n${lines.join("\n")}\nAccept or reject every finding with pair_programmer_decide(findingId, decision, reason) before using another tool. Give a concrete reason for each decision.`;
}

function acceptedReview(finding: Finding, reason: string): string {
  return `### Accepted review: ${finding.title}\n\n**${finding.file}:${String(finding.line)}**\n\n${finding.evidence}\n\n**Reason:** ${reason}`;
}

export default function pairProgrammer(pi: ExtensionAPI): void {
  const appendReviewEntry = (data: unknown): void => {
    pi.appendEntry("pair-programmer", data);
  };
  let store = new ReviewStore(appendReviewEntry);
  let admission = new FindingAdmission(store);
  let reviewers: readonly ReviewerConfig[] = DEFAULT_REVIEWERS;
  let root = process.cwd();
  let baseline: TaskBaseline | undefined;
  let baselineSession: string | undefined;
  let generation = 0;
  let unresolved = 0;
  let nextVersion = 0;
  const versions = new Map<string, number>();
  const reviewed = new Map<string, string>();
  const timers = new Map<string, NodeJS.Timeout>();
  const presented = new Set<string>();
  let wakeTimer: NodeJS.Timeout | undefined;
  let wakePending = false;
  const controllers = new Map<AbortController, string>();

  function stop(): void {
    generation += 1;
    unresolved = 0;
    versions.clear();
    reviewed.clear();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const controller of controllers.keys()) controller.abort();
    controllers.clear();
    clearTimeout(wakeTimer);
    wakeTimer = undefined;
    wakePending = false;
    presented.clear();
  }

  function deliverable(): readonly Finding[] {
    return !store.enabled || unresolved > 0 || store.outstanding().length > 0
      ? []
      : store
          .ready()
          .filter((finding) => !timers.has(finding.file))
          .slice(0, MAX_DELIVERY);
  }

  function send(batch: readonly Finding[], waking: Host | undefined): void {
    let options: Parameters<ExtensionAPI["sendMessage"]>[1] = {
      deliverAs: "nextTurn",
      triggerTurn: false,
    };
    if (waking === "pi") options = { triggerTurn: true };
    else if (waking === "omp")
      options = { deliverAs: "nextTurn", triggerTurn: true };
    pi.sendMessage(
      {
        customType: "pair-programmer-findings",
        content: describe(batch),
        display: false,
      },
      options,
    );
    const ids = batch.map((finding) => finding.id);
    store.deliver(ids);
    if (waking === undefined) return;
    wakePending = true;
    for (const id of ids) presented.add(id);
  }

  function deliver(): void {
    const batch = deliverable();
    if (batch.length > 0) send(batch, undefined);
  }

  function wake(ctx: ExtensionContext, ending: boolean): void {
    if (!store.enabled || wakePending) return;
    if (!ending && !idle(ctx)) return;
    const outstanding = store.outstanding();
    if (outstanding.length === 0) {
      const batch = deliverable();
      if (batch.length > 0) send(batch, hostOf(ctx));
    } else if (outstanding.some((finding) => !presented.has(finding.id))) {
      send(outstanding, hostOf(ctx));
    }
  }

  function scheduleWake(ctx: ExtensionContext): void {
    wakeTimer ??= setTimeout(() => {
      wakeTimer = undefined;
      wake(ctx, false);
    }, WAKE_COALESCE_MS);
  }

  function start(job: ReviewJob): void {
    const controller = new AbortController();
    controllers.set(controller, job.key);
    void runJob(job, controller.signal)
      .catch(() => {
        return;
      })
      .finally(() => {
        controllers.delete(controller);
      });
  }

  function active(job: ReviewJob): boolean {
    return (
      store.enabled &&
      job.session === generation &&
      job.version === versions.get(job.key)
    );
  }

  async function current(job: ReviewJob): Promise<boolean> {
    if (!active(job)) return false;
    try {
      return (
        (await realpath(job.fullPath)) === job.fullPath &&
        revisionOf(await readFile(job.fullPath, "utf8")) === job.revision &&
        active(job)
      );
    } catch {
      return false;
    }
  }

  async function runJob(job: ReviewJob, signal: AbortSignal): Promise<void> {
    const proposed = await reviewFile({
      host: job.host,
      cwd: job.cwd,
      model: job.model,
      prompt: job.reviewer.prompt,
      file: job.file,
      source: job.source,
      signal,
    });
    if (!(await current(job))) return;
    const reviewer = reviewerKey(job.reviewer);
    if (proposed.length === 0) {
      reviewed.set(`${job.key}:${reviewer}:${job.model}`, job.revision);
      return;
    }
    const judged = await Promise.all(
      proposed.map(async (finding) => ({
        finding,
        inherited: await isInherited({
          finding,
          evidence: await buildChangeEvidence(
            baseline,
            job.file,
            job.source,
            finding.line,
            finding.quote,
            signal,
          ),
          signal,
        }),
      })),
    );
    if (signal.aborted || !(await current(job))) return;
    const result = await admission.admit({
      file: job.file,
      reviewer,
      revision: job.revision,
      findings: judged.flatMap(({ finding, inherited }) =>
        inherited ? [] : [finding],
      ),
      signal,
      isCurrent: () => current(job),
    });
    if (result === "obsolete") return;
    if (result === "added") scheduleWake(job.ctx);
    reviewed.set(`${job.key}:${reviewer}:${job.model}`, job.revision);
  }

  function startReviews(
    base: Omit<ReviewJob, "model" | "reviewer">,
    ctx: ExtensionContext,
  ): void {
    const jobs: ReviewJob[] = [];
    const keys = new Set<string>();
    for (const reviewer of matchingReviewers(base.file, reviewers)) {
      let model = reviewer.model;
      if (model === "current") {
        if (ctx.model === undefined) continue;
        model = `${ctx.model.provider}/${ctx.model.id}`;
      }
      const key = `${base.file}:${reviewerKey(reviewer)}:${model}`;
      if (reviewed.get(key) === base.revision || keys.has(key)) continue;
      keys.add(key);
      jobs.push({ ...base, model, reviewer });
    }
    for (const job of jobs) start(job);
  }

  async function prepare(
    fullPath: string,
    file: string,
    ctx: ExtensionContext,
    version: number,
    session: number,
  ): Promise<void> {
    try {
      if (
        (await realpath(fullPath)) !== fullPath ||
        !(await stat(fullPath)).isFile()
      ) {
        if (
          store.enabled &&
          session === generation &&
          version === versions.get(file)
        ) {
          store.discardStale(file, "missing");
        }
        return;
      }
      const source = await readFile(fullPath, "utf8");
      if (
        !store.enabled ||
        session !== generation ||
        version !== versions.get(file)
      )
        return;
      const revision = revisionOf(source);
      store.discardStale(file, revision);
      const host = hostOf(ctx);
      startReviews(
        {
          file,
          fullPath,
          revision,
          source,
          session,
          version,
          key: file,
          host,
          cwd: ctx.cwd,
          ctx,
        },
        ctx,
      );
    } catch {
      if (
        store.enabled &&
        session === generation &&
        version === versions.get(file)
      ) {
        store.discardStale(file, "missing");
      }
    }
  }

  async function schedule(
    filePath: string,
    ctx: ExtensionContext,
    version: number,
    session: number,
  ): Promise<void> {
    const requested = path.resolve(ctx.cwd, filePath);
    const lexical = path.relative(ctx.cwd, requested).split(path.sep).join("/");
    if (
      !lexical ||
      lexical.startsWith("../") ||
      lexical === ".." ||
      path.isAbsolute(lexical)
    )
      return;
    try {
      const fullPath = await realpath(requested);
      const file = path.relative(root, fullPath).split(path.sep).join("/");
      if (
        !file ||
        file.startsWith("../") ||
        file === ".." ||
        path.isAbsolute(file)
      ) {
        if (store.enabled && session === generation)
          store.discardStale(lexical, "missing");
        return;
      }
      if (
        !store.enabled ||
        session !== generation ||
        version < (versions.get(file) ?? 0)
      )
        return;
      if (lexical !== file) store.discardStale(lexical, "missing");
      versions.set(file, version);
      for (const [controller, activeFile] of controllers) {
        if (activeFile === file) controller.abort();
      }
      clearTimeout(timers.get(file));
      timers.set(
        file,
        setTimeout(() => {
          timers.delete(file);
          void prepare(fullPath, file, ctx, version, session);
        }, 120),
      );
    } catch {
      if (store.enabled && session === generation)
        store.discardStale(lexical, "missing");
    }
  }

  function replaceBaseline(next: TaskBaseline | undefined): void {
    const previous = baseline;
    baseline = next;
    void previous?.dispose();
  }

  async function assessBaseline(
    event: { reason?: string },
    ctx: ExtensionContext,
    session: number,
  ): Promise<void> {
    const controller = new AbortController();
    controllers.set(controller, "");
    try {
      const manager = ctx.sessionManager as Partial<
        ExtensionContext["sessionManager"]
      >;
      const header = manager.getHeader?.();
      if (event.reason === "fork" || header?.id !== baselineSession) {
        replaceBaseline(undefined);
        baselineSession = header?.id;
        if (isFreshSession(event.reason, header, manager.getEntries?.())) {
          const capture = await captureBaseline(root, controller.signal);
          const captured =
            capture.status === "available" ? capture.baseline : undefined;
          if (session === generation) replaceBaseline(captured);
          else void captured?.dispose();
        }
      }
    } catch {
      if (session === generation) replaceBaseline(undefined);
    } finally {
      controllers.delete(controller);
    }
  }

  async function startSession(
    event: { reason?: string },
    ctx: ExtensionContext,
  ): Promise<void> {
    stop();
    const session = generation;
    const resolvedRoot = await realpath(ctx.cwd);
    if (session !== generation) return;
    root = resolvedRoot;
    store = new ReviewStore(appendReviewEntry, ctx.sessionManager.getBranch());
    admission = new FindingAdmission(store);
    await assessBaseline(event, ctx, session);
    if (session !== generation) return;
    try {
      const loaded = await loadReviewers(ctx.cwd);
      if (session === generation) reviewers = loaded;
    } catch (error) {
      if (session !== generation) return;
      reviewers = [];
      ctx.ui.notify(String(error), "warning");
    }
  }

  pi.on("session_start", startSession);
  const onOmpSession = pi.on.bind(pi) as unknown as (
    name: "session_switch" | "session_branch",
    handler: (
      event: { reason?: string },
      ctx: ExtensionContext,
    ) => Promise<void>,
  ) => void;
  onOmpSession("session_switch", startSession);
  onOmpSession("session_branch", (_event, ctx) =>
    startSession({ reason: "fork" }, ctx),
  );

  pi.on("session_shutdown", () => {
    stop();
    replaceBaseline(undefined);
    baselineSession = undefined;
  });

  pi.on("tool_result", (event, ctx) => {
    if (
      !store.enabled ||
      event.isError ||
      (event.toolName !== "write" && event.toolName !== "edit")
    )
      return;
    const filePath = ToolPathSchema.safeParse(event.input["path"]);
    if (!filePath.success) return;
    const version = ++nextVersion;
    const session = generation;
    unresolved += 1;
    void schedule(filePath.data, ctx, version, session)
      .finally(() => {
        if (session === generation) unresolved -= 1;
      })
      .catch(() => {
        return;
      });
  });

  pi.on("context", (event) => {
    if (
      event.messages.every(
        (message) =>
          message.role !== "custom" ||
          message.customType !== "pair-programmer-findings",
      )
    )
      return;
    const outstanding = store.enabled ? store.outstanding() : [];
    return {
      messages: event.messages.flatMap((message) => {
        if (
          message.role !== "custom" ||
          message.customType !== "pair-programmer-findings"
        )
          return [message];
        const relevant = outstanding.filter(
          (finding) =>
            typeof message.content === "string" &&
            message.content.includes(finding.id),
        );
        for (const finding of relevant) presented.add(finding.id);
        return relevant.length === 0
          ? []
          : [{ ...message, content: describe(relevant) }];
      }),
    };
  });

  pi.on("turn_end", () => {
    deliver();
  });

  pi.on("before_agent_start", () => {
    deliver();
  });

  pi.on("agent_start", () => {
    wakePending = false;
  });

  pi.on("agent_settled", (_event, ctx) => {
    wake(ctx, false);
  });

  pi.on("agent_end", (event, ctx) => {
    if (hostOf(ctx) === "omp" && !ContinuingRunSchema.safeParse(event).success)
      wake(ctx, true);
  });

  pi.on("tool_call", (event) => {
    if (!store.enabled || decisionInteraction(event.toolName, event.input))
      return;
    deliver();
    const outstanding = store.outstanding();
    if (outstanding.length === 0) return;
    for (const finding of outstanding) presented.add(finding.id);
    return { block: true, reason: describe(outstanding) };
  });

  pi.registerTool({
    name: DECISION_TOOL,
    label: "Decide review finding",
    description:
      "Accept or reject one delivered review finding and explain why before coding continues",
    parameters: DecisionParameters,
    execute(_toolCallId, params) {
      if (!store.enabled) {
        return Promise.resolve({
          content: [{ type: "text" as const, text: "Pair Programmer is off." }],
          details: { saved: false },
        });
      }
      const finding =
        params.decision === "accept"
          ? store.deliveredFinding(params.findingId)
          : undefined;
      const saved = store.decide(
        params.findingId,
        params.decision,
        params.reason,
      );
      if (saved && params.decision === "accept" && finding !== undefined) {
        pi.sendMessage(
          {
            customType: "pair-programmer-accepted",
            content: acceptedReview(finding, params.reason),
            display: true,
          },
          { triggerTurn: false },
        );
      }
      return Promise.resolve({
        content: [
          {
            type: "text" as const,
            text: saved
              ? `Recorded ${params.decision} for ${params.findingId}.`
              : "Unknown, already decided, or invalid finding. Decide each delivered finding with a reason.",
          },
        ],
        details: { saved },
      });
    },
  });

  pi.registerCommand("pair-programmer", {
    description: "Toggle background peer review on or off",
    handler: (_args, ctx) => {
      const enabled = !store.enabled;
      if (!enabled) stop();
      store.setEnabled(enabled);
      ctx.ui.notify(`Pair Programmer ${enabled ? "on" : "off"}.`, "info");
      return Promise.resolve();
    },
  });
}
