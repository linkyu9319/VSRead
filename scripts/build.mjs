import { build, context } from 'esbuild';
import { build as viteBuild } from 'vite';
import { cp, mkdir } from 'node:fs/promises';
import './licenses.mjs';

const options = {
  entryPoints: { extension: 'src/extension/extension.ts', txtWorker: 'src/extension/txtWorker.ts' },
  bundle: true, platform: 'node', target: 'node18', format: 'cjs', outdir: 'dist',
  outExtension: { '.js': '.cjs' }, external: ['vscode'], sourcemap: true,
};
if (process.argv.includes('--watch')) {
  const host = await context(options);
  await host.watch();
  await viteBuild({ build: { watch: {} } });
} else {
  await build(options);
  await viteBuild();
}
// PDF 的字体、CMap 与 WASM 全部随插件分发，离线机器也能正常排版。
for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await mkdir('dist/webview/pdf/' + directory, { recursive: true });
  await cp('node_modules/pdfjs-dist/' + directory, 'dist/webview/pdf/' + directory, { recursive: true });
}
