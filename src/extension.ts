import * as vscode from "vscode";
import { PptxEditorProvider } from "./editor/PptxEditorProvider";
import { VIEWER_COMMANDS, VIEW_TYPE } from "./shared/protocol";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("PPTX Live Viewer", { log: true });
  const provider = new PptxEditorProvider(context.extensionUri, log);
  const command = (name: string, run: (resource?: unknown) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(`pptxLiveViewer.${name}`, run);

  context.subscriptions.push(
    log,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      // Keeps the rendered slides and the scroll position while the tab is in the background.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    command("reload", (resource) => provider.sessionFor(resource)?.reload()),
    command("openInDefaultApp", (resource) => provider.sessionFor(resource)?.openInDefaultApp()),
    command("goToSlide", () => provider.sessionFor()?.promptGoToSlide()),
    // The remaining commands are carried out inside the webview.
    ...VIEWER_COMMANDS.map((name) => command(name, () => provider.sessionFor()?.runCommand(name))),
  );
}

export function deactivate(): void {}
