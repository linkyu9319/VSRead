import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { OnlineLibrary } from '../src/extension/online/library';
import { getBuiltinSource, listBuiltinSources } from '../src/extension/online/builtins';
import type { TextFetcher } from '../src/extension/online/network';

test('内置目录可直接选择，添加不联网、重复添加去重、保留自定义书源', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-builtin-list-'));
  let requests = 0;
  try {
    const library = new OnlineLibrary(root, { fetchText: async () => { requests++; throw new Error('不应联网'); } });
    await library.load();
    const builtins = library.listBuiltinSources();
    assert.equal(builtins.length, 4);
    assert(builtins.some(item => item.id === 'jingzhi-public' && item.language === '中文'));
    assert.equal(library.listSources().length, 0);
    for (const builtin of builtins) {
      assert.equal(getBuiltinSource(builtin.id).id, builtin.sourceId);
      await library.addBuiltinSource(builtin.id);
      await library.addBuiltinSource(builtin.id);
    }
    assert.equal(library.listSources().length, 4);
    assert.equal(requests, 0);
    const chinese = builtins.find(item => item.id === 'jingzhi-public')!;
    await library.toggleSource(chinese.sourceId, false);
    await library.addBuiltinSource(chinese.id);
    assert.equal(library.listSources().find(source => source.id === chinese.sourceId)?.enabled, true);
    const custom = getBuiltinSource('gutenberg');
    await library.importSources({ json: JSON.stringify({ ...custom, name: '我的自定义公版目录' }) });
    assert.equal(library.listSources().length, 5);
    await assert.rejects(library.addBuiltinSource('unknown'), /不存在/);
    const restored = new OnlineLibrary(root); await restored.load();
    assert.equal(restored.listSources().length, 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('所有内置规则可完成搜索、目录和正文流程，经致仅列公开章节', async () => {
  for (const builtin of listBuiltinSources()) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-builtin-rules-'));
    let requests = 0;
    const fetchText: TextFetcher = async url => {
      requests++;
      const parsed = new URL(url);
      if (builtin.id === 'jingzhi-public') {
        if (parsed.pathname === '/') {
          assert.equal(parsed.searchParams.get('keyword'), '三国');
          return { url, text: '<ul class="works-list"><li><div class="search-info"><a class="title" href="/books/1">三国故事</a><a href="/author/1">作者甲</a></div></li></ul>' };
        }
        if (parsed.pathname === '/books/1') return { url, text: '<h2>三国故事</h2><div class="author-zone"><a class="name">作者甲</a></div><div class="buttons"><a class="index" href="/books/catalog/1">目录</a></div>' };
        if (parsed.pathname === '/books/catalog/1') return { url, text: '<ul class="float-list"><li><a class="name" href="/chapter/1">公开第一章</a></li><li><a class="name isvip" href="/chapter/vip">VIP章节</a></li></ul>' };
        if (parsed.pathname === '/chapter/1') return { url, text: '<article class="page-content"><p>公开正文。</p><p>第二段。</p></article>' };
        throw new Error('不得请求VIP章节或未知页面');
      }
      if (builtin.id === 'standard-ebooks') {
        if (parsed.pathname === '/ebooks') return { url, text: '<ol class="ebooks-list"><li><p><a href="/ebooks/example">Example Book</a></p><p class="author">Example Author</p></li></ol>' };
        if (parsed.pathname === '/ebooks/example') return { url, text: '<a href="/ebooks/example/text/single-page">Read on one page</a>' };
        return { url, text: '<body><p>公开正文。</p><p>第二段。</p></body>' };
      }
      if (parsed.pathname === '/ebooks/search/') {
        if (builtin.id === 'gutenberg-zh') assert.equal(parsed.searchParams.get('languages[]'), 'zh');
        return { url, text: '<ul><li class="booklink"><a class="link" href="/ebooks/1"><span class="title">論語</span><span class="subtitle">孔子</span></a></li></ul>' };
      }
      if (parsed.pathname === '/ebooks/1') return { url, text: '<a class="read-online-button" href="/cache/epub/1/example.html">Read online now</a>' };
      return { url, text: '<body><p>公开正文。</p><p>第二段。</p></body>' };
    };
    try {
      const library = new OnlineLibrary(root, { fetchText }); await library.load();
      await library.addBuiltinSource(builtin.id);
      const results = await library.search(builtin.sourceId, '三国', 1);
      assert.equal(results.length, 1, builtin.id);
      const book = await library.add(results[0]);
      assert.equal(book.chapters.length, 1, builtin.id);
      assert(!book.chapters.some(chapter => chapter.url.includes('/vip')));
      const chapter = await library.chapter(book.id, 0);
      assert.equal(chapter.text, '公开正文。\n第二段。', builtin.id);
      const fetched = requests;
      assert.equal((await library.chapter(book.id, 0)).cached, true);
      assert.equal(requests, fetched);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('书源写盘失败会回滚，内置源与导入启停移除可重试并持久化', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-builtin-write-failure-'));
  const obstruction = path.join(root, 'online.json.tmp');
  try {
    const library = new OnlineLibrary(root); await library.load();
    await mkdir(obstruction);
    await assert.rejects(library.addBuiltinSource('jingzhi-public'));
    assert.deepEqual(library.listSources(), []);
    await rm(obstruction, { recursive: true });
    await library.addBuiltinSource('jingzhi-public');
    const first = library.listSources()[0];
    assert.equal(JSON.parse(await readFile(path.join(root, 'online.json'), 'utf8')).sources.length, 1);

    await mkdir(obstruction);
    const custom = { ...getBuiltinSource('gutenberg'), name: '自定义源' };
    const failedImport = library.importSources({ json: JSON.stringify(custom) });
    const failedToggle = library.toggleSource(first.id, false);
    const failedRemove = library.removeSource(first.id);
    const failures = await Promise.allSettled([failedImport, failedToggle, failedRemove]);
    assert(failures.every(result => result.status === 'rejected'));
    assert.deepEqual(library.listSources(), [first]);
    await rm(obstruction, { recursive: true });

    // 三个并发入口按调用顺序提交，失败恢复不会抹掉后续成功的不同书源。
    await Promise.all([
      library.importSources({ json: JSON.stringify(custom) }),
      library.toggleSource(first.id, false),
      library.addBuiltinSource('standard-ebooks'),
    ]);
    assert.equal(library.listSources().length, 3);
    assert.equal(library.listSources().find(source => source.id === first.id)?.enabled, false);
    await library.removeSource(first.id);
    await library.flush();
    const restored = new OnlineLibrary(root); await restored.load();
    assert.equal(restored.listSources().length, 2);
    assert(restored.listSources().some(source => source.name === '自定义源'));
    assert(restored.listSources().some(source => source.name === 'Standard Ebooks'));
    assert(!restored.listSources().some(source => source.id === first.id));
  } finally { await rm(root, { recursive: true, force: true }); }
});
