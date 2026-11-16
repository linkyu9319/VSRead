import https from 'node:https';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import type { UpdateInstallResult } from '../shared/online';

const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
const ASSET_API = 'https://api.github.com/repos/linkyu9319/VSRead/releases/assets/';
const DOWNLOAD_HOSTS = new Set(['api.github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
export interface UpdateAsset { id: number; version: string; name: string; size: number; sha256: string }
export type AssetDownloader = (asset: UpdateAsset, token: string | undefined, signal: AbortSignal | undefined, onProgress?: (received: number, total: number) => void) => Promise<Buffer>;

/** 仅从当前仓库正式 Release 选择与版本绑定的安装包，不接受 Webview 传来的下载地址。 */
export function selectUpdateAsset(version: string, release: unknown): UpdateAsset {
  const value = release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown } | null;
  if (!/^\d+\.\d+\.\d+$/.test(version) || !value || ![version, `v${version}`].includes(String(value.tag_name)) || value.draft === true || value.prerelease === true || !Array.isArray(value.assets)) throw new Error('发布信息无效，请重新检查更新。');
  const name = `vsread-${version}.vsix`;
  const asset = value.assets.find(item => item && item.name === name);
  if (!asset || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_PACKAGE_BYTES || typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)) throw new Error('发布版本缺少可校验的安装包，请从发布页手动安装。');
  return { id: asset.id, version, name, size: asset.size, sha256: asset.digest.slice(7).toLowerCase() };
}

/** 安装前验证完整文件及扩展身份，避免损坏包或同一 Release 的其他附件被安装。 */
export async function verifyUpdatePackage(bytes: Buffer, asset: UpdateAsset): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(asset.version) || asset.name !== `vsread-${asset.version}.vsix`) throw new Error('更新安装包名称无效。');
  if (bytes.length !== asset.size || bytes.length > MAX_PACKAGE_BYTES) throw new Error('安装包大小不匹配，请重试下载。');
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('安装包校验失败，请重试下载。');
  let manifest: { name?: unknown; publisher?: unknown; version?: unknown };
  try {
    const zip = await JSZip.loadAsync(bytes);
    const entry = zip.file('extension/package.json');
    if (!entry) throw new Error();
    const text = await entry.async('string');
    if (text.length > 512 * 1024) throw new Error();
    manifest = JSON.parse(text);
  } catch { throw new Error('安装包格式无效，请从发布页手动安装。'); }
  if (!manifest || manifest.name !== 'vsread' || manifest.publisher !== 'vsread-local' || manifest.version !== asset.version) throw new Error('安装包的扩展身份或版本不匹配，已停止安装。');
}

/** 处理 GitHub 的二进制响应或 CDN 跳转；访问令牌只发往固定的资产 API。 */
export const downloadUpdateAsset: AssetDownloader = async (asset, token, signal, onProgress) => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 180_000);
  let url = new URL(ASSET_API + asset.id);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      controller.signal.throwIfAborted();
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !DOWNLOAD_HOSTS.has(url.hostname)) throw new Error('更新下载跳转地址无效。');
      const authenticated = url.href === ASSET_API + asset.id;
      const response = await new Promise<{ bytes?: Buffer; location?: string }>((resolve, reject) => {
        const request = https.get(url, {
          signal: controller.signal,
          headers: { Accept: 'application/octet-stream', 'User-Agent': 'VSRead-update', ...(authenticated && token ? { Authorization: `Bearer ${token}` } : {}) },
        }, incoming => {
          incoming.once('error', reject);
          if ([301, 302, 303, 307, 308].includes(incoming.statusCode ?? 0)) {
            incoming.resume();
            if (!incoming.headers.location) reject(new Error('更新下载缺少跳转地址。'));
            else resolve({ location: incoming.headers.location });
            return;
          }
          if (incoming.statusCode !== 200) { incoming.resume(); reject(new Error(`下载更新失败（HTTP ${incoming.statusCode ?? 0}），请稍后重试。`)); return; }
          const length = incoming.headers['content-length'];
          if (length && Number(length) !== asset.size) { incoming.destroy(); reject(new Error('安装包大小不匹配，请重试下载。')); return; }
          const chunks: Buffer[] = [];
          let received = 0;
          incoming.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > asset.size || received > MAX_PACKAGE_BYTES) { incoming.destroy(new Error('安装包超过预期大小，已停止下载。')); return; }
            chunks.push(chunk);
            try { onProgress?.(received, asset.size); } catch { /* 进度提示失败不阻断下载。 */ }
          });
          incoming.once('aborted', () => reject(new Error('更新下载中断，请重试。')));
          incoming.once('end', () => resolve({ bytes: Buffer.concat(chunks) }));
        });
        request.setTimeout(30_000, () => request.destroy(new Error('更新下载超时，请稍后重试。')));
        request.once('error', reject);
      });
      if (response.bytes) return response.bytes;
      url = new URL(response.location!, url);
    }
    throw new Error('更新下载跳转次数过多。');
  } catch (error) {
    if (signal?.aborted) throw error;
    // 不向界面透出包含签名查询参数或凭据的底层网络异常。
    throw new Error('无法下载更新，请检查网络或从发布页手动安装。', { cause: error });
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
};

export interface InstallUpdateOptions {
  directory: string; token?: string; signal?: AbortSignal;
  onProgress?(received: number, total: number): void;
  download?: AssetDownloader; install(file: string): Promise<void>;
}

/** 每次更新使用独立临时目录，等待 IDE 读完安装包后清理；取消不影响现有扩展与书库。 */
export async function installUpdate(asset: UpdateAsset, options: InstallUpdateOptions): Promise<UpdateInstallResult> {
  let directory: string | undefined;
  let installing = false;
  try {
    options.signal?.throwIfAborted();
    const bytes = await (options.download ?? downloadUpdateAsset)(asset, options.token, options.signal, options.onProgress);
    options.signal?.throwIfAborted();
    await verifyUpdatePackage(bytes, asset);
    options.signal?.throwIfAborted();
    await mkdir(options.directory, { recursive: true });
    directory = await mkdtemp(path.join(options.directory, 'vsread-'));
    const file = path.join(directory, asset.name);
    await writeFile(file, bytes);
    options.signal?.throwIfAborted();
    installing = true;
    await options.install(file);
    return { state: 'installed', version: asset.version, message: `版本 ${asset.version} 已安装，重载窗口后生效。` };
  } catch (error) {
    if (!installing && options.signal?.aborted) return { state: 'cancelled', message: '已取消更新，当前版本保持不变。' };
    throw error;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
