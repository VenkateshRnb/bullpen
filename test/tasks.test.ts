import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTasks, parseTask } from "../src/tasks.ts";

test("parses scalars, inline lists and block lists", () => {
  const t = parseTask(
    "/x/020-api.md",
    `---
kind: security
depends_on: [010-db, 015-keys]
agents: [claude, codex]
review: false
check:
  - npm test
  - node check.mjs: out.txt
---
Build the thing.
Second line.
`,
  );
  assert.equal(t.id, "020-api");
  assert.equal(t.kind, "security");
  assert.deepEqual(t.dependsOn, ["010-db", "015-keys"]);
  assert.deepEqual(t.agents, ["claude", "codex"]);
  assert.equal(t.review, false);
  assert.deepEqual(t.check, ["npm test", "node check.mjs: out.txt"]);
  assert.equal(t.body, "Build the thing.\nSecond line.");
});

test("a file without front matter is all instructions", () => {
  const t = parseTask("/x/a.md", "Just do it.");
  assert.equal(t.kind, "default");
  assert.equal(t.body, "Just do it.");
  assert.deepEqual(t.check, []);
});

function dirWith(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "bullpen-tasks-"));
  mkdirSync(d, { recursive: true });
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  return d;
}

test("tasks load in file-name order and skip underscore files", () => {
  const d = dirWith({ "b.md": "B", "a.md": "A", "_draft.md": "no" });
  assert.deepEqual(loadTasks(d).map((t) => t.id), ["a", "b"]);
});

test("unknown dependency is an error", () => {
  const d = dirWith({ "a.md": "---\ndepends_on: [ghost]\n---\nx" });
  assert.throws(() => loadTasks(d), /unknown task "ghost"/);
});

test("dependency cycles are rejected", () => {
  const d = dirWith({ "a.md": "---\ndepends_on: [b]\n---\nx", "b.md": "---\ndepends_on: [a]\n---\nx" });
  assert.throws(() => loadTasks(d), /cycle/);
});
