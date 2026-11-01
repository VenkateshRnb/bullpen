// A pretend coding agent for tests. Behaviour comes from env vars so every scenario is repeatable:
//   FAKE_SCRIPT  = {"a": ["partial_limit", "ok"]}   what agent "a" does on its 1st, 2nd... work run
//   FAKE_REVIEW  = {"b": ["changes", "approve"]}    what agent "b" does on its 1st, 2nd... review run
//   FAKE_STATE_DIR  where call counters live
import fs from "node:fs";
import path from "node:path";

const name = process.argv[2];
const prompt = fs.readFileSync(0, "utf8");
const isReview = /acting as the code reviewer/.test(prompt);
const taskId = (prompt.match(/TASK_ID:\s*(\S+)/) || [])[1] ?? "unknown";

const counter = path.join(process.env.FAKE_STATE_DIR, `${name}.${isReview ? "review" : "work"}.count`);
let n = 0;
try {
  n = parseInt(fs.readFileSync(counter, "utf8"), 10);
} catch {}
fs.writeFileSync(counter, String(n + 1));

const table = JSON.parse(process.env[isReview ? "FAKE_REVIEW" : "FAKE_SCRIPT"] || "{}")[name] || [];
const behavior = table[n] ?? (isReview ? "approve" : "ok");
const note = (line) => fs.appendFileSync("HANDOFF.md", `\n- ${line}\n`);

switch (behavior) {
  case "ok":
    fs.appendFileSync(`out-${taskId}.txt`, `${name}\n`);
    note(`${name} did the work`);
    console.log("all done\nBULLPEN_STATUS: DONE");
    break;
  case "partial_limit":
    fs.appendFileSync(`partial-${taskId}.txt`, `${name}\n`);
    note(`${name} did the first half`);
    console.log("5-hour limit reached ∙ resets in 3 hours");
    process.exit(1);
  case "crash":
    console.error("boom: unexpected failure");
    process.exit(2);
  case "nofile":
    console.log("I think I am done\nBULLPEN_STATUS: DONE");
    break;
  case "notlogged":
    console.log("Not logged in · Please run /login");
    process.exit(1);
  case "approve":
    console.log("No blocking problems found.\nREVIEW: APPROVE");
    break;
  case "changes":
    console.log("- app.js: missing input validation\nREVIEW: CHANGES");
    break;
  case "garbage":
    console.log("looks fine to me");
    break;
  case "review_limit":
    console.log("usage limit reached, resets in 2 hours");
    process.exit(1);
  default:
    console.error(`unknown behavior ${behavior}`);
    process.exit(3);
}
