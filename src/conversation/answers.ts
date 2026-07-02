/**
 * Lenient interpretation of free-text yes/no answers.
 *
 * Early on, confirmations were strict "(y/n)" prompts that rejected anything
 * else. A conversational agent should understand ordinary phrasings ("sure",
 * "nope", "go ahead", "sí") and, at decision points, let the user answer in
 * natural language instead of forcing a single letter. This keeps the parsing in
 * one testable place.
 */

const AFFIRMATIVE = new Set([
  "y", "yes", "yeah", "yep", "yup", "ya", "ok", "okay", "k", "sure", "sures",
  "correct", "right", "yea", "affirmative", "please", "true",
  // common Spanish forms (the user may reply in Spanish even if the UI is English)
  "si", "sí", "dale", "claro", "vale",
]);

const NEGATIVE = new Set([
  "n", "no", "nope", "nah", "naw", "cancel", "stop", "negative", "false",
  "dont", "nevermind", "nvm", "abort", "quit",
  "nel",
]);

/** Multi-word affirmative/negative phrases, checked against the whole answer. */
const AFFIRMATIVE_PHRASES = ["go ahead", "do it", "go for it", "sounds good", "yes please", "let's go", "lets go"];
const NEGATIVE_PHRASES = ["no thanks", "no thank you", "not now", "don't", "do not", "no way"];

/** Filler words that don't change a leading yes/no into a redirect. */
const FILLERS = new Set(["please", "thanks", "thank", "you", "then", "sure", "go", "ahead", "it", "do"]);

function normalize(answer: string): string {
  return answer
    .trim()
    .toLowerCase()
    .replace(/[.!,]+$/, "")
    .trim();
}

/**
 * Returns true (yes), false (no), or null when the answer isn't a clear yes/no
 * and should be treated as free text.
 */
export function interpretYesNo(answer: string): boolean | null {
  const s = normalize(answer);
  if (s === "") return null;

  if (AFFIRMATIVE_PHRASES.includes(s)) return true;
  if (NEGATIVE_PHRASES.includes(s)) return false;

  if (AFFIRMATIVE.has(s)) return true;
  if (NEGATIVE.has(s)) return false;

  // A leading yes/no counts only when the rest is filler ("yes please",
  // "ok sure"). "no, pick sarek" keeps its content and is treated as free text
  // so the caller can act on the redirect.
  const words = s.split(/\s+/);
  if (words.length > 1) {
    const first = words[0];
    const restIsFiller = words.slice(1).every((w) => FILLERS.has(w));
    if (restIsFiller && AFFIRMATIVE.has(first)) return true;
    if (restIsFiller && NEGATIVE.has(first)) return false;
  }

  return null;
}
