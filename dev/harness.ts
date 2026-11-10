/**
 * Stands in for the extension host on the development page (dev/index.html), so that the viewer
 * can be worked on in a browser tab with its developer tools. It answers the webview's messages
 * the way src/editor/ViewerSession.ts does and sends the presentation again when the file changes.
 *
 * Query parameters:
 *   file        name of a presentation in the served folder (default: the first one found)
 *   theme       dark | light | hc | hc-light
 *   lang        language of the interface, for example "ja"
 *   zoom        fit | width | a percentage
 *   thumbnails  1 | 0
 *   notes       auto | show | hide
 *   watch       0 stops following changes to the file
 *
 * A presentation dropped onto the page is shown in place of the served one.
 * `window.pvHost` sends host messages by hand, for scripted checks.
 */
import { ReloadScheduler } from "../src/editor/reload";
import { viewerStrings } from "../src/editor/strings";
import {
  type HostMessage,
  type LoadReason,
  type NotesSetting,
  VIEWER_COMMANDS,
  type ViewerCommand,
  type WebviewInit,
  type WebviewMessage,
  type ZoomMode,
  isSafeExternalUrl,
  parseWebviewMessage,
} from "../src/shared/protocol";
import { setTranslations } from "./vscode-shim";

const THEME_CLASSES: Readonly<Record<string, readonly string[]>> = {
  dark: ["vscode-dark"],
  light: ["vscode-light"],
  hc: ["vscode-high-contrast"],
  "hc-light": ["vscode-high-contrast-light", "vscode-high-contrast"],
};
const POLL_MS = 700;

// Read while this script runs; afterwards `document.currentScript` is null.
const nonce = document.currentScript instanceof HTMLScriptElement ? document.currentScript.nonce : "";
const params = new URLSearchParams(location.search);
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function zoomSetting(): ZoomMode {
  const value = params.get("zoom");
  if (value === "width") return "width";
  const percent = Number(value);
  return value !== null && Number.isFinite(percent) && percent > 0 ? percent : "fit";
}

function notesSetting(): NotesSetting {
  const value = params.get("notes");
  return value === "show" || value === "hide" ? value : "auto";
}

async function firstDeck(): Promise<string | undefined> {
  try {
    const decks = (await (await fetch("/api/decks", { cache: "no-store" })).json()) as readonly { name: string }[];
    return decks[0]?.name;
  } catch {
    return undefined;
  }
}

async function loadTranslations(language: string): Promise<void> {
  if (language === "en") return;
  try {
    const response = await fetch(`/l10n/bundle.l10n.${encodeURIComponent(language)}.json`, { cache: "no-store" });
    if (response.ok) setTranslations((await response.json()) as Record<string, string>);
  } catch {
    // Without a bundle the interface stays in English, as it does in VS Code.
  }
}

async function start(): Promise<void> {
  const theme = params.get("theme") ?? "dark";
  const language = params.get("lang") ?? "en";
  document.documentElement.lang = language;
  document.documentElement.dataset.theme = theme in THEME_CLASSES ? theme : "dark";
  document.body.classList.add(...(THEME_CLASSES[theme] ?? ["vscode-dark"]));

  await loadTranslations(language);
  let fileName = params.get("file") ?? (await firstDeck()) ?? "sample.pptx";
  let dropped: ArrayBuffer | undefined;
  let version: string | null = null;
  document.title = fileName;

  const init: WebviewInit = {
    fileName,
    settings: { zoom: zoomSetting(), thumbnails: params.get("thumbnails") !== "0", notes: notesSetting() },
    strings: viewerStrings(),
  };
  const initElement = document.getElementById("init");
  if (initElement) initElement.textContent = JSON.stringify(init).replace(/</g, "\\u003c");

  const deckUrl = (): string => `/decks/${encodeURIComponent(fileName)}`;
  const post = (message: HostMessage): void => window.postMessage(message, location.origin);
  const received: WebviewMessage[] = [];
  let requestId = 0;

  const reloads = new ReloadScheduler({
    debounceMs: 250,
    retryDelaysMs: [400, 1000, 2500],
    run: (final) => void load("change", final),
  });

  async function load(reason: LoadReason, final: boolean): Promise<void> {
    const attempt = { requestId: ++requestId, reason, final };
    const stale = (): boolean => attempt.requestId !== requestId;
    try {
      let data = dropped?.slice(0);
      if (!data) {
        const response = await fetch(deckUrl(), { cache: "no-store" });
        if (!response.ok) throw new Error(`${fileName}: ${response.status} ${response.statusText}`);
        version = response.headers.get("etag");
        data = await response.arrayBuffer();
      }
      if (!stale()) post({ type: "load", data, ...attempt });
    } catch (error) {
      if (stale()) return;
      console.warn(`[host] could not read the file (${reason}): ${describe(error)}`);
      if (final) post({ type: "loadError", message: describe(error), ...attempt });
      else reloads.report(false);
    }
  }

  function reload(): void {
    reloads.cancel();
    void load("manual", true);
  }

  function onWebviewMessage(raw: unknown): void {
    const message = parseWebviewMessage(raw);
    if (!message) {
      console.error("[host] ignored a message the extension would not accept", raw);
      return;
    }
    received.push(message);
    console.debug("[webview]", message);
    switch (message.type) {
      case "ready":
        reloads.cancel();
        void load("open", true);
        break;
      case "requestReload":
        reload();
        break;
      case "loadResult":
        if (message.requestId === requestId) reloads.report(message.ok);
        break;
      case "openLink":
        console.info(
          isSafeExternalUrl(message.url) ? `[host] would open ${message.url}` : `[host] would block ${message.url}`,
        );
        break;
      case "showLog":
        console.info("[host] would show the output channel");
        break;
      default:
        break;
    }
  }

  // The state VS Code keeps for a webview, here kept for the browser tab.
  const stateKey = `pptx-live-viewer:${fileName}`;
  let state: unknown;
  try {
    state = JSON.parse(sessionStorage.getItem(stateKey) ?? "null") ?? undefined;
  } catch {
    state = undefined;
  }
  let acquired = false;
  Object.assign(globalThis, {
    acquireVsCodeApi: () => {
      if (acquired) throw new Error("An instance of the VS Code API has already been acquired");
      acquired = true;
      return {
        // Messages reach the extension host asynchronously and as copies.
        postMessage: (message: unknown) => {
          const copy = structuredClone(message);
          setTimeout(() => onWebviewMessage(copy), 0);
        },
        getState: () => state,
        setState: (value: unknown) => {
          state = value;
          sessionStorage.setItem(stateKey, JSON.stringify(value));
        },
      };
    },
  });

  // Follows the served file the way the extension's file watcher does. A hidden tab waits until
  // it is shown again, like a hidden editor.
  let changedWhileHidden = false;
  async function poll(): Promise<void> {
    if (dropped || version === null) return;
    try {
      const response = await fetch(deckUrl(), { method: "HEAD", cache: "no-store" });
      const current = response.ok ? response.headers.get("etag") : null;
      if (current === null || current === version) return;
      version = current;
      if (document.hidden) changedWhileHidden = true;
      else reloads.fileChanged();
    } catch {
      // The server is gone; keep showing what is there.
    }
  }
  if (params.get("watch") !== "0") {
    setInterval(() => void poll(), POLL_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden || !changedWhileHidden) return;
      changedWhileHidden = false;
      reloads.fileChanged();
    });
  }

  // VS Code never lets a webview navigate. It takes clicks on links itself and opens web and mail
  // addresses in the browser; here the page only reports what would have been asked for.
  const onLinkClick = (event: MouseEvent): void => {
    for (const node of event.composedPath()) {
      if (!(node instanceof Element) || node.localName !== "a") continue;
      const href = node instanceof HTMLAnchorElement ? node.href : node.getAttribute("href");
      if (!href) continue;
      event.preventDefault();
      if (node.getAttribute("href") !== "#") console.info(`[host] VS Code would be asked to open ${href}`);
      return;
    }
  };
  window.addEventListener("click", onLinkClick);
  window.addEventListener("auxclick", onLinkClick);

  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    const file = event.dataTransfer?.files[0];
    if (!file) return;
    void file.arrayBuffer().then((data) => {
      dropped = data;
      fileName = file.name;
      document.title = fileName;
      reload();
    });
  });

  Object.assign(window, {
    pvHost: {
      received,
      post,
      reload,
      command: (command: ViewerCommand) => {
        if (!VIEWER_COMMANDS.includes(command)) throw new Error(`Unknown command: ${String(command)}`);
        post({ type: "command", command });
      },
      goToSlide: (slide: number) => post({ type: "goToSlide", slide }),
    },
  });

  const script = document.createElement("script");
  script.nonce = nonce;
  script.src = "/dist/webview/main.js";
  document.body.append(script);
}

start().catch((error: unknown) => console.error(`[host] the development page could not start: ${describe(error)}`));
