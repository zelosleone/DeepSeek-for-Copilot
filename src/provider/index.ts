import * as vscode from 'vscode';
import { AuthManager } from '../auth.js';
import { DeepSeekClient, type DeepSeekToolCall, type DeepSeekUsage } from '../deepseekClient.js';
import { logger } from '../logger.js';
import {
  convertMessages,
  convertTools,
  countMessageChars,
  getConfiguredTemperature,
  getConfiguredThinkingEffort,
} from './convert.js';
import {
  API_KEY_REQUIRED_DETAIL,
  MODEL_CONFIGURATION_SCHEMA,
  MODELS,
  type ModelConfigurationOptions,
  type ModelDefinition,
  type ModelPickerChatInformation,
  REASONING_HISTORY_STORAGE_KEY,
  type ReasoningEffort,
  type ReasoningEntry,
  type ReasoningHistoryState,
} from './schema.js';

export class DeepSeekChatProvider implements vscode.LanguageModelChatProvider {
  private readonly context: vscode.ExtensionContext;
  private readonly authManager: AuthManager;
  private readonly onUsage?: (usage: DeepSeekUsage) => void;
  private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeLanguageModelChatInformation =
    this.onDidChangeLanguageModelChatInformationEmitter.event;

  private readonly reasoningCache: Map<number, ReasoningEntry>;
  private nextReasoningTurnIndex: number;
  private charsPerToken = 4.0;

  constructor(context: vscode.ExtensionContext, onUsage?: (usage: DeepSeekUsage) => void) {
    this.context = context;
    this.authManager = new AuthManager(context);
    this.onUsage = onUsage;

    const persisted = context.workspaceState.get<ReasoningHistoryState>(
      REASONING_HISTORY_STORAGE_KEY,
    );
    this.reasoningCache = new Map(persisted?.entries ?? []);
    this.nextReasoningTurnIndex = persisted?.nextReasoningTurnIndex ?? this.reasoningCache.size;

    context.subscriptions.push(
      this.onDidChangeLanguageModelChatInformationEmitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('deepseek.apiKey')) {
          this.onDidChangeLanguageModelChatInformationEmitter.fire();
        }
      }),
      context.secrets.onDidChange((e) => {
        if (e.key === 'deepseek.apiKey') {
          this.onDidChangeLanguageModelChatInformationEmitter.fire();
        }
      }),
    );
  }

  async configureApiKey(): Promise<void> {
    const saved = await this.authManager.promptForApiKey();
    if (saved) this.onDidChangeLanguageModelChatInformationEmitter.fire();
  }

  async clearApiKey(): Promise<void> {
    await this.authManager.deleteApiKey();
    this.onDidChangeLanguageModelChatInformationEmitter.fire();
    vscode.window.showInformationMessage('DeepSeek API key removed.');
  }

  async hasApiKey(): Promise<boolean> {
    return this.authManager.hasApiKey();
  }

  async configureTemperature(): Promise<void> {
    const presets = [
      { key: 'balanced', label: 'Balanced', value: 1.0, description: 'Default for most tasks' },
      {
        key: 'precise',
        label: 'Precise',
        value: 0.2,
        description: 'Coding / Math (deterministic)',
      },
      { key: 'creative', label: 'Creative', value: 1.3, description: 'Writing / Brainstorming' },
      { key: 'max', label: 'Max', value: 1.5, description: 'Maximum variety' },
    ];

    const selection = await vscode.window.showQuickPick(
      [
        ...presets.map((p) => ({
          label: p.label,
          description: `${p.value} — ${p.description}`,
          value: p.value,
        })),
        { label: 'Custom', description: 'Enter your own value (0.0 - 2.0)', value: undefined },
      ],
      { placeHolder: 'Select temperature for DeepSeek models' },
    );

    if (!selection) return;

    let value: number;
    if (selection.value === undefined) {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter temperature value (0.0 - 2.0)',
        validateInput: (text) => {
          const parsed = Number.parseFloat(text);
          if (Number.isNaN(parsed) || parsed < 0 || parsed > 2) {
            return 'Value must be a number between 0.0 and 2.0';
          }
          return undefined;
        },
      });
      if (!input) return;
      value = Number.parseFloat(input);
    } else {
      value = selection.value;
    }

    await vscode.workspace.getConfiguration('deepseek').update('temperature', value, true);
    vscode.window.showInformationMessage(`DeepSeek temperature set to ${value}`);
  }

  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const hasKey = await this.authManager.hasApiKey();
    return MODELS.map((model) => toChatInfo(model, hasKey));
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
      throw new Error(
        'DeepSeek API key not configured. Run "DeepSeek: Set API Key" from the Command Palette.',
      );
    }

    const baseUrl = this.authManager.getBaseUrl();
    const client = new DeepSeekClient(baseUrl, apiKey);

    const modelDef = findModel(modelInfo.id);
    if (!modelDef) throw new Error(`Unknown DeepSeek model: ${modelInfo.id}`);

    const isThinkingModel = modelDef.capabilities.thinking;
    const modelConfig = options as ModelConfigurationOptions;
    const thinkingEffort = getConfiguredThinkingEffort(modelConfig);
    const temperature = getConfiguredTemperature(modelConfig);

    if (messages.length <= 2) {
      this.reasoningCache.clear();
      this.nextReasoningTurnIndex = 0;
      void this.persistReasoningHistory();
    }

    const deepseekMessages = convertMessages(messages, isThinkingModel, this.reasoningCache);
    const tools = modelDef.capabilities.toolCalling ? convertTools(options.tools) : undefined;
    const totalRequestChars = countMessageChars(deepseekMessages);

    const thinkingParams = isThinkingModel
      ? {
          thinking: {
            type: thinkingEffort === 'none' ? ('disabled' as const) : ('enabled' as const),
          },
          ...(thinkingEffort === 'none'
            ? {}
            : { reasoning_effort: thinkingEffort as ReasoningEffort }),
        }
      : {};

    let accumulatedReasoning = '';

    return new Promise<void>((resolve, reject) => {
      client.streamChatCompletion(
        {
          model: modelDef.apiModel,
          messages: deepseekMessages,
          stream: true,
          temperature,
          tools,
          tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
          ...thinkingParams,
        },
        {
          onContent: (content: string) => {
            progress.report(new vscode.LanguageModelTextPart(content));
          },

          onThinking: (text: string) => {
            accumulatedReasoning += text;
            progress.report(
              new vscode.LanguageModelThinkingPart(
                text,
              ) as unknown as vscode.LanguageModelResponsePart,
            );
          },

          onReasoningContent: (content: string) => {
            accumulatedReasoning += content;
          },

          onToolCall: (toolCall: DeepSeekToolCall) => {
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
            this.reasoningCache.set(this.nextReasoningTurnIndex, {
              text: isThinkingModel ? accumulatedReasoning : '',
              timestamp: Date.now(),
            });
            this.nextReasoningTurnIndex += 1;
            void this.persistReasoningHistory();
            resolve();
          },

          onUsage: (usage: DeepSeekUsage) => {
            if (totalRequestChars > 0 && usage.prompt_tokens > 0) {
              const observedRatio = totalRequestChars / usage.prompt_tokens;
              this.charsPerToken = this.charsPerToken * 0.7 + observedRatio * 0.3;
            }

            const cacheHit = usage.prompt_cache_hit_tokens ?? 0;
            const cacheMiss = usage.prompt_cache_miss_tokens ?? 0;
            const cacheTotal = cacheHit + cacheMiss;
            const hitRate =
              cacheTotal > 0 ? `${((cacheHit / cacheTotal) * 100).toFixed(0)}%` : 'n/a';
            logger.info(
              `tokens: context=${usage.prompt_tokens} completion=${usage.completion_tokens}` +
                ` | cache: hit=${cacheHit} miss=${cacheMiss} rate=${hitRate}` +
                ` | temp=${temperature} chars/tok=${this.charsPerToken.toFixed(2)}`,
            );

            this.onUsage?.(usage);
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
      return Math.max(1, Math.ceil(text.length / this.charsPerToken));
    }
    if (!text?.content || !Array.isArray(text.content)) return 1;

    let total = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) total += part.value.length;
    }
    return Math.max(1, Math.ceil(total / this.charsPerToken));
  }

  private persistReasoningHistory(): Thenable<void> {
    return this.context.workspaceState.update(REASONING_HISTORY_STORAGE_KEY, {
      nextReasoningTurnIndex: this.nextReasoningTurnIndex,
      entries: [...this.reasoningCache.entries()],
    });
  }
}

function findModel(id: string): ModelDefinition | undefined {
  return MODELS.find((m) => m.id === id);
}

function toChatInfo(m: ModelDefinition, hasApiKey: boolean): ModelPickerChatInformation {
  return {
    id: m.id,
    name: m.name,
    family: m.family,
    version: m.version,
    detail: hasApiKey ? m.detail : API_KEY_REQUIRED_DETAIL,
    tooltip: hasApiKey ? undefined : API_KEY_REQUIRED_DETAIL,
    statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
    maxInputTokens: m.maxInputTokens,
    maxOutputTokens: m.maxOutputTokens,
    isUserSelectable: true,
    capabilities: {
      toolCalling: m.capabilities.toolCalling,
      imageInput: m.capabilities.imageInput,
    },
    ...(m.capabilities.thinking ? { configurationSchema: MODEL_CONFIGURATION_SCHEMA } : {}),
  };
}
