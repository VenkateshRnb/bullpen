import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { authStatus, runAgent } from "./agents.ts";
import { loadConfig, resolveCommand } from "./config.ts";
import { runChecks } from "./gates.ts";
import {
  commitAll,
  diffAgainst,
  dropFileFromBranch,
  ensureIntegration,
  ensureTaskWorktree,
  mergeTask,
  removeWorktree,
  worktreeGitDir,
} from "./git.ts";
import { detectAuthFailure, detectLimit } from "./limits.ts";
import type { LimitVerdict } from "./limits.ts";
import { buildReviewPrompt, buildWorkPrompt, handoffTemplate, readConventions, REVIEW_VERDICT } from "./prompt.ts";
import { acquireLock, loadState, newTaskState, saveState } from "./state.ts";
import { loadTasks } from "./tasks.ts";
import type { Attempt, Config, State, Task, TaskState } from "./types.ts";
import { hhmm, sleep as realSleep, stamp, tail } from "./util.ts";

export interface Deps {
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(msg: string): void;
}

export interface RunOptions {
  once?: boolean;
  concurrency?: number;
  deps?: Partial<Deps>;
  signal?: AbortSignal;
  config?: Partial<Config>;
}

export interface RunSummary {
  reason: "all_done" | "stuck" | "waiting" | "aborted";
  done: string[];
  needsHuman: string[];
  waitingUntil?: string;
  message: string;
}

const AUTH_RECHECK_MS = 5 * 60_000;

/** Outcomes that count against a task's attempt budget. A limit hit is not the task's fault. */
const FAIL_OUTCOMES = new Set(["checks_failed", "error", "timeout", "crashed"]);

export async function runBullpen(repo: string, opts: RunOptions = {}): Promise<RunSummary> {
  const cfg = loadConfig(repo, { ...(opts.config ?? {}), ...(opts.concurrency ? { concurrency: opts.concurrency } : {}) });
  const deps: Deps = {
    now: () => new Date(),
    sleep: realSleep,
    log: (m) => console.log(m),
    ...opts.deps,
  };
  const release = acquireLock(repo);
  try {
    const engine = new Engine(repo, cfg, deps, opts.signal);
    return await engine.run(opts.once ?? false);
  } finally {
    release();
  }
}

class Engine {
  repo: string;
  cfg: Config;
  deps: Deps;
  signal?: AbortSignal;
  state!: State;
  tasks: Task[] = [];
  commands: Record<string, string | null> = {};
  integrationWt = "";
  inflight = new Map<string, Promise<void>>();
  busy = new Set<string>();
  /**
   * Agents rested because they are signed out, with the time they were rested. They are re-checked
   * while we wait so a sign-in is noticed, but never sooner than AUTH_RECHECK_MS: a probe and a real
   * run can disagree, and an instant re-check would loop on the same failure.
   */
  authBlocked = new Map<string, number>();
  mergeChain: Promise<void> = Promise.resolve();

  constructor(repo: string, cfg: Config, deps: Deps, signal?: AbortSignal) {
    this.repo = repo;
    this.cfg = cfg;
    this.deps = deps;
    this.signal = signal;
  }

  /* ---------- plumbing ---------- */

  log(msg: string): void {
    const now = this.deps.now();
    this.deps.log(`${stamp(now)}  ${msg}`);
    if (this.state) {
      this.state.events.push({ ts: now.toISOString(), msg });
      if (this.state.events.length > 200) this.state.events.shift();
    }
    try {
      mkdirSync(join(this.repo, ".bullpen", "logs"), { recursive: true });
      appendFileSync(join(this.repo, ".bullpen", "logs", "bullpen.log"), `${now.toISOString()}  ${msg}\n`);
    } catch {
      /* logging must never break the run */
    }
  }

  save(): void {
    saveState(this.repo, this.state);
    try {
      writeFileSync(join(this.repo, ".bullpen", "STATUS.md"), renderStatus(this));
    } catch {
      /* status page is a convenience */
    }
  }

  private refresh(): void {
    try {
      this.tasks = loadTasks(join(this.repo, ".bullpen", "tasks"));
    } catch (e) {
      this.log(`task files are invalid, keeping the previous list: ${(e as Error).message}`);
    }
    for (const t of this.tasks) if (!this.state.tasks[t.id]) this.state.tasks[t.id] = newTaskState(t.id);
  }

  /* ---------- agents ---------- */

  blockedUntil(name: string): Date | undefined {
    const s = this.state.agents[name]?.blockedUntil;
    return s ? new Date(s) : undefined;
  }

  private usable(name: string): boolean {
    return !!this.cfg.agents[name]?.enabled && !!this.commands[name];
  }

  private available(name: string): boolean {
    if (!this.usable(name) || this.busy.has(name)) return false;
    const b = this.blockedUntil(name);
    return !b || b.getTime() <= this.deps.now().getTime();
  }

  /**
   * Routing says who is preferred, not who is allowed: any other enabled agent is a fallback, so a
   * task never stalls just because its preferred agents are missing. An explicit `agents:` list on
   * the task is a hard pin.
   */
  private order(t: Task): string[] {
    if (t.agents) return t.agents;
    const preferred = this.cfg.routing[t.kind] ?? this.cfg.routing.default ?? [];
    return [...preferred, ...Object.keys(this.cfg.agents).filter((n) => !preferred.includes(n))];
  }

  private excludedFor(ts: TaskState, role: "work" | "review"): Set<string> {
    const ex = new Set(ts.excluded);
    if (role === "review" && !this.cfg.allowSelfReview && ts.lastAuthor) ex.add(ts.lastAuthor);
    return ex;
  }

  private pick(t: Task, ts: TaskState, role: "work" | "review"): string | null {
    const ex = this.excludedFor(ts, role);
    return this.order(t).find((n) => this.cfg.agents[n] && !ex.has(n) && this.available(n)) ?? null;
  }

  private couldEverRun(t: Task, ts: TaskState, role: "work" | "review"): boolean {
    const ex = this.excludedFor(ts, role);
    return this.order(t).some((n) => this.cfg.agents[n] && !ex.has(n) && this.usable(n));
  }

  private blockAgent(agent: string, v: LimitVerdict): void {
    const a = (this.state.agents[agent] ??= { hits: 0 });
    a.hits++;
    const now = this.deps.now();
    let until: Date;
    if (v.resetAt) until = v.resetAt;
    else if (v.kind === "credits") until = new Date(now.getTime() + 6 * 3_600_000);
    else {
      const minutes = Math.min(this.cfg.agents[agent].cooldownMinutes * 2 ** Math.min(a.hits - 1, 3), 300);
      until = new Date(now.getTime() + minutes * 60_000);
    }
    a.blockedUntil = until.toISOString();
    a.lastReason = v.reason;
    this.log(`${agent} is out of budget (${v.reason || "limit"}); resting until ${hhmm(until)}`);
  }

  private blockUnavailable(agent: string, minutes: number, why: string): void {
    const a = (this.state.agents[agent] ??= { hits: 0 });
    const until = new Date(this.deps.now().getTime() + minutes * 60_000);
    a.blockedUntil = until.toISOString();
    a.lastReason = why;
    this.log(`${agent}: ${why}; resting until ${hhmm(until)}`);
  }

  private blockAuth(agent: string): void {
    this.authBlocked.set(agent, this.deps.now().getTime());
    this.blockUnavailable(agent, 12 * 60, "not signed in (sign in once in a terminal; see: bullpen doctor)");
  }

  /** Called while idle: if a rested agent has since been signed in, let it back in. */
  private recheckAuth(): void {
    const now = this.deps.now().getTime();
    for (const [name, since] of [...this.authBlocked]) {
      if (now - since < AUTH_RECHECK_MS) continue;
      if (authStatus(this.commands[name]!, this.cfg.agents[name]) === "not_signed_in") continue;
      this.authBlocked.delete(name);
      const a = this.state.agents[name];
      if (a) a.blockedUntil = undefined;
      this.log(`${name} is signed in again`);
    }
  }

  private markHealthy(agent: string): void {
    const a = this.state.agents[agent];
    if (a) a.hits = 0;
  }

  /* ---------- main loop ---------- */

  async run(once: boolean): Promise<RunSummary> {
    this.state = loadState(this.repo);
    for (const [name, a] of Object.entries(this.cfg.agents)) {
      this.commands[name] = a.enabled ? resolveCommand(name, a) : null;
    }
    for (const name of Object.keys(this.cfg.agents)) {
      if (!this.usable(name)) continue;
      const st = authStatus(this.commands[name]!, this.cfg.agents[name]);
      if (st === "not_signed_in") this.blockAuth(name);
      else if (this.state.agents[name]?.lastReason?.startsWith("not signed in")) {
        this.state.agents[name].blockedUntil = undefined; // signed in since the last run
      }
    }
    this.integrationWt = await ensureIntegration(this.repo, this.cfg);
    this.reconcile();
    this.refresh();
    if (this.tasks.length === 0) {
      this.save();
      return this.summary("all_done", "No tasks found in .bullpen/tasks.");
    }
    this.log(
      "agents: " +
        Object.keys(this.cfg.agents)
          .map((n) => `${n}=${this.authBlocked.has(n) ? "needs sign-in" : this.usable(n) ? "ready" : "unavailable"}`)
          .join(", "),
    );

    while (true) {
      if (this.signal?.aborted) {
        await Promise.allSettled([...this.inflight.values()]);
        this.save();
        return this.summary("aborted", "Stopped. Unfinished work is committed on its task branches.");
      }
      if (this.authBlocked.size && this.inflight.size === 0) this.recheckAuth();
      this.refresh();
      const unfinished = this.tasks.filter((t) => !["done", "needs_human"].includes(this.state.tasks[t.id].status));
      if (unfinished.length === 0 && this.inflight.size === 0) {
        this.save();
        return this.summary("all_done", "Every task is merged or waiting for you.");
      }

      let noAgentFor = 0;
      for (const t of unfinished) {
        if (this.inflight.size >= this.cfg.concurrency) break;
        if (!this.ready(t)) continue;
        if (this.tryStart(t) === "no_agent") noAgentFor++;
      }
      this.save();

      if (this.inflight.size > 0) {
        await Promise.race([...this.inflight.values()]);
        continue;
      }
      if (noAgentFor === 0) {
        this.save();
        return this.summary("stuck", "Remaining tasks wait on tasks that need a human, or nothing is runnable.");
      }
      const wake = this.nextWake();
      if (!wake) {
        return this.summary("stuck", "No agent is installed or enabled for the remaining tasks. Run: bullpen doctor");
      }
      this.log(`all suitable agents are resting; next one returns at ${hhmm(wake)}`);
      if (once) return this.summary("waiting", `Waiting for an agent until ${hhmm(wake)}.`, wake);
      const wait = Math.min(Math.max(wake.getTime() - this.deps.now().getTime(), 1000) + 1000, this.cfg.pollSeconds * 1000);
      await this.deps.sleep(wait);
    }
  }

  private summary(reason: RunSummary["reason"], message: string, waiting?: Date): RunSummary {
    const ids = (s: string) => this.tasks.filter((t) => this.state.tasks[t.id]?.status === s).map((t) => t.id);
    return { reason, message, done: ids("done"), needsHuman: ids("needs_human"), waitingUntil: waiting?.toISOString() };
  }

  private reconcile(): void {
    // We hold the lock, so any "running" entry is left over from a crashed or stopped run.
    for (const [id, ts] of Object.entries(this.state.tasks)) {
      if (ts.status === "running") {
        ts.status = "pending";
        const last = ts.attempts[ts.attempts.length - 1];
        if (last && !last.endedAt) {
          last.outcome = "interrupted";
          last.endedAt = this.deps.now().toISOString();
        }
        this.log(`${id}: recovered from an interrupted run`);
      }
    }
  }

  private ready(t: Task): boolean {
    const ts = this.state.tasks[t.id];
    if (!["pending", "awaiting_review"].includes(ts.status)) return false;
    if (this.inflight.has(t.id)) return false;
    return t.dependsOn.every((d) => this.state.tasks[d]?.status === "done");
  }

  private nextWake(): Date | undefined {
    const now = this.deps.now().getTime();
    let best: Date | undefined;
    for (const name of Object.keys(this.cfg.agents)) {
      if (!this.usable(name)) continue;
      const b = this.blockedUntil(name);
      if (b && b.getTime() > now && (!best || b < best)) best = b;
    }
    return best;
  }

  private tryStart(t: Task): "started" | "no_agent" | "dead" {
    const ts = this.state.tasks[t.id];
    const role = ts.status === "awaiting_review" ? "review" : "work";
    const agent = this.pick(t, ts, role);
    if (!agent) {
      if (!this.couldEverRun(t, ts, role)) {
        ts.status = "needs_human";
        ts.lastError =
          role === "review"
            ? "no second agent is available to review (install one, or set review: false on the task)"
            : "every suitable agent is excluded or not installed";
        this.log(`${t.id}: needs a human: ${ts.lastError}`);
        return "dead";
      }
      return "no_agent";
    }
    this.busy.add(agent);
    const job = (role === "review" ? this.review(t, agent) : this.work(t, agent))
      .catch((e) => this.log(`${t.id}: internal error: ${(e as Error).stack ?? e}`))
      .finally(() => {
        this.busy.delete(agent);
        this.inflight.delete(t.id);
      });
    this.inflight.set(t.id, job);
    return "started";
  }

  /* ---------- one work attempt ---------- */

  /**
   * Runs the configured setup commands in a worktree once, before any agent starts, so checks and
   * agents find the project's dependencies installed. A marker in the worktree's private git
   * directory records that setup ran for exactly these commands: resumed attempts and reviews skip
   * it, a recreated worktree runs it again, and changing the commands reruns it. A failing setup is
   * an environment problem, not the agent's, so the task goes to a human and no agent is started.
   */
  private async prepareWorktree(t: Task, wt: string, ts: TaskState, attempt: Attempt): Promise<boolean> {
    const cmds = this.cfg.setup;
    if (cmds.length === 0) return true;
    const marker = join(await worktreeGitDir(wt), "bullpen-setup");
    const signature = createHash("sha256").update(JSON.stringify(cmds)).digest("hex");
    if (existsSync(marker) && readFileSync(marker, "utf8") === signature) return true;

    this.log(`${t.id}: preparing the worktree (${cmds.join(" && ")})`);
    const res = await runChecks(cmds, wt, this.cfg.setupTimeoutMinutes * 60_000);
    const logFile = join(this.repo, ".bullpen", "logs", `${t.id}-setup.log`);
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(logFile, `${res.report}\n`);
    if (!res.ok) {
      attempt.outcome = "setup_failed";
      attempt.note = res.report.slice(0, 600);
      ts.status = "needs_human";
      ts.lastError = `worktree setup failed: ${res.report.replace(/\s+/g, " ").slice(0, 300)}`;
      this.log(`${t.id}: worktree setup failed, needs a human (see ${logFile})`);
      return false;
    }
    writeFileSync(marker, signature);
    return true;
  }

  private async checkpoint(wt: string, message: string): Promise<void> {
    try {
      await commitAll(wt, message);
    } catch (e) {
      this.log(`could not commit in ${wt}: ${(e as Error).message}`);
    }
  }

  private async appendHandoff(wt: string, text: string, msg: string): Promise<void> {
    const p = join(wt, "HANDOFF.md");
    const prev = existsSync(p) ? readFileSync(p, "utf8") : "";
    writeFileSync(p, `${prev.trimEnd()}\n\n---\n${text.trim()}\n`);
    await this.checkpoint(wt, msg);
  }

  private async work(t: Task, agent: string): Promise<void> {
    const ts = this.state.tasks[t.id];
    const n = ts.attempts.length + 1;
    const attempt: Attempt = { n, agent, role: "work", startedAt: this.deps.now().toISOString(), outcome: "running" };
    ts.attempts.push(attempt);
    ts.status = "running";
    this.log(`${t.id}: ${agent} starts attempt ${n}`);
    this.save();

    try {
      const wt = await ensureTaskWorktree(this.repo, t.id, this.cfg);
      if (!(await this.prepareWorktree(t, wt, ts, attempt))) return;
      const handoffPath = join(wt, "HANDOFF.md");
      if (!existsSync(handoffPath)) writeFileSync(handoffPath, handoffTemplate(t.id));
      const prompt = buildWorkPrompt({
        task: t,
        agent,
        attempt: n,
        conventions: readConventions(wt, this.cfg.conventionsFiles),
        handoff: readFileSync(handoffPath, "utf8"),
      });
      const logFile = join(this.repo, ".bullpen", "logs", `${t.id}-${n}-${agent}.log`);
      attempt.log = logFile;
      const res = await runAgent(this.commands[agent]!, this.cfg.agents[agent], {
        cwd: wt,
        prompt,
        review: false,
        timeoutMs: this.cfg.taskTimeoutMinutes * 60_000,
        logFile,
        signal: this.signal,
      });
      const verdict = detectLimit(res.output, res.exitCode, this.deps.now());
      await this.checkpoint(wt, `wip(${t.id}): ${agent} attempt ${n}`);

      if (this.signal?.aborted) {
        attempt.outcome = "interrupted";
        ts.status = "pending";
      } else if (res.spawnFailed) {
        attempt.outcome = "spawn_failed";
        attempt.note = tail(res.output, 300);
        this.blockUnavailable(agent, 30, "could not start");
        ts.status = "pending";
      } else if (detectAuthFailure(res.output, res.exitCode)) {
        attempt.outcome = "auth_required";
        attempt.note = tail(res.output, 200);
        this.blockAuth(agent);
        ts.status = "pending";
      } else if (verdict.hit) {
        attempt.outcome = "limit";
        attempt.note = verdict.reason;
        this.blockAgent(agent, verdict);
        await this.appendHandoff(
          wt,
          `Bullpen note: ${agent} stopped at ${hhmm(this.deps.now())} because its usage limit was reached. Everything it finished is committed. Continue from the last commit and the notes above.`,
          `chore(${t.id}): note ${agent} hit its limit`,
        );
        ts.status = "pending";
      } else if (res.timedOut) {
        attempt.outcome = "timeout";
        await this.appendHandoff(
          wt,
          `Bullpen note: ${agent} ran out of time (${this.cfg.taskTimeoutMinutes} min) and was stopped. Its work is committed. Continue from here with a smaller step.`,
          `chore(${t.id}): note ${agent} timed out`,
        );
        ts.status = "pending";
      } else if (res.exitCode !== 0) {
        attempt.outcome = "error";
        attempt.note = tail(res.output, 300);
        const errors = ts.attempts.filter((a) => a.agent === agent && a.outcome === "error").length;
        if (errors >= 2 && !ts.excluded.includes(agent)) {
          ts.excluded.push(agent);
          this.log(`${t.id}: ${agent} failed twice, skipping it for this task`);
        }
        ts.status = "pending";
      } else {
        this.markHealthy(agent);
        const gate = await runChecks(t.check, wt, this.cfg.checkTimeoutMinutes * 60_000);
        if (!gate.ok) {
          attempt.outcome = "checks_failed";
          attempt.note = gate.report.slice(0, 600);
          ts.lastError = gate.report.slice(0, 600);
          await this.appendHandoff(
            wt,
            `Bullpen note: acceptance checks FAILED after ${agent}'s attempt. Fix these before anything else:\n\n${gate.report}`,
            `chore(${t.id}): record failing checks`,
          );
          ts.status = "pending";
        } else {
          attempt.outcome = "work_done";
          ts.lastAuthor = agent;
          ts.lastError = undefined;
          this.log(`${t.id}: ${agent} finished and the checks pass`);
          const wantReview = t.review ?? this.cfg.review;
          if (wantReview) ts.status = "awaiting_review";
          else await this.merge(t, wt);
        }
      }
    } catch (e) {
      attempt.outcome = "crashed";
      attempt.note = (e as Error).message;
      ts.lastError = (e as Error).message;
      ts.status = "pending";
      this.log(`${t.id}: attempt crashed: ${(e as Error).message}`);
    } finally {
      attempt.endedAt = this.deps.now().toISOString();
      const failures = ts.attempts.filter((a) => a.role === "work" && FAIL_OUTCOMES.has(a.outcome)).length;
      if (ts.status === "pending" && failures >= this.cfg.maxAttemptsPerTask) {
        ts.status = "needs_human";
        this.log(`${t.id}: ${failures} failed attempts, needs a human`);
      }
      this.save();
    }
  }

  /* ---------- one review ---------- */

  private async review(t: Task, agent: string): Promise<void> {
    const ts = this.state.tasks[t.id];
    const n = ts.attempts.length + 1;
    const attempt: Attempt = { n, agent, role: "review", startedAt: this.deps.now().toISOString(), outcome: "running" };
    ts.attempts.push(attempt);
    this.log(`${t.id}: ${agent} reviews`);
    this.save();

    try {
      const wt = await ensureTaskWorktree(this.repo, t.id, this.cfg);
      if (!(await this.prepareWorktree(t, wt, ts, attempt))) return;
      const { stat, diff } = await diffAgainst(wt, this.cfg.integrationBranch);
      const prompt = buildReviewPrompt({
        task: t,
        agent,
        conventions: readConventions(wt, this.cfg.conventionsFiles),
        stat,
        diff,
        checksReport: "All acceptance checks passed.",
      });
      const logFile = join(this.repo, ".bullpen", "logs", `${t.id}-${n}-${agent}-review.log`);
      attempt.log = logFile;
      const res = await runAgent(this.commands[agent]!, this.cfg.agents[agent], {
        cwd: wt,
        prompt,
        review: true,
        timeoutMs: this.cfg.taskTimeoutMinutes * 60_000,
        logFile,
        signal: this.signal,
      });
      const verdict = detectLimit(res.output, res.exitCode, this.deps.now());
      const marks = [...res.output.matchAll(REVIEW_VERDICT)];
      const last = marks[marks.length - 1];

      if (this.signal?.aborted) {
        attempt.outcome = "interrupted";
      } else if (res.spawnFailed) {
        attempt.outcome = "spawn_failed";
        this.blockUnavailable(agent, 30, "could not start");
      } else if (!last && detectAuthFailure(res.output, res.exitCode)) {
        attempt.outcome = "auth_required";
        attempt.note = tail(res.output, 200);
        this.blockAuth(agent);
      } else if (verdict.hit && !last) {
        attempt.outcome = "limit";
        attempt.note = verdict.reason;
        this.blockAgent(agent, verdict);
      } else if (!last) {
        attempt.outcome = res.timedOut ? "timeout" : "review_unclear";
        attempt.note = tail(res.output, 300);
        const bad = ts.attempts.filter((a) => a.role === "review" && a.agent === agent && a.outcome !== "limit").length;
        if (bad >= 2 && !ts.excluded.includes(agent)) ts.excluded.push(agent);
      } else if (last[1].toUpperCase() === "APPROVE") {
        this.markHealthy(agent);
        attempt.outcome = "approved";
        this.log(`${t.id}: ${agent} approved`);
        await this.merge(t, wt);
      } else {
        this.markHealthy(agent);
        attempt.outcome = "changes_requested";
        const feedback = tail(res.output.slice(0, last.index ?? res.output.length).trim(), 3000);
        ts.reviewRounds++;
        this.log(`${t.id}: ${agent} asked for changes (round ${ts.reviewRounds})`);
        if (ts.reviewRounds > this.cfg.maxReviewRounds) {
          ts.status = "needs_human";
          ts.lastError = "still not approved after the allowed review rounds";
        } else {
          await this.appendHandoff(
            wt,
            `Bullpen note: reviewer ${agent} requested changes (round ${ts.reviewRounds}). Address these blocking points:\n\n${feedback}`,
            `chore(${t.id}): record review feedback`,
          );
          ts.status = "pending";
        }
      }
    } catch (e) {
      attempt.outcome = "crashed";
      attempt.note = (e as Error).message;
      this.log(`${t.id}: review crashed: ${(e as Error).message}`);
    } finally {
      attempt.endedAt = this.deps.now().toISOString();
      this.save();
    }
  }

  /* ---------- merge ---------- */

  private merge(t: Task, wt: string): Promise<void> {
    const run = async () => {
      const ts = this.state.tasks[t.id];
      const handoff = join(wt, "HANDOFF.md");
      if (existsSync(handoff)) {
        const dir = join(this.repo, ".bullpen", "handoff-archive");
        mkdirSync(dir, { recursive: true });
        copyFileSync(handoff, join(dir, `${t.id}.md`));
        await dropFileFromBranch(wt, "HANDOFF.md", `chore(${t.id}): drop handoff before merge`);
      }
      const r = await mergeTask(this.integrationWt, ts.branch, `Merge ${t.id}`);
      if (!r.ok) {
        ts.status = "needs_human";
        ts.lastError = `merge conflict: ${r.error}`;
        this.log(`${t.id}: merge conflict, needs a human`);
        return;
      }
      ts.status = "done";
      ts.mergedAt = this.deps.now().toISOString();
      this.log(`${t.id}: merged into ${this.cfg.integrationBranch}`);
      await removeWorktree(this.repo, wt);
    };
    const p = this.mergeChain.then(run);
    this.mergeChain = p.catch(() => {});
    return p;
  }
}

/* ---------- human-readable status page ---------- */

function renderStatus(e: Engine): string {
  const now = e.deps.now();
  const L: string[] = [`# Bullpen status`, ``, `Updated ${stamp(now)}`, ``, `## Agents`, `| agent | state | detail |`, `|---|---|---|`];
  for (const [name, a] of Object.entries(e.cfg.agents)) {
    const blocked = e.blockedUntil(name);
    let st = "ready";
    if (!a.enabled) st = "disabled";
    else if (!e.commands[name]) st = "not installed";
    else if (e.busy.has(name)) st = "working";
    else if (blocked && blocked > now) st = `resting until ${hhmm(blocked)}`;
    L.push(`| ${name} | ${st} | ${e.state.agents[name]?.lastReason ?? ""} |`);
  }
  L.push(``, `## Tasks`, `| task | kind | status | attempts | note |`, `|---|---|---|---|---|`);
  for (const t of e.tasks) {
    const ts = e.state.tasks[t.id];
    const last = ts.attempts[ts.attempts.length - 1];
    const note = ts.lastError ? ts.lastError.replace(/\s+/g, " ").slice(0, 90) : last ? `${last.agent}: ${last.outcome}` : "";
    L.push(`| ${t.id} | ${t.kind} | ${ts.status} | ${ts.attempts.length} | ${note} |`);
  }
  L.push(``, `## Recent events`);
  for (const ev of e.state.events.slice(-15)) L.push(`- ${stamp(new Date(ev.ts))}  ${ev.msg}`);
  return L.join("\n") + "\n";
}
