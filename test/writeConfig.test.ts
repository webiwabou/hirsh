import { describe, expect, it } from "vitest";
import { updateExecutionConfig } from "../src/config/writeConfig.js";

describe("updateExecutionConfig", () => {
  const yaml = [
    "# Hirsh config",
    "provider: ollama",
    "execution:",
    "  containerEngine: docker  # default backend",
    "  workdir: ./runs",
    "",
  ].join("\n");

  it("updates the touched keys and preserves comments and other values", () => {
    const out = updateExecutionConfig(yaml, { containerEngine: "conda", executor: "slurm", queue: "short" });
    expect(out).toContain("# Hirsh config"); // top comment preserved
    expect(out).toContain("provider: ollama"); // untouched
    expect(out).toContain("containerEngine: conda");
    expect(out).toContain("executor: slurm");
    expect(out).toContain("queue: short");
    expect(out).toContain("workdir: ./runs"); // untouched
  });

  it("deletes the queue when set to empty (e.g. switching to local)", () => {
    const withQueue = "execution:\n  executor: slurm\n  queue: short\n";
    const out = updateExecutionConfig(withQueue, { executor: "local", queue: "" });
    expect(out).toContain("executor: local");
    expect(out).not.toContain("queue:");
  });

  it("creates the execution block from an empty file", () => {
    const out = updateExecutionConfig("", { containerEngine: "mamba", executor: "local" });
    expect(out).toContain("execution:");
    expect(out).toContain("containerEngine: mamba");
    expect(out).toContain("executor: local");
  });
});
