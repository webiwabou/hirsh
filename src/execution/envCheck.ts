/**
 * Execution environment check: verifies that Nextflow and a container engine
 * (Docker or Singularity) are available on PATH.
 *
 * It does not throw: it returns a report so the CLI can show actionable messages
 * and decide whether to allow the execution phase.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ContainerEngine } from "../config/types.js";

const run = promisify(execFile);

export interface ToolStatus {
  name: string;
  available: boolean;
  version?: string;
  hint?: string;
}

export interface EnvReport {
  nextflow: ToolStatus;
  container: ToolStatus;
  /** true if a pipeline run can be attempted. */
  canExecute: boolean;
}

async function which(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 10_000 });
    return { ok: true, out: (stdout || stderr).trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

async function checkNextflow(): Promise<ToolStatus> {
  const res = await which("nextflow", ["-version"]);
  if (!res.ok) {
    return {
      name: "nextflow",
      available: false,
      hint:
        "Nextflow is not on PATH. Install it with `curl -s https://get.nextflow.io | bash` " +
        "and move it to a directory on PATH, or see https://www.nextflow.io/docs/latest/install.html.",
    };
  }
  const version = res.out.split("\n").find((l) => /version/i.test(l))?.trim() ?? res.out.split("\n")[0];
  return { name: "nextflow", available: true, version };
}

async function checkContainer(engine: ContainerEngine): Promise<ToolStatus> {
  if (engine === "singularity") {
    const res = await which("singularity", ["--version"]);
    if (res.ok) return { name: "singularity", available: true, version: res.out };
    // Apptainer is the successor to Singularity and shares the CLI.
    const alt = await which("apptainer", ["--version"]);
    if (alt.ok) return { name: "apptainer", available: true, version: alt.out };
    return {
      name: "singularity",
      available: false,
      hint:
        "Singularity/Apptainer was not found on PATH. Install it (https://apptainer.org/) " +
        'or set execution.containerEngine to "docker" in your config.',
    };
  }

  const res = await which("docker", ["--version"]);
  if (res.ok) return { name: "docker", available: true, version: res.out };
  return {
    name: "docker",
    available: false,
    hint:
      "Docker is not on PATH. Install it (https://docs.docker.com/get-docker/) and make sure " +
      'the daemon is running, or set execution.containerEngine to "singularity".',
  };
}

export async function checkEnvironment(engine: ContainerEngine): Promise<EnvReport> {
  const [nextflow, container] = await Promise.all([checkNextflow(), checkContainer(engine)]);
  return { nextflow, container, canExecute: nextflow.available && container.available };
}
