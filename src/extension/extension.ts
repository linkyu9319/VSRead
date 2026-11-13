import * as vscode from 'vscode';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { LibraryStore } from './store';
import { BookLibrary } from './library';
import { renderWebview } from './webview';
import { registerSidebar } from './sidebar';
import { isRecord, normalizeSettings, validateProgress } from '../shared/validation';
import type { OpenBook, RpcRequest, TextEncoding } from '../shared/model';

let store: LibraryStore | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const libraryStore = new LibraryStore(context.globalStorageUri.fsPath);
  await libraryStore.load();
  store = libraryStore;
  const library = new BookLibrary(libraryStore, path.join(context.extensionPath, 'dist', 'txtWorker.cjs'));
  let panel: vscode.WebviewPanel | undefined;
  let importing = false;

  const openBook = async (id: unknown): Promise<OpenBook> => {
    const book = library.book(id);
    libraryStore.data.lastBookId = book.id;
    await libraryStore.save();
    return { book, ...(book.format === 'txt' ? { textIndex: await library.textIndex(book) } : {}) };
  };

  const importBooks = async (resource?: vscode.Uri) => {
    if (importing) throw new Error('正在导入，请稍候');
    // 资源管理器会传 URI；侧栏标题菜单可能传视图上下文，应走文件选择器。
    const selected = resource instanceof vscode.Uri ? [resource] : await vscode.window.showOpenDialog({
      canSelectMany: true, openLabel: '导入到 VSRead',
      filters: { '电子书': ['epub', 'txt', 'pdf'] },
    });
    if (!selected?.length) return;
    importing = true;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'VSRead · 正在导入本地书籍' }, async progress => {
        const failures: string[] = [];
        for (const uri of selected) {
          try {
            if (uri.scheme !== 'file') throw new Error('目前仅支持本地文件');
            progress.report({ message: path.basename(uri.fsPath), increment: 100 / selected.length });
            const book = await library.importFile(uri.fsPath);
            libraryStore.data.lastBookId = book.id;
          } catch (error) { failures.push(`${path.basename(uri.fsPath)}：${errorMessage(error)}`); }
        }
        await libraryStore.save();
        if (failures.length) void vscode.window.showErrorMessage(failures.join('\n'));
      });
    } finally { importing = false; }
  };

  const configure = async (target: vscode.WebviewPanel) => {
    panel = target;
    target.webview.options = {
      enableScripts: true,
      // 书籍通过 Host 消息读取，避免各 IDE 对 storage URI scheme 的授权差异。
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    };
    target.onDidDispose(() => { if (panel === target) panel = undefined; }, null, context.subscriptions);
    // 所有 Webview 输入均视为不可信：只接受已导入书籍的 ID，从不接收文件路径。
    target.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isRecord(message) || typeof message.id !== 'string' || message.id.length > 100 || typeof message.method !== 'string') return;
      const request = message as unknown as RpcRequest;
      try {
        const args = isRecord(request.args) ? request.args : {};
        let result: unknown;
        switch (request.method) {
          case 'init': result = libraryStore.data; break;
          case 'import': await importBooks(); result = libraryStore.data; break;
          case 'open': result = await openBook(args.id); break;
          case 'text': result = await library.text(library.book(args.id), args.part); break;
          case 'binary': result = await library.binary(library.book(args.id), args.offset); break;
          case 'progress': {
            const book = library.book(args.id);
            book.progress = validateProgress(args.progress, book.format);
            await libraryStore.save();
            break;
          }
          case 'settings': libraryStore.data.settings = normalizeSettings(request.args); await libraryStore.save(); break;
          case 'metadata': {
            const book = library.book(args.id);
            if (typeof args.title === 'string' && args.title.trim()) book.title = args.title.trim().slice(0, 300);
            if (typeof args.author === 'string') book.author = args.author.trim().slice(0, 300);
            if (typeof args.cover === 'string' && args.cover.length < 2_000_000 && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(args.cover)) book.cover = args.cover;
            await libraryStore.save();
            break;
          }
          case 'encoding': {
            const book = library.book(args.id);
            if (book.format !== 'txt' || typeof args.encoding !== 'string') throw new Error('编码选择无效');
            await library.prepareText(book, args.encoding as TextEncoding);
            book.progress = undefined;
            await libraryStore.save();
            result = await openBook(book.id);
            break;
          }
          case 'remove': {
            const book = library.book(args.id);
            const answer = await vscode.window.showWarningMessage(`从书架移除《${book.title}》及其阅读进度？原文件会保留。`, { modal: true }, '移除');
            if (answer === '移除') {
              libraryStore.data.books = libraryStore.data.books.filter(item => item.id !== book.id);
              if (libraryStore.data.lastBookId === book.id) libraryStore.data.lastBookId = undefined;
              await libraryStore.save();
              await rm(library.directory(book), { recursive: true, force: true });
            }
            result = libraryStore.data;
            break;
          }
          default: throw new Error('不支持的阅读器请求');
        }
        await target.webview.postMessage({ id: request.id, result });
      } catch (error) { await target.webview.postMessage({ id: request.id, error: errorMessage(error) }); }
    }, null, context.subscriptions);
    target.webview.html = await renderWebview(target.webview, context.extensionUri);
  };

  const show = async () => {
    if (panel) { panel.reveal(vscode.ViewColumn.Active); return panel; }
    const target = vscode.window.createWebviewPanel('vsread.reader', 'VSRead', vscode.ViewColumn.Active, { enableScripts: true });
    await configure(target);
    return target;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vsread.open', show),
    vscode.commands.registerCommand('vsread.import', async (resource?: vscode.Uri) => {
      try {
        await importBooks(resource);
        const target = await show();
        await target.webview.postMessage({ event: 'library', library: libraryStore.data });
      } catch (error) { void vscode.window.showErrorMessage(errorMessage(error)); }
    }),
    vscode.window.registerWebviewPanelSerializer('vsread.reader', { deserializeWebviewPanel: async target => { await configure(target); } }),
  );
  registerSidebar(context);
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export async function deactivate(): Promise<void> { await store?.flush(); }
