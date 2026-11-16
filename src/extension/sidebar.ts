import * as vscode from 'vscode';

/** 使用原生侧栏提供稳定入口，阅读引擎仍按需在编辑器 Webview 中加载。 */
export function registerSidebar(context: vscode.ExtensionContext): void {
  const action = (label: string, command: string, icon: string, tooltip: string): vscode.TreeItem => {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.command = { title: label, command };
    item.iconPath = new vscode.ThemeIcon(icon);
    item.tooltip = tooltip;
    return item;
  };
  const entries = [
    action('打开阅读器', 'vsread.open', 'book', '打开书架，继续上次阅读'),
    action('导入本地电子书', 'vsread.import', 'add', '导入本地 EPUB、TXT 或 PDF'),
    action('在线书源', 'vsread.sources', 'globe', '管理书源、搜索与阅读在线书籍'),
    action('检查更新', 'vsread.checkUpdates', 'versions', '检查 GitHub 上的最新稳定版本'),
    action('打开诊断日志', 'vsread.openLogs', 'output', '查看本地书源请求和错误日志'),
  ];
  const provider: vscode.TreeDataProvider<vscode.TreeItem> = {
    getTreeItem: item => item,
    getChildren: item => item ? [] : entries,
  };
  // 独立入口 ID 避免旧版 IDE 占位图标仍指向 0.1.3 的缓存资源。
  const view = vscode.window.createTreeView('vsread.library.launcher', { treeDataProvider: provider, showCollapseAll: false });
  view.message = '青菜阅读 · EPUB / TXT / PDF';
  context.subscriptions.push(view);
}
