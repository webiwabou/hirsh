/**
 * Schema-validated structured output (Phase 2).
 *
 * Wraps a forced-tool chat call and validates the tool arguments against a Zod
 * schema. If the model returns no tool call or malformed arguments, it retries
 * once with a corrective message — which makes weaker local models (e.g. small
 * Ollama models) far more reliable — and returns null if it still fails so the
 * caller can fall back gracefully.
 */
import { z } from "zod";
import type { ChatMessage, LLMProvider, ToolDefinition } from "./provider.js";

/** A string that normalizes "", "null" and non-strings to null. */
export const nullableText = z.preprocess(
  (v) => (typeof v === "string" && (v.trim() === "" || v.trim().toLowerCase() === "null") ? null : v),
  z.string().nullable(),
);

/** A boolean tolerant of "true"/"false"/0/1 as produced by some models. */
export const looseBoolean = z.preprocess((v) => {
  if (v === true || v === "true" || v === 1) return true;
  if (v === false || v === "false" || v === 0) return false;
  return v;
}, z.boolean());

export interface StructuredOptions<S extends z.ZodTypeAny> {
  messages: ChatMessage[];
  tool: ToolDefinition;
  schema: S;
  /** Total attempts (initial + retries). Default 2. */
  maxAttempts?: number;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 4)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export async function callStructured<S extends z.ZodTypeAny>(
  provider: LLMProvider,
  opts: StructuredOptions<S>,
): Promise<z.infer<S> | null> {
  const attempts = opts.maxAttempts ?? 2;
  const messages: ChatMessage[] = [...opts.messages];

  for (let attempt = 0; attempt < attempts; attempt++) {
    const resp = await provider.chat({
      messages,
      tools: [opts.tool],
      forceTool: opts.tool.name,
    });
    const call = resp.toolCalls.find((c) => c.name === opts.tool.name);
    const last = attempt === attempts - 1;

    if (!call) {
      if (last) return null;
      messages.push({
        role: "user",
        content: `You did not call the ${opts.tool.name} tool. Respond ONLY by calling ${opts.tool.name}.`,
      });
      continue;
    }

    const parsed = opts.schema.safeParse(call.arguments);
    if (parsed.success) return parsed.data;
    if (last) return null;

    messages.push({
      role: "user",
      content:
        `Your ${opts.tool.name} call had invalid arguments (${formatIssues(parsed.error)}). ` +
        `Call ${opts.tool.name} again with valid values.`,
    });
  }

  return null;
}
