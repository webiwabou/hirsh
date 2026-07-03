import { describe, expect, it } from "vitest";
import { extractIntent } from "../src/conversation/intentExtraction.js";
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
