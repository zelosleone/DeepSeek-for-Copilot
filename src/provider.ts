import * as vscode from 'vscode';
import { AuthManager } from './auth.js';
import {
  DeepSeekClient,
  DeepSeekMessage,
  DeepSeekTool,
  DeepSeekToolCall,
} from './deepseekClient.js';

const MODELS = [
  {
    id: 'deepseek-chat',
    name: 'DeepSeek Chat',
    family: 'deepseek',
    version: 'v3.2',
    detail: 'Official',
    maxInputTokens: 128000, // 128K context
    maxOutputTokens: 8192, // 8K max output
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    family: 'deepseek',
    version: 'v3.2',
    detail: 'Official',
    maxInputTokens: 128000, // 128K context
    maxOutputTokens: 65536, // 64K max output
    capabilities: {
      toolCalling: true,
      imageInput: false,
    },
  },
] as const;

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
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const hasKey = await this.authManager.hasApiKey();

    if (!hasKey) {
      if (options.silent) {
        return [];
      }
      const configured = await this.authManager.promptForApiKey();
      if (!configured) {
        return [];
      }
    }

    return MODELS.map((model) => ({
      id: model.id,
      name: model.name,
      family: model.family,
      version: model.version,
      detail: model.detail,
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
    const apiKey = await this.authManager.getApiKey();

    if (!apiKey) {
      throw new Error('DeepSeek API key not configured. Run "DeepSeek: Set API Key" command.');
    }

    const baseUrl = this.authManager.getBaseUrl();
    const client = new DeepSeekClient(baseUrl, apiKey);

    const isReasoner = modelInfo.id === 'deepseek-reasoner';

    this.reasoningCache.clear();
    const deepseekMessages = this.convertMessages(messages, isReasoner);

    const modelDef = MODELS.find((m) => m.id === modelInfo.id);
    const tools = modelDef?.capabilities.toolCalling ? this.convertTools(options.tools) : undefined;

    let currentReasoningContent = '';
    const toolCallIds: string[] = [];
    let responseMessageId: string | undefined;

    return new Promise((resolve, reject) => {
      client.streamChatCompletion(
        {
          model: modelInfo.id,
          messages: deepseekMessages,
          tools,
          tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
        },
        {
          onContent: (content: string) => {
            progress.report(new vscode.LanguageModelTextPart(content));
          },
          onReasoningContent: (content: string) => {
            currentReasoningContent += content;
          },
          onToolCall: (toolCall: DeepSeekToolCall) => {
            toolCallIds.push(toolCall.id);
            if (isReasoner && currentReasoningContent) {
              this.reasoningCache.set(toolCall.id, currentReasoningContent);
              currentReasoningContent = '';
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
            if (isReasoner && currentReasoningContent) {
              responseMessageId = `response_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
              this.reasoningCache.set(responseMessageId, currentReasoningContent);
            }
            
            if (this.reasoningCache.size > 50) {
              const keys = [...this.reasoningCache.keys()];
              for (let i = 0; i < keys.length - 50; i++) {
                this.reasoningCache.delete(keys[i]);
              }
            }
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

  private convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    isReasoner: boolean,
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
        if (isReasoner) {
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

        if (isReasoner) {
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
}
