import * as vscode from 'vscode';
import { AuthManager, setProviderConfiguredApiKey } from '../auth.js';
import { DeepSeekClient, type DeepSeekToolCall, type DeepSeekUsage } from '../deepseekClient.js';
import { logger } from '../logger.js';
import {
  convertMessages,
  convertTools,
  countMessageChars,
  getConfiguredTemperature,
  getConfiguredThinkingEffort,
  getMessageText,
  normalizeTemperatureValue,
} from './convert.js';
import { captureShape, describeShapeChange, type PrefixShape } from './cacheShape.js';
import { createReasoningMarkerPart } from './replay.js';
import {
  KNOWN_MODELS,
  MODEL_CATALOG_CACHE_KEY,
  MODEL_CONFIGURATION_SCHEMA,
  parseModelListResponse,
  resolveModelCatalog,
  type ModelConfigurationOptions,
  type ModelDefinition,
  type ModelPickerChatInformation,
  REASONING_HISTORY_STORAGE_KEY,
  type ReasoningEffort,
} from './schema.js';

export interface SessionUsageInfo {
  sessionId: string;
  usage: DeepSeekUsage;
  generationId: number;
}

/**
 * `configuration` is part of the proposed chatProvider API, so it is absent from the
 * stable typings. VS Code populates it at runtime once the provider declares a
 * `configuration` schema in its `languageModelChatProviders` contribution.
 */
type PrepareOptionsWithConfiguration = vscode.PrepareLanguageModelChatModelOptions & {
  readonly configuration?: { readonly apiKey?: string };
};

/**
 * VS Code hands the model object back to us on each request, so the key rides
 * along on it. Mirroring it into secret storage instead would make the ungrouped
 * code path serve models as well, registering every model twice: once as
 * `deepseek/<id>` and once as `deepseek/<group>/<id>`.
 */
type ModelWithApiKey = ModelPickerChatInformation & {
  readonly isBYOK?: boolean;
  readonly apiKey?: string;
};

export class DeepSeekChatProvider implements vscode.LanguageModelChatProvider {
  private static nextGenerationId = 0;
  private readonly authManager: AuthManager;
  private readonly onUsage?: (info: SessionUsageInfo) => void;
  private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeLanguageModelChatInformation =
    this.onDidChangeLanguageModelChatInformationEmitter.event;

  private charsPerToken = 4.0;
  private lastPrefixShape: PrefixShape | undefined;
  private readonly extensionContext: vscode.ExtensionContext;
  private availableModels: ModelDefinition[];
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(context: vscode.ExtensionContext, onUsage?: (info: SessionUsageInfo) => void) {
    this.authManager = new AuthManager(context);
    this.onUsage = onUsage;
    this.extensionContext = context;
    this.availableModels = loadCachedCatalog(context);
    void this.refreshModels();
    this.refreshTimer = setInterval(() => {
      void this.refreshModels();
    }, 30 * 60 * 1000);
    if (typeof this.refreshTimer.unref === 'function') this.refreshTimer.unref();

    // Reasoning used to live in a provider-global map persisted here, which leaked
    // between chat sessions (#10). It now travels with the conversation instead.
    void context.workspaceState.update(REASONING_HISTORY_STORAGE_KEY, undefined);

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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.onDidChangeLanguageModelChatInformationEmitter.dispose();
  }

  async refreshModels(): Promise<void> {
    if (this.disposed) return;
    const apiKey = await this.authManager.getApiKey();
    if (!apiKey) return;
    try {
      const baseUrl = this.authManager.getBaseUrl().replace(/\/+$/, '');
      const response = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) return;
      const body: unknown = await response.json();
      const merged = resolveModelCatalog(parseModelListResponse(body));
      const previousIds = this.availableModels.map((m) => m.id).join('\n');
      const nextIds = merged.map((m) => m.id).join('\n');
      this.availableModels = merged;
      await this.extensionContext.globalState.update(MODEL_CATALOG_CACHE_KEY, {
        savedAt: Date.now(),
        models: merged,
      });
      if (previousIds !== nextIds) {
        this.onDidChangeLanguageModelChatInformationEmitter.fire();
      }
    } catch {
      // Offline or transient failure: keep serving the cached catalog.
    }
  }

  async configureApiKey(): Promise<void> {
    const saved = await this.authManager.promptForApiKey();
    if (saved) {
      void this.refreshModels();
      this.onDidChangeLanguageModelChatInformationEmitter.fire();
    }
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
          if (normalizeTemperatureValue(text) === undefined) {
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
    options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelChatInformation[]> {
    // Set through Add Models, VS Code collects the key against our `configuration`
    // contribution and passes it here (#14). Falling back to secret storage covers
    // users who configured via the "DeepSeek: Set API Key" command instead.
    let apiKey = (options as PrepareOptionsWithConfiguration).configuration?.apiKey;
    apiKey ||= await this.authManager.getApiKey();

    // Nothing to advertise without a key. VS Code calls us with silent=false when
    // the user is actively setting the provider up, which is when we may prompt.
    if (!apiKey) {
      if (options.silent) return [];
      if (!(await this.authManager.promptForApiKey())) return [];
      apiKey = await this.authManager.getApiKey();
      if (!apiKey) return [];
      void this.refreshModels();
    }

    // Inline completion is not a chat provider, so VS Code never hands it the
    // configured key. Share it rather than persisting a second copy.
    setProviderConfiguredApiKey(apiKey);

    return this.availableModels.map((model) => withApiKey(toChatInfo(model), apiKey));
  }

  async provideLanguageModelChatResponse(
    modelInfo: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    // The key rides on the model we handed back from provideLanguageModelChatInformation;
    // storage is only the fallback for command-configured users.
    const apiKey = (modelInfo as ModelWithApiKey).apiKey ?? (await this.authManager.getApiKey());
    if (!apiKey) {
      throw new Error(
        'DeepSeek API key not configured. Run "DeepSeek: Set API Key" from the Command Palette.',
      );
    }

    const baseUrl = this.authManager.getBaseUrl();
    const client = new DeepSeekClient(baseUrl, apiKey);

    const modelDef = this.availableModels.find((m) => m.id === modelInfo.id);
    if (!modelDef) throw new Error(`Unknown DeepSeek model: ${modelInfo.id}`);

    const isThinkingModel = modelDef.capabilities.thinking;
    const modelConfig = options as ModelConfigurationOptions;
    const thinkingEffort = getConfiguredThinkingEffort(modelConfig);
    const temperature = getConfiguredTemperature(modelConfig);

    const deepseekMessages = convertMessages(messages, isThinkingModel);
    const tools = modelDef.capabilities.toolCalling ? convertTools(options.tools) : undefined;
    const totalRequestChars = countMessageChars(deepseekMessages);

    const prefixShape = captureShape(deepseekMessages, tools);
    const shapeChanges = this.lastPrefixShape
      ? describeShapeChange(this.lastPrefixShape, prefixShape)
      : [];
    this.lastPrefixShape = prefixShape;

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

    const sessionId = crypto.randomUUID();
    const generationId = DeepSeekChatProvider.nextGenerationId++;
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
            if (isThinkingModel && accumulatedReasoning) {
              progress.report(
                createReasoningMarkerPart(
                  accumulatedReasoning,
                ) as unknown as vscode.LanguageModelResponsePart,
              );
            }
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
              `[${sessionId}] tokens: context=${usage.prompt_tokens} completion=${usage.completion_tokens}` +
                ` | cache: hit=${cacheHit} miss=${cacheMiss} rate=${hitRate}` +
                ` | temp=${temperature} chars/tok=${this.charsPerToken.toFixed(2)}` +
                (cacheHit === 0 && cacheMiss > 0
                  ? ` | MISS cause: ${shapeChanges.length ? shapeChanges.join(', ') : 'stable-prefix (tail growth or cache TTL)'}`
                  : ''),
            );

            reportCopilotContextUsage(progress, usage);
            this.onUsage?.({ sessionId, usage, generationId });
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

    return Math.max(1, Math.ceil(getMessageText(text).length / this.charsPerToken));
  }
}

function isValidModelDefinition(value: unknown): value is ModelDefinition {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m['id'] === 'string' &&
    typeof m['apiModel'] === 'string' &&
    typeof m['name'] === 'string' &&
    typeof m['family'] === 'string' &&
    typeof m['version'] === 'string' &&
    typeof m['maxInputTokens'] === 'number' &&
    typeof m['maxOutputTokens'] === 'number' &&
    !!m['capabilities'] &&
    typeof (m['capabilities'] as Record<string, unknown>)['toolCalling'] === 'boolean' &&
    typeof (m['capabilities'] as Record<string, unknown>)['imageInput'] === 'boolean' &&
    typeof (m['capabilities'] as Record<string, unknown>)['thinking'] === 'boolean'
  );
}

function loadCachedCatalog(context: vscode.ExtensionContext): ModelDefinition[] {
  try {
    const cached = context.globalState.get<{ savedAt?: unknown; models?: unknown }>(
      MODEL_CATALOG_CACHE_KEY,
    );
    if (cached && Array.isArray(cached.models)) {
      const models = cached.models.filter(isValidModelDefinition);
      if (models.length > 0) return models;
    }
  } catch {
    // Corrupt cache: fall through to known models.
  }
  return [...KNOWN_MODELS];
}

/**
 * Copilot Chat reads token usage off a data part with this MIME to drive the
 * context-window indicator. Without it the indicator never moves for a
 * third-party provider, and the chat is never summarised (#3).
 */
const COPILOT_USAGE_DATA_PART_MIME = 'usage';

function reportCopilotContextUsage(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  usage: DeepSeekUsage,
): void {
  const data = {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    prompt_tokens_details: {
      cached_tokens: usage.prompt_cache_hit_tokens ?? 0,
    },
  };

  try {
    progress.report(
      new vscode.LanguageModelDataPart(
        new TextEncoder().encode(JSON.stringify(data)),
        COPILOT_USAGE_DATA_PART_MIME,
      ) as unknown as vscode.LanguageModelResponsePart,
    );
  } catch (error) {
    logger.warn('Failed to report context usage', error);
  }
}

function withApiKey(info: ModelPickerChatInformation, apiKey: string): ModelWithApiKey {
  return { ...info, isBYOK: true, apiKey };
}

function toChatInfo(m: ModelDefinition): ModelPickerChatInformation {
  return {
    id: m.id,
    name: m.name,
    family: m.family,
    version: m.version,
    detail: m.detail,
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
