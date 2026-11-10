/**
 * Small helpers for the parts of a .pptx package the renderer does not cover: recognising what
 * kind of file was opened, reading speaker notes and hidden-slide marks, and one numbering fix-up.
 *
 * They work on the XML text directly and rely on the `p:` / `a:` namespace prefixes that every
 * mainstream producer writes. A file that uses other prefixes is left untouched (no notes, no
 * fix-up) rather than misread.
 */

export type ContainerKind = "zip" | "ole" | "empty" | "unknown";

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * Tells a zip package (.pptx) from an OLE compound file — the container of legacy .ppt files
 * and of password-protected .pptx files — by the first bytes.
 */
export function sniffContainer(bytes: Uint8Array): ContainerKind {
  if (bytes.length === 0) return "empty";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] ?? 0xff) <= 0x08 && (bytes[3] ?? 0xff) <= 0x08) {
    return "zip";
  }
  if (bytes.length >= OLE_SIGNATURE.length && OLE_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "ole";
  return "unknown";
}

/**
 * Resolves a relationship target against the part that owns the relationship.
 * `resolvePartPath("ppt/slides/slide1.xml", "../notesSlides/notesSlide1.xml")` is
 * `"ppt/notesSlides/notesSlide1.xml"`.
 */
export function resolvePartPath(ownerPart: string, target: string): string {
  const segments = target.startsWith("/") ? [] : ownerPart.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decodes the character and entity references of XML character data. */
export function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (reference, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : reference;
    }
    return ENTITIES[body] ?? reference;
  });
}

const attribute = (attributes: string, name: string): string | undefined =>
  new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1];

export interface NoteParagraph {
  readonly text: string;
  /** Outline level, 0 for a top-level paragraph. */
  readonly level: number;
}

const SHAPE = /<p:sp(?:\s[^>]*)?>[\s\S]*?<\/p:sp>/g;
const PLACEHOLDER = /<p:ph(?=[\s/>])([^>]*?)\/?>/;
const TEXT_BODY = /<p:txBody>[\s\S]*?<\/p:txBody>/;
const PARAGRAPH = /<a:p>([\s\S]*?)<\/a:p>|<a:p\/>/g;
const PARAGRAPH_PROPERTIES = /<a:pPr(?=[\s/>])([^>]*?)\/?>/;
const TEXT_PIECE = /<a:t(?:\s[^>]*)?(?<!\/)>([\s\S]*?)<\/a:t>|<a:br(?=[\s/>])[^>]*>/g;

/** Placeholders of a notes page that hold something other than the notes text. */
const NON_NOTE_PLACEHOLDERS = new Set(["sldImg", "sldNum", "hdr", "ftr", "dt"]);

function paragraphsOf(textBody: string): NoteParagraph[] {
  const paragraphs: NoteParagraph[] = [];
  for (const match of textBody.matchAll(PARAGRAPH)) {
    const content = match[1] ?? "";
    let text = "";
    for (const piece of content.matchAll(TEXT_PIECE)) {
      text += piece[0].startsWith("<a:br") ? "\n" : decodeXmlText(piece[1] ?? "");
    }
    const level = Number(attribute(PARAGRAPH_PROPERTIES.exec(content)?.[1] ?? "", "lvl") ?? 0);
    paragraphs.push({ text, level: Number.isInteger(level) && level > 0 ? Math.min(level, 8) : 0 });
  }
  while (paragraphs.length > 0 && paragraphs.at(-1)?.text.trim() === "") paragraphs.pop();
  while (paragraphs.length > 0 && paragraphs[0]?.text.trim() === "") paragraphs.shift();
  return paragraphs;
}

/**
 * Extracts the speaker notes from a notes slide part (`ppt/notesSlides/notesSlideN.xml`).
 * The notes live in the body placeholder; the slide image, page number, header, footer and date
 * placeholders of the notes page are skipped.
 */
export function extractNotes(notesSlideXml: string): NoteParagraph[] {
  // An XML parser reads every line ending as a line feed; do the same before looking at the text.
  const xml = notesSlideXml.replace(/\r\n?/g, "\n");
  let fallback: string | undefined;
  for (const [shape] of xml.matchAll(SHAPE)) {
    const textBody = TEXT_BODY.exec(shape)?.[0];
    if (!textBody) continue;
    const placeholder = PLACEHOLDER.exec(shape);
    const type = placeholder ? attribute(placeholder[1] ?? "", "type") : undefined;
    if (type === "body") return paragraphsOf(textBody);
    if (fallback === undefined && !(type !== undefined && NON_NOTE_PLACEHOLDERS.has(type))) fallback = textBody;
  }
  return fallback === undefined ? [] : paragraphsOf(fallback);
}

const SLIDE_ROOT = /<p:sld(?=[\s>])([^>]*)>/;

/** Whether a slide part (`ppt/slides/slideN.xml`) is marked as hidden, which makes a slide show skip it. */
export function isHiddenSlide(slideXml: string): boolean {
  const show = attribute(SLIDE_ROOT.exec(slideXml)?.[1] ?? "", "show");
  return show === "0" || show === "false";
}

const ANY_TEXT_BODY = /<([a-z]\w*):txBody>[\s\S]*?<\/\1:txBody>/g;
const AUTO_NUMBER = /<a:buAutoNum(?=[\s/>])([^>]*?)\/?>/;

/**
 * Makes numbered lists count up when every paragraph repeats the list's starting number.
 *
 * PowerPoint reads `startAt` as the first number of a run of numbered paragraphs, so a list in
 * which each paragraph carries `startAt="1"` (PptxGenJS writes lists this way) shows 1, 2, 3.
 * The renderer restarts at every `startAt` and would show 1, 1, 1. Removing the attribute from
 * the second paragraph of a run onwards leaves the meaning unchanged and lets the renderer count.
 *
 * A run is broken by a paragraph of the same or a shallower level that is not numbered the same
 * way, as in PowerPoint; paragraphs of deeper levels do not break it.
 */
export function normalizeAutoNumbering(slideXml: string): string {
  if (!slideXml.includes("startAt=")) return slideXml;
  return slideXml.replace(ANY_TEXT_BODY, (textBody) => {
    const running = new Map<number, string>();
    return textBody.replace(/<a:p>[\s\S]*?<\/a:p>/g, (paragraph) => {
      const level = Number(attribute(PARAGRAPH_PROPERTIES.exec(paragraph)?.[1] ?? "", "lvl") ?? 0) || 0;
      for (const deeper of [...running.keys()]) {
        if (deeper > level) running.delete(deeper);
      }
      const autoNumber = AUTO_NUMBER.exec(paragraph);
      if (!autoNumber) {
        running.delete(level);
        return paragraph;
      }
      const attributes = autoNumber[1] ?? "";
      const startAt = attribute(attributes, "startAt");
      const signature = `${attribute(attributes, "type") ?? "arabicPeriod"}:${startAt ?? "1"}`;
      if (running.get(level) !== signature) {
        running.set(level, signature);
        return paragraph;
      }
      if (startAt === undefined) return paragraph;
      return paragraph.replace(autoNumber[0], autoNumber[0].replace(/\s+startAt="[^"]*"/, ""));
    });
  });
}
