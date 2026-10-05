import type * as vscode from 'vscode';

export type ReasoningEffort = 'high' | 'max';

export const MODEL_CONFIGURATION_SCHEMA = {
  properties: {
    reasoningEffort: {
      type: 'string',
      title: 'Thinking Effort',
      enum: ['none', 'high', 'max'],
      enumItemLabels: ['None', 'High', 'Max'],
      enumDescriptions: ['No reasoning', 'Balanced', 'Max reasoning'],
      default: 'high',
      group: 'navigation',
    },
    temperature: {
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
    },
  },
} as const;

export type TemperaturePreset = 'balanced' | 'precise' | 'creative' | 'max';
export type ThinkingEffort = 'none' | 'high' | 'max';

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
  readonly configurationSchema?: typeof MODEL_CONFIGURATION_SCHEMA;
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
    thinking: boolean;
  };
}

export const KNOWN_MODELS: readonly ModelDefinition[] = [
  {
    id: 'deepseek-v4-flash',
    apiModel: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    family: 'deepseek',
    version: 'v4',
    detail: 'Cheap and Fast',
    maxInputTokens: 1048576,
    maxOutputTokens: 393216,
    capabilities: {
      toolCalling: true,
      imageInput: true,
      thinking: true,
    },
  },
  {
    id: 'deepseek-v4-pro',
    apiModel: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    family: 'deepseek',
    version: 'v4',
    detail: 'Pro version',
    maxInputTokens: 1048576,
    maxOutputTokens: 393216,
    capabilities: {
      toolCalling: true,
      imageInput: false,
      thinking: true,
    },
  },
];

export const REASONING_HISTORY_STORAGE_KEY = 'deepseek.reasoningHistory';

export const MODEL_CATALOG_CACHE_KEY = 'deepseek.modelCatalog.v1';

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

function humanizeModelName(value: string): string {
  return value
    .split(/[-_]/)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function inferThinking(id: string): boolean {
  const lower = id.toLowerCase();
  if (lower.includes('reasoner') || lower.includes('r1')) return true;
  if (lower.includes('chat')) return false;
  return true;
}

export function resolveModelDefinition(entry: string | LiveModelEntry): ModelDefinition {
  const live: LiveModelEntry = typeof entry === 'string' ? { id: entry } : entry;
  const known = KNOWN_MODELS.find((m) => m.id === live.id);
  // Bare ids fall back to the known table (covers ids the server omits).
  if (typeof entry === 'string' && known) return known;
  const displayName =
    live.name && live.name.trim() ? humanizeModelName(live.name.trim()) : humanizeModelName(live.id);
  return {
    id: live.id,
    apiModel: live.id,
    name: displayName,
    family: 'deepseek',
    version: known?.version ?? (live.id.startsWith('deepseek-') ? live.id.slice('deepseek-'.length) : live.id),
    detail: known?.detail ?? 'DeepSeek',
    maxInputTokens:
      positiveNumberOrUndefined(live.context_window) ?? known?.maxInputTokens ?? 131072,
    maxOutputTokens:
      positiveNumberOrUndefined(live.max_output_tokens) ?? known?.maxOutputTokens ?? 32768,
    capabilities: {
      toolCalling: true,
      imageInput: live.input_modalities?.some((m) => m.toLowerCase() === 'image') ?? false,
      thinking: live.effort !== undefined && live.effort !== null ? true : inferThinking(live.id),
    },
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

export function resolveModelCatalog(entries: readonly LiveModelEntry[]): ModelDefinition[] {
  const seen = new Set<string>();
  const catalog: ModelDefinition[] = [];
  for (const entry of entries) {
    if (!entry.id || seen.has(entry.id) || !isChatModelId(entry.id)) continue;
    seen.add(entry.id);
    catalog.push(resolveModelDefinition(entry));
  }
  for (const known of KNOWN_MODELS) {
    if (!seen.has(known.id)) {
      seen.add(known.id);
      catalog.push(known);
    }
  }
  return catalog;
}
