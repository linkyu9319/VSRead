import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import kuwo from '../examples/sources/kuwo.json';
import { OnlineLibrary } from '../src/extension/online/library';
import { normalizeSource } from '../src/extension/online/rules';
import { jsonText, jsonValues, validateJsonRule } from '../src/extension/online/jsonRules';
import { sourceDocument } from '../src/extension/online/document';
import type { TextFetcher } from '../src/extension/online/network';

test('JSON 路径与网址模板有界读取，不执行表达式且不会生成缺失ID的网址', () => {
  const value = { data: [{ id: '9007199254740993123', title: '故事甲' }, { id: 'b/c', title: '故事乙' }] };
  assert.deepEqual(jsonValues(value, '$.data[*].title'), ['故事甲', '故事乙']);
  assert.equal(jsonText(value, '$.data[0].id'), '9007199254740993123');
  assert.equal(jsonText(value.data[1], '/books/{{$.id}}', true), '/books/b%2Fc');
  assert.equal(jsonText({}, '/books/{{$.id}}', true), '');
  for (const rule of ['$..id', '$.data[?(@.id)]', '$.constructor.prototype', '$.__proto__']) assert.throws(() => validateJsonRule(rule));
  assert.throws(() => validateJsonRule('/books/{{java.ajax()}}', true));
  assert.throws(() => validateJsonRule('$.prefix/{{$.id}}', true));
  const unsafeId = JSON.parse('{"id":9007199254740993}');
  assert.throws(() => jsonText(unsafeId, '/books/{{$.id}}', true), /不安全整数/);
  assert.throws(() => jsonText(unsafeId, '$.id', true), /不安全整数/);
  assert.throws(() => jsonValues({ data: Array(20_001).fill(1) }, '$.data[*]'), /20,000/);
  assert.throws(() => normalizeSource({ ...kuwo, ruleContent: { content: '@js:java.ajax()' } }), /不支持脚本/);
});

test('JSON 书源支持搜索、详情根节点、目录模板、全文、缓存和离线重启', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vsread-json-'));
  const bookId = '9007199254740993123', firstId = '99007199254740993124', lastId = '99007199254740993125';
  let offline = false, failing = false, requests = 0;
  const fetchText: TextFetcher = async url => {
    if (offline) throw new Error('离线');
    requests++;
    const parsed = new URL(url);
    let data: unknown;
    if (parsed.pathname.endsWith('/search')) {
      assert.equal(parsed.searchParams.get('keyword'), '系统');
      assert.equal(parsed.searchParams.get('pi'), '2');
      data = [{ book_id: bookId, title: '系统故事', author_name: '作者甲' }, { title: '没有ID应忽略' }];
    } else if (parsed.pathname.endsWith('/chapters')) data = [{ book_id: bookId, chapter_id: firstId, chapter_title: '第一章' }, { book_id: bookId, chapter_id: lastId, chapter_title: '大结局' }];
    else if (parsed.pathname.endsWith(firstId)) data = { content: '<p>完整第一段。</p><p>第二段。<br>第三行。</p><script>不应出现</script>' };
    else if (parsed.pathname.endsWith(lastId)) data = { content: '最后一章。\n故事结束。' };
    else { assert(parsed.pathname.endsWith(bookId)); data = { book_id: bookId, title: '系统故事（详情）', author_name: '作者甲' }; }
    return { url, text: JSON.stringify({ code: failing ? 403 : 200, data: failing ? { content: '访问失败' } : data }) };
  };
  try {
    const library = new OnlineLibrary(root, { fetchText }); await library.load();
    const imported = await library.importSources({ json: JSON.stringify(kuwo) });
    assert.equal(imported.rejected.length, 0);
    assert.equal(imported.sources[0].ruleType, 'json');
    const hits = await library.search(imported.sources[0].id, '系统', 2);
    assert.equal(hits.length, 1);
    assert(hits[0].url.endsWith(bookId));
    const book = await library.add(hits[0]);
    assert.equal(book.title, '系统故事（详情）');
    assert.equal(book.chapters.length, 2);
    assert.equal((await library.chapter(book.id, 0)).text, '完整第一段。\n第二段。\n第三行。');
    assert.equal((await library.chapter(book.id, 1)).text, '最后一章。\n故事结束。');
    await library.saveProgress(book.id, 1, .45);
    failing = true;
    await assert.rejects(library.chapter(book.id, 1, true), /失败状态/);
    assert.equal((await library.chapter(book.id, 1)).text, '最后一章。\n故事结束。');
    await library.flush();
    const count = requests; offline = true;
    const restored = new OnlineLibrary(root, { fetchText }); await restored.load();
    assert.equal((await restored.open(book.id)).progress?.scroll, .45);
    assert.equal((await restored.chapter(book.id, 1)).cached, true);
    assert.equal(requests, count);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('HTML 搜索保留 form 内的结果，正文仍清除脚本和表单控件', () => {
  const source = normalizeSource({ ...kuwo, ruleType: 'html', jsonResponse: undefined, ruleSearch: { bookList: '.book', name: '@text', bookUrl: 'a@href' }, ruleBookInfo: {}, ruleToc: { chapterList: 'a', chapterName: '@text', chapterUrl: '@href' }, ruleContent: { content: '#content@html' } });
  const search = sourceDocument(source, '<form><div class="book"><a href="/book/1">系统故事</a></div></form>');
  assert.equal(search.rows('.book')[0].read('a@href'), '/book/1');
  const chapter = sourceDocument(source, '<form><article id="content"><p>正文第一段</p><p>正文第二段</p><button>提交</button><script>恶意代码</script></article></form>');
  assert.equal(chapter.read('#content@html', 'content'), '正文第一段\n正文第二段');
});
