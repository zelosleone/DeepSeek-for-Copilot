import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

const LODESTAR = 'DenizhanDaklr.lodestar';
const LODESTAR_URL = 'https://marketplace.visualstudio.com/items?itemName=DenizhanDaklr.lodestar';
const DELAY_MS = 60_000;
const LOCK_MS = 600_000;
const MAX_IMPRESSIONS = 3;

interface Copy {
  message: (name: string) => string;
  install: string;
  view: string;
  dismiss: string;
}

const COPY: Record<string, Copy> = {
  zh: {
    message: (name) =>
      `${name} 的作者还开发了 Lodestar：在编辑器中逐步图解代码调用链、悬停解释任意符号并审查 Git 改动，直接复用当前扩展的模型。免费试用 3 次，之后仅需 $5 买断。`,
    install: '免费安装',
    view: '查看详情',
    dismiss: '不再提示',
  },
  tr: {
    message: (name) =>
      `${name} geliştiricisi Lodestar'ı da yaptı: Bu eklentinin modelleri dahil editörünüzdeki herhangi bir modelle kod akışını adım adım haritalar, üzerine gelinen kodu açıklar ve değişiklikleri inceler. 3 kullanım ücretsiz, sonrasında tek seferlik $5.`,
    install: 'Ücretsiz Kur',
    view: 'İncele',
    dismiss: 'Bir daha gösterme',
  },
  ru: {
    message: (name) =>
      `Разработчик ${name} также создал Lodestar: пошаговые карты кода, объяснения при наведении и код-ревью с любой моделью в редакторе, включая модели этого расширения. 3 запуска бесплатно, затем $5 навсегда.`,
    install: 'Установить бесплатно',
    view: 'Подробнее',
    dismiss: 'Больше не показывать',
  },
  en: {
    message: (name) =>
      `The developer of ${name} also made Lodestar: step-by-step codemaps, hover explanations, and code reviews on any model in your editor, including this extension's. 3 free runs included, then $5 one-time.`,
    install: 'Install Free',
    view: 'Take a look',
    dismiss: 'No thanks',
  },
};

function copyForLocale(): Copy {
  const lang = (vscode.env.language || 'en').toLowerCase().split('-')[0];
  return COPY[lang] ?? COPY.en;
}

export function scheduleLodestarNotice(context: vscode.ExtensionContext): void {
  const timer = setTimeout(() => void showLodestarNotice(context).catch(() => undefined), DELAY_MS);
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(timer)));
}

async function beginNotice(folder: string): Promise<number | undefined> {
  await mkdir(folder, { recursive: true });
  const done = await stat(path.join(folder, 'denizhandaklr.lodestar-notice-v2')).then(
    () => true,
    () => false,
  );
  if (done) return undefined;
  const lockPath = path.join(folder, 'denizhandaklr.lodestar-lock');
  const lockStat = await stat(lockPath).catch(() => undefined);
  if (lockStat && Date.now() - lockStat.mtimeMs < LOCK_MS) return undefined;
  const triesPath = path.join(folder, 'denizhandaklr.lodestar-tries-v2');
  const tries = Number(await readFile(triesPath, 'utf8').catch(() => '0')) || 0;
  if (tries >= MAX_IMPRESSIONS) return undefined;
  await writeFile(lockPath, String(Date.now()));
  await writeFile(triesPath, String(tries + 1));
  return tries + 1;
}

async function markDone(folder: string): Promise<void> {
  await writeFile(path.join(folder, 'denizhandaklr.lodestar-notice-v2'), '').catch(() => undefined);
}

async function openOrInstall(choice: string, copy: Copy): Promise<void> {
  if (choice === copy.install) {
    const installed = await vscode.commands
      .executeCommand('workbench.extensions.installExtension', LODESTAR)
      .then(
        () => true,
        () => false,
      );
    if (installed) {
      await vscode.commands
        .executeCommand('extension.open', LODESTAR)
        .then(undefined, () => undefined);
      return;
    }
  }
  await vscode.commands
    .executeCommand('extension.open', LODESTAR)
    .then(undefined, () => vscode.env.openExternal(vscode.Uri.parse(LODESTAR_URL)));
}

async function showLodestarNotice(context: vscode.ExtensionContext): Promise<void> {
  if (vscode.extensions.getExtension(LODESTAR)) return;
  const folder = path.dirname(context.globalStorageUri.fsPath);
  const attempt = await beginNotice(folder);
  if (!attempt) return;
  const name = (context.extension.packageJSON as { displayName: string }).displayName;
  const copy = copyForLocale();
  const choice = await vscode.window.showInformationMessage(
    copy.message(name),
    copy.install,
    copy.view,
    copy.dismiss,
  );
  if (!choice) {
    if (attempt >= MAX_IMPRESSIONS) await markDone(folder);
    return;
  }
  await markDone(folder);
  if (choice === copy.dismiss) return;
  await openOrInstall(choice, copy);
}
