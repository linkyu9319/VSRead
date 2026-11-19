import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import type { BookSource } from '../src/shared/online';
import { AggregateSearchManager } from '../src/extension/online/aggregateSearch';
import { OnlineLibrary } from '../src/extension/online/library';
import type { TextFetcher } from '../src/extension/online/network';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitFor<T>(read: () => T | false | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const value = read();
    if (value) return value;
    assert(Date.now() < deadline, `等待超时：${label}`);
    await nextTurn();
  }
}

const html = (rows: Array<[string, string]> = [['星海', '/book/one']]) => rows.map(([title, href]) => `<div class="book"><a class="name" href="${href}">${title}</a><span class="author">测试作者</span></div>`).join('');
const source = (name: string, origin: string, searchPath = '/search') => ({
  name, baseUrl: origin, enabled: true, searchUrl: `${searchPath}?q={{key}}&page={{page}}`,
  search: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
  toc: { chapterList: 'a.chapter', chapterName: '@text', chapterUrl: '@href' }, content: { content: '#content@text' },
});

async function fixture(t: TestContext, fetchText: TextFetcher) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-aggregate-test-'));
  const library = new OnlineLibrary(root, { fetchText });
  const cleanup: Array<() => void> = [];
  t.after(async () => {
    for (const operation of cleanup) operation();
    await library.flush();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('vsread-aggregate-test-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  });
  await library.load();
  return { root, library, cleanup };
}

async function importSources(library: OnlineLibrary, values: ReturnType<typeof source>[]): Promise<BookSource[]> {
  const result = await library.importSources({ json: JSON.stringify(values) });
  assert.deepEqual(result.rejected, []);
  return values.map(value => result.sources.find(item => item.name === value.name)!);
}

test('聚合搜索立即返回，快源和失败源独立增量呈现，慢源不阻塞结果', async t => {
  const slow = deferred<void>();
  const slowStarted = deferred<void>();
  const { library, cleanup } = await fixture(t, async (url, options) => {
    const host = new URL(url).hostname;
    assert(options?.signal instanceof AbortSignal);
    if (host.startsWith('slow.')) { slowStarted.resolve(undefined); await slow.promise; }
    if (host.startsWith('broken.')) throw new Error('模拟书源请求超时');
    return { url, text: html() };
  });
  const sources = await importSources(library, [source('慢源', 'https://slow.example.test'), source('快源', 'https://fast.example.test'), source('坏源', 'https://broken.example.test')]);
  const manager = new AggregateSearchManager(library, { concurrency: 3 });
  cleanup.push(() => { manager.cancelAll(); slow.resolve(undefined); });
  const started = manager.start('  星海  ', sources.map(item => item.id));
  assert.equal(started.state, 'running');
  assert.equal(started.query, '星海');
  await slowStarted.promise;
  const partial = await waitFor(() => {
    const job = manager.status(started.id);
    return job.sources[1].state === 'success' && job.sources[2].state === 'error' && job;
  }, '快源完成、坏源独立失败');
  assert.equal(partial.state, 'running');
  assert.equal(partial.sources[0].state, 'running');
  assert.equal(partial.sources[1].count, 1);
  assert.equal(partial.sources[1].elapsedMs! >= 0, true);
  assert.match(partial.sources[2].error!, /超时/);
  assert.deepEqual(partial.results.map(item => item.sourceId), [sources[1].id]);
  // RPC 调用方修改快照不能破坏后台任务。
  partial.results.length = 0;
  partial.sources[0].state = 'cancelled';
  assert.equal(manager.status(started.id).results.length, 1);
  assert.equal(manager.status(started.id).sources[0].state, 'running');
  slow.resolve(undefined);
  const completed = await waitFor(() => { const job = manager.status(started.id); return job.state === 'completed' && job; }, '慢源最终完成');
  assert.equal(completed.results.length, 2);
  assert.deepEqual(completed.sources.map(item => item.state), ['success', 'success', 'error']);
});

test('后台并发有界，默认最多四源，配置可降为两源且排队源最终完成', async t => {
  for (const concurrency of [undefined, 2]) {
    const expected = concurrency ?? 4;
    const gates = Array.from({ length: 5 }, () => deferred<void>());
    let active = 0, peak = 0;
    const entered: number[] = [];
    const { library, cleanup } = await fixture(t, async url => {
      const index = Number(new URL(url).hostname.split('.')[0].slice(1));
      entered.push(index); active++; peak = Math.max(peak, active);
      try { await gates[index].promise; return { url, text: html() }; }
      finally { active--; }
    });
    const sources = await importSources(library, gates.map((_, index) => source(`并发源${index}`, `https://s${index}.example.test`)));
    const manager = new AggregateSearchManager(library, { concurrency });
    cleanup.push(() => { manager.cancelAll(); for (const gate of gates) gate.resolve(undefined); });
    const job = manager.start('星海', sources.map(item => item.id));
    await waitFor(() => entered.length >= expected, '并发槽位已占满');
    assert.equal(entered.length, expected);
    assert.equal(manager.status(job.id).sources.filter(item => item.state === 'queued').length, 5 - expected);
    for (const gate of gates) gate.resolve(undefined);
    await waitFor(() => manager.status(job.id).state === 'completed', '所有排队源完成');
    assert.equal(entered.length, 5);
    assert.equal(peak, expected);
    assert.equal(manager.status(job.id).results.length, 5);
  }
});

test('结果按书源与网址去重，保留同书跨源变体，达到上限明确标记截断', async t => {
  const { library } = await fixture(t, async url => ({ url, text: html([['星海', '/book/one'], ['重复条目', '/book/one'], ['另一部书', '/book/two']]) }));
  const sources = await importSources(library, [source('同站规则甲', 'https://same.example.test'), source('同站规则乙', 'https://same.example.test')]);
  const manager = new AggregateSearchManager(library, { maxResults: 3 });
  const started = manager.start('星海', sources.map(item => item.id));
  const completed = await waitFor(() => { const job = manager.status(started.id); return job.state === 'completed' && job; }, '跨源变体完成');
  assert.equal(completed.results.length, 3);
  assert.equal(completed.truncated, true);
  assert.deepEqual(completed.sources.map(item => item.count), [2, 2]);
  const variants = completed.results.filter(item => item.url === 'https://same.example.test/book/one');
  assert.equal(variants.length, 2);
  assert.deepEqual(new Set(variants.map(item => item.sourceId)), new Set(sources.map(item => item.id)));
  assert.equal(new Set(completed.results.map(item => `${item.sourceId}\n${item.url}`)).size, 3);
});

test('同域慢源不占满聚合窗口，后排异域快源仍可先返回', async t => {
  const release = deferred<void>();
  const entered: string[] = [];
  const active = new Map<string, number>();
  let sameOriginPeak = 0;
  const { library, cleanup } = await fixture(t, async url => {
    const parsed = new URL(url);
    entered.push(parsed.hostname + parsed.pathname);
    active.set(parsed.origin, (active.get(parsed.origin) ?? 0) + 1);
    if (parsed.hostname === 'shared.example.test') sameOriginPeak = Math.max(sameOriginPeak, active.get(parsed.origin)!);
    try {
      if (parsed.pathname === '/slow') await release.promise;
      return { url, text: html() };
    } finally { active.set(parsed.origin, active.get(parsed.origin)! - 1); }
  });
  const sources = await importSources(library, [source('同域慢甲', 'https://shared.example.test', '/slow'), source('同域乙', 'https://shared.example.test', '/second'), source('异域快源', 'https://independent.example.test')]);
  const manager = new AggregateSearchManager(library, { concurrency: 2 });
  cleanup.push(() => { manager.cancelAll(); release.resolve(undefined); });
  const started = manager.start('星海', sources.map(item => item.id));
  const partial = await waitFor(() => {
    const job = manager.status(started.id);
    return job.sources[2].state === 'success' && job;
  }, '后排异域快源不等待同域慢源');
  assert.equal(partial.state, 'running');
  assert.equal(partial.sources[0].state, 'running');
  assert.equal(partial.sources[1].state, 'queued');
  assert.deepEqual(partial.results.map(item => item.sourceId), [sources[2].id]);
  assert(!entered.includes('shared.example.test/second'));
  release.resolve(undefined);
  await waitFor(() => manager.status(started.id).state === 'completed', '同域队列最终完成');
  assert(entered.includes('shared.example.test/second'));
  assert.equal(sameOriginPeak, 1);
});

test('取消中止活动信号、不启动排队源，旧任务迟到和旧取消不污染新搜索', async t => {
  const releaseOld = deferred<void>();
  const oldSettled = deferred<void>();
  const calls: Array<{ query: string; host: string; signal: AbortSignal }> = [];
  let oldFinished = 0;
  const { library, cleanup } = await fixture(t, async (url, options) => {
    const parsed = new URL(url);
    const query = parsed.searchParams.get('q')!;
    calls.push({ query, host: parsed.hostname, signal: options!.signal! });
    if (query === '旧搜索') {
      try { await releaseOld.promise; }
      finally { if (++oldFinished === 2) oldSettled.resolve(undefined); }
    }
    return { url, text: html([[query, '/book/one']]) };
  });
  const sources = await importSources(library, [0, 1, 2].map(index => source(`取消源${index}`, `https://cancel${index}.example.test`)));
  const manager = new AggregateSearchManager(library, { concurrency: 2 });
  cleanup.push(() => { manager.cancelAll(); releaseOld.resolve(undefined); });
  const old = manager.start('旧搜索', sources.map(item => item.id));
  await waitFor(() => calls.length === 2, '旧任务两条活动请求');
  const cancelled = manager.cancel(old.id);
  assert.equal(cancelled.state, 'cancelled');
  assert(cancelled.sources.every(item => item.state === 'cancelled'));
  assert(calls.every(item => item.signal.aborted));
  assert.equal(calls.some(item => item.host === 'cancel2.example.test'), false);
  const current = manager.start('新搜索', [sources[2].id]);
  manager.cancel(old.id);
  const completed = await waitFor(() => { const job = manager.status(current.id); return job.state === 'completed' && job; }, '新任务独立完成');
  assert.deepEqual(completed.results.map(item => item.title), ['新搜索']);
  releaseOld.resolve(undefined);
  await oldSettled.promise;
  await nextTurn();
  assert.deepEqual(manager.status(old.id), cancelled);
  assert.deepEqual(manager.status(current.id), completed);
  assert.equal(calls.filter(item => item.query === '旧搜索').length, 2);
  const newest = manager.start('第三次搜索', [sources[2].id]);
  await waitFor(() => manager.status(newest.id).state === 'completed', '第三次任务完成');
  assert.throws(() => manager.status(old.id));
  assert.equal(manager.status(current.id).state, 'completed');
});

test('输入边界同步拒绝，坏请求不取消正在执行的任务，停用源不会被重启', async t => {
  const release = deferred<void>();
  let requests = 0;
  const { library, cleanup } = await fixture(t, async url => { requests++; await release.promise; return { url, text: html() }; });
  const [selected] = await importSources(library, [source('输入边界源', 'https://validation.example.test')]);
  const manager = new AggregateSearchManager(library);
  cleanup.push(() => { manager.cancelAll(); release.resolve(undefined); });
  const running = manager.start('正常搜索', [selected.id]);
  await waitFor(() => requests === 1, '原任务已开始');
  for (const query of ['', '   ', '字'.repeat(201), 123 as unknown as string]) assert.throws(() => manager.start(query, [selected.id]));
  for (const ids of [[], ['unknown'], ['f'.repeat(64)], [selected.id, selected.id], Array.from({ length: 51 }, (_, index) => index.toString(16).padStart(64, '0'))]) {
    assert.throws(() => manager.start('星海', ids));
  }
  assert.equal(manager.status(running.id).state, 'running');
  assert.equal(requests, 1);
  for (const id of ['', 'missing', 'x'.repeat(101), undefined as unknown as string]) { assert.throws(() => manager.status(id)); assert.throws(() => manager.cancel(id)); }
  release.resolve(undefined);
  await waitFor(() => manager.status(running.id).state === 'completed', '原任务完成');
  const boundary = manager.start('字'.repeat(200), [selected.id]);
  await waitFor(() => manager.status(boundary.id).state === 'completed', '200 字查询可执行');
  await library.toggleSource(selected.id, false);
  assert(!library.listSearchSources().some(item => item.id === selected.id));
  assert.throws(() => manager.start('星海', [selected.id]));
  await assert.rejects(library.prepareSearchSources([selected.id]));
  assert.equal(library.listSources()[0].enabled, false);
});

test('空库可选内置源但不联网，开始搜索才一次性补齐选定源，已有与停用配置保留', async t => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let requests = 0;
  const { root, library, cleanup } = await fixture(t, async url => {
    requests++; entered.resolve(undefined); await release.promise;
    return { url, text: '<li class="booklink"><a class="link" href="/ebooks/1"><span class="title">古籍</span><span class="subtitle">作者</span></a></li>' };
  });
  const builtins = library.listBuiltinSources().filter(item => ['gutenberg', 'gutenberg-zh'].includes(item.id));
  assert.equal(builtins.length, 2);
  assert.equal(library.listSources().length, 0);
  assert.equal(library.listSearchSources().length, library.listBuiltinSources().length);
  assert.equal(requests, 0);
  await assert.rejects(readFile(path.join(root, 'online.json')), { code: 'ENOENT' });
  const manager = new AggregateSearchManager(library);
  cleanup.push(() => { manager.cancelAll(); release.resolve(undefined); });
  const job = manager.start('古籍', builtins.map(item => item.sourceId));
  await entered.promise;
  const stored = JSON.parse(await readFile(path.join(root, 'online.json'), 'utf8'));
  assert.deepEqual(new Set(stored.sources.map((item: BookSource) => item.id)), new Set(builtins.map(item => item.sourceId)));
  // 空库一次提交两个新增源；若逐个保存，会留下只含第一个源的备份。
  await assert.rejects(readFile(path.join(root, 'online.backup.json')), { code: 'ENOENT' });
  release.resolve(undefined);
  await waitFor(() => manager.status(job.id).state === 'completed', '内置来源搜索完成');
  assert.equal(requests, 2);
  assert.equal(manager.status(job.id).results.length, 2);
  await library.toggleSource(builtins[0].sourceId, false);
  const backup = await readFile(path.join(root, 'online.backup.json'), 'utf8');
  await library.prepareSearchSources([builtins[1].sourceId]);
  assert.equal(await readFile(path.join(root, 'online.backup.json'), 'utf8'), backup);
  assert.throws(() => manager.start('古籍', [builtins[0].sourceId]));
  assert.equal(library.listSources().find(item => item.id === builtins[0].sourceId)?.enabled, false);
});

test('内置来源预处理写盘失败使任务失败，不联网且不留下半添加状态', async t => {
  let requests = 0;
  const { root, library } = await fixture(t, async () => { requests++; throw new Error('不应请求网络'); });
  const selected = library.listBuiltinSources()[0];
  await mkdir(path.join(root, 'online.json.tmp'));
  const manager = new AggregateSearchManager(library);
  const job = manager.start('星海', [selected.sourceId]);
  const failed = await waitFor(() => { const state = manager.status(job.id); return state.state === 'failed' && state; }, '预处理保存失败');
  assert.equal(typeof failed.error, 'string');
  assert(failed.sources.every(item => item.state === 'error'));
  assert.deepEqual(failed.results, []);
  assert.equal(requests, 0);
  assert.deepEqual(library.listSources(), []);
});

test('同域排队搜索取消及时返回，保留网络串行队尾，后续请求可继续', async t => {
  const release = deferred<void>();
  const started = deferred<void>();
  let active = 0, peak = 0;
  const queries: string[] = [];
  const { library, cleanup } = await fixture(t, async url => {
    const query = new URL(url).searchParams.get('q')!;
    queries.push(query); active++; peak = Math.max(peak, active);
    try {
      if (query === '占用队列') { started.resolve(undefined); await release.promise; }
      return { url, text: html() };
    } finally { active--; }
  });
  cleanup.push(() => release.resolve(undefined));
  const sources = await importSources(library, [source('同域甲', 'https://queue.example.test', '/first'), source('同域乙', 'https://queue.example.test', '/second')]);
  const first = library.search(sources[0].id, '占用队列');
  await started.promise;
  const controller = new AbortController();
  let cancelled = false;
  const queued = library.search(sources[1].id, '取消排队', 1, controller.signal).then(() => assert.fail('取消请求不应成功'), () => { cancelled = true; });
  controller.abort();
  await waitFor(() => cancelled, '排队取消不等待前一网络请求');
  await queued;
  assert.deepEqual(queries, ['占用队列']);
  const following = library.search(sources[1].id, '后续请求');
  await nextTurn();
  assert.deepEqual(queries, ['占用队列']);
  release.resolve(undefined);
  assert.equal((await first).length, 1);
  assert.equal((await following).length, 1);
  assert.deepEqual(queries, ['占用队列', '后续请求']);
  assert.equal(peak, 1);
});
