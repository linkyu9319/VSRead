import ePub, { type Book, type Rendition, type Contents } from 'epubjs';
import type { NavItem } from 'epubjs/types/navigation';
import type { OpenBook, ReaderSettings, ReadingPosition, TocItem } from '../../shared/model';
import { sanitizeEpubDocument } from './epubSecurity';
import { readBookBytes } from './bookBytes';
import { estimateEpubProgress, type EpubLocation } from './epubProgress';
import { progress, readingColors, type ReaderAdapter, type ReaderEvents } from './types';
import { resetReadingScroll, scrollReadingSurface, stopReadingScroll } from './readerScroll';
import { focusReadingSurface } from './readerFocus';

export class EpubReader implements ReaderAdapter {
  private book?: Book;
  private rendition?: Rendition;
  private destroyed = false;
  private ready = false;
  private moving = false;
  private watchedViewport?: HTMLElement;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  private abort = new AbortController();
  constructor(private container: HTMLElement, private settings: ReaderSettings, private events: ReaderEvents) { container.className = 'engine-surface epub-surface'; }

  async load(source: OpenBook, position?: ReadingPosition): Promise<void> {
    const buffer = await readBookBytes(source, this.abort.signal);
    if (this.destroyed) return;
    const book = this.book = ePub(buffer.buffer as ArrayBuffer, { replacements: 'blobUrl' });
    book.spine.hooks.content.register(sanitizeEpubDocument);
    await book.ready;
    if (this.destroyed) return;
    const metadata = await book.loaded.metadata;
    if (this.destroyed) return;
    this.events.metadata({ title: metadata.title, author: metadata.creator });
    const navigation = await book.loaded.navigation;
    if (this.destroyed) return;
    const convert = (items: NavItem[]): TocItem[] => items.map(item => ({ id: item.href, label: item.label.trim(), children: item.subitems?.length ? convert(item.subitems) : undefined }));
    this.events.toc(convert(navigation.toc));
    const rendition = this.rendition = book.renderTo(this.container, {
      width: '100%', height: '100%', spread: 'none',
      flow: this.settings.flow === 'scrolled' ? 'scrolled-doc' : 'paginated',
      allowScriptedContent: false,
    });
    rendition.hooks.content.register((contents: Contents) => {
      if (this.destroyed) return;
      this.applyContentSettings(contents);
      // iframe 内部的按键不会冒泡到外层，需要在此接回阅读操作。
      contents.document.addEventListener('keydown', this.onKeyDown);
      contents.document.addEventListener('click', event => {
        const target = (event.target as Element)?.closest('a');
        const href = (target?.getAttribute('href') ?? '').trim();
        if (target && /^(?:https?:|mailto:|file:|command:|vscode(?:-insiders)?:|tel:|javascript:|vbscript:)/i.test(href)) { event.preventDefault(); event.stopImmediatePropagation(); }
      }, true);
    });
    rendition.on('relocated', (location: EpubLocation) => {
      if (this.destroyed || !this.ready) return;
      this.emitProgress(location);
    });
    this.update(this.settings);
    try { await rendition.display(position?.format === 'epub' ? position.cfi : undefined); }
    catch (error) {
      if (position?.format !== 'epub') throw error;
      if (this.destroyed) return;
      await rendition.display();
    }
    if (this.destroyed) return;
    this.ready = true;
    this.watchViewport();
    // epub.js 的声明把 location range 写成了单个 location，运行时也可能返回 Promise。
    const location = await Promise.resolve(rendition.currentLocation() as unknown as EpubLocation | Promise<EpubLocation>);
    if (this.destroyed) return;
    this.emitProgress(location);
    // 封面异步提取，不阻塞首屏；仅允许本地 Blob，禁止跟随书籍中的外部 URL。
    void book.coverUrl().then(async url => {
      if (this.destroyed || !url?.startsWith('blob:')) return;
      const blob = await (await fetch(url)).blob();
      if (blob.size > 1_400_000 || !/^image\/(png|jpeg|webp|gif)$/.test(blob.type)) return;
      const cover = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
      if (!this.destroyed) this.events.metadata({ cover });
    }).catch(() => undefined);
  }
  private emitProgress(location: EpubLocation): void {
    if (!location.start?.cfi || !this.book || this.destroyed) return;
    const spineLength = (this.book.spine as unknown as { length: number }).length;
    const hasLocations = this.book.locations.length() > 1;
    this.events.progress(progress({ format: 'epub', cfi: location.start.cfi }, estimateEpubProgress(location, spineLength, hasLocations)));
  }
  private onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'h') {
      event.preventDefault();
      if (!event.repeat) window.dispatchEvent(new CustomEvent('vsread:toggle-focus'));
      return;
    }
    if (event.key === 'Escape') {
      if (!event.repeat) window.dispatchEvent(new CustomEvent('vsread:exit-focus'));
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || document.querySelector('[role="dialog"]') || (event.target as HTMLElement)?.closest('input,select,textarea,[contenteditable]')) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); this.scroll(event.key === 'ArrowDown' ? 1 : -1); }
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); void this.next().catch(this.events.error); }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); void this.previous().catch(this.events.error); }
  };
  private viewport(): HTMLElement { return this.container.querySelector<HTMLElement>('.epub-container') ?? this.container; }
  private watchViewport(): void {
    if (this.destroyed) return;
    const viewport = this.viewport();
    if (viewport === this.watchedViewport) return;
    this.watchedViewport?.removeEventListener('scroll', this.onViewportScroll);
    this.watchedViewport = viewport;
    viewport.addEventListener('scroll', this.onViewportScroll, { passive: true });
  }
  private onViewportScroll = () => {
    clearTimeout(this.scrollTimer);
    if (!this.ready || this.destroyed || this.moving) return;
    // epub.js 的 silent scroll 会吞掉切章后的首个 scroll；单次滚动也必须更新 CFI。
    this.scrollTimer = setTimeout(() => {
      if (this.ready && !this.destroyed && !this.moving) void this.rendition?.reportLocation().catch(this.events.error);
    }, 80);
  };
  scroll(direction: -1 | 1): void {
    if (this.destroyed || !this.ready) return;
    const viewport = this.viewport();
    const contents = this.rendition?.getContents() as unknown as Contents[] | undefined;
    const surface = viewport.scrollHeight > viewport.clientHeight + 1 ? viewport : contents?.map(content => content.document.scrollingElement as HTMLElement | null).find(node => node && node.scrollHeight > node.clientHeight + 1);
    if (surface) scrollReadingSurface(surface, direction, this.settings.fontSize * this.settings.lineHeight);
  }
  private async move(direction: 'next' | 'prev'): Promise<void> {
    const rendition = this.rendition;
    if (this.destroyed || !this.ready || !rendition || this.moving) return;
    focusReadingSurface(this.container);
    this.moving = true;
    clearTimeout(this.scrollTimer);
    stopReadingScroll(this.viewport());
    try {
      if (this.settings.flow === 'scrolled') {
        const index = (rendition.getContents() as unknown as Contents[])[0]?.sectionIndex;
        const section = typeof index === 'number' ? this.book?.spine.get(index) : undefined;
        const target = direction === 'next' ? section?.next() : section?.prev();
        if (!target) return;
        // prev() 的 prepend/resize 会补偿滚动位置；滚动阅读直接显示邻章，保证从章首开始。
        await rendition.display(target.href);
        if (this.destroyed) return;
        resetReadingScroll(this.viewport());
        this.watchViewport();
        await rendition.reportLocation();
      } else await rendition[direction]();
    } finally { this.moving = false; }
  }
  async next(): Promise<void> { await this.move('next'); }
  async previous(): Promise<void> { await this.move('prev'); }
  async goTo(target: string): Promise<void> {
    if (!this.destroyed) {
      focusReadingSurface(this.container);
      clearTimeout(this.scrollTimer);
      stopReadingScroll(this.viewport());
      await this.rendition?.display(target);
      if (!this.destroyed) this.watchViewport();
    }
  }
  update(settings: ReaderSettings): void {
    const oldFlow = this.settings.flow;
    this.settings = settings;
    if (!this.rendition) return;
    const contents = this.rendition.getContents() as unknown as Contents[];
    contents.forEach(content => this.applyContentSettings(content));
    if (oldFlow !== settings.flow) this.rendition.flow(settings.flow === 'scrolled' ? 'scrolled-doc' : 'paginated');
    if (this.ready) this.watchViewport();
  }
  private applyContentSettings(contents: Contents): void {
    const settings = this.settings;
    const colors = readingColors(settings);
    const document = contents.document;
    let style = document.getElementById('vsread-reader-style') as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = 'vsread-reader-style';
      (document.head ?? document.documentElement).append(style);
    }
    // 独立替换样式节点，避免 epub.js registerRules 在每次拖动字号时累积 CSS 规则。
    // 正文段落和 span 采用用户偏好，标题仍保留书籍自身的颜色与字号层次。
    style.textContent = `
      html, body {
        color: ${colors.foreground} !important;
        background: ${colors.background} !important;
        font-size: ${settings.fontSize}px !important;
        line-height: ${settings.lineHeight} !important;
        font-family: ${settings.fontFamily === 'serif' ? 'SimSun, serif' : 'system-ui, sans-serif'} !important;
      }
      body { padding: 20px 28px !important; }
      html body :is(p, div, section, article, main, li, blockquote, span, font, td, dd, dt):not(h1 *, h2 *, h3 *, h4 *, h5 *, h6 *) {
        color: ${colors.foreground} !important;
        background-color: transparent !important;
        font-size: ${settings.fontSize}px !important;
        line-height: ${settings.lineHeight} !important;
        font-family: ${settings.fontFamily === 'serif' ? 'SimSun, serif' : 'system-ui, sans-serif'} !important;
      }
      img { max-width: 100% !important; height: auto !important; }
      a { color: inherit !important; }
    `;
  }
  destroy(): void {
    this.abort.abort();
    this.destroyed = true;
    this.ready = false;
    clearTimeout(this.scrollTimer);
    this.watchedViewport?.removeEventListener('scroll', this.onViewportScroll);
    this.book?.destroy();
    this.container.replaceChildren();
  }
}
