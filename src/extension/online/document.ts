import type { BookSource } from '../../shared/online';
import { extract, loadHtml, select } from './rules';
import { jsonText, jsonValues } from './jsonRules';

type Mode = 'text' | 'url' | 'content';
export interface SourceElement { read(rule?: string, mode?: Mode): string }
export interface SourceDocument extends SourceElement {
  rows(rule: string): SourceElement[];
  scope(rule?: string): SourceElement;
}

/** 把 HTML / JSON 的字段读取差异收在适配器内，书库仍共用缓存和位置逻辑。 */
export function sourceDocument(source: BookSource, text: string): SourceDocument {
  if (source.ruleType !== 'json') {
    const $ = loadHtml(text);
    const element = (context: ReturnType<typeof $>): SourceElement => ({ read: (rule, mode) => extract($, context, rule, mode === 'content') });
    const root = element($.root());
    return {
      ...root,
      scope: () => root,
      rows: rule => {
        const nodes = select($, rule);
        if (nodes.length > 20_000) throw new Error('目录超过 20,000 章，已停止解析');
        return nodes.toArray().map(node => element($(node)));
      },
    };
  }
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('书源返回的内容不是有效 JSON'); }
  // HTTP 200 仍可能表示业务失败，先验证来源约定，避免错误消息覆盖已缓存正文。
  if (source.jsonResponse && jsonValues(data, source.jsonResponse.successPath)[0] !== source.jsonResponse.successValue) throw new Error('书源接口返回失败状态，请稍后重试');
  const element = (value: unknown): SourceElement => ({ read: (rule, mode) => {
    if (!rule) return '';
    const result = jsonText(value, rule, mode === 'url');
    if (mode !== 'content') return result.replace(/\s+/g, ' ').trim();
    if (/<(?:p|br|div|section|article|h[1-6])\b/i.test(result)) {
      const $ = loadHtml(result);
      return extract($, $.root(), '@text', true);
    }
    return result.replace(/\r\n?/g, '\n').trim();
  } });
  return {
    ...element(data),
    scope: rule => element(rule ? jsonValues(data, rule)[0] : data),
    rows: rule => {
      const rows = jsonValues(data, rule).flatMap(value => Array.isArray(value) ? value : [value]);
      if (rows.length > 20_000) throw new Error('目录超过 20,000 章，已停止解析');
      return rows.map(element);
    },
  };
}
