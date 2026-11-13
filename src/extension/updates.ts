import * as https from 'node:https';
import type * as vscode from 'vscode';
import type { UpdateStatus } from '../shared/online';

export const RELEASES_URL = 'https://github.com/linkyu9319/VSRead/releases';
export const LATEST_RELEASE_API = 'https://api.github.com/repos/linkyu9319/VSRead/releases/latest';
const TOKEN_KEY = 'vsread.githubToken';
const MAX_RESPONSE_BYTES = 512 * 1024;

interface Version { core: bigint[]; prerelease: string[] }
interface ReleaseResponse { status: number; body: string }
export interface UpdateServiceOptions {
  request?: (token: string | undefined) => Promise<ReleaseResponse>;
  inputToken?: () => Promise<string | undefined>;
  openExternal?: (url: string) => Promise<boolean>;
}

function parseVersion(value: string): Version | undefined {
  if (value.length > 128) return undefined;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value.trim());
  if (!match) return undefined;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) return undefined;
  return { core: match.slice(1, 4).map(part => BigInt(part)), prerelease };
}

/** SemVer 按数字比较主版本，预发布低于同版本的正式版，构建元数据不参与排序。 */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xNumber !== yNumber) return xNumber ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function unavailable(currentVersion: string, message: string): UpdateStatus {
  return { state: 'unavailable', currentVersion, message };
}

/** GitHub 的 404 同时可能表示无 Release 和私有仓库无访问权，不能当作“已是最新”。 */
export function releaseStatus(currentVersion: string, response: ReleaseResponse, authenticated: boolean): UpdateStatus {
  if (response.status === 404) return unavailable(currentVersion, authenticated
    ? '未找到可访问的正式发布版本，请确认令牌有仓库读取权限，或稍后再试。'
    : '尚无正式发布版本，或仓库为私有。可配置 GitHub 令牌后重试。');
  if (response.status === 401) return unavailable(currentVersion, 'GitHub 令牌无效或已过期，请重新配置。');
  if (response.status === 403 || response.status === 429) return unavailable(currentVersion, 'GitHub 请求受限，请检查仓库访问权限或稍后重试。');
  if (response.status !== 200) return unavailable(currentVersion, `无法检查更新（HTTP ${response.status}），请稍后重试。`);
  let release: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(response.body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    release = value as Record<string, unknown>;
  } catch { return unavailable(currentVersion, 'GitHub 返回的发布信息格式无效。'); }
  const tag = typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  const version = parseVersion(tag);
  if (!version || version.prerelease.length || release.draft === true || release.prerelease === true) return unavailable(currentVersion, '暂无有效的正式发布版本。');
  const comparison = compareVersions(tag, currentVersion);
  if (comparison === undefined) return unavailable(currentVersion, '当前插件版本格式无效，无法比较版本。');
  // 发布地址由固定仓库和校验后的 tag 构造，不信任响应中的任意 html_url。
  const releaseUrl = `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`;
  return {
    state: comparison > 0 ? 'available' : 'current', currentVersion, latestVersion: tag.replace(/^v/, ''), releaseUrl,
    ...(typeof release.published_at === 'string' && Number.isFinite(Date.parse(release.published_at)) ? { publishedAt: release.published_at } : {}),
    message: comparison > 0 ? `发现新版本 ${tag.replace(/^v/, '')}` : '当前版本已是最新正式版本。',
  };
}

/** 固定 GitHub API 主机，不跟随重定向，私有仓库令牌不会被转发到其他站点。 */
export async function requestLatestRelease(token?: string): Promise<ReleaseResponse> {
  return new Promise((resolve, reject) => {
    const request = https.get(LATEST_RELEASE_API, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/vnd.github+json', 'User-Agent': 'VSRead-version-check',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, response => {
      let total = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) { response.destroy(); request.destroy(new Error('Release response too large')); return; }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('Release response interrupted')));
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.setTimeout(15_000, () => request.destroy(new Error('Release request timed out')));
    request.once('error', reject);
  });
}

export class UpdateService {
  private pending?: Promise<UpdateStatus>;
  private currentVersion: string;
  constructor(private context: vscode.ExtensionContext, private options: UpdateServiceOptions = {}) {
    this.currentVersion = String(context.extension.packageJSON.version);
  }

  /** 仅在用户主动操作时请求 Release；并发点击复用一次检查。 */
  check(): Promise<UpdateStatus> {
    if (!this.pending) this.pending = this.checkOnce().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async checkOnce(): Promise<UpdateStatus> {
    try {
      const token = await this.context.secrets.get(TOKEN_KEY);
      const response = await (this.options.request ?? requestLatestRelease)(token);
      return releaseStatus(this.currentVersion, response, Boolean(token));
    } catch {
      // 网络和凭据错误只返回固定提示，不把可能包含请求信息的异常暴露给 Webview。
      return unavailable(this.currentVersion, '无法连接 GitHub，请检查网络连接后重试。');
    }
  }

  async open(): Promise<void> {
    const open = this.options.openExternal ?? (async url => {
      const vscode = await import('vscode');
      return vscode.env.openExternal(vscode.Uri.parse(url));
    });
    if (!await open(RELEASES_URL)) throw new Error('无法打开 GitHub 发布页面。');
  }

  async auth(action: 'set' | 'clear'): Promise<void> {
    if (action === 'clear') { await this.context.secrets.delete(TOKEN_KEY); return; }
    if (action !== 'set') throw new Error('GitHub 认证操作无效。');
    const input = this.options.inputToken ?? (async () => {
      const vscode = await import('vscode');
      return vscode.window.showInputBox({
        title: 'VSRead · GitHub 访问令牌', password: true, ignoreFocusOut: true,
        prompt: '访问私有发布仓库时使用；令牌仅保存在 IDE 的 SecretStorage。需仓库 Contents 读取权限。',
        placeHolder: '输入 GitHub 个人访问令牌',
      });
    });
    const token = await input();
    if (token === undefined) return;
    const trimmed = token.trim();
    if (!trimmed || trimmed.length > 2048 || /\s/.test(trimmed)) throw new Error('请输入有效的 GitHub 访问令牌。');
    await this.context.secrets.store(TOKEN_KEY, trimmed);
  }
}
