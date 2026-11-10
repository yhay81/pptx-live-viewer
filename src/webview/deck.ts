import {
  type PptxFiles,
  type PresentationData,
  type ZipParseLimits,
  buildPresentation,
  parseZip,
} from "@aiden0z/pptx-renderer";
import JSZip from "jszip";
import {
  type NoteParagraph,
  extractNotes,
  isHiddenSlide,
  normalizeAutoNumbering,
  resolvePartPath,
  sniffContainer,
} from "../shared/ooxml";
import { describeError } from "./dom";

const MB = 1024 * 1024;

/**
 * Limits on what is unpacked from the archive. They are generous — the file is one the user
 * chose to open, and decks with embedded video are large — and exist to stop a malformed or
 * hostile archive from exhausting the webview's memory.
 */
const ZIP_LIMITS: ZipParseLimits = {
  maxEntries: 20_000,
  maxEntryUncompressedBytes: 512 * MB,
  maxTotalUncompressedBytes: 1536 * MB,
  maxMediaBytes: 1536 * MB,
  maxConcurrency: 8,
};

/** A notes part larger than this is not text someone wrote; it is skipped. */
const MAX_NOTES_BYTES = 4 * MB;

export type DeckErrorKind = "empty" | "encrypted" | "notPptx" | "tooLarge";

/** A file that cannot be shown, with the reason in a form the UI can explain. */
export class DeckError extends Error {
  constructor(
    readonly kind: DeckErrorKind,
    detail: string,
  ) {
    super(detail);
    this.name = "DeckError";
  }
}

export interface Deck {
  readonly presentation: PresentationData;
  /** Speaker notes per slide, in slide order; empty for a slide without notes. */
  readonly notes: readonly (readonly NoteParagraph[])[];
  readonly hasNotes: boolean;
  /** Per slide, whether it is marked as hidden (skipped in a slide show). */
  readonly hidden: readonly boolean[];
}

function notesPartOf(slide: PresentationData["slides"][number]): string | undefined {
  for (const relationship of slide.rels.values()) {
    if (relationship.type.endsWith("/notesSlide") && relationship.targetMode !== "External") {
      return resolvePartPath(slide.slidePath, relationship.target);
    }
  }
  return undefined;
}

/** Reads the notes of every slide. The renderer does not expose notes, so the archive is opened again here. */
async function readNotes(buffer: ArrayBuffer, presentation: PresentationData): Promise<NoteParagraph[][]> {
  const parts = presentation.slides.map(notesPartOf);
  if (parts.every((part) => part === undefined)) return parts.map(() => []);
  const zip = await JSZip.loadAsync(buffer);
  return Promise.all(
    parts.map(async (part) => {
      const file = part === undefined ? null : zip.file(part);
      if (!file) return [];
      // JSZip keeps the declared size on a private field; an entry that hides it is read as usual.
      const size = (file as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
      if (typeof size === "number" && size > MAX_NOTES_BYTES) return [];
      return extractNotes(await file.async("string"));
    }),
  );
}

/** Parses a presentation file into the model the renderer draws from. */
export async function openDeck(buffer: ArrayBuffer): Promise<Deck> {
  const kind = sniffContainer(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8)));
  if (kind === "empty") throw new DeckError("empty", "the file has no content");
  if (kind === "ole") throw new DeckError("encrypted", "the file is an OLE compound document, not a zip package");
  if (kind !== "zip") throw new DeckError("notPptx", "the file is not a zip package");

  let files: PptxFiles;
  try {
    files = await parseZip(buffer, ZIP_LIMITS);
  } catch (error) {
    const detail = describeError(error);
    throw new DeckError(/zip limit exceeded/i.test(detail) ? "tooLarge" : "notPptx", detail);
  }
  if (!files.presentation) throw new DeckError("notPptx", "the package has no ppt/presentation.xml");

  for (const [path, xml] of files.slides) files.slides.set(path, normalizeAutoNumbering(xml));

  let presentation: PresentationData;
  try {
    // Slides are parsed when they are first drawn or searched, so a long deck opens quickly.
    presentation = buildPresentation(files, { lazySlides: true });
  } catch (error) {
    throw new DeckError("notPptx", describeError(error));
  }

  let notes: NoteParagraph[][];
  try {
    notes = await readNotes(buffer, presentation);
  } catch {
    notes = presentation.slides.map(() => []);
  }
  // Read from the XML because the model learns of it only once a slide has been parsed.
  const hidden = presentation.slides.map((slide) => isHiddenSlide(files.slides.get(slide.slidePath) ?? ""));
  return { presentation, notes, hasNotes: notes.some((paragraphs) => paragraphs.length > 0), hidden };
}
