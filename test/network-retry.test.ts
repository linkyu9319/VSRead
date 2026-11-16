import test from 'node:test';
import assert from 'node:assert/strict';
import { retryTransientRequest } from '../src/extension/online/networkRetry';

test('瞬时连接中断只重试一次，HTTP 拒绝、超时与取消不重新请求', async () => {
  let calls = 0; const retries: string[] = [];
  const result = await retryTransientRequest(async () => { if (++calls === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); return '正文'; }, new AbortController().signal, code => retries.push(code));
  assert.equal(result, '正文'); assert.equal(calls, 2); assert.deepEqual(retries, ['ECONNRESET']);
  for (const code of ['HTTP_403', 'HTTP_429', 'ETIMEDOUT', 'CERT_HAS_EXPIRED']) {
    calls = 0;
    await assert.rejects(retryTransientRequest(async () => { calls++; throw Object.assign(new Error(code), { code }); }, new AbortController().signal, () => assert.fail('不应重试')), new RegExp(code));
    assert.equal(calls, 1);
  }
  calls = 0;
  await assert.rejects(retryTransientRequest(async () => { calls++; throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }, new AbortController().signal, () => {}), /reset/);
  assert.equal(calls, 2);
  const controller = new AbortController(); calls = 0;
  await assert.rejects(retryTransientRequest(async () => { calls++; controller.abort(new Error('取消')); throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }, controller.signal, () => assert.fail('取消不重试')), /取消/);
  assert.equal(calls, 1);
});
