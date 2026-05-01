import type { CancellationToken } from 'vscode';
import { logger } from './logger.js';

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: DeepSeekToolCall[];
  reasoning_content?: string;
}

export interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface DeepSeekRequest {
  model: string;
  messages: DeepSeekMessage[];
  stream?: boolean;
  thinking?: {
    type: 'enabled' | 'disabled';
  };
  reasoning_effort?: 'high' | 'max';
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: DeepSeekTool[];
  tool_choice?: 'none' | 'auto' | 'required';
  stream_options?: {
    include_usage: boolean;
  };
}

export interface DeepSeekStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: DeepSeekUsage;
}

export interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface StreamCallbacks {
  onContent: (content: string) => void;
  onReasoningContent?: (content: string) => void;
  onThinking?: (text: string) => void;
  onToolCall: (toolCall: DeepSeekToolCall) => void;
  onError: (error: Error) => void;
  onDone: () => void;
  onUsage?: (usage: DeepSeekUsage) => void;
}

type DeepSeekSseState = {
  pendingToolCalls: Map<number, DeepSeekToolCall>;
};

function flushPendingToolCalls(
  pendingToolCalls: Map<number, DeepSeekToolCall>,
  onToolCall: StreamCallbacks['onToolCall'],
): void {
  for (const toolCall of pendingToolCalls.values()) {
    onToolCall(toolCall);
  }
  pendingToolCalls.clear();
}

function processDeepSeekSseLines(
  lines: readonly string[],
  state: DeepSeekSseState,
  callbacks: Pick<
    StreamCallbacks,
    'onContent' | 'onReasoningContent' | 'onThinking' | 'onToolCall' | 'onDone' | 'onUsage'
  >,
): boolean {
  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith(':')) {
      continue;
    }

    if (trimmed === 'data: [DONE]') {
      flushPendingToolCalls(state.pendingToolCalls, callbacks.onToolCall);
      callbacks.onDone();
      return true;
    }

    if (trimmed.startsWith('data: ')) {
      const jsonStr = trimmed.slice(6);

      try {
        const chunk: DeepSeekStreamChunk = JSON.parse(jsonStr);

        if (chunk.usage) {
          callbacks.onUsage?.(chunk.usage);
        }

        if (!chunk.choices || chunk.choices.length === 0) {
          continue;
        }

        const delta = chunk.choices[0].delta;
        if (delta) {
          if (delta.reasoning_content) {
            callbacks.onReasoningContent?.(delta.reasoning_content);
            callbacks.onThinking?.(delta.reasoning_content);
          }

          if (delta.content) {
            callbacks.onContent(delta.content);
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              let pending = state.pendingToolCalls.get(tc.index);

              if (!pending && tc.id) {
                pending = {
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: '',
                    arguments: '',
                  },
                };
                state.pendingToolCalls.set(tc.index, pending);
              }

              if (pending) {
                if (tc.function?.name) {
                  pending.function.name += tc.function.name;
                }
                if (tc.function?.arguments) {
                  pending.function.arguments += tc.function.arguments;
                }
              }
            }
          }
        }

        if (chunk.choices[0].finish_reason === 'tool_calls') {
          flushPendingToolCalls(state.pendingToolCalls, callbacks.onToolCall);
        }
      } catch (e) {
        if (e instanceof SyntaxError) {
          logger.error('Failed to parse SSE chunk:', jsonStr.slice(0, 200), e);
        } else {
          throw e;
        }
      }
    }
  }

  return false;
}

export class DeepSeekClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  async streamChatCompletion(
    request: DeepSeekRequest,
    callbacks: StreamCallbacks,
    cancellationToken?: CancellationToken,
  ): Promise<void> {
    const controller = new AbortController();

    const cancelListener = cancellationToken?.onCancellationRequested(() => {
      controller.abort();
    });

    let streamTerminatedByDone = false;

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          ...request,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[DeepSeek] HTTP ${response.status}:`, errorText);

        let errorMessage: string;

        try {
          const errorJson = JSON.parse(errorText) as {
            error?: { message?: string };
            message?: string;
          };
          errorMessage = errorJson.error?.message ?? errorJson.message ?? errorText;
        } catch {
          errorMessage = errorText;
        }

        throw new Error(`DeepSeek API error (${response.status}): ${errorMessage}`);
      }

      if (!response.body) {
        throw new Error('No response body received');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const MAX_BUFFER_SIZE = 1_000_000;

      const sseState: DeepSeekSseState = {
        pendingToolCalls: new Map<number, DeepSeekToolCall>(),
      };

      const progressCallbacks: Parameters<typeof processDeepSeekSseLines>[2] = {
        onContent: callbacks.onContent,
        onReasoningContent: callbacks.onReasoningContent,
        onThinking: callbacks.onThinking,
        onToolCall: callbacks.onToolCall,
        onUsage: callbacks.onUsage,
        onDone: () => {
          if (streamTerminatedByDone) {
            return;
          }
          streamTerminatedByDone = true;
          callbacks.onDone();
        },
      };

      while (true) {
        if (cancellationToken?.isCancellationRequested) {
          controller.abort();
          break;
        }

        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        if (buffer.length > MAX_BUFFER_SIZE) {
          throw new Error(
            `Streaming buffer exceeded maximum size (${MAX_BUFFER_SIZE} bytes). Possible malformed stream.`,
          );
        }

        processDeepSeekSseLines(lines, sseState, progressCallbacks);
      }

      buffer += decoder.decode();

      if (buffer) {
        const tailLines = buffer.split('\n');
        processDeepSeekSseLines(tailLines, sseState, progressCallbacks);
      }

      const cancelledEarly = cancellationToken?.isCancellationRequested === true;

      if (cancelledEarly) {
        if (!streamTerminatedByDone) {
          callbacks.onDone();
        }
      } else if (!streamTerminatedByDone) {
        flushPendingToolCalls(sseState.pendingToolCalls, callbacks.onToolCall);
        callbacks.onDone();
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        if (!streamTerminatedByDone) {
          callbacks.onDone();
        }
        return;
      }
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      cancelListener?.dispose();
    }
  }
}
