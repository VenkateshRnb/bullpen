import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Task } from "./types.ts";

/**
 * Task files live in .bullpen/tasks/*.md. Front matter is a tiny YAML subset:
 *   key: value            scalar
 *   key: [a, b]           inline list
 *   key:                  block list, followed by "  - item" lines
 * Everything after the closing --- is the instructions for the agent.
 */
export function parseTask(file: string, text: string): Task {
  const id = basename(file).replace(/\.md$/i, "");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta: Record<string, string | string[]> = {};
  const body = m ? m[2] : text;
  if (m) {
    const lines = m[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const km = lines[i].match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (!km) continue;
      const key = km[1];
      const val = km[2].trim();
      if (val === "") {
        const items: string[] = [];
        while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
          items.push(lines[++i].replace(/^\s*-\s+/, "").trim());
        }
        meta[key] = items;
      } else if (val.startsWith("[") && val.endsWith("]")) {
        meta[key] = val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      } else {
        meta[key] = val.replace(/^["']|["']$/g, "");
      }
    }
  }
  const list = (k: string): string[] => {
    const v = meta[k];
    return Array.isArray(v) ? v : v ? [v] : [];
  };
  const scalar = (k: string): string | undefined => {
    const v = meta[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const reviewRaw = scalar("review");
  return {
    id,
    file,
    kind: scalar("kind") ?? "default",
    dependsOn: list("depends_on"),
    check: list("check"),
    agents: list("agents").length ? list("agents") : undefined,
    review: reviewRaw === undefined ? undefined : reviewRaw !== "false",
    body: body.trim(),
  };
}

export function loadTasks(dir: string): Task[] {
  if (!existsSync(dir)) return [];
  const tasks = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md") && !f.startsWith("_"))
    .sort()
    .map((f) => parseTask(join(dir, f), readFileSync(join(dir, f), "utf8")));
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!ids.has(d)) throw new Error(`Task ${t.id} depends on unknown task "${d}"`);
    }
  }
  assertNoCycles(tasks);
  return tasks;
}

function assertNoCycles(tasks: Task[]): void {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`Task dependency cycle: ${[...path, id].join(" -> ")}`);
    state.set(id, 1);
    for (const d of byId.get(id)!.dependsOn) visit(d, [...path, id]);
    state.set(id, 2);
  };
  for (const t of tasks) visit(t.id, []);
}
