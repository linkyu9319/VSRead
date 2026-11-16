import path from 'node:path';
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';

export type DiagnosticLevel = 'info' | 'warn' | 'error';
export type DiagnosticSink = (level: DiagnosticLevel, event: string, details?: Record<string, unknown>) => void;

/** 日志只保留定位网络问题所需的网址路径，去掉查询、片段和 URL 凭据。 */
export function diagnosticUrl(value: string): string {
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 500); }
  catch { return '[invalid-url]'; }
}

function clean(value: unknown, key = '', depth = 0, hidePath = false): unknown {
  if (/token|password|authorization|cookie|secret|query|keyword|body|content|base64/i.test(key)) return '[redacted]';
  if (typeof value === 'string') return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, url => hidePath ? diagnosticUrl(url).replace(/^(https?:\/\/[^/]+).*$/, '$1/[redacted-path]') : diagnosticUrl(url))
    .replace(/(["'](?:authorization|proxy-authorization|cookie|set-cookie|token|password|secret)["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, '$1"[redacted]"')
    .replace(/\b(authorization|proxy-authorization)\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:Bearer|Basic)\s+[^\s,;]+|[^\r\n,;]+)/gi, '$1=[redacted]')
    .replace(/\b(cookie|set-cookie)\s*[=:]\s*[^\r\n]+/gi, '$1=[redacted]')
    .replace(/\b(token|password|secret)\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n,;]+)/gi, '$1=[redacted]')
    .replace(/data:[^\s]+/gi, '[data]').slice(0, 700);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (depth >= 3) return '[omitted]';
  if (Array.isArray(value)) return value.slice(0, 12).map(item => clean(item, key, depth + 1, hidePath));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 25).map(([name, item]) => [name, clean(item, name, depth + 1, hidePath)]));
  return undefined;
}

export function diagnosticError(error: unknown): { error: string; errorCode?: string } {
  const item = error as { message?: unknown; code?: unknown; cause?: { code?: unknown }; errors?: { code?: unknown }[] } | null;
  const code = item?.code ?? item?.cause?.code ?? item?.errors?.[0]?.code;
  return { error: String(item?.message || error || '未知错误'), errorCode: typeof code === 'string' ? code : undefined };
}

/** 有界本地 JSONL 日志；写盘失败不能阻断阅读，最多保留当前文件和两份轮转文件。 */
export class DiagnosticLog {
  readonly filePath: string;
  private pending = Promise.resolve();
  private bytes?: number;
  private reportedFailure = false;
  constructor(readonly directory: string, private options: { maxBytes?: number; output?(line: string): void } = {}) { this.filePath = path.join(directory, 'vsread.log'); }
  readonly write: DiagnosticSink = (level, event, details = {}) => {
    const hidePath = details.operation === 'search' || details.operation === 'import' || details.method === 'online.search' || details.method === 'sources.import';
    let line = JSON.stringify({ time: new Date().toISOString(), level, event, ...clean(details, '', 0, hidePath) as object }) + '\n';
    if (Buffer.byteLength(line) > 16 * 1024) line = JSON.stringify({ time: new Date().toISOString(), level, event, details: '[oversized entry omitted]' }) + '\n';
    try { this.options.output?.(line.trimEnd()); } catch { /* 输出面板不可用时仍写本地文件。 */ }
    const operation = this.pending.then(async () => {
      await mkdir(this.directory, { recursive: true });
      if (this.bytes === undefined) {
        try { this.bytes = (await stat(this.filePath)).size; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.bytes = 0; }
      }
      const length = Buffer.byteLength(line);
      if (this.bytes && this.bytes + length > (this.options.maxBytes ?? 512 * 1024)) {
        await rm(this.filePath + '.2', { force: true });
        for (const [from, to] of [[this.filePath + '.1', this.filePath + '.2'], [this.filePath, this.filePath + '.1']]) {
          try { await rename(from, to); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        this.bytes = 0;
      }
      await appendFile(this.filePath, line, 'utf8');
      this.bytes += length;
    });
    this.pending = operation.catch(error => {
      this.bytes = undefined;
      if (!this.reportedFailure) {
        this.reportedFailure = true;
        try { this.options.output?.(`[VSRead] 无法写入本地诊断日志：${(error as NodeJS.ErrnoException).code ?? 'IO_ERROR'}`); } catch { /* 日志故障不影响阅读。 */ }
      }
    });
  };
  flush(): Promise<void> { return this.pending; }
}
