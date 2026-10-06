import * as vscode from 'vscode';
import type { DeepSeekMessage, DeepSeekTool, DeepSeekToolCall } from '../deepseekClient.js';
import { readReasoningMarker } from './replay.js';
import type { ModelConfigurationOptions, TemperaturePreset } from './schema.js';
import { TEMPERATURE_PRESET_VALUES } from './schema.js';

// Copilot sends its system prompt with the proposed System role, which the stable typings lack.
const SYSTEM_ROLE = 3 as vscode.LanguageModelChatMessageRole;

function extractTextFromParts(parts: readonly unknown[]): string {
  let text = '';
  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text += part.value;
    }
  }
  return text;
}

export function convertMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  includeReasoning: boolean,
): DeepSeekMessage[] {
  const result: DeepSeekMessage[] = [];

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
      // The thinking-disabled path must not send reasoning replay content.
      const reasoningContent = includeReasoning ? (readReasoningMarker(message) ?? '') : '';

      if (content || toolCalls.length > 0 || reasoningContent) {
        const msg: DeepSeekMessage = {
          role: 'assistant' as const,
          content: content || '',
        };
        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
        }
        if (reasoningContent) {
          msg.reasoning_content = reasoningContent;
        }
        result.push(msg);
      }
    } else if (content) {
      result.push({ role, content });
    }

    for (const tr of toolResults) {
      result.push({ role: 'tool', content: tr.content, tool_call_id: tr.callId });
    }
  }

  return result;
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'system' | 'user' | 'assistant' {
  switch (role) {
    case vscode.LanguageModelChatMessageRole.Assistant:
      return 'assistant';
    case SYSTEM_ROLE:
      return 'system';
    default:
      return 'user';
  }
}

export function convertTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): DeepSeekTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown> | undefined,
      },
    }))
    // DeepSeek's prompt cache keys on the rendered prefix, and the tool list is
    // part of it. Copilot gives no ordering guarantee, so an unsorted list lets a
    // reshuffle invalidate the entire prefix. Ordering after Reasonix's
    // normalizeToolSchemas: name, then description, then parameters.
    .sort(
      (a, b) =>
        a.function.name.localeCompare(b.function.name) ||
        (a.function.description ?? '').localeCompare(b.function.description ?? '') ||
        JSON.stringify(a.function.parameters ?? null).localeCompare(
          JSON.stringify(b.function.parameters ?? null),
        ),
    );
}

/**
 * Image bytes carry no per-character token information, so they are blanked
 * before measuring: data URLs and long embedded base64 payloads.
 */
function stripImageData(json: string): string {
  return json
    .replace(/data:[A-Za-z0-9/+.=-]+;[A-Za-z0-9;=+.~:/-]*base64,[A-Za-z0-9+/=]+/g, '')
    .replace(/"(base64|image_url|url)"\s*:\s*"[A-Za-z0-9+/=\s]{256,}"/g, '"$1":""');
}

/** Full request payload (messages AND tools) with image data removed. */
export function countRequestChars(
  messages: readonly DeepSeekMessage[],
  tools: readonly DeepSeekTool[] | undefined,
): number {
  return stripImageData(JSON.stringify({ messages, tools: tools ?? [] })).length;
}

/** Provider-converted form of one message (replay included) with image data removed. */
export function countConvertedMessageChars(
  message: vscode.LanguageModelChatRequestMessage,
): number {
  return stripImageData(JSON.stringify(convertMessages([message], true))).length;
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
