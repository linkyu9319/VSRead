import { useEffect, useRef, useState } from 'react';
import type { ReaderSettings } from '../../shared/model';
import type { BookSource, BuiltinSourceSummary, OnlineBookRecord, OnlineSearchResult, SourceImportResult } from '../../shared/online';
import { rememberOnline, request } from '../bridge';
import { OnlineSources } from './OnlineSources';
import { OnlineSearch } from './OnlineSearch';
import { OnlineReader } from './OnlineReader';
import '../online.css';

export function OnlineHub({ settings, onError, initialBookId, onBackToShelf }: { settings: ReaderSettings; onError(error: unknown): void; initialBookId?: string; onBackToShelf(): void }) {
  const [sources, setSources] = useState<BookSource[]>([]);
  const [builtins, setBuiltins] = useState<BuiltinSourceSummary[]>([]);
  const [importExpanded, setImportExpanded] = useState(false);
  const [books, setBooks] = useState<OnlineBookRecord[]>([]);
  const [opened, setOpened] = useState<OnlineBookRecord>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [message, setMessage] = useState('');
  const active = useRef(true);
  const opening = useRef(0);
  const pendingRef = useRef('');
  useEffect(() => {
    active.current = true;
    const token = ++opening.current;
    setLoading(true);
    void Promise.allSettled([request('sources.list', undefined), request('online.list', undefined), request('sources.builtin.list', undefined)]).then(async ([sourceResult, bookResult, builtinResult]) => {
      if (!active.current || token !== opening.current) return;
      if (sourceResult.status === 'fulfilled') setSources(sourceResult.value);
      else onError(sourceResult.reason);
      if (bookResult.status === 'fulfilled') setBooks(bookResult.value);
      else onError(bookResult.reason);
      if (builtinResult.status === 'fulfilled') setBuiltins(builtinResult.value);
      else onError(builtinResult.reason);
      if (initialBookId && bookResult.status === 'fulfilled' && bookResult.value.some(book => book.id === initialBookId)) {
        try {
          const book = await request('online.open', { id: initialBookId });
          if (active.current && token === opening.current) { rememberOnline(book.id); setOpened(book); }
        } catch (error) { if (active.current && token === opening.current) onError(error); }
      }
      if (!active.current || token !== opening.current) return;
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
    if (active.current) { upsertBook(book); setMessage(`《${book.title}》已加入我的书架`); }
  });
  const importSources = (args: { json?: string; url?: string }): Promise<SourceImportResult | undefined> => perform('sources', async () => {
    const result = await request('sources.import', args);
    if (active.current) setSources(result.sources);
    return result;
  });
  const useBuiltin = (id: string): Promise<BookSource | undefined> => perform('sources', async () => {
    const builtin = builtins.find(item => item.id === id);
    if (!builtin) throw new Error('内置书源不存在');
    const next = await request('sources.builtin.add', { id });
    if (active.current) setSources(next);
    return next.find(source => source.id === builtin.sourceId);
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

  if (opened) return <OnlineReader key={opened.id} book={opened} settings={settings} sourceName={sources.find(source => source.id === opened.sourceId)?.name ?? '书源已移除'} onBack={onBackToShelf} onBookChange={upsertBook} onError={onError} />;
  if (loading) return <div className="initial-loading"><span className="spinner" />正在打开在线书源…</div>;
  return <div className="online-hub">
    <div className="online-intro"><span className="eyebrow">ONLINE SOURCES</span><h1>在线书源</h1><p>自选书源，按章阅读；已缓存的内容可离线打开。</p></div>
    {message && <p className="online-message" role="status">{message}<button className="text-button" onClick={onBackToShelf}>查看我的书架</button></p>}
    <OnlineSearch sources={sources} builtins={builtins} books={books} pending={pending} onUseBuiltin={useBuiltin} onImport={() => setImportExpanded(true)} onAdd={addBook} onOpen={book => void openBook(book)} onError={onError} />
    <OnlineSources sources={sources} busy={!!pending} expanded={importExpanded} onExpandedChange={setImportExpanded} onImport={importSources} onToggle={toggleSource} onRemove={source => { void perform('sources', async () => { const next = await request('sources.remove', { id: source.id }); if (active.current) setSources(next); }); }} />
    <p className="online-library-note">已加入的书籍统一保存在“我的书架”，目录与进度保存在本机，正文随阅读自动缓存。<button className="text-button" onClick={onBackToShelf}>查看我的书架{books.length ? ` · ${books.length} 本在线书籍` : ''}</button></p>
  </div>;
}
