import path from 'node:path';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { BatchUpdateSummary, BookSource, BuiltinSourceSummary, CacheAllJob, OnlineBookRecord, OnlineChapter, OnlineChapterContent, OnlineSearchResult, ReplaceRule, SourceImportResult } from '../../shared/online';
import { boundedNumber, isRecord } from '../../shared/validation';
import { requestText, type TextFetcher, type TextResponse } from './network';
import { normalizeSource, resolveSourceUrl, stableId } from './rules';
import { getBuiltinSource, listBuiltinSources } from './builtins';
import { sourceDocument } from './document';
import { applyReplaceRules, matchChapterIndex, normalizeReplaceRule, normalizeReplaceRules } from './replaceRules';
import { diagnosticError, diagnosticUrl, type DiagnosticSink } from '../diagnostics';

interface StoredBook extends OnlineBookRecord { cacheSizes: Record<string, number> }
interface State { version: 1; sources: BookSource[]; books: StoredBook[]; replaceRules?: ReplaceRule[] }
interface CacheAllTask {
  state: CacheAllJob['state']; cancelRequested: boolean; failedIds: Set<string>;
  currentChapter?: number; error?: string; done: Promise<void>; wake?(): void;
}
interface BookLockState {
  activeReaders: number; writerActive: boolean;
  waitingReaders: (() => void)[]; waitingWriters: (() => void)[];
}
const MAX_CACHE_BYTES = 200 * 1024 * 1024;
const clone = <T>(value: T): T => structuredClone(value);

/** 在线书架与本地文件书库分开存储；目录和正文缓存可独立离线读取。 */
export class OnlineLibrary {
  private state: State = { version: 1, sources: [], books: [] };
  private writes = Promise.resolve();
  private network = new Map<string, Promise<void>>();
  private fetchText: TextFetcher;
  private activeChapters = new Map<string, Promise<OnlineChapterContent>>();
  private bookLocks = new Map<string, BookLockState>();
  private chapterOperations = new Map<string, Promise<unknown>>();
  private cacheWrites = Promise.resolve();
  private sourceOperations = Promise.resolve();
  private cacheAllTasks = new Map<string, CacheAllTask>();
  private cacheMaintenance = new Map<string, number>();
  private cacheAllDelayMs: number;
  private log?: DiagnosticSink;
  constructor(readonly root: string, options: { fetchText?: TextFetcher; log?: DiagnosticSink; cacheAllDelayMs?: number } = {}) {
    this.fetchText = options.fetchText ?? requestText; this.log = options.log;
    this.cacheAllDelayMs = Math.max(0, Math.min(2000, options.cacheAllDelayMs ?? 200));
  }

  async load(): Promise<void> {
    await mkdir(path.join(this.root, 'cache'), { recursive: true });
    let damaged = false;
    for (const name of ['online.json', 'online.backup.json']) {
      try {
        const data: unknown = JSON.parse(await readFile(path.join(this.root, name), 'utf8'));
        if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.sources) || !Array.isArray(data.books) || data.sources.length > 200 || data.books.length > 200) throw new Error('在线书库索引无效');
        const sources = data.sources.map(normalizeSource);
        const books = data.books.map(item => this.validateBook(item));
        const replaceRules = normalizeReplaceRules(data.replaceRules);
        this.state = { version: 1, sources, books, replaceRules };
        if (name.includes('backup')) await writeFile(path.join(this.root, 'online.json'), JSON.stringify(this.state), 'utf8');
        return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') damaged = true; }
    }
    if (damaged) throw new Error('在线书库索引及备份无法读取，请先备份在线数据目录');
  }
  listSources(): BookSource[] { return clone(this.state.sources); }
  listBuiltinSources(): BuiltinSourceSummary[] { return listBuiltinSources(); }
  /** 未添加的内置源默认可选；用户保存的配置及停用状态优先于内置定义。 */
  listSearchSources(): BookSource[] {
    const available = new Map(listBuiltinSources().map(item => {
      const source = getBuiltinSource(item.id);
      return [source.id, source] as const;
    }));
    for (const source of this.state.sources) available.set(source.id, source);
    return clone([...available.values()].filter(source => source.enabled));
  }
  /** 搜索前一次性保存所选内置源，结果可直接加入书架；绝不重新启用停用源。 */
  async prepareSearchSources(ids: string[]): Promise<void> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) throw new Error('请选择 1–50 个有效书源');
    if (new Set(ids).size !== ids.length) throw new Error('请勿重复选择同一书源');
    const selected = [...ids];
    return this.withSources(async () => {
      const available = new Map(this.listSearchSources().map(source => [source.id, source]));
      const existing = new Set(this.state.sources.map(source => source.id));
      const additions: BookSource[] = [];
      for (const id of selected) {
        const source = available.get(id);
        if (!source) throw new Error('选中的书源已停用或不存在，请重新选择');
        if (!existing.has(id)) additions.push(source);
      }
      if (additions.length) await this.commitSources([...this.state.sources, ...additions]);
    });
  }
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
  listReplaceRules(): ReplaceRule[] { return clone(this.state.replaceRules ?? []); }
  async saveReplaceRule(input: unknown): Promise<ReplaceRule[]> {
    const inputId = isRecord(input) && typeof input.id === 'string' ? input.id : undefined;
    const rule = normalizeReplaceRule(input, inputId);
    await this.commitState(() => {
      const current = this.state.replaceRules ?? [];
      const exists = current.some(item => item.id === rule.id);
      if (!exists && current.length >= 200) throw new Error('最多保存 200 条净化规则');
      const next = exists ? current.map(item => item.id === rule.id ? rule : item) : [...current, rule];
      return {
        nextState: { ...this.state, replaceRules: next },
        apply: () => { this.state.replaceRules = next; },
      };
    });
    return this.listReplaceRules();
  }
  async toggleReplaceRule(id: string, enabled: boolean): Promise<ReplaceRule[]> {
    if (typeof enabled !== 'boolean') throw new Error('规则状态无效');
    await this.commitState(() => {
      const current = this.state.replaceRules ?? [];
      if (!current.some(item => item.id === id)) throw new Error('净化规则不存在');
      const next = current.map(item => item.id === id ? { ...item, enabled } : item);
      return {
        nextState: { ...this.state, replaceRules: next },
        apply: () => { this.state.replaceRules = next; },
      };
    });
    return this.listReplaceRules();
  }
  async removeReplaceRule(id: string): Promise<ReplaceRule[]> {
    await this.commitState(() => {
      const current = this.state.replaceRules ?? [];
      if (!current.some(item => item.id === id)) throw new Error('净化规则不存在');
      const next = current.filter(item => item.id !== id);
      return {
        nextState: { ...this.state, replaceRules: next },
        apply: () => { this.state.replaceRules = next; },
      };
    });
    return this.listReplaceRules();
  }

  async importSources(input: { json?: string; url?: string }): Promise<SourceImportResult> {
    if (typeof input.json !== 'string' && typeof input.url !== 'string') throw new Error('请提供书源 JSON 或订阅地址');
    const json = input.url ? (await this.request(input.url, 2 * 1024 * 1024, { operation: 'import', source: '外部书源配置' })).text : input.json!;
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

  async search(sourceId: string, query: string, page = 1, signal?: AbortSignal): Promise<OnlineSearchResult[]> {
    signal?.throwIfAborted();
    const source = this.source(sourceId, true);
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('搜索内容需要 1–200 个字符');
    if (!Number.isSafeInteger(page) || page < 1 || page > 100) throw new Error('搜索页码无效');
    const target = source.searchUrl.replace(/\{\{\s*key\s*\}\}/g, encodeURIComponent(query.trim())).replace(/\{\{\s*page\s*\}\}/g, String(page));
    const response = await this.request(resolveSourceUrl(source, target), undefined, { operation: 'search', source: source.name }, signal);
    signal?.throwIfAborted();
    const document = this.parsePage(source, response, 'search');
    const results: OnlineSearchResult[] = [];
    const seen = new Set<string>();
    for (const item of document.rows(source.search.bookList).slice(0, 100)) {
      const title = item.read(source.search.name).slice(0, 300);
      const href = item.read(source.search.bookUrl, 'url');
      if (!title || !href) continue;
      try {
        const url = resolveSourceUrl(source, href, response.url);
        if (seen.has(url)) continue;
        seen.add(url);
        results.push({ sourceId, title, author: item.read(source.search.author).slice(0, 300) || undefined, url });
      } catch { /* 外部推荐或广告链接不作为书籍结果。 */ }
    }
    return results;
  }
  async add(result: OnlineSearchResult): Promise<OnlineBookRecord> {
    if (!isRecord(result) || typeof result.title !== 'string' || !result.title.trim() || result.title.length > 300 || typeof result.url !== 'string' || typeof result.sourceId !== 'string') throw new Error('搜索结果无效');
    const source = this.source(result.sourceId, true);
    const url = resolveSourceUrl(source, result.url);
    const id = stableId(source.id + '\n' + url);
    return this.withBookExclusive(id, async () => {
      const existing = this.state.books.find(book => book.id === id);
      if (existing) return this.publicBook(existing);
      if (this.state.books.length >= 200) throw new Error('在线书架最多保存 200 本书');
      const book: StoredBook = { id, sourceId: source.id, title: result.title.trim(), author: typeof result.author === 'string' ? result.author.slice(0, 300) : undefined, url, addedAt: new Date().toISOString(), chapters: [], cachedChapters: [], cacheSizes: {} };
      // 先取得可用目录，再加入书架；无效规则不会留下无法阅读的空条目。
      const fetched = await this.fetchToc(book.url, source);
      this.applyToc(book, fetched);
      await this.commitState(() => {
        if (this.state.books.length >= 200) throw new Error('在线书架最多保存 200 本书');
        const books = [...this.state.books, book];
        return {
          nextState: { ...this.state, books },
          apply: () => { this.state.books = books; },
        };
      });
      return this.publicBook(book);
    });
  }
  async open(id: string, refresh = false): Promise<OnlineBookRecord> {
    if (refresh && this.cacheAllActive(id)) throw new Error('正在缓存全本，请先取消缓存后再刷新目录');
    const existing = !refresh ? this.state.books.find(book => book.id === id) : undefined;
    if (!refresh && existing?.chapters.length) {
      return this.withBookShared(id, async () => {
        const current = this.book(id);
        if (current.newChapters) {
          await this.commitBookUpdate(current, draft => { draft.newChapters = undefined; });
        }
        return this.publicBook(current);
      });
    }
    return this.withBookExclusive(id, async () => {
      if (refresh && this.cacheAllActive(id)) throw new Error('正在缓存全本，请先取消缓存后再刷新目录');
      const book = this.book(id);
      if (refresh || !book.chapters.length) {
        const fetched = await this.fetchToc(book.url, this.source(book.sourceId, true));
        // 先在统一串行队列内提交索引，写盘成功后再更新内存并删除旧正文，避免并发保存捕获未提交目录。
        const staleIds = await this.commitBookUpdate(book, draft => {
          draft.newChapters = undefined;
          draft.lastCheckedAt = new Date().toISOString();
          return this.applyToc(draft, fetched);
        });
        for (const staleId of staleIds) {
          await rm(path.join(this.root, 'cache', book.id, staleId + '.txt'), { force: true }).catch(() => undefined);
        }
      }
      return this.publicBook(book);
    });
  }
  async pinBook(id: string, pinned: boolean): Promise<OnlineBookRecord> {
    if (typeof pinned !== 'boolean') throw new Error('置顶状态无效');
    const book = this.book(id);
    await this.commitBookUpdate(book, draft => { draft.pinned = pinned || undefined; });
    return this.publicBook(book);
  }
  async switchSource(id: string, result: OnlineSearchResult): Promise<OnlineBookRecord> {
    if (this.cacheAllActive(id)) throw new Error('正在缓存全本，请先取消缓存后再换源');
    if (!isRecord(result) || typeof result.sourceId !== 'string' || typeof result.url !== 'string') throw new Error('目标书源信息无效');
    return this.withBookExclusive(id, async () => {
      if (this.cacheAllActive(id)) throw new Error('正在缓存全本，请先取消缓存后再换源');
      const book = this.book(id);
      const targetSource = this.source(result.sourceId, true);
      const targetUrl = resolveSourceUrl(targetSource, result.url);
      if (book.sourceId === targetSource.id && book.url === targetUrl) return this.publicBook(book);
      // 先验证新源目录可用再提交，换源失败时原目录与离线缓存完整保留。
      const fetched = await this.fetchToc(targetUrl, targetSource);
      await this.commitBookUpdate(book, draft => {
        const nextChapter = matchChapterIndex(draft.chapters, draft.progress?.chapter, fetched.chapters);
        draft.sourceId = targetSource.id;
        draft.url = targetUrl;
        draft.chapters = fetched.chapters;
        if (fetched.title) draft.title = fetched.title.slice(0, 300);
        if (fetched.author) draft.author = fetched.author.slice(0, 300);
        draft.cacheSizes = {};
        draft.cachedChapters = [];
        draft.newChapters = undefined;
        draft.lastCheckedAt = new Date().toISOString();
        draft.progress = { chapter: nextChapter, scroll: 0, updatedAt: new Date().toISOString() };
      });
      await rm(path.join(this.root, 'cache', book.id), { recursive: true, force: true }).catch(() => undefined);
      this.cacheAllTasks.delete(id);
      return this.publicBook(book);
    });
  }
  async checkAllUpdates(ids?: string[]): Promise<BatchUpdateSummary> {
    const targets = ids?.length
      ? ids.map(id => this.state.books.find(book => book.id === id)).filter((book): book is StoredBook => !!book)
      : [...this.state.books];
    const updated: BatchUpdateSummary['updated'] = [];
    const failed: BatchUpdateSummary['failed'] = [];
    let checked = 0;
    let skipped = 0;
    const queue = [...targets];
    const worker = async () => {
      while (queue.length) {
        const book = queue.shift()!;
        let title = book.title;
        try {
          await this.withBookExclusive(book.id, async () => {
            const current = this.state.books.find(item => item.id === book.id);
            if (!current || this.cacheAllActive(current.id)) { skipped++; return; }
            title = current.title;
            // 在排他锁内重新读取当前书源，避免与换源并发时使用旧源解析新网址。
            const currentSource = this.state.sources.find(item => item.id === current.sourceId);
            if (!currentSource?.enabled) { skipped++; return; }
            checked++;
            const fetched = await this.fetchToc(current.url, currentSource);
            const { staleIds, added } = await this.commitBookUpdate(current, draft => {
              const previousIds = new Set(draft.chapters.map(chapter => chapter.id));
              const addedCount = fetched.chapters.filter(chapter => !previousIds.has(chapter.id)).length;
              const stale = this.applyToc(draft, fetched);
              draft.lastCheckedAt = new Date().toISOString();
              if (addedCount > 0) draft.newChapters = (draft.newChapters ?? 0) + addedCount;
              return { staleIds: stale, added: addedCount };
            });
            for (const staleId of staleIds) {
              await rm(path.join(this.root, 'cache', current.id, staleId + '.txt'), { force: true }).catch(() => undefined);
            }
            if (added > 0) updated.push({ bookId: current.id, title: current.title, added });
          });
        } catch (error) {
          failed.push({ bookId: book.id, title, error: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
    return { checked, skipped, updated, failed, books: this.listBooks() };
  }
  async buildCachedTxt(id: string): Promise<{ title: string; author?: string; exportedChapters: number; totalChapters: number; content: string }> {
    return this.withBookShared(id, async () => {
      const book = this.book(id);
      const sections: string[] = [book.title + (book.author ? `\n作者：${book.author}` : '')];
      let exportedChapters = 0;
      for (const chapter of book.chapters) {
        if (book.cacheSizes[chapter.id] === undefined) continue;
        try {
          const raw = await readFile(this.cacheFile(book, chapter), 'utf8');
          if (!raw.trim()) continue;
          const purified = await this.purifyText(book, raw);
          sections.push(`${chapter.title}\n\n${purified}`);
          exportedChapters++;
        } catch { /* 缺失单章缓存不影响其余已缓存章节导出。 */ }
      }
      if (!exportedChapters) throw new Error('暂无已缓存章节，请先缓存章节或全本后再导出');
      return {
        title: book.title,
        author: book.author,
        exportedChapters,
        totalChapters: book.chapters.length,
        content: sections.join('\n\n\n') + '\n',
      };
    });
  }
  async chapter(id: string, number: number, refresh = false): Promise<OnlineChapterContent> {
    return this.withBookShared(id, () => this.withChapter(id, number, () => this.chapterData(id, number, refresh)));
  }
  private async chapterData(id: string, number: number, refresh: boolean): Promise<OnlineChapterContent> {
    const book = this.book(id);
    if (!Number.isSafeInteger(number) || number < 0 || number >= book.chapters.length) throw new Error('章节不存在');
    const chapter = book.chapters[number];
    const key = `${id}/${chapter.id}`;
    if (!refresh) {
      try {
        const text = await readFile(this.cacheFile(book, chapter), 'utf8');
        if (!text.trim()) throw Object.assign(new Error('缓存文件为空'), { code: 'VSREAD_EMPTY_CACHE' });
        const bytes = Buffer.byteLength(text, 'utf8');
        if (book.cacheSizes[chapter.id] !== bytes) {
          // 上次中断可能已写好正文但未提交索引；复用文件并补齐元数据，避免重复下载。
          const repair = this.cacheWrites.then(() => this.persistCacheSize(book, chapter.id, bytes));
          this.cacheWrites = repair.catch(() => undefined);
          await repair;
        }
        return { chapter: clone(chapter), text: await this.purifyText(book, text), cached: true };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'VSREAD_EMPTY_CACHE') throw error;
        if (code === 'VSREAD_EMPTY_CACHE') await rm(this.cacheFile(book, chapter), { force: true });
        if (book.cacheSizes[chapter.id] !== undefined) {
          await this.commitBookUpdate(book, draft => { delete draft.cacheSizes[chapter.id]; this.syncCached(draft); });
        }
      }
    }
    const active = this.activeChapters.get(key);
    if (active) return active;
    const operation = this.fetchChapter(book, chapter).finally(() => this.activeChapters.delete(key));
    this.activeChapters.set(key, operation);
    return operation;
  }
  private purifyText(book: StoredBook, raw: string): Promise<string> {
    const rules = this.state.replaceRules;
    if (!rules?.length) return Promise.resolve(raw);
    const sourceName = this.state.sources.find(source => source.id === book.sourceId)?.name ?? '';
    return applyReplaceRules(raw, rules, { title: book.title, sourceName }, {
      onTimeout: rule => this.log?.('warn', 'online.replace_rule_timeout', { ruleId: rule.id, ruleName: rule.name }),
    });
  }
  async saveProgress(id: string, chapter: number, scroll: number): Promise<void> {
    const book = this.book(id);
    if (!Number.isSafeInteger(chapter) || !book.chapters[chapter] || typeof scroll !== 'number' || !Number.isFinite(scroll)) throw new Error('在线阅读位置无效');
    const clampedScroll = boundedNumber(scroll, 0, 1, 0);
    await this.commitBookUpdate(book, draft => {
      if (!draft.chapters[chapter]) throw new Error('在线阅读位置无效');
      draft.progress = { chapter, scroll: clampedScroll, updatedAt: new Date().toISOString() };
    });
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
  /** 后台缓存复用逐章落盘流程，页面关闭不取消；重启后再次开始会跳过有效缓存。 */
  async startCacheAll(id: string): Promise<CacheAllJob> {
    const book = this.book(id);
    if (this.cacheMaintenance.has(id)) throw new Error('正在清理或移除这本书，请稍后重试');
    if (this.cacheAllActive(id)) return this.cacheAllStatus(id);
    if (!book.chapters.length) throw new Error('目录为空，请先刷新目录');
    const task: CacheAllTask = { state: 'running', cancelRequested: false, failedIds: new Set(), done: Promise.resolve() };
    this.cacheAllTasks.set(id, task);
    this.log?.('info', 'online.cache_all_start', { bookId: id, total: book.chapters.length, cached: book.cachedChapters.length });
    task.done = this.runCacheAll(id, task);
    return this.cacheAllStatus(id);
  }
  cacheAllStatus(id: string): CacheAllJob {
    const book = this.book(id);
    const task = this.cacheAllTasks.get(id);
    const chapterIds = new Set(book.chapters.map(chapter => chapter.id));
    const failed = task ? [...task.failedIds].filter(chapterId => book.cacheSizes[chapterId] === undefined && chapterIds.has(chapterId)).length : 0;
    return { bookId: id, state: task?.state ?? 'idle', total: book.chapters.length, completed: book.cachedChapters.length, failed, currentChapter: task?.currentChapter, error: task?.error, cachedChapters: [...book.cachedChapters] };
  }
  cancelCacheAll(id: string): CacheAllJob {
    this.book(id);
    const task = this.cacheAllTasks.get(id);
    if (task && this.cacheAllActive(id)) { task.cancelRequested = true; task.state = 'cancelling'; task.wake?.(); }
    return this.cacheAllStatus(id);
  }
  /** IDE 退出只请求停止后续下载，不等待当前网络请求结束。 */
  cancelAllCacheJobs(): void {
    for (const task of this.cacheAllTasks.values()) {
      if (task.state !== 'running' && task.state !== 'cancelling') continue;
      task.cancelRequested = true; task.state = 'cancelling'; task.wake?.();
    }
  }
  private cacheAllActive(id: string): boolean { const state = this.cacheAllTasks.get(id)?.state; return state === 'running' || state === 'cancelling'; }
  private async runCacheAll(id: string, task: CacheAllTask): Promise<void> {
    const book = this.book(id);
    let consecutiveFailures = 0;
    try {
      for (let index = 0; index < book.chapters.length && !task.cancelRequested; index++) {
        const chapter = book.chapters[index];
        task.currentChapter = index;
        try {
          const downloaded = await this.cacheAllChapter(id, index, task);
          task.failedIds.delete(chapter.id); consecutiveFailures = 0;
          if (!downloaded) continue;
        } catch (error) {
          task.failedIds.add(chapter.id); consecutiveFailures++;
          const code = diagnosticError(error).errorCode;
          const source = this.state.sources.find(source => source.id === book.sourceId);
          const fatalCodes = ['VSREAD_CACHE_LIMIT', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOSPC', 'EACCES', 'EPERM', 'EISDIR', 'EROFS', 'HTTP_401', 'HTTP_403', 'HTTP_429'];
          if (!source?.enabled || (code && fatalCodes.includes(code)) || consecutiveFailures >= 3) throw error;
        }
        if (!task.cancelRequested && index < book.chapters.length - 1 && this.cacheAllDelayMs) await this.cacheAllPause(task);
      }
      task.state = task.cancelRequested ? 'cancelled' : 'completed';
      const failed = this.cacheAllStatus(id).failed;
      if (failed) task.error = `仍有 ${failed} 章未缓存，可点击继续缓存重试`;
    } catch (error) {
      task.state = task.cancelRequested ? 'cancelled' : 'failed';
      task.error = error instanceof Error ? error.message : String(error);
    } finally {
      task.currentChapter = undefined; task.wake = undefined;
      this.log?.(task.state === 'failed' ? 'warn' : 'info', 'online.cache_all_end', { bookId: id, state: task.state, cached: book.cachedChapters.length, failed: task.failedIds.size });
    }
  }
  private cacheAllChapter(id: string, index: number, task: CacheAllTask): Promise<boolean> {
    return this.withBookShared(id, () => this.withChapter(id, index, async () => {
      if (task.cancelRequested) return false;
      const book = this.book(id), chapter = book.chapters[index];
      const expectedSize = book.cacheSizes[chapter.id];
      if (expectedSize !== undefined) {
        try {
          const file = await stat(this.cacheFile(book, chapter));
          if (file.isFile() && file.size > 0 && file.size === expectedSize) return false;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        // 校验和修复纳入章节锁，避免与用户刷新当前章交错，同时不阻塞其它已缓存章节的读取。
        await rm(this.cacheFile(book, chapter), { force: true });
        await this.commitBookUpdate(book, draft => { delete draft.cacheSizes[chapter.id]; this.syncCached(draft); });
      }
      if (task.cancelRequested) return false;
      this.source(book.sourceId, true);
      const content = await this.chapterData(id, index, false);
      return !content.cached;
    }));
  }
  private cacheAllPause(task: CacheAllTask): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { task.wake = undefined; resolve(); }, this.cacheAllDelayMs);
      task.wake = () => { clearTimeout(timer); task.wake = undefined; resolve(); };
    });
  }
  private async stopCacheAll(id: string): Promise<void> {
    const task = this.cacheAllTasks.get(id);
    if (task && this.cacheAllActive(id)) { this.cancelCacheAll(id); await task.done; }
  }
  private async withCacheMaintenance<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.book(id);
    this.cacheMaintenance.set(id, (this.cacheMaintenance.get(id) ?? 0) + 1);
    try { await this.stopCacheAll(id); return await operation(); }
    finally { const remaining = (this.cacheMaintenance.get(id) ?? 1) - 1; if (remaining) this.cacheMaintenance.set(id, remaining); else this.cacheMaintenance.delete(id); }
  }
  async clearCache(id: string): Promise<OnlineBookRecord> {
    return this.withCacheMaintenance(id, () => this.withBookExclusive(id, async () => { const book = await this.clearBookCache(id); this.cacheAllTasks.delete(id); return book; }));
  }
  private async clearBookCache(id: string): Promise<OnlineBookRecord> {
    const book = this.book(id);
    // 缓存路径仅由已验证哈希构成，源配置不能指定本地文件名。
    await rm(path.join(this.root, 'cache', book.id), { recursive: true, force: true });
    await this.commitBookUpdate(book, draft => { draft.cacheSizes = {}; this.syncCached(draft); });
    return this.publicBook(book);
  }
  async removeBook(id: string): Promise<OnlineBookRecord[]> {
    return this.withCacheMaintenance(id, () => this.withBookExclusive(id, async () => {
      const book = this.book(id);
      await this.commitState(() => {
        const books = this.state.books.filter(item => item !== book);
        return {
          nextState: { ...this.state, books },
          apply: () => { this.state.books = books; },
        };
      });
      await rm(path.join(this.root, 'cache', book.id), { recursive: true, force: true });
      this.cacheAllTasks.delete(id);
      return this.listBooks();
    }));
  }
  async flush(): Promise<void> {
    // cacheWrites 会继续排队 writes；循环等待直到所有写队列稳定。
    while (true) {
      const pending = [this.sourceOperations, this.cacheWrites, this.writes];
      await Promise.all(pending);
      if (this.sourceOperations === pending[0] && this.cacheWrites === pending[1] && this.writes === pending[2]) return;
    }
  }

  private withSources<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.sourceOperations.then(operation);
    this.sourceOperations = pending.then(() => undefined, () => undefined);
    return pending;
  }
  private async commitSources(next: BookSource[]): Promise<void> {
    if (next.length > 200) throw new Error('最多保存 200 个书源，请先移除不需要的书源');
    await this.commitState(() => ({
      nextState: { ...this.state, sources: next },
      apply: () => { this.state.sources = next; },
    }));
  }

  private request(url: string, maxBytes?: number, context: { operation: string; source: string } = { operation: 'request', source: '在线书源' }, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const origin = new URL(url).origin;
    const queued = Date.now();
    // 同站点保持串行，避免触发频率限制；一个站点超时不再阻塞其它书源。
    const operation = (this.network.get(origin) ?? Promise.resolve()).then(async () => {
      signal?.throwIfAborted();
      const started = Date.now();
      this.log?.('info', 'online.request', { ...context, url: diagnosticUrl(url), queuedMs: started - queued });
      try {
        return await this.fetchText(url, { maxBytes, signal, onTrace: event => this.log?.(event.stage === 'error' ? 'error' : 'info', 'network.' + event.stage, { ...context, ...event }) });
      } catch (error) {
        if (signal?.aborted) {
          this.log?.('info', 'online.request_cancelled', { ...context, url: diagnosticUrl(url), elapsedMs: Date.now() - started });
          signal.throwIfAborted();
        }
        this.log?.('error', 'online.request_failed', { ...context, url: diagnosticUrl(url), elapsedMs: Date.now() - started, ...diagnosticError(error) });
        const labels: Record<string, string> = { search: '搜索', 'book-info': '书籍信息', toc: '目录', chapter: '章节正文', import: '书源导入' };
        throw new Error(`「${context.source}」${labels[context.operation] ?? '请求'}失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.network.set(origin, tail);
    void tail.then(() => { if (this.network.get(origin) === tail) this.network.delete(origin); });
    if (!signal) return operation;
    // 取消等待立即通知调用方，同域队列仍等待原请求收尾，避免取消破坏串行顺序。
    return new Promise<TextResponse>((resolve, reject) => {
      const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason ?? new Error('搜索已取消')); };
      signal.addEventListener('abort', aborted, { once: true });
      operation.then(value => { signal.removeEventListener('abort', aborted); resolve(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
      if (signal.aborted) aborted();
    });
  }
  private bookLock(id: string): BookLockState {
    let lock = this.bookLocks.get(id);
    if (!lock) { lock = { activeReaders: 0, writerActive: false, waitingReaders: [], waitingWriters: [] }; this.bookLocks.set(id, lock); }
    return lock;
  }
  private drainBookLock(id: string): void {
    const lock = this.bookLocks.get(id);
    if (!lock || lock.writerActive) return;
    if (lock.waitingWriters.length) {
      if (lock.activeReaders === 0) { lock.writerActive = true; lock.waitingWriters.shift()!(); }
      return;
    }
    while (lock.waitingReaders.length) { lock.activeReaders++; lock.waitingReaders.shift()!(); }
    if (lock.activeReaders === 0 && !lock.writerActive) this.bookLocks.delete(id);
  }
  private async withBookShared<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const lock = this.bookLock(id);
    if (lock.writerActive || lock.waitingWriters.length) await new Promise<void>(resolve => lock.waitingReaders.push(resolve));
    else lock.activeReaders++;
    try { return await operation(); }
    finally { lock.activeReaders--; this.drainBookLock(id); }
  }
  private async withBookExclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const lock = this.bookLock(id);
    if (lock.writerActive || lock.activeReaders > 0) await new Promise<void>(resolve => lock.waitingWriters.push(resolve));
    else lock.writerActive = true;
    try { return await operation(); }
    finally { lock.writerActive = false; this.drainBookLock(id); }
  }
  private withChapter<T>(id: string, chapterIndex: number, operation: () => Promise<T>): Promise<T> {
    const key = `${id}#${chapterIndex}`;
    const pending = (this.chapterOperations.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.chapterOperations.set(key, pending);
    void pending.finally(() => { if (this.chapterOperations.get(key) === pending) this.chapterOperations.delete(key); }).catch(() => undefined);
    return pending;
  }
  private parsePage(source: BookSource, response: TextResponse, operation: string) {
    try { return sourceDocument(source, response.text); }
    catch (error) {
      this.log?.('error', 'online.parse_failed', { source: source.name, operation, url: diagnosticUrl(response.url), ...diagnosticError(error) });
      throw new Error(`「${source.name}」解析失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
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
  private async fetchToc(bookUrl: string, source: BookSource): Promise<{ chapters: OnlineChapter[]; title?: string; author?: string }> {
    const response = await this.request(resolveSourceUrl(source, bookUrl), undefined, { operation: 'book-info', source: source.name });
    let document = this.parsePage(source, response, 'book-info');
    const info = document.scope(source.bookInfo?.init);
    const title = info.read(source.bookInfo?.name);
    const author = info.read(source.bookInfo?.author);
    const tocHref = info.read(source.bookInfo?.tocUrl, 'url');
    let base = response.url;
    if (tocHref) {
      const target = resolveSourceUrl(source, tocHref, base);
      if (target !== base) { const tocPage = await this.request(target, undefined, { operation: 'toc', source: source.name }); document = this.parsePage(source, tocPage, 'toc'); base = tocPage.url; }
    }
    const chapters: OnlineChapter[] = [];
    const seen = new Set<string>();
    for (const item of document.rows(source.toc.chapterList)) {
      const title = item.read(source.toc.chapterName).slice(0, 300);
      const href = item.read(source.toc.chapterUrl, 'url');
      if (!title || !href) continue;
      try {
        const url = resolveSourceUrl(source, href, base);
        if (seen.has(url)) continue;
        seen.add(url);
        chapters.push({ id: stableId(url), title, url });
      } catch { /* 外部导航不属于当前书源目录。 */ }
    }
    if (!chapters.length) {
      this.log?.('warn', 'online.empty_toc', { source: source.name, operation: 'toc', url: diagnosticUrl(base) });
      throw new Error(`「${source.name}」没有解析到章节，请检查目录规则或站点是否需要登录/脚本`);
    }
    return { chapters, title: title || undefined, author: author || undefined };
  }
  private applyToc(book: StoredBook, fetched: { chapters: OnlineChapter[]; title?: string; author?: string }): string[] {
    const oldChapter = book.progress && book.chapters[book.progress.chapter]?.id;
    if (oldChapter && book.progress) {
      const index = fetched.chapters.findIndex(chapter => chapter.id === oldChapter);
      book.progress = index >= 0 ? { ...book.progress, chapter: index } : undefined;
    }
    book.chapters = fetched.chapters;
    const validIds = new Set(fetched.chapters.map(chapter => chapter.id));
    const staleIds = Object.keys(book.cacheSizes).filter(chapterId => !validIds.has(chapterId));
    for (const staleId of staleIds) delete book.cacheSizes[staleId];
    if (fetched.title) book.title = fetched.title.slice(0, 300);
    if (fetched.author) book.author = fetched.author.slice(0, 300);
    this.syncCached(book);
    return staleIds;
  }
  private async fetchChapter(book: StoredBook, chapter: OnlineChapter): Promise<OnlineChapterContent> {
    const source = this.source(book.sourceId, true);
    const response = await this.request(resolveSourceUrl(source, chapter.url), undefined, { operation: 'chapter', source: source.name });
    const text = this.parsePage(source, response, 'chapter').read(source.content.content, 'content');
    if (!text) {
      this.log?.('warn', 'online.empty_content', { source: source.name, operation: 'chapter', url: diagnosticUrl(response.url) });
      throw new Error(`「${source.name}」正文为空，请检查正文规则或该章节是否需要登录/脚本`);
    }
    // 不同书籍也共享缓存预算；把检查和提交串行化，避免并发下载同时越过体积上限。
    const operation = this.cacheWrites.then(async () => {
    const bytes = Buffer.byteLength(text, 'utf8');
    const oldSize = book.cacheSizes[chapter.id] ?? 0;
    const bookSize = Object.values(book.cacheSizes).reduce((sum, value) => sum + value, 0) - oldSize + bytes;
    const total = this.state.books.reduce((sum, item) => sum + Object.values(item.cacheSizes).reduce((a, b) => a + b, 0), 0) - oldSize + bytes;
    if (bookSize > 100 * 1024 * 1024 || total > MAX_CACHE_BYTES) throw Object.assign(new Error('离线缓存已达到体积上限，请先清理不需要的缓存后继续'), { code: 'VSREAD_CACHE_LIMIT' });
    const filename = this.cacheFile(book, chapter);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename + '.tmp', text, 'utf8');
    await rename(filename + '.tmp', filename);
    await this.persistCacheSize(book, chapter.id, bytes);
    });
    this.cacheWrites = operation.catch(() => undefined);
    await operation;
    return { chapter: clone(chapter), text: await this.purifyText(book, text), cached: false };
  }
  private persistCacheSize(book: StoredBook, chapterId: string, bytes: number): Promise<void> {
    return this.commitBookUpdate(book, draft => {
      draft.cacheSizes[chapterId] = bytes;
      this.syncCached(draft);
    });
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
    book.pinned = value.pinned === true ? true : undefined;
    book.newChapters = typeof value.newChapters === 'number' && Number.isSafeInteger(value.newChapters) && value.newChapters > 0 ? value.newChapters : undefined;
    book.lastCheckedAt = typeof value.lastCheckedAt === 'string' ? value.lastCheckedAt : undefined;
    if (book.progress && (!Number.isSafeInteger(book.progress.chapter) || !book.chapters[book.progress.chapter] || !Number.isFinite(book.progress.scroll))) book.progress = undefined;
    this.syncCached(book);
    return book;
  }
  private cloneBookDraft(book: StoredBook): StoredBook {
    return {
      ...book,
      progress: book.progress ? { ...book.progress } : undefined,
      cachedChapters: [...book.cachedChapters],
      cacheSizes: { ...book.cacheSizes },
    };
  }
  private commitBookUpdate<T = void>(book: StoredBook, update: (draft: StoredBook) => T): Promise<T> {
    return this.commitState(() => {
      const index = this.state.books.indexOf(book);
      if (index < 0) throw new Error('在线书籍不存在');
      const draft = this.cloneBookDraft(book);
      const result = update(draft);
      const books = [...this.state.books];
      books[index] = draft;
      return {
        nextState: { ...this.state, books },
        apply: () => { Object.assign(book, draft); return result; },
      };
    });
  }
  private commitState<T>(prepare: () => { nextState: State; apply: () => T }): Promise<T> {
    // 所有共享状态变更与全库落盘统一串行：先基于已提交状态构造快照并写盘，成功后再更新内存，
    // 防止并发保存捕获其它操作未提交（或即将失败回滚）的临时状态。
    const operation = this.writes.then(async () => {
      const { nextState, apply } = prepare();
      const snapshot = JSON.stringify(nextState);
      if (Buffer.byteLength(snapshot, 'utf8') > 20 * 1024 * 1024) throw new Error('在线书库索引过大，请移除不需要的书籍');
      await this.writeSnapshot(snapshot);
      return apply();
    });
    this.writes = operation.then(() => undefined, () => undefined);
    return operation;
  }
  private async writeSnapshot(snapshot: string): Promise<void> {
    const filename = path.join(this.root, 'online.json');
    await writeFile(filename + '.tmp', snapshot, 'utf8');
    try { await copyFile(filename, path.join(this.root, 'online.backup.json')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(filename + '.tmp', filename);
  }
}
