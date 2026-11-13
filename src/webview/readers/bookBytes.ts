import type { OpenBook } from '../../shared/model';
import { request } from '../bridge';

export const BOOK_CHUNK_SIZE = 512 * 1024;

/** 分块同时返回宿主实际文件大小，避免依赖旧元数据或前端估算。 */
export async function readBookChunk(source: OpenBook, offset: number, signal: AbortSignal): Promise<{ data: Uint8Array; total: number }> {
  signal.throwIfAborted();
  const chunk = await request('binary', { id: source.book.id, offset });
  signal.throwIfAborted();
  if (!Number.isSafeInteger(chunk.total) || chunk.total < 1 || chunk.total > 256 * 1024 * 1024) throw new Error('电子书大小无效');
  const bytes = atob(chunk.base64);
  if (!bytes.length || bytes.length > BOOK_CHUNK_SIZE || offset + bytes.length > chunk.total) throw new Error('电子书分块数据无效');
  return { data: Uint8Array.from(bytes, byte => byte.charCodeAt(0)), total: chunk.total };
}

/** PDF 按需读取一个区间；不拉取与首屏无关的其余书籍内容。 */
export async function readBookRange(source: OpenBook, begin: number, end: number, total: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end > total) throw new Error('电子书读取区间无效');
  const data = new Uint8Array(end - begin);
  let offset = begin;
  while (offset < end) {
    const chunk = await readBookChunk(source, offset, signal);
    if (chunk.total !== total) throw new Error('电子书在读取期间发生变化，请重新导入');
    const bytes = chunk.data.subarray(0, end - offset);
    data.set(bytes, offset - begin);
    offset += bytes.length;
  }
  return data;
}

/** Webview 不直接访问本地书籍路径；宿主负责授权，适配器只接收字节。 */
export async function readBookBytes(source: OpenBook, signal: AbortSignal): Promise<Uint8Array> {
  let data: Uint8Array | undefined;
  let offset = 0;
  do {
    const chunk = await readBookChunk(source, offset, signal);
    if (!data) data = new Uint8Array(chunk.total);
    else if (chunk.total !== data.length) throw new Error('电子书在读取期间发生变化，请重新导入');
    data.set(chunk.data, offset);
    offset += chunk.data.length;
  } while (offset < data.length);
  return data;
}
