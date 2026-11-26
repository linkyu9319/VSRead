import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { BinaryChunk, BookFormat, BookRecord, TextEncoding, TextIndex, TextChunk, TextSearchHit } from '../shared/model';
import { LibraryStore } from './store';

const ENCODINGS = new Set(['auto', 'utf-8', 'gb18030', 'utf-16le', 'utf-16be']);

export class BookLibrary {
  private textIndexCache = new Map<string, TextIndex>();
  constructor(readonly store: LibraryStore, private readonly workerPath: string) {}

  book(id: unknown): BookRecord {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw new Error('书籍标识无效');
    const book = this.store.data.books.find(item => item.id === id);
    if (!book) throw new Error('这本书已不在书架中');
    return book;
  }
  directory(book: BookRecord): string { return path.join(this.store.root, 'books', book.id); }
  source(book: BookRecord): string { return path.join(this.directory(book), `book.${book.format}`); }
  private textDirectory(book: BookRecord): string {
    if (!book.encoding || !ENCODINGS.has(book.encoding)) throw new Error('TXT 编码索引无效，请重新导入');
    return path.join(this.directory(book), `text-${book.encoding}`);
  }

  async importFile(source: string): Promise<BookRecord> {
    const format = path.extname(source).slice(1).toLowerCase() as BookFormat;
    if (!['txt', 'epub', 'pdf'].includes(format)) throw new Error('仅支持 TXT、EPUB 和 PDF');
    const info = await stat(source);
    if (!info.isFile() || info.size === 0) throw new Error('请选择非空电子书文件');
    const limit = format === 'txt' ? 100 : 256;
    if (info.size > limit * 1024 * 1024) throw new Error(`${format.toUpperCase()} 文件目前限制为 ${limit} MB`);
    const hash = createHash('sha256').update(format);
    for await (const chunk of createReadStream(source)) hash.update(chunk);
    const id = hash.digest('hex');
    const existing = this.store.data.books.find(book => book.id === id);
    if (existing) return existing;
    const book: BookRecord = { id, format, title: path.basename(source, path.extname(source)), importedAt: new Date().toISOString(), size: info.size };
    const directory = this.directory(book);
    await mkdir(directory, { recursive: true });
    try {
      await copyFile(source, this.source(book));
      if (format === 'txt') await this.prepareText(book, 'auto');
      this.store.data.books.push(book);
      try { await this.store.save(); }
      catch (error) { this.store.data.books = this.store.data.books.filter(item => item.id !== id); throw error; }
      return book;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async prepareText(book: BookRecord, encoding: TextEncoding): Promise<TextIndex> {
    if (!ENCODINGS.has(encoding)) throw new Error('不支持的文字编码');
    const staging = path.join(this.directory(book), `prepare-${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    try {
      const index = await new Promise<TextIndex>((resolve, reject) => {
        const worker = new Worker(this.workerPath, { workerData: { source: this.source(book), directory: staging, encoding } });
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', code => { if (code !== 0) reject(new Error(`TXT 解析进程退出（${code}）`)); });
      });
      const destination = path.join(this.directory(book), `text-${index.encoding}`);
      try { await rename(staging, destination); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        // 同一编码的索引不可变，重新选择编码时可直接复用已完成的目录。
        await stat(path.join(destination, 'index.json'));
      }
      book.encoding = index.encoding;
      this.evictTextIndex(book.id);
      this.cacheTextIndex(`${book.id}:${index.encoding}`, index);
      return index;
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  evictTextIndex(bookId: string): void {
    const prefix = `${bookId}:`;
    for (const key of this.textIndexCache.keys()) if (key.startsWith(prefix)) this.textIndexCache.delete(key);
  }
  private cacheTextIndex(key: string, index: TextIndex): void {
    this.textIndexCache.delete(key);
    this.textIndexCache.set(key, index);
    if (this.textIndexCache.size > 32) this.textIndexCache.delete(this.textIndexCache.keys().next().value!);
  }
  async textIndex(book: BookRecord): Promise<TextIndex> {
    const dir = this.textDirectory(book);
    const key = `${book.id}:${book.encoding}`;
    const cached = this.textIndexCache.get(key);
    if (cached) return cached;
    const parsed = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8')) as TextIndex;
    this.cacheTextIndex(key, parsed);
    return parsed;
  }
  async text(book: BookRecord, partNumber: unknown): Promise<TextChunk> {
    if (book.format !== 'txt' || typeof partNumber !== 'number' || !Number.isSafeInteger(partNumber)) throw new Error('正文请求无效');
    const index = await this.textIndex(book);
    const part = index.parts[partNumber];
    if (!part) throw new Error('章节不存在');
    return { part, text: await readFile(path.join(this.textDirectory(book), `${part.index}.txt`), 'utf8') };
  }
  async searchText(book: BookRecord, query: unknown): Promise<TextSearchHit[]> {
    if (book.format !== 'txt') throw new Error('仅 TXT 书籍支持宿主全文搜索');
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('搜索内容需要 1–200 个字符');
    const trimmed = query.trim();
    const needle = trimmed.toLocaleLowerCase();
    const index = await this.textIndex(book);
    const dir = this.textDirectory(book);
    const hits: TextSearchHit[] = [];
    for (const part of index.parts) {
      if (hits.length >= 100) break;
      const content = await readFile(path.join(dir, `${part.index}.txt`), 'utf8');
      const lower = content.toLocaleLowerCase();
      let from = 0;
      while (hits.length < 100) {
        const at = lower.indexOf(needle, from);
        if (at < 0) break;
        const snippet = content.slice(Math.max(0, at - 18), at + trimmed.length + 42).replace(/\s+/g, ' ').trim();
        hits.push({ part: part.index, offset: part.start + at, title: part.title, snippet });
        from = at + Math.max(1, needle.length);
      }
    }
    return hits;
  }

  /** 只读已导入的文件副本；固定大小分块，避免大文件以一条 Webview 消息传输。 */
  async binary(book: BookRecord, offset: unknown): Promise<BinaryChunk> {
    if (book.format === 'txt' || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('电子书数据请求无效');
    const file = await open(this.source(book), 'r');
    try {
      const { size } = await file.stat();
      if (size < 1 || size > 256 * 1024 * 1024 || offset >= size) throw new Error('电子书数据范围无效');
      const buffer = Buffer.alloc(Math.min(512 * 1024, size - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) throw new Error('电子书文件读取中断，请重新导入');
      return { base64: buffer.subarray(0, bytesRead).toString('base64'), total: size };
    } finally { await file.close(); }
  }
}
