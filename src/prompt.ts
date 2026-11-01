import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./types.ts";

/**
 * A verdict counts only as a line of its own. Some CLIs echo the prompt back, so the review prompt
 * deliberately never contains this line literally; an echo can therefore never pass for an answer.
 */
export const REVIEW_VERDICT = /^[ \t]*REVIEW:[ \t]*(APPROVE|CHANGES)[ \t]*$/gim;

export function readConventions(root: string, files: string[]): string {
  const parts: string[] = [];
  for (const f of files) {
    const p = join(root, f);
    if (existsSync(p)) parts.push(`### ${f}\n${readFileSync(p, "utf8").trim()}`);
  }
  return parts.join("\n\n") || "(no conventions files found)";
}

export const handoffTemplate = (id: string) =>
  `# Handoff: ${id}\n\nStatus: not started\n\n## Done\n(nothing yet)\n\n## Next steps\n(read the task)\n\n## Gotchas\n(none yet)\n`;

export function buildWorkPrompt(p: {
  task: Task;
  agent: string;
  attempt: number;
  conventions: string;
  handoff: string;
}): string {
  const checks = p.task.check.length ? p.task.check.map((c) => `- ${c}`).join("\n") : "- (none defined)";
  return `You are ${p.agent}, one of several AI coding agents in an automated build run by Bullpen. Usage limits can stop any agent at any moment, so another agent may have worked on this task before you, and another will continue after you. Work so that anyone can pick up where you stop.

TASK_ID: ${p.task.id}
TASK_KIND: ${p.task.kind}
ATTEMPT: ${p.attempt}

## Your task
${p.task.body}

## How to work
- You are inside a dedicated git worktree on branch bullpen/task/${p.task.id}. Work only here.
- Start by reading HANDOFF.md. It records what earlier agents did and what remains. Continue from it. Do not redo finished work.
- Follow the project conventions below.
- Do NOT run git commit. Bullpen saves (commits) your work automatically when you stop, even if you run out of budget. Never push, never switch branches, never rewrite history.
- Before you stop, whether finished or out of budget, update HANDOFF.md with "Done", "Next steps" and "Gotchas". Keep it short and concrete.
- Touch only what the task needs. Never install global tools. Never print or store secrets.

## Acceptance checks
Bullpen runs these itself after you finish and does not take your word for it:
${checks}

## Project conventions
${p.conventions}

## Handoff notes so far
${p.handoff.trim()}

When completely finished, end your last message with the line: BULLPEN_STATUS: DONE
If you could not finish, end it with: BULLPEN_STATUS: PARTIAL
`;
}

export function buildReviewPrompt(p: {
  task: Task;
  agent: string;
  conventions: string;
  stat: string;
  diff: string;
  checksReport: string;
}): string {
  return `You are ${p.agent}, acting as the code reviewer in an automated multi-agent build. Another agent wrote this change. Do NOT modify any files.

TASK_ID: ${p.task.id}

## What the change was supposed to do
${p.task.body}

## Automated checks (already passed)
${p.checksReport}

## Project conventions
${p.conventions}

## Change summary
${p.stat || "(empty)"}

## Diff
${p.diff || "(empty diff)"}

## Your job
Look for blocking problems only: correctness bugs, security problems (authentication, authorization, per-user data isolation, encryption, secrets, injection), missing or weak tests for risky logic, and clear violations of the conventions. Ignore style preferences.

List each blocking problem as a bullet point, with the file and a one-line reason. Then end with exactly one final line made of the word REVIEW, a colon, a space, and your verdict, which is either the word APPROVE or the word CHANGES.
`;
}
