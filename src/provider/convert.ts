import * as vscode from 'vscode';
import type { DeepSeekMessage, DeepSeekTool, DeepSeekToolCall } from '../deepseekClient.js';
import type {
  ModelConfigurationOptions,
  ReasoningEntry,
  TemperaturePreset,
  ThinkingEffort,
} from './schema.js';
import { TEMPERATURE_PRESET_VALUES } from './schema.js';

function extractTextFromParts(
  parts: readonly unknown[],
): string {
  let text = '';
  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    }
  }
  return text;
}

export function getMessageText(
  message: vscode.LanguageModelChatRequestMessage,
): string {
  return extractTextFromParts(message.content);
}

export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  isThinkingModel: boolean,
  reasoningCache: Map<number, ReasoningEntry>,
  startTurnIndex = 0,
): DeepSeekMessage[] {
  const result: DeepSeekMessage[] = [];
  let assistantTurnIndex = startTurnIndex;

  // Build a prefix → entry lookup so we can match by content even after
  // VS Code reorders or trims history (addresses index misalignment).
  // On prefix collision (two responses with the same opening 500 chars), keep the
  // most-recent entry so the latest reasoning is preferred.
  const prefixLookup = new Map<string, ReasoningEntry>();
  for (const entry of reasoningCache.values()) {
    if (entry.assistantContentPrefix) {
      const existing = prefixLookup.get(entry.assistantContentPrefix);
      if (!existing || entry.timestamp > existing.timestamp) {
        prefixLookup.set(entry.assistantContentPrefix, entry);
      }
    }
  }

  for (const message of messages) {
    const role = mapRole(message.role);
    let content = '';
    const toolCalls: DeepSeekToolCall[] = [];
    const toolResults: Array<{ callId: string; content: string }> = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        content += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: { name: part.name, arguments: JSON.stringify(part.input) },
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        const toolContent = extractTextFromParts(part.content);
        toolResults.push({
          callId: part.callId,
          content: toolContent || JSON.stringify(part.content),
        });
      }
    }

    if (role === 'assistant') {
      // Prefer prefix-based lookup (robust to positional shifts); fall back to
      // positional index for entries that pre-date the prefix field.
      const contentPrefix = content.slice(0, 500);
      const byPrefix = contentPrefix ? prefixLookup.get(contentPrefix) : undefined;
      const reasoningContent = byPrefix?.text ?? reasoningCache.get(assistantTurnIndex)?.text ?? '';
      assistantTurnIndex += 1;

      if (content || toolCalls.length > 0 || isThinkingModel) {
        const msg: DeepSeekMessage = {
          role: 'assistant' as const,
          content: content || '',
        };
        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
        }
        if (isThinkingModel) {
          msg.reasoning_content = reasoningContent;
        }
        result.push(msg);
      }
    } else if (content) {
      result.push({ role: role as 'user' | 'assistant', content });
    }

    for (const tr of toolResults) {
      result.push({ role: 'tool', content: tr.content, tool_call_id: tr.callId });
    }
  }

  return result;
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' {
  switch (role) {
    case vscode.LanguageModelChatMessageRole.User:
      return 'user';
    case vscode.LanguageModelChatMessageRole.Assistant:
      return 'assistant';
    default:
      return 'user';
  }
}

export function convertTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): DeepSeekTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as Record<string, unknown> | undefined,
    },
  }));
}

export function countMessageChars(messages: DeepSeekMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += msg.content.length;
    if (msg.reasoning_content) total += msg.reasoning_content.length;
  }
  return total;
}

export function getConfiguredThinkingEffort(options: ModelConfigurationOptions): ThinkingEffort {
  const configuredEffort =
    options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort;
  if (configuredEffort === 'none') return 'none';
  if (configuredEffort === 'max') return 'max';
  return 'high';
}

export function getConfiguredTemperature(options: ModelConfigurationOptions): number {
  const pickerValue = options.modelConfiguration?.temperature ?? options.configuration?.temperature;
  const normalizedPickerValue = normalizeTemperatureValue(pickerValue);
  if (normalizedPickerValue !== undefined) return normalizedPickerValue;
  return vscode.workspace.getConfiguration('deepseek').get<number>('temperature', 1.0);
}

export function normalizeTemperatureValue(value: unknown): number | undefined {
  if (typeof value === 'number' && !Number.isNaN(value)) {
    return clampTemperature(value);
  }
  if (typeof value !== 'string') return undefined;

  // Custom preset: read from settings
  if (value === 'custom') {
    const custom = vscode.workspace.getConfiguration('deepseek').get<number>('temperature');
    if (custom !== undefined && !Number.isNaN(custom)) return clampTemperature(custom);
    return undefined;
  }

  const preset = value as TemperaturePreset;
  if (preset in TEMPERATURE_PRESET_VALUES) return TEMPERATURE_PRESET_VALUES[preset];

  const parsed = Number.parseFloat(value);
  if (!Number.isNaN(parsed)) return clampTemperature(parsed);
  return undefined;
}

function clampTemperature(value: number): number {
  return Math.max(0, Math.min(2, value));
}
