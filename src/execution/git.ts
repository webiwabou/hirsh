/**
 * Minimal git helpers for packaging (Phase 5).
 *
 * A generated pipeline becomes a real repository so it can be versioned and
 * published — and so `nf-core lint` stops failing for "not a git repository".
 * Never destructive: only init + add + commit on a fresh directory.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function isGitAvailable(): Promise<boolean> {
  try {
    await run("git", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export interface GitInitResult {
  ok: boolean;
  error?: string;
}

/**
 * Initializes a git repo in `dir` (if not already one) and makes an initial
 * commit of everything. Idempotent-ish: if a repo already exists it just commits.
 */
export async function initAndCommit(dir: string, message: string): Promise<GitInitResult> {
  const git = (args: string[]) => run("git", args, { cwd: dir, timeout: 30_000 });
  try {
    await git(["init", "-b", "main"]).catch(() => git(["init"]));
    // Ensure an author identity exists for the commit (local, non-invasive).
    await git(["config", "user.name"]).catch(() => git(["config", "user.name", "Hirsh"]));
    await git(["config", "user.email"]).catch(() =>
      git(["config", "user.email", "hirsh@localhost"]),
    );
    await git(["add", "-A"]);
    await git(["commit", "-m", message, "--no-gpg-sign"]);
    return { ok: true };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, error: (e.stderr || e.message || String(err)).split("\n").slice(0, 3).join("\n") };
  }
}
