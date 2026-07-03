/**
 * OpenAI-compatible provider adapter (via plain HTTP — no SDK dependency).
 *
 * A single adapter for any service that speaks the OpenAI Chat Completions API:
 * free tiers like **Groq**, **Google Gemini** (its OpenAI-compat endpoint),
 * **Cerebras** and **OpenRouter**, OpenAI itself, or a local vLLM/LM Studio
 * server. Point `baseUrl` at the service and name the API-key env var; a keyless
 * local endpoint works without one.
 */
import type { OpenAICompatConfig } from "../config/types.js";
import {
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type LLMProvider,
  type ToolCall,
  ProviderError,
} from "./provider.js";

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface OpenAIMessage {
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
}
interface OpenAIResponse {
  choices?: Array<{ message?: OpenAIMessage }>;
  error?: { message?: string };
}
interface OpenAIStreamChunk {
  choices?: Array<{ delta?: { content?: string } }>;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly label: string;
  private readonly cfg: OpenAICompatConfig;
  private readonly apiKey: string | null;

  constructor(cfg: OpenAICompatConfig, apiKey: string | null) {
    this.cfg = cfg;
    this.apiKey = apiKey;
    this.label = `openai-compatible (${cfg.model})`;
  }

  async healthCheck(): Promise<void> {
    let res: Response;
    try {
      res = await this.post({
        model: this.cfg.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      });
    } catch (err) {
      throw new ProviderError(
        `Could not reach the LLM endpoint at ${this.cfg.baseUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok) {
      throw new ProviderError(this.describeStatus(res.status, await res.text().catch(() => "")));
    }
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const useTools = Boolean(options.tools && options.tools.length > 0);
    const stream = !useTools && Boolean(options.onToken);

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: options.messages.map(toOpenAIMessage),
      temperature: this.cfg.temperature,
      max_tokens: this.cfg.maxTokens,
      stream,
    };
    if (useTools) {
      body.tools = options.tools!.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      // Force a specific tool for single-pass structured extraction.
      body.tool_choice = options.forceTool
        ? { type: "function", function: { name: options.forceTool } }
        : "auto";
    }

    let res: Response;
    try {
      res = await this.post(body);
    } catch (err) {
      throw new ProviderError(
        `Could not reach the LLM endpoint at ${this.cfg.baseUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // Some servers (e.g. Groq) validate the model's tool call against the tool
      // schema and 400 when the model emits a wrong type. Treat that as "no valid
      // tool call this attempt" so callStructured can retry and then fall back,
      // instead of aborting the whole session on a weak model's slip.
      if (useTools && res.status === 400 && isToolValidationError(detail)) {
        return { text: "", toolCalls: [] };
      }
      throw new ProviderError(this.describeStatus(res.status, detail));
    }

    return stream ? this.readStream(res, options.onToken!) : this.readSingle(res);
  }

  private async readSingle(res: Response): Promise<ChatResponse> {
    const data = (await res.json()) as OpenAIResponse;
    if (data.error) throw new ProviderError(`LLM endpoint error: ${data.error.message ?? "unknown"}`);
    const msg = data.choices?.[0]?.message;
    return { text: msg?.content ?? "", toolCalls: parseToolCalls(msg?.tool_calls) };
  }

  private async readStream(res: Response, onToken: (chunk: string) => void): Promise<ChatResponse> {
    if (!res.body) throw new ProviderError("The LLM endpoint returned no response body.");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let chunk: OpenAIStreamChunk;
        try {
          chunk = JSON.parse(payload) as OpenAIStreamChunk;
        } catch {
          continue;
        }
        const piece = chunk.choices?.[0]?.delta?.content ?? "";
        if (piece) {
          text += piece;
          onToken(piece);
        }
      }
    }
    return { text, toolCalls: [] };
  }

  private post(body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    return fetch(`${this.baseUrl()}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  private baseUrl(): string {
    return this.cfg.baseUrl.replace(/\/+$/, "");
  }

  private describeStatus(status: number, detail: string): string {
    const where = `${this.cfg.baseUrl} (model "${this.cfg.model}")`;
    if (status === 401 || status === 403) {
      return `The LLM endpoint rejected the API key (${status}) at ${where}. Check the key env var.`;
    }
    if (status === 429) {
      return `The LLM endpoint returned 429 (rate limit / quota) at ${where}. Wait a moment or check your plan.`;
    }
    if (status === 404) {
      return `The LLM endpoint doesn't recognize the model or path (404) at ${where}. Check baseUrl and model.`;
    }
    return `The LLM endpoint returned status ${status} at ${where}${detail ? `: ${detail.slice(0, 300)}` : ""}.`;
  }
}

/** A server-side rejection of the model's tool call (wrong type / bad schema). */
function isToolValidationError(detail: string): boolean {
  return /tool_use_failed|tool call validation|did not match schema/i.test(detail);
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" };
  }
  return { role: m.role, content: m.content };
}

let toolCallCounter = 0;
function parseToolCalls(calls: OpenAIToolCall[] | undefined): ToolCall[] {
  if (!calls || calls.length === 0) return [];
  const out: ToolCall[] = [];
  for (const c of calls) {
    const name = c.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const raw = c.function?.arguments;
    if (typeof raw === "string" && raw.trim() !== "") {
      try {
        args = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        args = {};
      }
    }
    out.push({ id: c.id ?? `openai-tool-${++toolCallCounter}`, name, arguments: args });
  }
  return out;
}
