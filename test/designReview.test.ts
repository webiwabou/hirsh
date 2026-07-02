import { describe, expect, it } from "vitest";
import {
  reviewDesign,
  sortedObservations,
  worstSeverity,
  type DesignReview,
} from "../src/conversation/designReview.js";
import type { ChatOptions, ChatResponse, LLMProvider, ToolCall } from "../src/llm/provider.js";

class MockProvider implements LLMProvider {
  readonly label = "mock";
  constructor(private readonly scripted: ChatResponse[]) {}
  calls = 0;
  async healthCheck(): Promise<void> {}
  async chat(_o: ChatOptions): Promise<ChatResponse> {
    return this.scripted[this.calls++] ?? { text: "", toolCalls: [] };
  }
}
const toolCall = (args: Record<string, unknown>): ToolCall => ({
  id: "1",
  name: "report_design_review",
  arguments: args,
});

const review = (obs: DesignReview["observations"]): DesignReview => ({ observations: obs, summary: "" });

describe("worstSeverity", () => {
  it("returns the most serious severity present", () => {
    expect(
      worstSeverity(review([{ severity: "info", topic: "t", message: "m" }, { severity: "risk", topic: "t", message: "m" }])),
    ).toBe("risk");
    expect(worstSeverity(review([{ severity: "caution", topic: "t", message: "m" }]))).toBe("caution");
    expect(worstSeverity(review([]))).toBeNull();
  });
});

describe("sortedObservations", () => {
  it("orders risk before caution before info", () => {
    const r = review([
      { severity: "info", topic: "a", message: "m" },
      { severity: "risk", topic: "b", message: "m" },
      { severity: "caution", topic: "c", message: "m" },
    ]);
    expect(sortedObservations(r).map((o) => o.severity)).toEqual(["risk", "caution", "info"]);
  });
});

describe("reviewDesign", () => {
  const query = { organism: "mouse", dataType: "RNA-seq", objective: "DEGs", experimentalDesign: "treated vs control, n=2" };

  it("parses observations and drops empty messages", async () => {
    const provider = new MockProvider([
      {
        text: "",
        toolCalls: [
          toolCall({
            summary: "Low replication.",
            observations: [
              { severity: "risk", topic: "replication", message: "n=2 is underpowered", suggestion: "use ≥3 replicates" },
              { severity: "caution", topic: "batch", message: "" }, // dropped (empty message)
            ],
          }),
        ],
      },
    ]);
    const r = await reviewDesign(provider, query);
    expect(r).not.toBeNull();
    expect(r!.observations).toHaveLength(1);
    expect(r!.observations[0].topic).toBe("replication");
    expect(r!.observations[0].suggestion).toContain("3 replicates");
    expect(r!.summary).toBe("Low replication.");
  });

  it("returns null when the model never calls the tool", async () => {
    const provider = new MockProvider([
      { text: "no call", toolCalls: [] },
      { text: "still no call", toolCalls: [] },
    ]);
    expect(await reviewDesign(provider, query)).toBeNull();
  });
});
