import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { logger } from './logger';

/**
 * The HTML shell every svsch webview panel serves — the same built bundle
 * (media/webview.js) backs both the main diagram panel and the partial
 * diagram panel; which one a document *is* only shows in the messages its
 * host posts (see the `partial` flag on the `graph` message).
 */
export function diagramWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  title: string,
): string {
  const scriptUri = webviewMediaUri(context, webview, 'webview.js');
  const styleUri = webviewMediaUri(context, webview, 'webview.css');
  logger.log(`Webview URIs: script=${scriptUri.toString()}, style=${styleUri.toString()}`);
  const nonce = String(Date.now());
  const csp =
    `default-src 'none'; connect-src ${webview.cspSource} https:; ` +
    `font-src ${webview.cspSource}; img-src ${webview.cspSource} data:; ` +
    `style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `script-src 'nonce-${nonce}' ${webview.cspSource};`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>${title}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}

function webviewMediaUri(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  fileName: string,
): vscode.Uri {
  const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media', fileName);
  let version = 'dev';
  try {
    version = String(Math.round(fs.statSync(mediaUri.fsPath).mtimeMs)) + '-' + String(Date.now());
  } catch {
    // Keep serving the stable URI if the asset is missing; the webview will
    // surface the load failure and the caller can rebuild media.
  }
  return webview.asWebviewUri(mediaUri).with({ query: `v=${version}` });
}
