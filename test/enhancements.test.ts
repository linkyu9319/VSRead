import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../src/shared/model';
import { normalizeSettings } from '../src/shared/validation';
import { LibraryStore } from '../src/extension/store';
import { BookLibrary } from '../src/extension/library';
import { OnlineLibrary } from '../src/extension/online/library';
import { applyReplaceRules, matchChapterIndex, normalizeReplaceRule } from '../src/extension/online/replaceRules';
import type { TextFetcher } from '../src/extension/online/network';

const workerPath = path.resolve('dist/txtWorker.cjs');

const makeSource = (name: string, baseUrl: string) => ({
  bookSourceName: name, bookSourceUrl: baseUrl, searchUrl: '/search?q={{key}}&page={{page}}',
  ruleSearch: { bookList: '.book', name: '.name@text', author: '.author@text', bookUrl: 'a@href' },
  ruleBookInfo: {},
  ruleToc: { chapterList: 'a.chapter', chapterName: '@text', chapterUrl: '@href' },
  ruleContent: { content: '#content@html' },
});

test('阅读偏好校验正文宽度、段间距、PDF 滤镜与预加载开关', () => {
  const legacy = normalizeSettings({ theme: 'dark' });
  assert.equal(legacy.maxWidth, DEFAULT_SETTINGS.maxWidth);
  assert.equal(legacy.paragraphSpacing, DEFAULT_SETTINGS.paragraphSpacing);
  assert.equal(legacy.pdfFilter, 'none');
  assert.equal(legacy.preloadNextChapter, true);

  const custom = normalizeSettings({ maxWidth: 1120, paragraphSpacing: 1.4, pdfFilter: 'dark', preloadNextChapter: false });
  assert.equal(custom.maxWidth, 1120);
  assert.equal(custom.paragraphSpacing, 1.4);
  assert.equal(custom.pdfFilter, 'dark');
  assert.equal(custom.preloadNextChapter, false);

  const clamped = normalizeSettings({ maxWidth: 99999, paragraphSpacing: -5, pdfFilter: 'invert(1)' });
  assert.equal(clamped.maxWidth, 1400);
  assert.equal(clamped.paragraphSpacing, 0);
  assert.equal(clamped.pdfFilter, 'none');
});

test('本地 TXT 宿主侧全文搜索返回精确分块与字符偏移', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-txt-search-'));
  try {
    const sample = path.join(root, 'novel.txt');
    const content = '第一章 启程\n星海之间有微光闪烁。\n第二章 远航\n穿越星海的飞船留下航迹，Starlight 闪耀。\n';
    await writeFile(sample, content, 'utf8');
    const store = new LibraryStore(root); await store.load();
    const library = new BookLibrary(store, workerPath);
    const book = await library.importFile(sample);

    const hits = await library.searchText(book, '星海');
    assert.equal(hits.length, 2);
    assert.equal(hits[0].part, 0);
    assert.equal(hits[0].offset, content.indexOf('星海'));
    assert.match(hits[0].snippet, /星海之间/);
    assert.equal(hits[1].part, 1);
    assert.equal(hits[1].offset, content.lastIndexOf('星海'));

    const ciHits = await library.searchText(book, 'starlight');
    assert.equal(ciHits.length, 1);
    assert.match(ciHits[0].snippet, /Starlight/);

    await assert.rejects(library.searchText(book, '   '), /1–200/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('换源章节智能对齐支持精确标题、去前缀核心标题、章节号及比例回退', () => {
  const make = (titles: string[]) => titles.map((title, i) => ({ id: String(i).padStart(64, '0'), title, url: `https://example.test/c/${i}` }));
  const oldChapters = make(['第一章 初遇星海', '第十二章 迷雾港口', '第十三章 孤帆远影']);

  assert.equal(matchChapterIndex(oldChapters, 1, make(['序章', '第十二章 迷雾港口', '尾声'])), 1);
  assert.equal(matchChapterIndex(oldChapters, 1, make(['001 初遇', '12. 迷雾港口', '13. 远影'])), 1);
  assert.equal(matchChapterIndex(oldChapters, 1, make(['第11章 其它', '第12章 标题不同', '第13章 结尾'])), 1);
  assert.equal(matchChapterIndex(oldChapters, 2, make(['A', 'B', 'C', 'D', 'E'])), 4);
});

test('正文净化规则校验 ReDoS 防护、适用范围与正则/纯文本替换', () => {
  assert.throws(() => normalizeReplaceRule({ name: '危险正则', pattern: '(a+)+b', replacement: '', isRegex: true }), /嵌套量词/);
  assert.throws(() => normalizeReplaceRule({ name: '语法错误', pattern: '[unclosed', replacement: '', isRegex: true }), /语法无效/);
  const globalRule = normalizeReplaceRule({ name: '去广告', pattern: '求月票', replacement: '', isRegex: false });
  const scopedRule = normalizeReplaceRule({ name: '特定站水印', pattern: '^访问.*\\.example$', replacement: '', isRegex: true, scope: '源甲' });

  const raw = '正文第一段。\n访问 www.test.example\n求月票！\n\n\n正文第二段。';
  const cleanedA = applyReplaceRules(raw, [globalRule, scopedRule], { title: '星海', sourceName: '源甲' });
  assert.equal(cleanedA, '正文第一段。\n\n！\n\n正文第二段。');

  const cleanedB = applyReplaceRules(raw, [globalRule, scopedRule], { title: '星海', sourceName: '源乙' });
  assert.match(cleanedB, /www\.test\.example/);
  assert.ok(!cleanedB.includes('求月票'));
});

test('在线书库置顶、批量检查更新、换源对齐、正文净化与导出缓存 TXT 完整闭环', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-online-loop-'));
  let expandedA = false;
  let failSourceB = false;
  const fetchText: TextFetcher = async url => {
    if (url === 'https://a.example/book/1') {
      return {
        url,
        text: expandedA
          ? '<a class="chapter" href="/c/1">第一章 初遇</a><a class="chapter" href="/c/2">第二章 迷雾港口</a><a class="chapter" href="/c/3">第三章 新章降临</a>'
          : '<a class="chapter" href="/c/1">第一章 初遇</a><a class="chapter" href="/c/2">第二章 迷雾港口</a>',
      };
    }
    if (url === 'https://a.example/c/1') return { url, text: '<article id="content">第一章正文。\n广告水印：请记住本站</article>' };
    if (url === 'https://a.example/c/2') return { url, text: '<article id="content">第二章正文。\n广告水印：请记住本站</article>' };
    if (url === 'https://b.example/book/alt') {
      if (failSourceB) throw new Error('目标源暂时不可用');
      return {
        url,
        text: '<a class="chapter" href="/b/0">序言</a><a class="chapter" href="/b/1">1. 初遇</a><a class="chapter" href="/b/2">2. 迷雾港口</a><a class="chapter" href="/b/3">3. 归途</a>',
      };
    }
    if (url === 'https://b.example/b/2') return { url, text: '<article id="content">新源第二章正文。</article>' };
    throw new Error(`未模拟的 URL: ${url}`);
  };

  try {
    const library = new OnlineLibrary(root, { fetchText }); await library.load();
    const imported = await library.importSources({
      json: JSON.stringify([makeSource('源甲', 'https://a.example'), makeSource('源乙', 'https://b.example')]),
    });
    const [sourceA, sourceB] = imported.sources;
    const book = await library.add({ sourceId: sourceA.id, title: '星海奇旅', author: '作者甲', url: 'https://a.example/book/1' });
    await library.chapter(book.id, 0);
    await library.chapter(book.id, 1);
    await library.saveProgress(book.id, 1, 0.5);

    // 1. 置顶持久化
    const pinned = await library.pinBook(book.id, true);
    assert.equal(pinned.pinned, true);

    // 2. 正文净化规则动态生效，且不破坏磁盘原始缓存
    const rules = await library.saveReplaceRule({ name: '去广告水印', pattern: '广告水印：请记住本站', replacement: '', isRegex: false, enabled: true });
    assert.equal(rules.length, 1);
    const purifiedChapter = await library.chapter(book.id, 0);
    assert.equal(purifiedChapter.cached, true);
    assert.ok(!purifiedChapter.text.includes('广告水印'));
    const rawCacheFile = await readFile(path.join(root, 'cache', book.id, book.chapters[0].id + '.txt'), 'utf8');
    assert.match(rawCacheFile, /广告水印/);

    // 3. 导出已缓存章节为 TXT（应用净化规则）
    const exported = await library.buildCachedTxt(book.id);
    assert.equal(exported.exportedChapters, 2);
    assert.equal(exported.totalChapters, 2);
    assert.match(exported.content, /星海奇旅/);
    assert.match(exported.content, /第一章 初遇/);
    assert.match(exported.content, /第二章正文/);
    assert.ok(!exported.content.includes('广告水印'));

    // 4. 批量检查更新发现新章并标记 newChapters，重新打开书籍自动清除红点
    expandedA = true;
    const summary = await library.checkAllUpdates();
    assert.equal(summary.checked, 1);
    assert.equal(summary.updated.length, 1);
    assert.equal(summary.updated[0].added, 1);
    assert.equal(summary.books[0].newChapters, 1);
    assert.equal(summary.books[0].chapters.length, 3);
    const opened = await library.open(book.id);
    assert.equal(opened.newChapters, undefined);

    // 5. 换源失败保留原源和原缓存；换源成功对齐到“2. 迷雾港口”（索引 2）并清理旧缓存
    failSourceB = true;
    await assert.rejects(library.switchSource(book.id, { sourceId: sourceB.id, title: '星海奇旅', url: 'https://b.example/book/alt' }), /暂时不可用/);
    assert.equal((await library.chapter(book.id, 0)).cached, true);

    failSourceB = false;
    const switched = await library.switchSource(book.id, { sourceId: sourceB.id, title: '星海奇旅', url: 'https://b.example/book/alt' });
    assert.equal(switched.sourceId, sourceB.id);
    assert.equal(switched.chapters.length, 4);
    assert.equal(switched.progress?.chapter, 2);
    assert.deepEqual(switched.cachedChapters, []);
    const newSourceChapter = await library.chapter(book.id, 2);
    assert.equal(newSourceChapter.text, '新源第二章正文。');

    // 6. 重启恢复置顶、换源状态与净化规则
    await library.flush();
    const restored = new OnlineLibrary(root, { fetchText }); await restored.load();
    assert.equal(restored.listReplaceRules().length, 1);
    const restoredBook = await restored.open(book.id);
    assert.equal(restoredBook.pinned, true);
    assert.equal(restoredBook.sourceId, sourceB.id);
    assert.equal(restoredBook.progress?.chapter, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
