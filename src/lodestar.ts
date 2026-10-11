import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const LODESTAR = 'DenizhanDaklr.lodestar';
const LODESTAR_URL = 'https://marketplace.visualstudio.com/items?itemName=DenizhanDaklr.lodestar';
const DELAY_MS = 90_000;

// Mentions Lodestar once per machine. My other extensions share the marker file next to their
// storage folders, so someone with several of them installed still sees it only once.
export function scheduleLodestarNotice(context: vscode.ExtensionContext): void {
  const timer = setTimeout(() => void showLodestarNotice(context).catch(() => undefined), DELAY_MS);
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(timer)));
}

async function claimNotice(context: vscode.ExtensionContext): Promise<boolean> {
  const folder = path.dirname(context.globalStorageUri.fsPath);
  await mkdir(folder, { recursive: true });
  return writeFile(path.join(folder, 'denizhandaklr.lodestar-notice'), '', { flag: 'wx' }).then(
    () => true,
    () => false,
  );
}

async function showLodestarNotice(context: vscode.ExtensionContext): Promise<void> {
  const inVsCode = vscode.env.appName.includes('Visual Studio Code');
  if (!inVsCode || vscode.extensions.getExtension(LODESTAR) || !(await claimNotice(context))) return;
  const name = (context.extension.packageJSON as { displayName: string }).displayName;
  const action = 'Take a look';
  const choice = await vscode.window.showInformationMessage(
    `The developer of ${name} also made Lodestar. It walks you through how code works and reviews your changes, on any model in VS Code, including this extension's. $10, one time.`,
    action,
  );
  if (choice !== action) return;
  await vscode.commands
    .executeCommand('extension.open', LODESTAR)
    .then(undefined, () => vscode.env.openExternal(vscode.Uri.parse(LODESTAR_URL)));
}
