import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibraryStore } from '../src/extension/store';
import { BookLibrary } from '../src/extension/library';
import { normalizeSettings, validateProgress } from '../src/shared/validation';
import { ProgressWriter } from '../src/webview/progressWriter';

test('并发保存与进程重启后恢复最后位置', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vsread-store-'));
  try {
    const store = new LibraryStore(directory);
    await store.load();
    const saves: Promise<void>[] = [];
    for (let i = 1; i <= 20; i++) { store.data.settings.fontSize = i + 12; saves.push(store.save()); }
    await Promise.all(saves);
    const restored = new LibraryStore(directory);
    await restored.load();
    assert.equal(restored.data.settings.fontSize, 32);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'library.backup.json'), 'utf8')).settings.fontSize, 31);
    await writeFile(path.join(directory, 'library.json'), '{broken');
    await restored.load();
    assert.equal(restored.data.settings.fontSize, 31);
    await restored.save();
    await writeFile(path.join(directory, 'library.json'), '{broken');
    await restored.load();
    assert.equal(restored.data.settings.fontSize, 31);
    await writeFile(path.join(directory, 'library.backup.json'), '{broken');
    await writeFile(path.join(directory, 'library.json'), '{broken');
    await assert.rejects(restored.load(), /书库及备份无法读取/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('原文件导入副本、去重、分块读取和跨实例恢复', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vsread-import-'));
  try {
    const filename = path.join(directory, '示例.txt');
    await writeFile(filename, '第一章 星海\n' + '这是正文。'.repeat(5000) + '\n第二章 远航\n再见。');
    const store = new LibraryStore(path.join(directory, 'library'));
    await store.load();
    const library = new BookLibrary(store, path.resolve('dist/txtWorker.cjs'));
    const book = await library.importFile(filename);
    assert.equal((await library.importFile(filename)).id, book.id);
    assert.equal(store.data.books.length, 1);
    const chunk = await library.text(book, 1);
    assert(chunk.text.length <= 12_000);
    assert(chunk.part.start > 0);
    book.progress = validateProgress({ position: { format: 'txt', offset: chunk.part.start + 25 }, percentage: .5 }, 'txt');
    store.data.lastBookId = book.id;
    await store.save();
    await rm(filename);
    const restored = new LibraryStore(store.root);
    await restored.load();
    const reopened = new BookLibrary(restored, path.resolve('dist/txtWorker.cjs'));
    assert.equal(restored.data.lastBookId, book.id);
    assert.deepEqual(restored.data.books[0].progress, book.progress);
    assert.equal((await reopened.text(restored.data.books[0], 1)).text, chunk.text);
    assert.throws(() => library.book('../library.json'), /标识无效/);
    await assert.rejects(library.text(book, -1), /章节不存在/);
    await library.prepareText(book, 'utf-8');
    assert.equal((await library.textIndex(book)).encoding, 'utf-8');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('来自 Webview 的位置与设置有明确边界', () => {
  assert.throws(() => validateProgress({ position: { format: 'txt', offset: -1 } }, 'txt'));
  assert.throws(() => validateProgress({ position: { format: 'pdf', page: 1 } }, 'txt'));
  assert.throws(() => validateProgress({ position: { format: 'pdf', page: Infinity } }, 'pdf'));
  assert.throws(() => validateProgress({ position: { format: 'epub', cfi: 'javascript:alert(1)' } }, 'epub'));
  assert.equal(normalizeSettings({ fontSize: 900, lineHeight: NaN, zoom: -4 }).fontSize, 40);
  assert.equal(normalizeSettings({ zoom: -4 }).zoom, .5);
});
test('二进制书籍分块由宿主读取，并拒绝越界和错误格式', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vsread-binary-'));
  try {
    const bytes = Buffer.alloc(512 * 1024 + 391, 0x7a);
    const filename = path.join(directory, 'sample.pdf');
    await writeFile(filename, bytes);
    const store = new LibraryStore(path.join(directory, 'library'));
    await store.load();
    const library = new BookLibrary(store, path.resolve('dist/txtWorker.cjs'));
    const book = await library.importFile(filename);
    const first = await library.binary(book, 0);
    const second = await library.binary(book, 512 * 1024);
    assert.equal(first.total, bytes.length);
    assert.equal(Buffer.from(first.base64, 'base64').length, 512 * 1024);
    assert.deepEqual(Buffer.concat([Buffer.from(first.base64, 'base64'), Buffer.from(second.base64, 'base64')]), bytes);
    await assert.rejects(library.binary(book, -1), /请求无效/);
    await assert.rejects(library.binary(book, .1), /请求无效/);
    await assert.rejects(library.binary(book, bytes.length), /范围无效/);
    await assert.rejects(library.binary({ ...book, format: 'txt' }, 0), /请求无效/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('滚动位置合并发送，保存失败后保留最新位置供重试', async () => {
  const sent: number[] = [];
  let fail = true;
  const writer = new ProgressWriter(async (_id, value) => { if (fail) throw new Error('磁盘满'); sent.push((value.position as { offset: number }).offset); }, () => {});
  const progress = (offset: number) => ({ position: { format: 'txt' as const, offset }, percentage: .5, updatedAt: '' });
  writer.put('book', progress(10)); writer.put('book', progress(20));
  await writer.flush();
  fail = false;
  writer.put('book', progress(30));
  await writer.flush();
  assert.deepEqual(sent, [30]);
});
test('旧位置延迟失败时，不会在新位置保存后重新回写', async () => {
  const sent: number[] = [];
  let rejectFirst!: (reason: Error) => void;
  let started!: () => void;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const writer = new ProgressWriter(async (_id, value) => {
    const offset = (value.position as { offset: number }).offset;
    sent.push(offset);
    if (offset === 10) { started(); await new Promise<void>((_resolve, reject) => { rejectFirst = reject; }); }
  }, () => {});
  const value = (offset: number) => ({ position: { format: 'txt' as const, offset }, percentage: .5, updatedAt: '' });
  writer.put('book', value(10)); const first = writer.flush();
  await firstStarted;
  writer.put('book', value(20)); const second = writer.flush();
  rejectFirst(new Error('旧请求失败'));
  await Promise.all([first, second]);
  await writer.flush();
  assert.deepEqual(sent, [10, 20]);
});
