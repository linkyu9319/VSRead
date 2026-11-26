import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import type * as vscode from 'vscode';
import { compareVersions, releaseStatus, requestLatestRelease, UpdateService, RELEASES_URL, LATEST_RELEASE_API } from '../src/extension/updates';
import type { UpdateInstallResult } from '../src/shared/online';

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

test('主限流依据剩余额度和恢复时间提示等待，公开仓库令牌是可选项', () => {
  const reset = Math.floor(Date.now() / 1000) + 120;
  const response = { status: 403, body: 'private-response-value', rateLimitRemaining: 0, rateLimitReset: reset };
  const anonymous = releaseStatus('0.1.12', response, false);
  assert.equal(anonymous.state, 'unavailable');
  assert.equal(anonymous.errorCode, 'rate-limited');
  assert.equal(anonymous.retryAt, new Date(reset * 1000).toISOString());
  assert.match(anonymous.message, /已被限流.*秒后重试/);
  assert.match(anonymous.message, /也可配置.*只读/);
  assert(!anonymous.message.includes('private-'));
  const authenticated = releaseStatus('0.1.12', response, true);
  assert.match(authenticated.message, /所配置令牌的请求额度/);
  assert(!authenticated.message.includes('也可配置'));
});

test('二级限流与429识别明确，Retry-After 优先于一般额度重置时间', () => {
  const started = Date.now();
  const secondary = releaseStatus('0.1.12', {
    status: 403, body: JSON.stringify({ message: 'You have exceeded a secondary rate limit. private-response-value' }),
    rateLimitRemaining: 40, rateLimitReset: Math.floor(started / 1000) + 3600, retryAfter: 90,
  }, false);
  assert.equal(secondary.errorCode, 'rate-limited');
  assert.match(secondary.message, /约 90 秒后重试/);
  assert(Date.parse(secondary.retryAt!) >= started + 90_000);
  assert(Date.parse(secondary.retryAt!) <= Date.now() + 90_000);
  assert(!secondary.message.includes('private-'));
  for (const response of [
    { status: 429, body: '<html>private-response-value</html>' },
    { status: 403, body: '{"message":"API rate limit exceeded for private-address-value"}' },
  ]) {
    const status = releaseStatus('0.1.12', response, false);
    assert.equal(status.errorCode, 'rate-limited');
    assert.match(status.message, /等待额度恢复/);
    assert(!status.message.includes('private-'));
  }
});

test('一般403不当成限流，畸形额度信息不能产生恢复时间或混入提示', () => {
  const forbidden = releaseStatus('0.1.12', { status: 403, body: '{"message":"Resource not accessible by personal access token"}' }, true);
  assert.equal(forbidden.errorCode, 'forbidden');
  assert.match(forbidden.message, /拒绝访问.*未返回明确的限流信息/);
  assert.match(forbidden.message, /清除令牌/);
  for (const bad of [-1, NaN, Infinity, 'private-header-value', ['0']]) {
    const response = { status: 403, body: '{}', rateLimitRemaining: bad, rateLimitReset: Number.MAX_SAFE_INTEGER, retryAfter: bad } as any;
    const status = releaseStatus('0.1.12', response, false);
    assert.equal(status.errorCode, 'forbidden');
    assert.equal(status.retryAt, undefined);
    assert(!status.message.includes('private-'));
  }
  const unauthorized = releaseStatus('0.1.12', { status: 401, body: 'private-response-value' }, true);
  assert.equal(unauthorized.errorCode, 'unauthorized');
  assert.match(unauthorized.message, /无效或已过期/);
});

test('网络响应只保留可用的限流数字头，拒绝数组、文本和过大时间', async () => {
  const reset = Math.floor(Date.now() / 1000) + 120;
  const headers = [
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset), 'retry-after': '90', 'x-private-value': 'private-header-value' },
    { 'x-ratelimit-remaining': '-1', 'x-ratelimit-reset': String(Number.MAX_SAFE_INTEGER), 'retry-after': ['90'], 'x-private-value': 'private-header-value' },
  ];
  const mocked = mock.method(https, 'get', ((_url: unknown, options: any, callback: (response: any) => void) => {
    assert.equal(_url, LATEST_RELEASE_API);
    assert.equal(options.headers.Authorization, undefined);
    const request = new EventEmitter() as EventEmitter & { setTimeout(): unknown; destroy(error?: Error): void };
    request.setTimeout = () => request;
    request.destroy = error => { if (error) request.emit('error', error); };
    queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), { statusCode: 403, headers: headers.shift(), destroy() {} });
      callback(response);
      response.emit('data', Buffer.from('{"message":"API rate limit exceeded"}'));
      response.emit('end');
    });
    return request;
  }) as unknown as typeof https.get);
  try {
    const valid = await requestLatestRelease();
    assert.equal(valid.rateLimitRemaining, 0); assert.equal(valid.rateLimitReset, reset); assert.equal(valid.retryAfter, 90);
    assert(!JSON.stringify(valid).includes('private-header-value'));
    const invalid = await requestLatestRelease();
    assert.equal(invalid.rateLimitRemaining, undefined); assert.equal(invalid.rateLimitReset, undefined); assert.equal(invalid.retryAfter, undefined);
  } finally { mocked.mock.restore(); }
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

test('0.1.12 可发现 0.2.0，合并的并发检查只记录一次起止', async () => {
  const entries: { event: string; details?: Record<string, unknown> }[] = [];
  const context = {
    extension: { packageJSON: { version: '0.1.12' } },
    secrets: { get: async () => 'private-access-value' },
  } as unknown as vscode.ExtensionContext;
  let requests = 0;
  const updates = new UpdateService(context, {
    log: (_level, event, details) => { entries.push({ event, details }); },
    request: async token => {
      requests++; assert.equal(token, 'private-access-value');
      return { status: 200, body: JSON.stringify({ tag_name: 'v0.2.0', body: 'private-response-value' }) };
    },
  });
  const first = updates.check();
  assert.equal(updates.check(), first);
  const status = await first;
  assert.equal(status.state, 'available');
  assert.equal(status.latestVersion, '0.2.0');
  assert.equal(requests, 1);
  assert.deepEqual(entries.map(entry => entry.event), ['updates.check.start', 'updates.check.result']);
  assert.deepEqual(entries[0].details, { currentVersion: '0.1.12', phase: 'credentials' });
  assert.equal(entries[1].details?.phase, 'request');
  assert.equal(entries[1].details?.state, 'available');
  assert.equal(entries[1].details?.httpStatus, 200);
  assert.equal(entries[1].details?.latestVersion, '0.2.0');
  assert.equal(typeof entries[1].details?.elapsedMs, 'number');
  assert(!JSON.stringify(entries).includes('private-'));
});

test('检查失败日志区分凭据与请求阶段，只记录受控错误码', async () => {
  for (const phase of ['credentials', 'request'] as const) {
    const entries: { event: string; details?: Record<string, unknown> }[] = [];
    const failure = Object.assign(new Error('private-message-value Authorization: Bearer private-access-value'), {
      code: phase === 'request' ? 'ECONNRESET' : 'private-code-value',
    });
    const context = {
      extension: { packageJSON: { version: '0.1.12' } },
      secrets: { get: async () => { if (phase === 'credentials') throw failure; return 'private-access-value'; } },
    } as unknown as vscode.ExtensionContext;
    let requests = 0;
    const updates = new UpdateService(context, {
      log: (_level, event, details) => { entries.push({ event, details }); },
      request: async () => { requests++; throw failure; },
    });
    assert.equal((await updates.check()).state, 'unavailable');
    assert.equal(requests, phase === 'request' ? 1 : 0);
    assert.deepEqual(entries.map(entry => entry.event), ['updates.check.start', 'updates.check.failed']);
    assert.equal(entries[1].details?.phase, phase);
    assert.equal(entries[1].details?.errorCode, phase === 'request' ? 'ECONNRESET' : 'UNKNOWN');
    assert.equal(entries[1].details?.authenticated, phase === 'request' ? true : undefined);
    assert.equal(typeof entries[1].details?.elapsedMs, 'number');
    assert(!JSON.stringify(entries).includes('private-'));
    assert(!JSON.stringify(entries).includes('Authorization'));
  }
});

test('诊断输出异常不影响检查结果，HTTP 失败仍记录状态', async () => {
  const context = {
    extension: { packageJSON: { version: '0.1.12' } },
    secrets: { get: async () => undefined },
  } as unknown as vscode.ExtensionContext;
  let logCalls = 0;
  const updates = new UpdateService(context, {
    log: () => { logCalls++; throw new Error('模拟诊断输出故障'); },
    request: async () => ({ status: 200, body: '{"tag_name":"v0.2.0"}' }),
  });
  assert.equal((await updates.check()).state, 'available');
  assert.equal(logCalls, 2);
  const entries: { event: string; details?: Record<string, unknown> }[] = [];
  const limited = new UpdateService(context, {
    log: (_level, event, details) => { entries.push({ event, details }); },
    request: async () => ({ status: 429, body: 'private-response-value' }),
  });
  assert.equal((await limited.check()).state, 'unavailable');
  assert.equal(entries[1].event, 'updates.check.result');
  assert.equal(entries[1].details?.httpStatus, 429);
  assert.equal(entries[1].details?.state, 'unavailable');
  assert(!JSON.stringify(entries).includes('private-'));
});

test('限流日志保留受控原因和认证状态，不记录令牌或远端错误正文', async () => {
  const entries: { event: string; details?: Record<string, unknown> }[] = [];
  const reset = Math.floor(Date.now() / 1000) + 300;
  const context = {
    extension: { packageJSON: { version: '0.1.12' } }, secrets: { get: async () => 'private-access-value' },
  } as unknown as vscode.ExtensionContext;
  const updates = new UpdateService(context, {
    log: (_level, event, details) => { entries.push({ event, details }); },
    request: async () => ({ status: 403, body: '{"message":"private-response-value"}', rateLimitRemaining: 0, rateLimitReset: reset, retryAfter: 20 }),
  });
  assert.equal((await updates.check()).errorCode, 'rate-limited');
  assert.equal(entries[1].details?.reason, 'primary-rate-limit');
  assert.equal(entries[1].details?.authenticated, true);
  assert.equal(entries[1].details?.rateLimitRemaining, 0);
  assert.equal(entries[1].details?.rateLimitReset, reset);
  assert.equal(entries[1].details?.retryAfter, 20);
  assert(!JSON.stringify(entries).includes('private-'));
});

const installContext = () => ({
  extension: { packageJSON: { version: '0.1.8' } },
  globalStorageUri: { fsPath: 'C:/vsread-test-storage' },
  secrets: { get: async () => 'private-test-token' },
}) as unknown as vscode.ExtensionContext;
const installRelease = (version = '0.2.0') => ({ status: 200, body: JSON.stringify({
  tag_name: `v${version}`, assets: [{ id: 1, name: `vsread-${version}.vsix`, size: 400, state: 'uploaded', digest: `sha256:${'a'.repeat(64)}` }],
}) });
const progress: NonNullable<ConstructorParameters<typeof UpdateService>[1]>['withProgress'] = task => task(new AbortController().signal, () => {});

test('安装服务重新确认正式版本，合并并发安装，成功后重载且不重复下载安装', async () => {
  let requests = 0, installs = 0, reloads = 0;
  let releaseInstall!: (result: UpdateInstallResult) => void;
  const done = new Promise<UpdateInstallResult>(resolve => { releaseInstall = resolve; });
  const updates = new UpdateService(installContext(), {
    request: async token => { requests++; assert.equal(token, 'private-test-token'); return installRelease(); },
    withProgress: progress,
    install: async (asset, options) => {
      installs++; assert.equal(asset.version, '0.2.0'); assert.equal(options.token, 'private-test-token');
      assert(options.directory.endsWith('updates')); return done;
    },
    reloadWindow: async () => { reloads++; },
  });
  await assert.rejects(updates.reload(), /先完成/);
  const first = updates.install(), second = updates.install();
  assert.equal(first, second);
  releaseInstall({ state: 'installed', version: '0.2.0', message: '安装完成' });
  assert.equal((await first).state, 'installed');
  await updates.install(); await updates.reload();
  assert.equal(requests, 1); assert.equal(installs, 1); assert.equal(reloads, 1);
});

test('安装失败或取消后可重试，没有新版本及缺校验包时禁止调用安装', async () => {
  let installs = 0;
  const updates = new UpdateService(installContext(), {
    request: async () => installRelease(), withProgress: progress,
    install: async () => {
      installs++;
      if (installs === 1) throw new Error('模拟安装失败');
      return installs === 2 ? { state: 'cancelled', message: '已取消' } : { state: 'installed', version: '0.2.0', message: '安装完成' };
    },
  });
  await assert.rejects(updates.install(), /模拟安装失败/);
  assert.equal((await updates.install()).state, 'cancelled');
  assert.equal((await updates.install()).state, 'installed');
  for (const response of [installRelease('0.1.8'), installRelease('0.1.7'), { status: 200, body: '{"tag_name":"v0.2.0","assets":[]}' }]) {
    const blocked = new UpdateService(installContext(), { request: async () => response, withProgress: progress, install: async () => { assert.fail('不应安装'); } });
    await assert.rejects(blocked.install());
  }
  assert.equal(installs, 3);
});

test('一键更新在获取发布信息阶段收到取消信号会立即中止并返回已取消', async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const updates = new UpdateService(installContext(), {
    withProgress: task => task(controller.signal, () => {}),
    request: async (_token, signal) => {
      observedSignal = signal;
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        controller.abort();
      });
    },
    install: async () => { assert.fail('取消后不应继续下载安装'); },
  });
  const result = await updates.install();
  assert.equal(observedSignal, controller.signal);
  assert.equal(result.state, 'cancelled');
});

test('requestLatestRelease 在缺少 AbortSignal.any 的 Node 18 宿主机上仍可正常请求与取消', async () => {
  const originalAny = (AbortSignal as { any?: unknown }).any;
  Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true, writable: true });
  const mocked = mock.method(https, 'get', ((_url: unknown, options: any, callback: (response: any) => void) => {
    const request = new EventEmitter() as EventEmitter & { setTimeout(): unknown; destroy(error?: Error): void };
    request.setTimeout = () => request;
    request.destroy = error => { if (error) request.emit('error', error); };
    const onAbort = () => request.emit('error', options.signal.reason ?? new Error('aborted'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.headers?.Authorization === 'Bearer abort-me') {
      queueMicrotask(() => options.signal?.aborted || undefined);
      return request;
    }
    queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, destroy() {} });
      callback(response);
      response.emit('data', Buffer.from('{"tag_name":"v0.2.4"}'));
      response.emit('end');
    });
    return request;
  }) as unknown as typeof https.get);
  try {
    const okController = new AbortController();
    const ok = await requestLatestRelease('ok-token', okController.signal);
    assert.equal(ok.status, 200);
    const cancelController = new AbortController();
    const pending = requestLatestRelease('abort-me', cancelController.signal);
    cancelController.abort(new Error('user-cancelled'));
    await assert.rejects(pending, /user-cancelled|aborted/);
  } finally {
    mocked.mock.restore();
    Object.defineProperty(AbortSignal, 'any', { value: originalAny, configurable: true, writable: true });
  }
});
