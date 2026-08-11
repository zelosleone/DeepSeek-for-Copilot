import * as vscode from 'vscode';
import { type AuthManager, getProviderConfiguredApiKey } from './auth.js';
import { logger } from './logger.js';
import { trimToBlockWithTreeSitter } from './treeSitter.js';

/**
 * FIM lives behind the /beta prefix. Note that prefix serves ONLY completions:
 * GET /beta/models is a 404, the model list is at /models.
 */
const FIM_PATH = '/beta/completions';

const MAX_PREFIX_CHARS = 4000;
const MAX_SUFFIX_CHARS = 1000;

/**
 * How coarsely the prefix window start is snapped. DeepSeek reuses its prompt cache
 * by common leading prefix, so a window that slides with the cursor never matches:
 * every keystroke moves the start and the whole prompt is re-billed at the miss
 * rate. Snapping the start keeps it byte-identical for this many characters of
 * typing, at the cost of sending up to that many extra characters.
 */
const PREFIX_ANCHOR_CHARS = 2000;

function anchoredPrefixStart(offset: number): number {
  const rawStart = offset - MAX_PREFIX_CHARS;
  if (rawStart <= 0) return 0;
  return Math.floor(rawStart / PREFIX_ANCHOR_CHARS) * PREFIX_ANCHOR_CHARS;
}

interface FimResponse {
  choices?: Array<{ text?: string }>;
}

interface IndentOptions {
  insertSpaces?: boolean;
  tabSize?: number;
}

/**
 * Splits a statement the model welded onto the same line as an opening brace, e.g.
 * `if (x) {    await save();`. A deliberate one-liner uses a single space
 * (`{ return; }`), so a run of two or more spaces after `{` is a dropped newline,
 * and those spaces are the indentation the next line was meant to have.
 */
function unweldBraces(completion: string): string {
  return completion.replace(/\{( {2,})(?=\S)/g, '{\n$1');
}

/** Hard bound on suggestion size, independent of any block analysis. */
function capLines(completion: string, lineLimit: number): string {
  const lines = completion.split('\n');
  return lines.length <= lineLimit ? completion : lines.slice(0, lineLimit).join('\n');
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
  private readonly extensionUri: vscode.Uri;
  private warnedAboutMissingKey = false;

  constructor(authManager: AuthManager, extensionUri: vscode.Uri) {
    this.authManager = authManager;
    this.extensionUri = extensionUri;
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
    const windowStart = anchoredPrefixStart(offset);
    const suffix = fullText.slice(offset, offset + MAX_SUFFIX_CHARS);

    const prefix = fullText.slice(windowStart, offset);

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

    // The model often ends a suggestion with newlines. Accepting that inserts blank
    // lines, and the newline the user then types adds another. separateFromSuffix
    // puts one back only in the narrow case where it is needed to avoid a weld.
    const trimmedTail = unweldBraces(completion).replace(/\s+$/, '');
    if (!trimmedTail) return undefined;

    const editorOptions = vscode.window.visibleTextEditors.find(
      (editor) => editor.document === document,
    )?.options;

    const indented = normalizeIndent(trimmedTail, {
      insertSpaces:
        typeof editorOptions?.insertSpaces === 'boolean' ? editorOptions.insertSpaces : undefined,
      tabSize: typeof editorOptions?.tabSize === 'number' ? editorOptions.tabSize : undefined,
    });

    // Where a grammar is vendored the block boundary comes from the parse tree.
    // Where it is not, the suggestion is simply left whole rather than guessed at.
    const astTrimmed = await trimToBlockWithTreeSitter(
      document.languageId,
      prefix,
      indented,
      (name) =>
        Promise.resolve(
          vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.extensionUri, 'wasm', name)),
        ),
    );
    if (token.isCancellationRequested) return undefined;

    const trimmed = capLines(
      astTrimmed ?? indented,
      config.get<number>('inlineCompletion.maxLines', 10),
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
