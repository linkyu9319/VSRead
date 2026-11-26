import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OnlineLibrary } from '../src/extension/online/library';
import type { CacheAllJob } from '../src/shared/online';
import type { TextFetcher } from '../src/extension/online/network';

const config = {
  bookSourceName: '全本缓存测试', bookSourceUrl: 'https://cache.example', searchUrl: '/search?q={{key}}',
  ruleSearch: { bookList: '.book', name: '@text', bookUrl: 'a@href' }, ruleBookInfo: {},
  ruleToc: { chapterList: 'a.chapter', chapterName: '@text', chapterUrl: '@href' }, ruleContent: { content: '#content@html' },
};

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(count: number, chapter: (index: number) => Promise<string> = async index => `正文 ${index}`) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-cache-all-'));
  const calls: number[] = [];
  const fetchText: TextFetcher = async url => {
    const parsed = new URL(url);
    if (parsed.pathname === '/book/one') return { url, text: Array.from({ length: count }, (_unused, index) => `<a class="chapter" href="/chapter/${index}">第 ${index + 1} 章</a>`).join('') };
    const index = Number(parsed.pathname.split('/').at(-1)); calls.push(index);
    return { url, text: `<article id="content">${await chapter(index)}</article>` };
  };
  const library = new OnlineLibrary(root, { fetchText, cacheAllDelayMs: 0 }); await library.load();
  const sources = await library.importSources({ json: JSON.stringify(config) });
  const book = await library.add({ sourceId: sources.sources[0].id, title: '测试小说', url: 'https://cache.example/book/one' });
  return { root, library, book, calls, fetchText };
}

async function terminal(library: OnlineLibrary, id: string): Promise<CacheAllJob> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = library.cacheAllStatus(id);
    if (job.state !== 'running' && job.state !== 'cancelling') return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('缓存任务未在预期时间结束');
}

test('全本缓存立即返回后台状态，重复启动不重复任务，跳过已缓存并保留阅读进度', async () => {
  const entered = deferred(), release = deferred();
  const item = await fixture(4, async index => { if (index === 1) { entered.resolve(); await release.promise; } return `正文 ${index}`; });
  try {
    await item.library.chapter(item.book.id, 0); item.calls.length = 0;
    await item.library.saveProgress(item.book.id, 2, .35);
    const started = await item.library.startCacheAll(item.book.id);
    assert.equal(started.state, 'running'); assert.equal(started.completed, 1);
    assert(!('book' in started), '轮询摘要不应反复传输全目录');
    await entered.promise;
    const duplicate = await item.library.startCacheAll(item.book.id);
    assert.equal(duplicate.state, 'running'); assert.deepEqual(item.calls, [1]);
    await assert.rejects(item.library.open(item.book.id, true), /先取消/);
    release.resolve();
    const finished = await terminal(item.library, item.book.id);
    assert.equal(finished.state, 'completed'); assert.equal(finished.completed, 4); assert.equal(finished.failed, 0);
    assert.deepEqual(finished.cachedChapters, [0, 1, 2, 3]); assert.deepEqual(item.calls, [1, 2, 3]);
    assert.equal((await item.library.open(item.book.id)).progress?.scroll, .35);
    await item.library.flush();
    const restored = new OnlineLibrary(item.root, { fetchText: async () => { throw new Error('离线'); }, cacheAllDelayMs: 0 }); await restored.load();
    assert.equal(restored.cacheAllStatus(item.book.id).state, 'idle');
    assert.equal(restored.cacheAllStatus(item.book.id).completed, 4);
    await restored.toggleSource(item.book.sourceId, false);
    await restored.startCacheAll(item.book.id);
    assert.equal((await terminal(restored, item.book.id)).state, 'completed');
    assert.equal((await restored.chapter(item.book.id, 3)).cached, true);
  } finally { release.resolve(); await terminal(item.library, item.book.id); await rm(item.root, { recursive: true, force: true }); }
});

test('取消当前任务后不再下载后续章节，再次开始只补齐未缓存部分', async () => {
  const entered = deferred(), release = deferred();
  const item = await fixture(4, async index => { if (index === 1) { entered.resolve(); await release.promise; } return `正文 ${index}`; });
  try {
    await item.library.startCacheAll(item.book.id); await entered.promise;
    assert.equal(item.library.cancelCacheAll(item.book.id).state, 'cancelling');
    release.resolve();
    const cancelled = await terminal(item.library, item.book.id);
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.completed, 2); assert.deepEqual(item.calls, [0, 1]);
    await item.library.startCacheAll(item.book.id);
    const finished = await terminal(item.library, item.book.id);
    assert.equal(finished.completed, 4); assert.deepEqual(item.calls, [0, 1, 2, 3]);
  } finally { release.resolve(); await terminal(item.library, item.book.id); await rm(item.root, { recursive: true, force: true }); }
});

test('IDE 退出批量请求取消不等待当前网络，也不会启动后续章节', async () => {
  const entered = deferred(), release = deferred();
  const item = await fixture(3, async index => { entered.resolve(); await release.promise; return `正文 ${index}`; });
  try {
    await item.library.startCacheAll(item.book.id); await entered.promise;
    assert.equal(item.library.cancelAllCacheJobs(), undefined);
    assert.equal(item.library.cacheAllStatus(item.book.id).state, 'cancelling');
    assert.deepEqual(item.calls, [0]);
    release.resolve();
    assert.equal((await terminal(item.library, item.book.id)).state, 'cancelled');
    assert.deepEqual(item.calls, [0]);
  } finally { release.resolve(); await terminal(item.library, item.book.id); await rm(item.root, { recursive: true, force: true }); }
});

test('个别章节失败仍缓存其它章节，继续缓存只重试失败章', async () => {
  let unavailable = true;
  const item = await fixture(4, async index => { if (index === 1 && unavailable) throw new Error('章节暂时不可读'); return `正文 ${index}`; });
  try {
    await item.library.startCacheAll(item.book.id);
    const partial = await terminal(item.library, item.book.id);
    assert.equal(partial.state, 'completed'); assert.equal(partial.failed, 1); assert.equal(partial.completed, 3); assert.match(partial.error!, /继续缓存/);
    unavailable = false; await item.library.startCacheAll(item.book.id);
    const complete = await terminal(item.library, item.book.id);
    assert.equal(complete.completed, 4); assert.equal(complete.failed, 0); assert.deepEqual(item.calls, [0, 1, 2, 3, 1]);
  } finally { await terminal(item.library, item.book.id); await rm(item.root, { recursive: true, force: true }); }
});

for (const action of ['clear', 'remove'] as const) test(`正在缓存时${action === 'clear' ? '清理缓存' : '移除书籍'}会停止任务，不会产生迟到缓存`, async () => {
  const entered = deferred(), release = deferred();
  const item = await fixture(3, async index => { entered.resolve(); await release.promise; return `正文 ${index}`; });
  try {
    await item.library.startCacheAll(item.book.id); await entered.promise;
    const maintenance = action === 'clear' ? item.library.clearCache(item.book.id) : item.library.removeBook(item.book.id);
    await assert.rejects(item.library.startCacheAll(item.book.id), /正在清理或移除/);
    release.resolve(); await maintenance;
    assert.deepEqual(item.calls, [0]);
    await assert.rejects(stat(path.join(item.root, 'cache', item.book.id)), /ENOENT/);
    if (action === 'clear') { const status = item.library.cacheAllStatus(item.book.id); assert.equal(status.state, 'idle'); assert.equal(status.completed, 0); }
    else { assert.equal(item.library.listBooks().length, 0); assert.throws(() => item.library.cacheAllStatus(item.book.id), /不存在/); }
  } finally { release.resolve(); await rm(item.root, { recursive: true, force: true }); }
});

test('缓存达到单书预算会暂停并提示清理，保留已有索引且不继续后续请求', async () => {
  const item = await fixture(3);
  try {
    await item.library.flush();
    const filename = path.join(item.root, 'online.json');
    const state = JSON.parse(await readFile(filename, 'utf8'));
    // 已从目录移除的旧章节仍占缓存预算，测试无需实际分配百兆正文。
    state.books[0].cacheSizes['f'.repeat(64)] = 100 * 1024 * 1024;
    await writeFile(filename, JSON.stringify(state));
    const library = new OnlineLibrary(item.root, { fetchText: item.fetchText, cacheAllDelayMs: 0 }); await library.load();
    await library.startCacheAll(item.book.id);
    const job = await terminal(library, item.book.id);
    assert.equal(job.state, 'failed'); assert.equal(job.completed, 0); assert.equal(job.failed, 1); assert.match(job.error!, /体积上限.*清理/);
    assert.deepEqual(item.calls, [0]);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('正文已写但索引失败时不误报成功，重启后复用文件补齐索引', async () => {
  const item = await fixture(2);
  const filename = path.join(item.root, 'online.json');
  const previous = await readFile(filename, 'utf8');
  try {
    await rm(filename); await mkdir(filename);
    await item.library.startCacheAll(item.book.id);
    const failed = await terminal(item.library, item.book.id);
    assert.equal(failed.state, 'failed'); assert.equal(failed.completed, 0);
    assert.equal(item.calls.length, 1);
    await rm(filename, { recursive: true }); await writeFile(filename, previous);
    const restored = new OnlineLibrary(item.root, { fetchText: item.fetchText, cacheAllDelayMs: 0 }); await restored.load();
    await restored.startCacheAll(item.book.id);
    assert.equal((await terminal(restored, item.book.id)).completed, 2);
    assert.deepEqual(item.calls, [0, 1], '已落盘的首章不应再次访问网络');
    await restored.flush();
    const reopened = new OnlineLibrary(item.root); await reopened.load();
    assert.equal(reopened.cacheAllStatus(item.book.id).completed, 2);
  } finally { await rm(item.root, { recursive: true, force: true }); }
});

test('缺失或空缓存文件会被重新获取，不计作全本已缓存', async () => {
  const item = await fixture(2);
  try {
    await item.library.chapter(item.book.id, 0); await item.library.chapter(item.book.id, 1); item.calls.length = 0;
    const cacheDirectory = path.join(item.root, 'cache', item.book.id);
    await writeFile(path.join(cacheDirectory, item.book.chapters[0].id + '.txt'), '');
    await rm(path.join(cacheDirectory, item.book.chapters[1].id + '.txt'));
    await item.library.startCacheAll(item.book.id);
    assert.equal((await terminal(item.library, item.book.id)).completed, 2);
    assert.deepEqual(item.calls, [0, 1]);
  } finally { await terminal(item.library, item.book.id); await rm(item.root, { recursive: true, force: true }); }
});

test('全本缓存下载慢章时不阻塞同一本书已缓存章节的读取', async () => {
  const entered = deferred(), release = deferred();
  const item = await fixture(3, async index => { if (index === 1) { entered.resolve(); await release.promise; } return `正文 ${index}`; });
  try {
    await item.library.chapter(item.book.id, 0);
    await item.library.startCacheAll(item.book.id);
    await entered.promise;
    const cached = await Promise.race([
      item.library.chapter(item.book.id, 0),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('已缓存章节读取被后台下载阻塞')), 500)),
    ]);
    assert.equal(cached.cached, true);
    assert.equal(cached.text, '正文 0');
    release.resolve();
    assert.equal((await terminal(item.library, item.book.id)).completed, 3);
  } finally { release.resolve(); await terminal(item.library, item.book.id); await rm(item.root, { recursive: true, force: true }); }
});
