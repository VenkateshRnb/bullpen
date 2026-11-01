import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runBullpen } from "../src/engine.ts";
import { loadState } from "../src/state.ts";
import { fakeClock, makeRepo, taskFile } from "./helpers.ts";

const T = { timeout: 180_000 };
const integration = (repo: string) => join(repo, ".bullpen", "worktrees", "_integration");
const outputs = (repo: string, id: string) => loadState(repo).tasks[id].attempts.map((a) => `${a.agent}:${a.role}:${a.outcome}`);

test("happy path: work, review by the other agent, merge", T, async () => {
  const { repo } = makeRepo({ tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"]) } });
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.equal(s.reason, "all_done");
  assert.deepEqual(s.done, ["t1"]);
  assert.ok(existsSync(join(integration(repo), "out-t1.txt")), "work is on the integration branch");
  assert.ok(!existsSync(join(integration(repo), "HANDOFF.md")), "handoff is not merged");
  assert.ok(existsSync(join(repo, ".bullpen", "handoff-archive", "t1.md")), "handoff is archived");
  assert.deepEqual(outputs(repo, "t1"), ["a:work:work_done", "b:review:approved"]);
});

test("limit failover: the next agent continues from the first agent's committed work", T, async () => {
  const { repo } = makeRepo({
    tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"]) },
    script: { a: ["partial_limit"] },
  });
  const clock = fakeClock();
  const start = clock.time;
  const s = await runBullpen(repo, { deps: clock });
  assert.equal(s.reason, "all_done");
  assert.deepEqual(s.done, ["t1"]);
  // a stopped on its limit, b finished, then a (after resting) reviewed.
  assert.deepEqual(outputs(repo, "t1"), ["a:work:limit", "b:work:work_done", "a:review:approved"]);
  const wt = integration(repo);
  assert.ok(existsSync(join(wt, "partial-t1.txt")), "a's half-finished work survived");
  assert.ok(existsSync(join(wt, "out-t1.txt")), "b finished the job");
  const archive = readFileSync(join(repo, ".bullpen", "handoff-archive", "t1.md"), "utf8");
  assert.match(archive, /a stopped at .* usage limit was reached/);
  assert.ok(clock.time > start + 3 * 3_600_000, "the clock waited for a's reset before a could review");
});

test("failing checks send the task back with the failure recorded", T, async () => {
  const { repo } = makeRepo({
    tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"]) },
    script: { a: ["nofile", "ok"] },
  });
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.equal(s.reason, "all_done");
  assert.deepEqual(outputs(repo, "t1"), ["a:work:checks_failed", "a:work:work_done", "b:review:approved"]);
  const archive = readFileSync(join(repo, ".bullpen", "handoff-archive", "t1.md"), "utf8");
  assert.match(archive, /acceptance checks FAILED/);
});

test("an agent that crashes twice is skipped for that task", T, async () => {
  const { repo } = makeRepo({
    tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"], "review: false\n") },
    script: { a: ["crash", "crash"] },
  });
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.equal(s.reason, "all_done");
  assert.deepEqual(s.done, ["t1"]);
  assert.deepEqual(loadState(repo).tasks.t1.excluded, ["a"]);
  assert.deepEqual(outputs(repo, "t1"), ["a:work:error", "a:work:error", "b:work:work_done"]);
});

test("when every agent is resting, a --once run reports when to come back", T, async () => {
  const { repo } = makeRepo({
    tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"]) },
    script: { a: ["partial_limit"], b: ["partial_limit"] },
  });
  const s = await runBullpen(repo, { deps: fakeClock(), once: true });
  assert.equal(s.reason, "waiting");
  assert.ok(s.waitingUntil);
  const st = loadState(repo);
  assert.ok(st.agents.a.blockedUntil && st.agents.b.blockedUntil);
  assert.equal(st.tasks.t1.status, "pending");
});

test("dependencies run in order", T, async () => {
  const { repo, git } = makeRepo({
    tasks: {
      "010-first": taskFile("impl", ["node check.mjs out-010-first.txt"]),
      "020-second": taskFile("impl", ["node check.mjs out-020-second.txt"], "depends_on: [010-first]\n"),
    },
  });
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.equal(s.reason, "all_done");
  assert.deepEqual(s.done.sort(), ["010-first", "020-second"]);
  const log = git("log", "bullpen/integration", "--format=%s").split("\n");
  assert.ok(log.indexOf("Merge 020-second") < log.indexOf("Merge 010-first"), "second merged after first");
});

test("review asks for changes once, then approves", T, async () => {
  const { repo } = makeRepo({
    tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"]) },
    script: { a: ["ok", "ok"] },
    review: { b: ["changes", "approve"] },
  });
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.equal(s.reason, "all_done");
  assert.equal(loadState(repo).tasks.t1.reviewRounds, 1);
  assert.deepEqual(outputs(repo, "t1"), ["a:work:work_done", "b:review:changes_requested", "a:work:work_done", "b:review:approved"]);
  const archive = readFileSync(join(repo, ".bullpen", "handoff-archive", "t1.md"), "utf8");
  assert.match(archive, /reviewer b requested changes/);
});

test("a run that was killed mid-task is picked up again", T, async () => {
  const { repo } = makeRepo({ tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"]) } });
  writeFileSync(
    join(repo, ".bullpen", "state.json"),
    JSON.stringify({
      version: 1,
      agents: {},
      events: [],
      tasks: {
        t1: {
          status: "running",
          branch: "bullpen/task/t1",
          reviewRounds: 0,
          excluded: [],
          attempts: [{ n: 1, agent: "a", role: "work", startedAt: new Date().toISOString(), outcome: "running" }],
        },
      },
    }),
  );
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.equal(s.reason, "all_done");
  assert.equal(loadState(repo).tasks.t1.attempts[0].outcome, "interrupted");
  assert.deepEqual(s.done, ["t1"]);
});

test("too many failed attempts hands the task to a human", T, async () => {
  const { repo } = makeRepo({
    tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"]) },
    script: { a: ["nofile", "nofile"] },
    config: { maxAttemptsPerTask: 2 },
    agents: ["a"],
  });
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.deepEqual(s.needsHuman, ["t1"]);
  assert.equal(loadState(repo).tasks.t1.status, "needs_human");
});

test("with a single agent and review on, the task asks for a human instead of hanging", T, async () => {
  const { repo } = makeRepo({
    tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"]) },
    agents: ["a"],
  });
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.deepEqual(s.needsHuman, ["t1"]);
  assert.match(loadState(repo).tasks.t1.lastError ?? "", /second agent/);
});

test("an agent that turns out to be signed out is rested, not blamed", T, async () => {
  const { repo } = makeRepo({
    tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"], "review: false\n") },
    script: { a: ["notlogged"] },
  });
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.equal(s.reason, "all_done");
  assert.deepEqual(outputs(repo, "t1"), ["a:work:auth_required", "b:work:work_done"]);
  const st = loadState(repo);
  assert.deepEqual(st.tasks.t1.excluded, []);
  assert.match(st.agents.a.lastReason ?? "", /^not signed in/);
});

test("a signed-out agent is noticed before it is given any work", T, async () => {
  const { repo } = makeRepo({
    tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"], "review: false\n") },
    signedOut: ["a"],
  });
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.equal(s.reason, "all_done");
  assert.deepEqual(outputs(repo, "t1"), ["b:work:work_done"]);
  assert.match(loadState(repo).agents.a.lastReason ?? "", /^not signed in/);
});

// A stand-in for "npm ci": creates a git-ignored file and counts how many times it ran.
const SETUP_SCRIPT =
  "import fs from 'node:fs';\nfs.writeFileSync('deps-installed.txt', 'ok');\nfs.appendFileSync(process.env.SETUP_LOG, 'ran\\n');\n";

test("setup runs once per worktree and before the agent starts", T, async () => {
  const log = join(mkdtempSync(join(tmpdir(), "bullpen-setup-")), "setup.log");
  process.env.SETUP_LOG = log;
  const { repo } = makeRepo({
    tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"]) },
    script: { a: ["nofile", "ok"] },
    files: { "setup.mjs": SETUP_SCRIPT, ".gitignore": "deps-installed.txt\n" },
    config: { setup: ["node setup.mjs"] },
  });
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.equal(s.reason, "all_done");
  assert.deepEqual(outputs(repo, "t1"), ["a:work:checks_failed", "a:work:work_done", "b:review:approved"]);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1, "setup ran once across two attempts and a review");
  assert.match(readFileSync(join(integration(repo), "out-t1.txt"), "utf8"), /setup=true/, "setup had run before the agent started");
  assert.ok(!existsSync(join(integration(repo), "deps-installed.txt")), "setup output was not committed");
});

test("a failing setup stops the task before any agent runs", T, async () => {
  const { repo } = makeRepo({
    tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"]) },
    files: { "bad-setup.mjs": "process.exit(1);\n" },
    config: { setup: ["node bad-setup.mjs"] },
  });
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.deepEqual(s.needsHuman, ["t1"]);
  const st = loadState(repo).tasks.t1;
  assert.match(st.lastError ?? "", /setup/);
  assert.deepEqual(st.attempts.map((a) => a.outcome), ["setup_failed"]);
  assert.ok(!existsSync(join(process.env.FAKE_STATE_DIR!, "a.work.count")), "no agent was started");
  assert.ok(existsSync(join(repo, ".bullpen", "logs", "t1-setup.log")), "the setup output was kept in a log");
});

test("a review that was cut off is closed as interrupted and the reviewer is not benched", T, async () => {
  const { repo } = makeRepo({ tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"]) } });
  const started = new Date().toISOString();
  writeFileSync(
    join(repo, ".bullpen", "state.json"),
    JSON.stringify({
      version: 1,
      agents: {},
      events: [],
      tasks: {
        t1: {
          status: "awaiting_review",
          branch: "bullpen/task/t1",
          reviewRounds: 0,
          excluded: [],
          lastAuthor: "a",
          attempts: [
            { n: 1, agent: "a", role: "work", startedAt: started, endedAt: started, outcome: "work_done" },
            { n: 2, agent: "b", role: "review", startedAt: started, outcome: "running" },
          ],
        },
      },
    }),
  );
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.equal(s.reason, "all_done");
  assert.deepEqual(outputs(repo, "t1"), ["a:work:work_done", "b:review:interrupted", "b:review:approved"]);
  assert.deepEqual(loadState(repo).tasks.t1.excluded, []);
});

test("a reviewer that already did its job is not benched for one unclear answer", T, async () => {
  const { repo } = makeRepo({
    tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"]) },
    script: { a: ["ok", "ok"] },
    review: { b: ["changes", "garbage", "approve"] },
  });
  const s = await runBullpen(repo, { deps: fakeClock() });
  assert.equal(s.reason, "all_done");
  assert.deepEqual(outputs(repo, "t1"), [
    "a:work:work_done",
    "b:review:changes_requested",
    "a:work:work_done",
    "b:review:review_unclear",
    "b:review:approved",
  ]);
  assert.deepEqual(loadState(repo).tasks.t1.excluded, []);
});

test("a second bullpen on the same repo is refused", T, async () => {
  const { repo } = makeRepo({ tasks: { t1: taskFile("impl", ["node check.mjs out-t1.txt"], "review: false\n") } });
  writeFileSync(join(repo, ".bullpen", "bullpen.lock"), String(process.pid));
  await assert.rejects(runBullpen(repo, { deps: fakeClock() }), /already running/);
});
