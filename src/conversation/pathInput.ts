/**
 * Lenient interpretation of "give me a path" answers.
 *
 * The conversation shouldn't force a rigid path-only reply: a scientist may not
 * have a path, or may change their mind ("actually, run the test profile"). So we
 * classify the answer instead of treating any text as a directory. A leading "@"
 * explicitly marks a path (like most coding agents) — which also lets a path with
 * spaces through unambiguously.
 */

export type PathAnswer =
  | { kind: "empty" }
  | { kind: "path"; path: string }
  | { kind: "text"; text: string };

/** True if the answer looks like a filesystem path rather than a sentence. */
export function looksLikePath(raw: string): boolean {
  const s = raw.trim();
  if (s === "") return false;
  if (/^(\/|\.\/|\.\.\/|~)/.test(s)) return true; // absolute / relative / home
  if (/\s/.test(s)) return false; // has spaces → a sentence (use "@" to force a spaced path)
  return true; // a single bare token → a plausible path / directory name
}

/**
 * Classifies a free-text answer to a path prompt. A leading "@" is an explicit
 * path reference (and is stripped), so `@/my data/reads` works even with spaces.
 */
export function classifyPathAnswer(raw: string): PathAnswer {
  const t = raw.trim();
  if (t === "") return { kind: "empty" };
  if (t.startsWith("@")) {
    const p = t.slice(1).trim();
    return p ? { kind: "path", path: p } : { kind: "empty" };
  }
  return looksLikePath(t) ? { kind: "path", path: t } : { kind: "text", text: t };
}

/** Strips a leading "@" path reference, returning the bare path. */
export function pathReference(raw: string): string {
  const t = raw.trim();
  return t.startsWith("@") ? t.slice(1).trim() : t;
}

const TEST_PROFILE_RE =
  /\b(test\s*profile|test\s*run|run\s+(the\s+)?test|use\s+(the\s+)?test|test\s*data|perfil\s+de\s+prueba)\b/i;

/** Detects a request to switch to the pipeline's bundled test profile. */
export function wantsTestProfile(text: string): boolean {
  return TEST_PROFILE_RE.test(text);
}
