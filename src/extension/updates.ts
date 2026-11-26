import * as https from 'node:https';
import type * as vscode from 'vscode';
import path from 'node:path';
import type { UpdateInstallResult, UpdateStatus } from '../shared/online';
import { installUpdate, selectUpdateAsset } from './updateInstaller';
import type { DiagnosticSink } from './diagnostics';

export const RELEASES_URL = 'https://github.com/linkyu9319/VSRead/releases';
export const LATEST_RELEASE_API = 'https://api.github.com/repos/linkyu9319/VSRead/releases/latest';
const TOKEN_KEY = 'vsread.githubToken';
const MAX_RESPONSE_BYTES = 512 * 1024;
// 只接受已知网络错误码，异常自带的 code 也可能包含凭据等私密内容。
const CHECK_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ABORT_ERR', 'ERR_ABORTED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

function checkErrorCode(error: unknown): string {
  try {
    const value = error as { code?: unknown; cause?: { code?: unknown }; errors?: { code?: unknown }[] } | null;
    const code = value?.code ?? value?.cause?.code ?? value?.errors?.[0]?.code;
    return typeof code === 'string' && CHECK_ERROR_CODES.has(code) ? code : 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}

// VS Code 1.85 只拦截 CJS 的 vscode 加载；按需 require 兼容旧版 IDE 及纯 Node 测试。
function vscodeApi(): typeof import('vscode') { return require('vscode'); }

interface Version { core: bigint[]; prerelease: string[] }
interface ReleaseResponse {
  status: number; body: string;
  rateLimitRemaining?: number; rateLimitReset?: number; retryAfter?: number;
}
export interface UpdateServiceOptions {
  log?: DiagnosticSink;
  request?: (token: string | undefined, signal?: AbortSignal) => Promise<ReleaseResponse>;
  inputToken?: () => Promise<string | undefined>;
  openExternal?: (url: string) => Promise<boolean>;
  install?: typeof installUpdate;
  withProgress?: (task: (signal: AbortSignal, report: (received: number, total: number) => void) => Promise<UpdateInstallResult>) => Promise<UpdateInstallResult>;
  installFile?: (file: string) => Promise<void>;
  reloadWindow?: () => Promise<void>;
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

function unavailable(currentVersion: string, message: string, details: Pick<UpdateStatus, 'errorCode' | 'retryAt'> = {}): UpdateStatus {
  return { state: 'unavailable', currentVersion, message, ...details };
}

function boundedInteger(value: unknown, maximum: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function rateLimitInfo(response: ReleaseResponse): Pick<ReleaseResponse, 'rateLimitRemaining' | 'rateLimitReset' | 'retryAfter'> {
  return {
    rateLimitRemaining: boundedInteger(response.rateLimitRemaining, 1_000_000_000),
    rateLimitReset: boundedInteger(response.rateLimitReset, Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
    retryAfter: boundedInteger(response.retryAfter, 7 * 24 * 60 * 60),
  };
}

function rateLimitReason(response: ReleaseResponse): 'primary-rate-limit' | 'secondary-rate-limit' | 'rate-limited' | undefined {
  if (response.status !== 403 && response.status !== 429) return;
  if (rateLimitInfo(response).rateLimitRemaining === 0) return 'primary-rate-limit';
  // 只识别 GitHub 的已知限流标记，远端错误正文不直接进入界面或日志。
  let message: unknown;
  try { message = JSON.parse(response.body)?.message; } catch { /* 非 JSON 的拒绝响应不能据此断言限流。 */ }
  if (typeof message === 'string') {
    if (/secondary rate limit|^you have triggered an abuse detection mechanism/i.test(message)) return 'secondary-rate-limit';
    if (/^api rate limit exceeded\b/i.test(message)) return 'primary-rate-limit';
  }
  if (response.status === 429) return 'rate-limited';
}

function limitedStatus(currentVersion: string, response: ReleaseResponse, authenticated: boolean): UpdateStatus {
  const now = Date.now();
  const { rateLimitRemaining, rateLimitReset, retryAfter } = rateLimitInfo(response);
  const retryAfterTime = retryAfter !== undefined ? now + retryAfter * 1000 : undefined;
  // 主额度耗尽时同时遵守重置窗口；二级限流则优先使用服务端的 Retry-After。
  const resetTime = rateLimitReset !== undefined && (rateLimitRemaining === 0 || retryAfter === undefined) ? rateLimitReset * 1000 : undefined;
  const retryTime = retryAfterTime !== undefined && resetTime !== undefined ? Math.max(retryAfterTime, resetTime) : retryAfterTime ?? resetTime;
  const retryAt = retryTime !== undefined && retryTime > now ? new Date(retryTime).toISOString() : undefined;
  const wait = retryAt ? `请约 ${Math.ceil((retryTime! - now) / 1000)} 秒后重试。` : '请等待额度恢复后重试。';
  const auth = authenticated ? '可检查所配置令牌的请求额度。' : '也可配置 GitHub 只读访问令牌，使用认证请求额度。';
  return unavailable(currentVersion, `GitHub API 请求已被限流。${wait}${auth}`, { errorCode: 'rate-limited', ...(retryAt ? { retryAt } : {}) });
}

/** GitHub 的 404 同时可能表示无 Release 和私有仓库无访问权，不能当作“已是最新”。 */
export function releaseStatus(currentVersion: string, response: ReleaseResponse, authenticated: boolean): UpdateStatus {
  if (response.status === 404) return unavailable(currentVersion, authenticated
    ? '未找到可访问的正式发布版本，请确认令牌有仓库读取权限，或稍后再试。'
    : '尚无正式发布版本，或仓库为私有。可配置 GitHub 令牌后重试。');
  if (response.status === 401) return unavailable(currentVersion, 'GitHub 令牌无效或已过期，请重新配置。', { errorCode: 'unauthorized' });
  if (rateLimitReason(response)) return limitedStatus(currentVersion, response, authenticated);
  if (response.status === 403) return unavailable(currentVersion, authenticated
    ? 'GitHub 拒绝访问（HTTP 403），未返回明确的限流信息。请检查令牌的仓库读取权限，或清除令牌后重试。'
    : 'GitHub 拒绝访问（HTTP 403），未返回明确的限流信息。请检查访问权限或网络限制。', { errorCode: 'forbidden' });
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
export async function requestLatestRelease(token?: string, signal?: AbortSignal): Promise<ReleaseResponse> {
  if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('Release request aborted'), { name: 'AbortError' });
  // 兼容 VS Code 1.85（Node 18.15），避免依赖 Node 18.17+ 才提供的 AbortSignal.any。
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Release request timed out')), 15_000);
  try {
    return await new Promise<ReleaseResponse>((resolve, reject) => {
      const request = https.get(LATEST_RELEASE_API, {
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json', 'User-Agent': 'VSRead-version-check',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }, response => {
        const headerNumber = (name: string, maximum: number) => {
          const value = response.headers[name];
          return typeof value === 'string' && /^\d{1,13}$/.test(value) ? boundedInteger(Number(value), maximum) : undefined;
        };
        const limits = {
          rateLimitRemaining: headerNumber('x-ratelimit-remaining', 1_000_000_000),
          rateLimitReset: headerNumber('x-ratelimit-reset', Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
          retryAfter: headerNumber('retry-after', 7 * 24 * 60 * 60),
        };
        let total = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) { response.destroy(); request.destroy(new Error('Release response too large')); return; }
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('aborted', () => reject(new Error('Release response interrupted')));
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), ...limits }));
      });
      request.setTimeout(15_000, () => request.destroy(new Error('Release request timed out')));
      request.once('error', reject);
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

export class UpdateService {
  private pending?: Promise<UpdateStatus>;
  private installing?: Promise<UpdateInstallResult>;
  private installed?: UpdateInstallResult;
  private currentVersion: string;
  constructor(private context: vscode.ExtensionContext, private options: UpdateServiceOptions = {}) {
    this.currentVersion = String(context.extension.packageJSON.version);
  }

  /** 仅在用户主动操作时请求 Release；并发点击复用一次检查。 */
  check(): Promise<UpdateStatus> {
    if (!this.pending) this.pending = this.checkOnce().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private writeCheckLog(event: string, details: Record<string, unknown>): void {
    try { this.options.log?.(event === 'updates.check.failed' ? 'warn' : 'info', event, details); }
    catch { /* 诊断输出失败不影响版本检查。 */ }
  }

  private async checkOnce(): Promise<UpdateStatus> {
    const started = Date.now();
    let phase: 'credentials' | 'request' = 'credentials';
    let authenticated = false;
    this.writeCheckLog('updates.check.start', { currentVersion: this.currentVersion, phase });
    try {
      const token = await this.context.secrets.get(TOKEN_KEY);
      authenticated = Boolean(token);
      phase = 'request';
      const response = await (this.options.request ?? requestLatestRelease)(token);
      const status = releaseStatus(this.currentVersion, response, Boolean(token));
      this.writeCheckLog('updates.check.result', {
        currentVersion: this.currentVersion, latestVersion: status.latestVersion, state: status.state,
        httpStatus: response.status, phase, elapsedMs: Date.now() - started, authenticated: Boolean(token),
        reason: rateLimitReason(response) ?? status.errorCode,
        ...rateLimitInfo(response),
      });
      return status;
    } catch (error) {
      // 仅记录阶段和受控错误码，凭据、响应正文和底层异常文本不进入诊断日志。
      this.writeCheckLog('updates.check.failed', {
        currentVersion: this.currentVersion, state: 'unavailable', phase, elapsedMs: Date.now() - started,
        errorCode: checkErrorCode(error),
        ...(phase === 'request' ? { authenticated } : {}),
      });
      // 网络和凭据错误只返回固定提示，不把可能包含请求信息的异常暴露给 Webview。
      return unavailable(this.currentVersion, '无法连接 GitHub，请检查网络连接后重试。');
    }
  }

  /** 用户点击后重新确认最新正式版本；同一 Host 的并发请求只启动一次安装。 */
  install(): Promise<UpdateInstallResult> {
    if (this.installed) return Promise.resolve(this.installed);
    if (!this.installing) this.installing = this.installOnce().then(result => {
      if (result.state === 'installed') this.installed = result;
      return result;
    }).finally(() => { this.installing = undefined; });
    return this.installing;
  }

  private async installOnce(): Promise<UpdateInstallResult> {
    const run = this.options.withProgress ?? (async task => {
      const vscode = vscodeApi();
      return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'VSRead · 更新插件', cancellable: true }, async (progress, cancellation) => {
        const controller = new AbortController();
        const subscription = cancellation.onCancellationRequested(() => controller.abort());
        if (cancellation.isCancellationRequested) controller.abort();
        let percentage = 0;
        progress.report({ message: '获取最新版本…' });
        try {
          return await task(controller.signal, (received, total) => {
            const next = Math.min(100, received / total * 100);
            progress.report({ increment: Math.max(0, next - percentage), message: next < 100 ? `下载中 ${next.toFixed(0)}%` : '正在校验并安装，请稍候…' });
            percentage = next;
          });
        } finally { subscription.dispose(); }
      });
    });
    return run(async (signal, report) => {
      let response: ReleaseResponse;
      const token = await this.context.secrets.get(TOKEN_KEY);
      try { response = await (this.options.request ?? requestLatestRelease)(token, signal); }
      catch { if (signal.aborted) return { state: 'cancelled', message: '已取消更新，当前版本保持不变。' }; throw new Error('无法连接 GitHub，请稍后重试或从发布页手动安装。'); }
      if (signal.aborted) return { state: 'cancelled', message: '已取消更新，当前版本保持不变。' };
      const status = releaseStatus(this.currentVersion, response, Boolean(token));
      if (status.state !== 'available' || !status.latestVersion) throw new Error(status.message);
      const asset = selectUpdateAsset(status.latestVersion, JSON.parse(response.body));
      return (this.options.install ?? installUpdate)(asset, {
        directory: path.join(this.context.globalStorageUri.fsPath, 'updates'), token, signal, onProgress: report,
        install: this.options.installFile ?? (async file => {
          const vscode = vscodeApi();
          try { await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file)); }
          catch { throw new Error('IDE 未能完成安装，请从发布页下载并手动安装。'); }
        }),
      });
    });
  }

  async reload(): Promise<void> {
    if (!this.installed) throw new Error('请先完成更新安装。');
    if (this.options.reloadWindow) await this.options.reloadWindow();
    else {
      const vscode = vscodeApi();
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }

  async open(): Promise<void> {
    const open = this.options.openExternal ?? (async url => {
      const vscode = vscodeApi();
      return vscode.env.openExternal(vscode.Uri.parse(url));
    });
    if (!await open(RELEASES_URL)) throw new Error('无法打开 GitHub 发布页面。');
  }

  async auth(action: 'set' | 'clear'): Promise<void> {
    if (action === 'clear') { await this.context.secrets.delete(TOKEN_KEY); return; }
    if (action !== 'set') throw new Error('GitHub 认证操作无效。');
    const input = this.options.inputToken ?? (async () => {
      const vscode = vscodeApi();
      return vscode.window.showInputBox({
        title: 'VSRead · GitHub 访问令牌', password: true, ignoreFocusOut: true,
        prompt: '用于访问私有发布仓库或使用 GitHub 认证请求额度；令牌仅保存在 IDE 的 SecretStorage。私有仓库需 Contents 读取权限。',
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
