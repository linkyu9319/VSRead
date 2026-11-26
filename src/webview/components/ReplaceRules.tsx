import { useEffect, useState } from 'react';
import type { ReplaceRule } from '../../shared/online';
import { request } from '../bridge';
import { Icon } from './Icon';

const PRESETS: Omit<ReplaceRule, 'id'>[] = [
  { name: '去除常见网址广告行', pattern: '^.*(?:https?://|www\\.|\\.com|\\.net|\\.cc|\\.org).*$', replacement: '', isRegex: true, enabled: true },
  { name: '去除求月票/推荐票提示', pattern: '^.*(?:求月票|求推荐票|求订阅|求打赏|加入书签|本章未完|点击下一页).*$', replacement: '', isRegex: true, enabled: true },
];

export function ReplaceRules({ onError }: { onError(error: unknown): void }) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState<ReplaceRule[]>([]);
  const [editingId, setEditingId] = useState<string>();
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [replacement, setReplacement] = useState('');
  const [scope, setScope] = useState('');
  const [isRegex, setIsRegex] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!expanded || loaded) return;
    let cancelled = false;
    setBusy(true);
    void request('replaceRules.list', undefined)
      .then(list => { if (!cancelled) { setRules(list); setLoaded(true); } })
      .catch(error => { if (!cancelled) onError(error); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [expanded, loaded, onError]);

  const resetForm = () => {
    setEditingId(undefined); setName(''); setPattern(''); setReplacement(''); setScope(''); setIsRegex(false);
  };

  const run = async (action: () => Promise<ReplaceRule[]>, feedback?: string) => {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      const next = await action();
      setRules(next);
      setLoaded(true);
      if (feedback) setNotice(feedback);
    } catch (error) { onError(error); }
    finally { setBusy(false); }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!pattern) return;
    void run(
      () => request('replaceRules.save', {
        rule: { ...(editingId ? { id: editingId } : {}), name: name.trim() || pattern.slice(0, 30), pattern, replacement, isRegex, enabled: true, scope: scope.trim() || undefined },
      }),
      editingId ? '规则已更新，阅读正文时立即生效' : '规则已添加，阅读正文时立即生效',
    ).then(resetForm);
  };

  const startEdit = (rule: ReplaceRule) => {
    setEditingId(rule.id);
    setName(rule.name);
    setPattern(rule.pattern);
    setReplacement(rule.replacement);
    setScope(rule.scope ?? '');
    setIsRegex(rule.isRegex);
  };

  return <section className="online-sources replace-rules-section" aria-label="正文净化规则">
    <div className="online-section-heading">
      <div><h2>正文净化规则 {loaded && <span>{rules.length}</span>}</h2><p>通过纯文本或正则替换过滤网文广告语与水印；仅影响展示与导出，不改写原始缓存。</p></div>
      <button className="text-button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls="replace-rules-panel">
        <Icon name={expanded ? 'close' : 'filter'} size={15} />{expanded ? '收起规则' : '管理净化规则'}
      </button>
    </div>
    {expanded && <div id="replace-rules-panel" className="replace-rules-panel">
      <form className="source-import-form replace-rule-form" onSubmit={submit}>
        <div className="replace-rule-grid">
          <input aria-label="规则名称" placeholder="规则名称（如：去除站点水印）" value={name} maxLength={100} onChange={event => setName(event.target.value)} />
          <input aria-label="适用范围" placeholder="适用范围（留空全局，或填书名/书源关键字）" value={scope} maxLength={200} onChange={event => setScope(event.target.value)} />
        </div>
        <div className="replace-rule-grid">
          <input aria-label="匹配内容" placeholder={isRegex ? '输入正则表达式（多行模式 gm）' : '输入要过滤的原文文本'} value={pattern} maxLength={500} onChange={event => setPattern(event.target.value)} />
          <input aria-label="替换为" placeholder="替换为（留空表示直接删除）" value={replacement} maxLength={1000} onChange={event => setReplacement(event.target.value)} />
        </div>
        <div className="online-form-footer">
          <label className="replace-regex-toggle"><input type="checkbox" aria-label="使用正则表达式" checked={isRegex} onChange={event => setIsRegex(event.target.checked)} />使用正则表达式</label>
          <div className="replace-form-actions">
            {editingId && <button type="button" className="text-button" onClick={resetForm}>取消编辑</button>}
            <button className="primary" type="submit" disabled={busy || !pattern}><Icon name="plus" size={14} />{editingId ? '保存修改' : '添加规则'}</button>
          </div>
        </div>
        <div className="replace-presets">
          <span>常用预设：</span>
          {PRESETS.map(preset => <button key={preset.name} type="button" className="text-button" disabled={busy} onClick={() => void run(() => request('replaceRules.save', { rule: preset }), `已添加预设「${preset.name}」`)}>+ {preset.name}</button>)}
        </div>
      </form>
      {notice && <p className="online-message" role="status">{notice}</p>}
      {rules.length ? <div className="online-source-list">{rules.map(rule => <div className="online-source-row" key={rule.id}>
        <label className="source-enabled">
          <input type="checkbox" aria-label={`启用规则 ${rule.name}`} checked={rule.enabled} disabled={busy} onChange={() => void run(() => request('replaceRules.toggle', { id: rule.id, enabled: !rule.enabled }))} />
          <span>
            <strong>{rule.name}{rule.isRegex ? ' · 正则' : ''}{rule.scope ? ` · 范围：${rule.scope}` : ''}</strong>
            <small>{rule.pattern}{rule.replacement ? ` → ${rule.replacement}` : ' → （删除）'}</small>
          </span>
        </label>
        <div className="inline-confirm">
          <button className="text-button" disabled={busy} onClick={() => startEdit(rule)}>编辑</button>
          <button className="icon-button" aria-label={`移除规则 ${rule.name}`} title={`移除规则 ${rule.name}`} disabled={busy} onClick={() => void run(() => request('replaceRules.remove', { id: rule.id }))}><Icon name="trash" size={15} /></button>
        </div>
      </div>)}</div> : <p className="online-empty-note">暂无净化规则，可在上方添加自定义规则或点击预设一键启用。</p>}
    </div>}
  </section>;
}
