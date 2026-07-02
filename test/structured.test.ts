import { describe, expect, it } from "vitest";
import { z } from "zod";
import { callStructured } from "../src/llm/structured.js";
import type { ChatOptions, ChatResponse, LLMProvider, ToolCall } from "../src/llm/provider.js";

/** A provider that replays a scripted list of responses and counts calls. */
class MockProvider implements LLMProvider {
  readonly label = "mock";
  calls = 0;
  constructor(private readonly scripted: ChatResponse[]) {}
  async healthCheck(): Promise<void> {}
  async chat(_options: ChatOptions): Promise<ChatResponse> {
    const resp = this.scripted[this.calls] ?? { text: "", toolCalls: [] };
    this.calls++;
    return resp;
  }
}

const tool = { name: "t", description: "", parameters: {} };
const schema = z.object({ x: z.number() });
const toolCall = (args: Record<string, unknown>): ToolCall => ({ id: "1", name: "t", arguments: args });
const opts = (p: MockProvider) => ({ messages: [], tool, schema });

describe("callStructured", () => {
  it("returns parsed data on a valid first response", async () => {
    const p = new MockProvider([{ text: "", toolCalls: [toolCall({ x: 5 })] }]);
    const data = await callStructured(p, opts(p));
    expect(data).toEqual({ x: 5 });
    expect(p.calls).toBe(1);
  });

  it("retries once when the first response has no tool call, then succeeds", async () => {
    const p = new MockProvider([
      { text: "no call", toolCalls: [] },
      { text: "", toolCalls: [toolCall({ x: 7 })] },
    ]);
    const data = await callStructured(p, opts(p));
    expect(data).toEqual({ x: 7 });
    expect(p.calls).toBe(2);
  });

  it("retries when arguments are invalid, then succeeds", async () => {
    const p = new MockProvider([
      { text: "", toolCalls: [toolCall({ x: "not a number" })] },
      { text: "", toolCalls: [toolCall({ x: 9 })] },
    ]);
    const data = await callStructured(p, opts(p));
    expect(data).toEqual({ x: 9 });
  });

  it("returns null after exhausting attempts", async () => {
    const p = new MockProvider([
      { text: "", toolCalls: [toolCall({ x: "bad" })] },
      { text: "", toolCalls: [toolCall({ x: "still bad" })] },
    ]);
    const data = await callStructured(p, opts(p));
    expect(data).toBeNull();
    expect(p.calls).toBe(2);
  });
});
