/** Ollama (local server) provider adapter via its HTTP /api/chat API. */
import type { OllamaConfig } from "../config/types.js";
import {
  type ChatMessage,
  type ChatOptions,
  type ChatResponse,
  type LLMProvider,
  type ToolCall,
  ProviderError,
} from "./provider.js";

interface OllamaToolCall {
  function?: { name?: string; arguments?: Record<string, unknown> | string };
}

interface OllamaChatChunk {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  error?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly label: string;
  private readonly cfg: OllamaConfig;

  constructor(cfg: OllamaConfig) {
    this.cfg = cfg;
    this.label = `ollama (${cfg.model})`;
  }

  async healthCheck(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}/api/tags`);
    } catch (err) {
      throw new ProviderError(
        `Could not connect to Ollama at ${this.cfg.host}. ` +
          `Is the server running? Try \`ollama serve\`. (${
            err instanceof Error ? err.message : String(err)
          })`,
      );
    }
    if (!res.ok) {
      throw new ProviderError(
        `Ollama responded with status ${res.status} at ${this.cfg.host}/api/tags.`,
      );
    }
    // Check that the configured model is downloaded.
    try {
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      const names = (data.models ?? []).map((m) => m.name ?? "");
      const wanted = this.cfg.model;
      const present = names.some((n) => n === wanted || n.split(":")[0] === wanted.split(":")[0]);
      if (!present) {
        throw new ProviderError(
          `The model "${wanted}" is not downloaded in Ollama. ` +
            `Pull it with \`ollama pull ${wanted}\`. Available models: ${
              names.length ? names.join(", ") : "(none)"
            }.`,
        );
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      // If /api/tags responded but we couldn't parse it, don't block startup.
    }
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const useTools = Boolean(options.tools && options.tools.length > 0);
    // With tools we disable streaming: Ollama only returns tool_calls at the end.
    const stream = !useTools && Boolean(options.onToken);

    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: options.messages.map(toOllamaMessage),
      stream,
      options: { temperature: this.cfg.temperature },
    };
    if (useTools) {
      body.tools = options.tools!.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderError(
        `Could not reach Ollama at ${this.cfg.host}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ProviderError(
        `Ollama returned status ${res.status}${detail ? `: ${detail}` : ""}.`,
      );
    }

    return stream ? this.readStream(res, options.onToken!) : this.readSingle(res);
  }

  private async readSingle(res: Response): Promise<ChatResponse> {
    const chunk = (await res.json()) as OllamaChatChunk;
    if (chunk.error) throw new ProviderError(`Ollama: ${chunk.error}`);
    return {
      text: chunk.message?.content ?? "",
      toolCalls: parseToolCalls(chunk.message?.tool_calls),
    };
  }

  private async readStream(
    res: Response,
    onToken: (chunk: string) => void,
  ): Promise<ChatResponse> {
    if (!res.body) throw new ProviderError("Ollama returned no response body.");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const toolCalls: ToolCall[] = [];

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as OllamaChatChunk;
        if (chunk.error) throw new ProviderError(`Ollama: ${chunk.error}`);
        const piece = chunk.message?.content ?? "";
        if (piece) {
          text += piece;
          onToken(piece);
        }
        toolCalls.push(...parseToolCalls(chunk.message?.tool_calls));
      }
    }
    return { text, toolCalls };
  }

  private baseUrl(): string {
    return this.cfg.host.replace(/\/+$/, "");
  }
}

function toOllamaMessage(m: ChatMessage): Record<string, unknown> {
  // Ollama uses role "tool" with the result content; the rest map directly.
  return { role: m.role, content: m.content };
}

let toolCallCounter = 0;
function parseToolCalls(calls: OllamaToolCall[] | undefined): ToolCall[] {
  if (!calls || calls.length === 0) return [];
  const out: ToolCall[] = [];
  for (const c of calls) {
    const name = c.function?.name;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    const rawArgs = c.function?.arguments;
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        args = {};
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs;
    }
    out.push({ id: `ollama-tool-${++toolCallCounter}`, name, arguments: args });
  }
  return out;
}
