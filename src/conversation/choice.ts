/**
 * Recommended-options prompt (Claude-style "pick one, or type your own").
 *
 * Instead of asking a scientist to know nf-core jargon up front, present a short
 * list of options — each with a plain-language description and a recommended
 * default — and still accept a free-text custom answer (or an `@path`). This is
 * built on top of the existing `ask`, so it needs no new AgentIO method and works
 * with every frontend.
 */
import type { AgentIO, ChoiceOption } from "./io.js";

export type { ChoiceOption };

/** The option to default to on empty input: the recommended one, else the first. */
export function defaultOption(options: ChoiceOption[]): ChoiceOption | undefined {
  return options.find((o) => o.recommended) ?? options[0];
}

/**
 * Resolves a raw answer against the options:
 *  - empty → the default option's value,
 *  - a number in range → that option's value,
 *  - a case-insensitive label/value match → that option's value,
 *  - a leading `@` → the referenced path (stripped),
 *  - anything else → the raw text (a custom answer).
 * Pure.
 */
export function resolveChoice(raw: string, options: ChoiceOption[]): string {
  const t = raw.trim();
  if (t === "") return defaultOption(options)?.value ?? "";
  if (t.startsWith("@")) return t.slice(1).trim();
  const n = Number.parseInt(t, 10);
  if (Number.isInteger(n) && String(n) === t && n >= 1 && n <= options.length) {
    return options[n - 1].value;
  }
  const lower = t.toLowerCase();
  const match = options.find(
    (o) => o.value.toLowerCase() === lower || o.label.toLowerCase() === lower,
  );
  return match ? match.value : t;
}

/**
 * Presents the options and returns the chosen value (or a free-text custom
 * answer). Empty input picks the recommended/first option.
 */
export async function chooseWith(
  io: AgentIO,
  question: string,
  options: ChoiceOption[],
  opts: { customHint?: string } = {},
): Promise<string> {
  // Rich terminal: arrow-key selection. Otherwise a numbered text prompt.
  if (io.select) {
    return io.select(question, options, { allowCustom: true, customLabel: opts.customHint });
  }
  io.say(question);
  options.forEach((o, i) => {
    io.say(`  ${i + 1}) ${o.label}${o.recommended ? " (recommended)" : ""}`);
    if (o.description) io.info(`       ${o.description}`);
  });
  const def = defaultOption(options);
  const hint = opts.customHint ?? "type your own answer";
  const answer = await io.ask(`Pick a number, or ${hint}${def ? ` [${def.label}]` : ""}:`);
  return resolveChoice(answer, options);
}
