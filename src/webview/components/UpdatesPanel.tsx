import { useEffect } from 'react';
import type { UpdateInstallResult, UpdateStatus } from '../../shared/online';
import { Icon } from './Icon';

export function UpdatesPanel({ status, checking, installing, reloading, installResult, error, onCheck, onInstall, onReload, onOpen, onAuth, onClose }: {
  status?: UpdateStatus; checking: boolean; installing: boolean; reloading: boolean;
  installResult?: UpdateInstallResult; error: string; onCheck(): void; onInstall(): void; onReload(): void; onOpen(): void;
  onAuth(action: 'set' | 'clear'): void; onClose(): void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  const installed = installResult?.state === 'installed';
  const busy = checking || installing || reloading;
  return <section className="settings-panel update-panel" role="dialog" aria-label="软件更新">
    <div className="panel-heading">软件更新<button className="icon-button" aria-label="关闭软件更新" onClick={onClose}><Icon name="close" size={15} /></button></div>
    <p className="update-description">从 GitHub 检查 VSRead 的最新稳定版本。</p>
    {checking && <p className="settings-hint" role="status">正在从 GitHub 获取最新版本，请稍候…</p>}
    {status && <div className="update-status" role="status"><p>{status.message}</p><small>当前版本 {status.currentVersion}{status.latestVersion && ` · 最新版本 ${status.latestVersion}`}</small></div>}
    {installing && <p className="settings-hint" role="status">正在更新，请稍候…</p>}
    {installResult && <p className="settings-hint" role="status">{installResult.message}</p>}
    {error && <p className="settings-hint" role="alert">{error}</p>}
    <div className="update-actions">
      {installed ? <button className="primary" disabled={busy} onClick={onReload}>{reloading ? '正在重载…' : '重载窗口'}</button> : status?.state === 'available' && <button className="primary" disabled={busy} onClick={onInstall}>{installing ? '正在更新…' : error ? '重试更新' : '一键更新'}</button>}
      <button className="text-button" disabled={busy || installed} onClick={onCheck}>{checking ? '检查中…' : '检查更新'}</button><button className="text-button" onClick={onOpen}>查看发布页</button>
    </div>
    <p className="settings-hint">私有仓库需要只读访问令牌，令牌保存在 IDE 密钥存储中。</p>
    <div className="update-actions"><button className="text-button" disabled={busy || installed} onClick={() => onAuth('set')}>配置访问令牌</button><button className="text-button" disabled={busy || installed} onClick={() => onAuth('clear')}>清除令牌</button></div>
  </section>;
}
