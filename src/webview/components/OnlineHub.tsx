import { useEffect, useRef, useState } from 'react';
import type { ReaderSettings } from '../../shared/model';
import type { BookSource, OnlineBookRecord, OnlineSearchResult, SourceImportResult } from '../../shared/online';
import { formatPercentage } from '../../shared/format';
import { rememberOnline, request } from '../bridge';
import { Icon } from './Icon';
import { OnlineSources } from './OnlineSources';
import { OnlineSearch } from './OnlineSearch';
import { OnlineReader } from './OnlineReader';
import '../online.css';

export function OnlineHub({ settings, onError, initialBookId }: { settings: ReaderSettings; onError(error: unknown): void; initialBookId?: string }) {
  const [sources, setSources] = useState<BookSource[]>([]);
  const [books, setBooks] = useState<OnlineBookRecord[]>([]);
  const [opened, setOpened] = useState<OnlineBookRecord>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [message, setMessage] = useState('');
  const [removing, setRemoving] = useState('');
  const active = useRef(true);
  const opening = useRef(0);
  const pendingRef = useRef('');
  useEffect(() => {
    active.current = true;
    void Promise.allSettled([request('sources.list', undefined), request('online.list', undefined)]).then(async ([sourceResult, bookResult]) => {
      if (!active.current) return;
      if (sourceResult.status === 'fulfilled') setSources(sourceResult.value);
      else onError(sourceResult.reason);
      if (bookResult.status === 'fulfilled') setBooks(bookResult.value);
      else onError(bookResult.reason);
      if (initialBookId && bookResult.status === 'fulfilled' && bookResult.value.some(book => book.id === initialBookId)) {
        try {
          const book = await request('online.open', { id: initialBookId });
          if (active.current) { rememberOnline(book.id); setOpened(book); }
        } catch (error) { if (active.current) onError(error); }
      }
      if (!active.current) return;
      setLoading(false);
    });
    return () => { active.current = false; opening.current++; };
  }, [onError, initialBookId]);
  const upsertBook = (book: OnlineBookRecord) => setBooks(previous => previous.some(item => item.id === book.id) ? previous.map(item => item.id === book.id ? book : item) : [book, ...previous]);
  const perform = async <T,>(name: string, action: () => Promise<T>): Promise<T | undefined> => {
    if (pendingRef.current) return;
    pendingRef.current = name;
    setPending(name); setMessage('');
    try { return await action(); }
    catch (error) { if (active.current) { setMessage(error instanceof Error ? error.message : String(error)); onError(error); } }
    finally { pendingRef.current = ''; if (active.current) setPending(''); }
  };
  const openBook = async (book: OnlineBookRecord) => {
    if (pendingRef.current) return;
    const token = ++opening.current;
    await perform(`open:${book.id}`, async () => {
      const result = await request('online.open', { id: book.id });
      if (active.current && token === opening.current) { upsertBook(result); rememberOnline(result.id); setOpened(result); }
    });
  };
  const addBook = (result: OnlineSearchResult) => void perform(`add:${result.sourceId}:${result.url}`, async () => {
    const book = await request('online.add', { result });
    if (active.current) { upsertBook(book); setMessage(`《${book.title}》已加入在线书架`); }
  });
  const importSources = (args: { json?: string; url?: string }): Promise<SourceImportResult | undefined> => perform('sources', async () => {
    const result = await request('sources.import', args);
    if (active.current) setSources(result.sources);
    return result;
  });
  const toggleSource = (source: BookSource) => {
    if (pending) return;
    // 控件先响应用户操作；持久化失败再恢复，避免受控 checkbox 在 RPC 返回前闪回。
    setSources(previous => previous.map(item => item.id === source.id ? { ...item, enabled: !source.enabled } : item));
    void perform('sources', async () => {
      try {
        const next = await request('sources.toggle', { id: source.id, enabled: !source.enabled });
        if (active.current) setSources(next);
      } catch (error) {
        if (active.current) setSources(previous => previous.map(item => item.id === source.id ? source : item));
        throw error;
      }
    });
  };

  if (opened) return <OnlineReader key={opened.id} book={opened} settings={settings} sourceName={sources.find(source => source.id === opened.sourceId)?.name ?? '书源已移除'} onBack={() => { rememberOnline(); setOpened(undefined); }} onBookChange={upsertBook} onError={onError} />;
  if (loading) return <div className="initial-loading"><span className="spinner" />正在打开在线书源…</div>;
  const recent = [...books].sort((a, b) => (b.progress?.updatedAt ?? b.addedAt).localeCompare(a.progress?.updatedAt ?? a.addedAt));
  return <div className="online-hub">
    <div className="online-intro"><span className="eyebrow">ONLINE SOURCES</span><h1>在线书源</h1><p>自选书源，按章阅读；已缓存的内容可离线打开。</p></div>
    {message && <p className="online-message" role="status">{message}</p>}
    <OnlineSources sources={sources} busy={!!pending} onImport={importSources} onToggle={toggleSource} onRemove={source => { void perform('sources', async () => { const next = await request('sources.remove', { id: source.id }); if (active.current) setSources(next); }); }} />
    <OnlineSearch sources={sources} books={books} pending={pending} onAdd={addBook} onOpen={book => void openBook(book)} onError={onError} />
    <section className="online-library" aria-label="在线书架"><div className="online-section-heading"><div><h2>在线书架 <span>{books.length}</span></h2><p>目录与进度保存在本机，正文随阅读自动缓存。</p></div></div>
      {recent.length ? <div className="online-book-list">{recent.map(book => {
        const source = sources.find(source => source.id === book.sourceId);
        const percentage = book.chapters.length ? ((book.progress?.chapter ?? 0) + (book.progress?.scroll ?? 0)) / book.chapters.length : 0;
        return <div className="online-book-card" key={book.id}><div className="online-book-top"><div><span className="online-tag">{source?.name ?? '书源已移除'}</span><h3>{book.title}</h3><p>{book.author || '作者未注明'}</p></div><Icon name="book" size={30} /></div><div className="book-progress"><span style={{ width: `${Math.min(1, Math.max(0, percentage)) * 100}%` }} /></div><div className="online-book-details"><span>已读 {formatPercentage(percentage)}</span><span>已缓存 {book.cachedChapters.length} / {book.chapters.length} 章</span></div><div className="online-book-actions"><button className="text-button" disabled={!!pending} onClick={() => void openBook(book)}><Icon name="book" size={15} />{pending === `open:${book.id}` ? '打开中…' : book.progress ? '继续阅读' : '开始阅读'}</button>{removing === book.id ? <div className="inline-confirm"><span>移除书籍及缓存？</span><button className="text-button danger-button" disabled={!!pending} onClick={() => { void perform(`remove:${book.id}`, async () => { const result = await request('online.remove', { id: book.id }); if (active.current) { setBooks(result); setRemoving(''); } }); }}>确定</button><button className="text-button" onClick={() => setRemoving('')}>取消</button></div> : <button className="icon-button" disabled={!!pending} title={`移除 ${book.title}`} aria-label={`移除在线书籍 ${book.title}`} onClick={() => setRemoving(book.id)}><Icon name="trash" size={15} /></button>}</div></div>;
      })}</div> : <p className="online-empty-note">在线书架还是空的。导入书源，搜索并加入第一本书。</p>}
    </section>
  </div>;
}
