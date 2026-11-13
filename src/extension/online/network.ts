import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';
import iconv from 'iconv-lite';

export interface RequestTextOptions { maxBytes?: number; headers?: Record<string, string>; signal?: AbortSignal }
export interface TextResponse { text: string; url: string }
export type TextFetcher = (url: string, options?: RequestTextOptions) => Promise<TextResponse>;

/** 固定到已验证地址，同时兼容 Node 18 单地址与 Node 22 all=true 的查询约定。 */
export function pinnedLookup(address: { address: string; family: number }): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  };
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
    // 仅允许全局单播；映射、隧道和文档地址不会借由 IPv6 绕过私网限制。
    return /^[23][0-9a-f]{3}:/.test(value) && !value.startsWith('2001:db8:') && !value.startsWith('2002:');
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
  const abort = () => controller.abort(options.signal?.reason ?? new Error('网络请求已取消'));
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('网络请求超时，请稍后重试')), 15_000);
  let headers = { ...options.headers };
  try {
    for (let redirect = 0; redirect <= 3; redirect++) {
      controller.signal.throwIfAborted();
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        const aborted = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', aborted, { once: true });
        void lookup(hostname, { all: true, verbatim: true }).then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', aborted));
      });
      controller.signal.throwIfAborted();
      if (!addresses.length || addresses.some(address => !publicAddress(address.address))) throw new Error('书源域名指向私有网络，已停止访问');
      const selected = addresses.find(address => address.family === 4) ?? addresses[0];
      const result = await new Promise<{ bytes?: Buffer; location?: string; charset?: string }>((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const request = transport.get(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'VSRead/0.1', Accept: 'text/html,application/json;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'gzip, deflate, br', ...headers },
          family: selected.family,
          lookup: pinnedLookup(selected),
        }, response => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            const location = response.headers.location;
            response.destroy();
            if (!location) reject(new Error('网络跳转缺少目标地址'));
            else resolve({ location });
            return;
          }
          if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
            response.destroy(); reject(new Error(`网络请求失败（HTTP ${response.statusCode ?? 0}）`)); return;
          }
          const encoding = response.headers['content-encoding']?.toLowerCase();
          let stream: Readable = response;
          if (encoding === 'gzip') stream = response.pipe(createGunzip());
          else if (encoding === 'deflate') stream = response.pipe(createInflate());
          else if (encoding === 'br') stream = response.pipe(createBrotliDecompress());
          else if (encoding && encoding !== 'identity') { response.destroy(); reject(new Error('不支持该响应压缩格式')); return; }
          let bytes = 0;
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) { stream.destroy(); response.destroy(); reject(new Error('响应内容过大，已停止读取')); }
            else chunks.push(chunk);
          });
          response.on('error', reject); stream.on('error', reject);
          stream.on('end', () => resolve({ bytes: Buffer.concat(chunks), charset: /charset\s*=\s*["']?([^;\s"']+)/i.exec(response.headers['content-type'] ?? '')?.[1] }));
        });
        request.on('error', reject);
      });
      if (result.location) {
        if (redirect === 3) throw new Error('网络跳转次数过多');
        const next = validateHttpUrl(new URL(result.location, url).href);
        if (next.origin !== url.origin) headers = {};
        url = next;
        continue;
      }
      const bytes = result.bytes!;
      const declared = result.charset || /<meta[^>]+charset\s*=\s*["']?([^\s"'/>;]+)/i.exec(bytes.subarray(0, 4096).toString('ascii'))?.[1];
      let charset = declared?.toLowerCase();
      if (!charset) {
        try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); charset = 'utf-8'; }
        catch { charset = 'gb18030'; }
      }
      if (!iconv.encodingExists(charset)) throw new Error(`不支持的网页编码：${charset}`);
      return { text: iconv.decode(bytes, charset).replace(/^\uFEFF/, ''), url: url.href };
    }
    throw new Error('网络请求未完成');
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('网络请求已取消');
    throw error;
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
};
