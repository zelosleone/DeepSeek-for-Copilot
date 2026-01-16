import * as vscode from 'vscode';

const API_KEY_SECRET = 'deepseek.apiKey';

export class AuthManager {
  private readonly secretStorage: vscode.SecretStorage;

  constructor(context: vscode.ExtensionContext) {
    this.secretStorage = context.secrets;
  }

  /**
   * Get API key from SecretStorage first, then fallback to settings
   */
  async getApiKey(): Promise<string | undefined> {
    const secretKey = await this.secretStorage.get(API_KEY_SECRET);
    if (secretKey) {
      return secretKey;
    }

    const config = vscode.workspace.getConfiguration('deepseek');
    const settingsKey = config.get<string>('apiKey');
    if (settingsKey && settingsKey.trim()) {
      return settingsKey.trim();
    }

    return undefined;
  }

  /**
   * Store API key securely in SecretStorage
   */
  async setApiKey(apiKey: string): Promise<void> {
    await this.secretStorage.store(API_KEY_SECRET, apiKey);
  }

  /**
   * Delete API key from SecretStorage
   */
  async deleteApiKey(): Promise<void> {
    await this.secretStorage.delete(API_KEY_SECRET);
  }

  /**
   * Check if API key is configured
   */
  async hasApiKey(): Promise<boolean> {
    const key = await this.getApiKey();
    return key !== undefined && key.length > 0;
  }

  /**
   * Prompt user to enter API key via input box
   */
  async promptForApiKey(): Promise<boolean> {
    const apiKey = await vscode.window.showInputBox({
      prompt: 'Enter your DeepSeek API key',
      placeHolder: 'sk-...',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        if (!value || !value.trim()) {
          return 'API key cannot be empty';
        }
        if (!value.startsWith('sk-')) {
          return 'API key should start with "sk-"';
        }
        return undefined;
      },
    });

    if (apiKey) {
      await this.setApiKey(apiKey.trim());
      vscode.window.showInformationMessage('DeepSeek API key saved successfully');
      return true;
    }

    return false;
  }

  /**
   * Get base URL from settings
   */
  getBaseUrl(): string {
    const config = vscode.workspace.getConfiguration('deepseek');
    return config.get<string>('baseUrl') || 'https://api.deepseek.com';
  }
}
