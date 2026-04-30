import * as vscode from 'vscode';
import { logger } from './logger.js';
import { DeepSeekChatProvider } from './provider/index.js';

function formatTokenCount(value: number): string {
  return value.toLocaleString();
}

export function activate(context: vscode.ExtensionContext) {
  logger.info('Activating extension');

  let usageStatusBarItem: vscode.StatusBarItem | undefined;

  try {
    usageStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    usageStatusBarItem.command = 'deepseek.showLogs';

    const provider = new DeepSeekChatProvider(context, (usage) => {
      if (!usageStatusBarItem) return;

      const ctx = formatTokenCount(usage.prompt_tokens);
      const total = formatTokenCount(usage.total_tokens);
      usageStatusBarItem.text = `DeepSeek: $(database) ${ctx} tok`;
      usageStatusBarItem.tooltip = [
        `Context: ${ctx} tokens`,
        `Completion: ${formatTokenCount(usage.completion_tokens)}`,
        `Total: ${total} tokens`,
        `Cache hit: ${formatTokenCount(usage.prompt_cache_hit_tokens ?? 0)}`,
        `Cache miss: ${formatTokenCount(usage.prompt_cache_miss_tokens ?? 0)}`,
      ].join('\n');
      usageStatusBarItem.show();
    });

    context.subscriptions.push(
      usageStatusBarItem,
      vscode.commands.registerCommand('deepseek.setApiKey', () => provider.configureApiKey()),
      vscode.commands.registerCommand('deepseek.setTemperature', () =>
        provider.configureTemperature(),
      ),
      vscode.commands.registerCommand('deepseek.clearApiKey', () => provider.clearApiKey()),
      vscode.commands.registerCommand('deepseek.showLogs', () => logger.show()),
      vscode.lm.registerLanguageModelChatProvider('deepseek', provider),
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

export async function deactivate() {
  try {
    logger.info('Extension deactivated');
    logger.dispose();
  } catch {
    /* cleanup */
  }
}
