import { useMemo, useState } from 'react';
import type { TocItem } from '../../shared/model';
import { Icon } from './Icon';

export function Contents({ items, onNavigate }: { items: TocItem[]; onNavigate(target: string): void }) {
  const [filter, setFilter] = useState('');
  const filtered = useMemo(() => {
    const flatten = (nodes: TocItem[], depth = 0): { item: TocItem; depth: number }[] => nodes.flatMap(item => [{ item, depth }, ...flatten(item.children ?? [], depth + 1)]);
    return flatten(items).filter(({ item }) => item.label.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  }, [items, filter]);
  return <aside className="contents-panel" aria-label="章节目录">
    <div className="panel-heading">目录 <span>{items.length}</span></div>
    <div className="filter-field"><Icon name="search" size={15} /><input aria-label="筛选目录" placeholder="查找章节…" value={filter} onChange={event => setFilter(event.target.value)} /></div>
    <nav>{filtered.length ? filtered.map(({ item, depth }, index) => <button key={`${item.id}-${index}`} style={{ paddingLeft: 16 + Math.min(depth, 4) * 14 }} onClick={() => onNavigate(item.id)} title={item.label}>{item.label}</button>) : <p className="muted panel-message">{items.length ? '没有匹配的章节' : '正在读取目录…'}</p>}</nav>
  </aside>;
}
