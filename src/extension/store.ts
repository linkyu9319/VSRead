import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SETTINGS, type Library } from '../shared/model';
import { isRecord, normalizeSettings } from '../shared/validation';

export class LibraryStore {
  private queue: Promise<void> = Promise.resolve();
  data: Library = { version: 1, books: [], settings: { ...DEFAULT_SETTINGS } };
  constructor(readonly root: string) {}

  async load(): Promise<void> {
    await mkdir(path.join(this.root, 'books'), { recursive: true });
    let damaged = false;
    for (const filename of ['library.json', 'library.backup.json']) {
      try {
        const data: unknown = JSON.parse(await readFile(path.join(this.root, filename), 'utf8'));
        if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.books)) throw new Error('书库索引格式无效');
        if (!data.books.every(book => isRecord(book) && typeof book.id === 'string' && /^[a-f0-9]{64}$/.test(book.id) && ['txt', 'epub', 'pdf'].includes(String(book.format)) && typeof book.title === 'string')) throw new Error('书库记录无效');
        this.data = { ...(data as unknown as Library), settings: normalizeSettings(data.settings) };
        // 从备份恢复后，先修复主文件，后续写入不会把损坏的主文件当成备份。
        if (filename.includes('backup')) await writeFile(path.join(this.root, 'library.json'), JSON.stringify(this.data), 'utf8');
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') damaged = true;
      }
    }
    if (damaged) throw new Error('书库及备份无法读取，请先备份 VSRead 数据目录。');
  }

  /** 写入队列保留每次快照；临时文件原子替换，避免并发消息覆盖或截断索引。 */
  save(): Promise<void> {
    const snapshot = JSON.stringify(this.data);
    const operation = this.queue.then(async () => {
      const file = path.join(this.root, 'library.json');
      const temp = file + '.tmp';
      await writeFile(temp, snapshot, 'utf8');
      try { await copyFile(file, path.join(this.root, 'library.backup.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(temp, file);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  flush(): Promise<void> { return this.queue; }
}
