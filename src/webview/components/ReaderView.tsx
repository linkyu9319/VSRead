import { useEffect, useRef, useState } from 'react';
import type { BookRecord, OpenBook, Progress, ReaderSettings, TextEncoding, TocItem } from '../../shared/model';
import { createReader } from '../readers/createReader';
import type { ReaderAdapter, SearchHit } from '../readers/types';
import { Contents } from './Contents';
import { Icon } from './Icon';

interface Props {
  source: OpenBook; settings: ReaderSettings;
  onProgress(id: string, value: Progress): void;
  onMetadata(id: string, value: Partial<Pick<BookRecord, 'title' | 'author' | 'cover'>>): void;
  onError(error: unknown): void;
  onEncoding(encoding: TextEncoding): void;
}
export function ReaderView(props: Props) {
  const { source, settings } = props;
  const mount = useRef<HTMLDivElement>(null);
  const engine = useRef<ReaderAdapter | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const [toc, setToc] = useState<TocItem[]>([]);
  const [tocVisible, setTocVisible] = useState(true);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [hits, setHits] = useState<SearchHit[] | undefined>();
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let adapter: ReaderAdapter | undefined;
    setLoading(true);
    setFailed(false);
    const start = async () => {
      adapter = await createReader(source.book.format, mount.current!, latest.current.settings, {
        toc: items => { if (!cancelled) setToc(items); },
        progress: value => { if (!cancelled) latest.current.onProgress(source.book.id, value); },
        metadata: value => { if (!cancelled) latest.current.onMetadata(source.book.id, value); },
        error: error => { if (!cancelled) latest.current.onError(error); },
      });
      if (cancelled) { adapter.destroy(); return; }
      engine.current = adapter;
      await adapter.load(source, source.book.progress?.position);
      if (!cancelled) { adapter.update(latest.current.settings); setLoading(false); }
    };
    void start().catch(error => { if (!cancelled) { setFailed(true); setLoading(false); latest.current.onError(error); } });
    return () => { adapter?.destroy(); cancelled = true; engine.current = undefined; };
  }, [source]);

  useEffect(() => { engine.current?.update(settings); }, [settings]);
  useEffect(() => {
    // IDE 切换主题只会修改 Webview body 属性，EPUB iframe 需显式同步颜色。
    const observer = new MutationObserver(() => {
      if (latest.current.settings.theme === 'ide') engine.current?.update(latest.current.settings);
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-id', 'data-vscode-theme-kind'] });
    return () => observer.disconnect();
  }, []);
  const navigate = (direction: 'next' | 'previous') => { void engine.current?.[direction]().catch(latest.current.onError); };
  const goTo = (target: string) => { void engine.current?.goTo(target).catch(latest.current.onError); };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || document.querySelector('[role="dialog"]') || (event.target as HTMLElement)?.closest('input,select,textarea,[contenteditable]')) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); engine.current?.scroll(event.key === 'ArrowDown' ? 1 : -1); }
      if (event.key === 'PageDown' || event.key === 'ArrowRight') { event.preventDefault(); navigate('next'); }
      if (event.key === 'PageUp' || event.key === 'ArrowLeft') { event.preventDefault(); navigate('previous'); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return <div className="reader-view">
    <div className="reader-toolbar">
      <button className={`text-button ${tocVisible ? 'active' : ''}`} onClick={() => setTocVisible(!tocVisible)} aria-label="切换目录" aria-expanded={tocVisible}><Icon name="menu" size={16} /><span>目录</span></button>
      <span className="toolbar-divider" />
      {source.book.format === 'txt' && <label className="encoding-label">编码<select aria-label="文字编码" value={source.book.encoding ?? 'auto'} onChange={event => props.onEncoding(event.target.value as TextEncoding)}><option value="auto">自动识别</option><option value="utf-8">UTF-8</option><option value="gb18030">GBK / GB18030</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select></label>}
      {source.book.format === 'pdf' && <form className="pdf-search" onSubmit={event => {
        event.preventDefault();
        if (!engine.current?.search || searching || !search.trim()) return;
        setSearching(true);
        void engine.current.search(search.trim()).then(setHits).catch(props.onError).finally(() => setSearching(false));
      }}><Icon name="search" size={15} /><input aria-label="搜索 PDF 文字" placeholder="搜索 PDF 文字…" value={search} onChange={event => setSearch(event.target.value)} /><button className="text-button" disabled={searching || loading}>{searching ? '搜索中…' : '查找'}</button></form>}
      <span className="toolbar-hint">↑ ↓ 滚动 · ← → / PageUp / PageDown 翻页</span>
    </div>
    <div className="reader-body">
      {tocVisible && <Contents items={toc} onNavigate={goTo} />}
      <div className="reading-stage">
        <div ref={mount} className="engine-surface" data-testid="reader-engine" tabIndex={0} role="region" aria-label="电子书正文" />
        {loading && <div className="reader-overlay"><span className="spinner" /><p>正在翻开这本书…</p></div>}
        {failed && <div className="reader-overlay"><Icon name="book" size={32} /><p>这本书暂时无法打开</p><small>请检查文件是否完整、是否受 DRM 或密码保护。</small></div>}
      </div>
      {hits && <aside className="search-results"><div className="panel-heading">搜索结果 <button className="icon-button" onClick={() => setHits(undefined)} aria-label="关闭搜索结果"><Icon name="close" size={15} /></button></div><p className="muted">{hits.length ? `找到 ${hits.length} 个页面${hits.length === 100 ? '（最多显示 100 个）' : ''}` : '没有找到文字；扫描件暂不支持 OCR。'}</p>{hits.map(hit => <button key={hit.id} onClick={() => goTo(hit.id)}>{hit.label}</button>)}</aside>}
    </div>
    <div className="page-controls"><button className="text-button" disabled={loading || failed} onClick={() => navigate('previous')}><Icon name="left" size={16} />上一页</button><span>把这一页，留给自己。</span><button className="text-button" disabled={loading || failed} onClick={() => navigate('next')}>下一页<Icon name="right" size={16} /></button></div>
  </div>;
}
