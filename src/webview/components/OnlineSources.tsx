import { useEffect, useRef, useState } from 'react';
import type { BookSource, SourceImportResult } from '../../shared/online';
import { Icon } from './Icon';

interface Props {
  sources: BookSource[]; busy: boolean; expanded: boolean; onExpandedChange(value: boolean): void;
  onImport(args: { json?: string; url?: string }): Promise<SourceImportResult | undefined>;
  onToggle(source: BookSource): void; onRemove(source: BookSource): void;
}

export function OnlineSources({ sources, busy, expanded, onExpandedChange, onImport, onToggle, onRemove }: Props) {
  const [mode, setMode] = useState<'json' | 'url'>('json');
  const [json, setJson] = useState('');
  const [url, setUrl] = useState('');
  const [report, setReport] = useState<SourceImportResult>();
  const [removing, setRemoving] = useState('');
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (expanded) form.current?.querySelector<HTMLTextAreaElement | HTMLInputElement>('textarea,input')?.focus(); }, [expanded]);
  return <section className="online-sources" aria-label="书源管理">
    <div className="online-section-heading"><div><h2>书源管理 <span>{sources.length}</span></h2><p>管理已添加的书源，或导入自己的 JSON 配置。</p></div><button className="text-button" onClick={() => onExpandedChange(!expanded)} aria-expanded={expanded} aria-controls="source-import-form"><Icon name={expanded ? 'close' : 'plus'} size={16} />{expanded ? '收起配置' : '导入书源'}</button></div>
    {expanded && <form ref={form} id="source-import-form" className="source-import-form" onSubmit={event => {
      event.preventDefault();
      if (busy) return;
      void onImport(mode === 'json' ? { json: json.trim() } : { url: url.trim() }).then(result => { if (result) setReport(result); });
    }}>
      <div className="online-tabs" role="tablist" aria-label="书源导入方式"><button type="button" role="tab" aria-selected={mode === 'json'} className={mode === 'json' ? 'active' : ''} onClick={() => setMode('json')}>JSON 文本</button><button type="button" role="tab" aria-selected={mode === 'url'} className={mode === 'url' ? 'active' : ''} onClick={() => setMode('url')}>配置链接</button></div>
      {mode === 'json' ? <textarea aria-label="书源 JSON" placeholder="粘贴 VSRead 或阅读（Legado）书源 JSON，可导入单个对象或数组。" value={json} maxLength={2_000_000} onChange={event => setJson(event.target.value)} rows={6} /> : <input aria-label="书源配置链接" type="url" placeholder="https://example.org/sources.json" value={url} maxLength={2048} onChange={event => setUrl(event.target.value)} />}
      <div className="online-form-footer"><p>支持声明式 HTML / CSS 规则；不支持的规则会逐项说明。</p><button className="primary" type="submit" disabled={busy || !(mode === 'json' ? json.trim() : url.trim())}><Icon name="plus" size={15} />{busy ? '处理中…' : '导入书源'}</button></div>
      {report && <div className="source-import-report" role="status"><p>已导入 {report.imported} 个书源{report.rejected.length ? `，${report.rejected.length} 个配置未导入` : ''}。</p>{report.rejected.length > 0 && <ul>{report.rejected.map((item, index) => <li key={index}><strong>{item.name || '未命名书源'}</strong>：{item.reason}</li>)}</ul>}</div>}
    </form>}
    {sources.length ? <div className="online-source-list">{sources.map(source => <div className="online-source-row" key={source.id}>
      <label className="source-enabled"><input type="checkbox" aria-label={`启用 ${source.name}`} checked={source.enabled} disabled={busy} onChange={() => onToggle(source)} /><span><strong>{source.name}</strong><small>{source.baseUrl}</small></span></label>
      {removing === source.id ? <div className="inline-confirm"><span>移除此书源？</span><button className="text-button danger-button" disabled={busy} onClick={() => { setRemoving(''); onRemove(source); }}>确定移除</button><button className="text-button" onClick={() => setRemoving('')}>取消</button></div> : <button className="icon-button" aria-label={`移除书源 ${source.name}`} title={`移除书源 ${source.name}`} disabled={busy} onClick={() => setRemoving(source.id)}><Icon name="trash" size={15} /></button>}
    </div>)}</div> : <p className="online-empty-note">可直接在上方选择内置书源搜索，也可导入自己的书源。</p>}
  </section>;
}
