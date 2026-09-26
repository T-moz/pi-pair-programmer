import { createHash, randomUUID } from "node:crypto";
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
import { createPairLogger, type PairLogger } from "./logger.js";
import type { ModelCallObserver } from "./model-usage.js";
import {
  SessionAccounting,
  STATS_ENTRY,
  type PairStats,
  type ReviewOutcome,
} from "./pair-stats.js";
import { StatsView, statsLines } from "./stats-view.js";
import {
  isInherited,
  reviewFile,
  ReviewTimeoutError,
  type Host,
} from "./review-runner.js";
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
  id: string;
  stats: PairStats;
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
  let logger: PairLogger | undefined;
  const logging = (async () => {
    logger = await createPairLogger(pi);
  })();
  const statsView = new StatsView();
  const accounting = new SessionAccounting();
  let activeContext: ExtensionContext | undefined;
  const cancelJobs = new Map<AbortController, () => void>();
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
  let resetTimer: NodeJS.Timeout | undefined;
  let checkReset: (() => void) | undefined;

  function showState(ctx: ExtensionContext): void {
    ctx.ui.setStatus(
      "pair-programmer",
      `Pair Programmer: ${store.enabled ? "on" : "off"}`,
    );
  }

  function stopWatchingResets(): void {
    clearInterval(resetTimer);
    resetTimer = undefined;
    checkReset = undefined;
  }

  function watchResets(ctx: ExtensionContext): void {
    if (hostOf(ctx) !== "omp") return;
    const manager = ctx.sessionManager;
    let previousLeaf = manager.getLeafId();
    checkReset = () => {
      const leaf = manager.getLeafId();
      let id = leaf;
      let reset = false;
      while (id !== null && id !== previousLeaf) {
        const entry = manager.getEntry(id);
        if (entry === undefined) break;
        if ((entry.type as string) === "reset_boundary") {
          reset = true;
          break;
        }
        id = entry.parentId;
      }
      previousLeaf = leaf;
      if (!reset) return;
      stop("cleared");
      store = new ReviewStore(appendReviewEntry, manager.getBranch());
      admission = new FindingAdmission(store);
      showState(ctx);
    };
    resetTimer = setInterval(checkReset, 100);
    resetTimer.unref();
  }

  function stop(
    reasonCode: "session_change" | "shutdown" | "disabled" | "cleared",
  ): void {
    logger?.log("session.stop", {
      sessionId: accounting.stats.sessionId,
      reasonCode,
    });
    statsView.close();
    for (const cancel of cancelJobs.values()) cancel();
    cancelJobs.clear();
    accounting.retain(accounting.stats);
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
    checkReset?.();
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
    logger?.log("delivery.sent", {
      sessionId: accounting.stats.sessionId,
      count: ids.length,
      reasonCode: waking === undefined ? "passive" : "ready",
    });
    if (waking === undefined) return;
    wakePending = true;
    for (const id of ids) presented.add(id);
  }

  function deliver(): void {
    const batch = deliverable();
    if (batch.length > 0) send(batch, undefined);
  }

  function wake(ctx: ExtensionContext, ending: boolean): void {
    checkReset?.();
    if (!store.enabled || wakePending) {
      logger?.log("delivery.wake", {
        sessionId: accounting.stats.sessionId,
        reasonCode: wakePending ? "wake_pending" : "disabled",
      });
      return;
    }
    if (!ending && !idle(ctx)) {
      logger?.log("delivery.wake", {
        sessionId: accounting.stats.sessionId,
        reasonCode: "busy",
      });
      return;
    }
    const outstanding = store.outstanding();
    if (outstanding.length === 0) {
      const batch = deliverable();
      logger?.log("delivery.wake", {
        sessionId: accounting.stats.sessionId,
        reasonCode: batch.length > 0 ? "ready" : "no_findings_ready",
      });
      if (batch.length > 0) send(batch, hostOf(ctx));
    } else if (outstanding.some((finding) => !presented.has(finding.id))) {
      logger?.log("delivery.wake", {
        sessionId: accounting.stats.sessionId,
        reasonCode: "outstanding",
      });
      send(outstanding, hostOf(ctx));
    } else {
      logger?.log("delivery.wake", {
        sessionId: accounting.stats.sessionId,
        reasonCode: "already_presented",
      });
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
    const started = performance.now();
    const fields = {
      sessionId: job.stats.sessionId,
      jobId: job.id,
      reviewerId: reviewerKey(job.reviewer),
      modelId: revisionOf(job.model),
    };
    const reviewState: { outcome: ReviewOutcome } = { outcome: "success" };
    let finished = false;
    const finish = (result: ReviewOutcome, settled = true): void => {
      if (finished) return;
      finished = true;
      const durationMs = performance.now() - started;
      job.stats.finish(job.id, result, durationMs, settled);
      logger?.log("review.finished", {
        ...fields,
        outcome: result,
        durationMs,
      });
    };
    const onModelCall: ModelCallObserver = (observation) => {
      job.stats.observe(job.id, observation);
      logger?.log("model.finished", {
        ...fields,
        modelId: revisionOf(
          JSON.stringify([
            observation.provider,
            observation.model,
            observation.requestedModel,
          ]),
        ),
        stage: observation.stage,
        outcome: observation.outcome,
        durationMs: observation.durationMs,
        ...observation.usage,
      });
      if (observation.stage === "review")
        reviewState.outcome = observation.outcome;
      else if (
        observation.outcome === "failed" ||
        observation.outcome === "timeout"
      ) {
        logger?.log("finding.filtered", {
          ...fields,
          stage: observation.stage,
          reasonCode:
            observation.stage === "attribution"
              ? "attribution_fallback"
              : "dedup_fallback",
        });
      }
    };
    controllers.set(controller, job.key);
    cancelJobs.set(controller, () => {
      finish("cancelled", false);
    });
    job.stats.start(job.id);
    logger?.log("review.started", fields);
    void (async () => {
      try {
        const result = await runJob(job, controller.signal, onModelCall);
        const settledOutcome =
          reviewState.outcome === "success" ? result : reviewState.outcome;
        finish(controller.signal.aborted ? "cancelled" : settledOutcome);
      } catch (error) {
        const failure =
          error instanceof ReviewTimeoutError ? "timeout" : "failed";
        finish(controller.signal.aborted ? "cancelled" : failure);
      } finally {
        job.stats.settle(job.id);
        accounting.retain(job.stats);
        controllers.delete(controller);
        cancelJobs.delete(controller);
      }
    })();
  }

  function active(job: ReviewJob): boolean {
    checkReset?.();
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

  async function runJob(
    job: ReviewJob,
    signal: AbortSignal,
    onModelCall: ModelCallObserver,
  ): Promise<ReviewOutcome> {
    const proposed = await reviewFile({
      host: job.host,
      cwd: job.cwd,
      model: job.model,
      prompt: job.reviewer.prompt,
      file: job.file,
      source: job.source,
      signal,
      onModelCall,
    });
    if (!(await current(job))) {
      logger?.log("review.skipped", {
        sessionId: job.stats.sessionId,
        jobId: job.id,
        reasonCode: "stale",
      });
      return "obsolete";
    }
    const reviewer = reviewerKey(job.reviewer);
    if (proposed.length === 0) {
      reviewed.set(`${job.key}:${reviewer}:${job.model}`, job.revision);
      return "success";
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
          onModelCall,
        }),
      })),
    );
    logger?.log("finding.filtered", {
      sessionId: job.stats.sessionId,
      jobId: job.id,
      reasonCode: "inherited",
      count: judged.filter(({ inherited }) => inherited).length,
    });
    if (signal.aborted || !(await current(job))) return "obsolete";
    const result = await admission.admit({
      file: job.file,
      reviewer,
      revision: job.revision,
      findings: judged.flatMap(({ finding, inherited }) =>
        inherited ? [] : [finding],
      ),
      signal,
      isCurrent: () => current(job),
      onModelCall,
    });
    logger?.log("finding.admission", {
      sessionId: job.stats.sessionId,
      jobId: job.id,
      outcome: result,
    });
    if (result === "obsolete") return "obsolete";
    if (result === "added") scheduleWake(job.ctx);
    reviewed.set(`${job.key}:${reviewer}:${job.model}`, job.revision);
    return "success";
  }

  function startReviews(
    base: Omit<ReviewJob, "model" | "reviewer" | "id" | "stats">,
    ctx: ExtensionContext,
  ): void {
    const jobs: ReviewJob[] = [];
    const keys = new Set<string>();
    for (const reviewer of matchingReviewers(base.file, reviewers)) {
      let model = reviewer.model;
      if (model === "current") {
        if (ctx.model === undefined) {
          logger?.log("review.skipped", {
            sessionId: accounting.stats.sessionId,
            reasonCode: "missing_model",
          });
          continue;
        }
        model = `${ctx.model.provider}/${ctx.model.id}`;
      }
      const key = `${base.file}:${reviewerKey(reviewer)}:${model}`;
      if (reviewed.get(key) === base.revision || keys.has(key)) {
        logger?.log("review.skipped", {
          sessionId: accounting.stats.sessionId,
          reasonCode: keys.has(key) ? "duplicate_config" : "unchanged",
        });
        continue;
      }
      keys.add(key);
      const id = randomUUID();
      logger?.log("review.scheduled", {
        sessionId: accounting.stats.sessionId,
        jobId: id,
      });
      jobs.push({ ...base, model, reviewer, id, stats: accounting.stats });
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
    checkReset?.();
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
        if (activeFile === file) {
          cancelJobs.get(controller)?.();
          controller.abort();
        }
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
    stopWatchingResets();
    activeContext = ctx;
    accounting.suspend();
    stop("session_change");
    const session = generation;
    const resolvedRoot = await realpath(ctx.cwd);
    if (session !== generation) return;
    root = resolvedRoot;
    const manager = ctx.sessionManager as Partial<
      ExtensionContext["sessionManager"]
    >;
    accounting.activate(
      manager,
      (data) => {
        pi.appendEntry(STATS_ENTRY, data);
      },
      () =>
        logger?.log("extension.persistence_failed", {
          reasonCode: "persistence_failed",
        }),
    );
    store = new ReviewStore(appendReviewEntry, ctx.sessionManager.getBranch());
    admission = new FindingAdmission(store);
    showState(ctx);
    watchResets(ctx);
    await logging;
    if (session !== generation) return;
    logger?.log("session.start", { sessionId: accounting.stats.sessionId });
    await assessBaseline(event, ctx, session);
    if (session !== generation) return;
    try {
      const loaded = await loadReviewers(ctx.cwd);
      if (session === generation) reviewers = loaded;
    } catch (error) {
      if (session !== generation) return;
      reviewers = [];
      logger?.log("review.skipped", {
        sessionId: accounting.stats.sessionId,
        reasonCode: "configuration_failed",
      });
      ctx.ui.notify(String(error), "warning");
    }
  }

  pi.on("session_start", startSession);
  const beforeSessionChange = (): void => {
    stopWatchingResets();
    stop("session_change");
  };
  pi.on("session_before_switch", beforeSessionChange);
  pi.on("session_before_fork", beforeSessionChange);
  pi.on("session_before_tree", beforeSessionChange);
  const onOmpBeforeBranch = pi.on.bind(pi) as unknown as (
    name: "session_before_branch",
    handler: () => void,
  ) => void;
  onOmpBeforeBranch("session_before_branch", beforeSessionChange);
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

  pi.on("session_tree", (_event, ctx) => startSession({ reason: "tree" }, ctx));

  pi.on("session_shutdown", () => {
    stopWatchingResets();
    stop("shutdown");
    activeContext?.ui.setStatus("pair-programmer", undefined);
    activeContext = undefined;
    accounting.suspend();
    replaceBaseline(undefined);
    baselineSession = undefined;
    const sessionId = accounting.stats.sessionId;

    void (async () => {
      await logging;
      logger?.log("extension.shutdown", { sessionId });
      await logger?.close();
    })();
  });

  pi.on("tool_result", (event, ctx) => {
    checkReset?.();
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
    checkReset?.();
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
    checkReset?.();
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
      checkReset?.();
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
      logger?.log("finding.verdict", {
        sessionId: accounting.stats.sessionId,
        outcome: saved ? params.decision : "invalid",
      });
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
      checkReset?.();
      const enabled = !store.enabled;
      if (!enabled) stop("disabled");
      store.setEnabled(enabled);
      showState(ctx);
      logger?.log("extension.toggle", {
        sessionId: accounting.stats.sessionId,
        outcome: enabled ? "on" : "off",
      });
      ctx.ui.notify(`Pair Programmer ${enabled ? "on" : "off"}.`, "info");
      return Promise.resolve();
    },
  });

  pi.registerCommand("pair-clear", {
    description: "Cancel reviews and clear all review findings",
    handler: (_args, ctx) => {
      checkReset?.();
      stop("cleared");
      store.clear();
      ctx.ui.notify("Pair Programmer reviews cleared.", "info");
      return Promise.resolve();
    },
  });

  pi.registerCommand("pair-stats", {
    description:
      "Show on-demand Pair Programmer activity, findings and extension usage",
    handler: (_args, ctx) => {
      checkReset?.();
      return statsView.open(
        ctx,
        statsLines(accounting.stats.snapshot(), store),
      );
    },
  });
}
