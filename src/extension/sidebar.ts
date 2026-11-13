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
  ];
  const provider: vscode.TreeDataProvider<vscode.TreeItem> = {
    getTreeItem: item => item,
    getChildren: item => item ? [] : entries,
  };
  const view = vscode.window.createTreeView('vsread.launcher', { treeDataProvider: provider, showCollapseAll: false });
  view.message = '你的本地阅读空间 · EPUB / TXT / PDF';
  context.subscriptions.push(view);
}
