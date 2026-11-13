import path from 'node:path';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { BookSource, BuiltinSourceSummary, OnlineBookRecord, OnlineChapter, OnlineChapterContent, OnlineSearchResult, SourceImportResult } from '../../shared/online';
import { boundedNumber, isRecord } from '../../shared/validation';
import { requestText, type TextFetcher } from './network';
import { extract, loadHtml, normalizeSource, resolveSourceUrl, select, stableId } from './rules';
import { getBuiltinSource, listBuiltinSources } from './builtins';

interface StoredBook extends OnlineBookRecord { cacheSizes: Record<string, number> }
interface State { version: 1; sources: BookSource[]; books: StoredBook[] }
const MAX_CACHE_BYTES = 200 * 1024 * 1024;
const clone = <T>(value: T): T => structuredClone(value);

/** 在线书架与本地文件书库分开存储；目录和正文缓存可独立离线读取。 */
export class OnlineLibrary {
  private state: State = { version: 1, sources: [], books: [] };
  private writes = Promise.resolve();
  private network = Promise.resolve();
  private fetchText: TextFetcher;
  private activeChapters = new Map<string, Promise<OnlineChapterContent>>();
  private bookOperations = new Map<string, Promise<unknown>>();
  private cacheWrites = Promise.resolve();
  private sourceOperations = Promise.resolve();
  constructor(readonly root: string, options: { fetchText?: TextFetcher } = {}) { this.fetchText = options.fetchText ?? requestText; }

  async load(): Promise<void> {
    await mkdir(path.join(this.root, 'cache'), { recursive: true });
    let damaged = false;
    for (const name of ['online.json', 'online.backup.json']) {
      try {
        const data: unknown = JSON.parse(await readFile(path.join(this.root, name), 'utf8'));
        if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.sources) || !Array.isArray(data.books) || data.sources.length > 200 || data.books.length > 200) throw new Error('在线书库索引无效');
        const sources = data.sources.map(normalizeSource);
        const books = data.books.map(item => this.validateBook(item));
        this.state = { version: 1, sources, books };
        if (name.includes('backup')) await writeFile(path.join(this.root, 'online.json'), JSON.stringify(this.state), 'utf8');
        return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') damaged = true; }
    }
    if (damaged) throw new Error('在线书库索引及备份无法读取，请先备份在线数据目录');
  }
  listSources(): BookSource[] { return clone(this.state.sources); }
  listBuiltinSources(): BuiltinSourceSummary[] { return listBuiltinSources(); }
  async addBuiltinSource(id: string): Promise<BookSource[]> {
    const source = getBuiltinSource(id);
    return this.withSources(async () => {
      const existing = this.state.sources.find(item => item.id === source.id);
      if (existing?.enabled) return this.listSources();
      const next = existing
        ? this.state.sources.map(item => item.id === source.id ? { ...item, enabled: true } : item)
        : [...this.state.sources, source];
      await this.commitSources(next);
      return this.listSources();
    });
  }
  listBooks(): OnlineBookRecord[] { return this.state.books.map(book => this.publicBook(book)); }

  async importSources(input: { json?: string; url?: string }): Promise<SourceImportResult> {
    if (typeof input.json !== 'string' && typeof input.url !== 'string') throw new Error('请提供书源 JSON 或订阅地址');
    const json = input.url ? (await this.request(input.url, 2 * 1024 * 1024)).text : input.json!;
    if (Buffer.byteLength(json, 'utf8') > 2 * 1024 * 1024) throw new Error('书源 JSON 不能超过 2 MB');
    let values: unknown;
    try { values = JSON.parse(json); } catch { throw new Error('书源 JSON 格式无效'); }
    const entries = Array.isArray(values) ? values : [values];
    if (entries.length > 200) throw new Error('一次最多导入 200 个书源');
    const rejected: SourceImportResult['rejected'] = [];
    const accepted: BookSource[] = [];
    for (const value of entries) {
      try { accepted.push(normalizeSource(value)); }
      catch (error) { rejected.push({ name: isRecord(value) ? String(value.name ?? value.bookSourceName ?? '未命名书源').slice(0, 200) : '无效书源', reason: error instanceof Error ? error.message : '规则无效' }); }
    }
    return this.withSources(async () => {
      const next = new Map(this.state.sources.map(source => [source.id, source]));
      for (const source of accepted) next.set(source.id, source);
      await this.commitSources([...next.values()]);
      return { sources: this.listSources(), imported: new Set(accepted.map(source => source.id)).size, rejected };
    });
  }
  async toggleSource(id: string, enabled: boolean): Promise<BookSource[]> {
    if (typeof enabled !== 'boolean') throw new Error('书源状态无效');
    return this.withSources(async () => {
      this.source(id);
      await this.commitSources(this.state.sources.map(source => source.id === id ? { ...source, enabled } : source));
      return this.listSources();
    });
  }
  async removeSource(id: string): Promise<BookSource[]> {
    return this.withSources(async () => {
      this.source(id);
      await this.commitSources(this.state.sources.filter(source => source.id !== id));
      return this.listSources();
    });
  }

  async search(sourceId: string, query: string, page = 1): Promise<OnlineSearchResult[]> {
    const source = this.source(sourceId, true);
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('搜索内容需要 1–200 个字符');
    if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new Error('搜索页码无效');
    const target = source.searchUrl.replace(/\{\{\s*key\s*\}\}/g, encodeURIComponent(query.trim())).replace(/\{\{\s*page\s*\}\}/g, String(page));
    const response = await this.request(resolveSourceUrl(source, target));
    const $ = loadHtml(response.text);
    const results: OnlineSearchResult[] = [];
    const seen = new Set<string>();
    select($, source.search.bookList).slice(0, 100).each((_index, element) => {
      const item = $(element);
      const title = extract($, item, source.search.name).slice(0, 300);
      const href = extract($, item, source.search.bookUrl);
      if (!title || !href) return;
      try {
        const url = resolveSourceUrl(source, href, response.url);
        if (seen.has(url)) return;
        seen.add(url);
        results.push({ sourceId, title, author: extract($, item, source.search.author).slice(0, 300) || undefined, url });
      } catch { /* 外部推荐或广告链接不作为书籍结果。 */ }
    });
    return results;
  }
  async add(result: OnlineSearchResult): Promise<OnlineBookRecord> {
    if (!isRecord(result) || typeof result.title !== 'string' || !result.title.trim() || result.title.length > 300 || typeof result.url !== 'string' || typeof result.sourceId !== 'string') throw new Error('搜索结果无效');
    const source = this.source(result.sourceId, true);
    const url = resolveSourceUrl(source, result.url);
    const id = stableId(source.id + '\n' + url);
    return this.withBook(id, async () => {
      const existing = this.state.books.find(book => book.id === id);
      if (existing) return this.publicBook(existing);
      if (this.state.books.length >= 200) throw new Error('在线书架最多保存 200 本书');
      const book: StoredBook = { id, sourceId: source.id, title: result.title.trim(), author: typeof result.author === 'string' ? result.author.slice(0, 300) : undefined, url, addedAt: new Date().toISOString(), chapters: [], cachedChapters: [], cacheSizes: {} };
      // 先取得可用目录，再加入书架；无效规则不会留下无法阅读的空条目。
      await this.refreshToc(book, source);
      this.state.books.push(book);
      try { await this.save(); }
      catch (error) {
        // 保存失败必须撤回内存条目，后续重试才会再次落盘，而不是命中“已存在”。
        this.state.books = this.state.books.filter(item => item !== book);
        throw error;
      }
      return this.publicBook(book);
    });
  }
  async open(id: string, refresh = false): Promise<OnlineBookRecord> {
    return this.withBook(id, async () => {
    const book = this.book(id);
    if (refresh || !book.chapters.length) { await this.refreshToc(book, this.source(book.sourceId, true)); await this.save(); }
    return this.publicBook(book);
    });
  }
  async chapter(id: string, number: number, refresh = false): Promise<OnlineChapterContent> {
    return this.withBook(id, () => this.chapterData(id, number, refresh));
  }
  private async chapterData(id: string, number: number, refresh: boolean): Promise<OnlineChapterContent> {
    const book = this.book(id);
    if (!Number.isSafeInteger(number) || number < 0 || number >= book.chapters.length) throw new Error('章节不存在');
    const chapter = book.chapters[number];
    const key = `${id}/${chapter.id}`;
    if (!refresh) {
      try {
        const text = await readFile(this.cacheFile(book, chapter), 'utf8');
        return { chapter: clone(chapter), text, cached: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (book.cacheSizes[chapter.id] !== undefined) { delete book.cacheSizes[chapter.id]; this.syncCached(book); await this.save(); }
      }
    }
    const active = this.activeChapters.get(key);
    if (active) return active;
    const operation = this.fetchChapter(book, chapter).finally(() => this.activeChapters.delete(key));
    this.activeChapters.set(key, operation);
    return operation;
  }
  async saveProgress(id: string, chapter: number, scroll: number): Promise<void> {
    const book = this.book(id);
    if (!Number.isSafeInteger(chapter) || !book.chapters[chapter] || typeof scroll !== 'number' || !Number.isFinite(scroll)) throw new Error('在线阅读位置无效');
    book.progress = { chapter, scroll: boundedNumber(scroll, 0, 1, 0), updatedAt: new Date().toISOString() };
    await this.save();
  }
  async cacheChapters(id: string, from: number, count: number): Promise<{ cached: number; failed: number }> {
    const book = this.book(id);
    if (!Number.isSafeInteger(from) || from < 0 || !book.chapters[from] || !Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error('每次可以缓存 1–20 个章节');
    let cached = 0, failed = 0;
    for (let i = from; i < Math.min(book.chapters.length, from + count); i++) {
      try { await this.chapter(id, i); cached++; } catch { failed++; }
    }
    return { cached, failed };
  }
  async clearCache(id: string): Promise<OnlineBookRecord> {
    return this.withBook(id, () => this.clearBookCache(id));
  }
  private async clearBookCache(id: string): Promise<OnlineBookRecord> {
    const book = this.book(id);
    // 缓存路径仅由已验证哈希构成，源配置不能指定本地文件名。
    await rm(path.join(this.root, 'cache', book.id), { recursive: true, force: true });
    book.cacheSizes = {}; this.syncCached(book);
    await this.save();
    return this.publicBook(book);
  }
  async removeBook(id: string): Promise<OnlineBookRecord[]> {
    return this.withBook(id, async () => {
      const book = this.book(id);
      const index = this.state.books.indexOf(book);
      this.state.books.splice(index, 1);
      try { await this.save(); }
      catch (error) {
        // 先提交索引，再删除缓存；写盘失败时书籍及离线正文仍完整保留。
        this.state.books.splice(Math.min(index, this.state.books.length), 0, book);
        throw error;
      }
      await rm(path.join(this.root, 'cache', book.id), { recursive: true, force: true });
      return this.listBooks();
    });
  }
  flush(): Promise<void> { return Promise.all([this.sourceOperations, this.writes]).then(() => undefined); }

  private withSources<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.sourceOperations.then(operation);
    this.sourceOperations = pending.then(() => undefined, () => undefined);
    return pending;
  }
  private async commitSources(next: BookSource[]): Promise<void> {
    if (next.length > 200) throw new Error('最多保存 200 个书源，请先移除不需要的书源');
    const previous = this.state.sources;
    this.state.sources = next;
    try { await this.save(); }
    catch (error) {
      // 书源变更串行提交；失败恢复原数组，不会覆盖随后排队的导入、启停或移除。
      this.state.sources = previous;
      throw error;
    }
  }

  private request(url: string, maxBytes?: number) {
    const operation = this.network.then(() => this.fetchText(url, { maxBytes }));
    this.network = operation.then(() => undefined, () => undefined);
    return operation;
  }
  private withBook<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.bookOperations.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.bookOperations.set(id, pending);
    void pending.finally(() => { if (this.bookOperations.get(id) === pending) this.bookOperations.delete(id); }).catch(() => undefined);
    return pending;
  }
  private source(id: string, requireEnabled = false): BookSource {
    const source = this.state.sources.find(source => source.id === id);
    if (!source) throw new Error('书源已移除；已缓存的章节仍可离线阅读');
    if (requireEnabled && !source.enabled) throw new Error('该书源已停用；已缓存的章节仍可离线阅读');
    return source;
  }
  private book(id: string): StoredBook {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('在线书籍标识无效');
    const book = this.state.books.find(book => book.id === id);
    if (!book) throw new Error('在线书籍不存在');
    return book;
  }
  private publicBook(book: StoredBook): OnlineBookRecord {
    const { cacheSizes: _cacheSizes, ...value } = book;
    return clone(value);
  }
  private cacheFile(book: StoredBook, chapter: OnlineChapter): string { return path.join(this.root, 'cache', book.id, chapter.id + '.txt'); }
  private syncCached(book: StoredBook): void { book.cachedChapters = book.chapters.flatMap((chapter, index) => book.cacheSizes[chapter.id] === undefined ? [] : [index]); }
  private async refreshToc(book: StoredBook, source: BookSource): Promise<void> {
    const response = await this.request(resolveSourceUrl(source, book.url));
    let $ = loadHtml(response.text);
    const title = extract($, $.root(), source.bookInfo?.name);
    const author = extract($, $.root(), source.bookInfo?.author);
    const tocHref = extract($, $.root(), source.bookInfo?.tocUrl);
    let base = response.url;
    if (tocHref) {
      const target = resolveSourceUrl(source, tocHref, base);
      if (target !== base) { const tocPage = await this.request(target); $ = loadHtml(tocPage.text); base = tocPage.url; }
    }
    const chapters: OnlineChapter[] = [];
    const seen = new Set<string>();
    const selected = select($, source.toc.chapterList);
    if (selected.length > 20_000) throw new Error('目录超过 20,000 章，已停止解析');
    selected.each((_index, node) => {
      const item = $(node);
      const title = extract($, item, source.toc.chapterName).slice(0, 300);
      const href = extract($, item, source.toc.chapterUrl);
      if (!title || !href) return;
      try {
        const url = resolveSourceUrl(source, href, base);
        if (seen.has(url)) return;
        seen.add(url);
        chapters.push({ id: stableId(url), title, url });
      } catch { /* 外部导航不属于当前书源目录。 */ }
    });
    if (!chapters.length) throw new Error('没有解析到章节，请检查目录规则或站点是否需要登录/脚本');
    const oldChapter = book.progress && book.chapters[book.progress.chapter]?.id;
    if (oldChapter && book.progress) {
      const index = chapters.findIndex(chapter => chapter.id === oldChapter);
      book.progress = index >= 0 ? { ...book.progress, chapter: index } : undefined;
    }
    book.chapters = chapters;
    if (title) book.title = title.slice(0, 300);
    if (author) book.author = author.slice(0, 300);
    this.syncCached(book);
  }
  private async fetchChapter(book: StoredBook, chapter: OnlineChapter): Promise<OnlineChapterContent> {
    const source = this.source(book.sourceId, true);
    const response = await this.request(resolveSourceUrl(source, chapter.url));
    const $ = loadHtml(response.text);
    const text = extract($, $.root(), source.content.content, true);
    if (!text) throw new Error('正文为空，请检查正文规则或该章节是否需要登录/脚本');
    // 不同书籍也共享缓存预算；把检查和提交串行化，避免并发下载同时越过体积上限。
    const operation = this.cacheWrites.then(async () => {
    const bytes = Buffer.byteLength(text, 'utf8');
    const oldSize = book.cacheSizes[chapter.id] ?? 0;
    const bookSize = Object.values(book.cacheSizes).reduce((sum, value) => sum + value, 0) - oldSize + bytes;
    const total = this.state.books.reduce((sum, item) => sum + Object.values(item.cacheSizes).reduce((a, b) => a + b, 0), 0) - oldSize + bytes;
    if (bookSize > 100 * 1024 * 1024 || total > MAX_CACHE_BYTES) throw new Error('离线缓存已达到体积上限，请先清理不需要的缓存');
    const filename = this.cacheFile(book, chapter);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename + '.tmp', text, 'utf8');
    await rename(filename + '.tmp', filename);
    book.cacheSizes[chapter.id] = bytes;
    this.syncCached(book);
    await this.save();
    });
    this.cacheWrites = operation.catch(() => undefined);
    await operation;
    return { chapter: clone(chapter), text, cached: false };
  }
  private validateBook(value: unknown): StoredBook {
    if (!isRecord(value) || typeof value.id !== 'string' || !/^[a-f0-9]{64}$/.test(value.id) || typeof value.sourceId !== 'string' || typeof value.title !== 'string' || typeof value.url !== 'string' || !Array.isArray(value.chapters) || value.chapters.length > 20_000) throw new Error('在线书籍记录无效');
    for (const chapter of value.chapters) {
      if (!isRecord(chapter) || typeof chapter.id !== 'string' || !/^[a-f0-9]{64}$/.test(chapter.id) || typeof chapter.title !== 'string' || typeof chapter.url !== 'string') throw new Error('在线章节记录无效');
    }
    const book = value as unknown as StoredBook;
    const sizes: Record<string, number> = {};
    if (isRecord(value.cacheSizes)) for (const [id, size] of Object.entries(value.cacheSizes)) if (/^[a-f0-9]{64}$/.test(id) && typeof size === 'number' && Number.isSafeInteger(size) && size >= 0) sizes[id] = size;
    book.cacheSizes = sizes;
    if (book.progress && (!Number.isSafeInteger(book.progress.chapter) || !book.chapters[book.progress.chapter] || !Number.isFinite(book.progress.scroll))) book.progress = undefined;
    this.syncCached(book);
    return book;
  }
  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state);
    if (Buffer.byteLength(snapshot, 'utf8') > 20 * 1024 * 1024) throw new Error('在线书库索引过大，请移除不需要的书籍');
    const operation = this.writes.then(async () => {
      const filename = path.join(this.root, 'online.json');
      await writeFile(filename + '.tmp', snapshot, 'utf8');
      try { await copyFile(filename, path.join(this.root, 'online.backup.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(filename + '.tmp', filename);
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
}
