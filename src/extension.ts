import * as vscode from 'vscode';
import { AuthManager } from './auth.js';
import { DeepSeekInlineCompletionProvider } from './fim.js';
import { logger } from './logger.js';
import { DeepSeekChatProvider, type SessionUsageInfo } from './provider/index.js';

function updateStatusBar(item: vscode.StatusBarItem, usage: SessionUsageInfo | undefined): void {
  if (!usage) {
    item.hide();
    return;
  }

  const ctx = usage.usage.prompt_tokens.toLocaleString();
  const total = usage.usage.total_tokens.toLocaleString();
  item.text = `DeepSeek: $(database) ${ctx} tok`;
  item.tooltip = [
    `Context: ${ctx} tokens`,
    `Completion: ${usage.usage.completion_tokens.toLocaleString()}`,
    `Total: ${total} tokens`,
    `Cache hit: ${(usage.usage.prompt_cache_hit_tokens ?? 0).toLocaleString()}`,
    `Cache miss: ${(usage.usage.prompt_cache_miss_tokens ?? 0).toLocaleString()}`,
  ].join('\n');
  item.show();
}

export function activate(context: vscode.ExtensionContext) {
  logger.info('Activating extension');

  let usageStatusBarItem: vscode.StatusBarItem | undefined;
  let lastVisibleGenerationId = -1;

  function onTabOrEditorChange(): void {
    if (!usageStatusBarItem) return;

    lastVisibleGenerationId = Infinity;
    usageStatusBarItem.hide();
  }

  try {
    usageStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    usageStatusBarItem.command = 'deepseek.showLogs';

    const provider = new DeepSeekChatProvider(context, (info: SessionUsageInfo) => {
      if (!usageStatusBarItem) return;

      if (info.generationId > lastVisibleGenerationId) {
        updateStatusBar(usageStatusBarItem, info);
      }
    });

    context.subscriptions.push(
      usageStatusBarItem,
      vscode.window.tabGroups.onDidChangeTabs(onTabOrEditorChange),
      vscode.window.onDidChangeActiveTextEditor(onTabOrEditorChange),
      vscode.commands.registerCommand('deepseek.setApiKey', () => provider.configureApiKey()),
      vscode.commands.registerCommand('deepseek.setTemperature', () =>
        provider.configureTemperature(),
      ),
      vscode.commands.registerCommand('deepseek.clearApiKey', () => provider.clearApiKey()),
      vscode.commands.registerCommand('deepseek.showLogs', () => logger.show()),
      vscode.commands.registerCommand('deepseek.toggleInlineCompletion', async () => {
        const config = vscode.workspace.getConfiguration('deepseek');
        const enabled = !config.get<boolean>('inlineCompletion.enabled', false);
        await config.update('inlineCompletion.enabled', enabled, true);
        vscode.window.showInformationMessage(
          `DeepSeek inline completion ${enabled ? 'enabled' : 'disabled'}.`,
        );
      }),
      vscode.commands.registerCommand('deepseek.openSettings', () =>
        vscode.commands.executeCommand('workbench.action.openSettings', 'deepseek.'),
      ),
      vscode.lm.registerLanguageModelChatProvider('deepseek', provider),
      vscode.languages.registerInlineCompletionItemProvider(
        { pattern: '**' },
        new DeepSeekInlineCompletionProvider(new AuthManager(context)),
      ),
    );

    logger.info('Extension activated');
  } catch (error) {
    usageStatusBarItem?.dispose();
    logger.error('Failed to activate DeepSeek extension', error);
    void vscode.window.showErrorMessage(
      'DeepSeek failed to activate. Run "DeepSeek: Show Logs" for details.',
    );
    throw error;
  }
}

export async function deactivate(): Promise<void> {
  try {
    logger.info('Extension deactivated');
  } catch {
    // VS Code may dispose the output channel before calling deactivate.
  }
  logger.dispose();
}
