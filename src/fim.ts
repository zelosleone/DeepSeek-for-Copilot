import * as vscode from 'vscode';
import { type AuthManager, getProviderConfiguredApiKey } from './auth.js';
import { logger } from './logger.js';

/**
 * FIM lives behind the /beta prefix. Note that prefix serves ONLY completions:
 * GET /beta/models is a 404, the model list is at /models.
 */
const FIM_PATH = '/beta/completions';

const MAX_PREFIX_CHARS = 4000;
const MAX_SUFFIX_CHARS = 1000;

interface FimResponse {
  choices?: Array<{ text?: string }>;
}

interface IndentOptions {
  insertSpaces?: boolean;
  tabSize?: number;
}

function indentWidth(line: string, tabSize: number): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += tabSize;
    else break;
  }
  return width;
}

/**
 * Keeps a completion from running past the block it started in. Copilot's
 * BlockTrimmer resolves the block boundary from a tree-sitter statement tree; that
 * needs a parser plus a WASM grammar per language, so the boundary here is
 * approximated by indentation. The blank-line and line-limit passes match theirs.
 */
function trimToBlock(
  completion: string,
  baseIndent: number,
  lineLimit: number,
  tabSize: number,
): string {
  const lines = completion.split('\n');

  // The first line continues the cursor's own line, so it has no indentation of
  // its own. From the second onwards, dedenting back to the cursor's level means
  // we have left the block and started a sibling.
  let end = lines.length;
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    if (indentWidth(lines[i], tabSize) <= baseIndent) {
      end = i;
      break;
    }
  }
  // Blank lines that merely separated us from the sibling we just cut.
  while (end > 1 && !lines[end - 1].trim()) end -= 1;
  let trimmed = lines.slice(0, end).join('\n');

  // Still too long: fall back to the last blank line that fits.
  if (trimmed.split('\n').length > lineLimit) {
    for (const match of [...trimmed.matchAll(/\r?\n\s*\r?\n/g)].reverse()) {
      const candidate = trimmed.slice(0, match.index);
      if (candidate.split('\n').length <= lineLimit) {
        trimmed = candidate;
        break;
      }
    }
  }

  // Hard cap.
  const capped = trimmed.split('\n');
  if (capped.length > lineLimit) trimmed = capped.slice(0, lineLimit).join('\n');

  // Never hand back nothing; a bad trim is worse than no trim.
  return trimmed.trim() ? trimmed : lines[0];
}

/**
 * The model indents with whatever it inferred from the prefix, which is not
 * necessarily what the editor is configured to use. Rewrites leading whitespace to
 * match, after Copilot's own `normalizeIndentCharacter`.
 */
function normalizeIndent(completion: string, options: IndentOptions): string {
  const indentSize = typeof options.tabSize === 'number' ? options.tabSize : 4;

  const replaceLeading = (unit: string, build: (count: number) => string): string =>
    completion
      .split('\n')
      .map((line) => {
        const trimmed = line.replace(new RegExp(`^(${unit})+`), '');
        return build(line.length - trimmed.length) + trimmed;
      })
      .join('\n');

  // Editor indents with tabs: fold runs of leading spaces into tabs.
  if (options.insertSpaces === false) {
    return replaceLeading(
      ' ',
      (n) => '\t'.repeat(Math.floor(n / indentSize)) + ' '.repeat(n % indentSize),
    );
  }

  // Editor indents with spaces: expand leading tabs.
  if (options.insertSpaces === true) {
    return replaceLeading('\\t', (n) => ' '.repeat(n * indentSize));
  }

  return completion;
}

/**
 * The model mirrors whatever separation the document already has, so when the text
 * after the cursor starts on the same line a multi-line completion welds onto it,
 * e.g. `return n * factorial(n-1)print(factorial(25))`. Guarantee a line break in
 * that case only; single-line completions and end-of-file are left untouched.
 */
function separateFromSuffix(completion: string, suffix: string): string {
  if (!completion.includes('\n')) return completion;
  if (suffix.length === 0) return completion;
  if (suffix.startsWith('\n') || suffix.startsWith('\r')) return completion;
  if (completion.endsWith('\n')) return completion;
  return `${completion}\n`;
}

function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export class DeepSeekInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly authManager: AuthManager;
  private warnedAboutMissingKey = false;

  constructor(authManager: AuthManager) {
    this.authManager = authManager;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const config = vscode.workspace.getConfiguration('deepseek');
    if (!config.get<boolean>('inlineCompletion.enabled', false)) return undefined;

    const apiKey = getProviderConfiguredApiKey() ?? (await this.authManager.getApiKey());
    if (!apiKey) {
      // This used to fail silently on every keystroke, which is very hard to
      // diagnose from the outside. Say it once.
      if (!this.warnedAboutMissingKey) {
        this.warnedAboutMissingKey = true;
        logger.warn(
          '[DeepSeek FIM] No API key available yet. Open Copilot Chat once so the provider resolves, or run "DeepSeek: Set API Key".',
        );
      }
      return undefined;
    }

    // VS Code asks on every keystroke; without this we would fire a request per
    // character at roughly a second each.
    await delay(config.get<number>('inlineCompletion.debounceMs', 300), token);
    if (token.isCancellationRequested) return undefined;

    const offset = document.offsetAt(position);
    const fullText = document.getText();
    const prefix = fullText.slice(Math.max(0, offset - MAX_PREFIX_CHARS), offset);
    const suffix = fullText.slice(offset, offset + MAX_SUFFIX_CHARS);

    if (!prefix.trim()) return undefined;

    const completion = await this.fetchCompletion(
      apiKey,
      config.get<string>('inlineCompletion.model', 'deepseek-v4-flash'),
      config.get<number>('inlineCompletion.maxTokens', 128),
      prefix,
      suffix,
      token,
    );

    if (!completion || token.isCancellationRequested) return undefined;

    const editorOptions = vscode.window.visibleTextEditors.find(
      (editor) => editor.document === document,
    )?.options;
    const tabSize = typeof editorOptions?.tabSize === 'number' ? editorOptions.tabSize : 4;

    const indented = normalizeIndent(completion, {
      insertSpaces:
        typeof editorOptions?.insertSpaces === 'boolean' ? editorOptions.insertSpaces : undefined,
      tabSize: typeof editorOptions?.tabSize === 'number' ? editorOptions.tabSize : undefined,
    });

    const trimmed = trimToBlock(
      indented,
      indentWidth(document.lineAt(position.line).text, tabSize),
      config.get<number>('inlineCompletion.maxLines', 10),
      tabSize,
    );

    return [
      new vscode.InlineCompletionItem(
        separateFromSuffix(trimmed, suffix),
        new vscode.Range(position, position),
      ),
    ];
  }

  private async fetchCompletion(
    apiKey: string,
    model: string,
    maxTokens: number,
    prefix: string,
    suffix: string,
    token: vscode.CancellationToken,
  ): Promise<string | undefined> {
    const controller = new AbortController();
    const cancelListener = token.onCancellationRequested(() => controller.abort());

    try {
      const response = await fetch(`${this.authManager.getBaseUrl()}${FIM_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          prompt: prefix,
          suffix,
          max_tokens: maxTokens,
          temperature: 0,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.error(`[DeepSeek FIM] HTTP ${response.status}:`, await response.text());
        return undefined;
      }

      const body = (await response.json()) as FimResponse;
      return body.choices?.[0]?.text || undefined;
    } catch (error) {
      // Aborts are the normal outcome of typing another character.
      if (!(error instanceof Error && error.name === 'AbortError')) {
        logger.error('[DeepSeek FIM] request failed', error);
      }
      return undefined;
    } finally {
      cancelListener.dispose();
    }
  }
}
