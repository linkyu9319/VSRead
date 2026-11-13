import { useEffect, useRef, useState } from 'react';
import type { BookSource, OnlineBookRecord, OnlineSearchResult } from '../../shared/online';
import { request } from '../bridge';
import { Icon } from './Icon';

interface Props {
  sources: BookSource[]; books: OnlineBookRecord[]; pending: string;
  onAdd(result: OnlineSearchResult): void; onOpen(book: OnlineBookRecord): void; onError(error: unknown): void;
}

export function OnlineSearch({ sources, books, pending, onAdd, onOpen, onError }: Props) {
  const enabled = sources.filter(source => source.enabled);
  const [sourceId, setSourceId] = useState(enabled[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [searchedQuery, setSearchedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<OnlineSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const generation = useRef(0);
  const active = useRef(true);
  const selected = enabled.find(source => source.id === sourceId);

  useEffect(() => {
    if (!enabled.some(source => source.id === sourceId)) setSourceId(enabled[0]?.id ?? '');
  }, [sources, sourceId]);
  useEffect(() => {
    generation.current++;
    setResults([]); setPage(1); setSearched(false); setSearching(false); setSearchedQuery('');
  }, [sourceId]);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; }; }, []);

  const search = async (targetPage: number, keyword: string) => {
    const normalized = keyword.trim();
    if (!sourceId || !normalized || searching) return;
    const token = ++generation.current;
    setSearching(true);
    try {
      const result = await request('online.search', { sourceId, query: normalized, page: targetPage });
      if (!active.current || token !== generation.current) return;
      setResults(result); setPage(targetPage); setSearchedQuery(normalized); setSearched(true);
    } catch (error) { if (active.current && token === generation.current) onError(error); }
    finally { if (active.current && token === generation.current) setSearching(false); }
  };

  return <section className="online-search-section" aria-label="在线搜索">
    <div className="online-section-heading"><div><h2>搜索书籍</h2><p>只向当前选择的书源发起查询。</p></div></div>
    <form className="online-search-form" onSubmit={event => { event.preventDefault(); void search(1, query); }}><select aria-label="搜索书源" value={sourceId} onChange={event => setSourceId(event.target.value)} disabled={!enabled.length}><option value="" disabled>选择已启用的书源</option>{enabled.map(source => <option value={source.id} key={source.id}>{source.name}</option>)}</select><div className="online-query-field"><Icon name="search" size={16} /><input aria-label="搜索书名或作者" placeholder="输入书名或作者" maxLength={120} value={query} onChange={event => setQuery(event.target.value)} /></div><button className="primary" type="submit" disabled={!selected || !query.trim() || searching}>{searching ? '搜索中…' : '搜索'}</button></form>
    {searched && <div className="online-search-results"><div className="online-result-summary"><span>“{searchedQuery}” · {selected?.name} · 第 {page} 页 · {results.length} 条结果</span><div><button className="text-button" disabled={searching || page <= 1} onClick={() => void search(page - 1, searchedQuery)}><Icon name="left" size={14} />上一页</button><button className="text-button" disabled={searching || !results.length || !selected?.searchUrl.includes('{{page}}')} onClick={() => void search(page + 1, searchedQuery)}>下一页<Icon name="right" size={14} /></button></div></div>
      {results.length ? results.map(result => {
        const added = books.find(book => book.sourceId === result.sourceId && book.url === result.url);
        const adding = pending === `add:${result.sourceId}:${result.url}`;
        return <div className="online-result-row" key={`${result.sourceId}:${result.url}`}><span className="online-result-icon"><Icon name="book" size={20} /></span><div><h3>{result.title}</h3><p>{result.author || '作者未注明'} · {selected?.name}</p></div><button className="text-button" disabled={!!pending} onClick={() => added ? onOpen(added) : onAdd(result)}><Icon name={added ? 'book' : 'plus'} size={15} />{adding ? '添加中…' : added ? '打开阅读' : '加入书架'}</button></div>;
      }) : <p className="online-empty-note">没有找到匹配的书籍。可调整关键词或切换书源重试。</p>}
    </div>}
  </section>;
}
