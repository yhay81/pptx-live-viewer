import {
  type HostMessage,
  type ViewerCommand,
  type ViewerSettings,
  type ViewerStrings,
  type WebviewInit,
  type WebviewMessage,
  type ZoomMode,
  format,
  joinSentences,
} from "../shared/protocol";
import { MAX_ZOOM, MIN_ZOOM, ZOOM_PRESETS, formatZoom } from "../shared/zoom";
import { type Deck, DeckError, openDeck } from "./deck";
import { button, describeError, h, icon, setPressed } from "./dom";
import { FindBar } from "./find";
import { NotesPanel } from "./notes";
import { Stage } from "./stage";
import { Thumbnails } from "./thumbnails";

/** The viewer's connection to whatever embeds it: VS Code, or the development page. */
export interface ViewerHost {
  post(message: WebviewMessage): void;
  loadState(): unknown;
  saveState(state: unknown): void;
}

/** What the user chose in this tab. It outlives the webview being hidden or the window reloading. */
interface SavedState {
  zoom?: ZoomMode;
  thumbnails?: boolean;
  notes?: boolean;
  notesHeight?: number;
  slide?: number;
}

type LoadAttempt = Pick<Extract<HostMessage, { type: "load" }>, "requestId" | "reason" | "final">;

/** Problems of one file version written to the extension's log before the rest are only counted. */
const MAX_LOGGED_PROBLEMS = 20;

function readState(value: unknown): SavedState {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const state: SavedState = {};
  if (raw.zoom === "fit" || raw.zoom === "width") state.zoom = raw.zoom;
  else if (typeof raw.zoom === "number" && Number.isFinite(raw.zoom)) state.zoom = raw.zoom;
  if (typeof raw.thumbnails === "boolean") state.thumbnails = raw.thumbnails;
  if (typeof raw.notes === "boolean") state.notes = raw.notes;
  if (typeof raw.notesHeight === "number" && Number.isFinite(raw.notesHeight)) state.notesHeight = raw.notesHeight;
  if (typeof raw.slide === "number" && Number.isInteger(raw.slide) && raw.slide >= 0) state.slide = raw.slide;
  return state;
}

/** The file's bytes as sent by the host. A typed array is accepted too and copied out of its buffer. */
function asArrayBuffer(data: unknown): ArrayBuffer | undefined {
  if (data instanceof ArrayBuffer) return data;
  if (!ArrayBuffer.isView(data)) return undefined;
  const copy = new Uint8Array(data.byteLength);
  copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return copy.buffer;
}

/** The whole viewer: toolbar, thumbnails, slides, notes and find bar, and the loading of files into them. */
export class App {
  private readonly strings: ViewerStrings;
  private readonly settings: ViewerSettings;
  private readonly state: SavedState;

  private readonly stageHost: HTMLDivElement;
  private readonly message: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly bannerText: HTMLSpanElement;
  private readonly thumbnails: Thumbnails;
  private readonly notes: NotesPanel;
  private readonly find: FindBar;

  private readonly thumbnailsButton: HTMLButtonElement;
  private readonly notesButton: HTMLButtonElement;
  private readonly findButton: HTMLButtonElement;
  private readonly previousButton: HTMLButtonElement;
  private readonly nextButton: HTMLButtonElement;
  private readonly pageInput: HTMLInputElement;
  private readonly pageTotal: HTMLSpanElement;
  private readonly zoomOutButton: HTMLButtonElement;
  private readonly zoomInButton: HTMLButtonElement;
  private readonly zoomSelect: HTMLSelectElement;
  private readonly customZoom: HTMLOptionElement;
  private readonly problemsButton: HTMLButtonElement;
  private readonly problemsCount: HTMLSpanElement;

  /** The presentation on show; `undefined` until the first file has been drawn. */
  private stage: Stage | undefined;
  private deck: Deck | undefined;
  /** The presentation the panels are laid out for: the one on show or, while a file loads, the one about to be. */
  private layoutDeck: Deck | undefined;
  private zoom: ZoomMode;
  private loadToken = 0;

  constructor(
    root: HTMLElement,
    init: WebviewInit,
    private readonly host: ViewerHost,
  ) {
    const strings = (this.strings = init.strings);
    this.settings = init.settings;
    this.state = readState(host.loadState());
    this.zoom = this.state.zoom ?? init.settings.zoom;

    // Toolbar ---------------------------------------------------------------------------------
    this.thumbnailsButton = button({
      label: strings.toggleThumbnails,
      icon: "sidebar",
      onClick: () => this.run("toggleThumbnails"),
    });
    this.previousButton = button({ label: strings.previousSlide, icon: "chevronUp", onClick: () => this.run("previousSlide") });
    this.nextButton = button({ label: strings.nextSlide, icon: "chevronDown", onClick: () => this.run("nextSlide") });
    this.pageInput = h("input", {
      class: "pv-page",
      title: strings.slideNumber,
      attrs: { type: "text", inputmode: "numeric", autocomplete: "off", "aria-label": strings.slideNumber },
    });
    this.pageTotal = h("span", { class: "pv-page-total" });
    this.zoomOutButton = button({ label: strings.zoomOut, icon: "minus", onClick: () => this.run("zoomOut") });
    this.zoomInButton = button({ label: strings.zoomIn, icon: "plus", onClick: () => this.run("zoomIn") });
    this.customZoom = h("option", { hidden: true, attrs: { value: "custom" } });
    this.zoomSelect = h(
      "select",
      { class: "pv-zoom", attrs: { "aria-label": strings.zoom } },
      h("option", { text: strings.zoomFit, attrs: { value: "fit" } }),
      h("option", { text: strings.zoomWidth, attrs: { value: "width" } }),
      ...ZOOM_PRESETS.map((percent) => h("option", { text: formatZoom(percent), attrs: { value: String(percent) } })),
      this.customZoom,
    );
    this.problemsCount = h("span");
    this.problemsButton = h(
      "button",
      { class: "pv-button pv-problems", hidden: true, attrs: { type: "button" } },
      icon("warning"),
      this.problemsCount,
    );
    this.problemsButton.addEventListener("click", () => host.post({ type: "showLog" }));
    this.findButton = button({ label: strings.find, icon: "search", onClick: () => this.run("find") });
    this.notesButton = button({ label: strings.toggleNotes, icon: "notes", onClick: () => this.run("toggleNotes") });

    const separator = (): HTMLElement => h("span", { class: "pv-separator", attrs: { "aria-hidden": "true" } });
    const toolbar = h(
      "div",
      { class: "pv-toolbar", attrs: { role: "toolbar", "aria-label": strings.toolbar } },
      this.thumbnailsButton,
      separator(),
      this.previousButton,
      this.pageInput,
      this.pageTotal,
      this.nextButton,
      separator(),
      this.zoomOutButton,
      this.zoomSelect,
      this.zoomInButton,
      h("span", { class: "pv-spacer" }),
      this.problemsButton,
      this.findButton,
      this.notesButton,
    );

    // Banner shown when a reload fails while an earlier version is still on show ------------------
    this.bannerText = h("span", { class: "pv-banner-text" });
    this.banner = h(
      "div",
      { class: "pv-banner", hidden: true, attrs: { role: "alert" } },
      icon("warning"),
      this.bannerText,
      button({ label: strings.retry, text: strings.retry, class: "pv-text-button", onClick: () => host.post({ type: "requestReload" }) }),
      button({ label: strings.dismiss, icon: "close", onClick: () => (this.banner.hidden = true) }),
    );

    // Panels ----------------------------------------------------------------------------------
    this.thumbnails = new Thumbnails(
      strings,
      (index) => this.stage?.goTo(index),
      (problem) => this.host.post({ type: "diagnostic", level: "warn", message: problem }),
    );
    this.notes = new NotesPanel(strings, this.state.notesHeight, (height) => {
      this.state.notesHeight = height;
      this.save();
    });
    this.find = new FindBar(strings, {
      search: (pattern) => this.stage?.search(pattern) ?? [],
      currentSlide: () => this.stage?.current ?? 0,
      setPattern: (pattern) => this.stage?.setSearchPattern(pattern),
      select: (match, reveal) => this.stage?.selectMatch(match, reveal),
      focusContent: () => this.stage?.focus(),
    });
    this.message = h("div", { class: "pv-message" });
    this.stageHost = h("div", { class: "pv-stage" }, this.find.element, this.message);

    root.classList.add("pv-app");
    root.replaceChildren(
      toolbar,
      this.banner,
      h("div", { class: "pv-body" }, this.thumbnails.element, h("div", { class: "pv-main" }, this.stageHost, this.notes.element)),
    );

    this.pageInput.addEventListener("focus", () => this.pageInput.select());
    this.pageInput.addEventListener("blur", () => this.syncPage());
    this.pageInput.addEventListener("keydown", (event) => this.onPageKey(event));
    this.zoomSelect.addEventListener("change", () => this.onZoomSelected());
    document.addEventListener("keydown", (event) => this.onKeyDown(event));
    // VS Code focuses the webview as a whole; the slides should then respond to the keyboard.
    window.addEventListener("focus", () => {
      if (document.activeElement === document.body) this.stage?.focus();
    });

    this.showNotice(strings.loading);
    this.applyPanels();
    this.syncPage();
    this.syncZoom();
    this.syncAvailability();
  }

  /** Handles a message from the host. Anything that is not a known message is ignored. */
  receive(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const message = value as HostMessage;
    switch (message.type) {
      case "load": {
        const data = asArrayBuffer(message.data);
        if (data) void this.load(message, data);
        break;
      }
      case "loadError":
        this.loadToken++; // a load still in progress is for a version of the file that is gone
        this.layoutFor(this.deck);
        if (message.final) this.showFailure(String(message.message));
        break;
      case "command":
        this.run(message.command);
        break;
      case "goToSlide":
        this.stage?.goTo(Number(message.slide) - 1);
        break;
    }
  }

  // --- Loading -------------------------------------------------------------------------------

  /**
   * Draws a version of the file. The new slides are built out of sight, scrolled to where the
   * view is, and only then swapped in, so a reload replaces the picture in one step.
   */
  private async load(attempt: LoadAttempt, data: ArrayBuffer): Promise<void> {
    const token = ++this.loadToken;
    const superseded = (): boolean => token !== this.loadToken;
    let stage: Stage | undefined;
    let deck: Deck;
    try {
      deck = await openDeck(data);
      if (superseded()) return;
      // Decided before the slides are laid out: the panels take space the slides would otherwise fit to.
      this.layoutFor(deck);

      stage = this.createStage(deck);
      stage.element.classList.add("pv-pending");
      this.stageHost.prepend(stage.element);
      await stage.render();
      if (!superseded()) {
        this.place(stage);
        await stage.settled();
      }
    } catch (error) {
      stage?.dispose();
      if (superseded()) return;
      this.layoutFor(this.deck);
      this.loadFailed(attempt, error);
      return;
    }
    if (superseded()) {
      stage.dispose();
      return;
    }
    this.place(stage); // again: the view may have been scrolled while the new slides were prepared
    this.show(stage, deck);
    this.host.post({ type: "loadResult", requestId: attempt.requestId, ok: true, slideCount: stage.slideCount, detail: "" });
  }

  private createStage(deck: Deck): Stage {
    const labels = { slide: this.strings.slideLabel, hidden: this.strings.hiddenSlide };
    const stage: Stage = new Stage(deck, this.zoom, labels, {
      onSlideChange: () => {
        if (this.stage === stage) this.slideChanged();
      },
      onZoomChange: () => {
        if (this.stage === stage) this.zoomChanged();
      },
      onProblem: (problem, count) => {
        if (count <= MAX_LOGGED_PROBLEMS) {
          this.host.post({ type: "diagnostic", level: "warn", message: `could not render ${problem}` });
        } else if (count === MAX_LOGGED_PROBLEMS + 1) {
          this.host.post({ type: "diagnostic", level: "warn", message: "further rendering problems in this file are not listed" });
        }
        if (this.stage === stage) this.syncProblems();
      },
    });
    return stage;
  }

  /** Scrolls a stage that is being prepared to where the user is, or on first load to where they were. */
  private place(stage: Stage): void {
    if (this.stage) stage.restore(this.stage.capture());
    else if (this.state.slide !== undefined) stage.goTo(this.state.slide);
  }

  private show(stage: Stage, deck: Deck): void {
    const previous = this.stage;
    const focused = document.activeElement;
    const takeFocus = focused === document.body || (previous !== undefined && focused === previous.element);
    this.stage = stage;
    this.deck = deck;
    stage.element.classList.remove("pv-pending");
    previous?.dispose();
    if (takeFocus) stage.focus();

    this.banner.hidden = true;
    if (stage.slideCount === 0) this.showNotice(this.strings.emptyDeck);
    else this.message.hidden = true;
    this.layoutFor(deck);
    this.thumbnails.update(stage);
    if (this.hasSlides) this.find.refresh();
    else this.find.close();
    this.syncAvailability();
    this.syncZoom();
    this.syncProblems();
    this.slideChanged();
  }

  private loadFailed(attempt: LoadAttempt, error: unknown): void {
    this.host.post({
      type: "loadResult",
      requestId: attempt.requestId,
      ok: false,
      slideCount: this.stage?.slideCount ?? 0,
      detail: describeError(error),
    });
    // While the host will try again (the file may still be being written), what is on show stays as it is.
    if (attempt.final) this.showFailure(this.explain(error));
  }

  private explain(error: unknown): string {
    if (!(error instanceof DeckError)) return describeError(error);
    switch (error.kind) {
      case "empty":
        return this.strings.errorEmpty;
      case "encrypted":
        return this.strings.errorEncrypted;
      case "tooLarge":
        return this.strings.errorTooLarge;
      case "notPptx":
        return this.strings.errorNotPptx;
    }
  }

  /** Reports that the file cannot be shown: as a banner over an earlier version, or in place of the slides. */
  private showFailure(explanation: string): void {
    if (this.stage) {
      this.bannerText.textContent = joinSentences(this.strings.reloadFailed, explanation);
      this.banner.hidden = false;
      return;
    }
    this.message.replaceChildren(
      h(
        "div",
        { class: "pv-message-box", attrs: { role: "alert" } },
        h("h2", { text: this.strings.errorTitle }),
        h("p", { text: explanation }),
        button({
          label: this.strings.retry,
          text: this.strings.retry,
          class: "pv-text-button pv-primary",
          onClick: () => this.host.post({ type: "requestReload" }),
        }),
      ),
    );
    this.message.hidden = false;
  }

  private showNotice(text: string): void {
    this.message.replaceChildren(h("div", { class: "pv-message-box", attrs: { role: "status" } }, h("p", { text })));
    this.message.hidden = false;
  }

  // --- Commands and controls -----------------------------------------------------------------

  private run(command: ViewerCommand): void {
    const stage = this.stage;
    switch (command) {
      case "find":
        if (this.hasSlides) this.find.open();
        break;
      case "nextSlide":
        stage?.next();
        break;
      case "previousSlide":
        stage?.previous();
        break;
      case "zoomIn":
        stage?.zoomStep(1);
        break;
      case "zoomOut":
        stage?.zoomStep(-1);
        break;
      case "zoomToFit":
        this.setZoom("fit");
        break;
      case "zoomToWidth":
        this.setZoom("width");
        break;
      case "zoomActualSize":
        this.setZoom(100);
        break;
      case "toggleThumbnails":
        this.state.thumbnails = !this.thumbnailsVisible;
        this.applyPanels();
        this.save();
        break;
      case "toggleNotes":
        this.state.notes = !this.notesVisible;
        this.applyPanels();
        this.save();
        break;
    }
  }

  private setZoom(mode: ZoomMode): void {
    if (this.stage) {
      this.stage.setZoom(mode);
      return;
    }
    this.zoom = mode;
    this.zoomChanged();
  }

  /** Whether there are slides on show for the controls to act on. */
  private get hasSlides(): boolean {
    return (this.stage?.slideCount ?? 0) > 0;
  }

  /** Whether the user wants the thumbnails; they are shown once there are slides. */
  private get thumbnailsVisible(): boolean {
    return this.state.thumbnails ?? this.settings.thumbnails;
  }

  private get notesVisible(): boolean {
    if (this.state.notes !== undefined) return this.state.notes;
    return this.settings.notes === "auto" ? this.layoutDeck?.hasNotes === true : this.settings.notes === "show";
  }

  /** Lays the panels out for a presentation: the one about to be shown, or the one on show. */
  private layoutFor(deck: Deck | undefined): void {
    this.layoutDeck = deck;
    this.applyPanels();
  }

  private applyPanels(): void {
    const anySlides = (this.layoutDeck?.presentation.slides.length ?? 0) > 0;
    this.thumbnails.element.hidden = !(anySlides && this.thumbnailsVisible);
    setPressed(this.thumbnailsButton, this.thumbnailsVisible);
    this.notes.element.hidden = !(anySlides && this.notesVisible);
    setPressed(this.notesButton, this.notesVisible);
  }

  /** Without slides there is nothing for most of the toolbar to do. */
  private syncAvailability(): void {
    const unavailable = !this.hasSlides;
    for (const control of [this.thumbnailsButton, this.notesButton, this.findButton, this.zoomSelect]) {
      control.disabled = unavailable;
    }
  }

  private slideChanged(): void {
    const stage = this.stage;
    if (!stage) return;
    const index = stage.current;
    this.syncPage();
    this.thumbnails.setCurrent(index);
    this.notes.show(this.deck?.notes[index]);
    if (this.state.slide !== index) {
      this.state.slide = index;
      this.save();
    }
    this.host.post({ type: "slideChanged", slide: index + 1, slideCount: stage.slideCount });
  }

  private zoomChanged(): void {
    const mode = this.stage?.zoomMode ?? this.zoom;
    this.zoom = mode;
    if (this.state.zoom !== mode) {
      this.state.zoom = mode;
      this.save();
    }
    this.syncZoom();
  }

  private syncPage(): void {
    const count = this.stage?.slideCount ?? 0;
    const index = this.stage?.current ?? 0;
    if (document.activeElement !== this.pageInput) this.pageInput.value = count > 0 ? String(index + 1) : "";
    this.pageInput.disabled = count === 0;
    this.pageInput.style.width = `${Math.max(2, String(count).length) + 1.6}ch`;
    this.pageTotal.textContent = `/ ${count}`;
    this.previousButton.disabled = index <= 0;
    this.nextButton.disabled = index >= count - 1;
  }

  private syncZoom(): void {
    const mode = this.stage?.zoomMode ?? this.zoom;
    const percent = this.stage?.zoomPercent ?? (typeof mode === "number" ? mode : 100);
    const preset = typeof mode === "number" && ZOOM_PRESETS.includes(mode);
    this.customZoom.hidden = typeof mode !== "number" || preset;
    this.customZoom.textContent = formatZoom(percent);
    this.zoomSelect.value = typeof mode !== "number" ? mode : preset ? String(mode) : "custom";
    this.zoomSelect.title = `${this.strings.zoom}: ${formatZoom(percent)}`;
    this.zoomOutButton.disabled = !this.hasSlides || percent <= MIN_ZOOM + 0.5;
    this.zoomInButton.disabled = !this.hasSlides || percent >= MAX_ZOOM - 0.5;
  }

  private syncProblems(): void {
    const count = this.stage?.problemCount ?? 0;
    const label = format(this.strings.renderProblems, count);
    this.problemsButton.hidden = count === 0;
    this.problemsButton.title = label;
    this.problemsButton.setAttribute("aria-label", label);
    this.problemsCount.textContent = String(count);
  }

  private onZoomSelected(): void {
    const value = this.zoomSelect.value;
    if (value === "fit" || value === "width") this.setZoom(value);
    else if (value !== "custom") this.setZoom(Number(value));
  }

  private onPageKey(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      const slide = Number(this.pageInput.value.trim());
      const stage = this.stage;
      if (stage && Number.isInteger(slide) && slide >= 1 && slide <= stage.slideCount) stage.goTo(slide - 1);
      this.pageInput.blur(); // also restores the field when the entry was not a slide number
      stage?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      this.pageInput.blur();
      this.stage?.focus();
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.isComposing) return;
    const key = event.key;
    const modifier = event.ctrlKey || event.metaKey;

    // Find works from anywhere in the viewer.
    if (modifier && !event.altKey && key.toLowerCase() === "f") {
      event.preventDefault();
      if (this.hasSlides) this.find.open();
      return;
    }
    if (this.find.isOpen) {
      if (key === "Escape") {
        event.preventDefault();
        this.find.close();
        return;
      }
      if (key === "F3" || (modifier && !event.altKey && key.toLowerCase() === "g")) {
        event.preventDefault();
        this.find.step(event.shiftKey ? -1 : 1);
        return;
      }
    }

    const stage = this.stage;
    const target = event.target instanceof Element ? event.target : null;
    if (!stage || modifier || event.altKey) return;
    // Fields, the find bar and the notes panel use these keys themselves.
    if (target?.closest("input, select, textarea, [data-pv-own-keys]")) return;

    const inThumbnails = target !== null && this.thumbnails.element.contains(target);
    const bySlide = inThumbnails || stage.showsWholeSlide;
    const step = (forward: boolean): void => (forward ? stage.next() : stage.previous());

    switch (key) {
      case "ArrowDown":
      case "ArrowUp":
        if (bySlide) step(key === "ArrowDown");
        else stage.scrollLines(0, key === "ArrowDown" ? 1 : -1);
        break;
      case "ArrowRight":
      case "ArrowLeft":
        if (inThumbnails || !stage.scrollsSideways) step(key === "ArrowRight");
        else stage.scrollLines(key === "ArrowRight" ? 1 : -1, 0);
        break;
      case "PageDown":
      case "PageUp":
        if (bySlide) step(key === "PageDown");
        else stage.scrollPages(key === "PageDown" ? 1 : -1);
        break;
      case " ":
        if (target?.closest("button, a, [role='link']")) return; // the space bar activates the control
        if (bySlide) step(!event.shiftKey);
        else stage.scrollPages(event.shiftKey ? -1 : 1);
        break;
      case "Home":
        stage.goTo(0);
        break;
      case "End":
        stage.goTo(stage.slideCount - 1);
        break;
      case "+":
      case "=":
        stage.zoomStep(1);
        break;
      case "-":
        stage.zoomStep(-1);
        break;
      case "0":
        this.setZoom("fit");
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private save(): void {
    this.host.saveState({ ...this.state });
  }
}
