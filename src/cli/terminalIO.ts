/**
 * Terminal implementation of AgentIO, on top of readline/promises + chalk.
 *
 * Transparently intercepts special commands (/status, /help, /reset, /exit):
 * the state machine never sees them, only "real" answers. /reset and /exit
 * propagate as signals the main loop catches.
 */
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import type { AgentIO } from "../conversation/io.js";
import { interpretYesNo } from "../conversation/answers.js";
import { ExitSignal, ResetSignal } from "../conversation/session.js";

export interface TerminalIOHooks {
  /** Returns the /status text (current phase, context, etc.). */
  getStatus: () => string;
  /** Returns the /help text. */
  getHelp: () => string;
}

export class TerminalIO implements AgentIO {
  private readonly rl: readline.Interface;

  constructor(private readonly hooks: TerminalIOHooks) {
    this.rl = readline.createInterface({ input: stdin, output: stdout });
  }

  close(): void {
    this.rl.close();
  }

  say(text: string): void {
    stdout.write(text + "\n");
  }

  info(text: string): void {
    stdout.write(chalk.gray(text) + "\n");
  }

  warn(text: string): void {
    stdout.write(chalk.yellow(text) + "\n");
  }

  heading(text: string): void {
    stdout.write("\n" + chalk.bold.cyan("── " + text + " ──") + "\n");
  }

  raw(chunk: string): void {
    stdout.write(chunk);
  }

  endStream(): void {
    stdout.write("\n");
  }

  async ask(question: string): Promise<string> {
    for (;;) {
      const prompt = question
        ? chalk.green(question) + "\n" + chalk.green("› ")
        : chalk.green("› ");
      let line: string;
      try {
        line = await this.rl.question(prompt);
      } catch {
        // readline closed (EOF / Ctrl+D)
        throw new ExitSignal();
      }
      const handled = this.maybeHandleCommand(line.trim());
      if (!handled) return line.trim();
    }
  }

  async confirm(question: string, defaultYes = true): Promise<boolean> {
    const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
    for (;;) {
      const answer = await this.ask(question + suffix);
      if (answer === "") return defaultYes;
      const yn = interpretYesNo(answer);
      if (yn !== null) return yn;
      this.warn("Sorry, I couldn't tell if that was a yes or a no — try again (or /help).");
    }
  }

  async confirmOrText(
    question: string,
    defaultYes = true,
  ): Promise<{ decision: boolean } | { text: string }> {
    const suffix = defaultYes ? " [Y/n, or tell me more] " : " [y/N, or tell me more] ";
    const answer = await this.ask(question + suffix);
    if (answer === "") return { decision: defaultYes };
    const yn = interpretYesNo(answer);
    if (yn !== null) return { decision: yn };
    return { text: answer };
  }

  async withSpinner<T>(label: string, task: () => Promise<T>): Promise<T> {
    const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let i = 0;
    const isTTY = stdout.isTTY;
    let timer: NodeJS.Timeout | undefined;
    if (isTTY) {
      timer = setInterval(() => {
        stdout.write("\r" + chalk.gray(`${frames[i % frames.length]} ${label}…`));
        i++;
      }, 90);
    } else {
      stdout.write(chalk.gray(`${label}…\n`));
    }
    try {
      return await task();
    } finally {
      if (timer) {
        clearInterval(timer);
        stdout.write("\r" + " ".repeat(label.length + 4) + "\r");
      }
    }
  }

  /** Returns true if the line was a special command and it was handled. */
  private maybeHandleCommand(line: string): boolean {
    if (!line.startsWith("/")) return false;
    const cmd = line.split(/\s+/)[0].toLowerCase();
    switch (cmd) {
      case "/status":
        this.say(this.hooks.getStatus());
        return true;
      case "/help":
        this.say(this.hooks.getHelp());
        return true;
      case "/reset":
        throw new ResetSignal();
      case "/exit":
      case "/quit":
        throw new ExitSignal();
      default:
        this.warn(`Unknown command: ${cmd}. Use /help.`);
        return true;
    }
  }
}
