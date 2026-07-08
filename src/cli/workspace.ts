/**
 * Workspace resolution.
 *
 * Like running an editor (or Claude Code) in a directory, Hirsh operates inside a
 * chosen **workspace** — the scientist's own project folder — so runs, config and
 * per-project memory land there, not inside the Hirsh install. The workspace is
 * picked (highest precedence first) from `--workdir/-C <path>`, a bare positional
 * path, the `HIRSH_WORKSPACE` env var, or the current directory.
 *
 * Pure (args in, path out) so it is unit-tested; the CLI does the chdir/validation.
 */
import { resolve } from "node:path";

/** Flags Hirsh consumes itself, so they're never mistaken for a workspace path. */
const KNOWN_FLAGS = new Set(["--auto"]);

export interface WorkspaceChoice {
  /** Absolute workspace path. */
  path: string;
  /** How it was chosen (for a clear banner/announcement). */
  source: "flag" | "positional" | "env" | "cwd";
}

/**
 * Resolves the workspace directory from CLI args and environment. Returns an
 * absolute path (resolved against `cwd`) and how it was chosen. Pure.
 */
export function resolveWorkspace(
  argv: string[],
  env: { HIRSH_WORKSPACE?: string },
  cwd: string,
): WorkspaceChoice {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workdir" || a === "-C") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) return { path: resolve(cwd, next), source: "flag" };
    } else if (a.startsWith("--workdir=")) {
      const v = a.slice("--workdir=".length);
      if (v) return { path: resolve(cwd, v), source: "flag" };
    }
  }

  // A bare positional path (not a flag, not the value of --workdir/-C).
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--workdir" || a === "-C") {
      i++; // skip its value
      continue;
    }
    if (a.startsWith("-")) continue; // a flag (e.g. --auto)
    if (KNOWN_FLAGS.has(a)) continue;
    return { path: resolve(cwd, a), source: "positional" };
  }

  if (env.HIRSH_WORKSPACE && env.HIRSH_WORKSPACE.trim() !== "") {
    return { path: resolve(cwd, env.HIRSH_WORKSPACE), source: "env" };
  }
  return { path: resolve(cwd), source: "cwd" };
}

/** The per-project data directory inside a workspace (memory, learned pipelines). */
export function projectDataDir(workspace: string): string {
  return resolve(workspace, ".hirsh");
}
