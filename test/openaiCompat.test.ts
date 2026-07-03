import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAICompatProvider } from "../src/llm/openaiCompat.js";
import type { OpenAICompatConfig } from "../src/config/types.js";

const cfg: OpenAICompatConfig = {
  baseUrl: "https://api.groq.com/openai/v1",
  model: "llama-3.3-70b-versatile",
  apiKeyEnv: "GROQ_API_KEY",
  temperature: 0.2,
  maxTokens: 100,
};

function mockJson(data: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  })) as unknown as typeof fetch;
}
function initOf(f: unknown, i = 0): { headers: Record<string, string>; body: string } {
  return (f as { mock: { calls: unknown[][] } }).mock.calls[i][1] as {
    headers: Record<string, string>;
    body: string;
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenAICompatProvider.chat", () => {
  it("sends tools + a forced tool_choice and parses the tool call", async () => {
    const data = {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              { id: "call_1", function: { name: "record_intent", arguments: '{"organism":"mouse"}' } },
            ],
          },
        },
      ],
    };
    const f = mockJson(data);
    vi.stubGlobal("fetch", f);

    const p = new OpenAICompatProvider(cfg, "gsk_test");
    const resp = await p.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "record_intent", description: "d", parameters: { type: "object" } }],
      forceTool: "record_intent",
    });

    expect(resp.toolCalls).toEqual([
      { id: "call_1", name: "record_intent", arguments: { organism: "mouse" } },
    ]);
    const init = initOf(f);
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(false); // never stream with tools
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "record_intent" } });
    expect(body.tools[0].function.name).toBe("record_intent");
    expect(init.headers.authorization).toBe("Bearer gsk_test");
  });

  it("parses plain content and omits the auth header when keyless", async () => {
    const f = mockJson({ choices: [{ message: { content: "hello world" } }] });
    vi.stubGlobal("fetch", f);

    const p = new OpenAICompatProvider(cfg, null);
    const resp = await p.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(resp.text).toBe("hello world");
    expect(resp.toolCalls).toEqual([]);
    expect(initOf(f).headers.authorization).toBeUndefined();
  });

  it("raises an actionable error on 401", async () => {
    const f = vi.fn(async () => ({ ok: false, status: 401, text: async () => "denied" })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", f);

    const p = new OpenAICompatProvider(cfg, "bad");
    await expect(p.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      /rejected the API key/,
    );
  });

  it("recovers from a strict tool-validation 400 (Groq) instead of aborting", async () => {
    // Groq validates the model's tool call server-side and 400s on a wrong type.
    const body = JSON.stringify({
      error: {
        message: "tool call validation failed: parameters for tool record_intent did not match schema",
        code: "tool_use_failed",
      },
    });
    const f = vi.fn(async () => ({ ok: false, status: 400, text: async () => body })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", f);

    const p = new OpenAICompatProvider(cfg, "gsk_test");
    const resp = await p.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "record_intent", description: "d", parameters: { type: "object" } }],
      forceTool: "record_intent",
    });
    // No throw: surfaced as "no tool call" so callStructured can retry / fall back.
    expect(resp).toEqual({ text: "", toolCalls: [] });
  });

  it("still throws on an unrelated 400", async () => {
    const f = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "context length exceeded" } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", f);

    const p = new OpenAICompatProvider(cfg, "gsk_test");
    await expect(
      p.chat({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
        forceTool: "t",
      }),
    ).rejects.toThrow(/status 400/);
  });
});
