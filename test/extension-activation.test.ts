import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
async function scenario(name: string): Promise<Record<string, unknown>> {
  const fixture = path.resolve('test/fixtures/activation-host.cjs');
  try {
    const { stdout } = await run(process.execPath, [fixture, name], { cwd: path.resolve('.'), timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
    return JSON.parse(stdout.trim().split('\n').at(-1)!);
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    assert.fail(`${name} 原生宿主回归失败：${failure.message}\n${failure.stderr ?? ''}\n${failure.stdout ?? ''}`);
  }
}

test('显式onView冷启动注册真实侧栏provider并打开Webview', async () => {
  const result = await scenario('view');
  assert.equal(result.event, `onView:${result.view}`);
  assert.equal(result.html, true);
});

test('显式onCommand冷启动可执行打开阅读器命令', async () => {
  const result = await scenario('command');
  assert.equal(result.event, 'onCommand:vsread.open');
  assert.equal(result.html, true);
});

test('本地索引和备份损坏仍保留侧栏及日志，禁止导入覆盖原数据', async () => {
  const result = await scenario('damaged-local');
  assert.equal(result.localBlocked, true);
});

test('在线索引损坏不阻止本地书库初始化和侧栏注册', async () => {
  const result = await scenario('damaged-online');
  assert.equal(result.onlineIsolated, true);
});
