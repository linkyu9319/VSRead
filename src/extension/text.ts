import iconv from 'iconv-lite';
import type { TextEncoding, TextIndex } from '../shared/model';

export function decodeText(bytes: Buffer, requested: TextEncoding = 'auto'): { text: string; encoding: string } {
  let encoding: string = requested;
  if (requested === 'auto') {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
    else {
      // GBK 是 GB18030 的子集；先严格验证 UTF-8，避免把中文遗留编码解成乱码。
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); encoding = 'utf-8'; }
      catch { encoding = 'gb18030'; }
    }
  }
  const text = iconv.decode(bytes, encoding).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new Error('TXT 文件没有可阅读的内容');
  return { text, encoding };
}

const HEADING = /^\s*(?:第[零〇一二三四五六七八九十百千万两\d０-９]+[章节卷回部篇集]|(?:chapter|part)\s+[\divxlcdm]+\b|序章|序言|楔子|前言|后记|尾声|终章)[^\n]{0,70}$/i;
const PART_SIZE = 12_000;

/** 返回稳定的 UTF-16 字符偏移；超长章节拆成小块，Webview 始终只渲染一块。 */
export function indexText(text: string, encoding: string): TextIndex {
  const starts: { start: number; title: string; chapter: boolean }[] = [];
  const lines = /[^\n]+/g;
  let match: RegExpExecArray | null;
  while ((match = lines.exec(text))) {
    if (HEADING.test(match[0]) && match[0].trim().length <= 80) {
      starts.push({ start: match.index, title: match[0].trim(), chapter: true });
    }
  }
  if (!starts.length || starts[0].start > 0) starts.unshift({ start: 0, title: starts.length ? '卷首' : '正文', chapter: true });
  const parts: TextIndex['parts'] = [];
  starts.forEach((section, i) => {
    const end = starts[i + 1]?.start ?? text.length;
    let cursor = section.start;
    let continuation = 0;
    while (cursor < end) {
      let next = Math.min(cursor + PART_SIZE, end);
      if (next < end) {
        const newline = text.lastIndexOf('\n', next);
        if (newline > cursor + PART_SIZE / 2) next = newline + 1;
        // 不在 UTF-16 代理对中间切块，确保字符偏移可以精确往返。
        else if (/^[\uDC00-\uDFFF]$/.test(text[next])) next--;
      }
      parts.push({ index: parts.length, title: section.title + (continuation ? ` · 续 ${continuation}` : ''), start: cursor, end: next, chapter: continuation === 0 });
      cursor = next;
      continuation++;
    }
  });
  return { encoding, length: text.length, parts };
}
