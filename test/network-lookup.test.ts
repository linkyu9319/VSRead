import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { pinnedLookup, requestText } from '../src/extension/online/network';

test('固定DNS地址兼容Node自动选择地址族的真实HTTP连接', async () => {
  const server = createServer((_request, response) => response.end('connected'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const options = {
        autoSelectFamily: true,
        lookup: pinnedLookup({ address: '127.0.0.1', family: 4 }),
      };
      const request = get(`http://fixture.invalid:${port}/`, options, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.once('end', () => resolve(text));
        response.once('error', reject);
      });
      request.once('error', reject);
    });
    assert.equal(body, 'connected');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('首个地址连接失败时，使用同批已固定的下一地址', async () => {
  const server = createServer((_request, response) => response.end('fallback-connected'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const options = { family: 0, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 50, lookup: pinnedLookup([{ address: '127.0.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }]) };
      const request = get(`http://fixture.invalid:${port}/`, options, response => {
        let text = ''; response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; }); response.once('end', () => resolve(text)); response.once('error', reject);
      });
      request.once('error', reject);
    });
    assert.equal(body, 'fallback-connected');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('DNS 追踪回调同步取消时立即结束，不等待未启动的域名查询', async () => {
  const controller = new AbortController();
  const stages: string[] = [];
  await assert.rejects(requestText('https://example.com/', { signal: controller.signal, onTrace: event => {
    stages.push(event.stage); if (event.stage === 'dns') controller.abort(new Error('已取消测试请求'));
  } }), /已取消测试请求/);
  assert.deepEqual(stages, ['dns', 'error']);
});
