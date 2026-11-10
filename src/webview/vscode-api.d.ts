/** The object VS Code hands a webview for talking to its extension and keeping per-tab state. */
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

/** Provided by VS Code inside a webview. It may be called only once. */
declare function acquireVsCodeApi(): VsCodeApi;
