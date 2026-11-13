import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OnlineLibrary } from '../src/extension/online/library';
import { normalizeSource, parseRule } from '../src/extension/online/rules';
import { publicAddress, requestText, validateHttpUrl, type TextFetcher } from '../src/extension/online/network';

const source = {
  bookSourceName: '测试书源', bookSourceUrl: 'https://books.example.test', searchUrl: '/search?q={{key}}&page={{page}}',
  ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
  ruleBookInfo: { name: 'h1@text', author: '.author@text', tocUrl: '.toc-link@href' },
  ruleToc: { chapterList: '.chapters a', chapterName: '@text', chapterUrl: '@href' },
  ruleContent: { content: '#content@html' },
};

test('声明式书源字段映射和规则边界', () => {
  const normalized = normalizeSource(source);
  assert.equal(normalized.name, '测试书源');
  assert.match(normalized.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(parseRule('class.book@tag.a@href'), { selector: '.book a', attribute: 'href' });
  assert.throws(() => normalizeSource({ ...source, searchUrl: '/search, {"method":"POST"}' }), /GET/);
  assert.throws(() => normalizeSource({ ...source, ruleContent: { content: '@js:java.get()' } }), /不支持脚本/);
  assert.throws(() => normalizeSource({ ...source, ruleToc: { ...source.ruleToc, nextTocUrl: 'a@href' } }), /nextTocUrl/);
  assert.throws(() => normalizeSource({ ...source, header: '{"Cookie":"secret"}' }), /header/);
});

test('搜索、目录、正文缓存、离线恢复与目录更新保留锚点', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-online-'));
  let offline = false, inserted = false, requests = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    let html = '';
    if (url.pathname === '/search') {
      assert.equal(url.searchParams.get('q'), '星海');
      html = '<div class="book"><a href="/book/1"><span class="name">星海来信</span></a><span class="author">作者甲</span></div>';
    } else if (url.pathname === '/book/1') html = '<h1>星海来信</h1><span class="author">作者甲</span><a class="toc-link" href="/toc/1">目录</a>';
    else if (url.pathname === '/toc/1') html = `<nav class="chapters">${inserted ? '<a href="/chapter/0">序言</a>' : ''}<a href="/chapter/1">第一章</a><a href="/chapter/2">第二章</a></nav>`;
    else if (url.pathname.startsWith('/chapter/')) html = `<article id="content"><script>alert(1)</script><p>章节 ${url.pathname.split('/').pop()} 的正文。</p><p>下一段<br/>继续阅读。</p></article>`;
    else { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const fetchText: TextFetcher = async url => {
    if (offline) throw new Error('offline');
    requests++;
    const original = new URL(url);
    const response = await fetch(`http://127.0.0.1:${port}${original.pathname}${original.search}`);
    if (!response.ok) throw new Error('fixture HTTP failed');
    return { text: await response.text(), url };
  };
  try {
    const library = new OnlineLibrary(root, { fetchText }); await library.load();
    const imported = await library.importSources({ json: JSON.stringify([source, { ...source, bookSourceName: 'JS源', ruleContent: { content: '@js:bad' } }]) });
    assert.equal(imported.imported, 1); assert.equal(imported.rejected.length, 1);
    const results = await library.search(imported.sources[0].id, '星海', 1);
    assert.equal(results[0].title, '星海来信');
    const book = await library.add(results[0]); assert.equal(book.chapters.length, 2);
    await assert.rejects(library.cacheChapters(book.id, 0, 21), /1–20/);
    const chapters = await Promise.all([library.chapter(book.id, 1), library.chapter(book.id, 1)]);
    assert.equal(chapters[0].cached, false); assert.equal(chapters[1].cached, true);
    assert.match(chapters[0].text, /下一段\n继续阅读/); assert(!chapters[0].text.includes('alert'));
    await library.saveProgress(book.id, 1, .42);
    inserted = true;
    const refreshed = await library.open(book.id, true);
    assert.equal(refreshed.progress?.chapter, 2); assert.deepEqual(refreshed.cachedChapters, [2]);
    const count = requests;
    offline = true;
    const restored = new OnlineLibrary(root, { fetchText }); await restored.load();
    assert.equal((await restored.open(book.id)).progress?.scroll, .42);
    assert.equal((await restored.chapter(book.id, 2)).cached, true);
    assert.equal(requests, count);
    await restored.removeSource(imported.sources[0].id);
    assert.equal((await restored.chapter(book.id, 2)).cached, true);
    await assert.rejects(restored.chapter(book.id, 0), /书源已移除/);
    await restored.clearCache(book.id);
    assert.deepEqual((await restored.open(book.id)).cachedChapters, []);
    assert.equal((await restored.removeBook(book.id)).length, 0);
    await restored.flush();
    const json = JSON.parse(await readFile(path.join(root, 'online.json'), 'utf8'));
    assert.equal(json.books.length, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('清理缓存等待当前下载提交，不会在清理后重新留下旧正文', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-online-race-'));
  let allowChapter!: () => void;
  let chapterStarted!: () => void;
  const started = new Promise<void>(resolve => { chapterStarted = resolve; });
  const proceed = new Promise<void>(resolve => { allowChapter = resolve; });
  const fetchText: TextFetcher = async url => {
    if (url.endsWith('/book')) return { url, text: '<a class="chapter" href="/chapter">第一章</a>' };
    chapterStarted(); await proceed;
    return { url, text: '<article id="content">正文内容。</article>' };
  };
  try {
    const library = new OnlineLibrary(root, { fetchText }); await library.load();
    const imported = await library.importSources({ json: JSON.stringify({ ...source, ruleBookInfo: {}, ruleToc: { chapterList: 'a.chapter', chapterName: '@text', chapterUrl: '@href' } }) });
    const book = await library.add({ sourceId: imported.sources[0].id, title: '并发测试', url: 'https://books.example.test/book' });
    const reading = library.chapter(book.id, 0);
    await started;
    const clearing = library.clearCache(book.id);
    allowChapter();
    await reading;
    assert.deepEqual((await clearing).cachedChapters, []);
    await assert.rejects(readFile(path.join(root, 'cache', book.id, book.chapters[0].id + '.txt')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('备份恢复、无效输入与缓存批次上限', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-online-store-'));
  try {
    const library = new OnlineLibrary(root); await library.load();
    await library.importSources({ json: JSON.stringify(source) });
    await library.toggleSource(library.listSources()[0].id, false);
    await writeFile(path.join(root, 'online.json'), '{broken');
    const restored = new OnlineLibrary(root); await restored.load(); assert.equal(restored.listSources().length, 1);
    await assert.rejects(restored.importSources({ json: '{broken' }), /JSON/);
    await assert.rejects(restored.open('../private'), /标识无效/);
    await assert.rejects(restored.cacheChapters('a'.repeat(64), 0, 21), /不存在/);
    await assert.rejects(restored.search(restored.listSources()[0].id, '', 1), /搜索内容/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('网络层拒绝本地、私网、URL凭据和非HTTP协议', async () => {
  for (const url of ['file:///etc/passwd', 'https://user:password@example.com', 'http://localhost:3306', 'http://127.0.0.1', 'http://2130706433', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://169.254.169.254', 'http://10.1.2.3']) assert.throws(() => validateHttpUrl(url), url);
  assert(publicAddress('8.8.8.8')); assert(publicAddress('2606:4700:4700::1111'));
  assert(!publicAddress('192.168.1.1')); assert(!publicAddress('100.64.1.1')); assert(!publicAddress('fd00::1')); assert(!publicAddress('2001:db8::1'));
  await assert.rejects(requestText('http://127.0.0.1:1'), /不允许/);
});

test('加入和移除在线书籍写盘失败时，内存与缓存不会产生幽灵状态', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-online-write-failure-'));
  const fetchText: TextFetcher = async url => ({ url, text: url.includes('/book/')
    ? '<a class="chapter" href="/chapter/1">第一章</a>'
    : '<article id="content">离线正文。</article>' });
  try {
    const library = new OnlineLibrary(root, { fetchText }); await library.load();
    const imported = await library.importSources({ json: JSON.stringify({ ...source, ruleBookInfo: {}, ruleToc: { chapterList: 'a.chapter', chapterName: '@text', chapterUrl: '@href' } }) });
    const result = { sourceId: imported.sources[0].id, title: '事务测试', url: 'https://books.example.test/book/1' };
    const obstruction = path.join(root, 'online.json.tmp');
    await mkdir(obstruction);
    await assert.rejects(library.add(result));
    assert.equal(library.listBooks().length, 0);
    const afterFailedAdd = JSON.parse(await readFile(path.join(root, 'online.json'), 'utf8'));
    assert.equal(afterFailedAdd.books.length, 0);
    await rm(obstruction, { recursive: true });
    const book = await library.add(result);
    await library.chapter(book.id, 0);
    await mkdir(obstruction);
    await assert.rejects(library.removeBook(book.id));
    assert.equal(library.listBooks().length, 1);
    assert.equal((await library.chapter(book.id, 0)).cached, true);
    const afterFailedRemove = JSON.parse(await readFile(path.join(root, 'online.json'), 'utf8'));
    assert.equal(afterFailedRemove.books[0].id, book.id);
    await rm(obstruction, { recursive: true });
    assert.deepEqual(await library.removeBook(book.id), []);
    const restored = new OnlineLibrary(root, { fetchText }); await restored.load();
    assert.equal(restored.listBooks().length, 0);
    await assert.rejects(readFile(path.join(root, 'cache', book.id, book.chapters[0].id + '.txt')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
