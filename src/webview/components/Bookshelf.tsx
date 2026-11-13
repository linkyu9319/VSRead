import type { BookRecord } from '../../shared/model';
import { formatPercentage } from '../../shared/format';
import { Icon } from './Icon';

export function Bookshelf({ books, onOpen, onImport, onRemove, busy }: {
  books: BookRecord[]; onOpen(id: string): void; onImport(): void; onRemove(id: string): void; busy: boolean;
}) {
  const recent = [...books].sort((a, b) => (b.progress?.updatedAt ?? b.importedAt).localeCompare(a.progress?.updatedAt ?? a.importedAt));
  return <div className="shelf-page">
    <div className="shelf-intro"><span className="eyebrow">A QUIET CORNER IN YOUR IDE</span><h1>代码之间，读几页。</h1><p>关上喧嚣，把故事留在本地。</p></div>
    <div className="shelf-heading"><h2>我的书架 <span>{books.length.toString().padStart(2, '0')}</span></h2><button className="primary" onClick={onImport} disabled={busy}><Icon name="plus" size={16} />{busy ? '导入中…' : '导入书籍'}</button></div>
    {!books.length ? <div className="empty-shelf"><div className="empty-icon"><Icon name="book" size={36} /></div><h2>下一段故事，从这里开始</h2><p>导入本地 EPUB、TXT 或 PDF<br />阅读进度自动保存，随时接着读。</p><button className="primary" onClick={onImport} disabled={busy}><Icon name="plus" />选择电子书</button><small>离线阅读 · 无需账号 · 没有广告</small></div> : <div className="book-list">{recent.map((book, i) => <div className="book-card" key={book.id}>
      <button className="book-open" onClick={() => onOpen(book.id)} aria-label={`阅读 ${book.title}`}>
        <div className={`book-cover cover-${i % 4}`}>{book.cover ? <img src={book.cover} alt={`${book.title} 封面`} /> : <><Icon name="book" size={28} /><span>{book.format.toUpperCase()}</span></>}</div>
        <div className="book-details"><span className="book-format">{book.format.toUpperCase()}</span><h3>{book.title}</h3><p>{book.author || '本地藏书'}</p><div className="book-progress"><span style={{ width: `${(book.progress?.percentage ?? 0) * 100}%` }} /></div><small>{book.progress ? `已读 ${formatPercentage(book.progress.percentage)} · 继续阅读` : '尚未开始 · 翻开第一页'}</small></div><Icon name="right" />
      </button><button className="icon-button remove-book" title={`移除 ${book.title}`} aria-label={`移除 ${book.title}`} onClick={() => onRemove(book.id)}><Icon name="trash" size={15} /></button>
    </div>)}</div>}
    <footer className="shelf-footer"><span className="status-dot" /> 所有书籍与进度，仅保存在这台设备。</footer>
  </div>;
}
