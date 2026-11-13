import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const collected = new Map();
const licenseName = /^(?:licen[sc]e|copying|notice|copyright)(?:[._-].*)?$/i;

async function resolvePackage(name, from) {
  let directory = from;
  while (true) {
    const candidate = path.join(directory, 'node_modules', name);
    try { return { directory: candidate, data: JSON.parse(await readFile(path.join(candidate, 'package.json'), 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function collect(name, from, optional = false) {
  const resolved = await resolvePackage(name, from);
  if (!resolved) {
    if (optional) return;
    throw new Error(`缺少生产依赖：${name}，请先执行 npm ci`);
  }
  const { directory, data } = resolved;
  if (collected.has(directory)) return;
  collected.set(directory, { data, texts: [] });
  const files = await readdir(directory, { withFileTypes: true });
  const texts = collected.get(directory).texts;
  for (const file of files) {
    if (file.isFile() && licenseName.test(file.name)) texts.push({ filename: file.name, text: await readFile(path.join(directory, file.name), 'utf8') });
  }
  if (!texts.length && name === 'isarray') {
    const readme = await readFile(path.join(directory, 'README.md'), 'utf8');
    texts.push({ filename: 'README.md (License section)', text: readme.slice(readme.indexOf('## License')) });
  }
  if (!texts.length && name.startsWith('@napi-rs/canvas-')) {
    const canvas = await resolvePackage('@napi-rs/canvas', root);
    texts.push({ filename: '@napi-rs/canvas/LICENSE (same upstream project)', text: await readFile(path.join(canvas.directory, 'LICENSE'), 'utf8') });
  }
  if (name === 'path-webpack') texts.push({
    filename: 'Node.js v7.0.0 path implementation license (upstream provenance in README.md)',
    text: await readFile(path.join(root, 'media', 'licenses', 'upstream', 'path-webpack-node-LICENSE.txt'), 'utf8'),
  });
  // PDF 运行时资源有各自的原始许可，不能只附 JavaScript 库的 Apache 文本。
  if (name === 'pdfjs-dist') {
    for (const resource of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
      for (const file of await readdir(path.join(directory, resource), { withFileTypes: true })) {
        if (file.isFile() && licenseName.test(file.name)) texts.push({ filename: resource + '/' + file.name, text: await readFile(path.join(directory, resource, file.name), 'utf8') });
      }
    }
  }
  const optionalDependencies = data.optionalDependencies ?? {};
  for (const dependency of Object.keys(data.dependencies ?? {})) await collect(dependency, directory, dependency in optionalDependencies);
  for (const dependency of Object.keys(optionalDependencies)) await collect(dependency, directory, true);
}

for (const dependency of Object.keys(packageJson.dependencies)) await collect(dependency, root);
const entries = [...collected.values()].sort((a, b) => a.data.name.localeCompare(b.data.name) || a.data.version.localeCompare(b.data.version));
const metadataOnly = new Set(['marks-pane', '@types/localforage']);
const missing = entries.filter(entry => !entry.texts.length && !metadataOnly.has(entry.data.name));
if (missing.length) throw new Error(`以下生产依赖缺少原始许可文本：${missing.map(entry => entry.data.name).join(', ')}`);
const sections = entries.map(({ data, texts }) => {
  const license = typeof data.license === 'string' ? data.license : JSON.stringify(data.license ?? data.licenses ?? 'not specified');
  const header = `${data.name} @ ${data.version}\nDeclared license: ${license}\n`;
  return header + (texts.length ? texts.map(file => `\n--- ${file.filename} ---\n${file.text.trim()}\n`).join('') : `\nUpstream npm archive and repository do not include a separate license file.\nLicense declaration preserved from package.json:\n${JSON.stringify({ name: data.name, version: data.version, author: data.author, license: data.license, repository: data.repository }, null, 2)}\n`);
});
const output = path.join(root, 'media', 'licenses');
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'THIRD_PARTY_LICENSES.txt'), 'VSRead Third-Party License Notices\n\nInstalled production dependency graph (including optional installed dependencies).\nOriginal license texts follow.\n\n' + sections.join('\n' + '='.repeat(80) + '\n\n'), 'utf8');
console.log(`已收集 ${entries.length} 个生产依赖的许可声明。`);
