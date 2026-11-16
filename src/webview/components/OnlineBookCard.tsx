import { useState } from 'react';
import type { OnlineBookRecord } from '../../shared/online';
import { formatPercentage } from '../../shared/format';
import { Icon } from './Icon';

export function OnlineBookCard({ book, sourceName, busy, onOpen, onRemove }: {
  book: OnlineBookRecord; sourceName: string; busy: boolean; onOpen(): void; onRemove(): void;
}) {
  const [confirming, setConfirming] = useState(false);
  const percentage = book.chapters.length ? ((book.progress?.chapter ?? 0) + (book.progress?.scroll ?? 0)) / book.chapters.length : 0;
  return <div className="book-card online-book-card" data-book-kind="online">
    <button className="book-open" onClick={onOpen} disabled={busy} aria-label={`阅读 ${book.title}`}>
      <div className="book-cover online-book-cover"><Icon name="globe" size={28} /><span>ONLINE</span></div>
      <div className="book-details"><span className="book-format" title={sourceName}>在线 · {sourceName}</span><h3>{book.title}</h3><p>{book.author || '作者未注明'}</p><div className="book-progress"><span style={{ width: `${Math.min(1, Math.max(0, percentage)) * 100}%` }} /></div><small>{book.progress ? `已读 ${formatPercentage(percentage)} · 继续阅读` : '尚未开始 · 开始阅读'}</small><small className="online-cache-count">已缓存 {book.cachedChapters.length} / {book.chapters.length} 章</small></div><Icon name="right" />
    </button>
    {confirming ? <div className="book-remove-confirm" role="group" aria-label={`确认移除在线书籍 ${book.title}`}><span>移除此书及缓存？</span><button className="text-button danger-button" disabled={busy} onClick={() => { setConfirming(false); onRemove(); }}>确定移除</button><button className="text-button" disabled={busy} onClick={() => setConfirming(false)}>取消</button></div> : <button className="icon-button remove-book" title={`移除 ${book.title}`} aria-label={`移除在线书籍 ${book.title}`} disabled={busy} onClick={() => setConfirming(true)}><Icon name="trash" size={15} /></button>}
  </div>;
}
