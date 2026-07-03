/** LLM provider factory: maps config to the concrete adapter. */
import {
  looksLikeApiKeySecret,
  resolveAnthropicApiKey,
  resolveOpenAIApiKey,
} from "../config/loadConfig.js";
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
        throw new ProviderError(pastedKeyHint("anthropic", config.anthropic.apiKeyEnv, "sk-ant-..."));
      }
      return new AnthropicProvider(config.anthropic, apiKey);
    }
    case "openai": {
      const apiKey = resolveOpenAIApiKey(config);
      // A key is optional (keyless local endpoints work), but if it's missing AND
      // the configured value looks like a pasted secret, that's the classic
      // mistake — fail with a clear fix instead of a confusing 401 later.
      if (!apiKey && looksLikeApiKeySecret(config.openai.apiKeyEnv)) {
        throw new ProviderError(pastedKeyHint("openai", config.openai.apiKeyEnv, "gsk_..."));
      }
      return new OpenAICompatProvider(config.openai, apiKey);
    }
    default: {
      // Exhaustiveness: if a provider is added to ProviderName without handling
      // it here, TypeScript flags this point.
      const _exhaustive: never = config.provider;
      throw new ProviderError(`Unsupported provider: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Message for a missing API key, tailored to the very common mistake of pasting
 * the key itself into `apiKeyEnv` (which must be the NAME of an env var).
 */
function pastedKeyHint(provider: string, apiKeyEnv: string, sample: string): string {
  if (looksLikeApiKeySecret(apiKeyEnv)) {
    return (
      `The "${provider}" provider's apiKeyEnv must be the NAME of an environment variable ` +
      `(e.g. GROQ_API_KEY or ANTHROPIC_API_KEY), not the key itself — it looks like you pasted ` +
      `the key there. Fix your config to \`apiKeyEnv: <VAR_NAME>\` and export the key: ` +
      `\`export <VAR_NAME>=${sample}\`. (Keys are never stored in the config file.)`
    );
  }
  return (
    `The "${provider}" provider needs an API key. Set the ${apiKeyEnv} environment variable ` +
    `(export ${apiKeyEnv}=${sample}).`
  );
}
