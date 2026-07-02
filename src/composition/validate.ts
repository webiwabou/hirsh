/**
 * Validation for a generated pipeline (Phase F4).
 *
 * Honest, cheap gates that need no test data:
 *   - `nextflow config <dir>`: confirms the generated config/DSL scaffolding parses.
 *   - detect the `nf-core` CLI so the user can run full `nf-core lint` themselves.
 *
 * Deeper validation (stub-run of the wiring, `nf-core lint` in CI) is a roadmap
 * item; we do not claim a composed pipeline is runnable, only that it is
 * well-formed and pinned.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ValidationResult {
  configOk: boolean;
  configError?: string;
  nfCoreCli: { available: boolean; note?: string };
}

export interface StubResult {
  ok: boolean;
  error?: string;
}

export interface LintResult {
  /** The nf-core CLI was present and usable. */
  available: boolean;
  /** Lint actually executed (vs. couldn't run). */
  ran: boolean;
  passed?: number;
  warned?: number;
  failed?: number;
  /** Short titles/messages of failed (and, if none, warned) checks. */
  findings: string[];
  /** Why lint couldn't run, when ran is false. */
  error?: string;
}

export async function validateGenerated(dir: string): Promise<ValidationResult> {
  const [configOk, configError] = await checkNextflowConfig(dir);
  const nfCoreCli = await checkNfCoreCli();
  return { configOk, configError, nfCoreCli };
}

/**
 * Executes the whole DAG via `-profile test -stub-run`: no containers, no real
 * data — every module runs its `stub:` block (touch outputs). This is the real
 * "does it run end-to-end without editing" gate for a composed pipeline.
 */
export async function stubRun(dir: string): Promise<StubResult> {
  try {
    await run(
      "nextflow",
      ["run", ".", "-profile", "test", "-stub-run", "-ansi-log", "false", "--outdir", "results_test"],
      { cwd: dir, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
    );
    return { ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const combined = [e.stdout ?? "", e.stderr ?? "", e.message ?? String(err)].join("\n");
    const idx = combined.indexOf("ERROR ~");
    const snippet =
      idx >= 0
        ? combined.slice(idx).split("\n").slice(0, 20).join("\n")
        : combined.split("\n").filter((l) => l.trim()).slice(-18).join("\n");
    return { ok: false, error: snippet.trim() };
  }
}

/** Strips ANSI colour codes so the rich-formatted lint output can be parsed. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Parses `nf-core lint` output into pass/warn/fail counts and a few failure
 * titles. Pure and tolerant of the rich box formatting and version differences.
 */
export function parseLintOutput(raw: string): {
  passed?: number;
  warned?: number;
  failed?: number;
  findings: string[];
} {
  const text = stripAnsi(raw);
  const num = (re: RegExp): number | undefined => {
    const m = re.exec(text);
    return m ? Number(m[1]) : undefined;
  };
  const passed = num(/(\d+)\s+Tests?\s+Passed/i);
  const warned = num(/(\d+)\s+Tests?\s+Warn(?:ed|ing)/i);
  const failed = num(/(\d+)\s+Tests?\s+Failed/i);

  const findings: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // "Test Failed: …" lines are always failures; bare cross-mark lines are only
    // failures when they carry a "check: detail" (avoids panel section headers
    // like "[✗] Pipeline Tests").
    const named = /\bTest Failed:?\s*(.+)$/i.exec(trimmed);
    const marked = /(?:✗|✘)\s*(.+)$/.exec(trimmed);
    let detail = named ? named[1] : marked ? marked[1] : "";
    detail = detail.replace(/[│╰╭─╮╯]+/g, "").trim();
    if (!detail || /Tests?\s+(Failed|Passed|Warn|Ignored)/i.test(detail)) continue;
    if (!named && !detail.includes(":")) continue;
    if (seen.has(detail)) continue;
    seen.add(detail);
    findings.push(detail);
  }
  return { passed, warned, failed, findings: findings.slice(0, 8) };
}

/** Picks `nf-core pipelines lint` (v3+) or `nf-core lint` (older) by version. */
function lintArgs(version: string, dir: string): string[] {
  const major = Number(/version\s+(\d+)/i.exec(version)?.[1] ?? /^\D*(\d+)/.exec(version)?.[1] ?? "0");
  const base = major >= 3 ? ["pipelines", "lint"] : ["lint"];
  return [...base, "--dir", dir];
}

/**
 * Runs `nf-core lint` on a generated pipeline as an in-the-loop quality gate.
 * Composed projects won't be fully green, so this is advisory: it surfaces the
 * pass/warn/fail counts and top failures rather than blocking.
 */
export async function lintPipeline(dir: string): Promise<LintResult> {
  const cli = await checkNfCoreCli();
  if (!cli.available) {
    return { available: false, ran: false, findings: [], error: cli.note };
  }
  let version = "";
  try {
    const v = await run("nf-core", ["--version"], { timeout: 15_000 });
    version = (v.stdout || v.stderr).trim();
  } catch {
    /* detected above; keep default */
  }
  try {
    const { stdout, stderr } = await run("nf-core", lintArgs(version, dir), {
      cwd: dir,
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const parsed = parseLintOutput(`${stdout}\n${stderr}`);
    return { available: true, ran: true, ...parsed };
  } catch (err) {
    // Lint exits non-zero when there are failures — that's a normal result, so
    // parse its output rather than treating it as an error.
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const combined = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    const parsed = parseLintOutput(combined);
    if (parsed.passed != null || parsed.failed != null) {
      return { available: true, ran: true, ...parsed };
    }
    return {
      available: true,
      ran: false,
      findings: [],
      error: (e.message ?? String(err)).split("\n").slice(0, 4).join("\n"),
    };
  }
}

async function checkNextflowConfig(dir: string): Promise<[boolean, string | undefined]> {
  try {
    await run("nextflow", ["config", dir], { timeout: 60_000 });
    return [true, undefined];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Keep only the most relevant tail of Nextflow's message.
    const short = msg.split("\n").filter((l) => l.trim()).slice(-6).join("\n");
    return [false, short];
  }
}

async function checkNfCoreCli(): Promise<{ available: boolean; note?: string }> {
  try {
    const { stdout, stderr } = await run("nf-core", ["--version"], { timeout: 15_000 });
    const out = (stdout || stderr).trim();
    if (/nf-core/i.test(out)) return { available: true };
    return {
      available: false,
      note: "An `nf-core` command exists but did not respond as expected (e.g. a container wrapper needing a TTY).",
    };
  } catch {
    return {
      available: false,
      note: "Install the nf-core CLI (`pip install nf-core`) to run `nf-core pipelines lint` on the generated project.",
    };
  }
}
