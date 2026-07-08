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
        'or choose another backend (e.g. "docker" or "conda").',
    };
  }

  if (engine === "conda" || engine === "mamba") {
    const res = await which(engine, ["--version"]);
    if (res.ok) return { name: engine, available: true, version: res.out };
    return {
      name: engine,
      available: false,
      hint:
        `${engine} is not on PATH. Install Conda/Mamba (Miniforge: ` +
        "https://github.com/conda-forge/miniforge) or choose a container backend.",
    };
  }

  const cli = await which("docker", ["--version"]);
  // The Docker CLI can be present while the daemon is down — a run would then fail
  // cryptically mid-way, so check the daemon is reachable before allowing it.
  const daemonOk = cli.ok && (await which("docker", ["info", "--format", "{{.ServerVersion}}"])).ok;
  return dockerStatus(cli, daemonOk);
}

const DOCKER_NOT_INSTALLED =
  "Docker is not on PATH. Install it (https://docs.docker.com/get-docker/) and make sure " +
  'the daemon is running, or choose another backend (e.g. "singularity" or "conda").';
const DOCKER_DAEMON_DOWN =
  "Docker is installed but its daemon isn't reachable — start Docker (e.g. `sudo systemctl start docker`, " +
  'or launch Docker Desktop), then retry. You can also choose another backend (e.g. "conda").';

/**
 * Decides Docker's status from the CLI-present and daemon-reachable checks. A
 * present CLI with an unreachable daemon is reported as NOT usable (with a daemon
 * hint), since a real run would fail. Pure, so the decision is unit-tested.
 */
export function dockerStatus(cli: { ok: boolean; out: string }, daemonOk: boolean): ToolStatus {
  if (!cli.ok) return { name: "docker", available: false, hint: DOCKER_NOT_INSTALLED };
  if (!daemonOk) return { name: "docker", available: false, version: cli.out, hint: DOCKER_DAEMON_DOWN };
  return { name: "docker", available: true, version: cli.out };
}

export async function checkEnvironment(engine: ContainerEngine): Promise<EnvReport> {
  const [nextflow, container] = await Promise.all([checkNextflow(), checkContainer(engine)]);
  return { nextflow, container, canExecute: nextflow.available && container.available };
}
