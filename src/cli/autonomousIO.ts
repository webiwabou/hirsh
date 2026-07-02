/**
 * Autonomous-mode IO decorator (Phase 6 — end-to-end autonomy with guardrails).
 *
 * Wraps any AgentIO so Hirsh runs a request to an interpreted answer without
 * pausing for reversible confirmations — it auto-answers those with their
 * intended value (announcing each decision for transparency) — while still:
 *   - asking open questions when information is genuinely missing (ask()), and
 *   - stopping at decisions only a human should make (opts.consequential):
 *     publishing, spending, or overriding a safety recommendation.
 *
 * This keeps the invariant that nothing consequential happens without explicit
 * human consent, even when running autonomously.
 */
import type { AgentIO } from "../conversation/io.js";

export class AutonomousIO implements AgentIO {
  constructor(private readonly base: AgentIO) {}

  say(text: string): void {
    this.base.say(text);
  }
  info(text: string): void {
    this.base.info(text);
  }
  warn(text: string): void {
    this.base.warn(text);
  }
  heading(text: string): void {
    this.base.heading(text);
  }
  raw(chunk: string): void {
    this.base.raw(chunk);
  }
  endStream(): void {
    this.base.endStream();
  }
  withSpinner<T>(label: string, task: () => Promise<T>): Promise<T> {
    return this.base.withSpinner(label, task);
  }

  /** Open questions still need a human — autonomy reduces friction, not input. */
  ask(question: string): Promise<string> {
    return this.base.ask(question);
  }

  async confirm(
    question: string,
    defaultYes = true,
    opts?: { consequential?: boolean; auto?: boolean },
  ): Promise<boolean> {
    if (opts?.consequential) {
      this.base.warn("This decision is yours to make (autonomy pauses here):");
      return this.base.confirm(question, defaultYes, opts);
    }
    const value = opts?.auto ?? defaultYes;
    this.base.info(`[auto] ${question} → ${value ? "yes" : "no"}`);
    return value;
  }

  /** In autonomous mode, take the default decision (typically: accept and proceed). */
  async confirmOrText(
    question: string,
    defaultYes = true,
  ): Promise<{ decision: boolean } | { text: string }> {
    this.base.info(`[auto] ${question} → ${defaultYes ? "yes" : "no"}`);
    return { decision: defaultYes };
  }
}
