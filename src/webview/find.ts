import type { TextSearchResult } from "@aiden0z/pptx-renderer";
import { MAX_FIND_RESULTS, compileFindQuery, firstMatchFrom, stepMatch } from "../shared/find";
import { type ViewerStrings, format } from "../shared/protocol";
import { button, clamp, h, setPressed } from "./dom";

const SEARCH_DELAY_MS = 120;

/** What the find bar searches in and reports to. The presentation on show stands behind it. */
export interface FindTarget {
  search(pattern: RegExp): readonly TextSearchResult[];
  /** Index of the slide being viewed. */
  currentSlide(): number;
  /** Highlights every occurrence of the pattern, or none. */
  setPattern(pattern: RegExp | undefined): void;
  /** Marks a match as the current one and optionally scrolls to it; `undefined` removes the mark. */
  select(match: TextSearchResult | undefined, reveal: boolean): void;
  /** Returns the keyboard focus to the slides. */
  focusContent(): void;
}

/** The find bar: a search box over the text of all slides, with the editor's three matching options. */
export class FindBar {
  readonly element: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly status: HTMLSpanElement;
  private readonly stepButtons: HTMLButtonElement[];
  private readonly options = { matchCase: false, wholeWord: false, regex: false };
  private results: readonly TextSearchResult[] = [];
  private position = -1;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly strings: ViewerStrings,
    private readonly target: FindTarget,
  ) {
    this.input = h("input", {
      class: "pv-find-input",
      attrs: {
        type: "text",
        placeholder: strings.findPlaceholder,
        "aria-label": strings.findPlaceholder,
        autocomplete: "off",
        autocapitalize: "off",
        spellcheck: "false",
      },
    });
    this.status = h("span", { class: "pv-find-status", attrs: { role: "status" } });

    const option = (key: keyof FindBar["options"], label: string, text: string): HTMLButtonElement => {
      const toggle = button({
        label,
        text,
        class: "pv-find-option",
        onClick: () => {
          this.options[key] = !this.options[key];
          setPressed(toggle, this.options[key]);
          this.run(true);
          this.input.focus();
        },
      });
      setPressed(toggle, false);
      return toggle;
    };
    const previous = button({ label: strings.findPrevious, icon: "chevronUp", onClick: () => this.step(-1) });
    const next = button({ label: strings.findNext, icon: "chevronDown", onClick: () => this.step(1) });
    this.stepButtons = [previous, next];

    this.element = h(
      "div",
      { class: "pv-find", hidden: true, attrs: { role: "search", "data-pv-own-keys": "" } },
      h(
        "div",
        { class: "pv-find-field" },
        this.input,
        option("matchCase", strings.findMatchCase, "Aa"),
        option("wholeWord", strings.findWholeWord, "ab"),
        option("regex", strings.findRegex, ".*"),
      ),
      this.status,
      previous,
      next,
      button({ label: strings.findClose, icon: "close", onClick: () => this.close() }),
    );

    this.input.addEventListener("input", () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.run(true), SEARCH_DELAY_MS);
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      this.flush();
      this.step(event.shiftKey ? -1 : 1);
    });
    this.updateStatus();
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  open(): void {
    const wasOpen = this.isOpen;
    this.element.hidden = false;
    this.input.focus();
    this.input.select();
    if (wasOpen) return;
    this.run(false);
  }

  close(): void {
    if (!this.isOpen) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.element.hidden = true;
    this.results = [];
    this.position = -1;
    this.target.setPattern(undefined);
    this.target.select(undefined, false);
    this.target.focusContent();
  }

  /** Moves to the next or previous match, wrapping around at the ends. */
  step(direction: 1 | -1): void {
    if (!this.isOpen) return;
    this.flush();
    if (this.results.length === 0) return;
    this.position = stepMatch(this.position, this.results.length, direction);
    this.target.select(this.results[this.position], true);
    this.updateStatus();
  }

  /** Searches again after the presentation changed, without moving the view. */
  refresh(): void {
    if (!this.isOpen) return;
    clearTimeout(this.timer);
    this.run(false, true);
  }

  /** Carries out a search that is still waiting for the typing pause. */
  private flush(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.run(true);
  }

  private run(reveal: boolean, keepPosition = false): void {
    this.timer = undefined;
    const compiled = compileFindQuery({ text: this.input.value, ...this.options });
    const previous = this.position;
    this.input.classList.toggle("pv-invalid", !compiled.ok);
    this.input.title = compiled.ok ? "" : compiled.error;

    const pattern = compiled.ok ? compiled.pattern : undefined;
    this.results = pattern ? this.target.search(pattern) : [];
    this.target.setPattern(this.results.length > 0 ? pattern : undefined);

    if (this.results.length === 0) {
      this.position = -1;
      this.target.select(undefined, false);
    } else {
      // A search starts at the slide being viewed. Showing a match makes its slide that slide, so
      // typing on refines the search from the match already found, as it does in the editor.
      this.position = keepPosition && previous >= 0
        ? clamp(previous, 0, this.results.length - 1)
        : firstMatchFrom(this.results.map((result) => result.slideIndex), this.target.currentSlide());
      this.target.select(this.results[this.position], reveal);
    }
    this.updateStatus(compiled.ok ? undefined : this.strings.findInvalidRegex);
  }

  private updateStatus(problem?: string): void {
    const count = this.results.length;
    const searching = this.input.value !== "";
    const total = count >= MAX_FIND_RESULTS ? `${count}+` : count; // the search stopped collecting there
    this.status.textContent =
      problem ?? (count > 0 ? format(this.strings.findCount, this.position + 1, total) : searching ? this.strings.findNoResults : "");
    this.status.classList.toggle("pv-find-empty", problem !== undefined || (searching && count === 0));
    for (const control of this.stepButtons) control.disabled = count === 0;
  }
}
