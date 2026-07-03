import { describe, expect, it } from "vitest";
import { collectLocalTool } from "../src/composition/localModule.js";
import type { AgentIO } from "../src/conversation/io.js";

/** Feeds ask() answers in order; say/info render the option menus (ignored). */
class ScriptedIO implements AgentIO {
  private i = 0;
  constructor(private readonly answers: string[]) {}
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
  async withSpinner<T>(_l: string, t: () => Promise<T>): Promise<T> {
    return t();
  }
}

describe("collectLocalTool — recommended-options flow", () => {
  it("builds a clean spec from numeric picks and safe defaults", async () => {
    // asks: name, description, env-pick(1=later), input-pick(1=fasta), command(blank),
    //       output-pick(1=graph), naming(blank→default), version(blank)
    const io = new ScriptedIO(["graphtool", "makes a graph", "1", "1", "", "1", "", ""]);
    const spec = (await collectLocalTool(io))!;

    expect(spec.name).toBe("graphtool");
    expect(spec.description).toBe("makes a graph");
    expect(spec.container).toBeUndefined();
    expect(spec.conda).toBeUndefined(); // "set it later"
    expect(spec.inputs[0].name).toBe("fasta");
    expect(spec.outputs[0].name).toBe("graph");
    expect(spec.outputs[0].pattern).toBe("*.graph"); // clean default, not "*.i don't know"
    expect(spec.versionCommand).toBeUndefined();
    expect(spec.command).toContain("prefix"); // placeholder command
  });

  it("captures a conda package the scientist selects", async () => {
    // env-pick = 2 (conda) → then asks the conda package
    const io = new ScriptedIO([
      "clust",
      "clusters",
      "2",
      "bioconda::mmseqs2=15",
      "1", // input fasta
      "mmseqs $prefix",
      "tsv", // output kind typed
      "",
      "",
    ]);
    const spec = (await collectLocalTool(io))!;
    expect(spec.conda).toBe("bioconda::mmseqs2=15");
    expect(spec.container).toBeUndefined();
    expect(spec.outputs[0].pattern).toBe("*.tsv");
  });

  it("returns null when no name is given", async () => {
    expect(await collectLocalTool(new ScriptedIO([""]))).toBeNull();
  });
});
