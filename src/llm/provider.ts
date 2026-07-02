/**
 * LLM provider abstraction.
 *
 * The rest of the code depends ONLY on this interface, never on a concrete SDK.
 * To add a third provider (e.g. OpenAI) in the future:
 *   1. Create src/llm/<provider>.ts implementing LLMProvider.
 *   2. Add its branch in createProvider() (src/llm/index.ts).
 *   3. Add its section to the config.
 * No other part of the code should change.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  /** Only for role="tool" messages: id of the tool_call being answered. */
  toolCallId?: string;
}

/** Definition of a tool exposed to the model (JSON Schema in `parameters`). */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the argument object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /**
   * Forces the model to call a specific tool (by name).
   * Used for single-pass structured extraction.
   */
  forceTool?: string;
  /** Text streaming callback. Only invoked when no tools are used. */
  onToken?: (chunk: string) => void;
}

export interface LLMProvider {
  /** Provider identifier, e.g. "ollama (llama3.1:8b)". */
  readonly label: string;
  /** Sends a conversation and returns text and/or tool calls. */
  chat(options: ChatOptions): Promise<ChatResponse>;
  /**
   * Verifies the backend is available and usable.
   * Must throw ProviderError with an actionable message if something is missing.
   */
  healthCheck(): Promise<void>;
}

/** Provider error with a message intended to be shown to the user as-is. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
