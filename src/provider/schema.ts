import type * as vscode from 'vscode';

export type ReasoningEffort = 'high' | 'max';

export interface ReasoningEntry {
  text: string;
  timestamp: number;
  /** First 500 chars of the assistant response that produced this reasoning. Used to
   * re-align cache slots after VS Code trims or re-orders conversation history.
   * Named "prefix" (not "hash") because it stores raw text, not a digest. */
  assistantContentPrefix?: string;
}

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

export interface ReasoningHistoryState {
  nextReasoningTurnIndex: number;
  entries: Array<[number, ReasoningEntry]>;
  firstUserMessageFingerprint?: string;
}

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
  readonly isUserSelectable: boolean;
  readonly statusIcon?: vscode.ThemeIcon;
  readonly detail?: string;
  readonly tooltip?: string;
  readonly configurationSchema?: typeof MODEL_CONFIGURATION_SCHEMA;
};

export interface ModelDefinition {
  id: string;
  apiModel: 'deepseek-v4-flash' | 'deepseek-v4-pro';
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

export const MODELS: readonly ModelDefinition[] = [
  {
    id: 'deepseek-v4-flash',
    apiModel: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    family: 'deepseek',
    version: 'v4',
    detail: 'Cheap and Fast',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    capabilities: {
      toolCalling: true,
      imageInput: false,
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
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    capabilities: {
      toolCalling: true,
      imageInput: false,
      thinking: true,
    },
  },
];

export const API_KEY_REQUIRED_DETAIL = 'Please run DeepSeek: Set API Key to configure.';
export const REASONING_HISTORY_STORAGE_KEY = 'deepseek.reasoningHistory';
