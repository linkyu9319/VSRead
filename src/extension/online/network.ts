import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import iconv from 'iconv-lite';
import { diagnosticError, diagnosticUrl } from '../diagnostics';
import { retryTransientRequest } from './networkRetry';

export interface NetworkTrace extends Record<string, unknown> { stage: string; url: string; elapsedMs: number }
export interface RequestTextOptions { maxBytes?: number; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; onTrace?(event: NetworkTrace): void }
export interface TextResponse { text: string; url: string }
export type TextFetcher = (url: string, options?: RequestTextOptions) => Promise<TextResponse>;

/** 固定到已验证地址，同时兼容 Node 18 单地址与 Node 22 all=true 的查询约定。 */
export function pinnedLookup(address: { address: string; family: number } | { address: string; family: number }[]): LookupFunction {
  const addresses = Array.isArray(address) ? address : [address];
  return (_hostname, options, callback) => {
    if (options.all) callback(null, addresses.map(item => ({ ...item })));
    else { const selected = addresses.find(item => item.family === options.family) ?? addresses[0]; callback(null, selected.address, selected.family); }
  };
}

function expandIpv6(address: string): number[] | undefined {
  if (address.includes('.')) return undefined;
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  if (halves.length === 2 && left.length + right.length >= 8) return undefined;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  return parts.map(part => parseInt(part, 16));
}

export function publicAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0))
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19));
  }
  if (isIP(value) === 6) {
    // 仅允许全局单播 2000::/3；显式排除文档、Teredo、ORCHID、6to4 与 IPv4 映射地址。
    const segments = expandIpv6(value);
    if (!segments) return false;
    const [first, second] = segments;
    if (first < 0x2000 || first > 0x3fff) return false;
    if (first === 0x2002) return false;
    if (first === 0x2001 && (second === 0x0db8 || second === 0x0000 || (second & 0xfff0) === 0x0010 || (second & 0xfff0) === 0x0020)) return false;
    return true;
  }
  return false;
}

export function validateHttpUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('请输入有效的 HTTP 或 HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || input.length > 8192) throw new Error('仅支持不含账号密码的 HTTP / HTTPS 地址');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) throw new Error('不允许访问本机或私有网络地址');
  if (isIP(hostname) && !publicAddress(hostname)) throw new Error('不允许访问本机或私有网络地址');
  return url;
}

/** 每次跳转重新验证 DNS 并固定连接地址，避免书源把请求重定向到本机服务。 */
export const requestText: TextFetcher = async (input, options = {}) => {
  let url = validateHttpUrl(input);
  const maxBytes = Math.min(8 * 1024 * 1024, Math.max(1024, options.maxBytes ?? 2 * 1024 * 1024));
  const controller = new AbortController();
  const started = Date.now();
  let stage = 'dns';
  const trace = (name: string, details: Record<string, unknown> = {}) => {
    try { options.onTrace?.({ stage: name, url: diagnosticUrl(url.href), elapsedMs: Date.now() - started, ...details }); } catch { /* 诊断输出失败不阻断网络请求。 */ }
  };
  const abort = () => controller.abort(options.signal?.reason ?? new Error('网络请求已取消'));
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timeoutMs = Math.min(60_000, Math.max(250, options.timeoutMs ?? 30_000));
  const timer = setTimeout(() => controller.abort(Object.assign(new Error(`网络请求超时（${url.hostname}，${stage}阶段），请稍后重试`), { code: 'ETIMEDOUT' })), timeoutMs);
  let headers = { ...options.headers };
  try {
    for (let redirect = 0; redirect <= 3; redirect++) {
      controller.signal.throwIfAborted();
      stage = 'dns'; trace(stage);
      controller.signal.throwIfAborted();
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        const aborted = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', aborted, { once: true });
        void lookup(hostname, { all: true, verbatim: true }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', aborted));
      });
      controller.signal.throwIfAborted();
      if (!addresses.length || addresses.some(address => !publicAddress(address.address))) throw new Error('书源域名指向私有网络，已停止访问');
      trace('dns.complete', { addressCount: addresses.length, addresses: addresses.slice(0, 8).map(item => item.address) });
      controller.signal.throwIfAborted();
      const send = () => {
        stage = 'connect';
        return new Promise<{ bytes?: Buffer; location?: string; charset?: string }>((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const requestOptions = {
          signal: controller.signal,
          headers: { 'User-Agent': 'VSRead/0.1', Accept: 'text/html,application/json;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'gzip, deflate, br', ...headers },
          // 所有候选 IP 均已验证；Node 在连接失败时尝试其它地址，避免只卡在首个 IPv4。
          family: 0, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 500,
          lookup: pinnedLookup(addresses),
        };
        const request = transport.get(url, requestOptions, response => {
          stage = 'response'; trace(stage, { status: response.statusCode });
          if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            const location = response.headers.location;
            response.destroy();
            if (!location) reject(new Error('网络跳转缺少目标地址'));
            else resolve({ location });
            return;
          }
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            response.destroy(); reject(Object.assign(new Error(`网络请求失败（HTTP ${response.statusCode ?? 0}）`), { code: `HTTP_${response.statusCode ?? 0}` })); return;
          }
          const encoding = response.headers['content-encoding']?.toLowerCase();
          let stream: Readable = response;
          if (encoding === 'gzip') stream = response.pipe(createGunzip());
          else if (encoding === 'deflate') stream = response.pipe(createInflate());
          else if (encoding === 'br') stream = response.pipe(createBrotliDecompress());
          else if (encoding && encoding !== 'identity') { response.destroy(); reject(new Error('不支持该响应压缩格式')); return; }
          let bytes = 0;
          stage = 'download';
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) { stream.destroy(); response.destroy(); reject(new Error('响应内容过大，已停止读取')); }
            else chunks.push(chunk);
          });
          response.on('error', reject); stream.on('error', reject);
          response.on('aborted', () => reject(Object.assign(new Error('书源提前中断响应，请重试'), { code: 'ECONNRESET' })));
          stream.on('end', () => { trace('download.complete', { bytes }); resolve({ bytes: Buffer.concat(chunks), charset: /charset\s*=\s*["']?([^;\s"']+)/i.exec(response.headers['content-type'] ?? '')?.[1] }); });
        });
        request.on('socket', socket => {
          const connected = () => { stage = url.protocol === 'https:' ? 'tls' : 'response'; trace('connect.complete', { address: socket.remoteAddress }); };
          if (socket.connecting) socket.once('connect', connected);
          else { stage = 'response'; trace('connect.reused', { address: socket.remoteAddress }); }
          socket.once('secureConnect', () => { stage = 'response'; trace('tls.complete'); });
        });
        request.on('error', reject);
        });
      };
      const result = await retryTransientRequest(send, controller.signal, errorCode => trace('retry', { errorCode, attempt: 2 }));
      if (result.location) {
        if (redirect === 3) throw new Error('网络跳转次数过多');
        const next = validateHttpUrl(new URL(result.location, url).href);
        if (next.origin !== url.origin) headers = {};
        trace('redirect', { target: diagnosticUrl(next.href) });
        url = next;
        continue;
      }
      const bytes = result.bytes!;
      stage = 'decode';
      const declared = result.charset || /<meta[^>]+charset\s*=\s*["']?([^\s"'/>;]+)/i.exec(bytes.subarray(0, 4096).toString('ascii'))?.[1];
      let charset = declared?.toLowerCase();
      let decoded: string | undefined;
      if (!charset) {
        try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); charset = 'utf-8'; }
        catch { charset = 'gb18030'; }
      }
      if (!decoded && !iconv.encodingExists(charset)) throw new Error(`不支持的网页编码：${charset}`);
      const text = (decoded ?? iconv.decode(bytes, charset)).replace(/^\uFEFF/, '');
      trace('complete', { bytes: bytes.length, charset });
      return { text, url: url.href };
    }
    throw new Error('网络请求未完成');
  } catch (error) {
    if (controller.signal.aborted) error = controller.signal.reason instanceof Error ? controller.signal.reason : new Error('网络请求已取消');
    trace('error', { failedStage: stage, ...diagnosticError(error) });
    throw error;
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
};
