import * as vscode from 'vscode';
import { DeepSeekChatProvider } from './provider.js';

export function activate(context: vscode.ExtensionContext) {
  const provider = new DeepSeekChatProvider(context);

  const providerDisposable = vscode.lm.registerLanguageModelChatProvider('deepseek', provider);

  const commandDisposable = vscode.commands.registerCommand('deepseek.setApiKey', () =>
    provider.configureApiKey(),
  );

  context.subscriptions.push(providerDisposable, commandDisposable);

  // eslint-disable-next-line no-console
  console.log('DeepSeek extension activated');
}

export function deactivate() {
  // eslint-disable-next-line no-console
  console.log('DeepSeek extension deactivated');
}
