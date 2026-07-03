import { describe, expect, it } from "vitest";
import {
  extractIntent,
  hasEnoughContext,
  isDuplicateQuestion,
} from "../src/conversation/intentExtraction.js";
import type { ChatOptions, ChatResponse, LLMProvider, ToolCall } from "../src/llm/provider.js";

class MockProvider implements LLMProvider {
  readonly label = "mock";
  constructor(private readonly resp: ChatResponse) {}
  async healthCheck(): Promise<void> {}
  async chat(_o: ChatOptions): Promise<ChatResponse> {
    return this.resp;
  }
}
const call = (args: Record<string, unknown>): ToolCall => ({ id: "1", name: "record_intent", arguments: args });

describe("hasEnoughContext", () => {
  it("is true only when organism, dataType and objective are all set", () => {
    expect(hasEnoughContext({ organism: "human", dataType: "protein", objective: "graph" })).toBe(true);
    expect(hasEnoughContext({ organism: "human", dataType: "protein" })).toBe(false);
    expect(hasEnoughContext({ organism: "human", dataType: "  ", objective: "x" })).toBe(false);
    expect(hasEnoughContext({})).toBe(false);
  });
});

describe("isDuplicateQuestion", () => {
  it("flags a near-duplicate clarifying question", () => {
    const asked = ["Do you have multiple protein sequences to compare or just one?"];
    expect(
      isDuplicateQuestion("Do you have multiple protein sequences to group, or just one?", asked),
    ).toBe(true);
  });

  it("does not flag a genuinely different question", () => {
    const asked = ["What organism is this from?"];
    expect(isDuplicateQuestion("What is the sequencing data type?", asked)).toBe(false);
  });

  it("is false against an empty history or an empty candidate", () => {
    expect(isDuplicateQuestion("anything at all here?", [])).toBe(false);
    expect(isDuplicateQuestion("", ["a real question about the organism?"])).toBe(false);
  });
});

describe("extractIntent — tolerant of a stringified boolean", () => {
  it("coerces enough:'false' (as some models emit) to a real boolean", async () => {
    const provider = new MockProvider({
      text: "",
      toolCalls: [
        call({
          organism: "E. coli",
          dataType: "protein",
          objective: "cluster into families",
          experimentalDesign: null,
          enough: "false", // string, not boolean
          nextQuestion: "How many sequences do you have?",
        }),
      ],
    });
    const intent = await extractIntent(provider, [], [{ role: "user", text: "hi" }]);
    expect(intent.enough).toBe(false);
    expect(intent.organism).toBe("E. coli");
    expect(intent.nextQuestion).toBe("How many sequences do you have?");
  });

  it("accepts a real boolean true and drops nextQuestion", async () => {
    const provider = new MockProvider({
      text: "",
      toolCalls: [
        call({
          organism: "human",
          dataType: "RNA short-read",
          objective: "DEGs",
          experimentalDesign: "treated vs control",
          enough: true,
          nextQuestion: null,
        }),
      ],
    });
    const intent = await extractIntent(provider, [], [{ role: "user", text: "hi" }]);
    expect(intent.enough).toBe(true);
    expect(intent.nextQuestion).toBeNull();
  });
});
