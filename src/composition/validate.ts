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
