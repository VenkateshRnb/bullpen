import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./types.ts";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function gitOk(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** Use the repo's own identity when set; otherwise a neutral one so commits never fail. */
async function identity(cwd: string): Promise<string[]> {
  const email = (await git(["config", "user.email"], cwd)).stdout.trim();
  return email ? [] : ["-c", "user.name=Bullpen", "-c", "user.email=bullpen@localhost"];
}

const branchExists = async (repo: string, branch: string) =>
  (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo)).code === 0;

export const worktreesDir = (repo: string) => join(repo, ".bullpen", "worktrees");
export const integrationPath = (repo: string) => join(worktreesDir(repo), "_integration");
export const taskPath = (repo: string, id: string) => join(worktreesDir(repo), id);

/**
 * All work lands on an integration branch in its own worktree. Your checked-out branch is
 * never touched; you merge bullpen/integration yourself when you are happy with it.
 */
export async function ensureIntegration(repo: string, cfg: Config): Promise<string> {
  const head = await git(["rev-parse", "--verify", "HEAD"], repo);
  if (head.code !== 0) throw new Error("This repository has no commits yet. Make one commit first, then run again.");
  await git(["worktree", "prune"], repo);
  const wt = integrationPath(repo);
  if (!existsSync(join(wt, ".git"))) {
    if (await branchExists(repo, cfg.integrationBranch)) {
      await gitOk(["worktree", "add", wt, cfg.integrationBranch], repo);
    } else {
      await gitOk(["worktree", "add", "-b", cfg.integrationBranch, wt, "HEAD"], repo);
    }
  }
  return wt;
}

export async function ensureTaskWorktree(repo: string, id: string, cfg: Config): Promise<string> {
  const wt = taskPath(repo, id);
  if (existsSync(join(wt, ".git"))) return wt;
  const branch = `bullpen/task/${id}`;
  if (await branchExists(repo, branch)) {
    await gitOk(["worktree", "add", wt, branch], repo);
  } else {
    await gitOk(["worktree", "add", "-b", branch, wt, cfg.integrationBranch], repo);
  }
  return wt;
}

/** Commit everything in the worktree. Returns false when there was nothing to commit. */
export async function commitAll(wt: string, message: string): Promise<boolean> {
  // The prompt file (promptVia "file") is scratch and must never be committed.
  await gitOk(["add", "-A", "--", ".", ":(exclude).bullpen-prompt.md"], wt);
  const staged = await git(["diff", "--cached", "--quiet"], wt);
  if (staged.code === 0) return false;
  await gitOk([...(await identity(wt)), "commit", "-m", message], wt);
  return true;
}

export async function diffAgainst(wt: string, base: string, maxChars = 80_000): Promise<{ stat: string; diff: string }> {
  const stat = (await git(["diff", "--stat", `${base}...HEAD`], wt)).stdout.trim();
  let diff = (await git(["diff", `${base}...HEAD`], wt)).stdout;
  if (diff.length > maxChars) diff = diff.slice(0, maxChars) + "\n... (diff truncated)";
  return { stat, diff };
}

export async function dropFileFromBranch(wt: string, file: string, message: string): Promise<void> {
  const r = await git(["rm", "-f", "--quiet", file], wt);
  if (r.code !== 0) return; // not tracked, nothing to drop
  await gitOk([...(await identity(wt)), "commit", "-m", message], wt);
}

export async function mergeTask(
  integrationWt: string,
  branch: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await git([...(await identity(integrationWt)), "merge", "--no-ff", "-m", message, branch], integrationWt);
  if (r.code === 0) return { ok: true };
  await git(["merge", "--abort"], integrationWt);
  return { ok: false, error: (r.stdout + r.stderr).trim().slice(-600) };
}

export async function removeWorktree(repo: string, wt: string): Promise<void> {
  await git(["worktree", "remove", "--force", wt], repo);
}
