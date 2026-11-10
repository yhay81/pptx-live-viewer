import type { NoteParagraph } from "../shared/ooxml";
import type { ViewerStrings } from "../shared/protocol";
import { clamp, h } from "./dom";

const MIN_HEIGHT = 48;
const DEFAULT_HEIGHT = 132;
const KEY_STEP = 16;
/** Height always left for the slides above the panel. */
const MIN_STAGE_HEIGHT = 120;
const MAX_INDENT_LEVEL = 8;

/** The speaker notes of the slide being viewed, in a panel below the slides whose top edge can be dragged. */
export class NotesPanel {
  readonly element: HTMLElement;
  private readonly body: HTMLDivElement;
  private shown: readonly NoteParagraph[] | undefined | null = null;
  private height: number;

  constructor(
    private readonly strings: ViewerStrings,
    height: number | undefined,
    private readonly onResize: (height: number) => void,
  ) {
    this.height = height !== undefined && Number.isFinite(height) ? Math.max(MIN_HEIGHT, height) : DEFAULT_HEIGHT;
    const resizer = h("div", {
      class: "pv-notes-resizer",
      title: strings.resizeNotes,
      attrs: {
        role: "separator",
        "aria-orientation": "horizontal",
        "aria-label": strings.resizeNotes,
        tabindex: "0",
        "data-pv-own-keys": "",
      },
    });
    this.body = h("div", { class: "pv-notes-body", attrs: { tabindex: "0", "data-pv-own-keys": "" } });
    this.element = h("section", { class: "pv-notes", attrs: { "aria-label": strings.notes } }, resizer, this.body);
    this.applyHeight();

    resizer.addEventListener("pointerdown", (event) => this.startDrag(resizer, event));
    resizer.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowUp" ? KEY_STEP : event.key === "ArrowDown" ? -KEY_STEP : 0;
      if (step === 0) return;
      event.preventDefault();
      this.setHeight(this.height + step);
      this.onResize(this.height);
    });
  }

  /** Shows the notes of a slide; `undefined` or an empty list shows that the slide has none. */
  show(paragraphs: readonly NoteParagraph[] | undefined): void {
    if (paragraphs === this.shown) return; // keeps the reader's place when nothing changed
    this.shown = paragraphs;
    if (!paragraphs || paragraphs.length === 0) {
      this.body.replaceChildren(h("p", { class: "pv-notes-empty", text: this.strings.noNotes }));
    } else {
      this.body.replaceChildren(
        ...paragraphs.map((paragraph) => {
          const element = h("p", { class: "pv-note", text: paragraph.text });
          if (paragraph.level > 0) {
            element.style.paddingInlineStart = `${Math.min(paragraph.level, MAX_INDENT_LEVEL) * 1.5}em`;
          }
          return element;
        }),
      );
    }
    this.body.scrollTop = 0;
  }

  private startDrag(resizer: HTMLElement, down: PointerEvent): void {
    if (down.button !== 0) return;
    down.preventDefault();
    resizer.setPointerCapture(down.pointerId);
    const startY = down.clientY;
    const startHeight = this.element.getBoundingClientRect().height;
    const move = (event: PointerEvent): void => this.setHeight(startHeight + startY - event.clientY);
    const end = (): void => {
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", end);
      resizer.removeEventListener("pointercancel", end);
      this.onResize(this.height);
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", end);
    resizer.addEventListener("pointercancel", end);
  }

  private setHeight(height: number): void {
    const available = this.element.parentElement?.clientHeight ?? 0;
    const max = available > 0 ? Math.max(MIN_HEIGHT, available - MIN_STAGE_HEIGHT) : Number.POSITIVE_INFINITY;
    this.height = Math.round(clamp(height, MIN_HEIGHT, max));
    this.applyHeight();
  }

  private applyHeight(): void {
    this.element.style.setProperty("--pv-notes-h", `${this.height}px`);
  }
}
