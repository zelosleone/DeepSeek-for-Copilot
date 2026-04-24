import * as vscode from 'vscode';
import { AuthManager } from './auth.js';
import {
  DeepSeekClient,
  DeepSeekMessage,
  DeepSeekTool,
  DeepSeekToolCall,
} from './deepseekClient.js';

type ThinkingMode = 'enabled' | 'disabled';
type ReasoningEffort = 'high' | 'max';

interface DeepSeekModelDefinition {
  id: string;
  apiModel: 'deepseek-v4-flash' | 'deepseek-v4-pro';
  name: string;
  family: string;
  version: string;
  thinking: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: {
    toolCalling: boolean;
    imageInput: boolean;
  };
}

const MODELS: readonly DeepSeekModelDefinition[] = [
  {
    id: 'deepseek-v4-flash',
    apiModel: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    family: 'deepseek-v4',
    version: 'v4-flash',
    thinking: 'disabled',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'deepseek-v4-flash-thinking',
    apiModel: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash Thinking',
    family: 'deepseek-v4',
    version: 'v4-flash',
    thinking: 'enabled',
    reasoningEffort: 'high',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'deepseek-v4-pro',
    apiModel: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    family: 'deepseek-v4',
    version: 'v4-pro',
    thinking: 'disabled',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'deepseek-v4-pro-thinking',
    apiModel: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro Thinking',
    family: 'deepseek-v4',
    version: 'v4-pro',
    thinking: 'enabled',
    reasoningEffort: 'high',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
];

export class DeepSeekChatProvider implements vscode.LanguageModelChatProvider {
  private readonly authManager: AuthManager;
  private readonly reasoningCache = new Map<string, string>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.authManager = new AuthManager(context);
  }

  async configureApiKey(): Promise<void> {
    await this.authManager.promptForApiKey();
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    return MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      family: model.family,
      version: model.version,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: model.capabilities,
    }));
  }

  async provideLanguageModelChatResponse(
    modelInfo: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    let apiKey = await this.authManager.getApiKey();

    if (!apiKey) {
      const configured = await this.authManager.promptForApiKey();
      apiKey = configured ? await this.authManager.getApiKey() : undefined;
    }

    if (!apiKey) {
      throw new Error('DeepSeek API key not configured.');
    }

    const baseUrl = this.authManager.getBaseUrl();
    const client = new DeepSeekClient(baseUrl, apiKey);

    const modelDef = MODELS.find((m) => m.id === modelInfo.id);
    if (!modelDef) {
      throw new Error(`Unknown DeepSeek model: ${modelInfo.id}`);
    }

    const behavior = this.resolveModelBehavior(modelDef, options.modelOptions);
    const usesThinking = behavior.thinking === 'enabled';
    const deepseekMessages = this.convertMessages(messages, usesThinking);

    const tools = modelDef.capabilities.toolCalling ? this.convertTools(options.tools) : undefined;
    const toolChoice = this.convertToolChoice(options.toolMode, tools);

    let currentReasoningContent = '';

    return new Promise((resolve, reject) => {
      client.streamChatCompletion(
        {
          model: modelDef.apiModel,
          messages: deepseekMessages,
          thinking: { type: behavior.thinking },
          reasoning_effort: behavior.reasoningEffort,
          tools,
          tool_choice: toolChoice,
        },
        {
          onContent: (content: string) => {
            progress.report(new vscode.LanguageModelTextPart(content));
          },
          onReasoningContent: (content: string) => {
            currentReasoningContent += content;
          },
          onToolCall: (toolCall: DeepSeekToolCall) => {
            if (usesThinking && currentReasoningContent) {
              this.reasoningCache.set(toolCall.id, currentReasoningContent);
            }
            try {
              const args = JSON.parse(toolCall.function.arguments);
              progress.report(
                new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, args),
              );
            } catch {
              progress.report(
                new vscode.LanguageModelToolCallPart(toolCall.id, toolCall.function.name, {}),
              );
            }
          },
          onError: (error: Error) => {
            reject(error);
          },
          onDone: () => {
            this.pruneReasoningCache();
            resolve();
          },
        },
        token,
      );
    });
  }

  async provideTokenCount(
    _modelInfo: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === 'string') {
      return Math.max(1, Math.ceil(text.length / 4));
    }

    let content = '';
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        content += part.value;
      }
    }

    return Math.max(1, Math.ceil(content.length / 4));
  }

  private resolveModelBehavior(
    model: DeepSeekModelDefinition,
    modelOptions: Record<string, unknown> | undefined,
  ): { thinking: ThinkingMode; reasoningEffort?: ReasoningEffort } {
    const thinking = this.getThinkingOverride(modelOptions) ?? model.thinking;
    if (thinking === 'disabled') {
      return { thinking };
    }

    return {
      thinking,
      reasoningEffort: this.getReasoningEffort(modelOptions) ?? model.reasoningEffort ?? 'high',
    };
  }

  private getThinkingOverride(
    modelOptions: Record<string, unknown> | undefined,
  ): ThinkingMode | undefined {
    if (!modelOptions) {
      return undefined;
    }

    const rawThinking =
      modelOptions.thinking ?? modelOptions.thinkingMode ?? modelOptions.thinking_mode;

    if (typeof rawThinking === 'boolean') {
      return rawThinking ? 'enabled' : 'disabled';
    }

    if (typeof rawThinking === 'object' && rawThinking !== null && 'type' in rawThinking) {
      const rawType = (rawThinking as { type?: unknown }).type;
      if (typeof rawType === 'string') {
        return this.normalizeThinkingMode(rawType);
      }
    }

    if (typeof rawThinking === 'string') {
      return this.normalizeThinkingMode(rawThinking);
    }

    return undefined;
  }

  private normalizeThinkingMode(value: string): ThinkingMode | undefined {
    switch (value.toLowerCase()) {
      case 'enabled':
      case 'enable':
      case 'on':
      case 'true':
        return 'enabled';
      case 'disabled':
      case 'disable':
      case 'off':
      case 'false':
        return 'disabled';
      default:
        return undefined;
    }
  }

  private getReasoningEffort(
    modelOptions: Record<string, unknown> | undefined,
  ): ReasoningEffort | undefined {
    if (!modelOptions) {
      return undefined;
    }

    const rawEffort =
      modelOptions.reasoning_effort ?? modelOptions.reasoningEffort ?? modelOptions.effort;

    if (typeof rawEffort !== 'string') {
      return undefined;
    }

    switch (rawEffort.toLowerCase()) {
      case 'low':
      case 'medium':
      case 'high':
        return 'high';
      case 'xhigh':
      case 'max':
        return 'max';
      default:
        return undefined;
    }
  }

  private convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    usesThinking: boolean,
  ): DeepSeekMessage[] {
    const result: DeepSeekMessage[] = [];

    for (const message of messages) {
      const role = this.mapRole(message.role);

      let content = '';
      const toolCalls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }> = [];
      const toolResults: Array<{ callId: string; content: string }> = [];

      for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          content += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            id: part.callId,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input),
            },
          });
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          let toolContent = '';
          for (const item of part.content) {
            if (item instanceof vscode.LanguageModelTextPart) {
              toolContent += item.value;
            }
          }
          toolResults.push({
            callId: part.callId,
            content: toolContent || JSON.stringify(part.content),
          });
        }
      }

      if (role === 'assistant') {
        let reasoningContent: string | undefined;
        if (usesThinking) {
          // Try to find cached reasoning content for any tool calls
          for (const tc of toolCalls) {
            const cached = this.reasoningCache.get(tc.id);
            if (cached) {
              reasoningContent = cached;
              break;
            }
          }
        }

        const message: DeepSeekMessage = {
          role: 'assistant',
          content: content || '',
        };

        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls;
        }

        if (usesThinking) {
          message.reasoning_content = reasoningContent || '';
        }

        result.push(message);
      } else if (content) {
        result.push({ role, content });
      }

      for (const tr of toolResults) {
        result.push({
          role: 'tool',
          content: tr.content,
          tool_call_id: tr.callId,
        });
      }
    }

    return result;
  }

  private mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' {
    switch (role) {
      case vscode.LanguageModelChatMessageRole.User:
        return 'user';
      case vscode.LanguageModelChatMessageRole.Assistant:
        return 'assistant';
      default:
        return 'user';
    }
  }

  private convertTools(
    tools: readonly vscode.LanguageModelChatTool[] | undefined,
  ): DeepSeekTool[] | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    return tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown> | undefined,
      },
    }));
  }

  private convertToolChoice(
    toolMode: vscode.LanguageModelChatToolMode | undefined,
    tools: DeepSeekTool[] | undefined,
  ): 'auto' | 'required' | undefined {
    if (!tools || tools.length === 0) {
      return undefined;
    }

    if (toolMode === vscode.LanguageModelChatToolMode.Required) {
      return 'required';
    }

    return 'auto';
  }

  private pruneReasoningCache(): void {
    if (this.reasoningCache.size <= 50) {
      return;
    }

    const keys = [...this.reasoningCache.keys()];
    for (let i = 0; i < keys.length - 50; i++) {
      this.reasoningCache.delete(keys[i]);
    }
  }
}
