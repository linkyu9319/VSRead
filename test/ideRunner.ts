import * as vscode from 'vscode';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 仅在独立测试 profile 中运行，不包含在 VSIX 中。 */
export async function run(): Promise<void> {
  const root = process.env.VSREAD_TEST_ROOT;
  if (!root) throw new Error('缺少测试目录');
  const extension = vscode.extensions.getExtension('vsread-local.vsread');
  if (!extension) throw new Error('VSRead 未安装到测试 Extension Host');
  await extension.activate();
  const stateFile = path.join(root, 'profile', 'User', 'globalStorage', 'vsread-local.vsread', 'library.json');
  let hasBooks = false;
  try { hasBooks = JSON.parse(await readFile(stateFile, 'utf8')).books.length === 3; } catch { /* 首次运行时书架为空。 */ }
  if (!hasBooks) {
    for (const filename of ['星海样例.txt', '星海来信.epub', '离线阅读.pdf']) {
      await vscode.commands.executeCommand('vsread.import', vscode.Uri.file(path.join(root, 'fixtures', filename)));
    }
  }
  await vscode.commands.executeCommand('vsread.open');
  await writeFile(path.join(root, 'ready.json'), JSON.stringify({ version: vscode.version, stateFile }), 'utf8');
  await new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      void readFile(path.join(root, 'finish')).then(() => { clearInterval(timer); resolve(); }).catch(() => {
        if (Date.now() - start > 180_000) { clearInterval(timer); reject(new Error('IDE 验证超时')); }
      });
    }, 300);
  });
}
