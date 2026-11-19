import test from 'node:test';
import assert from 'node:assert/strict';
import type { OnlineSearchResult } from '../src/shared/online';
import { groupSearchResults, searchVariantKey } from '../src/webview/searchResults';

const result = (source: string, url: string, title = '星海', author?: string): OnlineSearchResult => ({ sourceId: source.repeat(64), url, title, ...(author === undefined ? {} : { author }) });

test('同书分组只统一 NFKC、大小写与空白，不误合不同作者、未知作者或不同卷册', () => {
  const known = [
    result('a', 'https://a.example/book/1', 'ＡＢＣ　书名', 'Ａｕｔｈｏｒ 甲'),
    result('b', 'https://b.example/book/1', 'abc书名', 'author\t甲'),
    result('c', 'https://c.example/book/1', 'Ab C 书名', 'AUTHOR甲'),
  ];
  const anotherAuthor = result('d', 'https://d.example/book/1', 'ABC书名', 'Author乙');
  const unknown = result('e', 'https://e.example/book/1', 'ABC书名');
  const blankAuthor = result('f', 'https://f.example/book/1', 'abc 书名', '　\t');
  const punctuation = result('a', 'https://a.example/book/2', 'ABC·书名', 'author甲');
  const volumeOne = result('b', 'https://b.example/book/2', 'ABC书名（卷一）', 'author甲');
  const volumeTwo = result('c', 'https://c.example/book/2', 'ABC书名（卷二）', 'author甲');
  const groups = groupSearchResults([...known, anotherAuthor, unknown, blankAuthor, punctuation, volumeOne, volumeTwo]);
  assert.equal(groups.length, 6);
  assert.deepEqual(groups[0].variants, known);
  assert.equal(groups[0].title, known[0].title);
  assert.equal(groups[0].author, known[0].author);
  assert.deepEqual(groups[1].variants, [anotherAuthor]);
  assert.deepEqual(groups[2].variants, [unknown, blankAuthor]);
  assert.deepEqual(groups.slice(3).map(group => group.variants), [[punctuation], [volumeOne], [volumeTwo]]);
});

test('来源变体按 sourceId 与 URL 去重，跨源同网址与同源不同网址均保留', () => {
  const first = result('a', 'https://shared.example/book/1', '星海', '作者');
  const duplicate = { ...first, title: '重复数据不能新增条目', author: '错误作者' };
  const anotherSource = result('b', first.url, first.title, first.author);
  const anotherUrl = result('a', 'https://shared.example/book/2', first.title, first.author);
  const groups = groupSearchResults([first, duplicate, anotherSource, anotherUrl, { ...anotherSource }]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].variants, [first, anotherSource, anotherUrl]);
  assert.equal(searchVariantKey(first), searchVariantKey(duplicate));
  assert.notEqual(searchVariantKey(first), searchVariantKey(anotherSource));
  assert.notEqual(searchVariantKey(first), searchVariantKey(anotherUrl));
});

test('增量轮询顺序变化不移动已有书籍与来源，选中的 variantKey 始终对应原来源', () => {
  const a1 = result('a', 'https://a.example/book/1', '星海', '作者甲');
  const a2 = result('b', 'https://b.example/book/1', '星 海', '作者甲');
  const bookB = result('a', 'https://a.example/book/2', '远航', '作者乙');
  const previous = groupSearchResults([a1, bookB, a2]);
  const previousSnapshot = structuredClone(previous);
  const selected = searchVariantKey(a2);
  const newVariant = result('c', 'https://c.example/book/1', '星海', '作者甲');
  const newBook = result('d', 'https://d.example/book/3', '归途', '作者丙');
  const incoming = [newBook, newVariant, bookB, a2, a1];
  const incomingSnapshot = structuredClone(incoming);

  const groups = groupSearchResults(incoming, previous);
  assert.deepEqual(groups.map(group => group.title), ['星海', '远航', '归途']);
  assert.deepEqual(groups[0].variants, [a1, a2, newVariant]);
  assert.equal(groups[0].variants.find(item => searchVariantKey(item) === selected), a2);
  assert.equal(groups[0].variants.findIndex(item => searchVariantKey(item) === selected), 1);
  assert.deepEqual(previous, previousSnapshot);
  assert.deepEqual(incoming, incomingSnapshot);

  const last = result('e', 'https://e.example/book/1', '星海', '作者甲');
  const nextPoll = groupSearchResults([last, newBook, a2, bookB, newVariant, a1], groups);
  assert.deepEqual(nextPoll.map(group => group.key), groups.map(group => group.key));
  assert.deepEqual(nextPoll[0].variants, [a1, a2, newVariant, last]);
  assert.equal(nextPoll[0].variants.find(item => searchVariantKey(item) === selected), a2);
  assert.deepEqual(groupSearchResults([], nextPoll), []);
});
