const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');

// 每次用独立进程替换 vscode 模块；真实宿主 bundle、文件系统和数据加载逻辑保持原样。
async function main() {
  const scenario = process.argv[2];
  assert(['view', 'command', 'damaged-local', 'damaged-online'].includes(scenario));
  const repository = path.resolve(__dirname, '..', '..');
  const manifest = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'));
  const views = Object.values(manifest.contributes.views).flat();
  const expectedView = views.find(view => view.id.startsWith('vsread.'))?.id;
  assert(expectedView, 'manifest 必须声明阅读入口');
  for (const view of views) assert(manifest.activationEvents.includes(`onView:${view.id}`), `缺少显式视图激活事件 ${view.id}`);
  for (const command of manifest.contributes.commands) assert(manifest.activationEvents.includes(`onCommand:${command.command}`), `缺少显式命令激活事件 ${command.command}`);
  const event = scenario === 'command' ? 'onCommand:vsread.open' : `onView:${expectedView}`;
  // 模拟不合成隐式事件的 IDE，只根据 manifest 中的显式事件进入 activate。
  assert(manifest.activationEvents.includes(event), `冷启动事件没有匹配扩展：${event}`);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vsread-activation-'));
  const storage = path.join(root, 'storage');
  const logs = path.join(root, 'logs');
  const book = { id: 'a'.repeat(64), format: 'pdf', title: '启动回归样书', importedAt: '2026-11-16T00:00:00.000Z', size: 100 };
  const validLibrary = JSON.stringify({ version: 1, books: [book], settings: { theme: 'ide', fontSize: 19, lineHeight: 1.9, fontFamily: 'serif', flow: 'scrolled', zoom: 1 } });
  const damagedLocal = '{ damaged-local-original';
  const damagedOnline = '{ damaged-online-original';
  await fs.mkdir(path.join(storage, 'online'), { recursive: true });
  await fs.writeFile(path.join(storage, 'library.json'), scenario === 'damaged-local' ? damagedLocal : validLibrary);
  if (scenario === 'damaged-local') await fs.writeFile(path.join(storage, 'library.backup.json'), damagedLocal);
  if (scenario === 'damaged-online') {
    await fs.writeFile(path.join(storage, 'online', 'online.json'), damagedOnline);
    await fs.writeFile(path.join(storage, 'online', 'online.backup.json'), damagedOnline);
  }

  const commands = new Map();
  const trees = [];
  const panels = [];
  const output = [];
  const shownDocuments = [];
  const shownErrors = [];
  let filePickers = 0;
  const disposable = () => ({ dispose() {} });
  class Uri {
    constructor(fsPath) { this.fsPath = path.resolve(fsPath); this.scheme = 'file'; }
    static file(fsPath) { return new Uri(fsPath); }
    static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
    static parse(value) { return { scheme: new URL(value).protocol.slice(0, -1), toString: () => value }; }
    toString() { return pathToFileURL(this.fsPath).href; }
  }
  const vscode = {
    Uri, version: '1.85.0', ViewColumn: { Active: -1 }, ProgressLocation: { Notification: 15 },
    TreeItemCollapsibleState: { None: 0 },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    env: { appName: 'CodeBuddy-compatible activation fixture', openExternal: async () => true },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    commands: {
      registerCommand: (id, handler) => {
        assert(!commands.has(id), `命令重复注册：${id}`);
        commands.set(id, handler); return disposable();
      },
      executeCommand: async (id, ...args) => {
        if (id === 'setContext') return;
        assert(commands.has(id), `命令未注册：${id}`);
        return commands.get(id)(...args);
      },
    },
    window: {
      createOutputChannel: () => ({ appendLine: line => output.push(line), show() {}, dispose() {} }),
      createTreeView: (id, options) => { const tree = { id, options, dispose() {} }; trees.push(tree); return tree; },
      createWebviewPanel: (viewType, title, column, options) => {
        const receivers = [], messages = [];
        const panel = {
          viewType, title, column, options, active: true,
          webview: {
            html: '', options: {}, cspSource: 'https://fixture.webview.invalid',
            asWebviewUri: uri => ({ toString: () => `https://fixture.webview.invalid/${encodeURIComponent(uri.fsPath)}` }),
            onDidReceiveMessage: handler => { receivers.push(handler); return disposable(); },
            postMessage: async message => { messages.push(message); return true; },
          },
          onDidChangeViewState: () => disposable(), onDidDispose: () => disposable(), reveal() {}, dispose() {},
          async rpc(method, args) {
            const id = `activation-fixture-${messages.length}-${method}`;
            for (const receive of receivers) await receive({ id, method, args });
            const response = messages.find(message => message.id === id);
            assert(response, `${method} RPC 没有返回`); return response;
          },
        };
        panels.push(panel); return panel;
      },
      registerWebviewPanelSerializer: () => disposable(),
      showTextDocument: async uri => { const text = await fs.readFile(uri.fsPath, 'utf8'); shownDocuments.push({ path: uri.fsPath, text }); return {}; },
      showErrorMessage: async message => { shownErrors.push(message); },
      showWarningMessage: async () => undefined, showInformationMessage: async () => undefined,
      showInputBox: async () => undefined,
      showOpenDialog: async () => { filePickers++; return undefined; },
      withProgress: async (_options, operation) => operation({ report() {} }, { isCancellationRequested: false }),
    },
  };
  const context = {
    subscriptions: [], extensionPath: repository, extensionUri: Uri.file(repository),
    globalStorageUri: Uri.file(storage), logUri: Uri.file(logs), extension: { packageJSON: manifest },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    globalState: { get: (_key, fallback) => fallback, update: async () => {} },
  };
  const originalLoad = Module._load;
  let extension;
  try {
    Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
    extension = require(path.join(repository, 'dist', 'extension.cjs'));
    const activating = extension.activate(context);
    // 无论磁盘加载成功与否，入口与诊断必须在 activate 的首个 await 之前可用。
    assert.equal(trees.length, 1, '数据加载前尚未注册侧栏，冷启动会显示无provider');
    assert(commands.has('vsread.openLogs'), '数据加载前尚未注册日志命令');
    await activating;
    assert.equal(trees[0].id, expectedView);
    const entries = await trees[0].options.treeDataProvider.getChildren();
    assert(entries.some(item => item.command?.command === 'vsread.open'));
    assert(entries.some(item => item.command?.command === 'vsread.openLogs'));
    for (const command of manifest.contributes.commands) assert(commands.has(command.command), `激活后缺少命令 ${command.command}`);

    await vscode.commands.executeCommand('vsread.open');
    assert.equal(panels.length, 1);
    const panel = panels[0];
    assert.equal(panel.viewType, 'vsread.reader');
    assert(panel.webview.html.includes('Content-Security-Policy'));
    assert(panel.webview.html.includes('reader.js'));
    const init = await panel.rpc('init');
    if (scenario === 'damaged-local') {
      assert.equal(typeof init.error, 'string');
      assert.match(init.error, /书库|本地|索引/);
      for (const [method, args] of [
        ['import', undefined], ['open', { id: book.id }], ['settings', { fontSize: 25 }],
        ['text', { id: book.id, part: 0 }], ['binary', { id: book.id, offset: 0 }],
        ['metadata', { id: book.id, title: '不应写入的标题' }], ['encoding', { id: book.id, encoding: 'utf-8' }], ['remove', { id: book.id }],
        ['progress', { id: book.id, progress: { position: { format: 'pdf', page: 1, scroll: 0 }, percentage: .5 } }],
      ]) {
        const response = await panel.rpc(method, args);
        assert.equal(response.error, init.error, `${method} 应被相同的本地书库保护拦住`);
      }
      await vscode.commands.executeCommand('vsread.import');
      assert.equal(filePickers, 0, '本地索引损坏时不应弹出可覆盖数据的导入选择器');
      assert(shownErrors.some(message => /书库|本地|索引/.test(message)));
      assert.equal(await fs.readFile(path.join(storage, 'library.json'), 'utf8'), damagedLocal);
      assert.equal(await fs.readFile(path.join(storage, 'library.backup.json'), 'utf8'), damagedLocal);
    } else {
      assert.equal(init.error, undefined);
      assert.equal(init.result.books[0].id, book.id);
      if (scenario === 'damaged-online') {
        const online = await panel.rpc('online.list');
        assert.match(online.error, /在线书库/);
        assert.equal(await fs.readFile(path.join(storage, 'online', 'online.json'), 'utf8'), damagedOnline);
        assert.equal(await fs.readFile(path.join(storage, 'online', 'online.backup.json'), 'utf8'), damagedOnline);
      } else assert.deepEqual((await panel.rpc('online.list')).result, []);
    }
    await vscode.commands.executeCommand('vsread.openLogs');
    assert(shownDocuments.some(document => document.path === path.join(logs, 'vsread.log')));
    const events = shownDocuments.flatMap(document => document.text.trim().split('\n').map(line => JSON.parse(line).event));
    assert(events.includes('sidebar.registered'));
    assert(events.includes('extension.ready'));
    console.log(JSON.stringify({ scenario, event, view: expectedView, registeredCommands: commands.size, html: true, localBlocked: scenario === 'damaged-local', onlineIsolated: scenario === 'damaged-online' }));
  } finally {
    try { if (extension) await extension.deactivate(); }
    finally {
      Module._load = originalLoad;
      for (const item of context.subscriptions.reverse()) item.dispose?.();
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert(path.basename(root).startsWith('vsread-activation-'));
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
    }
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
