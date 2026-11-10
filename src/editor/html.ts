import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { WebviewInit } from "../shared/protocol";

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The webview document: an empty shell that the bundled script fills in.
 *
 * The content security policy allows no network access at all. A presentation is untrusted
 * input, and everything the renderer draws comes from the file itself: images, media and fonts
 * as `blob:` or `data:` URLs, and inline styles on the elements it creates. Scripts run only
 * from the bundled file, identified by a nonce.
 */
export function buildViewerHtml(webview: vscode.Webview, extensionUri: vscode.Uri, init: WebviewInit): string {
  const nonce = randomBytes(18).toString("base64");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", "main.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "viewer.css"));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} blob: data:`,
    "media-src blob: data:",
    "font-src blob: data:",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");
  // "<" is escaped so that text from the file name cannot close the script element.
  const initJson = JSON.stringify(init).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(init.fileName)}</title>
<link rel="stylesheet" href="${escapeHtml(String(styleUri))}">
</head>
<body>
<div id="app"></div>
<script type="application/json" id="init">${initJson}</script>
<script nonce="${nonce}" src="${escapeHtml(String(scriptUri))}"></script>
</body>
</html>`;
}
