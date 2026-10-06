// VENDORED from DRM3Labs/drm3-health-contract @ 616a760fda593ef47872e1de6548a935da353037 (src/index.ts). Do not edit here.
// The door gate: revealExtended() decides who sees the full /health body, publicHealth()
// projects it to the fields public-health.allow names for everyone else, parseAllow() reads
// that file. Default-deny. The law is OPEN-OPS-LAW.md section 3 in the DRM3 master container.
// Re-sync from the container root: node scripts/vendor-public-health.mjs <this repo>
/** The header an operator instrument presents to read a product's `extended` block. */
export const OPS_READ_HEADER = 'X-DRM3-Ops-Key';

/**
 * Should this request see `extended`? True when it carries the fleet's operator read key
 * (`OPS_READ_HEADER` equal to the worker's `OPS_READ_KEY`). Constant-time compare; an unset
 * key reveals to nobody. The public envelope (status, sku, product, version, timestamp and the
 * SKU's canonical top-level metrics) never depends on this.
 *
 * Why (2026-09-07 surface audit): every fleet /health printed its whole `extended` block to
 * anyone - spend in USD against caps, provider token counts, billing deltas, lake-door refusal
 * messages. Operating intelligence, and exactly the numbers the ops board reads.
 */
export function revealExtended(request: Request, env: { OPS_READ_KEY?: string }): boolean {
  const want = env.OPS_READ_KEY || '';
  const got = request.headers.get(OPS_READ_HEADER) || '';
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

/**
 * THE PUBLIC-FIELD ALLOWLIST: parseAllow() + publicHealth().
 *
 * The law is OPEN-OPS-LAW.md section 3 in the DRM3 master container. A /health field reaches
 * a public surface only when the repo's `public-health.allow` names it, with a reason on the
 * line directly above. Everything else is dropped: default-deny.
 *
 * THE TWIN: `scripts/lib/public-health.mjs` in the container is the tooling copy of these two
 * functions (the fleet view and the ratchet run on it). The two MUST change together. A rule
 * that differs between them is a hole.
 *
 * The allow-file format (plain text, line oriented):
 *   - A line whose first non-space char is '#' is a comment. Blank lines are ignored.
 *   - Any other line is ONE allowed field: a dotted path against the health body
 *     (status, version, metrics.articlesIndexed, queue.depth). Whitespace is trimmed.
 *     Segments match object keys exactly. A path names a leaf OR a whole subtree.
 *   - REASON RULE: the line DIRECTLY above every field line is a comment with real text
 *     after the '#'. A blank line, another field, or the file start above a field is a
 *     violation, and the field is NOT allowed.
 *
 * Producer usage, with the file bundled as text:
 *
 *   const ALLOW = parseAllow(allowText).fields;
 *   return Response.json(revealExtended(request, env) ? full : publicHealth(full, ALLOW));
 */

/** One allowed field from a `public-health.allow` file. */
export interface AllowField {
  /** The dotted path against the health body. */
  path: string;
  /** The comment text from the line above, with the leading '#' removed. */
  reason: string;
  /** 1-based line number of the field line. */
  line: number;
}

/** One field line that broke the format. It is never in `fields`. */
export interface AllowViolation {
  /** 1-based line number of the field line. */
  line: number;
  /** The field line as written, trimmed. */
  field: string;
  /** What is wrong with it. */
  problem: string;
}

export interface ParsedAllow {
  fields: AllowField[];
  violations: AllowViolation[];
}

/** What publicHealth() takes as the allow list: path strings, or the `fields` parseAllow() returns. */
export type AllowPaths = Iterable<string | { path: string }>;

/** Path segments that never resolve and never appear in output. Prototype-pollution guard. */
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/** A container we walk into: a non-null, non-array object. */
const isContainer = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** A reason is real when it holds at least one letter or digit. '#', '# ---' and '#   ' are not. */
const REAL_TEXT_RE = /[\p{L}\p{N}]/u;

/** Why a path is not a usable dotted path, or '' when it is fine. */
function pathProblem(path: string): string {
  if (/[\s#]/.test(path)) return 'not a single dotted path (whitespace or an inline comment on the field line)';
  const segments = path.split('.');
  if (segments.some((s) => s === '')) return 'empty path segment';
  if (segments.some((s) => FORBIDDEN_SEGMENTS.has(s))) return 'forbidden path segment (__proto__, constructor, prototype)';
  return '';
}

/**
 * Parse the text of a `public-health.allow` file.
 *
 * Default-deny: a field that breaks any rule lands in `violations` and is LEFT OUT of
 * `fields`. A caller that feeds `fields` to publicHealth() can never expose a field whose
 * line was malformed or whose reason was missing.
 */
export function parseAllow(text: string): ParsedAllow {
  const fields: AllowField[] = [];
  const violations: AllowViolation[] = [];
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  // LF and CRLF only. A lone CR is NOT a line break: grep, git and the ratchet's line scan all
  // read "# why\rsecret" as one comment, so this parser must too, or a field hides from every audit.
  for (let i = 0; i < lines.length; i++) {
    const field = (lines[i] ?? '').trim();
    if (field === '' || field.startsWith('#')) continue;
    const line = i + 1;

    const malformed = pathProblem(field);
    if (malformed) {
      violations.push({ line, field, problem: malformed });
      continue;
    }

    const above = i > 0 ? (lines[i - 1] ?? '').trim() : null;
    if (above === null) {
      violations.push({ line, field, problem: 'no reason: the field is on the first line of the file' });
      continue;
    }
    if (above === '') {
      violations.push({ line, field, problem: 'no reason: the line above is blank' });
      continue;
    }
    if (!above.startsWith('#')) {
      violations.push({ line, field, problem: 'no reason: the line above is another field, not a comment' });
      continue;
    }
    const reason = above.replace(/^#+/, '').trim();
    if (!REAL_TEXT_RE.test(reason)) {
      violations.push({ line, field, problem: 'no reason: the comment above has no text' });
      continue;
    }
    fields.push({ path: field, reason, line });
  }
  return { fields, violations };
}

/** Deep copy of a JSON-like value. Forbidden keys and non-JSON values (functions, symbols, undefined) are dropped. */
function cloneValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  }
  const withJson = value as { toJSON?: unknown };
  if (typeof withJson.toJSON === 'function') return cloneValue((withJson.toJSON as () => unknown).call(value));
  if (Array.isArray(value)) {
    return value.map((item: unknown) => {
      const copy = cloneValue(item);
      return copy === undefined ? null : copy;
    });
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_SEGMENTS.has(key)) continue;
    const copy = cloneValue(source[key]);
    if (copy !== undefined) out[key] = copy;
  }
  return out;
}

/** Normalise the allow list to trimmed path strings. Anything unusable becomes nothing. */
function allowList(allowPaths: unknown): string[] {
  // A bare string is not a list. Refuse it, or its characters would each read as a path.
  if (allowPaths === null || allowPaths === undefined || typeof allowPaths === 'string') return [];
  if (typeof (allowPaths as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') return [];
  const out: string[] = [];
  for (const entry of allowPaths as Iterable<unknown>) {
    const raw: unknown =
      typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' ? (entry as { path?: unknown }).path : undefined;
    if (typeof raw !== 'string') continue;
    const path = raw.trim();
    if (path !== '') out.push(path);
  }
  return out;
}

/**
 * The projector. Returns a NEW object holding only the allowed dotted paths of `body`.
 *
 * Default-deny, with no exceptions:
 *   - a path not listed is dropped, whatever it is;
 *   - a listed path the body does not carry is skipped silently;
 *   - an empty or missing allow list returns {};
 *   - a body that is not a plain object returns {}.
 * A path that names a subtree copies the whole subtree. A path may name an array-valued key,
 * copied whole. There is no index syntax and no path walks INTO an array.
 * `body` is never mutated and the result shares no reference with it.
 * A path with a __proto__, constructor or prototype segment is ignored, and those keys are
 * dropped from copied subtrees.
 */
export function publicHealth(body: unknown, allowPaths?: AllowPaths | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isContainer(body)) return out;

  for (const path of allowList(allowPaths)) {
    const segments = path.split('.');
    if (segments.some((s) => s === '' || FORBIDDEN_SEGMENTS.has(s))) continue;

    // Read: walk own keys only. Never the prototype chain, never into an array.
    let source: unknown = body;
    let found = true;
    for (const segment of segments) {
      if (!isContainer(source) || !hasOwn(source, segment)) {
        found = false;
        break;
      }
      source = source[segment];
    }
    if (!found) continue;
    const copy = cloneValue(source);
    if (copy === undefined) continue;

    // Write: build the parents in the output, then set the leaf or the subtree.
    let target = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i] as string;
      let next = hasOwn(target, segment) ? target[segment] : undefined;
      if (!isContainer(next)) {
        next = {};
        target[segment] = next;
      }
      target = next as Record<string, unknown>;
    }
    target[segments[segments.length - 1] as string] = copy;
  }
  return out;
}
