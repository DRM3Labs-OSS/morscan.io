// Copy style check. Keeps user-facing copy (server-rendered pages, templates, UI strings) free of
// em/en dashes and the common AI-writing clichés that read as filler: summary-closes ("in short",
// "at the end of the day"), warm-ups ("here's the thing", "let me be clear"), self-claps ("and that
// matters", "which is exactly the point"), and giveaway vocabulary (delve, tapestry, supercharge,
// seamless, ...). Comment lines and .replace() lines are skipped (a comment is not shipped copy,
// and code that operates on punctuation is not copy). The census is frozen and may only SHRINK: a
// new tell fails the check. Runs in predeploy.
import { readdirSync, readFileSync } from "node:fs";

const TELLS = [
  { name: "summary-close", re: /\b(in short|at the end of the day|the bottom line is|when all is said and done)\b/i },
  { name: "warm-up", re: /\b(here'?s the thing|here is the thing|let me be clear|at its core,)\b/i },
  {
    name: "self-clap",
    re: /(and that matters\b|that'?s the part everyone misses|which is (exactly )?the point|here'?s why that'?s huge)/i,
  },
  // Prose em dashes only: a letter/digit on BOTH sides (one optional space). A standalone empty-
  // value glyph in a numeric table ('—', >—<, `${x || '—'} MOR`) is a deliberate
  // convention, distinct from a minus sign, and is NOT prose, so it is left alone.
  { name: "em-dash", re: /\w[ ]?—[ ]?\w/ },
  { name: "em-dash-escape", re: /\w[ ]?\\u2014[ ]?\w/ },
  { name: "tell-vocab", re: /\b(delve|tapestry|testament to|pivotal|supercharge|in a world where|seamless|effortless)\b/i },
];

// Frozen 2026-08-16. SHRINK ONLY. Empty is the goal state; a new key is a new debt.
const CENSUS = {};

const files = readdirSync("src", { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") || f.endsWith(".html") || f.endsWith(".mustache"))
  .filter((f) => !f.includes("node_modules") && !f.startsWith("vendor/") && !f.includes("/vendor/"))
  .map((f) => `src/${f}`);

const counts = {};
const detail = [];
for (const f of files) {
  let lines;
  try {
    lines = readFileSync(f, "utf8").split("\n");
  } catch {
    continue;
  }
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    if (/\.replace\(/.test(raw)) continue;
    for (const tell of TELLS) {
      if (tell.re.test(raw)) {
        n++;
        detail.push(`  ${f}:${i + 1} [${tell.name}] ${t.slice(0, 90)}`);
      }
    }
  }
  if (n > 0) counts[f] = n;
}

let failures = 0;
for (const [f, n] of Object.entries(counts)) {
  const pin = CENSUS[f];
  if (pin === undefined) {
    console.error(`copy style: ${f} has ${n} tell(s), not in the census - fix them or freeze the debt`);
    failures++;
  } else if (n > pin) {
    console.error(`copy style: ${f} grew ${pin} -> ${n} tells (frozen files only shrink)`);
    failures++;
  }
}
for (const [f, pin] of Object.entries(CENSUS)) {
  if (!counts[f]) console.error(`copy style: ${f} is now clean (was ${pin}) - DELETE its census entry`);
}
if (detail.length) console.error(detail.join("\n"));
if (failures) {
  console.error(`copy style: ${failures} violation(s).`);
  process.exit(1);
}
const pinned = Object.keys(CENSUS).length;
console.log(`copy style: no un-frozen tells${pinned ? ` (${pinned} pinned, shrink-only)` : ", census EMPTY"}`);
