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
  /** Yes/no confirmation. */
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  /** Writes a chunk without a newline (for streaming LLM tokens). */
  raw(chunk: string): void;
  /** Closes the current streaming line with a newline. */
  endStream(): void;
  /** Runs an async task while showing a progress indicator. */
  withSpinner<T>(label: string, task: () => Promise<T>): Promise<T>;
}
