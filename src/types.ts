export interface AgentConfig {
  enabled: boolean;
  /** Absolute path or bare command. null means auto-discover on every run. */
  command: string | null;
  /** Placeholders: {cwd}, {prompt}, {promptFile}. */
  args: string[];
  /** Args for read-only review runs. Falls back to args. */
  reviewArgs?: string[];
  /**
   * How the prompt reaches the agent: "stdin" (best), "arg" (placed where {prompt} appears), or
   * "file" (written to .bullpen-prompt.md in the worktree and referenced as {promptFile}; use this for
   * CLIs that cannot read stdin, since long multi-line prompts break command lines on Windows).
   */
  promptVia: "stdin" | "arg" | "file";
  /** Extra environment variables for this agent only. */
  env?: Record<string, string>;
  /** Cool-down used when the limit message carries no reset time. */
  cooldownMinutes: number;
  /** Optional sign-in probe: run `command ...args`; signed in when the output matches okPattern. */
  authCheck?: { args: string[]; okPattern: string };
}

export interface Config {
  integrationBranch: string;
  concurrency: number;
  taskTimeoutMinutes: number;
  checkTimeoutMinutes: number;
  maxAttemptsPerTask: number;
  maxReviewRounds: number;
  review: boolean;
  allowSelfReview: boolean;
  pollSeconds: number;
  /** Task kind -> agent order. "default" is used for unknown kinds. */
  routing: Record<string, string[]>;
  conventionsFiles: string[];
  agents: Record<string, AgentConfig>;
}

export interface Task {
  id: string;
  file: string;
  kind: string;
  dependsOn: string[];
  check: string[];
  agents?: string[];
  review?: boolean;
  body: string;
}

export type TaskStatus = "pending" | "running" | "awaiting_review" | "done" | "needs_human";

export interface Attempt {
  n: number;
  agent: string;
  role: "work" | "review";
  startedAt: string;
  endedAt?: string;
  outcome: string;
  note?: string;
  log?: string;
}

export interface TaskState {
  status: TaskStatus;
  attempts: Attempt[];
  branch: string;
  reviewRounds: number;
  /** Agents that keep failing this task and are skipped for it. */
  excluded: string[];
  lastAuthor?: string;
  lastError?: string;
  mergedAt?: string;
}

export interface AgentState {
  blockedUntil?: string;
  hits: number;
  lastReason?: string;
}

export interface State {
  version: 1;
  tasks: Record<string, TaskState>;
  agents: Record<string, AgentState>;
  events: { ts: string; msg: string }[];
}
