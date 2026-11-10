/** Identifiers and message shapes shared by the extension host and the webview. */

export const VIEW_TYPE = "pptxLiveViewer.viewer";
export const CONFIG_SECTION = "pptxLiveViewer";

/** "fit" shows the whole slide, "width" fills the editor width, a number is a percentage. */
export type ZoomMode = "fit" | "width" | number;

export type NotesSetting = "auto" | "show" | "hide";

export interface ViewerSettings {
  readonly zoom: ZoomMode;
  readonly thumbnails: boolean;
  readonly notes: NotesSetting;
}

/** Text shown inside the webview, already translated by the extension host. `{0}` and `{1}` are placeholders. */
export interface ViewerStrings {
  readonly loading: string;
  readonly toolbar: string;
  readonly thumbnails: string;
  readonly toggleThumbnails: string;
  readonly previousSlide: string;
  readonly nextSlide: string;
  readonly slideNumber: string;
  readonly slideLabel: string;
  readonly hiddenSlide: string;
  readonly zoom: string;
  readonly zoomIn: string;
  readonly zoomOut: string;
  readonly zoomFit: string;
  readonly zoomWidth: string;
  readonly find: string;
  readonly findPlaceholder: string;
  readonly findPrevious: string;
  readonly findNext: string;
  readonly findClose: string;
  readonly findMatchCase: string;
  readonly findWholeWord: string;
  readonly findRegex: string;
  readonly findNoResults: string;
  readonly findCount: string;
  readonly findInvalidRegex: string;
  readonly notes: string;
  readonly toggleNotes: string;
  readonly noNotes: string;
  readonly resizeNotes: string;
  readonly emptyDeck: string;
  readonly errorTitle: string;
  readonly errorEmpty: string;
  readonly errorEncrypted: string;
  readonly errorNotPptx: string;
  readonly errorTooLarge: string;
  readonly reloadFailed: string;
  readonly retry: string;
  readonly dismiss: string;
  readonly renderProblems: string;
}

export interface WebviewInit {
  readonly fileName: string;
  readonly settings: ViewerSettings;
  readonly strings: ViewerStrings;
}

/**
 * Why a file is being sent to the webview: the editor was opened, the file changed on disk,
 * or the user asked for a reload.
 */
export type LoadReason = "open" | "change" | "manual";

export const VIEWER_COMMANDS = [
  "find",
  "nextSlide",
  "previousSlide",
  "zoomIn",
  "zoomOut",
  "zoomToFit",
  "zoomToWidth",
  "zoomActualSize",
  "toggleThumbnails",
  "toggleNotes",
] as const;

export type ViewerCommand = (typeof VIEWER_COMMANDS)[number];

interface LoadAttempt {
  readonly requestId: number;
  readonly reason: LoadReason;
  /** False while the host will try again if this attempt fails (a file may still be being written). */
  readonly final: boolean;
}

export type HostMessage =
  | ({ readonly type: "load"; readonly data: ArrayBuffer } & LoadAttempt)
  | ({ readonly type: "loadError"; readonly message: string } & LoadAttempt)
  | { readonly type: "command"; readonly command: ViewerCommand }
  | { readonly type: "goToSlide"; readonly slide: number };

export type DiagnosticLevel = "info" | "warn" | "error";

export type WebviewMessage =
  | { readonly type: "ready" }
  | {
      readonly type: "loadResult";
      readonly requestId: number;
      readonly ok: boolean;
      readonly slideCount: number;
      readonly detail: string;
    }
  | { readonly type: "slideChanged"; readonly slide: number; readonly slideCount: number }
  | { readonly type: "requestReload" }
  /** Asks the host to bring up the extension's output channel, where rendering problems are listed. */
  | { readonly type: "showLog" }
  | { readonly type: "openLink"; readonly url: string }
  | { readonly type: "diagnostic"; readonly level: DiagnosticLevel; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * Validates a message posted by the webview. The webview renders untrusted documents, so the host
 * accepts only the shapes it knows and ignores everything else.
 */
export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case "ready":
    case "requestReload":
    case "showLog":
      return { type: value.type };
    case "loadResult":
      if (!isCount(value.requestId) || typeof value.ok !== "boolean") return undefined;
      return {
        type: "loadResult",
        requestId: value.requestId,
        ok: value.ok,
        slideCount: isCount(value.slideCount) ? value.slideCount : 0,
        detail: typeof value.detail === "string" ? value.detail.slice(0, 2000) : "",
      };
    case "slideChanged":
      if (!isCount(value.slide) || !isCount(value.slideCount)) return undefined;
      return { type: "slideChanged", slide: value.slide, slideCount: value.slideCount };
    case "openLink":
      if (typeof value.url !== "string" || value.url.length > 8192) return undefined;
      return { type: "openLink", url: value.url };
    case "diagnostic":
      if (typeof value.message !== "string") return undefined;
      return {
        type: "diagnostic",
        level: value.level === "error" || value.level === "warn" ? value.level : "info",
        message: value.message.slice(0, 2000),
      };
    default:
      return undefined;
  }
}

/** Only web and mail links may be handed to the operating system. */
export function isSafeExternalUrl(url: string): boolean {
  return /^(https?|mailto):/i.test(url.trim());
}

/**
 * Puts two sentences on one line. A space separates them unless the first ends with a full-width
 * punctuation mark, as Japanese and Chinese sentences do: such a mark carries its own space.
 */
export function joinSentences(first: string, second: string): string {
  if (first === "" || second === "") return first + second;
  return /[。．！？]$/u.test(first) ? first + second : `${first} ${second}`;
}

/** Replaces `{0}`, `{1}`, ... in a translated template. */
export function format(template: string, ...values: readonly (string | number)[]): string {
  return template.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const value = values[Number(index)];
    return value === undefined ? placeholder : String(value);
  });
}
