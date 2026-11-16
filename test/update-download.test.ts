import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import { downloadUpdateAsset, type UpdateAsset } from '../src/extension/updateInstaller';

const asset: UpdateAsset = { id: 123, version: '0.2.0', name: 'vsread-0.2.0.vsix', size: 6, sha256: 'a'.repeat(64) };
const api = 'https://api.github.com/repos/linkyu9319/VSRead/releases/assets/123';
const privateToken = 'download-test-private-token';
const signedUrl = 'https://release-assets.githubusercontent.com/assets/package?signature=private-signature';

interface Step {
  status?: number; headers?: Record<string, string>; chunks?: Buffer[];
  error?: Error; aborted?: boolean; hold?: boolean;
}
interface CapturedRequest { url: string; headers: Record<string, string>; signal?: AbortSignal }

class ResponseFixture extends EventEmitter {
  destroyed = false;
  resumed = false;
  constructor(readonly statusCode: number, readonly headers: Record<string, string>) { super(); }
  resume() { this.resumed = true; return this; }
  destroy(error?: Error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (error) queueMicrotask(() => this.emit('error', error));
    return this;
  }
}

/** 只替换 HTTPS 传输，下载器自身的跳转、字节计数、取消与凭据逻辑保持真实。 */
function mockTransport(t: TestContext, steps: Step[]) {
  const requests: CapturedRequest[] = [];
  const responses: ResponseFixture[] = [];
  const get = (url: URL, options: { headers: Record<string, string>; signal?: AbortSignal }, callback: (response: IncomingMessage) => void) => {
    const step = steps[requests.length];
    assert(step, `出现了意料外的网络请求：${url.href}`);
    requests.push({ url: url.href, headers: { ...options.headers }, signal: options.signal });
    const request = new EventEmitter() as EventEmitter & { destroyed: boolean; setTimeout(): unknown; destroy(error?: Error): unknown };
    request.destroyed = false;
    request.setTimeout = () => request;
    request.destroy = error => {
      if (request.destroyed) return request;
      request.destroyed = true;
      if (error) queueMicrotask(() => request.emit('error', error));
      return request;
    };
    const abort = () => request.destroy(new DOMException('The operation was aborted', 'AbortError'));
    options.signal?.addEventListener('abort', abort, { once: true });
    t.after(() => options.signal?.removeEventListener('abort', abort));
    queueMicrotask(() => {
      if (request.destroyed) return;
      if (step.error) { request.destroy(step.error); return; }
      const response = new ResponseFixture(step.status ?? 200, step.headers ?? {});
      responses.push(response);
      callback(response as unknown as IncomingMessage);
      if (step.hold) return;
      queueMicrotask(() => {
        if (request.destroyed || response.destroyed) return;
        if (step.aborted) { response.emit('aborted'); return; }
        for (const chunk of step.chunks ?? []) {
          if (request.destroyed || response.destroyed) return;
          response.emit('data', chunk);
        }
        if (!request.destroyed && !response.destroyed) response.emit('end');
      });
    });
    return request as unknown as ClientRequest;
  };
  t.mock.method(https, 'get', get as typeof https.get);
  return { requests, responses };
}

function safeMessage(error: unknown) {
  assert(error instanceof Error);
  assert(!error.message.includes(privateToken));
  assert(!error.message.includes('private-signature'));
  assert(!error.message.includes(signedUrl));
  return true;
}

test('默认下载处理 API 跳转与官方 CDN 二进制响应，仅初始资产 API 携带令牌', async t => {
  const transport = mockTransport(t, [
    { status: 302, headers: { location: signedUrl } },
    { status: 307, headers: { location: 'https://objects.githubusercontent.com/package?signature=second-signature' } },
    { status: 200, headers: { 'content-length': '6' }, chunks: [Buffer.from('abc'), Buffer.from('def')] },
  ]);
  const progress: Array<[number, number]> = [];
  const downloaded = await downloadUpdateAsset(asset, privateToken, undefined, (received, total) => progress.push([received, total]));
  assert.equal(downloaded.toString(), 'abcdef');
  assert.equal(transport.requests[0].url, api);
  assert.equal(transport.requests[0].headers.Authorization, `Bearer ${privateToken}`);
  assert.equal(transport.requests[0].headers.Accept, 'application/octet-stream');
  for (const request of transport.requests.slice(1)) assert.equal(request.headers.Authorization, undefined);
  assert.equal(transport.responses[0].resumed, true);
  assert.deepEqual(progress, [[3, 6], [6, 6]]);
});

test('默认下载也支持 API 直接返回二进制，不需要浏览器下载网址', async t => {
  const transport = mockTransport(t, [{ headers: { 'content-length': '6' }, chunks: [Buffer.from('abcdef')] }]);
  assert.equal((await downloadUpdateAsset(asset, undefined, undefined)).toString(), 'abcdef');
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].headers.Authorization, undefined);
});

test('即使跳转仍在 GitHub API 同域，其他路径也不会接收访问令牌', async t => {
  const transport = mockTransport(t, [
    { status: 302, headers: { location: 'https://api.github.com/another/path?signature=private-signature' } },
    { chunks: [Buffer.from('abcdef')] },
  ]);
  assert.equal((await downloadUpdateAsset(asset, privateToken, undefined)).toString(), 'abcdef');
  assert.equal(transport.requests[0].headers.Authorization, `Bearer ${privateToken}`);
  assert.equal(transport.requests[1].headers.Authorization, undefined);
});

test('恶意站点、HTTP、凭据 URL 与非标准端口跳转均被拒绝，不发起后续请求', async t => {
  for (const target of [
    'https://evil.example/package', 'http://release-assets.githubusercontent.com/package',
    'https://release-assets.githubusercontent.com.evil.example/package', 'https://user:pass@release-assets.githubusercontent.com/package',
    'https://release-assets.githubusercontent.com:444/package', 'file:///tmp/package.vsix',
  ]) {
    const transport = mockTransport(t, [{ status: 302, headers: { location: target } }]);
    await assert.rejects(downloadUpdateAsset(asset, privateToken, undefined), safeMessage);
    assert.equal(transport.requests.length, 1, `不应跟随跳转：${target}`);
    t.mock.restoreAll();
  }
});

test('下载拒绝缺失跳转地址、HTTP 错误及超出跳转次数的响应', async t => {
  for (const steps of [
    [{ status: 302 }], [{ status: 403 }],
    Array.from({ length: 4 }, () => ({ status: 302, headers: { location: signedUrl } })),
  ]) {
    const transport = mockTransport(t, steps);
    await assert.rejects(downloadUpdateAsset(asset, privateToken, undefined), safeMessage);
    assert.equal(transport.requests.length, steps.length);
    t.mock.restoreAll();
  }
});

test('下载检查 Content-Length 并在字节超出预期时立即销毁响应', async t => {
  const mismatch = mockTransport(t, [{ headers: { 'content-length': '7' }, chunks: [Buffer.from('abcdefg')] }]);
  await assert.rejects(downloadUpdateAsset(asset, undefined, undefined), safeMessage);
  assert.equal(mismatch.responses[0].destroyed, true);
  t.mock.restoreAll();
  const oversized = mockTransport(t, [{ chunks: [Buffer.from('abc'), Buffer.from('defg')] }]);
  const progress: number[] = [];
  await assert.rejects(downloadUpdateAsset(asset, undefined, undefined, received => progress.push(received)), safeMessage);
  assert.equal(oversized.responses[0].destroyed, true);
  assert.deepEqual(progress, [3]);
});

test('连接错误或响应中断及时失败，界面错误不泄露令牌和签名地址', { timeout: 2000 }, async t => {
  const failed = mockTransport(t, [{ error: new Error(`connect ${signedUrl} Authorization: Bearer ${privateToken}`) }]);
  await assert.rejects(downloadUpdateAsset(asset, privateToken, undefined), safeMessage);
  assert.equal(failed.requests.length, 1);
  t.mock.restoreAll();
  const interrupted = mockTransport(t, [{ aborted: true }]);
  await assert.rejects(downloadUpdateAsset(asset, privateToken, undefined), safeMessage);
  assert.equal(interrupted.requests.length, 1);
});

test('预取消不发网络请求，下载中取消会中断请求且不会等待总超时', { timeout: 2000 }, async t => {
  const transport = mockTransport(t, [{ chunks: [Buffer.from('abc'), Buffer.from('def')] }]);
  const before = new AbortController(); before.abort();
  await assert.rejects(downloadUpdateAsset(asset, privateToken, before.signal), safeMessage);
  assert.equal(transport.requests.length, 0);
  const during = new AbortController();
  await assert.rejects(downloadUpdateAsset(asset, privateToken, during.signal, () => during.abort()), safeMessage);
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].signal?.aborted, true);
});
