/** LLM provider factory: maps config to the concrete adapter. */
import { resolveAnthropicApiKey, resolveOpenAIApiKey } from "../config/loadConfig.js";
import type { HirshConfig } from "../config/types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAICompatProvider } from "./openaiCompat.js";
import { type LLMProvider, ProviderError } from "./provider.js";

export * from "./provider.js";
export { callStructured, nullableText, looseBoolean } from "./structured.js";

/**
 * Builds the active LLM provider from config.
 * Throws ProviderError with an actionable message if something is missing (e.g. API key).
 */
export function createProvider(config: HirshConfig): LLMProvider {
  switch (config.provider) {
    case "ollama":
      return new OllamaProvider(config.ollama);
    case "anthropic": {
      const apiKey = resolveAnthropicApiKey(config);
      if (!apiKey) {
        throw new ProviderError(
          `The "anthropic" provider needs an API key. ` +
            `Set the ${config.anthropic.apiKeyEnv} environment variable ` +
            `(export ${config.anthropic.apiKeyEnv}=sk-ant-...).`,
        );
      }
      return new AnthropicProvider(config.anthropic, apiKey);
    }
    case "openai": {
      // Key is optional: keyless local endpoints (vLLM/LM Studio) work too.
      return new OpenAICompatProvider(config.openai, resolveOpenAIApiKey(config));
    }
    default: {
      // Exhaustiveness: if a provider is added to ProviderName without handling
      // it here, TypeScript flags this point.
      const _exhaustive: never = config.provider;
      throw new ProviderError(`Unsupported provider: ${String(_exhaustive)}`);
    }
  }
}
