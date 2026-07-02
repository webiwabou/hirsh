/**
 * I/O interface the state machine uses to talk to the user. The concrete
 * implementation (terminal via readline/inquirer) lives in src/cli. Decoupling
 * it this way lets us test the flow or swap the frontend without touching the
 * conversational logic.
 */

export interface AgentIO {
  /** Agent message (normal text, with a trailing newline). */
  say(text: string): void;
  /** Informational/secondary message (dimmed). */
  info(text: string): void;
  /** Warning (non-fatal). */
  warn(text: string): void;
  /** Section/phase heading. */
  heading(text: string): void;
  /** Open question; returns the user's answer (text). */
  ask(question: string): Promise<string>;
  /**
   * Yes/no confirmation (accepts natural-language yes/no phrasings).
   *
   * `opts.consequential` marks a decision only a human should make (publishing,
   * spending, overriding a safety recommendation) — an autonomous frontend must
   * still ask these. `opts.auto` is the value to use in autonomous mode when the
   * decision is NOT consequential (defaults to `defaultYes`).
   */
  confirm(
    question: string,
    defaultYes?: boolean,
    opts?: { consequential?: boolean; auto?: boolean },
  ): Promise<boolean>;
  /**
   * Like confirm, but a natural-language answer that isn't a clear yes/no is
   * returned as free text so the caller can act on it (e.g. a redirect). Empty
   * input takes the default decision.
   */
  confirmOrText(
    question: string,
    defaultYes?: boolean,
  ): Promise<{ decision: boolean } | { text: string }>;
  /** Writes a chunk without a newline (for streaming LLM tokens). */
  raw(chunk: string): void;
  /** Closes the current streaming line with a newline. */
  endStream(): void;
  /** Runs an async task while showing a progress indicator. */
  withSpinner<T>(label: string, task: () => Promise<T>): Promise<T>;
}
