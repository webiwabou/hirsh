/**
 * Terminal presentation: a small node-motif logo, a rounded welcome frame and
 * inline tips, in the spirit of Claude Code's launch banner — kept minimal.
 *
 * All rendering is pure string building so it can be tested without a TTY.
 */
import chalk from "chalk";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible length of a string, ignoring ANSI color escapes. */
function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/**
 * A compact one-line logo: a three-node "pipeline" motif and the wordmark.
 * (A minimal nod to connected analysis steps.)
 */
export function renderLogo(): string {
  const dot = chalk.cyan("●");
  const link = chalk.gray("──");
  const mark = dot + link + dot + link + dot;
  return `${mark}  ${chalk.bold.cyan("hirsh")}`;
}

/**
 * Wraps content lines in a rounded box sized to the widest visible line.
 * Content lines may contain ANSI colors.
 */
export function box(lines: string[], pad = 1): string {
  const inner = Math.max(...lines.map(visibleLength));
  const width = inner + pad * 2;
  const horizontal = "─".repeat(width);
  const top = chalk.gray("╭" + horizontal + "╮");
  const bottom = chalk.gray("╰" + horizontal + "╯");
  const spaces = " ".repeat(pad);
  const body = lines.map((line) => {
    const fill = " ".repeat(inner - visibleLength(line));
    return chalk.gray("│") + spaces + line + fill + spaces + chalk.gray("│");
  });
  return [top, ...body, bottom].join("\n");
}

export interface WelcomeInfo {
  providerLabel: string;
  configSource: string;
  pipelines: string[];
  envLine: string;
  cwd: string;
}

/** Full welcome screen: a minimal logo + tagline, then a light framed meta + tips. */
export function renderWelcome(info: WelcomeInfo): string {
  const logo = renderLogo();
  const tagline = chalk.gray("bioinformatics co-scientist");

  const label = (t: string) => chalk.gray(t.padEnd(10));
  const meta = [
    label("model") + info.providerLabel,
    label("config") + info.configSource,
    label("pipelines") + info.pipelines.join(", "),
    label("env") + info.envLine,
  ];
  const cmd = (c: string, d: string) => chalk.cyan(c) + chalk.gray(" " + d);
  const tips = [
    chalk.gray("describe your analysis in plain English to begin"),
    [cmd("/help", "commands"), cmd("/status", "progress"), cmd("/reset", "restart"), cmd("/exit", "quit")].join(
      chalk.gray("   "),
    ),
  ];

  // Divider spans the widest content line so it reads as a full separator.
  const contentWidth = Math.max(...[...meta, ...tips].map(visibleLength));
  const divider = chalk.gray("─".repeat(contentWidth));

  const framed = box([...meta, divider, ...tips]);

  return "\n  " + logo + "\n  " + tagline + "\n\n" + framed + "\n";
}
