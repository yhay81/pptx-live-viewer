import { type WebviewInit, type WebviewMessage, isSafeExternalUrl } from "../shared/protocol";
import { App } from "./app";
import { describeError } from "./dom";

const api = acquireVsCodeApi();
const post = (message: WebviewMessage): void => api.postMessage(message);

// An error nobody caught is worth a line in the extension's log; the webview's own console is rarely open.
window.addEventListener("error", (event) => {
  const file = event.filename.split("/").pop() ?? "";
  post({ type: "diagnostic", level: "error", message: `${event.message} (${file}:${event.lineno})` });
});
window.addEventListener("unhandledrejection", (event) => {
  post({ type: "diagnostic", level: "error", message: `unhandled rejection: ${describeError(event.reason)}` });
});

function readInit(): WebviewInit {
  const text = document.getElementById("init")?.textContent;
  if (!text) throw new Error("The viewer page has no settings.");
  return JSON.parse(text) as WebviewInit;
}

const root = document.getElementById("app");
if (!root) throw new Error("The viewer page has no root element.");

const app = new App(root, readInit(), {
  post,
  loadState: () => api.getState(),
  saveState: (state) => api.setState(state),
});

// The renderer opens a shape's hyperlink with window.open, which is not available to a webview.
// The link goes to the extension instead, which decides whether it may be opened.
window.open = (url?: string | URL): WindowProxy | null => {
  if (url !== undefined) post({ type: "openLink", url: String(url) });
  return null;
};

/** The address a link element points to, or undefined for anything that is not a link. */
function linkAddress(node: EventTarget): string | undefined {
  if (node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) return node.href;
  if (!(node instanceof SVGAElement)) return undefined;
  try {
    return new URL(node.href.baseVal, document.baseURI).href;
  } catch {
    return "";
  }
}

// VS Code opens whatever a clicked link points to, and that includes addresses that make the
// editor itself do something. The links here come from the file, so every click on one is taken
// over here, and only web and mail addresses are passed on to the extension.
window.addEventListener(
  "click",
  (event) => {
    for (const node of event.composedPath()) {
      const address = linkAddress(node);
      if (address === undefined) continue;
      // Nothing is left to the editor: in a trusted workspace it would open the address without
      // asking. The extension asks first, showing where the link really goes.
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isSafeExternalUrl(address)) post({ type: "openLink", url: address });
      return;
    }
  },
  true,
);

window.addEventListener("message", (event: MessageEvent<unknown>) => app.receive(event.data));
post({ type: "ready" });
