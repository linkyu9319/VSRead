/** 书籍内容不是插件代码：在 epub.js 序列化之前移除脚本与主动内容。 */
export function sanitizeEpubDocument(document: Document): void {
  document.querySelectorAll('script, iframe, object, embed, form, base, meta[http-equiv]').forEach(node => node.remove());
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().replace(/[\u0000-\u0020]/g, '');
      if (name.startsWith('on') || name === 'srcdoc' || ((name === 'href' || name === 'src' || name.endsWith(':href')) && /^(javascript|vbscript):/i.test(value))) element.removeAttribute(attribute.name);
    }
  }
  const policy = document.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', "default-src 'none'; script-src 'none'; img-src blob: data:; style-src 'unsafe-inline' blob:; font-src blob: data:; connect-src 'none'; form-action 'none'; base-uri 'none'");
  document.head?.prepend(policy);
}
