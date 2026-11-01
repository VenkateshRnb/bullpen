import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReviewPrompt, REVIEW_VERDICT } from "../src/prompt.ts";
import type { Task } from "../src/types.ts";

const verdicts = (text: string) => [...text.matchAll(REVIEW_VERDICT)].map((m) => m[1].toUpperCase());

test("the review prompt never contains a verdict line, so an echoed prompt cannot pass for an answer", () => {
  const task: Task = { id: "t", file: "t.md", kind: "impl", dependsOn: [], check: [], body: "x" };
  const prompt = buildReviewPrompt({ task, agent: "a", conventions: "c", stat: "s", diff: "d", checksReport: "ok" });
  assert.deepEqual(verdicts(prompt), []);
});

test("only a verdict on its own line counts", () => {
  assert.deepEqual(verdicts("- bug in x\nREVIEW: CHANGES\n"), ["CHANGES"]);
  assert.deepEqual(verdicts("fine\n  review: approve  \n"), ["APPROVE"]);
  assert.deepEqual(verdicts("I would say REVIEW: APPROVE if the tests pass"), []);
});

test("when a reviewer changes its mind the last verdict wins", () => {
  assert.deepEqual(verdicts("REVIEW: APPROVE\nwait, a bug\nREVIEW: CHANGES\n").slice(-1), ["CHANGES"]);
});
