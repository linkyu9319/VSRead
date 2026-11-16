import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OnlineLibrary } from '../src/extension/online/library';
import { getBuiltinSource } from '../src/extension/online/builtins';
import type { TextFetcher } from '../src/extension/online/network';

test('慢书源不阻塞其它域名，同域名搜索继续串行', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-network-queue-'));
  let release!: () => void, started!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const calls: string[] = [];
  const fetchText: TextFetcher = async url => {
    const parsed = new URL(url); const query = parsed.searchParams.get('query')!;
    calls.push(parsed.hostname + ':' + query);
    if (parsed.hostname === 'slow.example' && query === 'first') { started(); await slow; }
    return { url, text: '<li class="booklink"><a class="link" href="/ebooks/1"><span class="title">小说</span></a></li>' };
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const library = new OnlineLibrary(root, { fetchText }); await library.load();
    const config = getBuiltinSource('gutenberg');
    const imported = await library.importSources({ json: JSON.stringify([{ ...config, name: '慢书源', baseUrl: 'https://slow.example/' }, { ...config, name: '快书源', baseUrl: 'https://fast.example/' }]) });
    const first = library.search(imported.sources[0].id, 'first'); await entered;
    const second = library.search(imported.sources[0].id, 'second');
    const fast = library.search(imported.sources[1].id, 'fast');
    const result = await Promise.race([fast, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('其它书源被慢请求阻塞')), 1000); })]);
    assert.equal(result.length, 1);
    assert.deepEqual(calls, ['slow.example:first', 'fast.example:fast']);
    release(); await Promise.all([first, second]);
    assert.equal(calls.at(-1), 'slow.example:second');
  } finally { release(); clearTimeout(timeout); await rm(root, { recursive: true, force: true }); }
});

test('网络失败明确标出书源与操作，并写入错误码和请求阶段', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-network-diagnostic-'));
  const entries: { event: string; details: Record<string, unknown> }[] = [];
  try {
    const library = new OnlineLibrary(root, { fetchText: async (_url, options) => {
      options?.onTrace?.({ stage: 'response', url: 'https://books.example/search', elapsedMs: 25 });
      throw Object.assign(new Error('网络请求超时'), { code: 'ETIMEDOUT' });
    }, log: (_level, event, details = {}) => entries.push({ event, details }) });
    await library.load();
    const imported = await library.importSources({ json: JSON.stringify({ ...getBuiltinSource('gutenberg'), name: '测试书源' }) });
    await assert.rejects(library.search(imported.sources[0].id, 'PRIVATE_QUERY'), /「测试书源」搜索失败：网络请求超时/);
    const failure = entries.find(entry => entry.event === 'online.request_failed')!;
    assert.equal(failure.details.operation, 'search'); assert.equal(failure.details.source, '测试书源'); assert.equal(failure.details.errorCode, 'ETIMEDOUT');
    assert(entries.some(entry => entry.event === 'network.response'));
    assert(!JSON.stringify(entries).includes('PRIVATE_QUERY'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
