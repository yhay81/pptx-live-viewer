import * as vscode from "vscode";
import {
  CONFIG_SECTION,
  type HostMessage,
  type LoadReason,
  type ViewerCommand,
  type ViewerSettings,
  isSafeExternalUrl,
  parseWebviewMessage,
} from "../shared/protocol";
import { buildViewerHtml } from "./html";
import { ReloadScheduler } from "./reload";
import { baseName, isSameResource, toArrayBuffer } from "./resource";
import { viewerStrings } from "./strings";

/** Larger files are refused: they would be copied several times on their way into the webview. */
const MAX_FILE_BYTES = 1024 ** 3;

function readSettings(resource: vscode.Uri): ViewerSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
  const zoom = config.get<string>("defaultZoom", "fit");
  const notes = config.get<string>("notes", "auto");
  return {
    zoom: zoom === "width" ? "width" : zoom === "actual" ? 100 : "fit",
    thumbnails: config.get<boolean>("thumbnails", true),
    notes: notes === "show" || notes === "hide" ? notes : "auto",
  };
}

function describeError(error: unknown): string {
  if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
    return vscode.l10n.t("The file no longer exists.");
  }
  return error instanceof Error ? error.message : String(error);
}

/** One open viewer tab: its webview, the file it shows, and the watcher that keeps it current. */
export class ViewerSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly reloads: ReloadScheduler;
  private readonly name: string;
  private requestId = 0;
  private changedWhileHidden = false;
  private disposed = false;
  private slide = 1;
  private slideCount = 0;

  constructor(
    readonly uri: vscode.Uri,
    readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.name = baseName(uri);
    this.reloads = new ReloadScheduler({
      debounceMs: 250,
      retryDelaysMs: [400, 1000, 2500],
      run: (final) => void this.load("change", final),
    });

    const { webview } = panel;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist"), vscode.Uri.joinPath(extensionUri, "media")],
    };
    this.disposables.push(
      webview.onDidReceiveMessage((message: unknown) => this.onMessage(message)),
      panel.onDidChangeViewState(() => this.onViewStateChanged()),
      this.watchFile(),
    );
    // Set last: the script posts "ready" as soon as it runs, and the listener must already exist.
    webview.html = buildViewerHtml(webview, extensionUri, {
      fileName: this.name,
      settings: readSettings(uri),
      strings: viewerStrings(),
    });
  }

  dispose(): void {
    this.disposed = true;
    this.reloads.cancel();
    vscode.Disposable.from(...this.disposables).dispose();
  }

  runCommand(command: ViewerCommand): void {
    void this.post({ type: "command", command });
  }

  /** Re-reads the file now, as the Reload command does. */
  reload(): void {
    this.reloads.cancel();
    void this.load("manual", true);
  }

  async openInDefaultApp(): Promise<void> {
    if (this.uri.scheme !== "file" || vscode.env.remoteName !== undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Only files on this computer can be opened in the default app."),
      );
      return;
    }
    const opened = await vscode.env.openExternal(this.uri);
    if (!opened) this.log.warn(`${this.name}: the operating system did not open the file`);
  }

  async promptGoToSlide(): Promise<void> {
    const count = this.slideCount;
    if (count === 0) return;
    const hint = vscode.l10n.t("Enter a slide number between 1 and {0}", count);
    const parse = (text: string): number | undefined => {
      const value = Number(text.trim());
      return Number.isInteger(value) && value >= 1 && value <= count ? value : undefined;
    };
    const input = await vscode.window.showInputBox({
      title: vscode.l10n.t("Go to Slide"),
      prompt: hint,
      value: String(Math.min(this.slide, count)),
      validateInput: (text) => (parse(text) === undefined ? hint : undefined),
    });
    const slide = input === undefined ? undefined : parse(input);
    if (slide !== undefined) void this.post({ type: "goToSlide", slide });
  }

  /**
   * Watches the file's folder rather than the file. Many programs save by writing a temporary
   * file and renaming it over the original, which a watch on the file itself can miss, and a
   * folder pattern avoids having to escape glob characters in the file name.
   */
  private watchFile(): vscode.Disposable {
    const folder = vscode.Uri.joinPath(this.uri, "..");
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "*"), false, false, true);
    const onEvent = (changed: vscode.Uri): void => {
      if (isSameResource(changed, this.uri)) this.onFileChanged();
    };
    return vscode.Disposable.from(watcher, watcher.onDidChange(onEvent), watcher.onDidCreate(onEvent));
  }

  private onFileChanged(): void {
    if (!vscode.workspace.getConfiguration(CONFIG_SECTION, this.uri).get<boolean>("autoReload", true)) return;
    if (this.panel.visible) {
      this.reloads.fileChanged();
    } else {
      // A hidden tab reloads when it is shown again; a file rewritten many times costs nothing meanwhile.
      this.changedWhileHidden = true;
    }
  }

  private onViewStateChanged(): void {
    if (this.panel.visible && this.changedWhileHidden) {
      this.changedWhileHidden = false;
      this.reloads.fileChanged();
    }
  }

  private async load(reason: LoadReason, final: boolean): Promise<void> {
    const requestId = ++this.requestId;
    const attempt = { requestId, reason, final };
    const stale = (): boolean => this.disposed || requestId !== this.requestId;
    try {
      const { size } = await vscode.workspace.fs.stat(this.uri);
      if (size > MAX_FILE_BYTES) {
        throw new Error(
          vscode.l10n.t("The file is too large to open in the viewer ({0} MB).", Math.round(size / 1024 ** 2)),
        );
      }
      const bytes = await vscode.workspace.fs.readFile(this.uri);
      if (stale()) return;
      await this.post({ type: "load", data: toArrayBuffer(bytes), ...attempt });
    } catch (error) {
      if (stale()) return;
      this.log.warn(`${this.name}: could not read the file (${reason}): ${describeError(error)}`);
      if (final) {
        await this.post({ type: "loadError", message: describeError(error), ...attempt });
      } else {
        this.reloads.report(false);
      }
    }
  }

  private onMessage(raw: unknown): void {
    const message = parseWebviewMessage(raw);
    if (!message) return;
    switch (message.type) {
      case "ready":
        this.reloads.cancel();
        void this.load("open", true);
        break;
      case "requestReload":
        this.reload();
        break;
      case "showLog":
        this.log.show(true);
        break;
      case "loadResult":
        if (message.requestId !== this.requestId) break;
        if (message.ok) {
          this.slideCount = message.slideCount;
          this.log.info(`${this.name}: showing ${message.slideCount} slide(s)`);
        } else {
          this.log.warn(`${this.name}: could not be displayed: ${message.detail}`);
        }
        this.reloads.report(message.ok);
        break;
      case "slideChanged":
        this.slide = message.slide;
        this.slideCount = message.slideCount;
        break;
      case "openLink":
        void this.openLink(message.url);
        break;
      case "diagnostic":
        this.log[message.level](`${this.name}: ${message.message}`);
        break;
    }
  }

  /** Opens a link from a slide. The webview is not trusted to decide what may be opened. */
  private async openLink(url: string): Promise<void> {
    if (!isSafeExternalUrl(url)) {
      this.log.warn(`${this.name}: blocked a link that is not a web or mail address`);
      return;
    }
    try {
      const target = vscode.Uri.parse(url.trim(), true);
      // A presentation can show one address and link to another, and the editor does not ask
      // before opening a link for an extension, so the real address is shown first.
      const open = vscode.l10n.t("Open Link");
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t("Do you want to open this link from the presentation?"),
        { modal: true, detail: target.toString(true) },
        open,
      );
      if (answer !== open) return;
      await vscode.env.openExternal(target);
    } catch (error) {
      this.log.warn(`${this.name}: could not open a link: ${describeError(error)}`);
    }
  }

  private async post(message: HostMessage): Promise<void> {
    if (this.disposed) return;
    try {
      await this.panel.webview.postMessage(message);
    } catch {
      // The webview was disposed while the message was on its way.
    }
  }
}
