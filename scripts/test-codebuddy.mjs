import { _electron as electron, expect } from '@playwright/test';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createFixtures } from '../test/fixtures.mjs';

const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const executable = process.env.CODEBUDDY_EXECUTABLE || path.join(localAppData, 'Programs', 'CodeBuddy CN', 'CodeBuddy CN.exe');
const root = path.resolve('.test-data/ide');
await mkdir(path.join(root, 'profile', 'User'), { recursive: true });
await mkdir(path.join(root, 'fixtures'), { recursive: true });
await writeFile(path.join(root, 'profile', 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'security.workspace.trust.enabled': false,
  'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off',
  'workbench.colorTheme': 'Default Dark Modern', 'window.titleBarStyle': 'custom',
}));
const fixtureRoot = await createFixtures();
for (const [source, destination] of [['demo.txt', '星海样例.txt'], ['demo.epub', '星海来信.epub'], ['demo.pdf', '离线阅读.pdf']]) {
  await copyFile(path.join(fixtureRoot, source), path.join(root, 'fixtures', destination));
}
await build({ entryPoints: ['test/ideRunner.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'], outfile: '.test-data/ide/runner.cjs' });

async function launch() {
  await rm(path.join(root, 'ready.json'), { force: true });
  await rm(path.join(root, 'finish'), { force: true });
  const env = { ...process.env, VSREAD_TEST_ROOT: root };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: executable, args: [
    '--no-sandbox', '--disable-gpu', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
    `--user-data-dir=${path.join(root, 'profile')}`, `--extensions-dir=${path.join(root, 'extensions')}`,
    `--extensionDevelopmentPath=${path.resolve('.')}`, `--extensionTestsPath=${path.join(root, 'runner.cjs')}`,
  ], env, timeout: 60_000 });
  await expect.poll(async () => { try { return JSON.parse(await readFile(path.join(root, 'ready.json'), 'utf8')); } catch { return null; } }, { timeout: 60_000 }).toBeTruthy();
  let frame;
  await expect.poll(async () => {
    for (const window of app.windows()) for (const candidate of window.frames()) {
      if (await candidate.locator('.app-header').count().catch(() => 0)) { frame = candidate; return true; }
    }
    return false;
  }, { timeout: 30_000 }).toBe(true);
  return { app, get frame() { return frame; } };
}

let session;
const errors = [];
try {
  session = await launch();
  const f = session.frame;
  f.page().on('pageerror', error => errors.push(error.message));
  console.log('真实 CodeBuddy Webview 已打开');
  await expect(f.locator('canvas[aria-label="第 1 页"]')).toBeVisible({ timeout: 30_000 });
  await f.getByRole('button', { name: '下一页', exact: true }).click();
  await expect(f.locator('canvas[aria-label="第 2 页"]')).toBeVisible();
  await expect(f.locator('.textLayer')).toContainText('VSRead - Page 2');
  await expect(f.locator('.save-indicator')).toContainText('进度已保存');
  await f.getByRole('button', { name: '我的书架', exact: true }).click();
  await f.getByRole('button', { name: '阅读 星海样例', exact: true }).click();
  await expect(f.locator('.txt-content')).toContainText('第一章 星海');
  await f.getByRole('button', { name: '第二章 远航', exact: true }).click();
  await expect(f.locator('.txt-content')).toContainText('第二章 远航');
  await expect(f.locator('.save-indicator')).toContainText('进度已保存');
  await f.getByRole('button', { name: '我的书架', exact: true }).click();
  await f.getByRole('button', { name: '阅读 星海来信', exact: true }).click();
  const epub = f.frameLocator('.epub-surface iframe');
  await expect(epub.locator('h1')).toHaveText('第一章 星海', { timeout: 20_000 });
  await expect(epub.locator('h1')).toHaveCSS('color', 'rgb(30, 120, 90)');
  await expect.poll(() => epub.locator('img').evaluate(image => image.naturalWidth)).toBeGreaterThan(0);
  await f.getByRole('button', { name: '第二章 远航', exact: true }).click();
  await expect(epub.locator('h1')).toHaveText('第二章 远航');
  await expect(f.locator('.save-indicator')).toContainText('进度已保存');
  await expect(f.getByRole('alert')).toHaveCount(0);
  await f.page().screenshot({ path: path.join(root, 'codebuddy-reader.png') });
  const info = JSON.parse(await readFile(path.join(root, 'ready.json'), 'utf8'));
  await session.app.close(); session = undefined;
  console.log('第一轮三种格式通过，正在重启 IDE 验证恢复');
  session = await launch();
  const restored = session.frame;
  await expect(restored.frameLocator('.epub-surface iframe').locator('h1')).toHaveText('第二章 远航', { timeout: 20_000 });
  await restored.getByRole('button', { name: '我的书架', exact: true }).click();
  await restored.getByRole('button', { name: '阅读 星海样例', exact: true }).click();
  await expect(restored.locator('.txt-content')).toContainText('第二章 远航');
  await restored.getByRole('button', { name: '我的书架', exact: true }).click();
  await restored.getByRole('button', { name: '阅读 离线阅读', exact: true }).click();
  await expect(restored.locator('canvas[aria-label="第 2 页"]')).toBeVisible();
  await expect(restored.getByRole('alert')).toHaveCount(0);
  await writeFile(path.join(root, 'report.json'), JSON.stringify({ passed: true, vscodeVersion: info.version, formats: ['TXT', 'EPUB', 'PDF'], restartRestored: true, errors }, null, 2));
  console.log('CodeBuddy 三种格式渲染及 IDE 重启恢复全部通过');
} catch (error) {
  if (session) {
    console.log('窗口与 Frames', session.app.windows().map(window => ({ url: window.url(), frames: window.frames().map(frame => frame.url()) })));
    await session.app.windows()[0]?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    console.log('Webview DOM', await session.frame?.locator('body').innerText().catch(() => 'unavailable'));
  }
  throw error;
} finally { if (session) await session.app.close().catch(() => {}); }
