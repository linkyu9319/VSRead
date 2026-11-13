import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ReaderSettings } from '../../shared/model';
import type { OnlineBookRecord, OnlineChapterContent } from '../../shared/online';
import { formatPercentage } from '../../shared/format';
import { request } from '../bridge';
import { OnlineProgressWriter, type ChapterPosition } from '../onlineProgress';
import { Icon } from './Icon';

interface Props {
  book: OnlineBookRecord; settings: ReaderSettings; sourceName: string;
  onBack(): void; onBookChange(book: OnlineBookRecord): void; onError(error: unknown): void;
}

interface DisplayedChapter {
  content: OnlineChapterContent; index: number; scroll: number; generation: number;
}

export function OnlineReader(props: Props) {
  const [book, setBook] = useState(props.book);
  const [displayed, setDisplayed] = useState<DisplayedChapter>();
  const content = displayed?.content;
  const chapterIndex = displayed?.index ?? Math.max(0, props.book.progress?.chapter ?? 0);
  const [loading, setLoading] = useState(true);
  const [task, setTask] = useState('');
  const [message, setMessage] = useState('');
  const [saveState, setSaveState] = useState('进度自动保存');
  const [tocVisible, setTocVisible] = useState(true);
  const [filter, setFilter] = useState('');
  const [cacheCount, setCacheCount] = useState(5);
  const [position, setPosition] = useState<ChapterPosition>({ chapter: chapterIndex, scroll: props.book.progress?.scroll ?? 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const bookRef = useRef(book);
  const latest = useRef(props);
  const active = useRef(true);
  const generation = useRef(0);
  const readable = useRef(false);
  const shownChapter = useRef(chapterIndex);
  const targetChapter = useRef(chapterIndex);
  const loadingChapter = useRef(true);
  const restore = useRef(props.book.progress?.scroll ?? 0);
  const lastPosition = useRef<ChapterPosition>(position);
  const viewportSize = useRef({ width: 0, height: 0 });
  const writer = useRef<OnlineProgressWriter | undefined>(undefined);
  latest.current = props;
  bookRef.current = book;
  if (!writer.current) writer.current = new OnlineProgressWriter(
    value => request('online.progress', { id: props.book.id, ...value }),
    error => {
      if (!active.current) return;
      setSaveState(error ? '保存失败 · 下次操作重试' : '进度已保存');
      if (error) latest.current.onError(error);
    },
  );

  const remember = useCallback((value: ChapterPosition) => {
    if (!active.current) return;
    lastPosition.current = value;
    setPosition(value);
    setSaveState('正在保存…');
    writer.current!.put(value);
    const progress = { ...value, updatedAt: new Date().toISOString() };
    bookRef.current = { ...bookRef.current, progress };
    setBook(bookRef.current);
    latest.current.onBookChange(bookRef.current);
  }, []);
  const capture = useCallback(() => {
    const node = viewport.current;
    if (!node || !readable.current) return;
    const size = viewportSize.current;
    if (size.width && (size.width !== node.clientWidth || size.height !== node.clientHeight)) {
      // 专注模式/折叠目录改变视口时，先恢复已捕获比例，再采样新布局。
      node.scrollTo({ top: lastPosition.current.scroll * Math.max(0, node.scrollHeight - node.clientHeight), behavior: 'instant' });
    }
    viewportSize.current = { width: node.clientWidth, height: node.clientHeight };
    remember({ chapter: shownChapter.current, scroll: Math.min(1, Math.max(0, node.scrollTop / Math.max(1, node.scrollHeight - node.clientHeight))) });
  }, [remember]);

  const loadChapter = useCallback(async (index: number, scroll = 0, refresh = false) => {
    if (!bookRef.current.chapters[index]) return;
    capture();
    const token = ++generation.current;
    targetChapter.current = index;
    restore.current = scroll;
    loadingChapter.current = true;
    setLoading(true);
    setMessage('');
    await writer.current!.flush();
    if (!active.current || token !== generation.current) return;
    try {
      const next = await request('online.chapter', { id: props.book.id, chapter: index, refresh });
      if (!active.current || token !== generation.current) return;
      if (!next.text.trim()) throw new Error('当前章节没有可阅读的正文');
      // 新正文提交前暂停滚动采样，防止旧 DOM 的滚动事件被记到新章节。
      readable.current = false;
      // 正文与恢复位置属于同一次提交，避免两个相邻请求共享可变 restore 值。
      const nextDisplay = { content: next, index, scroll: Math.min(1, Math.max(0, scroll)), generation: token };
      setDisplayed(previous => token === generation.current ? nextDisplay : previous);
      const updated = { ...bookRef.current, cachedChapters: [...new Set([...bookRef.current.cachedChapters, index])].sort((a, b) => a - b) };
      bookRef.current = updated;
      setBook(updated);
      latest.current.onBookChange(updated);
    } catch (error) {
      if (active.current && token === generation.current) {
        setMessage(error instanceof Error ? error.message : String(error));
        latest.current.onError(error);
      }
    } finally { if (active.current && token === generation.current) { loadingChapter.current = false; setLoading(false); } }
  }, [capture, props.book.id]);

  useEffect(() => {
    const chapter = Math.min(Math.max(0, props.book.progress?.chapter ?? 0), Math.max(0, props.book.chapters.length - 1));
    if (!props.book.chapters.length) { setLoading(false); setMessage('目录为空，请刷新目录后重试'); return; }
    void loadChapter(chapter, props.book.progress?.scroll ?? 0);
  }, [loadChapter, props.book.id]);
  useLayoutEffect(() => {
    if (!displayed || displayed.generation !== generation.current || !viewport.current) return;
    const node = viewport.current;
    shownChapter.current = displayed.index;
    // 普通换章明确从章首开始；只有恢复阅读/刷新正文才传入已保存比例。
    // instant 与独立滚动节点共同阻止旧章节末尾的平滑滚动、焦点及锚定回写。
    node.scrollTo({ top: displayed.scroll * Math.max(0, node.scrollHeight - node.clientHeight), behavior: 'instant' });
    if (!document.querySelector('[role="dialog"]')) node.focus({ preventScroll: true });
    viewportSize.current = { width: node.clientWidth, height: node.clientHeight };
    readable.current = true;
    remember({ chapter: displayed.index, scroll: node.scrollTop / Math.max(1, node.scrollHeight - node.clientHeight) });
  }, [displayed, remember]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const size = viewportSize.current;
      if (size.width !== node.clientWidth || size.height !== node.clientHeight) capture();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [displayed, capture]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (node && readable.current) node.scrollTo({ top: lastPosition.current.scroll * Math.max(0, node.scrollHeight - node.clientHeight), behavior: 'instant' });
  }, [props.settings.fontSize, props.settings.lineHeight, props.settings.fontFamily]);
  useLayoutEffect(() => {
    active.current = true;
    const flush = () => { void writer.current!.flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      // 离开时只发送此前捕获的快照，不依赖已移除节点的尺寸。
      active.current = false;
      readable.current = false;
      generation.current++;
      void writer.current!.flush();
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, []);

  const turn = useCallback((direction: -1 | 1) => {
    if (loadingChapter.current) return;
    const next = shownChapter.current + direction;
    if (bookRef.current.chapters[next]) void loadChapter(next);
  }, [loadChapter]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || (target instanceof Element && target.closest('input,textarea,select,button,[contenteditable]')) || !readable.current) return;
      const node = viewport.current;
      if (!node) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = Math.max(24, latest.current.settings.fontSize * latest.current.settings.lineHeight * 2);
        node.scrollTo({ top: node.scrollTop + (event.key === 'ArrowDown' ? step : -step), behavior: 'instant' });
        capture();
      }
      if (event.key === 'ArrowRight') { event.preventDefault(); turn(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); turn(-1); }
      if (event.key === 'PageDown') {
        event.preventDefault();
        if (node.scrollTop + node.clientHeight >= node.scrollHeight - 4) turn(1);
        else { node.scrollTo({ top: node.scrollTop + node.clientHeight * .88, behavior: 'instant' }); capture(); }
      }
      if (event.key === 'PageUp') {
        event.preventDefault();
        if (node.scrollTop < 4) turn(-1);
        else { node.scrollTo({ top: node.scrollTop - node.clientHeight * .88, behavior: 'instant' }); capture(); }
      }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [capture, turn]);

  const synchronizeBook = (next: OnlineBookRecord) => {
    const updated = { ...next, progress: bookRef.current.progress ?? next.progress };
    bookRef.current = updated;
    setBook(updated);
    latest.current.onBookChange(updated);
  };
  const perform = async (name: string, action: () => Promise<void>) => {
    if (task) return;
    capture();
    setTask(name);
    setMessage('');
    await writer.current!.flush();
    try { await action(); }
    catch (error) { if (active.current) { setMessage(error instanceof Error ? error.message : String(error)); latest.current.onError(error); } }
    finally { if (active.current) setTask(''); }
  };
  const refreshToc = () => {
    if (task || loading) return;
    capture();
    // 刷新可能改变章节顺序；请求期间不再发送旧目录索引的进度。
    readable.current = false;
    void perform('刷新目录', async () => {
    const previous = bookRef.current.chapters[shownChapter.current];
    const previousScroll = lastPosition.current.scroll;
    let next: OnlineBookRecord;
    try { next = await request('online.open', { id: book.id, refresh: true }); }
    catch (error) { readable.current = !!content; throw error; }
    if (!active.current) return;
    const index = Math.max(0, next.chapters.findIndex(item => item.id === previous?.id || item.url === previous?.url));
    readable.current = false;
    synchronizeBook(next);
    if (!next.chapters.length) { setMessage('更新后的目录为空，已保留当前显示的正文'); return; }
    await loadChapter(index, next.chapters[index]?.id === previous?.id ? previousScroll : 0);
    if (active.current) setMessage(`目录已更新，共 ${next.chapters.length} 章`);
    });
  };
  const percentage = book.chapters.length ? (position.chapter + position.scroll) / book.chapters.length : 0;
  const textStyle: CSSProperties = {
    fontSize: `${props.settings.fontSize}px`, lineHeight: props.settings.lineHeight,
    fontFamily: props.settings.fontFamily === 'serif' ? '"Source Han Serif SC", "Noto Serif CJK SC", SimSun, serif' : 'system-ui, "Microsoft YaHei", sans-serif',
  };

  return <section className="online-reader" aria-label="在线阅读器">
    <div className="online-reader-heading"><button className="text-button" onClick={() => { capture(); void writer.current!.flush(); props.onBack(); }}><Icon name="left" size={16} />在线书架</button><div><h2>{book.title}</h2><span>{book.author || props.sourceName}</span></div><span className="online-tag">{props.sourceName}</span></div>
    <div className="online-reader-tools"><button className={`text-button ${tocVisible ? 'active' : ''}`} onClick={() => setTocVisible(!tocVisible)} aria-label="切换在线目录" aria-expanded={tocVisible}><Icon name="menu" size={16} />目录</button><button className="text-button" disabled={!!task || loading} onClick={refreshToc}>刷新目录</button><button className="text-button" disabled={!!task || loading || !content} onClick={() => void loadChapter(chapterIndex, lastPosition.current.scroll, true)}>刷新本章</button><span className="online-reader-cache">已缓存 {book.cachedChapters.length} / {book.chapters.length} 章</span></div>
    <div className="online-cache-controls"><label>从当前章起缓存 <input aria-label="缓存章节数" type="number" min="1" max="20" value={cacheCount} onChange={event => setCacheCount(Math.max(1, Math.min(20, Number(event.target.value) || 1)))} /> 章</label><button className="text-button" disabled={!!task || !book.chapters.length} onClick={() => void perform('缓存章节', async () => {
      const result = await request('online.cache', { id: book.id, from: shownChapter.current, count: cacheCount });
      const next = await request('online.open', { id: book.id });
      if (active.current) { synchronizeBook(next); setMessage(`缓存完成：成功 ${result.cached} 章，失败 ${result.failed} 章`); }
    })}>{task === '缓存章节' ? '正在缓存…' : '缓存章节'}</button><button className="text-button" disabled={!!task || !book.cachedChapters.length} onClick={() => void perform('清除缓存', async () => {
      const next = await request('online.clearCache', { id: book.id });
      if (active.current) { synchronizeBook(next); setMessage('离线缓存已清除，当前已显示章节仍可阅读'); }
    })}>清除缓存</button>{task && <span className="online-inline-status" role="status">{task}中…</span>}</div>
    {message && <p className="online-message" role="status">{message}{!content && !loading && <button className="text-button" onClick={() => void loadChapter(targetChapter.current, restore.current)}>重试</button>}</p>}
    <div className="online-reader-body">{tocVisible && <aside className="online-toc" aria-label="在线章节目录"><div className="filter-field"><Icon name="search" size={15} /><input aria-label="筛选在线章节" placeholder="查找章节…" value={filter} onChange={event => setFilter(event.target.value)} /></div><nav>{book.chapters.map((chapter, index) => ({ chapter, index })).filter(({ chapter }) => chapter.title.toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(({ chapter, index }) => <button key={chapter.id} className={index === chapterIndex && content ? 'active' : ''} onClick={() => void loadChapter(index)} title={chapter.title}><span>{chapter.title}</span>{book.cachedChapters.includes(index) && <Icon name="check" size={12} />}</button>)}</nav></aside>}
      <div className="online-reading-stage"><div key={content?.chapter.id ?? 'empty'} ref={viewport} className="online-reading-surface" style={{ overflowAnchor: 'none' }} tabIndex={0} aria-label="在线章节正文" onScroll={capture} data-testid="online-reading-surface">{content && <article className="online-chapter-content" style={textStyle}><h3>{content.chapter.title}</h3><div>{content.text}</div></article>}</div>{loading && <div className={`online-loading ${content ? 'online-loading-small' : ''}`} role="status"><span className="spinner" />正在读取章节…</div>}{!loading && !content && <div className="online-no-content"><Icon name="book" size={30} /><p>选择章节开始阅读</p></div>}</div>
    </div>
    <div className="page-controls"><button className="text-button" disabled={loading || chapterIndex <= 0} onClick={() => turn(-1)}><Icon name="left" size={16} />上一章</button><span>{content?.cached ? '离线缓存' : content ? '正文已缓存' : ''} · {saveState} · {formatPercentage(percentage)}</span><button className="text-button" disabled={loading || chapterIndex >= book.chapters.length - 1} onClick={() => turn(1)}>下一章<Icon name="right" size={16} /></button></div>
  </section>;
}
