import * as vscode from 'vscode';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { LibraryStore } from './store';
import { BookLibrary } from './library';
import { renderWebview } from './webview';
import { registerSidebar } from './sidebar';
import { OnlineLibrary } from './online/library';
import { AggregateSearchManager } from './online/aggregateSearch';
import { UpdateService } from './updates';
import { isRecord, normalizeSettings, validateProgress } from '../shared/validation';
import type { OpenBook, RpcRequest, TextEncoding } from '../shared/model';
import type { OnlineSearchResult } from '../shared/online';
import { DiagnosticLog, diagnosticError } from './diagnostics';

let store: LibraryStore | undefined;
let onlineStore: OnlineLibrary | undefined;
let diagnostics: DiagnosticLog | undefined;
const searchSessions = new Set<() => void>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('VSRead');
  context.subscriptions.push(output);
  const log = diagnostics = new DiagnosticLog(context.logUri?.fsPath ?? path.join(context.globalStorageUri.fsPath, 'logs'), { output: line => output.appendLine(line) });
  log.write('info', 'extension.activate', { version: context.extension.packageJSON.version, ide: vscode.env.appName, ideVersion: vscode.version, node: process.versions.node, transport: 'node-http', proxyConfigured: !!vscode.workspace.getConfiguration('http').get('proxy') });
  const openLogs = async () => {
    await log.flush();
    try { await vscode.window.showTextDocument(vscode.Uri.file(log.filePath), { preview: true }); }
    catch (error) { output.show(); log.write('error', 'diagnostics.open_failed', diagnosticError(error)); }
  };
  // 先提供原生入口，书库初始化失败时仍能打开日志排查。
  registerSidebar(context);
  context.subscriptions.push(vscode.commands.registerCommand('vsread.openLogs', openLogs));
  log.write('info', 'sidebar.registered', { viewId: 'vsread.library.launcher' });
  const libraryStore = new LibraryStore(context.globalStorageUri.fsPath);
  let libraryError: string | undefined;
  try { await libraryStore.load(); store = libraryStore; }
  catch (error) { libraryError = `本地书库暂不可用：${errorMessage(error)}`; log.write('error', 'library.load_failed', diagnosticError(error)); }
  const requireLibrary = () => { if (libraryError) throw new Error(libraryError); };
  const localMethods = new Set(['init', 'import', 'open', 'text', 'binary', 'progress', 'settings', 'metadata', 'encoding', 'remove']);
  const library = new BookLibrary(libraryStore, path.join(context.extensionPath, 'dist', 'txtWorker.cjs'));
  const online = new OnlineLibrary(path.join(context.globalStorageUri.fsPath, 'online'), { log: log.write });
  let onlineError: string | undefined;
  try { await online.load(); onlineStore = online; }
  catch (error) { onlineError = `在线书库暂不可用：${errorMessage(error)}`; log.write('error', 'online.load_failed', diagnosticError(error)); }
  const updates = new UpdateService(context, { log: log.write });
  let panel: vscode.WebviewPanel | undefined;
  let importing = false;
  let requestedView: 'online' | undefined;
  let requestedFocus: boolean | undefined;
  let focusMode = false;
  const setPanelFocus = (target: vscode.WebviewPanel, enabled: boolean) => {
    focusMode = enabled;
    target.title = enabled ? 'notes.txt' : 'VSRead · 青菜阅读';
    target.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', enabled ? 'file.svg' : 'vegetable.svg');
  };

  const openBook = async (id: unknown): Promise<OpenBook> => {
    requireLibrary();
    const book = library.book(id);
    libraryStore.data.lastBookId = book.id;
    await libraryStore.save();
    return { book, ...(book.format === 'txt' ? { textIndex: await library.textIndex(book) } : {}) };
  };

  const importBooks = async (resource?: vscode.Uri): Promise<string | undefined> => {
    requireLibrary();
    if (importing) throw new Error('正在导入，请稍候');
    // 资源管理器会传 URI；侧栏标题菜单可能传视图上下文，应走文件选择器。
    const selected = resource instanceof vscode.Uri ? [resource] : await vscode.window.showOpenDialog({
      canSelectMany: true, openLabel: '导入到 VSRead',
      filters: { '电子书': ['epub', 'txt', 'pdf'] },
    });
    if (!selected?.length) return undefined;
    importing = true;
    let importedBookId: string | undefined;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'VSRead · 正在导入本地书籍' }, async progress => {
        const failures: string[] = [];
        for (const uri of selected) {
          try {
            if (uri.scheme !== 'file') throw new Error('目前仅支持本地文件');
            progress.report({ message: path.basename(uri.fsPath), increment: 100 / selected.length });
            const book = await library.importFile(uri.fsPath);
            libraryStore.data.lastBookId = book.id;
            importedBookId = book.id;
          } catch (error) { failures.push(`${path.basename(uri.fsPath)}：${errorMessage(error)}`); }
        }
        if (importedBookId) await libraryStore.save();
        if (failures.length) void vscode.window.showErrorMessage(failures.join('\n'));
      });
      return importedBookId;
    } finally { importing = false; }
  };

  const configure = async (target: vscode.WebviewPanel) => {
    if (panel && panel !== target) panel.dispose();
    panel = target;
    let disposed = false;
    const panelDisposables: vscode.Disposable[] = [];
    const post = (payload: unknown) => {
      if (disposed) return Promise.resolve(false);
      return Promise.resolve(target.webview.postMessage(payload)).catch(() => false);
    };
    const searches = new AggregateSearchManager(online);
    let singleSearch: AbortController | undefined;
    const stopSearches = () => { searches.cancelAll(); singleSearch?.abort(); };
    searchSessions.add(stopSearches);
    setPanelFocus(target, false);
    target.webview.options = {
      enableScripts: true,
      // 书籍通过 Host 消息读取，避免各 IDE 对 storage URI scheme 的授权差异。
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
    };
    void vscode.commands.executeCommand('setContext', 'vsread.readerActive', target.active);
    panelDisposables.push(
      target.onDidChangeViewState(event => { void vscode.commands.executeCommand('setContext', 'vsread.readerActive', event.webviewPanel.active); }),
      target.onDidDispose(() => {
        disposed = true;
        stopSearches(); searchSessions.delete(stopSearches);
        if (panel === target) { panel = undefined; void vscode.commands.executeCommand('setContext', 'vsread.readerActive', false); }
        for (const disposable of panelDisposables.splice(0)) disposable.dispose();
      }),
    );
    // 所有 Webview 输入均视为不可信：只接受已导入书籍的 ID，从不接收文件路径。
    panelDisposables.push(target.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isRecord(message) || typeof message.id !== 'string' || message.id.length > 100 || typeof message.method !== 'string') return;
      const request = message as unknown as RpcRequest;
      const started = Date.now();
      const traced = /^(online\.(search|searchAll\.(start|cancel)|add|open|chapter|cache|cacheAll\.(start|cancel))|sources\.(import|builtin\.add)|updates\.(install|reload))$/.test(request.method);
      if (traced) log.write('info', 'rpc.start', { method: request.method, requestId: request.id });
      try {
        const args = isRecord(request.args) ? request.args : {};
        // 加载失败时禁止用默认空书库覆盖原始文件。
        if (localMethods.has(request.method)) requireLibrary();
        // 在线数据损坏只影响在线功能，本地文件阅读仍可正常使用。
        if (onlineError && (request.method.startsWith('sources.') || request.method.startsWith('online.'))) throw new Error(onlineError);
        let result: unknown;
        switch (request.method) {
          case 'init': result = { ...libraryStore.data, initialView: requestedView, initialFocus: requestedFocus }; requestedView = undefined; requestedFocus = undefined; break;
          case 'focus': {
            if (typeof args.enabled !== 'boolean') throw new Error('专注模式参数无效');
            setPanelFocus(target, args.enabled);
            break;
          }
          case 'diagnostics.open': await openLogs(); break;
          case 'import': { const importedBookId = await importBooks(); result = { ...libraryStore.data, ...(importedBookId ? { importedBookId } : {}) }; break; }
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
              library.evictTextIndex(book.id);
              await libraryStore.save();
              await rm(library.directory(book), { recursive: true, force: true });
            }
            result = libraryStore.data;
            break;
          }
          case 'sources.list': result = online.listSources(); break;
          case 'sources.builtin.list': result = online.listBuiltinSources(); break;
          case 'sources.builtin.add': result = await online.addBuiltinSource(requiredString(args.id)); break;
          case 'sources.import': result = await online.importSources({ json: optionalString(args.json), url: optionalString(args.url) }); break;
          case 'sources.toggle': result = await online.toggleSource(requiredString(args.id), args.enabled === true); break;
          case 'sources.remove': result = await online.removeSource(requiredString(args.id)); break;
          case 'online.list': result = online.listBooks(); break;
          case 'online.search': {
            searches.cancelAll(); singleSearch?.abort();
            const controller = singleSearch = new AbortController();
            try { result = await online.search(requiredString(args.sourceId), requiredString(args.query), args.page as number, controller.signal); }
            finally { if (singleSearch === controller) singleSearch = undefined; }
            break;
          }
          case 'online.searchAll.start': {
            if (!Array.isArray(args.sourceIds) || !args.sourceIds.every(id => typeof id === 'string')) throw new Error('请选择有效的搜索书源');
            const job = searches.start(requiredString(args.query), args.sourceIds as string[]);
            singleSearch?.abort();
            result = job;
            break;
          }
          case 'online.searchAll.status': result = searches.status(requiredString(args.id)); break;
          case 'online.searchAll.cancel': result = searches.cancel(requiredString(args.id)); break;
          case 'online.add': {
            if (!isRecord(args.result)) throw new Error('书籍信息无效');
            result = await online.add(args.result as unknown as OnlineSearchResult);
            break;
          }
          case 'online.open': result = await online.open(requiredString(args.id), args.refresh === true); break;
          case 'online.chapter': result = await online.chapter(requiredString(args.id), args.chapter as number, args.refresh === true); break;
          case 'online.progress': await online.saveProgress(requiredString(args.id), args.chapter as number, args.scroll as number); break;
          case 'online.cache': result = await online.cacheChapters(requiredString(args.id), args.from as number, args.count as number); break;
          case 'online.cacheAll.start': result = await online.startCacheAll(requiredString(args.id)); break;
          case 'online.cacheAll.status': result = online.cacheAllStatus(requiredString(args.id)); break;
          case 'online.cacheAll.cancel': result = online.cancelCacheAll(requiredString(args.id)); break;
          case 'online.clearCache': result = await online.clearCache(requiredString(args.id)); break;
          case 'online.remove': result = await online.removeBook(requiredString(args.id)); break;
          case 'updates.check': result = await updates.check(); break;
          case 'updates.install': result = await updates.install(); break;
          case 'updates.reload': await Promise.all([store?.flush(), onlineStore?.flush(), log.flush()]); await updates.reload(); break;
          case 'updates.open': await updates.open(); break;
          case 'updates.auth': {
            if (args.action !== 'set' && args.action !== 'clear') throw new Error('令牌操作无效');
            await updates.auth(args.action);
            break;
          }
          default: throw new Error('不支持的阅读器请求');
        }
        if (traced) log.write('info', 'rpc.complete', { method: request.method, requestId: request.id, elapsedMs: Date.now() - started });
        await post({ id: request.id, result });
      } catch (error) {
        log.write('error', 'rpc.failed', { method: request.method, requestId: request.id, elapsedMs: Date.now() - started, ...diagnosticError(error) });
        await post({ id: request.id, error: errorMessage(error) });
      }
    }));
    target.webview.html = await renderWebview(target.webview, context.extensionUri);
  };

  const show = async () => {
    if (panel) { panel.reveal(vscode.ViewColumn.Active); return panel; }
    const target = vscode.window.createWebviewPanel('vsread.reader', 'VSRead · 青菜阅读', vscode.ViewColumn.Active, { enableScripts: true });
    await configure(target);
    return target;
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('vsread.open', async () => { requestedView = undefined; await show(); }),
    vscode.commands.registerCommand('vsread.toggleFocusMode', async () => {
      if (panel) await panel.webview.postMessage({ event: 'focus', enabled: !focusMode });
      else { requestedFocus = true; setPanelFocus(await show(), true); }
    }),
    vscode.commands.registerCommand('vsread.sources', async () => {
      requestedView = 'online';
      const target = await show();
      await target.webview.postMessage({ event: 'navigate', view: 'online' });
    }),
    vscode.commands.registerCommand('vsread.checkUpdates', async () => {
      try {
        const status = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'VSRead · 检查更新' }, () => updates.check());
        const action = status.state === 'available' ? await vscode.window.showInformationMessage(status.message, '一键更新', '查看发布页') : await vscode.window.showInformationMessage(status.message);
        if (action === '一键更新') {
          const installed = await updates.install();
          const next = installed.state === 'installed' ? await vscode.window.showInformationMessage(installed.message, '重载窗口') : await vscode.window.showInformationMessage(installed.message);
          if (next === '重载窗口') { await Promise.all([store?.flush(), onlineStore?.flush(), log.flush()]); await updates.reload(); }
        } else if (action === '查看发布页') await updates.open();
      } catch (error) { void vscode.window.showErrorMessage(errorMessage(error)); }
    }),
    vscode.commands.registerCommand('vsread.configureUpdateToken', () => updates.auth('set')),
    vscode.commands.registerCommand('vsread.clearUpdateToken', () => updates.auth('clear')),
    vscode.commands.registerCommand('vsread.import', async (resource?: vscode.Uri) => {
      try {
        const importedBookId = await importBooks(resource);
        if (!importedBookId) return;
        const target = await show();
        await target.webview.postMessage({ event: 'library', library: libraryStore.data, openBookId: importedBookId });
      } catch (error) { void vscode.window.showErrorMessage(errorMessage(error)); }
    }),
    vscode.window.registerWebviewPanelSerializer('vsread.reader', { deserializeWebviewPanel: async target => { await configure(target); } }),
  );
  log.write('info', 'extension.ready', { localLibrary: !libraryError, onlineLibrary: !onlineError });
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function requiredString(value: unknown): string { if (typeof value !== 'string' || !value.trim()) throw new Error('请求参数无效'); return value; }
function optionalString(value: unknown): string | undefined { if (value === undefined) return undefined; return requiredString(value); }
export async function deactivate(): Promise<void> {
  for (const stopSearches of searchSessions) stopSearches();
  searchSessions.clear();
  onlineStore?.cancelAllCacheJobs();
  await Promise.all([store?.flush(), onlineStore?.flush()]);
  await diagnostics?.flush();
}
