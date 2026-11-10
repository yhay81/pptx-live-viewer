import { describe, expect, it } from "vitest";
import {
  decodeXmlText,
  extractNotes,
  isHiddenSlide,
  normalizeAutoNumbering,
  resolvePartPath,
  sniffContainer,
} from "../src/shared/ooxml";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const NAMESPACES =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

describe("sniffContainer", () => {
  it("recognises a zip package, also an empty one", () => {
    expect(sniffContainer(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00))).toBe("zip");
    expect(sniffContainer(bytes(0x50, 0x4b, 0x05, 0x06))).toBe("zip");
  });

  it("recognises the container of legacy and password-protected files", () => {
    expect(sniffContainer(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00))).toBe("ole");
  });

  it("tells an empty file from one it does not know", () => {
    expect(sniffContainer(bytes())).toBe("empty");
    expect(sniffContainer(new TextEncoder().encode("<!doctype html>"))).toBe("unknown");
    expect(sniffContainer(new TextEncoder().encode("PKZIP"))).toBe("unknown");
    expect(sniffContainer(bytes(0x50, 0x4b))).toBe("unknown");
    expect(sniffContainer(bytes(0xd0, 0xcf, 0x11, 0xe0))).toBe("unknown");
  });
});

describe("resolvePartPath", () => {
  it("resolves a target relative to the folder of the part that refers to it", () => {
    expect(resolvePartPath("ppt/slides/slide1.xml", "../notesSlides/notesSlide1.xml")).toBe("ppt/notesSlides/notesSlide1.xml");
    expect(resolvePartPath("ppt/presentation.xml", "slides/slide1.xml")).toBe("ppt/slides/slide1.xml");
    expect(resolvePartPath("ppt/slides/slide1.xml", "./slide2.xml")).toBe("ppt/slides/slide2.xml");
  });

  it("takes a target that starts with a slash from the root of the package", () => {
    expect(resolvePartPath("ppt/slides/slide1.xml", "/ppt/media/image1.png")).toBe("ppt/media/image1.png");
  });

  it("does not climb out of the package", () => {
    expect(resolvePartPath("slide.xml", "../../notes.xml")).toBe("notes.xml");
  });
});

describe("decodeXmlText", () => {
  it("decodes the predefined entities", () => {
    expect(decodeXmlText("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;")).toBe("a & b <c> \"d\" 'e'");
  });

  it("decodes character references, decimal and hexadecimal", () => {
    expect(decodeXmlText("&#65;&#x3042;&#x1F600;")).toBe("Aあ😀");
  });

  it("decodes once: an escaped ampersand does not start another reference", () => {
    expect(decodeXmlText("&amp;lt;")).toBe("&lt;");
  });

  it("leaves what it does not know as it is", () => {
    expect(decodeXmlText("&nbsp; &#0; &#x110000; & alone")).toBe("&nbsp; &#0; &#x110000; & alone");
  });
});

/** A shape of a notes page; `placeholder` is its `<p:ph>` element, `body` its paragraphs. */
const shape = (placeholder: string, body: string): string =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:spPr/>` +
  `<p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;
const SLIDE_IMAGE =
  '<p:sp><p:nvSpPr><p:cNvPr id="1" name="Slide Image"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>';
const notesPage = (...shapes: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notes ${NAMESPACES}><p:cSld><p:spTree>${shapes.join("")}</p:spTree></p:cSld></p:notes>`;
const run = (text: string): string => `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${text}</a:t></a:r>`;
const paragraph = (text: string, properties = ""): string => `<a:p>${properties}${run(text)}</a:p>`;
const BODY = '<p:ph type="body" idx="1"/>';
const PAGE_NUMBER = '<p:ph type="sldNum" sz="quarter" idx="5"/>';

const textOf = (xml: string): string[] => extractNotes(xml).map((note) => note.text);

describe("extractNotes", () => {
  it("reads the paragraphs of the body placeholder and nothing else on the page", () => {
    const xml = notesPage(SLIDE_IMAGE, shape(BODY, paragraph("First point") + paragraph("Second point")), shape(PAGE_NUMBER, paragraph("3")));
    expect(extractNotes(xml)).toEqual([
      { text: "First point", level: 0 },
      { text: "Second point", level: 0 },
    ]);
  });

  it("joins the runs of a paragraph and turns a line break into a new line", () => {
    const body = `<a:p>${run("Hello, ")}${run("world")}<a:br><a:rPr lang="en-US"/></a:br>${run("next line")}<a:br/>${run("last")}</a:p>`;
    expect(textOf(notesPage(shape(BODY, body)))).toEqual(["Hello, world\nnext line\nlast"]);
  });

  it("reads the outline level of a paragraph", () => {
    const body =
      paragraph("top") +
      paragraph("nested", '<a:pPr marL="342900" lvl="2" indent="-342900"/>') +
      paragraph("with children", '<a:pPr lvl="1"><a:buNone/></a:pPr>') +
      paragraph("too deep", '<a:pPr lvl="12"/>') +
      paragraph("not a number", '<a:pPr lvl="x"/>');
    expect(extractNotes(notesPage(shape(BODY, body))).map((note) => note.level)).toEqual([0, 2, 1, 8, 0]);
  });

  it("decodes entities and character references in the text", () => {
    expect(textOf(notesPage(shape(BODY, paragraph("Q&amp;A &lt;draft&gt; &#x3042;"))))).toEqual(["Q&A <draft> あ"]);
  });

  it("does not take an empty text element for the start of one", () => {
    const body = `<a:p><a:r><a:t xml:space="preserve"/></a:r>${run("after")}</a:p>`;
    expect(textOf(notesPage(shape(BODY, body)))).toEqual(["after"]);
  });

  it("drops empty paragraphs around the notes and keeps the ones between", () => {
    const empty = '<a:p><a:endParaRPr lang="en-US"/></a:p>';
    const body = `<a:p/>${empty}${paragraph("one")}<a:p/>${paragraph("two")}${paragraph("  ")}${empty}`;
    expect(textOf(notesPage(shape(BODY, body)))).toEqual(["one", "", "two"]);
  });

  it("reads line endings the way an XML parser does", () => {
    expect(textOf(notesPage(shape(BODY, paragraph("one\r\ntwo\rthree"))))).toEqual(["one\ntwo\nthree"]);
  });

  it("falls back to the first other text when no placeholder is marked as the body", () => {
    const xml = notesPage(SLIDE_IMAGE, shape(PAGE_NUMBER, paragraph("7")), shape('<p:ph idx="1"/>', paragraph("Loose notes")), shape("", paragraph("A text box")));
    expect(textOf(xml)).toEqual(["Loose notes"]);
  });

  it("prefers the body placeholder to a text box that comes before it", () => {
    const xml = notesPage(shape("", paragraph("A text box")), shape(BODY, paragraph("The notes")));
    expect(textOf(xml)).toEqual(["The notes"]);
  });

  it("has no notes when the page holds only its page number, header, footer and date", () => {
    const xml = notesPage(
      SLIDE_IMAGE,
      shape(PAGE_NUMBER, paragraph("3")),
      shape('<p:ph type="hdr" sz="quarter"/>', paragraph("Header")),
      shape('<p:ph type="ftr" sz="quarter" idx="4"/>', paragraph("Footer")),
      shape('<p:ph type="dt" idx="1"/>', paragraph("2026-01-01")),
    );
    expect(extractNotes(xml)).toEqual([]);
    expect(extractNotes(notesPage())).toEqual([]);
    expect(extractNotes("")).toEqual([]);
  });
});

describe("isHiddenSlide", () => {
  const slide = (attributes: string): string => `<?xml version="1.0"?><p:sld ${NAMESPACES}${attributes}><p:cSld/></p:sld>`;

  it("reads the mark that hides a slide from the slide show", () => {
    expect(isHiddenSlide(slide(' show="0"'))).toBe(true);
    expect(isHiddenSlide(slide(' show="false"'))).toBe(true);
    expect(isHiddenSlide(slide(' showMasterSp="0" show="0"'))).toBe(true);
  });

  it("takes a slide without the mark as shown", () => {
    expect(isHiddenSlide(slide(""))).toBe(false);
    expect(isHiddenSlide(slide(' show="1"'))).toBe(false);
    expect(isHiddenSlide(slide(' show="true"'))).toBe(false);
  });

  it("is not misled by attributes and elements with similar names", () => {
    expect(isHiddenSlide(slide(' showMasterSp="0"'))).toBe(false);
    expect(isHiddenSlide(`<p:sldLayout ${NAMESPACES} show="0"><p:cSld/></p:sldLayout>`)).toBe(false);
    expect(isHiddenSlide("")).toBe(false);
  });
});

interface Numbering {
  readonly type?: string;
  readonly startAt?: number;
}

/** A paragraph of a list: numbered when `numbering` is given, plain otherwise. */
function item(text: string, numbering?: Numbering, level = 0): string {
  const start = numbering?.startAt === undefined ? "" : ` startAt="${numbering.startAt}"`;
  const bullet = numbering ? `<a:buAutoNum type="${numbering.type ?? "arabicPeriod"}"${start}/>` : "<a:buNone/>";
  return `<a:p><a:pPr${level > 0 ? ` lvl="${level}"` : ""}>${bullet}</a:pPr><a:r><a:t>${text}</a:t></a:r></a:p>`;
}
const textBody = (...paragraphs: string[]): string => `<p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join("")}</p:txBody>`;
const FROM_ONE: Numbering = { startAt: 1 };
const COUNTING: Numbering = {};

describe("normalizeAutoNumbering", () => {
  it("keeps the starting number on the first paragraph of a list only", () => {
    const before = textBody(item("a", FROM_ONE), item("b", FROM_ONE), item("c", FROM_ONE));
    const after = textBody(item("a", FROM_ONE), item("b", COUNTING), item("c", COUNTING));
    expect(normalizeAutoNumbering(before)).toBe(after);
  });

  it("starts a new list after a paragraph of the same level that is not numbered", () => {
    const before = textBody(item("a", FROM_ONE), item("b", FROM_ONE), item("text"), item("c", FROM_ONE), item("d", FROM_ONE));
    const after = textBody(item("a", FROM_ONE), item("b", COUNTING), item("text"), item("c", FROM_ONE), item("d", COUNTING));
    expect(normalizeAutoNumbering(before)).toBe(after);
  });

  it("carries a list on across paragraphs of deeper levels", () => {
    const before = textBody(item("a", FROM_ONE), item("detail", undefined, 1), item("b", FROM_ONE));
    const after = textBody(item("a", FROM_ONE), item("detail", undefined, 1), item("b", COUNTING));
    expect(normalizeAutoNumbering(before)).toBe(after);
  });

  it("starts a nested list again under each parent", () => {
    const before = textBody(
      item("1", FROM_ONE),
      item("1.1", FROM_ONE, 1),
      item("1.2", FROM_ONE, 1),
      item("2", FROM_ONE),
      item("2.1", FROM_ONE, 1),
      item("2.2", FROM_ONE, 1),
    );
    const after = textBody(
      item("1", FROM_ONE),
      item("1.1", FROM_ONE, 1),
      item("1.2", COUNTING, 1),
      item("2", COUNTING),
      item("2.1", FROM_ONE, 1),
      item("2.2", COUNTING, 1),
    );
    expect(normalizeAutoNumbering(before)).toBe(after);
  });

  it("treats another numbering style or another starting number as another list", () => {
    const letters: Numbering = { type: "alphaLcPeriod", startAt: 1 };
    const fromThree: Numbering = { startAt: 3 };
    const before = textBody(item("a", letters), item("b", FROM_ONE), item("c", fromThree), item("d", fromThree));
    const after = textBody(item("a", letters), item("b", FROM_ONE), item("c", fromThree), item("d", COUNTING));
    expect(normalizeAutoNumbering(before)).toBe(after);
  });

  it("leaves a list alone that already counts", () => {
    const usual = textBody(item("a", FROM_ONE), item("b", COUNTING), item("c", COUNTING));
    expect(normalizeAutoNumbering(usual)).toBe(usual);
    const plain = textBody(item("a", COUNTING), item("b", COUNTING));
    expect(normalizeAutoNumbering(plain)).toBe(plain);
  });

  it("looks at every text body on its own, in table cells too", () => {
    const cell = (...paragraphs: string[]): string => `<a:tc><a:txBody><a:bodyPr/>${paragraphs.join("")}</a:txBody></a:tc>`;
    const before = textBody(item("a", FROM_ONE)) + textBody(item("b", FROM_ONE)) + cell(item("c", FROM_ONE), item("d", FROM_ONE));
    const after = textBody(item("a", FROM_ONE)) + textBody(item("b", FROM_ONE)) + cell(item("c", FROM_ONE), item("d", COUNTING));
    expect(normalizeAutoNumbering(before)).toBe(after);
  });

  it("changes nothing outside text bodies", () => {
    const loose = item("a", FROM_ONE) + item("b", FROM_ONE);
    expect(normalizeAutoNumbering(loose)).toBe(loose);
  });
});
