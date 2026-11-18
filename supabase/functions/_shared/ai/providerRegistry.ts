// ─── Finora AI Hub — Provider Registry ─────────────────────────
//
// The gateway requests AI completions by provider ID through this registry.
// Keys are read here (from Deno.env) and passed to adapters — they are never
// logged, never returned, and never reach the frontend.

import type { ProviderAdapter } from "./providerAdapter.ts";
import { openaiAdapter } from "./adapters/openai.ts";
import { AiProviderError } from "./errors.ts";
import type { AiChatRequest, AiChatResponse } from "./types.ts";

const ADAPTERS: Record<string, ProviderAdapter> = {
  openai: openaiAdapter,
  // Future providers register here — e.g. gemini: geminiAdapter.
};

export function isProviderRegistered(providerId: string): boolean {
  return providerId in ADAPTERS;
}

/**
 * Execute a chat completion via the registered provider.
 * Throws AiProviderError when the provider is unknown or the call fails.
 */
export async function chatViaProvider(request: AiChatRequest): Promise<AiChatResponse> {
  const adapter = ADAPTERS[request.providerId];
  if (!adapter) {
    throw new AiProviderError({
      code: "unknown",
      providerId: request.providerId,
      message: `Provider "${request.providerId}" is not registered.`,
    });
  }

  const apiKey = Deno.env.get(adapter.apiKeyEnvName);
  if (!apiKey) {
    throw new AiProviderError({
      code: "authentication",
      providerId: adapter.id,
      message: `Secret ${adapter.apiKeyEnvName} is not configured.`,
    });
  }

  return adapter.chat(request, apiKey);
}
