import { useEffect, useMemo, useRef, useState } from 'react';
import type { BookRecord } from '../../shared/model';
import type { BookSource, OnlineBookRecord } from '../../shared/online';
import { formatPercentage } from '../../shared/format';
import { request } from '../bridge';
import { Icon } from './Icon';
import { OnlineBookCard } from './OnlineBookCard';

type ShelfFilter = 'all' | 'local' | 'online' | 'epub' | 'txt' | 'pdf' | 'pinned' | 'updated';
type ShelfSort = 'recent' | 'title' | 'progress' | 'added';

type ShelfItem =
  | { kind: 'local'; book: BookRecord; updatedAt: string; addedAt: string; progress: number; pinned: boolean; newChapters: number }
  | { kind: 'online'; book: OnlineBookRecord; updatedAt: string; addedAt: string; progress: number; pinned: boolean; newChapters: number };

export function Bookshelf({ books, onOpen, onOpenOnline, onShowSources, onImport, onPin, onRemove, onError, busy }: {
  books: BookRecord[]; onOpen(id: string): void; onOpenOnline(id: string): void; onShowSources(): void;
  onImport(): void; onPin(id: string, pinned: boolean): void; onRemove(id: string): void; onError(error: unknown): void; busy: boolean;
}) {
  const [onlineBooks, setOnlineBooks] = useState<OnlineBookRecord[]>([]);
  const [sources, setSources] = useState<BookSource[]>([]);
  const [loadingOnline, setLoadingOnline] = useState(true);
  const [pending, setPending] = useState('');
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateNotice, setUpdateNotice] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ShelfFilter>('all');
  const [sort, setSort] = useState<ShelfSort>('recent');
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
  const pinOnline = async (book: OnlineBookRecord) => {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(book.id);
    try {
      const updated = await request('online.pin', { id: book.id, pinned: !book.pinned });
      if (active.current) setOnlineBooks(previous => previous.map(item => item.id === updated.id ? updated : item));
    } catch (error) { if (active.current) onError(error); }
    finally { pendingRef.current = false; if (active.current) setPending(''); }
  };
  const checkOnlineUpdates = async () => {
    if (checkingUpdates || !onlineBooks.length) return;
    setCheckingUpdates(true); setUpdateNotice('');
    try {
      const summary = await request('online.checkUpdates', undefined);
      if (!active.current) return;
      setOnlineBooks(summary.books);
      const totalAdded = summary.updated.reduce((sum, item) => sum + item.added, 0);
      const parts = [`已检查 ${summary.checked} 本`];
      if (summary.updated.length) parts.push(`${summary.updated.length} 本有更新（共 +${totalAdded} 章）`);
      else parts.push('暂无新章节');
      if (summary.skipped) parts.push(`跳过 ${summary.skipped} 本`);
      if (summary.failed.length) parts.push(`失败 ${summary.failed.length} 本`);
      setUpdateNotice(parts.join(' · '));
    } catch (error) { if (active.current) onError(error); }
    finally { if (active.current) setCheckingUpdates(false); }
  };

  const allItems = useMemo<ShelfItem[]>(() => [
    ...books.map(book => ({
      kind: 'local' as const, book,
      updatedAt: book.progress?.updatedAt ?? book.importedAt,
      addedAt: book.importedAt,
      progress: book.progress?.percentage ?? 0,
      pinned: book.pinned === true,
      newChapters: 0,
    })),
    ...onlineBooks.map(book => ({
      kind: 'online' as const, book,
      updatedAt: book.progress?.updatedAt ?? book.addedAt,
      addedAt: book.addedAt,
      progress: book.chapters.length ? ((book.progress?.chapter ?? 0) + (book.progress?.scroll ?? 0)) / book.chapters.length : 0,
      pinned: book.pinned === true,
      newChapters: book.newChapters ?? 0,
    })),
  ], [books, onlineBooks]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = allItems.filter(item => {
      if (filter === 'local' && item.kind !== 'local') return false;
      if (filter === 'online' && item.kind !== 'online') return false;
      if ((filter === 'epub' || filter === 'txt' || filter === 'pdf') && (item.kind !== 'local' || item.book.format !== filter)) return false;
      if (filter === 'pinned' && !item.pinned) return false;
      if (filter === 'updated' && item.newChapters <= 0) return false;
      if (!needle) return true;
      const author = item.book.author ?? '';
      return item.book.title.toLocaleLowerCase().includes(needle) || author.toLocaleLowerCase().includes(needle);
    });
    return filtered.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (sort === 'title') return a.book.title.localeCompare(b.book.title, 'zh-CN');
      if (sort === 'progress') return b.progress - a.progress || b.updatedAt.localeCompare(a.updatedAt);
      if (sort === 'added') return b.addedAt.localeCompare(a.addedAt);
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [allItems, filter, query, sort]);

  const hasFilter = !!query.trim() || filter !== 'all';

  return <section className="shelf-page" aria-label="我的书架">
    <div className="shelf-intro"><span className="eyebrow">A QUIET CORNER IN YOUR IDE</span><h1>代码之间，读几页。</h1><p>关上喧嚣，把故事留在本地。</p></div>
    <div className="shelf-heading">
      <div><h2>我的书架 <span>{allItems.length.toString().padStart(2, '0')}</span></h2><p className="shelf-summary">本地 {books.length} 本 · 在线 {onlineBooks.length} 本</p></div>
      <div className="shelf-actions">
        {onlineBooks.length > 0 && <button className="text-button" onClick={() => void checkOnlineUpdates()} disabled={checkingUpdates || busy} aria-label="检查在线书籍更新"><Icon name="update" size={15} />{checkingUpdates ? '检查中…' : '检查更新'}</button>}
        <button className="text-button" onClick={onShowSources}><Icon name="search" size={16} />搜索在线书籍</button>
        <button className="primary" onClick={onImport} disabled={busy}><Icon name="plus" size={16} />{busy ? '导入中…' : '导入书籍'}</button>
      </div>
    </div>
    {updateNotice && <p className="online-message shelf-notice" role="status"><span>{updateNotice}</span><button className="icon-button" aria-label="关闭更新提示" onClick={() => setUpdateNotice('')}><Icon name="close" size={14} /></button></p>}
    {allItems.length > 0 && <div className="shelf-controls" role="region" aria-label="书架筛选与排序">
      <div className="shelf-search"><Icon name="search" size={14} /><input aria-label="筛选书架" placeholder="搜索书名或作者…" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <select aria-label="书籍分类筛选" value={filter} onChange={event => setFilter(event.target.value as ShelfFilter)}>
        <option value="all">全部书籍</option>
        <option value="local">仅本地</option>
        <option value="online">仅在线</option>
        <option value="epub">EPUB</option>
        <option value="txt">TXT</option>
        <option value="pdf">PDF</option>
        <option value="pinned">已置顶</option>
        <option value="updated">有更新</option>
      </select>
      <select aria-label="书架排序方式" value={sort} onChange={event => setSort(event.target.value as ShelfSort)}>
        <option value="recent">最近阅读</option>
        <option value="title">按书名</option>
        <option value="progress">按进度</option>
        <option value="added">按加入时间</option>
      </select>
    </div>}
    {loadingOnline && <p className="shelf-loading" role="status">正在读取在线书籍…</p>}
    {!allItems.length && !loadingOnline ? <div className="empty-shelf"><div className="empty-icon"><Icon name="book" size={36} /></div><h2>下一段故事，从这里开始</h2><p>导入本地 EPUB、TXT 或 PDF，或从在线书源加入书籍。<br />阅读进度自动保存，随时接着读。</p><button className="primary" onClick={onImport} disabled={busy}><Icon name="plus" />选择电子书</button><small>本地书籍与在线缓存 · 无需账号</small></div>
      : !visible.length && hasFilter ? <div className="empty-shelf shelf-filter-empty"><p>没有符合当前筛选条件的书籍。</p><button className="text-button" onClick={() => { setQuery(''); setFilter('all'); }}>重置筛选</button></div>
      : <div className="book-list">{visible.map((item, i) => {
        if (item.kind === 'online') return <OnlineBookCard key={`online:${item.book.id}`} book={item.book} sourceName={sources.find(source => source.id === item.book.sourceId)?.name ?? '书源已移除'} busy={busy || !!pending} onOpen={() => onOpenOnline(item.book.id)} onPin={() => { void pinOnline(item.book); }} onRemove={() => { void removeOnline(item.book.id); }} />;
        const book = item.book;
        return <div className={`book-card${book.pinned ? ' is-pinned' : ''}`} data-book-kind="local" data-pinned={book.pinned ? 'true' : undefined} key={`local:${book.id}`}>
          <button className="book-open" onClick={() => onOpen(book.id)} aria-label={`阅读 ${book.title}`}>
            <div className={`book-cover cover-${i % 4}`}>{book.cover ? <img src={book.cover} alt={`${book.title} 封面`} /> : <><Icon name="book" size={28} /><span>{book.format.toUpperCase()}</span></>}</div>
            <div className="book-details">
              <div className="book-meta-row">
                <span className="book-format">{book.format.toUpperCase()}</span>
                {book.pinned && <span className="book-badge pin-badge">置顶</span>}
              </div>
              <h3>{book.title}</h3>
              <p>{book.author || '本地藏书'}</p>
              <div className="book-progress"><span style={{ width: `${(book.progress?.percentage ?? 0) * 100}%` }} /></div>
              <small>{book.progress ? `已读 ${formatPercentage(book.progress.percentage)} · 继续阅读` : '尚未开始 · 翻开第一页'}</small>
            </div>
            <Icon name="right" />
          </button>
          <div className="book-card-actions">
            <button className={`icon-button pin-book${book.pinned ? ' active' : ''}`} title={book.pinned ? `取消置顶 ${book.title}` : `置顶 ${book.title}`} aria-label={book.pinned ? `取消置顶 ${book.title}` : `置顶 ${book.title}`} onClick={() => onPin(book.id, !book.pinned)}><Icon name="pin" size={14} /></button>
            <button className="icon-button remove-book" title={`移除 ${book.title}`} aria-label={`移除 ${book.title}`} onClick={() => onRemove(book.id)}><Icon name="trash" size={15} /></button>
          </div>
        </div>;
      })}</div>}
    <footer className="shelf-footer"><span className="status-dot" /> 书架、进度与已缓存正文，仅保存在这台设备。</footer>
  </section>;
}
