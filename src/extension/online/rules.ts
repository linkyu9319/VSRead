import { createHash } from 'node:crypto';
import { load, type CheerioAPI, type Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { BookSource } from '../../shared/online';
import { isRecord } from '../../shared/validation';
import { validateHttpUrl } from './network';

export const stableId = (value: string): string => createHash('sha256').update(value).digest('hex');
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

function required(value: unknown, name: string): string {
  const result = string(value);
  if (!result || result.length > 4096) throw new Error(`${name} 缺失或过长`);
  return result;
}

function selectorPart(value: string): string {
  return value.replace(/(^|\s)(class|id|tag)\.([\w-]+)(?:\.(\d+))?/g, (_match, space, kind, name, index) => {
    const selector = kind === 'class' ? '.' + name : kind === 'id' ? '#' + name : name;
    return space + selector + (index === undefined ? '' : `:eq(${index})`);
  });
}

export function parseRule(rule: string): { selector: string; attribute: string } {
  if (rule.length > 4096 || /@js:|<\/?js>|javascript:|\$\.|\{\{|\|\||&&|##|^\s*\//i.test(rule)) throw new Error('仅支持声明式 HTML / CSS 规则，不支持脚本、JSONPath、XPath 或规则表达式');
  const parts = rule.split('@');
  let attribute = 'text';
  if (parts.length > 1) {
    attribute = parts.pop()!.trim();
    if (!/^(text|textNodes|html|href|src|content|title|data-[\w-]+)$/i.test(attribute)) throw new Error(`不支持的规则提取方式：${attribute}`);
  }
  const selector = selectorPart(parts.filter(Boolean).join(' ').trim());
  try { if (selector) load('<div></div>')(selector); } catch { throw new Error(`无效的 CSS 选择器：${selector}`); }
  return { selector, attribute };
}

function rule(value: unknown, name: string, optional = false): string | undefined {
  const text = string(value);
  if (!text && optional) return undefined;
  required(text, name);
  parseRule(text);
  return text;
}

/** 独立实现 Legado 字段映射，不加载上游脚本引擎或执行书源内代码。 */
export function normalizeSource(input: unknown): BookSource {
  if (!isRecord(input)) throw new Error('书源必须是 JSON 对象');
  if (input.bookSourceType !== undefined && input.bookSourceType !== 0) throw new Error('当前仅支持文字书源');
  const native = typeof input.baseUrl === 'string';
  const name = required(native ? input.name : input.bookSourceName, '书源名称').slice(0, 200);
  const base = validateHttpUrl(required(native ? input.baseUrl : input.bookSourceUrl, '书源网址'));
  base.hash = '';
  const searchUrl = required(input.searchUrl, '搜索地址');
  if (/\{\{(?!\s*(key|page)\s*\}\})|@js:|<js>|,\s*\{|\$\{|javascript:/i.test(searchUrl)) throw new Error('搜索地址仅支持 GET 与 {{key}} / {{page}} 模板');
  const resolvedSearch = validateHttpUrl(new URL(searchUrl.replace(/\{\{\s*key\s*\}\}/g, 'test').replace(/\{\{\s*page\s*\}\}/g, '1'), base).href);
  if (resolvedSearch.origin !== base.origin) throw new Error('搜索地址必须与书源网址同源');
  for (const field of ['loginUrl', 'loginUi', 'loginCheckJs', 'jsLib', 'header']) {
    if (input[field] && String(input[field]).trim()) throw new Error(`当前不支持 ${field}，请使用公开的声明式 HTML 书源`);
  }
  const search = record(native ? input.search : input.ruleSearch);
  const bookInfo = record(native ? input.bookInfo : input.ruleBookInfo);
  const toc = record(native ? input.toc : input.ruleToc);
  const content = record(native ? input.content : input.ruleContent);
  for (const [name, value] of Object.entries({ nextTocUrl: toc.nextTocUrl, nextContentUrl: content.nextContentUrl, contentReplace: content.replaceRegex })) {
    if (value) throw new Error(`当前不支持 ${name}，不能完整读取该书源`);
  }
  const source: BookSource = {
    id: stableId(base.href + '\n' + name), name, baseUrl: base.href,
    enabled: input.enabled !== false,
    searchUrl,
    search: {
      bookList: rule(search.bookList, '搜索列表')!, name: rule(search.name, '搜索书名')!,
      bookUrl: rule(search.bookUrl, '书籍地址')!, author: rule(search.author, '搜索作者', true),
    },
    bookInfo: {
      name: rule(bookInfo.name, '详情书名', true), author: rule(bookInfo.author, '详情作者', true), tocUrl: rule(bookInfo.tocUrl, '目录地址', true),
    },
    toc: { chapterList: rule(toc.chapterList, '章节列表')!, chapterName: rule(toc.chapterName, '章节名称')!, chapterUrl: rule(toc.chapterUrl, '章节地址')! },
    content: { content: rule(content.content, '正文规则')! },
  };
  return source;
}

export function loadHtml(html: string): CheerioAPI {
  const $ = load(html);
  $('script,style,noscript,iframe,object,embed,form').remove();
  return $;
}
export function select($: CheerioAPI, selector: string): Cheerio<AnyNode> {
  const parsed = parseRule(selector);
  return parsed.selector ? $(parsed.selector) : $.root();
}
export function extract($: CheerioAPI, context: Cheerio<AnyNode>, rule: string | undefined, content = false): string {
  if (!rule) return '';
  const { selector, attribute } = parseRule(rule);
  const selected = (selector ? context.find(selector) : context).first();
  if (!selected.length) return '';
  if (attribute !== 'text' && attribute !== 'html' && attribute !== 'textNodes') return selected.attr(attribute) ?? '';
  if (!content && attribute !== 'html') return selected.text().replace(/\s+/g, ' ').trim();
  const clone = selected.clone();
  clone.find('script,style,noscript,iframe,object,embed,form,nav,header,footer').remove();
  clone.find('br').replaceWith('\n');
  clone.find('p,div,li,section,article,h1,h2,h3,blockquote').each((_index, node) => { $(node).append('\n'); });
  return clone.text().replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function resolveSourceUrl(source: BookSource, input: string, base = source.baseUrl): string {
  const url = validateHttpUrl(new URL(input, base).href);
  if (url.origin !== new URL(source.baseUrl).origin) throw new Error('书籍与章节地址必须和书源同源');
  // hash 可用于同页章节定位；网络请求仍由原 URL 决定，缓存标识保留它。
  return url.href;
}
