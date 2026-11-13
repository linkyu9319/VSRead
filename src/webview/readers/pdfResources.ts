import { getDocument, GlobalWorkerOptions, PDFDataRangeTransport, type PDFDocumentProxy, type PDFDocumentLoadingTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { OpenBook } from '../../shared/model';
import { BOOK_CHUNK_SIZE, readBookChunk, readBookRange } from './bookBytes';
import { PdfSessionCache } from './PdfSessionCache';

GlobalWorkerOptions.workerSrc = workerUrl;

export interface PdfResource { document: PDFDocumentProxy; task: PDFDocumentLoadingTask; total: number; destroy(): Promise<void> }

class HostPdfRange extends PDFDataRangeTransport {
  failure?: unknown;
  constructor(private source: OpenBook, first: { data: Uint8Array; total: number }, private signal: AbortSignal, private fail: (error: unknown) => void) {
    super(first.total, first.data, true);
  }
  override requestDataRange(begin: number, end: number): void {
    void readBookRange(this.source, begin, end, this.length, this.signal).then(data => {
      if (!this.signal.aborted) this.onDataRange(begin, data);
    }).catch(error => {
      if (!this.signal.aborted) { this.failure = error; this.fail(error); }
    });
  }
}

const cache = new PdfSessionCache<PdfResource>(resource => resource.destroy(), {
  maxEntries: 2, maxWeight: 96 * 1024 * 1024, idleMs: 60_000, weight: resource => resource.total,
});
window.addEventListener('pagehide', () => cache.clear(), { once: true });

/** 同一 Webview 内短时重开复用文档和 Worker；关闭整个 Webview 后自然释放。 */
export function acquirePdf(source: OpenBook, resources: string) {
  return cache.acquire(source.book.id, source.book.size, async signal => {
    const first = await readBookChunk(source, 0, signal);
    signal.throwIfAborted();
    let task: PDFDocumentLoadingTask | undefined;
    let destroyPromise: Promise<void> | undefined;
    // 密码失败、取消、缓存驱逐可能同时到达，所有路径复用同一次 Worker 清理。
    const destroy = (): Promise<void> => {
      if (!task) return Promise.resolve();
      return destroyPromise ??= task.destroy();
    };
    const quietlyDestroy = () => { void destroy().catch(() => undefined); };
    let rejectFailure!: (error: unknown) => void;
    const failure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
    const fail = (error: unknown) => { rejectFailure(error); cache.invalidate(source.book.id); quietlyDestroy(); };
    const range = first.data.length < first.total ? new HostPdfRange(source, first, signal, fail) : undefined;
    task = getDocument({
      ...(range ? { range, rangeChunkSize: BOOK_CHUNK_SIZE, disableAutoFetch: true, disableStream: true } : { data: first.data }),
      cMapUrl: resources + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: resources + 'standard_fonts/', wasmUrl: resources + 'wasm/', iccUrl: resources + 'iccs/',
    });
    task.onPassword = () => fail(new Error('这份 PDF 有密码保护，请先解密后再导入'));
    const abort = quietlyDestroy;
    signal.addEventListener('abort', abort, { once: true });
    try {
      const document = await Promise.race([task.promise, failure]);
      signal.throwIfAborted();
      return { document, task, total: first.total, destroy };
    } catch (error) {
      await destroy().catch(() => undefined);
      throw range?.failure ?? error;
    } finally { signal.removeEventListener('abort', abort); }
  });
}
