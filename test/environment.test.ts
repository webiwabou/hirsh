import { describe, expect, it } from "vitest";
import {
  availableEngines,
  backendProfile,
  BACKENDS,
  chooseBackend,
  PREFERENCE,
  recommendEngine,
  type BackendStatus,
} from "../src/execution/environment.js";
import type { ContainerEngine } from "../src/config/types.js";
import type { AgentIO } from "../src/conversation/io.js";

/** An AgentIO that replays scripted answers and swallows output. */
class ScriptedIO implements AgentIO {
  constructor(private readonly answers: string[]) {}
  private i = 0;
  say(): void {}
  info(): void {}
  warn(): void {}
  heading(): void {}
  raw(): void {}
  endStream(): void {}
  async ask(): Promise<string> {
    return this.answers[this.i++] ?? "";
  }
  async confirm(): Promise<boolean> {
    return false;
  }
  async confirmOrText(): Promise<{ decision: boolean } | { text: string }> {
    return { decision: false };
  }
  async withSpinner<T>(_label: string, task: () => Promise<T>): Promise<T> {
    return task();
  }
}

const status = (avail: Partial<Record<ContainerEngine, boolean>>): BackendStatus[] =>
  (Object.keys(BACKENDS) as ContainerEngine[]).map((engine) => ({
    engine,
    available: avail[engine] ?? false,
  }));

describe("backendProfile", () => {
  it("maps each engine to its nf-core profile name", () => {
    expect(backendProfile("docker")).toBe("docker");
    expect(backendProfile("singularity")).toBe("singularity");
    expect(backendProfile("conda")).toBe("conda");
    expect(backendProfile("mamba")).toBe("mamba");
  });
});

describe("availableEngines", () => {
  it("returns available engines in preference order", () => {
    const got = availableEngines(status({ conda: true, docker: true, mamba: true }));
    // PREFERENCE is docker, singularity, mamba, conda
    expect(got).toEqual(["docker", "mamba", "conda"]);
  });

  it("returns an empty list when none are available", () => {
    expect(availableEngines(status({}))).toEqual([]);
  });

  it("PREFERENCE puts containers before conda environments", () => {
    expect(PREFERENCE.indexOf("docker")).toBeLessThan(PREFERENCE.indexOf("conda"));
    expect(PREFERENCE.indexOf("singularity")).toBeLessThan(PREFERENCE.indexOf("mamba"));
    expect(PREFERENCE.indexOf("mamba")).toBeLessThan(PREFERENCE.indexOf("conda"));
  });
});

describe("recommendEngine", () => {
  it("keeps the configured engine when it is available", () => {
    expect(recommendEngine(status({ docker: true, conda: true }), "conda")).toBe("conda");
  });

  it("falls back to the most reproducible available engine otherwise", () => {
    // configured docker is unavailable; singularity beats conda by preference
    expect(recommendEngine(status({ singularity: true, conda: true }), "docker")).toBe(
      "singularity",
    );
  });

  it("prefers mamba over conda when only environments are present", () => {
    expect(recommendEngine(status({ conda: true, mamba: true }), "docker")).toBe("mamba");
  });

  it("returns null when nothing is available", () => {
    expect(recommendEngine(status({}), "docker")).toBeNull();
  });
});

describe("chooseBackend", () => {
  it("returns the sole available engine without asking", async () => {
    const io = new ScriptedIO([]);
    const got = await chooseBackend(io, status({ conda: true }), "docker");
    expect(got).toBe("conda");
  });

  it("returns null when nothing is available", async () => {
    const io = new ScriptedIO([]);
    expect(await chooseBackend(io, status({}), "docker")).toBeNull();
  });

  it("uses the recommended engine on an empty answer", async () => {
    const io = new ScriptedIO([""]);
    // docker + conda available, configured docker → recommend docker
    expect(await chooseBackend(io, status({ docker: true, conda: true }), "docker")).toBe(
      "docker",
    );
  });

  it("honors a numeric selection from the menu", async () => {
    // available (preference order): docker(1), conda(2)
    const io = new ScriptedIO(["2"]);
    expect(await chooseBackend(io, status({ docker: true, conda: true }), "docker")).toBe(
      "conda",
    );
  });

  it("accepts an engine typed by name", async () => {
    const io = new ScriptedIO(["conda"]);
    expect(await chooseBackend(io, status({ docker: true, conda: true }), "docker")).toBe(
      "conda",
    );
  });

  it("falls back to the recommendation on an unrecognized answer", async () => {
    const io = new ScriptedIO(["nonsense"]);
    expect(await chooseBackend(io, status({ docker: true, conda: true }), "docker")).toBe(
      "docker",
    );
  });
});
