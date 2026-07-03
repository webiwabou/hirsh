import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  loadConfig,
  looksLikeApiKeySecret,
  resolveAnthropicApiKey,
  resolveOpenAIApiKey,
} from "../src/config/loadConfig.js";
import { createProvider, ProviderError } from "../src/llm/index.js";

function writeTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hirsh-cfg-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, contents, "utf8");
  return path;
}

afterEach(() => {
  delete process.env.HIRSH_CONFIG;
  delete process.env.MY_TEST_KEY;
  delete process.env.GROQ_API_KEY;
});

describe("loadConfig", () => {
  it("reads provider and sections from HIRSH_CONFIG", () => {
    process.env.HIRSH_CONFIG = writeTempConfig(
      ["provider: anthropic", "anthropic:", "  apiKeyEnv: MY_TEST_KEY", "  model: some-model"].join("\n"),
    );
    const { config, sourcePath } = loadConfig();
    expect(sourcePath).toBe(process.env.HIRSH_CONFIG);
    expect(config.provider).toBe("anthropic");
    expect(config.anthropic.apiKeyEnv).toBe("MY_TEST_KEY");
    expect(config.anthropic.model).toBe("some-model");
    // defaults still applied for unspecified sections
    expect(config.execution.containerEngine).toBe("docker");
  });

  it("rejects an invalid provider", () => {
    process.env.HIRSH_CONFIG = writeTempConfig("provider: bogus\n");
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  it("supports the openai-compatible provider with Groq defaults and env key", () => {
    process.env.HIRSH_CONFIG = writeTempConfig(
      ["provider: openai", "openai:", "  model: llama-3.1-8b-instant"].join("\n"),
    );
    const { config } = loadConfig();
    expect(config.provider).toBe("openai");
    expect(config.openai.baseUrl).toBe("https://api.groq.com/openai/v1"); // default
    expect(config.openai.model).toBe("llama-3.1-8b-instant"); // overridden
    expect(config.openai.apiKeyEnv).toBe("GROQ_API_KEY"); // default
    expect(resolveOpenAIApiKey(config)).toBeNull();
    process.env.GROQ_API_KEY = "gsk_test";
    expect(resolveOpenAIApiKey(config)).toBe("gsk_test");
  });

  it("resolves the API key from the named env var", () => {
    process.env.HIRSH_CONFIG = writeTempConfig(
      ["provider: anthropic", "anthropic:", "  apiKeyEnv: MY_TEST_KEY"].join("\n"),
    );
    const { config } = loadConfig();
    expect(resolveAnthropicApiKey(config)).toBeNull();
    process.env.MY_TEST_KEY = "sk-ant-xyz";
    expect(resolveAnthropicApiKey(config)).toBe("sk-ant-xyz");
  });
});

describe("looksLikeApiKeySecret", () => {
  it("flags pasted keys but not env-var names", () => {
    expect(looksLikeApiKeySecret("gsk_cxyZlkARz7twjLHJIrhZWGdyb3FY4dJPx0y")).toBe(true);
    expect(looksLikeApiKeySecret("sk-ant-abc123")).toBe(true);
    expect(looksLikeApiKeySecret("GROQ_API_KEY")).toBe(false);
    expect(looksLikeApiKeySecret("ANTHROPIC_API_KEY")).toBe(false);
    expect(looksLikeApiKeySecret("MY_KEY")).toBe(false);
  });
});

describe("createProvider — pasted-key guardrail", () => {
  it("gives a clear error when the key is pasted into openai.apiKeyEnv", () => {
    process.env.HIRSH_CONFIG = writeTempConfig(
      ["provider: openai", "openai:", "  apiKeyEnv: gsk_cxyZlkARz7twjLHJIrhZWGdyb3FY4dJPx0y"].join("\n"),
    );
    const { config } = loadConfig();
    expect(() => createProvider(config)).toThrow(ProviderError);
    expect(() => createProvider(config)).toThrow(/NAME of an environment variable/);
  });

  it("builds the provider when apiKeyEnv is a name (keyless local is allowed)", () => {
    process.env.HIRSH_CONFIG = writeTempConfig(
      ["provider: openai", "openai:", "  baseUrl: http://localhost:8000/v1", "  apiKeyEnv: NOT_SET_VAR"].join("\n"),
    );
    const { config } = loadConfig();
    expect(createProvider(config).label).toContain("openai-compatible");
  });
});
