import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AggregateSearchJob, BookSource, BuiltinSourceSummary, OnlineBookRecord, OnlineSearchResult, SearchSourceStatus } from '../../shared/online';
import { request } from '../bridge';
import { groupSearchResults, searchVariantKey, type SearchResultGroup } from '../searchResults';
import { Icon } from './Icon';

interface Props {
  sources: BookSource[]; builtins: BuiltinSourceSummary[]; books: OnlineBookRecord[]; pending: string;
  onUseBuiltin(id: string): Promise<BookSource | undefined>; onImport(): void; onAggregateDone(): void;
  onAdd(result: OnlineSearchResult): void; onOpen(book: OnlineBookRecord): void; onError(error: unknown): void;
}
const AGGREGATE = '__aggregate__';
const sourceState = (source: SearchSourceStatus): string => {
  switch (source.state) {
    case 'queued': return '等待中';
    case 'running': return '搜索中';
    case 'success': return source.count + ' 条结果';
    case 'error': return (source.error || '搜索失败').slice(0, 140);
    case 'cancelled': return '已停止';
  }
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export function OnlineSearch({ sources, builtins, books, pending, onUseBuiltin, onImport, onAggregateDone, onAdd, onOpen, onError }: Props) {
  const enabled = sources.filter(source => source.enabled);
  const [sourceId, setSourceId] = useState(enabled[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [searchedQuery, setSearchedQuery] = useState('');
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<OnlineSearchResult[]>([]);
  const [groups, setGroups] = useState<SearchResultGroup[]>([]);
  const [variants, setVariants] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [job, setJob] = useState<AggregateSearchJob>();
  const [aggregateError, setAggregateError] = useState('');
  const [stopped, setStopped] = useState(false);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const selectionTouched = useRef(false);
  const generation = useRef(0);
  const active = useRef(true);
  const jobId = useRef<string | undefined>(undefined);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ onAggregateDone });
  latest.current = { onAggregateDone };
  const aggregate = sourceId === AGGREGATE;
  const selected = enabled.find(source => source.id === sourceId);
  const builtin = builtins.find(source => source.sourceId === sourceId);
  const custom = enabled.filter(source => !builtins.some(item => item.sourceId === source.id));
  const sourceName = selected?.name ?? builtin?.name;
  const searchUrl = selected?.searchUrl ?? builtin?.searchUrl;
  const available = useMemo(() => {
    const disabled = new Set(sources.filter(source => !source.enabled).map(source => source.id));
    const entries = new Map<string, { id: string; name: string }>();
    for (const source of builtins) if (!disabled.has(source.sourceId)) entries.set(source.sourceId, { id: source.sourceId, name: source.name });
    for (const source of sources) if (source.enabled) entries.set(source.id, { id: source.id, name: source.name });
    return [...entries.values()];
  }, [sources, builtins]);
  const availableKey = available.map(source => source.id).join('|');
  const canSearch = aggregate ? selectedSources.length > 0 : !!sourceName && !sources.some(source => source.id === sourceId && !source.enabled);

  const cancel = (id: string) => { void request('online.searchAll.cancel', { id }).catch(() => undefined); };
  const invalidate = () => {
    clearTimeout(pollTimer.current);
    const previous = jobId.current;
    jobId.current = undefined;
    if (previous) cancel(previous);
    return ++generation.current;
  };
  const changeSource = (id: string) => {
    if (id === sourceId) return;
    invalidate();
    setSourceId(id); setResults([]); setGroups([]); setVariants({}); setJob(undefined); setAggregateError('');
    setPage(1); setSearched(false); setSearching(false); setSearchedQuery(''); setStopped(false);
  };
  useEffect(() => {
    if (sourceId !== AGGREGATE && !enabled.some(source => source.id === sourceId) && !builtins.some(source => source.sourceId === sourceId)) {
      changeSource(enabled[0]?.id ?? builtins[0]?.sourceId ?? '');
    }
  }, [sources, builtins, sourceId]);
  useEffect(() => {
    const allowed = new Set(available.map(source => source.id));
    setSelectedSources(previous => selectionTouched.current ? previous.filter(id => allowed.has(id)) : available.slice(0, 50).map(source => source.id));
  }, [availableKey]);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; invalidate(); };
  }, []);

  const accept = (snapshot: AggregateSearchJob) => {
    setJob(snapshot); setResults(snapshot.results);
    setStopped(snapshot.state === 'cancelled');
    setGroups(previous => groupSearchResults(snapshot.results, previous));
    setSearched(true); setSearchedQuery(snapshot.query); setSearching(snapshot.state === 'running');
    if (snapshot.state !== 'running') {
      jobId.current = undefined;
      latest.current.onAggregateDone();
    }
  };
  const poll = async (id: string, token: number): Promise<void> => {
    if (!active.current || generation.current !== token) return;
    try {
      const snapshot = await request('online.searchAll.status', { id });
      if (!active.current || generation.current !== token || jobId.current !== id) return;
      accept(snapshot);
      // 上一次查询完成后再计时，慢响应不会堆积轮询。
      if (snapshot.state === 'running') pollTimer.current = setTimeout(() => { void poll(id, token); }, 400);
    } catch (error) {
      if (!active.current || generation.current !== token) return;
      cancel(id); jobId.current = undefined;
      setAggregateError(errorMessage(error)); setSearching(false);
    }
  };
  const searchAll = async (keyword: string) => {
    const normalized = keyword.trim();
    if (!normalized || !selectedSources.length || pending) return;
    const token = invalidate();
    setSearching(true); setSearched(true); setSearchedQuery(normalized); setResults([]); setGroups([]); setVariants({});
    setJob(undefined); setAggregateError(''); setStopped(false);
    try {
      const snapshot = await request('online.searchAll.start', { query: normalized, sourceIds: [...selectedSources] });
      if (!active.current || generation.current !== token) { cancel(snapshot.id); return; }
      jobId.current = snapshot.id;
      accept(snapshot);
      if (snapshot.state === 'running') pollTimer.current = setTimeout(() => { void poll(snapshot.id, token); }, 400);
    } catch (error) {
      if (active.current && generation.current === token) { setAggregateError(errorMessage(error)); setSearching(false); }
    }
  };
  const stop = async () => {
    const id = jobId.current;
    clearTimeout(pollTimer.current);
    jobId.current = undefined;
    const token = ++generation.current;
    setSearching(false); setStopped(true);
    setJob(previous => previous ? { ...previous, state: 'cancelled', sources: previous.sources.map(source => source.state === 'queued' || source.state === 'running' ? { ...source, state: 'cancelled' } : source) } : previous);
    if (!id) return;
    try {
      const snapshot = await request('online.searchAll.cancel', { id });
      if (active.current && generation.current === token) accept(snapshot);
    } catch (error) { if (active.current && generation.current === token) setAggregateError(errorMessage(error)); }
  };
  const search = async (targetPage: number, keyword: string) => {
    if (aggregate) { await searchAll(keyword); return; }
    const normalized = keyword.trim();
    if (!sourceId || !normalized || searching || pending || !canSearch) return;
    const token = invalidate();
    setSearching(true);
    try {
      // 内置配置随扩展提供；首次搜索才加入本地列表，进入页面不会触发站点请求。
      const source = selected ?? (builtin && await onUseBuiltin(builtin.id));
      if (!active.current || token !== generation.current || !source) return;
      const result = await request('online.search', { sourceId: source.id, query: normalized, page: targetPage });
      if (!active.current || token !== generation.current) return;
      setResults(result); setPage(targetPage); setSearchedQuery(normalized); setSearched(true);
    } catch (error) { if (active.current && token === generation.current) onError(error); }
    finally { if (active.current && token === generation.current) setSearching(false); }
  };
  const toggleSource = (id: string, checked: boolean) => {
    selectionTouched.current = true;
    setSelectedSources(previous => checked ? previous.length < 50 && !previous.includes(id) ? [...previous, id] : previous : previous.filter(value => value !== id));
  };
  const renderResult = (result: OnlineSearchResult, title: ReactNode, key: string, extra?: ReactNode) => {
    const added = books.find(book => book.sourceId === result.sourceId && book.url === result.url);
    const adding = pending === 'add:' + result.sourceId + ':' + result.url;
    return <div className={'online-result-row' + (aggregate ? ' aggregate-result-row' : '')} key={key}>
      <span className="online-result-icon"><Icon name="book" size={20} /></span>
      <div><h3>{title}</h3><p>{result.author?.trim() || '作者未注明'} · {aggregate ? available.find(source => source.id === result.sourceId)?.name ?? job?.sources.find(source => source.sourceId === result.sourceId)?.name ?? '书源已移除' : sourceName}</p>{extra}</div>
      <button className="text-button" disabled={!!pending} onClick={() => added ? onOpen(added) : onAdd(result)}><Icon name={added ? 'book' : 'plus'} size={15} />{adding ? '添加中…' : added ? '打开阅读' : '加入书架'}</button>
    </div>;
  };

  return <section className="online-search-section" aria-label="在线搜索">
    <div className="online-section-heading"><div><h2><Icon name="search" size={18} />搜索书籍</h2><p>聚合多个书源搜索，也可选择单个书源。</p></div><button className="text-button" onClick={onImport}><Icon name="plus" size={15} />新增书源</button></div>
    <form className="online-search-form" onSubmit={event => { event.preventDefault(); void search(1, query); }}>
      <select aria-label="搜索书源" value={sourceId} onChange={event => changeSource(event.target.value)} disabled={!available.length && !sourceName}>
        <option value="" disabled>选择书源</option><option value={AGGREGATE}>聚合搜索</option>
        {builtins.length > 0 && <optgroup label="内置书源">{builtins.map(source => { const disabled = sources.some(item => item.id === source.sourceId && !item.enabled); return <option value={source.sourceId} key={source.id} disabled={disabled}>{source.name}{disabled ? '（已停用）' : ''}</option>; })}</optgroup>}
        {custom.length > 0 && <optgroup label="我的书源">{custom.map(source => <option value={source.id} key={source.id}>{source.name}</option>)}</optgroup>}
      </select>
      <div className="online-query-field"><Icon name="search" size={16} /><input aria-label="搜索书名或作者" placeholder="输入书名或作者，按 Enter 搜索" maxLength={120} value={query} onChange={event => setQuery(event.target.value)} /></div>
      <button className="primary" type="submit" disabled={!canSearch || !query.trim() || (!aggregate && searching) || !!pending}>{!aggregate && searching ? '搜索中…' : '搜索'}</button>
      {aggregate && searching && <button className="text-button" type="button" onClick={() => { void stop(); }}>停止搜索</button>}
    </form>
    {aggregate ? <>
      <fieldset className="aggregate-source-picker">
        <legend>搜索范围 · 已选 {selectedSources.length} / {available.length} 个书源</legend>
        <div className="aggregate-selection-actions"><button className="text-button" onClick={() => { selectionTouched.current = true; setSelectedSources(available.slice(0, 50).map(source => source.id)); }}>{available.length > 50 ? '选择前 50 个' : '全选'}</button><button className="text-button" onClick={() => { selectionTouched.current = true; setSelectedSources([]); }}>清空</button></div>
        <div className="aggregate-source-options">{available.map(source => <label key={source.id}><input type="checkbox" aria-label={'聚合书源 ' + source.name} checked={selectedSources.includes(source.id)} disabled={selectedSources.length >= 50 && !selectedSources.includes(source.id)} onChange={event => toggleSource(source.id, event.target.checked)} />{source.name}</label>)}</div>
      </fieldset>
      <p className="online-search-hint">各书源搜索第一页；选择单个书源可继续翻页。</p>
    </> : <p className="online-search-hint">{sourceName && !canSearch ? '此书源已停用，可在下方重新启用，或切换其他书源。' : builtin?.description ?? (selected ? '只查询所选书源，已添加的书源可在下方管理。' : '暂无可用书源，可通过“新增书源”导入配置。')}</p>}
    {aggregate && searched && <section className="aggregate-source-status" aria-label="搜索来源状态">
      <div className="aggregate-status-heading"><span>{searching ? '搜索中' : stopped || job?.state === 'cancelled' ? '已停止搜索' : aggregateError || job?.state === 'failed' ? '搜索未完成' : '搜索完成'} · {job?.sources.filter(source => source.state === 'success' || source.state === 'error').length ?? 0} / {job?.sources.length ?? selectedSources.length} 个书源</span>{!searching && (aggregateError || job?.sources.some(source => source.state === 'error')) && <button className="text-button" disabled={!canSearch || !!pending} onClick={() => { void searchAll(searchedQuery); }}>重试搜索</button>}</div>
      {job?.sources.map(source => <div className={'aggregate-status-row state-' + source.state} key={source.sourceId}><span>{source.name}</span><span>{sourceState(source)}{typeof source.elapsedMs === 'number' && ' · ' + (source.elapsedMs / 1000).toFixed(1) + ' 秒'}</span></div>)}
      {(aggregateError || job?.error) && <p className="aggregate-search-error" role="alert">{aggregateError || job?.error}</p>}
    </section>}
    {searched && <div className="online-search-results">
      <div className="online-result-summary"><span>“{searchedQuery}” · {aggregate ? '聚合搜索 · ' + groups.length + ' 本书 · ' + results.length + ' 条结果' : sourceName + ' · 第 ' + page + ' 页 · ' + results.length + ' 条结果'}</span>{!aggregate && <div><button className="text-button" disabled={searching || page <= 1} onClick={() => void search(page - 1, searchedQuery)}><Icon name="left" size={14} />上一页</button><button className="text-button" disabled={searching || !results.length || !searchUrl?.includes('{{page}}')} onClick={() => void search(page + 1, searchedQuery)}>下一页<Icon name="right" size={14} /></button></div>}</div>
      {aggregate ? groups.map(group => {
        const result = group.variants.find(result => searchVariantKey(result) === variants[group.key]) ?? group.variants[0];
        return renderResult(result, group.title, group.key, group.variants.length > 1 && <label className="aggregate-variant"><span>{group.variants.length} 个结果</span><select aria-label={'选择《' + group.title + '》的来源'} value={searchVariantKey(result)} onChange={event => setVariants(previous => ({ ...previous, [group.key]: event.target.value }))}>{group.variants.map((variant, index) => <option key={searchVariantKey(variant)} value={searchVariantKey(variant)}>{available.find(source => source.id === variant.sourceId)?.name ?? job?.sources.find(source => source.sourceId === variant.sourceId)?.name ?? '书源已移除'}{group.variants.filter(item => item.sourceId === variant.sourceId).length > 1 ? ' · ' + (index + 1) : ''}</option>)}</select></label>);
      }) : results.map(result => renderResult(result, result.title, searchVariantKey(result)))}
      {!(aggregate ? groups.length : results.length) && <p className="online-empty-note">{aggregate && searching ? '等待书源返回结果…' : aggregate && job?.sources.length && job.sources.every(source => source.state === 'error') ? '全部书源搜索失败，请查看来源状态后重试。' : '没有找到匹配的书籍。可调整关键词或切换书源重试。'}</p>}
      {aggregate && job?.truncated && <p className="online-search-hint">结果较多，可缩小搜索范围或调整关键词。</p>}
    </div>}
  </section>;
}
