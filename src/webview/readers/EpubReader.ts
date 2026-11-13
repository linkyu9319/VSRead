import ePub, { type Book, type Rendition, type Contents } from 'epubjs';
import type { NavItem } from 'epubjs/types/navigation';
import type { OpenBook, ReaderSettings, ReadingPosition, TocItem } from '../../shared/model';
import { sanitizeEpubDocument } from './epubSecurity';
import { readBookBytes } from './bookBytes';
import { estimateEpubProgress, type EpubLocation } from './epubProgress';
import { progress, readingColors, type ReaderAdapter, type ReaderEvents } from './types';

export class EpubReader implements ReaderAdapter {
  private book?: Book;
  private rendition?: Rendition;
  private destroyed = false;
  private ready = false;
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
        if (target && /^(https?:|mailto:|file:|command:)/i.test(target.getAttribute('href') ?? '')) { event.preventDefault(); event.stopImmediatePropagation(); }
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
    if (event.ctrlKey || event.altKey || event.metaKey || (event.target as HTMLElement)?.closest('input,select,textarea,[contenteditable]')) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); void this.next().catch(this.events.error); }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); void this.previous().catch(this.events.error); }
  };
  async next(): Promise<void> { if (!this.destroyed) await this.rendition?.next(); }
  async previous(): Promise<void> { if (!this.destroyed) await this.rendition?.prev(); }
  async goTo(target: string): Promise<void> { if (!this.destroyed) await this.rendition?.display(target); }
  update(settings: ReaderSettings): void {
    const oldFlow = this.settings.flow;
    this.settings = settings;
    if (!this.rendition) return;
    const contents = this.rendition.getContents() as unknown as Contents[];
    contents.forEach(content => this.applyContentSettings(content));
    if (oldFlow !== settings.flow) this.rendition.flow(settings.flow === 'scrolled' ? 'scrolled-doc' : 'paginated');
  }
  private applyContentSettings(contents: Contents): void {
    const settings = this.settings;
    const colors = readingColors(settings);
    const document = contents.document;
    let style = document.getElementById('vsread-reader-style') as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = 'vsread-reader-style';
      document.head.append(style);
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
    this.book?.destroy();
    this.container.replaceChildren();
  }
}
