import assert from "node:assert/strict";
import { test } from "node:test";
import { detectAuthFailure, detectLimit } from "../src/limits.ts";

const NOW = new Date(2026, 9, 31, 10, 0, 0); // local 10:00

test("wall-clock reset time is read and padded by a minute", () => {
  const v = detectLimit("Claude usage limit reached. Your limit will reset at 5:30pm", 1, NOW);
  assert.equal(v.hit, true);
  assert.equal(v.resetAt?.getHours(), 17);
  assert.equal(v.resetAt?.getMinutes(), 31);
});

test("wall-clock time already past today means tomorrow", () => {
  const v = detectLimit("usage limit reached, resets at 9am", 1, NOW);
  assert.equal(v.hit, true);
  assert.equal(v.resetAt?.getDate(), 1); // 1 November
  assert.equal(v.resetAt?.getHours(), 9);
});

test("relative reset: hours and minutes", () => {
  const v = detectLimit("5-hour limit reached ∙ resets in 3 hours 12 minutes", 1, NOW);
  assert.equal(v.hit, true);
  const want = NOW.getTime() + (3 * 60 + 12 + 1) * 60_000;
  assert.equal(v.resetAt?.getTime(), want);
});

test("epoch after a pipe", () => {
  const now = new Date(1_761_890_000 * 1000);
  const v = detectLimit("Claude AI usage limit reached|1761900000", 1, now);
  assert.equal(v.hit, true);
  assert.equal(v.resetAt?.getTime(), 1_761_900_000 * 1000 + 60_000);
});

test("retryDelay in a JSON error", () => {
  const v = detectLimit('{"error":{"code":429,"message":"Resource has been exhausted","details":[{"retryDelay":"34s"}]}}', 1, NOW);
  assert.equal(v.hit, true);
  assert.equal(v.resetAt?.getTime(), NOW.getTime() + 34_000 + 60_000);
});

test("no reset time given: hit without resetAt", () => {
  const v = detectLimit("Error: rate limit exceeded", 1, NOW);
  assert.equal(v.hit, true);
  assert.equal(v.resetAt, undefined);
});

test("a long successful answer that talks about rate limits is not a limit hit", () => {
  const text = "Here is the implementation of the rate limit middleware. ".repeat(30);
  assert.equal(detectLimit(text, 0, NOW).hit, false);
});

test("a short message that exits 0 can still be a limit hit", () => {
  assert.equal(detectLimit("You have hit your usage limit.", 0, NOW).hit, true);
});

test("ordinary failures are not limits", () => {
  assert.equal(detectLimit("TypeError: x is not a function", 1, NOW).hit, false);
});

test("a killed run (exit null) with limit text counts", () => {
  assert.equal(detectLimit("quota exceeded for this account", null, NOW).hit, true);
});

test("a signed-out CLI is recognised, and is not mistaken for a limit", () => {
  const text = "Not logged in · Please run /login";
  assert.equal(detectAuthFailure(text, 1), true);
  assert.equal(detectLimit(text, 1, NOW).hit, false);
});

test("auth wording inside a successful or long answer is ignored", () => {
  assert.equal(detectAuthFailure("Not logged in", 0), false);
  assert.equal(detectAuthFailure("The unauthorized handler returns 401. ".repeat(40), 1), false);
});

test("running out of credits is reported as credits", () => {
  const v = detectLimit("Your credit balance is too low to access the API", 1, NOW);
  assert.equal(v.hit, true);
  assert.equal(v.kind, "credits");
});
