/**
 * Execution-backend intelligence (Phase 3).
 *
 * Hirsh should decide *how* a pipeline runs, not just accept a single configured
 * value. This module detects which backends are actually available (Docker,
 * Singularity/Apptainer, Conda, Mamba), recommends the most reproducible one,
 * runs a short interactive selection, and — with explicit confirmation — can
 * bootstrap Nextflow itself on a machine that doesn't have it yet.
 *
 * The pure decision helpers (preference order, profile mapping, recommendation)
 * are separated from the impure probes/installers so they can be unit-tested.
 */
import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentIO, ChoiceOption } from "../conversation/io.js";
import { chooseWith } from "../conversation/choice.js";
import type { ContainerEngine } from "../config/types.js";

const run = promisify(execFile);

export type BackendKind = "container" | "conda";

export interface BackendInfo {
  engine: ContainerEngine;
  /** nf-core profile name to pass to `-profile`. */
  profile: string;
  label: string;
  kind: BackendKind;
  /** Command + args used to probe availability. */
  probe: { cmd: string; args: string[] };
  /** One-line reproducibility characterization, shown during selection. */
  note: string;
}

/**
 * Backend metadata. Container engines give the strongest reproducibility (pinned
 * image digests); conda/mamba resolve tool versions but not the full OS image.
 */
export const BACKENDS: Record<ContainerEngine, BackendInfo> = {
  docker: {
    engine: "docker",
    profile: "docker",
    label: "Docker",
    kind: "container",
    probe: { cmd: "docker", args: ["--version"] },
    note: "Containers — strongest reproducibility; needs the Docker daemon running.",
  },
  singularity: {
    engine: "singularity",
    profile: "singularity",
    label: "Singularity/Apptainer",
    kind: "container",
    probe: { cmd: "singularity", args: ["--version"] },
    note: "Containers, rootless — the usual choice on HPC clusters.",
  },
  conda: {
    engine: "conda",
    profile: "conda",
    label: "Conda",
    kind: "conda",
    probe: { cmd: "conda", args: ["--version"] },
    note: "Environments, no containers — works without root or a daemon; less hermetic.",
  },
  mamba: {
    engine: "mamba",
    profile: "mamba",
    label: "Mamba",
    kind: "conda",
    probe: { cmd: "mamba", args: ["--version"] },
    note: "Like Conda but with a much faster dependency solver.",
  },
};

/**
 * Preference order when recommending a backend: containers first (more
 * reproducible), and mamba over conda when only environments are available.
 */
export const PREFERENCE: ContainerEngine[] = ["docker", "singularity", "mamba", "conda"];

export interface BackendStatus {
  engine: ContainerEngine;
  available: boolean;
  version?: string;
}

/** Engines that were detected as available, in preference order. */
export function availableEngines(statuses: BackendStatus[]): ContainerEngine[] {
  const ok = new Set(statuses.filter((s) => s.available).map((s) => s.engine));
  return PREFERENCE.filter((e) => ok.has(e));
}

/**
 * Recommends the best backend among the available ones. Preference: keep the
 * configured engine if it's available; otherwise the most reproducible one
 * present. Returns null when nothing is available.
 */
export function recommendEngine(
  statuses: BackendStatus[],
  configured: ContainerEngine,
): ContainerEngine | null {
  const available = availableEngines(statuses);
  if (available.length === 0) return null;
  if (available.includes(configured)) return configured;
  return available[0];
}

/** nf-core profile name for an engine. */
export function backendProfile(engine: ContainerEngine): string {
  return BACKENDS[engine].profile;
}

async function probe(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 10_000 });
    return { ok: true, out: (stdout || stderr).trim().split("\n")[0] ?? "" };
  } catch {
    return { ok: false, out: "" };
  }
}

/** Probes all backends for availability. Never throws. */
export async function detectBackends(): Promise<BackendStatus[]> {
  const engines = Object.keys(BACKENDS) as ContainerEngine[];
  return Promise.all(
    engines.map(async (engine): Promise<BackendStatus> => {
      const info = BACKENDS[engine];
      let res = await probe(info.probe.cmd, info.probe.args);
      // Apptainer is the successor to Singularity and shares the CLI.
      if (!res.ok && engine === "singularity") {
        res = await probe("apptainer", ["--version"]);
      }
      return { engine, available: res.ok, version: res.ok ? res.out : undefined };
    }),
  );
}

/**
 * Short interactive backend selection. Detects what's available, recommends the
 * most reproducible option (keeping the configured one if present), and lets the
 * user confirm or switch. Returns the chosen engine, or null if none is
 * available and the user declined installation guidance.
 */
export async function chooseBackend(
  io: AgentIO,
  statuses: BackendStatus[],
  configured: ContainerEngine,
): Promise<ContainerEngine | null> {
  const available = availableEngines(statuses);

  if (available.length === 0) {
    io.warn("No execution backend was found (Docker, Singularity/Apptainer, Conda or Mamba).");
    io.info(
      "Install one to run pipelines reproducibly:\n" +
        "  • Docker: https://docs.docker.com/get-docker/\n" +
        "  • Singularity/Apptainer: https://apptainer.org/\n" +
        "  • Conda/Mamba (Miniforge): https://github.com/conda-forge/miniforge",
    );
    return null;
  }

  const recommended = recommendEngine(statuses, configured)!;

  if (available.length === 1) {
    const only = BACKENDS[available[0]];
    io.info(`Execution backend: ${only.label} (the only one available). ${only.note}`);
    return available[0];
  }

  // Recommended-options menu (arrow keys in a rich terminal; numbered otherwise).
  const options: ChoiceOption[] = available.map((engine) => ({
    value: engine,
    label: BACKENDS[engine].label,
    description: BACKENDS[engine].note,
    recommended: engine === recommended,
  }));
  const picked = await chooseWith(io, "Which execution backend should I use?", options, {
    allowCustom: false,
  });
  return (available as string[]).includes(picked) ? (picked as ContainerEngine) : recommended;
}

export interface BootstrapResult {
  installed: boolean;
  /** Directory the binary was placed in, when installed. */
  binDir?: string;
  message: string;
}

/**
 * Offers to install Nextflow via the official installer, with explicit
 * confirmation (human-in-the-loop). The installer needs a compatible Java and
 * network access; on any failure this returns installed=false with guidance
 * rather than throwing.
 */
export async function bootstrapNextflow(io: AgentIO): Promise<BootstrapResult> {
  const binDir = join(homedir(), ".local", "bin");
  io.info(
    "Nextflow isn't installed. I can install it with the official installer " +
      `(curl -s https://get.nextflow.io | bash) and place it in ${binDir}. ` +
      "This requires Java 17+ and network access.",
  );
  const ok = await io.confirm("Install Nextflow now?", false);
  if (!ok) {
    return {
      installed: false,
      message:
        "Skipped install. You can set it up manually: " +
        "`curl -s https://get.nextflow.io | bash` then move `nextflow` onto your PATH.",
    };
  }

  // Verify Java is present first — the installer fails cryptically without it.
  let java = await probe("java", ["-version"]);
  if (!java.ok) {
    const jdk = await bootstrapJava(io);
    io.info(jdk.message);
    if (jdk.installed) java = await probe("java", ["-version"]);
  }
  if (!java.ok) {
    return {
      installed: false,
      message:
        "Java is still not available. Nextflow needs Java 17+ (e.g. Temurin/OpenJDK). " +
        "Install Java, then re-run.",
    };
  }

  const done = await io.withSpinner("Installing Nextflow", async () => {
    mkdirSync(binDir, { recursive: true });
    // The installer drops a `nextflow` launcher into cwd; run it in binDir.
    const code = await new Promise<number>((res) => {
      const child = spawn("bash", ["-c", "curl -fsSL https://get.nextflow.io | bash"], {
        cwd: binDir,
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.on("error", () => res(1));
      child.on("close", (c) => res(c ?? 1));
    });
    if (code !== 0) return false;
    const bin = join(binDir, "nextflow");
    if (!existsSync(bin)) {
      // Some versions write to ./nextflow relative to the shell cwd.
      const fallback = join(process.cwd(), "nextflow");
      if (existsSync(fallback)) renameSync(fallback, bin);
    }
    if (!existsSync(bin)) return false;
    chmodSync(bin, 0o755);
    return true;
  });

  if (!done) {
    return {
      installed: false,
      message:
        "The Nextflow installer did not complete. Try manually: " +
        "`curl -s https://get.nextflow.io | bash`.",
    };
  }

  const onPath = (process.env.PATH ?? "").split(":").includes(binDir);
  const pathNote = onPath
    ? ""
    : ` Note: ${binDir} is not on your PATH — add it (e.g. \`export PATH="${binDir}:$PATH"\`) so \`nextflow\` is found.`;
  return {
    installed: true,
    binDir,
    message: `Nextflow installed into ${binDir}.${pathNote}`,
  };
}

// --- Backend & Java bootstrapping (Phase 3) ---

/** The Miniforge installer asset for a platform/arch, or null if unsupported. */
export function miniforgeInstallerUrl(platform: string, arch: string): string | null {
  const os = platform === "darwin" ? "MacOSX" : platform === "linux" ? "Linux" : null;
  if (!os) return null; // Windows uses an .exe installer — not handled here.
  const machine = arch === "arm64" ? (os === "MacOSX" ? "arm64" : "aarch64") : arch === "x64" ? "x86_64" : null;
  if (!machine) return null;
  return `https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-${os}-${machine}.sh`;
}

/** conda's executable directories under an install prefix. */
export function condaBinDirs(prefix: string): string[] {
  return [join(prefix, "bin"), join(prefix, "condabin")];
}

/** Prepends dirs to a PATH string, de-duplicating (dirs win, first-listed first). */
export function prependPath(current: string, dirs: string[]): string {
  const existing = current ? current.split(":") : [];
  const seen = new Set<string>();
  const ordered = [...dirs, ...existing].filter((d) => d && !seen.has(d) && seen.add(d) !== undefined);
  return ordered.join(":");
}

/** Makes newly installed tool dirs visible to this process and its children. */
function activatePath(dirs: string[]): void {
  process.env.PATH = prependPath(process.env.PATH ?? "", dirs);
}

/**
 * Offers to install Conda/Mamba via the official Miniforge installer (confirmed).
 * On success the new bin dirs are added to this process's PATH so the run can use
 * them. Never throws; returns guidance on failure.
 */
export async function bootstrapConda(io: AgentIO): Promise<BootstrapResult> {
  const url = miniforgeInstallerUrl(process.platform, process.arch);
  if (!url) {
    return {
      installed: false,
      message:
        `Automatic Conda install isn't supported on ${process.platform}/${process.arch}. ` +
        "Install Miniforge manually: https://github.com/conda-forge/miniforge",
    };
  }
  const prefix = join(homedir(), "miniforge3");
  io.info(
    `Conda/Mamba isn't installed. I can install Miniforge into ${prefix} ` +
      "(downloads the official installer and runs it unattended). This needs network access.",
  );
  const ok = await io.confirm("Install Miniforge (conda + mamba) now?", false);
  if (!ok) {
    return {
      installed: false,
      message: "Skipped. Install Miniforge yourself: https://github.com/conda-forge/miniforge",
    };
  }

  const done = await io.withSpinner("Installing Miniforge", async () => {
    const script = join(homedir(), ".bioagent-miniforge.sh");
    const cmd = `curl -fsSL "${url}" -o "${script}" && bash "${script}" -b -p "${prefix}" && rm -f "${script}"`;
    const code = await new Promise<number>((res) => {
      const child = spawn("bash", ["-c", cmd], { stdio: ["ignore", "ignore", "pipe"] });
      child.on("error", () => res(1));
      child.on("close", (c) => res(c ?? 1));
    });
    return code === 0 && existsSync(join(prefix, "bin", "conda"));
  });

  if (!done) {
    return { installed: false, message: "The Miniforge install did not complete. Try it manually." };
  }
  activatePath(condaBinDirs(prefix));
  return { installed: true, binDir: join(prefix, "bin"), message: `Miniforge installed into ${prefix}.` };
}

/**
 * Offers to install a JDK for Nextflow. Uses Conda when available (installs
 * openjdk into a dedicated prefix); otherwise returns guidance (a system JDK
 * needs a package manager we won't assume). Never throws.
 */
export async function bootstrapJava(io: AgentIO): Promise<BootstrapResult> {
  const conda = await probe("conda", ["--version"]);
  if (!conda.ok) {
    return {
      installed: false,
      message:
        "Java (17+) is required and I can't install it automatically without Conda or a package " +
        "manager. Install a JDK (e.g. Temurin: https://adoptium.net) or Conda, then re-run.",
    };
  }
  const prefix = join(homedir(), ".bioagent", "jdk");
  io.info(`Java isn't installed. I can install OpenJDK via Conda into ${prefix}.`);
  const ok = await io.confirm("Install OpenJDK (via Conda) now?", false);
  if (!ok) {
    return { installed: false, message: "Skipped Java install." };
  }
  const done = await io.withSpinner("Installing OpenJDK", async () => {
    const cmd = `conda create -y -p "${prefix}" -c conda-forge 'openjdk>=17'`;
    const code = await new Promise<number>((res) => {
      const child = spawn("bash", ["-c", cmd], { stdio: ["ignore", "ignore", "pipe"] });
      child.on("error", () => res(1));
      child.on("close", (c) => res(c ?? 1));
    });
    return code === 0 && existsSync(join(prefix, "bin", "java"));
  });
  if (!done) {
    return { installed: false, message: "The OpenJDK install did not complete." };
  }
  activatePath([join(prefix, "bin")]);
  return { installed: true, binDir: join(prefix, "bin"), message: `OpenJDK installed into ${prefix}.` };
}
