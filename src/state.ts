import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { State, TaskState } from "./types.ts";
import { pidAlive } from "./util.ts";

export const stateFile = (repo: string) => join(repo, ".bullpen", "state.json");

export function emptyState(): State {
  return { version: 1, tasks: {}, agents: {}, events: [] };
}

export function loadState(repo: string): State {
  const f = stateFile(repo);
  if (!existsSync(f)) return emptyState();
  try {
    const s = JSON.parse(readFileSync(f, "utf8")) as State;
    return { ...emptyState(), ...s };
  } catch {
    // A torn write cannot happen (we rename atomically), so this means hand-editing gone wrong.
    throw new Error(`${f} is not valid JSON. Fix or delete it (tasks restart as pending).`);
  }
}

/** Write to a temp file then rename: a crash mid-write never leaves a half-written state. */
export function saveState(repo: string, state: State): void {
  const f = stateFile(repo);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, f);
}

export function newTaskState(id: string): TaskState {
  return { status: "pending", attempts: [], branch: `bullpen/task/${id}`, reviewRounds: 0, excluded: [] };
}

/** Single-instance lock so two bullpens never fight over the same repo. */
export function acquireLock(repo: string): () => void {
  const lock = join(repo, ".bullpen", "bullpen.lock");
  mkdirSync(dirname(lock), { recursive: true });
  const tryOpen = () => {
    const fd = openSync(lock, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  };
  try {
    tryOpen();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = parseInt(readFileSync(lock, "utf8"), 10);
    if (pid && pidAlive(pid)) throw new Error(`Another bullpen is already running here (pid ${pid}).`);
    unlinkSync(lock); // stale lock from a crashed run
    tryOpen();
  }
  return () => {
    try {
      unlinkSync(lock);
    } catch {
      /* already removed */
    }
  };
}
