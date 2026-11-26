import type { BookFormat, ReaderSettings } from '../../shared/model';
import { useEffect } from 'react';
import { Icon } from './Icon';

export function Settings({ value, format, onChange, onClose }: { value: ReaderSettings; format?: BookFormat; onChange(value: ReaderSettings): void; onClose(): void }) {
  const update = (patch: Partial<ReaderSettings>) => onChange({ ...value, ...patch });
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [onClose]);
  return <section className="settings-panel" id="reading-settings" role="dialog" aria-label="阅读偏好">
    <div className="panel-heading">阅读偏好<button className="icon-button" onClick={onClose} aria-label="关闭阅读偏好"><Icon name="close" size={15} /></button></div>
    <label>外观<select aria-label="阅读主题" value={value.theme} onChange={event => update({ theme: event.target.value as ReaderSettings['theme'] })}>
      <option value="ide">跟随 IDE</option><option value="light">纸间 · 浅色</option><option value="dark">夜读 · 深色</option><option value="custom">自定义颜色</option>
    </select></label>
    {value.theme === 'custom' && <div className="custom-colors">
      <label>背景颜色<span className="color-value"><code>{value.backgroundColor}</code><input aria-label="背景颜色" type="color" value={value.backgroundColor} onChange={event => update({ backgroundColor: event.target.value })} /></span></label>
      <label>文字颜色<span className="color-value"><code>{value.textColor}</code><input aria-label="文字颜色" type="color" value={value.textColor} onChange={event => update({ textColor: event.target.value })} /></span></label>
      <div className="color-presets" aria-label="配色预设">{[
        { name: '纸白', background: '#faf8f2', text: '#302e2a' }, { name: '护眼绿', background: '#cce8cf', text: '#25342a' },
        { name: '米黄', background: '#f4ecd8', text: '#483d2e' }, { name: '夜色', background: '#1c2025', text: '#d4d7d9' },
      ].map(preset => <button key={preset.name} style={{ backgroundColor: preset.background, color: preset.text }} onClick={() => update({ backgroundColor: preset.background, textColor: preset.text })}>{preset.name}</button>)}</div>
    </div>}
    {format === 'pdf' ? <>
      <label>缩放 <span>{Math.round(value.zoom * 100)}%</span><input aria-label="PDF 缩放" type="range" min="0.5" max="3" step="0.1" value={value.zoom} onChange={event => update({ zoom: Number(event.target.value) })} /></label>
      <label>页面滤镜<select aria-label="PDF 滤镜" value={value.pdfFilter ?? 'none'} onChange={event => update({ pdfFilter: event.target.value as ReaderSettings['pdfFilter'] })}>
        <option value="none">原稿</option><option value="dark">深色反色</option><option value="sepia">暖纸护眼</option>
      </select></label>
      <p className="settings-hint">PDF 保留原稿排版，可通过缩放与页面滤镜改善深色环境阅读体验。</p>
    </> : <>
      <div className="font-size-setting"><div><label htmlFor="reader-font-range">字号</label><span><input aria-label="字号数值" type="number" min="12" max="40" step="1" value={value.fontSize} onChange={event => {
        const size = event.target.valueAsNumber;
        if (Number.isInteger(size) && size >= 12 && size <= 40) update({ fontSize: size });
      }} onBlur={event => { event.currentTarget.value = String(value.fontSize); }} /> px</span></div><input id="reader-font-range" aria-label="字号" type="range" min="12" max="40" value={value.fontSize} onChange={event => update({ fontSize: Number(event.target.value) })} /></div>
      <label>行距 <span>{value.lineHeight.toFixed(1)}</span><input aria-label="行距" type="range" min="1.2" max="3" step="0.1" value={value.lineHeight} onChange={event => update({ lineHeight: Number(event.target.value) })} /></label>
      <label>正文宽度 <span>{value.maxWidth ?? 830} px</span><input aria-label="正文宽度" type="range" min="480" max="1400" step="20" value={value.maxWidth ?? 830} onChange={event => update({ maxWidth: Number(event.target.value) })} /></label>
      <label>段间距 <span>{(value.paragraphSpacing ?? 0.8).toFixed(1)} em</span><input aria-label="段间距" type="range" min="0" max="2.4" step="0.2" value={value.paragraphSpacing ?? 0.8} onChange={event => update({ paragraphSpacing: Number(event.target.value) })} /></label>
      <label>字体<select aria-label="字体" value={value.fontFamily} onChange={event => update({ fontFamily: event.target.value as ReaderSettings['fontFamily'] })}><option value="serif">宋体 / 衬线</option><option value="sans-serif">系统 / 无衬线</option></select></label>
      {format === 'epub' && <label>阅读方式<select aria-label="阅读方式" value={value.flow} onChange={event => update({ flow: event.target.value as ReaderSettings['flow'] })}><option value="scrolled">章节内滚动</option><option value="paginated">分页阅读</option></select></label>}
      <label className="settings-checkbox"><span>在线阅读预加载下一章</span><input aria-label="预加载下一章" type="checkbox" checked={value.preloadNextChapter ?? true} onChange={event => update({ preloadNextChapter: event.target.checked })} /></label>
      <p className="settings-hint">字号、行距、宽度与段间距应用于 TXT / EPUB 与在线正文，设置会自动保存。</p>
    </>}
  </section>;
}
