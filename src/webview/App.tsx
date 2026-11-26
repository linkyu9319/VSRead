import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, type BookRecord, type Library, type OpenBook, type Progress, type ReaderSettings, type TextEncoding } from '../shared/model';
import { rememberBook, rememberFocus, rememberOnline, request, savedView } from './bridge';
import { ProgressWriter } from './progressWriter';
import { flushReadingProgress } from './readingProgress';
import { Bookshelf } from './components/Bookshelf';
import { ReaderView } from './components/ReaderView';
import { Settings } from './components/Settings';
import { Icon } from './components/Icon';
import { formatPercentage } from '../shared/format';
import { customThemeStyle } from './theme';
import { OnlineHub } from './components/OnlineHub';
import { UpdatesPanel } from './components/UpdatesPanel';
import type { UpdateInstallResult, UpdateStatus } from '../shared/online';
import './online.css';

function checkedUpdateStatus(value: unknown): UpdateStatus {
  const status = value as Partial<UpdateStatus> | null;
  const text = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 512;
  // RPC 的空回复对保存进度等操作合法，但检查更新必须有可展示的完整结果。
  if (!status || typeof status !== 'object' || Array.isArray(status) || typeof status.state !== 'string' || !['available', 'current', 'unavailable'].includes(status.state)
    || !text(status.currentVersion) || !text(status.message) || (status.state !== 'unavailable' && !text(status.latestVersion))) {
    throw new Error('更新检查返回异常，请重试或打开诊断日志。');
  }
  return status as UpdateStatus;
}

export function App() {
  const [library, setLibrary] = useState<Library>({ version: 1, books: [], settings: DEFAULT_SETTINGS });
  const [source, setSource] = useState<OpenBook>();
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [page, setPage] = useState<'shelf' | 'online'>('shelf');
  const [initialOnlineBookId, setInitialOnlineBookId] = useState<string>();
  const [updatesVisible, setUpdatesVisible] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>();
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [reloadingUpdate, setReloadingUpdate] = useState(false);
  // 关闭弹层只隐藏界面，后台安装及其完成结果继续保留。
  const [updateInstallResult, setUpdateInstallResult] = useState<UpdateInstallResult>();
  const [updateError, setUpdateError] = useState('');
  // 同步加锁，防止快速点击在 React 更新按钮状态前发起并行请求。
  const updateOperation = useRef(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [saveState, setSaveState] = useState('本地自动保存');
  const [focusMode, setFocusMode] = useState(() => savedView().focus === true);
  const lastFocus = useRef(false);
  const opening = useRef(0);
  const settingsQueue = useRef(Promise.resolve());
  const settingsToggle = useRef<HTMLButtonElement>(null);
  const reportError = useCallback((error: unknown) => setError(error instanceof Error ? error.message : String(error)), []);
  useEffect(() => {
    if (focusMode) { setSettingsVisible(false); setUpdatesVisible(false); }
    rememberFocus(focusMode);
    if (lastFocus.current === focusMode) return;
    lastFocus.current = focusMode;
    void request('focus', { enabled: focusMode }).catch(reportError);
  }, [focusMode, reportError]);
  useEffect(() => {
    const toggle = () => setFocusMode(value => !value);
    const exit = () => setFocusMode(false);
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'h') {
        event.preventDefault(); toggle();
      } else if (event.key === 'Escape' && focusMode) { event.preventDefault(); exit(); }
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('vsread:toggle-focus', toggle);
    window.addEventListener('vsread:exit-focus', exit);
    return () => { window.removeEventListener('keydown', keydown); window.removeEventListener('vsread:toggle-focus', toggle); window.removeEventListener('vsread:exit-focus', exit); };
  }, [focusMode]);
  const writer = useRef<ProgressWriter | undefined>(undefined);
  if (!writer.current) writer.current = new ProgressWriter((id, progress) => request('progress', { id, progress }), error => {
    setSaveState(error ? '保存失败 · 将重试' : '进度已保存');
    if (error) reportError(error);
  });
  const showOnline = useCallback(() => {
    opening.current++; setSource(undefined); setPage('online'); setInitialOnlineBookId(undefined); setSettingsVisible(false); setUpdatesVisible(false);
    rememberOnline();
    void writer.current!.flush();
  }, []);
  const showShelf = () => {
    opening.current++; setSource(undefined); setPage('shelf'); setInitialOnlineBookId(undefined); rememberBook();
    void writer.current!.flush();
  };
  const openOnline = (id: string) => {
    opening.current++; setSource(undefined); setPage('online'); setInitialOnlineBookId(id); setSettingsVisible(false); setUpdatesVisible(false);
    rememberOnline(id);
    void writer.current!.flush();
  };

  const open = useCallback(async (id: string) => {
    const token = ++opening.current;
    try {
      await writer.current!.flush();
      const next = await request('open', { id });
      if (opening.current !== token) return;
      setError(''); setPage('shelf'); setSource(next); rememberBook(id);
    } catch (error) { reportError(error); }
  }, [reportError]);

  useEffect(() => {
    const initialToken = opening.current;
    const restored = savedView();
    void request('init', undefined).then(data => {
      setLibrary(data);
      if (typeof data.initialFocus === 'boolean') setFocusMode(data.initialFocus);
      if (initialToken !== opening.current) return;
      if (data.initialView === 'online') showOnline();
      else if (restored.view === 'online') { setPage('online'); setInitialOnlineBookId(restored.onlineBookId); }
      else if (data.lastBookId && data.books.some(book => book.id === data.lastBookId)) void open(data.lastBookId);
    }).catch(reportError).finally(() => setInitializing(false));
    const update = (event: MessageEvent) => {
      if (event.data?.event === 'focus' && typeof event.data.enabled === 'boolean') { setFocusMode(event.data.enabled); return; }
      if (event.data?.event === 'navigate' && event.data.view === 'online') { showOnline(); return; }
      if (event.data?.event !== 'library') return;
      const data = event.data.library as Library;
      setLibrary(data);
      const nextBookId = typeof event.data.openBookId === 'string' ? event.data.openBookId : undefined;
      if (nextBookId) void open(nextBookId);
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
  }, [open, reportError, showOnline]);

  const importBooks = async () => {
    setBusy(true);
    try {
      const { importedBookId, ...data } = await request('import', undefined);
      setLibrary(data);
      if (importedBookId) await open(importedBookId);
    }
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
  const checkUpdates = async (reveal = true) => {
    if (updateOperation.current || updateInstallResult?.state === 'installed') return;
    updateOperation.current = true;
    if (reveal) { setSettingsVisible(false); setUpdatesVisible(true); }
    setCheckingUpdates(true); setUpdateStatus(undefined);
    setUpdateError(''); setUpdateInstallResult(undefined);
    try { setUpdateStatus(checkedUpdateStatus(await request('updates.check', undefined))); }
    catch (error) { setUpdateError(error instanceof Error && error.message.trim() ? error.message : '检查更新失败，请重试或查看发布页。'); }
    finally { updateOperation.current = false; setCheckingUpdates(false); }
  };
  const showUpdates = () => {
    setSettingsVisible(false); setUpdatesVisible(true);
    // 顶部入口表示主动检查；进行中的操作和等待重载的安装结果仍保留。
    void checkUpdates();
  };
  const installUpdate = async () => {
    if (updateOperation.current || updateInstallResult?.state === 'installed') return;
    updateOperation.current = true; setInstallingUpdate(true); setUpdateError(''); setUpdateInstallResult(undefined);
    try { setUpdateInstallResult(await request('updates.install', undefined)); }
    catch (error) { setUpdateError(error instanceof Error ? error.message : String(error)); }
    finally { updateOperation.current = false; setInstallingUpdate(false); }
  };
  const reloadUpdate = async () => {
    if (updateOperation.current) return;
    updateOperation.current = true; setReloadingUpdate(true); setUpdateError('');
    try { await writer.current?.flush(); await flushReadingProgress(); await settingsQueue.current; await request('updates.reload', undefined); }
    catch (error) { setUpdateError(error instanceof Error ? error.message : String(error)); }
    finally { updateOperation.current = false; setReloadingUpdate(false); }
  };
  const updateAuth = async (action: 'set' | 'clear') => {
    if (updateOperation.current || updateInstallResult?.state === 'installed') return;
    updateOperation.current = true; setUpdateError('');
    let changed = false;
    try { await request('updates.auth', { action }); setUpdateStatus(undefined); changed = true; }
    catch (error) { setUpdateError(error instanceof Error ? error.message : String(error)); }
    finally { updateOperation.current = false; }
    // 凭据操作与检查共用锁，释放后再重查；关闭弹层不会被异步结果重新打开。
    if (changed) await checkUpdates(false);
  };
  return <div className="app" data-theme={library.settings.theme} data-focus={focusMode ? 'true' : undefined} style={customThemeStyle(library.settings)} onPointerDownCapture={event => {
    if (settingsVisible && event.target instanceof Element && !event.target.closest('.settings-panel, [data-settings-toggle]')) setSettingsVisible(false);
    if (updatesVisible && event.target instanceof Element && !event.target.closest('.update-panel, [data-update-toggle]')) setUpdatesVisible(false);
  }}>
    <header className="app-header"><button className="brand" onClick={showShelf} aria-label="返回书架" title="VSRead · 青菜阅读"><span className="brand-mark vegetable-mark" aria-hidden="true">🥬</span>VS<span className="brand-read">Read</span><small className="brand-cn">青菜阅读</small></button><span className="header-divider" />
      <div className="header-title">{source ? <><span>{currentBook?.title ?? source.book.title}</span><small>{currentBook?.author || source.book.format.toUpperCase()}</small></> : <span className="muted">{page === 'online' ? '在线书源' : '你的阅读空间'}</span>}</div>
      <div className="header-actions">{(source || page === 'online') && <button className="text-button header-action" onClick={showShelf} title="我的书架" aria-label="我的书架"><Icon name="shelf" /><span>我的书架</span></button>}<button className={`text-button header-action ${page === 'online' ? 'active' : ''}`} onClick={showOnline} aria-label="在线书源"><Icon name="globe" /><span>在线书源</span></button><button data-update-toggle className={`text-button header-action ${updatesVisible ? 'active' : ''}`} onClick={showUpdates} aria-label="检查更新"><Icon name="update" /><span>检查更新</span></button><button ref={settingsToggle} data-settings-toggle className={`text-button header-action ${settingsVisible ? 'active' : ''}`} onClick={() => { setUpdatesVisible(false); setSettingsVisible(!settingsVisible); }} title="调整背景、字号与行距" aria-label="阅读设置" aria-controls="reading-settings" aria-expanded={settingsVisible}><Icon name="settings" /><span>阅读设置</span></button><button className="text-button header-action" onClick={() => setFocusMode(true)} title="隐藏名称、工具栏与目录 · Ctrl+Alt+H" aria-label="专注阅读"><Icon name="focus" /><span>专注阅读</span></button></div>
    </header>
    {focusMode && <button className="focus-restore icon-button" aria-label="退出专注阅读" title="恢复界面 · Esc / Ctrl+Alt+H" onClick={() => setFocusMode(false)}><Icon name="focus" size={16} /></button>}
    {error && <div className="error-banner" role="alert"><span>{error}</span><button className="text-button" onClick={() => { void request('diagnostics.open', undefined).catch(reportError); }}>查看日志</button><button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}><Icon name="close" size={15} /></button></div>}
    <main>{initializing ? <div className="initial-loading"><span className="spinner" />正在打开书架…</div> : page === 'online' ? <OnlineHub settings={library.settings} onError={reportError} initialBookId={initialOnlineBookId} onBackToShelf={showShelf} /> : source ? <ReaderView key={source.book.id + (source.book.encoding ?? '')} source={source} settings={library.settings} onProgress={onProgress} onMetadata={onMetadata} onError={reportError} onEncoding={encoding => { if (!busy) void changeEncoding(encoding); }} /> : <Bookshelf books={library.books} busy={busy} onOpen={id => void open(id)} onOpenOnline={openOnline} onShowSources={showOnline} onError={reportError} onImport={() => void importBooks()} onRemove={id => { void writer.current!.flush().then(() => request('remove', { id })).then(setLibrary).catch(reportError); }} />}</main>
    {(settingsVisible || updatesVisible) && <div className="settings-dismiss" aria-hidden="true" />}
    {settingsVisible && <Settings value={library.settings} format={source?.book.format} onChange={updateSettings} onClose={() => { setSettingsVisible(false); settingsToggle.current?.focus(); }} />}
    {updatesVisible && <UpdatesPanel status={updateStatus} checking={checkingUpdates} installing={installingUpdate} reloading={reloadingUpdate} installResult={updateInstallResult} error={updateError} onCheck={() => { void checkUpdates(); }} onInstall={() => { void installUpdate(); }} onReload={() => { void reloadUpdate(); }} onOpen={() => { void request('updates.open', undefined).catch(reportError); }} onAuth={action => { void updateAuth(action); }} onClose={() => setUpdatesVisible(false)} />}
    <footer className="app-status"><span><span className="status-dot" /> {page === 'online' ? 'ONLINE / LOCAL CACHE' : 'LOCAL / OFFLINE'}</span>{source ? <><span className="save-indicator"><Icon name="check" size={12} />{saveState}</span><span className="reading-percentage">{currentBook?.progress?.position.format === 'pdf' && `第 ${currentBook.progress.position.page} 页 · `}{formatPercentage(currentBook?.progress?.percentage)}</span></> : <span>留一点时间，给好故事。</span>}</footer>
  </div>;
}
