import { describe, expect, it } from "vitest";
import { proposeLocalTools, toLocalToolSpec } from "../src/composition/localToolProposal.js";
import type { ChatOptions, ChatResponse, LLMProvider, ToolCall } from "../src/llm/provider.js";

class MockProvider implements LLMProvider {
  readonly label = "mock";
  calls = 0;
  constructor(private readonly scripted: ChatResponse[]) {}
  async healthCheck(): Promise<void> {}
  async chat(_o: ChatOptions): Promise<ChatResponse> {
    return this.scripted[this.calls++] ?? { text: "", toolCalls: [] };
  }
}
const call = (args: Record<string, unknown>): ToolCall => ({ id: "1", name: "propose_local_tools", arguments: args });

describe("toLocalToolSpec", () => {
  it("maps a proposal to a spec with a default output pattern", () => {
    const spec = toLocalToolSpec({
      name: "PeakFilter",
      description: "Filters peaks",
      command: "peakfilter $prefix",
      inputKind: "bed",
      outputKind: "bed",
      outputPattern: "",
      conda: "bioconda::bedtools=2.31",
      container: "",
      versionCommand: "bedtools --version",
    })!;
    expect(spec.name).toBe("peakfilter"); // sanitized lowercase
    expect(spec.inputs[0].name).toBe("bed");
    expect(spec.outputs[0].pattern).toBe("*.bed"); // defaulted from outputKind
    expect(spec.conda).toBe("bioconda::bedtools=2.31");
    expect(spec.hasMeta).toBe(true);
  });

  it("returns null when name or command is empty", () => {
    expect(toLocalToolSpec({ name: "", description: "", command: "x", inputKind: "a", outputKind: "b", outputPattern: "", conda: "", container: "", versionCommand: "" })).toBeNull();
    expect(toLocalToolSpec({ name: "x", description: "", command: "  ", inputKind: "a", outputKind: "b", outputPattern: "", conda: "", container: "", versionCommand: "" })).toBeNull();
  });
});

describe("proposeLocalTools", () => {
  const query = { objective: "call and filter peaks", organism: "human", dataType: "ChIP-seq" };

  it("returns proposed specs from the tool call, dropping unusable ones", async () => {
    const provider = new MockProvider([
      {
        text: "",
        toolCalls: [
          call({
            tools: [
              { name: "peakfilter", description: "Filters peaks", command: "peakfilter $prefix", inputKind: "bed", outputKind: "bed", outputPattern: "*.filt.bed" },
              { name: "", description: "bad", command: "x", inputKind: "a", outputKind: "b" }, // dropped
            ],
          }),
        ],
      },
    ]);
    const specs = await proposeLocalTools(provider, query, ["macs2", "bwa/mem"]);
    expect(specs).toHaveLength(1);
    expect(specs[0].name).toBe("peakfilter");
    expect(specs[0].outputs[0].pattern).toBe("*.filt.bed");
  });

  it("returns [] when the modules already suffice (empty tools)", async () => {
    const provider = new MockProvider([{ text: "", toolCalls: [call({ tools: [] })] }]);
    expect(await proposeLocalTools(provider, query, ["macs2"])).toEqual([]);
  });

  it("returns [] when the model never calls the tool", async () => {
    const provider = new MockProvider([
      { text: "no", toolCalls: [] },
      { text: "still no", toolCalls: [] },
    ]);
    expect(await proposeLocalTools(provider, query, ["macs2"])).toEqual([]);
  });
});
