import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { z } from "zod";
import { deduplicate, reviewFile, type Host } from "./review-runner.js";
import { ReviewStore, type Finding } from "./review-store.js";
import {
  DEFAULT_REVIEWERS,
  loadReviewers,
  matchingReviewers,
  reviewerKey,
  type ReviewerConfig,
} from "./reviewers.js";

const MAX_ACTIVE_REVIEWERS = 2;
const MAX_DELIVERY = 4;
const ToolPathSchema = z.string();

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

export default function pairProgrammer(pi: ExtensionAPI): void {
  const appendReviewEntry = (data: unknown): void => {
    pi.appendEntry("pair-programmer", data);
  };
  let store = new ReviewStore(appendReviewEntry);
  let reviewers: readonly ReviewerConfig[] = DEFAULT_REVIEWERS;
  let root = process.cwd();
  let generation = 0;
  let active = 0;
  let unresolved = 0;
  let nextVersion = 0;
  let pending: ReviewJob[] = [];
  const versions = new Map<string, number>();
  const reviewed = new Map<string, string>();
  const timers = new Map<string, NodeJS.Timeout>();
  const controllers = new Map<AbortController, string>();

  function stop(): void {
    generation += 1;
    active = 0;
    unresolved = 0;
    pending = [];
    versions.clear();
    reviewed.clear();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const controller of controllers.keys()) controller.abort();
    controllers.clear();
  }

  function deliver(): void {
    if (!store.enabled || unresolved > 0 || store.outstanding().length > 0)
      return;
    const batch = store
      .ready()
      .filter((finding) => !timers.has(finding.file))
      .slice(0, MAX_DELIVERY);
    if (batch.length === 0) return;
    pi.sendMessage(
      {
        customType: "pair-programmer-findings",
        content: describe(batch),
        display: true,
      },
      { deliverAs: "nextTurn", triggerTurn: false },
    );
    store.deliver(batch.map((finding) => finding.id));
  }

  function pump(): void {
    while (active < MAX_ACTIVE_REVIEWERS && store.enabled) {
      const job = pending.shift();
      if (job === undefined) return;
      if (
        reviewed.get(`${job.key}:${reviewerKey(job.reviewer)}:${job.model}`) ===
        job.revision
      )
        continue;
      const controller = new AbortController();
      controllers.set(controller, job.key);
      active += 1;
      void runJob(job, controller.signal)
        .catch(() => {
          return;
        })
        .finally(() => {
          controllers.delete(controller);
          if (job.session !== generation) return;
          active -= 1;
          pump();
        });
    }
  }

  async function current(job: ReviewJob): Promise<boolean> {
    if (
      !store.enabled ||
      job.session !== generation ||
      job.version !== versions.get(job.key)
    ) {
      return false;
    }
    try {
      return (
        (await realpath(job.fullPath)) === job.fullPath &&
        revisionOf(await readFile(job.fullPath, "utf8")) === job.revision
      );
    } catch {
      return false;
    }
  }

  let deduplication = Promise.resolve(null);

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
    const candidates: Finding[] = proposed.map((finding) => ({
      id: createHash("sha256")
        .update(
          JSON.stringify([
            job.file,
            reviewer,
            finding.title.toLowerCase().trim(),
            finding.quote.trim(),
          ]),
        )
        .digest("hex")
        .slice(0, 16),
      reviewer,
      file: job.file,
      revision: job.revision,
      line: finding.line,
      title: finding.title,
      evidence: `${finding.quote} — ${finding.evidence}`,
    }));

    const insert = async (): Promise<void> => {
      if (!(await current(job))) return;
      const history = store.history(job.file);
      let novel: readonly Finding[];
      try {
        novel = await deduplicate({ candidates, history, signal });
      } catch {
        novel = candidates.filter((candidate) =>
          history.every(({ finding }) => finding.id !== candidate.id),
        );
      }
      if (!(await current(job))) return;
      for (const finding of novel) store.add(finding);
      reviewed.set(`${job.key}:${reviewer}:${job.model}`, job.revision);
    };
    const previous = deduplication;
    const { promise, resolve: release } = Promise.withResolvers<null>();
    deduplication = promise;
    await previous;
    try {
      await insert();
    } finally {
      release(null);
    }
  }

  function enqueueReviews(
    base: Omit<ReviewJob, "model" | "reviewer">,
    ctx: ExtensionContext,
  ): void {
    for (const reviewer of matchingReviewers(base.file, reviewers)) {
      let model = reviewer.model;
      if (model === "current") {
        if (ctx.model === undefined) continue;
        model = `${ctx.model.provider}/${ctx.model.id}`;
      }
      if (
        reviewed.get(`${base.file}:${reviewerKey(reviewer)}:${model}`) ===
        base.revision
      )
        continue;
      pending.push({ ...base, model, reviewer });
    }
    pump();
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
      const host: Host =
        typeof ctx.modelRegistry.streamSimple === "function" ? "pi" : "omp";
      enqueueReviews(
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
      pending = pending.filter((job) => job.key !== file);
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

  pi.on("session_start", async (_event, ctx) => {
    stop();
    root = await realpath(ctx.cwd);
    store = new ReviewStore(appendReviewEntry, ctx.sessionManager.getBranch());
    try {
      reviewers = await loadReviewers(ctx.cwd);
    } catch (error) {
      reviewers = [];
      ctx.ui.notify(String(error), "warning");
    }
  });

  pi.on("session_shutdown", () => {
    stop();
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

  pi.on("tool_call", (event) => {
    if (
      !store.enabled ||
      event.toolName === "pair_programmer_decide" ||
      (event.toolName === "write" &&
        event.input.path === "xd://pair_programmer_decide")
    )
      return;
    deliver();
    const outstanding = store.outstanding();
    if (outstanding.length > 0) {
      return { block: true, reason: describe(outstanding) };
    }
  });

  pi.registerTool({
    name: "pair_programmer_decide",
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
      const saved = store.decide(
        params.findingId,
        params.decision,
        params.reason,
      );
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
