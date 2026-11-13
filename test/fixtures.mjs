import JSZip from 'jszip';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function createFixtures() {
  const directory = fileURLToPath(new URL('../.test-data/fixtures/', import.meta.url));
  await mkdir(directory, { recursive: true });
  const text = '第一章 星海\n' + '夜色落在编辑器的边缘，故事才刚刚开始。\n'.repeat(100) + '\n第二章 远航\n' + '我们驶向下一片星海。\n'.repeat(100);
  await writeFile(directory + 'demo.txt', text);
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">vsread-test</dc:identifier><dc:title>星海来信</dc:title><dc:creator>VSRead</dc:creator><dc:language>zh-CN</dc:language><meta name="cover" content="cover"/></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="style" href="style.css" media-type="text/css"/><item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>');
  zip.file('OPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="one.xhtml">第一章 星海</a></li><li><a href="two.xhtml">第二章 远航</a></li></ol></nav></body></html>');
  zip.file('OPS/style.css', 'h1 { color: rgb(30, 120, 90); } .art { width: 36px; height: 36px; }');
  zip.file('OPS/cover.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'));
  for (const [filename, title] of [['one', '第一章 星海'], ['two', '第二章 远航']]) {
    zip.file(`OPS/${filename}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title><link rel="stylesheet" href="style.css"/><script>window.parent.__epubScriptRan=true;</script></head><body><h1>${title}</h1><img class="art" src="cover.png" alt="星海插图" onerror="window.parent.__epubScriptRan=true"/>${'<p>故事在代码之间悄悄展开。星光照亮了下一行，也照亮了下一页。</p>'.repeat(100)}</body></html>`);
  }
  await writeFile(directory + 'demo.epub', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 10 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 600] /Resources << /Font << /F1 9 0 R >> >> /Contents 4 0 R >>',
    '',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 600] /Resources << /Font << /F1 9 0 R >> >> /Contents 6 0 R >>',
    '',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 600] /Resources << /Font << /F1 9 0 R >> >> /Contents 8 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Outlines /First 11 0 R /Last 11 0 R /Count 1 >>',
    '<< /Title (Chapter Two) /Parent 10 0 R /Dest [5 0 R /Fit] >>',
  ];
  for (let page = 1; page <= 3; page++) {
    const stream = `BT /F1 20 Tf 40 540 Td (VSRead - Page ${page}) Tj 0 -45 Td /F1 12 Tf (Offline reading among the stars. Chapter ${page}.) Tj ET`;
    objects[page * 2 + 1] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  }
  const serializePdf = items => {
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    items.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${items.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    return pdf + `trailer\n<< /Size ${items.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  };
  await writeFile(directory + 'demo.pdf', serializePdf(objects));
  // 未引用的大对象放在 xref 前，验证首屏只需文件头和文件尾，不必传完整文件。
  const padding = 'x'.repeat(4 * 1024 * 1024);
  await writeFile(directory + 'large.pdf', serializePdf([...objects, `<< /Length ${padding.length} >>\nstream\n${padding}\nendstream`]));
  return directory;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await createFixtures();
