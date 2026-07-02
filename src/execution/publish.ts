/**
 * Assisted GitHub publishing (Phase 5).
 *
 * Publishing is an outward-facing, consequential action, so it is strictly
 * opt-in and gated by explicit confirmation in the caller — this module only
 * checks the `gh` CLI and, when told to, creates and pushes the repository.
 * Nothing here runs without the user having said yes.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GhStatus {
  /** The gh CLI is installed. */
  installed: boolean;
  /** gh is authenticated to a GitHub account. */
  authenticated: boolean;
  /** Actionable note when not usable. */
  note?: string;
}

export async function checkGhCli(): Promise<GhStatus> {
  try {
    await run("gh", ["--version"], { timeout: 10_000 });
  } catch {
    return {
      installed: false,
      authenticated: false,
      note: "GitHub CLI not found. Install `gh` (https://cli.github.com/) and run `gh auth login` to publish.",
    };
  }
  try {
    await run("gh", ["auth", "status"], { timeout: 15_000 });
    return { installed: true, authenticated: true };
  } catch {
    return {
      installed: true,
      authenticated: false,
      note: "GitHub CLI is installed but not authenticated. Run `gh auth login`, then retry.",
    };
  }
}

export interface PublishOptions {
  /** Repository name to create. */
  name: string;
  /** Visibility. Defaults to private for safety. */
  visibility?: "public" | "private";
  /** One-line repo description. */
  description?: string;
}

export interface PublishResult {
  ok: boolean;
  url?: string;
  error?: string;
}

/**
 * Creates a GitHub repository from `dir` and pushes it. MUST only be called after
 * the user has explicitly confirmed publishing (the caller is responsible for
 * that consent and for defaulting to private).
 */
export async function createGitHubRepo(dir: string, opts: PublishOptions): Promise<PublishResult> {
  const visibility = opts.visibility ?? "private";
  const args = [
    "repo",
    "create",
    opts.name,
    `--${visibility}`,
    "--source=.",
    "--remote=origin",
    "--push",
  ];
  if (opts.description) args.push("--description", opts.description);
  try {
    const { stdout, stderr } = await run("gh", args, { cwd: dir, timeout: 120_000 });
    const out = `${stdout}\n${stderr}`;
    const url = /(https:\/\/github\.com\/\S+)/.exec(out)?.[1];
    return { ok: true, url };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    return {
      ok: false,
      error: (e.stderr || e.stdout || e.message || String(err)).split("\n").slice(0, 4).join("\n"),
    };
  }
}
