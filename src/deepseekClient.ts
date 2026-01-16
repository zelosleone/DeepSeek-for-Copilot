import type { CancellationToken } from 'vscode';

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
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  tools?: DeepSeekTool[];
  tool_choice?: 'none' | 'auto' | 'required';
}

export interface DeepSeekStreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
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
}

export interface StreamCallbacks {
  onContent: (content: string) => void;
  onReasoningContent?: (content: string) => void;
  onToolCall: (toolCall: DeepSeekToolCall) => void;
  onError: (error: Error) => void;
  onDone: () => void;
}

export class DeepSeekClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  /**
   * Stream chat completion from DeepSeek API
   */
  async streamChatCompletion(
    request: DeepSeekRequest,
    callbacks: StreamCallbacks,
    cancellationToken?: CancellationToken,
  ): Promise<void> {
    const controller = new AbortController();

    const cancelListener = cancellationToken?.onCancellationRequested(() => {
      controller.abort();
    });

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
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage: string;

        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.message || errorText;
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

      const pendingToolCalls = new Map<number, DeepSeekToolCall>();

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

        for (const line of lines) {
          const trimmed = line.trim();

          if (!trimmed || trimmed.startsWith(':')) {
            continue;
          }

          if (trimmed === 'data: [DONE]') {
            for (const toolCall of pendingToolCalls.values()) {
              callbacks.onToolCall(toolCall);
            }
            callbacks.onDone();
            return;
          }

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);

            try {
              const chunk: DeepSeekStreamChunk = JSON.parse(jsonStr);
              const choice = chunk.choices[0];

              if (!choice) continue;

              if (choice.delta.reasoning_content) {
                callbacks.onReasoningContent?.(choice.delta.reasoning_content);
              }

              if (choice.delta.content) {
                callbacks.onContent(choice.delta.content);
              }

              if (choice.delta.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  let pending = pendingToolCalls.get(tc.index);

                  if (!pending && tc.id) {
                    pending = {
                      id: tc.id,
                      type: 'function',
                      function: {
                        name: '',
                        arguments: '',
                      },
                    };
                    pendingToolCalls.set(tc.index, pending);
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

              if (choice.finish_reason === 'tool_calls') {
                for (const toolCall of pendingToolCalls.values()) {
                  callbacks.onToolCall(toolCall);
                }
                pendingToolCalls.clear();
              }
            } catch (e) {
              // eslint-disable-next-line no-console
              console.error('Failed to parse chunk:', jsonStr, e);
            }
          }
        }
      }

      callbacks.onDone();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        callbacks.onDone();
        return;
      }
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      cancelListener?.dispose();
    }
  }
}
