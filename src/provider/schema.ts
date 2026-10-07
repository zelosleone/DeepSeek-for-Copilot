import type * as vscode from 'vscode';
import { logger } from '../logger.js';
import {
  reasoningChoices,
  reasoningSchema,
  tokenLimits,
  type ModelsDevCache,
  type ModelsDevModel,
  type ReasoningChoices,
} from '../modelsDev.js';

export const MODEL_CATALOG_CACHE_KEY = 'deepseek.modelCatalog.v2';

/** User preference, not model data: merged into each model's live schema. */
const TEMPERATURE_SCHEMA_PROPERTY = {
  type: 'string',
  title: 'Temperature',
  enum: ['balanced', 'precise', 'creative', 'max', 'custom'],
  enumItemLabels: ['Balanced', 'Precise', 'Creative', 'Max', 'Custom'],
  enumDescriptions: [
    'Standard',
    'Low, good for code',
    'Higher, good for writing',
    'Highest, good for creativity',
    'Custom value set in settings',
  ],
  default: 'balanced',
  description: 'Presets',
  group: 'navigation',
} as const;

/** Live reasoningEffort property plus the temperature preset property. */
export function buildConfigurationSchema(choices: ReasoningChoices): object {
  const base = reasoningSchema(choices) as { properties: Record<string, unknown> };
  return {
    properties: {
      ...base.properties,
      temperature: TEMPERATURE_SCHEMA_PROPERTY,
    },
  };
}

export type TemperaturePreset = 'balanced' | 'precise' | 'creative' | 'max';

export const TEMPERATURE_PRESET_VALUES: Record<TemperaturePreset, number> = {
  balanced: 1.0,
  precise: 0.2,
  creative: 1.3,
  max: 1.5,
};

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
  readonly isUserSelectable: boolean;
  readonly detail?: string;
  readonly configurationSchema?: object;
};

export interface ModelDefinition {
  id: string;
  apiModel: string;
  name: string;
  family: string;
  version: string;
  detail: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: {
    toolCalling: boolean;
    imageInput: boolean;
  };
  /** Live reasoning picker choices; absent when the model exposes no reasoning controls. */
  choices?: ReasoningChoices;
  configurationSchema?: object;
}

const NON_CHAT_MODEL_PATTERN = /embed|rerank|moderation|tts|whisper/i;

export function isChatModelId(id: string): boolean {
  return !NON_CHAT_MODEL_PATTERN.test(id);
}

export interface LiveModelEntry {
  id: string;
  object?: string;
  owned_by?: string;
  name?: string;
  context_window?: number;
  max_output_tokens?: number;
  input_modalities?: string[];
  output_modalities?: string[];
  effort?: {
    supported_levels?: string[];
    default_level?: string;
  };
  api_capabilities?: {
    anthropic_messages?: {
      system_prompt_update?: string;
    };
  };
}

function asLiveModelEntry(value: unknown): LiveModelEntry | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw['id'] !== 'string' || !raw['id']) return undefined;
  const entry: LiveModelEntry = { id: raw['id'] };
  if (typeof raw['object'] === 'string') entry.object = raw['object'];
  if (typeof raw['owned_by'] === 'string') entry.owned_by = raw['owned_by'];
  if (typeof raw['name'] === 'string') entry.name = raw['name'];
  if (typeof raw['context_window'] === 'number') entry.context_window = raw['context_window'];
  if (typeof raw['max_output_tokens'] === 'number')
    entry.max_output_tokens = raw['max_output_tokens'];
  if (Array.isArray(raw['input_modalities']))
    entry.input_modalities = raw['input_modalities'].filter(
      (m): m is string => typeof m === 'string',
    );
  if (Array.isArray(raw['output_modalities']))
    entry.output_modalities = raw['output_modalities'].filter(
      (m): m is string => typeof m === 'string',
    );
  if (raw['effort'] && typeof raw['effort'] === 'object') {
    const effort = raw['effort'] as Record<string, unknown>;
    entry.effort = {};
    if (Array.isArray(effort['supported_levels']))
      entry.effort.supported_levels = effort['supported_levels'].filter(
        (l): l is string => typeof l === 'string',
      );
    if (typeof effort['default_level'] === 'string')
      entry.effort.default_level = effort['default_level'];
  }
  if (raw['api_capabilities'] && typeof raw['api_capabilities'] === 'object') {
    const caps = raw['api_capabilities'] as Record<string, unknown>;
    const messages = caps['anthropic_messages'];
    entry.api_capabilities = {};
    if (messages && typeof messages === 'object') {
      const update = (messages as Record<string, unknown>)['system_prompt_update'];
      entry.api_capabilities.anthropic_messages = {};
      if (typeof update === 'string')
        entry.api_capabilities.anthropic_messages.system_prompt_update = update;
    }
  }
  return entry;
}

function positiveNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function includesImage(modalities: readonly string[] | undefined): boolean | undefined {
  if (!modalities) return undefined;
  return modalities.some((m) => m.toLowerCase() === 'image');
}

/** Conservative fallback when DeepSeek lists a model before models.dev catalogs it. */
const DEFAULT_CONTEXT_TOKENS = 131072;
const DEFAULT_OUTPUT_TOKENS = 32768;

/**
 * A live id becomes a model with the provider's own /models fields first,
 * models.dev second, and conservative defaults last.
 */
export function resolveModelDefinition(
  live: LiveModelEntry,
  dev: ModelsDevModel | null | undefined,
): ModelDefinition | undefined {
  // A model DeepSeek lists before models.dev catalogs it still shows up, with safe limits, corrected on the next refresh once models.dev knows it.
  const context =
    positiveNumberOrUndefined(live.context_window) ??
    positiveNumberOrUndefined(dev?.limit?.context) ??
    DEFAULT_CONTEXT_TOKENS;
  const output =
    positiveNumberOrUndefined(live.max_output_tokens) ??
    positiveNumberOrUndefined(dev?.limit?.output) ??
    DEFAULT_OUTPUT_TOKENS;
  const limits = tokenLimits(context, output);
  const choices = reasoningChoices(
    dev?.reasoning_options,
    live.effort
      ? { levels: live.effort.supported_levels, defaultLevel: live.effort.default_level }
      : undefined,
  );
  return {
    id: live.id,
    apiModel: live.id,
    name: live.name?.trim() || dev?.name || live.id,
    family: 'deepseek',
    version: live.id.startsWith('deepseek-') ? live.id.slice('deepseek-'.length) : live.id,
    detail: 'DeepSeek',
    maxInputTokens: limits.maxInputTokens,
    maxOutputTokens: limits.maxOutputTokens,
    capabilities: {
      toolCalling: dev?.tool_call !== false,
      imageInput:
        includesImage(live.input_modalities) ?? includesImage(dev?.modalities?.input) ?? false,
    },
    ...(choices ? { choices, configurationSchema: buildConfigurationSchema(choices) } : {}),
  };
}

export function parseModelListResponse(body: unknown): LiveModelEntry[] {
  if (!body || typeof body !== 'object') return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const entries: LiveModelEntry[] = [];
  for (const item of data) {
    const parsed = asLiveModelEntry(item);
    if (parsed) entries.push(parsed);
  }
  return entries;
}

/** Live ids only: no hardcoded tables, no fallback merge. */
export function resolveModelCatalog(
  entries: readonly LiveModelEntry[],
  devCache: ModelsDevCache | undefined,
): ModelDefinition[] {
  const seen = new Set<string>();
  const catalog: ModelDefinition[] = [];
  const defaulted: string[] = [];
  for (const entry of entries) {
    if (!entry.id || seen.has(entry.id) || !isChatModelId(entry.id)) continue;
    seen.add(entry.id);
    const dev = devCache?.models[entry.id];
    if (
      (positiveNumberOrUndefined(entry.context_window) ??
        positiveNumberOrUndefined(dev?.limit?.context)) === undefined ||
      (positiveNumberOrUndefined(entry.max_output_tokens) ??
        positiveNumberOrUndefined(dev?.limit?.output)) === undefined
    ) {
      defaulted.push(entry.id);
    }
    const definition = resolveModelDefinition(entry, dev);
    if (definition) catalog.push(definition);
  }
  if (defaulted.length > 0) {
    logger.info(`DeepSeek models using default limits: ${defaulted.join(', ')}`);
  }
  return catalog;
}
