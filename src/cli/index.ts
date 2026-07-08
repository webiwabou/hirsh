#!/usr/bin/env node
/**
 * Hirsh — REPL entry point.
 *
 * Loads config and the pipeline registry, builds the LLM provider, checks the
 * environment and drives the conversational loop. Configuration, provider and
 * environment errors are surfaced as clear messages, never as raw stack traces.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { resolveWorkspace } from "./workspace.js";
import { runInit } from "./init.js";
import { formatRunsTable, listRuns } from "./runsList.js";
import { ConfigError, loadConfig } from "../config/loadConfig.js";
import type { HirshConfig } from "../config/types.js";
import { createProvider, ProviderError, type LLMProvider } from "../llm/index.js";
import { loadRegistry, RegistryError } from "../pipelines/registry.js";
import { checkEnvironment } from "../execution/envCheck.js";
import { Agent } from "../conversation/stateMachine.js";
import {
  createSession,
  ExitSignal,
  PHASE_LABEL,
  ResetSignal,
  type Session,
} from "../conversation/session.js";
import { TerminalIO } from "./terminalIO.js";
import { AutonomousIO } from "./autonomousIO.js";
import type { AgentIO } from "../conversation/io.js";
import { renderWelcome } from "./banner.js";

const HELP = [
  chalk.bold("Commands"),
  "  /status   Show the current phase and the context gathered so far.",
  "  /help     Show this help.",
  "  /reset    Restart the conversation from scratch.",
  "  /exit     Quit Hirsh.",
  "",
  "At any open prompt, type your answer and press Enter.",
].join("\n");

function statusText(session: Session, config: HirshConfig, provider: LLMProvider): string {
  const q = session.query;
  const lines = [
    chalk.bold("Session status"),
    `  Phase: ${PHASE_LABEL[session.phase]}`,
    `  LLM provider: ${provider.label}`,
    `  Container engine: ${config.execution.containerEngine}`,
    `  Executor: ${config.execution.executor ?? "local"}`,
    "  Context:",
    `    Organism: ${q.organism ?? "—"}`,
    `    Data type: ${q.dataType ?? "—"}`,
    `    Objective: ${q.objective ?? "—"}`,
    `    Design: ${q.experimentalDesign ?? "—"}`,
    `  Pipeline: ${session.selectedPipeline?.name ?? "—"}`,
  ];
  if (session.command) lines.push(`  Command: nextflow ${session.command.join(" ")}`);
  return lines.join("\n");
}

function fatal(message: string): never {
  process.stderr.write(chalk.red("\n" + message) + "\n");
  process.exit(1);
}

/** `hirsh init [path]` — scaffold a project workspace, then exit (no REPL). */
function handleInit(args: string[]): void {
  const pathArg = args[1] && !args[1].startsWith("-") ? args[1] : ".";
  const res = runInit(resolve(process.cwd(), pathArg));
  process.stdout.write(chalk.bold(`\nInitialized Hirsh workspace at ${res.workspace}\n`));
  for (const f of res.created) process.stdout.write(chalk.green(`  created  ${f}\n`));
  for (const f of res.updated) process.stdout.write(chalk.cyan(`  updated  ${f}\n`));
  for (const f of res.skipped) process.stdout.write(chalk.gray(`  kept     ${f} (already present)\n`));
  process.stdout.write(
    chalk.gray("\nEdit config.yaml, then run ") + chalk.cyan("hirsh") + chalk.gray(" here to begin.\n"),
  );
}

/** `hirsh runs` — list the runs recorded in the current workspace. */
function handleRuns(): void {
  let workdir = "./runs";
  try {
    workdir = loadConfig().config.execution.workdir;
  } catch {
    /* fall back to ./runs */
  }
  process.stdout.write(chalk.bold(`\nRuns in ${resolve(workdir)}\n\n`));
  process.stdout.write(formatRunsTable(listRuns(resolve(workdir))) + "\n");
}

async function main(): Promise<void> {
  // --- Subcommands ---
  const argv = process.argv.slice(2);
  if (argv[0] === "init") {
    handleInit(argv);
    return;
  }
  if (argv[0] === "runs") {
    const ws = resolveWorkspace(argv.slice(1), process.env, process.cwd());
    if (ws.source !== "cwd" && existsSync(ws.path) && statSync(ws.path).isDirectory()) {
      process.chdir(ws.path);
    }
    handleRuns();
    return;
  }

  // --- Workspace ---
  // Operate inside the scientist's chosen project folder (like an editor opened
  // in a directory): runs, ./config.yaml and per-project memory land there, not
  // inside the Hirsh install. `hirsh [path]` / `--workdir <path>` / HIRSH_WORKSPACE.
  const ws = resolveWorkspace(process.argv.slice(2), process.env, process.cwd());
  if (ws.source !== "cwd") {
    if (!existsSync(ws.path) || !statSync(ws.path).isDirectory()) {
      fatal(`Workspace directory not found: ${ws.path}`);
    }
    process.chdir(ws.path);
  }

  // --- Configuration ---
  let config: HirshConfig;
  let sourcePath: string | null;
  try {
    ({ config, sourcePath } = loadConfig());
  } catch (err) {
    if (err instanceof ConfigError) fatal("Configuration error: " + err.message);
    throw err;
  }

  // --- Pipeline registry ---
  let registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    if (err instanceof RegistryError) fatal("Failed to load pipelines: " + err.message);
    throw err;
  }

  // --- LLM provider ---
  let provider: LLMProvider;
  try {
    provider = createProvider(config);
  } catch (err) {
    if (err instanceof ProviderError) fatal(err.message);
    throw err;
  }

  // --- Environment check (informational; does not block the conversation) ---
  const env = await checkEnvironment(config.execution.containerEngine);
  const envLine = env.canExecute
    ? chalk.green("ready") + chalk.gray(` · ${env.nextflow.version ?? "nextflow"} · ${env.container.name}`)
    : chalk.yellow("missing tools (see below)");

  // --- Welcome banner ---
  process.stdout.write(
    renderWelcome({
      providerLabel: provider.label,
      configSource: sourcePath ?? "defaults (no file)",
      pipelines: registry.map((p) => p.name.split("/").pop() ?? p.name),
      envLine,
      cwd: process.cwd(),
    }),
  );

  if (!env.canExecute) {
    process.stdout.write(chalk.yellow("\nMissing software required to run pipelines:\n"));
    if (!env.nextflow.available) process.stdout.write(chalk.yellow(`  • ${env.nextflow.hint}\n`));
    if (!env.container.available) process.stdout.write(chalk.yellow(`  • ${env.container.hint}\n`));
    process.stdout.write(
      chalk.gray("You can still converse and prepare the command; execution stays blocked until installed.\n"),
    );
  }

  // --- LLM provider health check ---
  try {
    await provider.healthCheck();
  } catch (err) {
    const msg = err instanceof ProviderError ? err.message : String(err);
    fatal("The LLM provider is not available: " + msg);
  }

  process.stdout.write("\n");

  // --- Conversational loop ---
  let session = createSession();
  const io = new TerminalIO({
    getStatus: () => statusText(session, config, provider),
    getHelp: () => HELP,
  });

  // Autonomous mode: enabled by config or the --auto flag. It reduces friction
  // (auto-answers reversible confirmations) but still asks for missing info and
  // stops at consequential decisions.
  const autonomous = config.autonomy.enabled || process.argv.slice(2).includes("--auto");
  const agentIo: AgentIO = autonomous ? new AutonomousIO(io) : io;
  if (autonomous) {
    io.info(
      "Autonomous mode: I'll proceed through reversible steps on my own and only stop for " +
        "missing information or decisions that are yours (running-with-a-warning, publishing).",
    );
  }

  try {
    for (;;) {
      session = createSession();
      const agent = new Agent(provider, config, registry, agentIo, sourcePath ?? undefined, autonomous);
      try {
        await agent.run(session);
        const again = await io.confirm("\nStart another analysis?", false);
        if (!again) break;
      } catch (err) {
        if (err instanceof ResetSignal) {
          io.info("\nConversation reset.");
          continue;
        }
        if (err instanceof ExitSignal) break;
        if (err instanceof ProviderError) {
          io.warn("\nLLM problem: " + err.message);
          continue;
        }
        throw err;
      }
    }
  } finally {
    io.close();
  }
  process.stdout.write(chalk.cyan("\nSee you!\n"));
}

main().catch((err) => {
  process.stderr.write(
    chalk.red("\nUnexpected error: " + (err instanceof Error ? err.message : String(err))) + "\n",
  );
  process.exit(1);
});
