import type { OnlineSearchResult } from '../shared/online';

export interface SearchResultGroup {
  key: string; title: string; author?: string; variants: OnlineSearchResult[];
}

const normalized = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
export const searchVariantKey = (result: OnlineSearchResult): string => JSON.stringify([result.sourceId, result.url]);

/** 只合并书名及作者严格相同的结果；新结果不得改变已有分组或来源的展示顺序。 */
export function groupSearchResults(results: OnlineSearchResult[], previous: SearchResultGroup[] = []): SearchResultGroup[] {
  const old = new Map(previous.map(group => [group.key, group]));
  const groups = new Map<string, SearchResultGroup>();
  const seen = new Set<string>();
  for (const result of results) {
    const variantKey = searchVariantKey(result);
    if (seen.has(variantKey)) continue;
    seen.add(variantKey);
    const key = JSON.stringify([normalized(result.title), normalized(result.author ?? '')]);
    let group = groups.get(key);
    if (!group) {
      const existing = old.get(key);
      group = { key, title: existing?.title ?? result.title, author: existing?.author ?? result.author, variants: [] };
      groups.set(key, group);
    }
    group.variants.push(result);
  }
  for (const group of groups.values()) {
    const order = new Map(old.get(group.key)?.variants.map((result, index) => [searchVariantKey(result), index]));
    group.variants.sort((a, b) => (order.get(searchVariantKey(a)) ?? Infinity) - (order.get(searchVariantKey(b)) ?? Infinity));
  }
  const order = new Map(previous.map((group, index) => [group.key, index]));
  return [...groups.values()].sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
}
