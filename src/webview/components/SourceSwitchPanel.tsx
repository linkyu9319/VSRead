import { useEffect, useMemo, useRef, useState } from 'react';
import type { AggregateSearchJob, BookSource, BuiltinSourceSummary, OnlineBookRecord, OnlineSearchResult } from '../../shared/online';
import { request } from '../bridge';
import { Icon } from './Icon';

interface Props {
  book: OnlineBookRecord;
  sources: BookSource[];
  builtins: BuiltinSourceSummary[];
  busy: boolean;
  onSwitch(result: OnlineSearchResult): void;
  onSearchDone(): void;
  onClose(): void;
  onError(error: unknown): void;
}

function norm(text: string | undefined): string {
  return (text ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '');
}

export function SourceSwitchPanel({ book, sources, builtins, busy, onSwitch, onSearchDone, onClose, onError }: Props) {
  const [job, setJob] = useState<AggregateSearchJob>();
  const [starting, setStarting] = useState(false);
  const active = useRef(true);
  const jobIdRef = useRef<string | undefined>(undefined);

  const searchable = useMemo(() => {
    const map = new Map<string, string>();
    const configured = new Set(sources.map(source => source.id));
    for (const source of sources) if (source.enabled) map.set(source.id, source.name);
    for (const builtin of builtins) if (!configured.has(builtin.sourceId)) map.set(builtin.sourceId, builtin.name);
    return map;
  }, [sources, builtins]);

  const startSearch = () => {
    const sourceIds = [...searchable.keys()].slice(0, 50);
    if (!sourceIds.length) return;
    const previous = jobIdRef.current;
    if (previous) {
      jobIdRef.current = undefined;
      void request('online.searchAll.cancel', { id: previous }).catch(() => undefined);
    }
    setStarting(true);
    void request('online.searchAll.start', { query: book.title, sourceIds })
      .then(started => {
        if (!active.current) {
          void request('online.searchAll.cancel', { id: started.id }).catch(() => undefined);
          return;
        }
        jobIdRef.current = started.id;
        setJob(started);
      })
      .catch(error => { if (active.current) onError(error); })
      .finally(() => { if (active.current) setStarting(false); });
  };

  useEffect(() => {
    active.current = true;
    startSearch();
    return () => {
      active.current = false;
      const id = jobIdRef.current;
      jobIdRef.current = undefined;
      if (id) void request('online.searchAll.cancel', { id }).catch(() => undefined);
    };
  }, [book.id, book.title]);

  useEffect(() => {
    if (!job || job.state !== 'running') return;
    const timer = setTimeout(() => {
      void request('online.searchAll.status', { id: job.id })
        .then(next => {
          if (!active.current || jobIdRef.current !== job.id) return;
          setJob(next);
          if (next.state !== 'running') {
            jobIdRef.current = undefined;
            onSearchDone();
          }
        })
        .catch(() => undefined);
    }, 350);
    return () => clearTimeout(timer);
  }, [job, onSearchDone]);

  const candidates = useMemo(() => {
    const targetTitle = norm(book.title);
    const targetAuthor = norm(book.author);
    return (job?.results ?? [])
      .filter(item => !(item.sourceId === book.sourceId && item.url === book.url))
      .map(item => {
        const sameTitle = norm(item.title) === targetTitle;
        const sameAuthor = !!targetAuthor && norm(item.author) === targetAuthor;
        const score = (sameTitle ? 4 : 0) + (sameAuthor ? 2 : 0) + (norm(item.title).includes(targetTitle) ? 1 : 0);
        return { item, score, sourceName: searchable.get(item.sourceId) ?? job?.sources.find(s => s.sourceId === item.sourceId)?.name ?? '在线书源' };
      })
      .sort((a, b) => b.score - a.score);
  }, [book.author, book.sourceId, book.title, book.url, job, searchable]);

  const doneCount = job ? job.sources.filter(s => s.state !== 'queued' && s.state !== 'running').length : 0;
  const errorSources = job ? job.sources.filter(s => s.state === 'error') : [];
  const allFailed = !!job && (job.state === 'failed' || (job.state === 'completed' && job.sources.length > 0 && errorSources.length === job.sources.length));

  return <aside className="source-switch-panel" aria-label="换源选择">
    <div className="panel-heading">
      <span>换源 · {book.title}</span>
      <div>
        <button className="text-button" disabled={starting || busy || !searchable.size} onClick={startSearch}>重新搜索</button>
        <button className="icon-button" aria-label="关闭换源面板" onClick={onClose}><Icon name="close" size={15} /></button>
      </div>
    </div>
    {!searchable.size ? <p className="panel-message muted">没有可用的在线书源，请先在“在线书源”启用或导入书源。</p>
      : <>
        <p className={`source-switch-status${allFailed ? ' aggregate-search-error' : ''}`} role="status">
          {starting ? '正在向可用书源发起搜索…'
            : job?.state === 'running' ? `搜索中（${doneCount}/${job.sources.length} 个书源）…`
            : job?.state === 'failed' ? `搜索失败：${job.error || '请稍后重试'}`
            : allFailed ? `全部 ${job!.sources.length} 个书源搜索失败，请检查网络或稍后重试`
            : job ? `已检索 ${job.sources.length} 个书源，找到 ${candidates.length} 个候选来源${errorSources.length ? `（${errorSources.length} 个书源失败）` : ''}` : ''}
        </p>
        <div className="source-switch-list">
          {candidates.length ? candidates.map(({ item, sourceName }) => <div className="source-switch-row" key={`${item.sourceId}:${item.url}`}>
            <div>
              <strong>{sourceName}</strong>
              <span>{item.title}{item.author ? ` · ${item.author}` : ''}</span>
            </div>
            <button className="text-button" disabled={busy} onClick={() => onSwitch(item)}>切换至此源</button>
          </div>) : !starting && job?.state !== 'running' && (
            allFailed
              ? <div className="source-switch-errors">
                <p className="panel-message aggregate-search-error">本次换源搜索未能从任何书源获取结果：</p>
                {errorSources.slice(0, 5).map(source => <p className="panel-message muted" key={source.sourceId}>{source.name}：{source.error || '请求失败'}</p>)}
              </div>
              : <p className="panel-message muted">未找到其他来源的同名书籍{errorSources.length ? `（另有 ${errorSources.length} 个书源搜索失败，可点击重新搜索）` : ''}。</p>
          )}
        </div>
      </>}
  </aside>;
}
