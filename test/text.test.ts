import test from 'node:test';
import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { decodeText, indexText } from '../src/extension/text';

test('UTF-8、GBK、GB18030、UTF-16 BOM 自动识别且统一换行', () => {
  const content = '第一章 初见\r\n中文长篇小说。';
  for (const encoding of ['utf8', 'gbk', 'gb18030', 'utf16-le', 'utf16-be']) {
    const bytes = iconv.encode(content, encoding, { addBOM: encoding.startsWith('utf16') });
    assert.equal(decodeText(bytes).text, content.replace(/\r\n/g, '\n'), encoding);
  }
  const rare = '第一章 𠀀与世界';
  assert.equal(decodeText(iconv.encode(rare, 'gb18030')).text, rare);
  assert.throws(() => decodeText(Buffer.from(' \n')), /没有可阅读/);
});
test('章节识别、长章节分块及字符偏移可以无损重组', () => {
  const content = '序言\n故事开始。\n第一章 星河\n' + '你好宇宙🚀。'.repeat(20_000) + '\n第２章 归来\n结束。\nChapter III Home\nHello.';
  const index = indexText(content, 'utf-8');
  assert(index.parts.length > 10);
  assert(index.parts.some(part => part.title === '第一章 星河'));
  assert(index.parts.some(part => part.title === '第２章 归来'));
  assert(index.parts.some(part => part.title === 'Chapter III Home'));
  assert.equal(index.parts.map(part => content.slice(part.start, part.end)).join(''), content);
  for (const [i, part] of index.parts.entries()) {
    assert(part.end - part.start <= 12_000);
    assert.equal(part.index, i);
    assert(!/^[\uDC00-\uDFFF]/.test(content.slice(part.start)));
    if (i) assert.equal(part.start, index.parts[i - 1].end);
  }
});
test('没有章节标题的千万字正文依然按块读取', () => {
  const index = indexText('长篇正文。'.repeat(2_000_000), 'utf-8');
  assert.equal(index.length, 10_000_000);
  assert(index.parts.length > 800);
  assert.equal(index.parts[0].title, '正文');
});
