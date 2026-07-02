/** Anthropic (Claude) provider adapter on top of @anthropic-ai/sdk. */
import Anthropic from "@anthropic-ai/sdk";
import type { AnthropicConfig } from "../config/types.js";
import {
  type ChatOptions,
  type ChatResponse,
  type ChatMessage,
  type LLMProvider,
  type ToolCall,
  ProviderError,
} from "./provider.js";

export class AnthropicProvider implements LLMProvider {
  readonly label: string;
  private readonly client: Anthropic;
  private readonly cfg: AnthropicConfig;

  constructor(cfg: AnthropicConfig, apiKey: string) {
    this.cfg = cfg;
    this.client = new Anthropic({ apiKey });
    this.label = `anthropic (${cfg.model})`;
  }

  async healthCheck(): Promise<void> {
    try {
      await this.client.messages.create({
        model: this.cfg.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
    } catch (err) {
      throw new ProviderError(this.describeError(err));
    }
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const { system, messages } = splitSystem(options.messages);

    const params: Anthropic.MessageCreateParams = {
      model: this.cfg.model,
      max_tokens: this.cfg.maxTokens,
      temperature: this.cfg.temperature,
      messages,
    };
    if (system) params.system = system;

    if (options.tools && options.tools.length > 0) {
      params.tools = options.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      }));
      if (options.forceTool) {
        params.tool_choice = { type: "tool", name: options.forceTool };
      }
    }

    try {
      // With tools we do not stream: we need the complete tool_use block.
      if (params.tools) {
        const resp = await this.client.messages.create(params);
        return this.parseMessage(resp);
      }

      // Without tools: stream text token by token.
      const stream = this.client.messages.stream(params);
      if (options.onToken) {
        stream.on("text", (chunk) => options.onToken?.(chunk));
      }
      const final = await stream.finalMessage();
      return this.parseMessage(final);
    } catch (err) {
      throw new ProviderError(this.describeError(err));
    }
  }

  private parseMessage(msg: Anthropic.Message): ChatResponse {
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of msg.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return { text, toolCalls };
  }

  private describeError(err: unknown): string {
    if (err instanceof Anthropic.APIError) {
      if (err.status === 401) {
        return "Anthropic rejected the API key (401). Check that the environment variable holds a valid key.";
      }
      if (err.status === 429) {
        return "Anthropic returned 429 (rate limit / quota). Wait a moment or check your plan.";
      }
      if (err.status === 404) {
        return `Anthropic does not recognize the model "${this.cfg.model}" (404). Check the model name in your config.`;
      }
      return `Anthropic API error (${err.status ?? "no status"}): ${err.message}`;
    }
    if (err instanceof Error) {
      return `Could not reach Anthropic: ${err.message}`;
    }
    return `Unknown error contacting Anthropic: ${String(err)}`;
  }
}

/** Splits system messages (Anthropic takes them separately) from the rest. */
function splitSystem(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const rest: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else if (m.role === "tool") {
      rest.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId ?? "",
            content: m.content,
          },
        ],
      });
    } else {
      rest.push({ role: m.role, content: m.content });
    }
  }

  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: rest,
  };
}
