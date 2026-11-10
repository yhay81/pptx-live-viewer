import * as vscode from "vscode";
import { isSameResource } from "./resource";
import { ViewerSession } from "./ViewerSession";

interface PptxDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
}

/**
 * Read-only custom editor for presentation files. The file is never modified, so the document
 * is only a handle to its URI; each editor tab reads the file itself and reloads on its own.
 */
export class PptxEditorProvider implements vscode.CustomReadonlyEditorProvider<PptxDocument> {
  private readonly sessions = new Set<ViewerSession>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  openCustomDocument(uri: vscode.Uri): PptxDocument {
    return { uri, dispose: () => {} };
  }

  resolveCustomEditor(document: PptxDocument, panel: vscode.WebviewPanel): void {
    const session = new ViewerSession(document.uri, panel, this.extensionUri, this.log);
    this.sessions.add(session);
    panel.onDidDispose(() => {
      this.sessions.delete(session);
      session.dispose();
    });
  }

  /**
   * The viewer a command applies to. A command run from an editor title bar passes that editor's
   * file, which need not belong to the focused editor group.
   */
  sessionFor(resource?: unknown): ViewerSession | undefined {
    const sessions = [...this.sessions];
    const candidates =
      resource instanceof vscode.Uri ? sessions.filter((session) => isSameResource(session.uri, resource)) : sessions;
    return (
      candidates.find((session) => session.panel.active) ??
      (resource instanceof vscode.Uri ? candidates.find((session) => session.panel.visible) : undefined)
    );
  }
}
