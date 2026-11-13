import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

export async function renderWebview(webview: vscode.Webview, extensionUri: vscode.Uri): Promise<string> {
  const root = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  let html = await readFile(vscode.Uri.joinPath(root, 'index.html').fsPath, 'utf8');
  const nonce = randomBytes(24).toString('base64');
  const csp = [
    "default-src 'none'", `img-src ${webview.cspSource} blob: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline' blob:`, `font-src ${webview.cspSource} blob: data:`,
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${webview.cspSource}`, `worker-src ${webview.cspSource} blob:`,
    `connect-src ${webview.cspSource} blob: data:`, "frame-src 'self' blob:",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  ].join('; ');
  html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
  html = html.replace(/(src|href)="\.\/([^"]+)"/g, (_match, attribute, resource) => `${attribute}="${webview.asWebviewUri(vscode.Uri.joinPath(root, resource))}"`);
  return html.replace(/<script /g, `<script nonce="${nonce}" `);
}
