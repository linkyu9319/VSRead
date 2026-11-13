import test from 'node:test';
import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { compareVersions, releaseStatus, UpdateService, RELEASES_URL } from '../src/extension/updates';

test('版本比较遵循 SemVer 数字、预发布及构建元数据顺序', () => {
  assert.equal(compareVersions('v1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.2'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.2'), 1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(compareVersions('1.0.0+one', '1.0.0+two'), 0);
  assert.equal(compareVersions('01.0.0', '1.0.0'), undefined);
  assert.equal(compareVersions('1.0.0-01', '1.0.0'), undefined);
});

test('Release 仅接受正式版本，状态和发布链接不受任意 URL 影响', () => {
  const release = (version: string, extra = {}) => ({ status: 200, body: JSON.stringify({ tag_name: version, draft: false, prerelease: false, html_url: 'https://evil.example/installer', ...extra }) });
  const available = releaseStatus('0.1.2', release('v0.2.0'), false);
  assert.equal(available.state, 'available');
  assert.equal(available.releaseUrl, `${RELEASES_URL}/tag/v0.2.0`);
  assert.equal(releaseStatus('0.2.0', release('v0.2.0'), false).state, 'current');
  assert.equal(releaseStatus('0.3.0', release('v0.2.0'), false).state, 'current');
  assert.equal(releaseStatus('0.1.2', release('v0.2.0-beta.1'), false).state, 'unavailable');
  assert.equal(releaseStatus('0.1.2', release('v0.2.0', { draft: true }), false).state, 'unavailable');
  assert.equal(releaseStatus('0.1.2', { status: 200, body: 'not-json' }, false).state, 'unavailable');
});

test('无发布、私有无权、认证失败和限流不误报已是最新', () => {
  for (const status of [401, 403, 404, 429, 500, 302]) assert.equal(releaseStatus('0.1.2', { status, body: '' }, false).state, 'unavailable');
  assert.match(releaseStatus('0.1.2', { status: 404, body: '' }, false).message, /私有/);
  assert.match(releaseStatus('0.1.2', { status: 404, body: '' }, true).message, /读取权限/);
});

test('令牌保留在 SecretStorage、检查可复用且打开固定仓库页面', async () => {
  const secrets = new Map<string, string>();
  const context = {
    extension: { packageJSON: { version: '0.1.2' } },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => { secrets.set(key, value); },
      delete: async (key: string) => { secrets.delete(key); },
    },
  } as unknown as vscode.ExtensionContext;
  let calls = 0;
  let opened = '';
  const updates = new UpdateService(context, {
    inputToken: async () => '  test-token  ',
    request: async token => { calls++; assert.equal(token, 'test-token'); return { status: 200, body: '{"tag_name":"v0.2.0"}' }; },
    openExternal: async url => { opened = url; return true; },
  });
  await updates.auth('set');
  const statuses = await Promise.all([updates.check(), updates.check()]);
  assert.equal(calls, 1);
  assert.equal(statuses[0].state, 'available');
  assert(!JSON.stringify(statuses).includes('test-token'));
  await updates.open();
  assert.equal(opened, RELEASES_URL);
  await updates.auth('clear');
  assert.equal(secrets.size, 0);
});

test('检查错误不暴露底层请求或令牌，取消输入不改变凭据', async () => {
  const stored: string[] = [];
  const context = {
    extension: { packageJSON: { version: '0.1.2' } },
    secrets: { get: async () => 'secret-value', store: async (_key: string, value: string) => { stored.push(value); } },
  } as unknown as vscode.ExtensionContext;
  const updates = new UpdateService(context, { inputToken: async () => undefined, request: async () => { throw new Error('secret-value'); } });
  await updates.auth('set');
  assert.equal(stored.length, 0);
  const status = await updates.check();
  assert.equal(status.state, 'unavailable');
  assert(!JSON.stringify(status).includes('secret-value'));
});
