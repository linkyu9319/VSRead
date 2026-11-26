import { TextLayer, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { OpenBook, ReaderSettings, ReadingPosition, TocItem } from '../../shared/model';
import { progress, type ReaderAdapter, type ReaderEvents, type SearchHit } from './types';
import { acquirePdf, type PdfResource } from './pdfResources';
import type { PdfLease } from './PdfSessionCache';
import { resetReadingScroll, scrollReadingSurface, stopReadingScroll } from './readerScroll';

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

interface RenderedPage {
  element: HTMLElement; canvas: HTMLCanvasElement; textLayer: TextLayer; page: PDFPageProxy; pixels: number;
}

export class PdfReader implements ReaderAdapter {
  private document?: PDFDocumentProxy;
  private lease?: PdfLease<PdfResource>;
  private renderTask?: RenderTask;
  private textLayer?: TextLayer;
  private pageNumber = 1;
  private generation = 0;
  private searchGeneration = 0;
  private destroyed = false;
  private rendering = false;
  private resize: ResizeObserver;
  private width = 0;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private prefetchTimer?: ReturnType<typeof setTimeout>;
  private frame = 0;
  private displayedKey = '';
  private pageCache = new Map<string, RenderedPage>();
  private textCache = new Map<number, Promise<TextContent>>();
  private preparedPages = new Map<number, PDFPageProxy>();

  constructor(private container: HTMLElement, private settings: ReaderSettings, private events: ReaderEvents) {
    container.className = 'engine-surface pdf-surface';
    this.width = container.clientWidth;
    container.addEventListener('scroll', this.onScroll, { passive: true });
    this.resize = new ResizeObserver(() => {
      if (Math.abs(this.width - container.clientWidth) < 2) return;
      this.width = container.clientWidth;
      clearTimeout(this.resizeTimer);
      // 首次 ResizeObserver 通知不应启动第二次首屏绘制，尺寸稳定后才重新排版。
      if (!this.document || !this.displayedKey) return;
      this.resizeTimer = setTimeout(() => { if (!this.destroyed) void this.show(this.pageNumber, this.scrollRatio()).catch(this.events.error); }, 180);
    });
    this.resize.observe(container);
  }

  async load(source: OpenBook, position?: ReadingPosition): Promise<void> {
    const resources = new URL('pdf/', document.querySelector<HTMLScriptElement>('script[src]')!.src).href;
    const lease = this.lease = acquirePdf(source, resources);
    const resource = await lease.ready;
    if (this.destroyed) return;
    this.document = resource.document;
    this.width = this.container.clientWidth;
    // 阅读优先：首屏只等待当前页，元数据与完整目录在首屏出现后异步补齐。
    await this.show(position?.format === 'pdf' ? position.page : 1, position?.format === 'pdf' ? position.scroll : 0);
    if (this.destroyed) return;
    void this.loadBookDetails(resource.document);
  }

  private async loadBookDetails(pdf: PDFDocumentProxy): Promise<void> {
    const metadata = pdf.getMetadata().then(metadata => {
      if (this.destroyed) return;
      const info = metadata.info as { Title?: string; Author?: string };
      if (info.Title || info.Author) this.events.metadata({ title: info.Title, author: info.Author });
    });
    const outline = pdf.getOutline().then(outline => {
      if (this.destroyed) return;
      const mapOutline = (items: NonNullable<typeof outline>): TocItem[] => items.flatMap(item => {
        const children = item.items.length ? mapOutline(item.items) : [];
        return item.dest ? [{ id: `dest:${JSON.stringify(item.dest)}`, label: item.title, children: children.length ? children : undefined }] : children;
      });
      const items = outline?.length ? mapOutline(outline) : [];
      this.events.toc(items.length ? items : Array.from({ length: pdf.numPages }, (_, i) => ({ id: String(i + 1), label: `第 ${i + 1} 页` })));
    });
    await Promise.allSettled([metadata, outline]);
  }

  private async show(number: number, scroll = 0): Promise<void> {
    const pdf = this.document;
    if (!pdf || this.destroyed) return;
    const generation = ++this.generation;
    this.renderTask?.cancel();
    this.textLayer?.cancel();
    clearTimeout(this.prefetchTimer);
    this.rendering = true;
    stopReadingScroll(this.container);
    this.pageNumber = Math.max(1, Math.min(pdf.numPages, number));
    let unfinished: RenderedPage | undefined;
    try {
      const page = await pdf.getPage(this.pageNumber);
      if (this.destroyed || generation !== this.generation) return;
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(1.5, Math.max(0.2, (this.container.clientWidth - 48) / original.width)) * this.settings.zoom;
      const viewport = page.getViewport({ scale });
      // 当前页最多约 24 MB 像素；三个最近页面共享约 40 MB 预算，避免扫描件常驻大画布。
      const outputScale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(6_000_000 / (viewport.width * viewport.height)));
      const key = `${this.pageNumber}:${scale.toFixed(5)}:${outputScale.toFixed(3)}`;
      const cached = this.pageCache.get(key);
      if (cached) {
        this.pageCache.delete(key);
        this.pageCache.set(key, cached);
        this.display(cached, key, scroll);
        return;
      }
      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page';
      wrapper.style.width = `${viewport.width}px`;
      wrapper.style.height = `${viewport.height}px`;
      wrapper.style.setProperty('--scale-factor', String(scale));
      wrapper.style.setProperty('--total-scale-factor', String(scale));
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-label', `第 ${this.pageNumber} 页`);
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const textContainer = document.createElement('div');
      textContainer.className = 'textLayer';
      wrapper.append(canvas, textContainer);
      const preparedText = this.textCache.get(page.pageNumber);
      const text = preparedText ? await preparedText : page.streamTextContent();
      if (this.destroyed || generation !== this.generation) { canvas.width = canvas.height = 0; return; }
      const layer = this.textLayer = new TextLayer({ textContentSource: text, container: textContainer, viewport });
      unfinished = { element: wrapper, canvas, textLayer: layer, page, pixels: canvas.width * canvas.height };
      const renderTask = this.renderTask = page.render({ canvas, viewport, transform: [outputScale, 0, 0, outputScale, 0, 0] });
      // 文字层与像素绘制可以并行；完成后一次替换，翻页期间保留上一页而不是展示空白画布。
      await Promise.all([renderTask.promise, layer.render()]);
      if (this.destroyed || generation !== this.generation) return;
      this.pageCache.set(key, unfinished);
      this.display(unfinished, key, scroll);
      unfinished = undefined;
      this.trimPages();
    } catch (error) {
      if (!this.destroyed && generation === this.generation && (error as Error).name !== 'RenderingCancelledException') throw error;
    } finally {
      if (unfinished) { unfinished.textLayer.cancel(); unfinished.canvas.width = unfinished.canvas.height = 0; }
      if (generation === this.generation) this.rendering = false;
    }
  }

  private display(page: RenderedPage, key: string, scroll: number): void {
    this.displayedKey = key;
    this.container.replaceChildren(page.element);
    resetReadingScroll(this.container, Math.min(1, Math.max(0, scroll)) * Math.max(0, this.container.scrollHeight - this.container.clientHeight));
    this.rendering = false;
    this.emit();
    this.prefetchTimer = setTimeout(() => { void this.prepareNextPage(); }, 200);
  }

  private pageText(page: PDFPageProxy): Promise<TextContent> {
    let promise = this.textCache.get(page.pageNumber);
    if (!promise) {
      promise = page.getTextContent();
      this.textCache.set(page.pageNumber, promise);
      if (this.textCache.size > 8) this.textCache.delete(this.textCache.keys().next().value!);
      void promise.catch(() => { if (this.textCache.get(page.pageNumber) === promise) this.textCache.delete(page.pageNumber); });
    }
    return promise;
  }
  private async prepareNextPage(): Promise<void> {
    const pdf = this.document;
    const number = this.pageNumber + 1;
    if (!pdf || this.destroyed || number > pdf.numPages || this.rendering) return;
    try {
      const page = await pdf.getPage(number);
      if (this.destroyed || number !== this.pageNumber + 1) return;
      this.preparedPages.set(number, page);
      await Promise.all([page.getOperatorList(), this.pageText(page)]);
      for (const [preparedNumber, prepared] of this.preparedPages) {
        if (Math.abs(preparedNumber - this.pageNumber) <= 1) continue;
        this.preparedPages.delete(preparedNumber);
        if (![...this.pageCache.values()].some(item => item.page === prepared)) prepared.cleanup();
      }
    } catch { /* 邻页预热失败不影响当前页，实际翻页仍会显示可理解的错误。 */ }
  }
  private trimPages(): void {
    let pixels = [...this.pageCache.values()].reduce((sum, item) => sum + item.pixels, 0);
    for (const [key, page] of this.pageCache) {
      if (this.pageCache.size <= 3 && pixels <= 10_000_000) break;
      if (key === this.displayedKey) continue;
      this.pageCache.delete(key);
      pixels -= page.pixels;
      page.textLayer.cancel();
      page.canvas.width = page.canvas.height = 0;
      if (![...this.pageCache.values()].some(item => item.page === page.page) && !this.preparedPages.has(page.page.pageNumber)) page.page.cleanup();
    }
  }

  private scrollRatio(): number { return this.container.scrollTop / Math.max(1, this.container.scrollHeight - this.container.clientHeight); }
  private emit(): void {
    if (this.destroyed || this.rendering || !this.document) return;
    this.events.progress(progress({ format: 'pdf', page: this.pageNumber, scroll: this.scrollRatio() }, (this.pageNumber - 1 + this.scrollRatio()) / this.document.numPages));
  }
  private onScroll = () => { cancelAnimationFrame(this.frame); this.frame = requestAnimationFrame(() => this.emit()); };
  scroll(direction: -1 | 1): void {
    if (!this.destroyed && !this.rendering && this.document) scrollReadingSurface(this.container, direction);
  }
  async next(): Promise<void> { if (this.document && this.pageNumber < this.document.numPages) await this.show(this.pageNumber + 1); }
  async previous(): Promise<void> { if (this.pageNumber > 1) await this.show(this.pageNumber - 1); }
  async goTo(target: string): Promise<void> {
    if (!this.document) return;
    if (target.startsWith('dest:')) {
      const destination = JSON.parse(target.slice(5));
      const resolved = typeof destination === 'string' ? await this.document.getDestination(destination) : destination;
      if (!resolved?.length || this.destroyed) return;
      const index = typeof resolved[0] === 'number' ? resolved[0] : await this.document.getPageIndex(resolved[0]);
      await this.show(index + 1);
    } else if (/^\d+$/.test(target)) await this.show(Number(target));
  }
  async search(query: string): Promise<SearchHit[]> {
    const pdf = this.document;
    if (!pdf || !query.trim()) return [];
    const token = ++this.searchGeneration;
    const hits: SearchHit[] = [];
    for (let i = 1; i <= pdf.numPages && hits.length < 100 && !this.destroyed && token === this.searchGeneration; i++) {
      const page = await pdf.getPage(i);
      const text = await this.pageText(page);
      if (![...this.pageCache.values()].some(item => item.page === page) && !this.preparedPages.has(i)) page.cleanup();
      if (this.destroyed || token !== this.searchGeneration) break;
      const content = text.items.map(item => 'str' in item ? item.str : '').join(' ');
      const at = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      if (at >= 0) hits.push({ id: String(i), label: `第 ${i} 页 · ${content.slice(Math.max(0, at - 20), at + 80)}` });
    }
    return hits;
  }
  update(settings: ReaderSettings): void {
    const zoomChanged = this.settings.zoom !== settings.zoom;
    this.settings = settings;
    if (zoomChanged && this.document) void this.show(this.pageNumber, this.scrollRatio()).catch(this.events.error);
  }
  destroy(): void {
    // 销毁 DOM 不重算位置；Worker 文档由有界会话缓存管理，画布则立即释放。
    this.destroyed = true;
    this.generation++;
    this.searchGeneration++;
    this.resize.disconnect();
    clearTimeout(this.resizeTimer);
    clearTimeout(this.prefetchTimer);
    cancelAnimationFrame(this.frame);
    this.container.removeEventListener('scroll', this.onScroll);
    this.renderTask?.cancel();
    this.textLayer?.cancel();
    for (const page of this.pageCache.values()) { page.textLayer.cancel(); page.canvas.width = page.canvas.height = 0; page.page.cleanup(); }
    for (const page of this.preparedPages.values()) page.cleanup();
    this.pageCache.clear(); this.preparedPages.clear(); this.textCache.clear();
    this.lease?.release();
    this.container.replaceChildren();
  }
}
