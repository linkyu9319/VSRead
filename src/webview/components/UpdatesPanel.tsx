import { useEffect } from 'react';
import type { UpdateStatus } from '../../shared/online';
import { Icon } from './Icon';

export function UpdatesPanel({ status, checking, onCheck, onOpen, onAuth, onClose }: {
  status?: UpdateStatus; checking: boolean; onCheck(): void; onOpen(): void;
  onAuth(action: 'set' | 'clear'): void; onClose(): void;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  return <section className="settings-panel update-panel" role="dialog" aria-label="软件更新">
    <div className="panel-heading">软件更新<button className="icon-button" aria-label="关闭软件更新" onClick={onClose}><Icon name="close" size={15} /></button></div>
    <p className="update-description">从 GitHub 检查 VSRead 的最新稳定版本。</p>
    {status && <div className="update-status" role="status"><p>{status.message}</p><small>当前版本 {status.currentVersion}{status.latestVersion && ` · 最新版本 ${status.latestVersion}`}</small></div>}
    <div className="update-actions"><button className="primary" disabled={checking} onClick={onCheck}>{checking ? '检查中…' : '检查更新'}</button><button className="text-button" onClick={onOpen}>查看发布页</button></div>
    <p className="settings-hint">私有仓库需要只读访问令牌，令牌保存在 IDE 密钥存储中。</p>
    <div className="update-actions"><button className="text-button" onClick={() => onAuth('set')}>配置访问令牌</button><button className="text-button" onClick={() => onAuth('clear')}>清除令牌</button></div>
  </section>;
}
