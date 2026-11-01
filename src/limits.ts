/**
 * Decides whether an agent run ended because the vendor's usage limit was reached,
 * and when it resets. Message formats differ between tools and change over time, so
 * this is deliberately generous about wording but strict about context: a run that
 * exited 0 with a long answer that merely mentions "rate limit" is not a limit hit.
 */

export interface LimitVerdict {
  hit: boolean;
  kind?: "limit" | "credits";
  resetAt?: Date;
  reason: string;
}

const HIT: RegExp[] = [
  /(?:usage|rate|quota|token|message|daily|weekly|monthly|5[- ]?hour|session|request)s?\s+limit/i,
  /limit\s+(?:reached|exceeded|hit)/i,
  /(?:reached|hit|exceeded)\s+(?:your|the)\s+[\w\s-]{0,30}limit/i,
  /quota\s+(?:exceeded|exhausted|reached)|exceeded\s+(?:your\s+)?(?:current\s+)?quota/i,
  /too many requests/i,
  /resource[_\s]?exhausted/i,
  /rate[_\s-]?limit(?:ed|_exceeded)?/i,
];
const CREDITS = /credit balance is too low|insufficient[_\s]quota|out of credits/i;

const UNIT_MS: Record<string, number> = {
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
};

function sumDurations(text: string): number {
  let total = 0;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
    total += parseFloat(m[1]) * (UNIT_MS[m[2].toLowerCase()] ?? 0);
  }
  return total;
}

export function parseReset(text: string, now: Date): Date | undefined {
  let m: RegExpMatchArray | null;

  // "limit reached|1760000000" and "resets 1760000000"
  m = text.match(/(?:\||reset[s]?\s+(?:at\s+)?)(\d{10})\b/i);
  if (m) return new Date(parseInt(m[1], 10) * 1000);

  // retryDelay: "34s", Retry-After: 120
  m = text.match(/retry(?:Delay|[- ]after)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)\s*(ms|s|m|h)?/i);
  if (m) {
    const n = parseFloat(m[1]);
    const unit = (m[2] ?? "s").toLowerCase();
    const ms = unit === "ms" ? n : unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 1000;
    return new Date(now.getTime() + ms);
  }

  // "in 4 hours 12 minutes", "after 30 min"
  m = text.match(/(?:in|after|within)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i);
  if (m) {
    const ms = sumDurations(m[1]);
    if (ms > 0) return new Date(now.getTime() + ms);
  }

  // ISO timestamp near a reset word
  m = text.match(/(?:reset|resets|retry|available|until|after)[^\n]{0,40}?(20\d\d-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d:?\d\d)?)/i);
  if (m) {
    const d = new Date(m[1].replace(" ", "T"));
    if (!Number.isNaN(d.getTime())) return d;
  }

  // Wall clock: "resets at 5:30pm", "resets 3pm", "try again at 17:30" (system local time)
  m = text.match(/(?:reset|resets|resume|try again|available|retry)[^\n]{0,30}?\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (m && (m[2] !== undefined || m[3] !== undefined)) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h <= 23 && min <= 59) {
      const d = new Date(now);
      d.setHours(h, min, 0, 0);
      if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
      return d;
    }
  }
  return undefined;
}

const AUTH = /not logged in|not signed in|please run \/login|please (?:log|sign)[ -]?in|invalid api key|authentication (?:failed|required|error)|\bunauthorized\b|\b401\b/i;

/** A run that died because the CLI is signed out. Waiting will not fix it; the user must sign in. */
export function detectAuthFailure(text: string, exitCode: number | null): boolean {
  if (exitCode === 0) return false;
  const t = text.trim();
  return t.length < 800 && AUTH.test(t);
}

export function detectLimit(text: string, exitCode: number | null, now: Date = new Date()): LimitVerdict {
  const tailText = text.slice(-4000);
  const failed = exitCode !== 0;
  const matched =
    HIT.find((r) => r.test(tailText)) ?? (failed && /\b429\b/.test(tailText) ? /\b429\b/ : undefined);
  const credits = CREDITS.test(tailText);
  if (!matched && !credits) return { hit: false, reason: "" };

  const short = text.trim().length < 600;
  if (!failed && !short) return { hit: false, reason: "mentions a limit but exited 0 with a long answer" };

  const probe = (matched ?? CREDITS) as RegExp;
  const line = tailText.split(/\r?\n/).find((l) => probe.test(l)) ?? tailText.trim().slice(-200);
  let resetAt = parseReset(tailText, now);
  if (resetAt && resetAt.getTime() <= now.getTime()) resetAt = undefined;
  if (resetAt) {
    const min = now.getTime() + 60_000;
    const max = now.getTime() + 8 * 86_400_000;
    resetAt = new Date(Math.min(Math.max(resetAt.getTime() + 60_000, min), max));
  }
  return {
    hit: true,
    kind: credits && !matched ? "credits" : "limit",
    resetAt,
    reason: line.trim().slice(0, 200),
  };
}
