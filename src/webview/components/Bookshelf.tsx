import { useEffect, useRef, useState } from 'react';
import type { BookRecord } from '../../shared/model';
import type { BookSource, OnlineBookRecord } from '../../shared/online';
import { formatPercentage } from '../../shared/format';
import { request } from '../bridge';
import { Icon } from './Icon';
import { OnlineBookCard } from './OnlineBookCard';

export function Bookshelf({ books, onOpen, onOpenOnline, onShowSources, onImport, onRemove, onError, busy }: {
  books: BookRecord[]; onOpen(id: string): void; onOpenOnline(id: string): void; onShowSources(): void;
  onImport(): void; onRemove(id: string): void; onError(error: unknown): void; busy: boolean;
}) {
  const [onlineBooks, setOnlineBooks] = useState<OnlineBookRecord[]>([]);
  const [sources, setSources] = useState<BookSource[]>([]);
  const [loadingOnline, setLoadingOnline] = useState(true);
  const [pending, setPending] = useState('');
  const active = useRef(true);
  const pendingRef = useRef(false);
  useEffect(() => {
    active.current = true;
    // 返回书架时重新读取本地索引，在线阅读刚保存的位置与缓存立即可见。
    void Promise.allSettled([request('online.list', undefined), request('sources.list', undefined)]).then(([bookResult, sourceResult]) => {
      if (!active.current) return;
      if (bookResult.status === 'fulfilled') setOnlineBooks(bookResult.value);
      else onError(bookResult.reason);
      if (sourceResult.status === 'fulfilled') setSources(sourceResult.value);
      else onError(sourceResult.reason);
      setLoadingOnline(false);
    });
    return () => { active.current = false; };
  }, [onError]);
  const removeOnline = async (id: string) => {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(id);
    try { const next = await request('online.remove', { id }); if (active.current) setOnlineBooks(next); }
    catch (error) { if (active.current) onError(error); }
    finally { pendingRef.current = false; if (active.current) setPending(''); }
  };
  const recent = [
    ...books.map(book => ({ kind: 'local' as const, book, updatedAt: book.progress?.updatedAt ?? book.importedAt })),
    ...onlineBooks.map(book => ({ kind: 'online' as const, book, updatedAt: book.progress?.updatedAt ?? book.addedAt })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return <section className="shelf-page" aria-label="我的书架">
    <div className="shelf-intro"><span className="eyebrow">A QUIET CORNER IN YOUR IDE</span><h1>代码之间，读几页。</h1><p>关上喧嚣，把故事留在本地。</p></div>
    <div className="shelf-heading"><div><h2>我的书架 <span>{recent.length.toString().padStart(2, '0')}</span></h2><p className="shelf-summary">本地 {books.length} 本 · 在线 {onlineBooks.length} 本</p></div><div className="shelf-actions"><button className="text-button" onClick={onShowSources}><Icon name="search" size={16} />搜索在线书籍</button><button className="primary" onClick={onImport} disabled={busy}><Icon name="plus" size={16} />{busy ? '导入中…' : '导入书籍'}</button></div></div>
    {loadingOnline && <p className="shelf-loading" role="status">正在读取在线书籍…</p>}
    {!recent.length && !loadingOnline ? <div className="empty-shelf"><div className="empty-icon"><Icon name="book" size={36} /></div><h2>下一段故事，从这里开始</h2><p>导入本地 EPUB、TXT 或 PDF，或从在线书源加入书籍。<br />阅读进度自动保存，随时接着读。</p><button className="primary" onClick={onImport} disabled={busy}><Icon name="plus" />选择电子书</button><small>本地书籍与在线缓存 · 无需账号</small></div> : <div className="book-list">{recent.map((item, i) => {
      if (item.kind === 'online') return <OnlineBookCard key={`online:${item.book.id}`} book={item.book} sourceName={sources.find(source => source.id === item.book.sourceId)?.name ?? '书源已移除'} busy={busy || !!pending} onOpen={() => onOpenOnline(item.book.id)} onRemove={() => { void removeOnline(item.book.id); }} />;
      const book = item.book;
      return <div className="book-card" data-book-kind="local" key={`local:${book.id}`}>
      <button className="book-open" onClick={() => onOpen(book.id)} aria-label={`阅读 ${book.title}`}>
        <div className={`book-cover cover-${i % 4}`}>{book.cover ? <img src={book.cover} alt={`${book.title} 封面`} /> : <><Icon name="book" size={28} /><span>{book.format.toUpperCase()}</span></>}</div>
        <div className="book-details"><span className="book-format">{book.format.toUpperCase()}</span><h3>{book.title}</h3><p>{book.author || '本地藏书'}</p><div className="book-progress"><span style={{ width: `${(book.progress?.percentage ?? 0) * 100}%` }} /></div><small>{book.progress ? `已读 ${formatPercentage(book.progress.percentage)} · 继续阅读` : '尚未开始 · 翻开第一页'}</small></div><Icon name="right" />
      </button><button className="icon-button remove-book" title={`移除 ${book.title}`} aria-label={`移除 ${book.title}`} onClick={() => onRemove(book.id)}><Icon name="trash" size={15} /></button>
    </div>;
    })}</div>}
    <footer className="shelf-footer"><span className="status-dot" /> 书架、进度与已缓存正文，仅保存在这台设备。</footer>
  </section>;
}
