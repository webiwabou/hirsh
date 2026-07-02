/**
 * Terminal presentation: ASCII DNA-helix logo, a rounded welcome frame and
 * inline tips, in the spirit of Claude Code's launch banner.
 *
 * All rendering is pure string building so it can be tested without a TTY.
 */
import chalk from "chalk";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible length of a string, ignoring ANSI color escapes. */
function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

/** The DNA double-helix logo (5 lines). */
export function renderLogo(): string {
  const strand = chalk.cyan;
  const rung = chalk.green;
  const base = chalk.greenBright;
  const L = [
    strand("  ╲   ╱   ╲   ╱   ╲   ╱"),
    strand("   ╲ ╱     ╲ ╱     ╲ ╱"),
    base("    ●") + rung("───────") + base("●") + rung("───────") + base("●"),
    strand("   ╱ ╲     ╱ ╲     ╱ ╲"),
    strand("  ╱   ╲   ╱   ╲   ╱   ╲"),
  ];
  return L.join("\n");
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

/** Full welcome screen: logo + framed title/meta + tips. */
export function renderWelcome(info: WelcomeInfo): string {
  const logo = renderLogo();

  const title =
    chalk.bold.cyan("Hirsh") + chalk.gray("  ·  bioinformatics pipeline agent");
  const meta = [
    chalk.gray("model    ") + info.providerLabel,
    chalk.gray("config   ") + info.configSource,
    chalk.gray("pipelines") + " " + info.pipelines.join(", "),
    chalk.gray("env      ") + info.envLine,
  ];
  const tips = [
    chalk.gray("Tips"),
    chalk.gray("  •  describe your analysis in plain English to begin"),
    chalk.gray("  •  ") + chalk.white("/help") + chalk.gray("  commands   ") + chalk.white("/status") + chalk.gray("  progress"),
    chalk.gray("  •  ") + chalk.white("/reset") + chalk.gray(" restart    ") + chalk.white("/exit") + chalk.gray("   quit"),
  ];

  // Divider spans the widest content line so it reads as a full separator.
  const contentWidth = Math.max(...[title, ...meta, ...tips].map(visibleLength));
  const divider = chalk.gray("─".repeat(contentWidth));

  const framed = box([title, "", ...meta, divider, ...tips]);

  return "\n" + indent(logo, 2) + "\n\n" + framed + "\n";
}

function indent(block: string, n: number): string {
  const prefix = " ".repeat(n);
  return block
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}
