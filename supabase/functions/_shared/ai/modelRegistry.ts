// ─── Finora AI Hub — Model Registry ────────────────────────────
//
// Central catalog of available models. The gateway selects a model by task
// type; adding a model means adding an entry here — no gateway changes.

export type AiTaskType = "consultant-chat";

export interface ModelEntry {
  providerId: string;
  modelId: string;
  displayName: string;
  /** Whether the gateway may route traffic to this model. */
  active: boolean;
  maxOutputTokens: number;
  supportsTemperature: boolean;
}

export const MODEL_REGISTRY: Record<AiTaskType, ModelEntry> = {
  "consultant-chat": {
    providerId: "openai",
    modelId: "gpt-4o-mini",
    displayName: "GPT-4o mini",
    active: true,
    maxOutputTokens: 800,
    supportsTemperature: true,
  },
};

export function getModelForTask(task: AiTaskType): ModelEntry {
  const entry = MODEL_REGISTRY[task];
  if (!entry || !entry.active) {
    throw new Error(`No active model registered for task "${task}".`);
  }
  return entry;
}
