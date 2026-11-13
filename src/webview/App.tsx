import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, type BookRecord, type Library, type OpenBook, type Progress, type ReaderSettings, type TextEncoding } from '../shared/model';
import { rememberBook, request } from './bridge';
import { ProgressWriter } from './progressWriter';
import { Bookshelf } from './components/Bookshelf';
import { ReaderView } from './components/ReaderView';
import { Settings } from './components/Settings';
import { Icon } from './components/Icon';
import { formatPercentage } from '../shared/format';
import { customThemeStyle } from './theme';

export function App() {
  const [library, setLibrary] = useState<Library>({ version: 1, books: [], settings: DEFAULT_SETTINGS });
  const [source, setSource] = useState<OpenBook>();
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [saveState, setSaveState] = useState('本地自动保存');
  const opening = useRef(0);
  const settingsQueue = useRef(Promise.resolve());
  const settingsToggle = useRef<HTMLButtonElement>(null);
  const reportError = useCallback((error: unknown) => setError(error instanceof Error ? error.message : String(error)), []);
  const writer = useRef<ProgressWriter | undefined>(undefined);
  if (!writer.current) writer.current = new ProgressWriter((id, progress) => request('progress', { id, progress }), error => {
    setSaveState(error ? '保存失败 · 将重试' : '进度已保存');
    if (error) reportError(error);
  });

  const open = useCallback(async (id: string) => {
    const token = ++opening.current;
    try {
      await writer.current!.flush();
      const next = await request('open', { id });
      if (opening.current !== token) return;
      setError(''); setSource(next); rememberBook(id);
    } catch (error) { reportError(error); }
  }, [reportError]);

  useEffect(() => {
    void request('init', undefined).then(data => {
      setLibrary(data);
      if (data.lastBookId && data.books.some(book => book.id === data.lastBookId)) void open(data.lastBookId);
    }).catch(reportError).finally(() => setInitializing(false));
    const update = (event: MessageEvent) => {
      if (event.data?.event !== 'library') return;
      const data = event.data.library as Library;
      setLibrary(data);
      if (data.lastBookId) void open(data.lastBookId);
    };
    const flush = () => { void writer.current!.flush(); };
    window.addEventListener('message', update);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      flush(); window.removeEventListener('message', update); window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush); document.removeEventListener('visibilitychange', flush);
    };
  }, [open, reportError]);

  const importBooks = async () => {
    setBusy(true);
    try { const data = await request('import', undefined); setLibrary(data); if (data.lastBookId) await open(data.lastBookId); }
    catch (error) { reportError(error); }
    finally { setBusy(false); }
  };
  const onProgress = useCallback((id: string, value: Progress) => {
    setSaveState('正在保存…');
    writer.current!.put(id, value);
    setLibrary(previous => ({ ...previous, books: previous.books.map(book => book.id === id ? { ...book, progress: value } : book) }));
  }, []);
  const onMetadata = useCallback((id: string, value: Partial<Pick<BookRecord, 'title' | 'author' | 'cover'>>) => {
    const metadata = Object.fromEntries(Object.entries(value).filter(([, item]) => item));
    setLibrary(previous => ({ ...previous, books: previous.books.map(book => book.id === id ? { ...book, ...metadata } : book) }));
    void request('metadata', { id, ...metadata }).catch(reportError);
  }, [reportError]);
  const updateSettings = (settings: ReaderSettings) => {
    setLibrary(previous => ({ ...previous, settings }));
    settingsQueue.current = settingsQueue.current.then(() => request('settings', settings)).catch(reportError);
  };
  const changeEncoding = async (encoding: TextEncoding) => {
    if (!source) return;
    try {
      await writer.current!.flush();
      setBusy(true);
      const next = await request('encoding', { id: source.book.id, encoding });
      setSource(next);
      setLibrary(previous => ({ ...previous, books: previous.books.map(book => book.id === next.book.id ? next.book : book) }));
    } catch (error) { reportError(error); }
    finally { setBusy(false); }
  };
  const currentBook = source && library.books.find(book => book.id === source.book.id);
  return <div className="app" data-theme={library.settings.theme} style={customThemeStyle(library.settings)} onPointerDownCapture={event => {
    if (settingsVisible && event.target instanceof Element && !event.target.closest('.settings-panel, [data-settings-toggle]')) setSettingsVisible(false);
  }}>
    <header className="app-header"><button className="brand" onClick={() => { opening.current++; setSource(undefined); rememberBook(); void writer.current!.flush(); }} aria-label="返回书架"><span className="brand-mark"><Icon name="book" size={20} /></span>VS<span>Read</span></button><span className="header-divider" />
      <div className="header-title">{source ? <><span>{currentBook?.title ?? source.book.title}</span><small>{currentBook?.author || source.book.format.toUpperCase()}</small></> : <span className="muted">你的本地阅读空间</span>}</div>
      <div className="header-actions">{source && <button className="text-button header-action" onClick={() => { opening.current++; setSource(undefined); void writer.current!.flush(); }} title="我的书架" aria-label="我的书架"><Icon name="shelf" /><span>我的书架</span></button>}<button ref={settingsToggle} data-settings-toggle className={`text-button header-action ${settingsVisible ? 'active' : ''}`} onClick={() => setSettingsVisible(!settingsVisible)} title="调整背景、字号与行距" aria-label="阅读设置" aria-controls="reading-settings" aria-expanded={settingsVisible}><Icon name="settings" /><span>阅读设置</span></button></div>
    </header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}><Icon name="close" size={15} /></button></div>}
    <main>{initializing ? <div className="initial-loading"><span className="spinner" />正在打开书架…</div> : source ? <ReaderView key={source.book.id + (source.book.encoding ?? '')} source={source} settings={library.settings} onProgress={onProgress} onMetadata={onMetadata} onError={reportError} onEncoding={encoding => { if (!busy) void changeEncoding(encoding); }} /> : <Bookshelf books={library.books} busy={busy} onOpen={id => void open(id)} onImport={() => void importBooks()} onRemove={id => { void writer.current!.flush().then(() => request('remove', { id })).then(setLibrary).catch(reportError); }} />}</main>
    {settingsVisible && <><div className="settings-dismiss" aria-hidden="true" /><Settings value={library.settings} format={source?.book.format} onChange={updateSettings} onClose={() => { setSettingsVisible(false); settingsToggle.current?.focus(); }} /></>}
    <footer className="app-status"><span><span className="status-dot" /> LOCAL / OFFLINE</span>{source ? <><span className="save-indicator"><Icon name="check" size={12} />{saveState}</span><span className="reading-percentage">{currentBook?.progress?.position.format === 'pdf' && `第 ${currentBook.progress.position.page} 页 · `}{formatPercentage(currentBook?.progress?.percentage)}</span></> : <span>留一点时间，给好故事。</span>}</footer>
  </div>;
}
