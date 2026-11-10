// Writes a presentation that exercises the viewer: text, lists, shapes, a table, charts, images,
// links, speaker notes and a hidden slide.
//   node dev/make-sample.mjs                  dev/samples/sample.pptx
//   node dev/make-sample.mjs --slides 300     pads the deck to 300 slides (to try a large file)
//   node dev/make-sample.mjs --out <file>     writes somewhere else
// The title slide shows the time of writing, so running it again while the viewer is open shows
// the live reload.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import PptxGenJSModule from "pptxgenjs";

const PptxGenJS = PptxGenJSModule.default ?? PptxGenJSModule;
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const totalSlides = Number(option("slides", "0"));
const outFile = path.resolve(option("out", path.join(here, "samples", "sample.pptx")));

/** A small PNG drawn here (a colour gradient with a white disc), so that cropping and scaling are easy to judge. */
function makePng(width, height) {
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4;
      const inDisc = Math.hypot(x - width / 2, y - height / 2) < Math.min(width, height) * 0.3;
      raw[i] = inDisc ? 255 : Math.round((x / width) * 255);
      raw[i + 1] = inDisc ? 255 : Math.round((y / height) * 180);
      raw[i + 2] = inDisc ? 255 : 160;
      raw[i + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const png = `image/png;base64,${makePng(320, 200).toString("base64")}`;
const NAVY = "1B2A4A";
const BLUE = "2563EB";
const ORANGE = "E8590C";
const GRAY = "6B7280";
const INK = "1F2937";

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
pptx.title = "PPTX Live Viewer sample";
const shapes = pptx.ShapeType;

pptx.defineSlideMaster({
  title: "CONTENT",
  background: { color: "FFFFFF" },
  objects: [
    { rect: { x: 0, y: 0, w: "100%", h: 0.12, fill: { color: NAVY } } },
    { line: { x: 0.5, y: 1.15, w: 12.33, h: 0, line: { color: "D1D5DB", width: 1 } } },
    { text: { text: "PPTX Live Viewer sample", options: { x: 0.5, y: 7.05, w: 4, h: 0.3, fontSize: 9, color: GRAY } } },
  ],
  slideNumber: { x: 12.3, y: 7.05, w: 0.6, h: 0.3, fontSize: 9, color: GRAY, align: "right" },
});

const heading = (slide, text) =>
  slide.addText(text, { x: 0.5, y: 0.35, w: 12.3, h: 0.7, fontSize: 28, bold: true, color: INK });

// 1. Title
{
  const slide = pptx.addSlide();
  slide.background = { color: NAVY };
  slide.addShape(shapes.rect, { x: 0.8, y: 3.3, w: 1.6, h: 0.08, fill: { color: ORANGE } });
  slide.addText("PPTX Live Viewer", { x: 0.8, y: 1.9, w: 11.7, h: 1.2, fontSize: 48, bold: true, color: "FFFFFF" });
  slide.addText("Sample presentation / サンプル プレゼンテーション", { x: 0.8, y: 3.6, w: 11.7, h: 0.6, fontSize: 22, color: "D6E0FF" });
  slide.addText(`Written at ${new Date().toLocaleTimeString("en-GB")}`, { x: 0.8, y: 5.6, w: 6, h: 0.4, fontSize: 14, color: "A9B8DC" });
  slide.addNotes("These are the speaker notes of the title slide.\nRun `npm run sample` again to see the viewer reload.");
}

// 2. Text
{
  const slide = pptx.addSlide({ masterName: "CONTENT" });
  heading(slide, "Text and lists / テキストと箇条書き");
  slide.addText(
    [
      { text: "A first-level bullet with enough text to wrap onto a second line, so that the hanging indent is visible.", options: { bullet: true, breakLine: true } },
      { text: "A second-level bullet", options: { bullet: true, indentLevel: 1, breakLine: true } },
      { text: "A third-level bullet", options: { bullet: true, indentLevel: 2, breakLine: true } },
      { text: "日本語と English が混在する箇条書き", options: { bullet: true, breakLine: true } },
      { text: "Numbered item one", options: { bullet: { type: "number" }, breakLine: true } },
      { text: "Numbered item two", options: { bullet: { type: "number" }, breakLine: true } },
      { text: "Numbered item three", options: { bullet: { type: "number" } } },
    ],
    { x: 0.5, y: 1.4, w: 6.2, h: 3.6, fontSize: 18, color: INK, valign: "top", paraSpaceAfter: 6 },
  );
  slide.addText(
    [
      { text: "Bold ", options: { bold: true } },
      { text: "italic ", options: { italic: true } },
      { text: "underline ", options: { underline: { style: "sng" } } },
      { text: "strike ", options: { strike: "sngStrike" } },
      { text: "colour ", options: { color: ORANGE } },
      { text: "highlight ", options: { highlight: "FFF59D" } },
      { text: "H" },
      { text: "2", options: { subscript: true } },
      { text: "O  x" },
      { text: "2", options: { superscript: true } },
    ],
    { x: 7.0, y: 1.4, w: 5.8, h: 0.9, fontSize: 18, color: INK },
  );
  slide.addText(
    [
      { text: "A link to " },
      { text: "example.com", options: { hyperlink: { url: "https://example.com", tooltip: "Opens in the browser" } } },
      { text: " and a link to " },
      { text: "the charts slide", options: { hyperlink: { slide: 5 } } },
      { text: "." },
    ],
    { x: 7.0, y: 2.4, w: 5.8, h: 0.6, fontSize: 16, color: INK },
  );
  slide.addText("Centred, in the middle\nwith a second line", { x: 7.0, y: 3.2, w: 5.8, h: 1.2, fontSize: 16, align: "center", valign: "middle", fill: { color: "EEF2FF" }, line: { color: BLUE, width: 1 }, color: INK });
  slide.addText("Right-aligned, at the bottom", { x: 7.0, y: 4.6, w: 5.8, h: 0.9, fontSize: 16, align: "right", valign: "bottom", fill: { color: "F3F4F6" }, color: INK });
  slide.addText("Lines set one and a half apart.\nLines set one and a half apart.\nLines set one and a half apart.", { x: 0.5, y: 5.1, w: 6.2, h: 1.7, fontSize: 14, lineSpacingMultiple: 1.5, color: "374151" });
  slide.addText("Search for the word viewer: the viewer finds it in every slide.", { x: 7.0, y: 5.8, w: 5.8, h: 0.8, fontSize: 14, color: "374151" });
  slide.addNotes("Notes can have several paragraphs.\nThis is the second one.\n日本語のノートも表示できます。");
}

// 3. Shapes
{
  const slide = pptx.addSlide({ masterName: "CONTENT" });
  heading(slide, "Shapes and lines / 図形と線");
  const presets = [
    [shapes.rect, "rect"], [shapes.roundRect, "roundRect"], [shapes.ellipse, "ellipse"], [shapes.triangle, "triangle"],
    [shapes.rightArrow, "rightArrow"], [shapes.chevron, "chevron"], [shapes.star5, "star5"], [shapes.hexagon, "hexagon"],
    [shapes.diamond, "diamond"], [shapes.parallelogram, "parallelogram"], [shapes.cloud, "cloud"], [shapes.wedgeRoundRectCallout, "callout"],
  ];
  const colors = ["2563EB", "059669", "D97706", "DC2626", "7C3AED", "0891B2", "CA8A04", "4B5563", "BE185D", "15803D", "9CA3AF", "1D4ED8"];
  presets.forEach(([shape, label], index) => {
    slide.addText(label, {
      shape,
      x: 0.5 + (index % 6) * 2.1,
      y: 1.45 + Math.floor(index / 6) * 1.55,
      w: 1.8,
      h: 1.25,
      fill: { color: colors[index] },
      line: { color: INK, width: 1 },
      color: "FFFFFF",
      fontSize: 12,
      align: "center",
      valign: "middle",
    });
  });
  slide.addShape(shapes.line, { x: 0.5, y: 4.9, w: 3.5, h: 0, line: { color: ORANGE, width: 3, dashType: "dash" } });
  slide.addShape(shapes.line, { x: 0.5, y: 5.4, w: 3.5, h: 0, line: { color: NAVY, width: 2, endArrowType: "triangle", beginArrowType: "oval" } });
  slide.addShape(shapes.line, { x: 0.5, y: 5.8, w: 3.5, h: 0.9, line: { color: "059669", width: 2, endArrowType: "arrow" } });
  slide.addText("Rotated 20°", { shape: shapes.rect, x: 4.8, y: 5.0, w: 2.2, h: 1.0, rotate: 20, fill: { color: "FDE68A" }, line: { color: "92400E", width: 2 }, fontSize: 14, align: "center", color: "92400E" });
  slide.addShape(shapes.ellipse, { x: 7.8, y: 4.8, w: 1.8, h: 1.8, fill: { color: "DC2626", transparency: 50 } });
  slide.addShape(shapes.ellipse, { x: 8.8, y: 4.8, w: 1.8, h: 1.8, fill: { color: "2563EB", transparency: 50 } });
  slide.addText("Shadow", { shape: shapes.roundRect, x: 11.0, y: 5.0, w: 1.8, h: 1.2, fill: { color: "FFFFFF" }, line: { color: "D1D5DB", width: 1 }, shadow: { type: "outer", color: "000000", opacity: 0.35, blur: 8, offset: 4, angle: 45 }, fontSize: 14, align: "center", color: INK, rectRadius: 0.2 });
}

// 4. Table
{
  const slide = pptx.addSlide({ masterName: "CONTENT" });
  heading(slide, "Table / 表");
  const head = { bold: true, color: "FFFFFF", fill: { color: NAVY }, align: "center", valign: "middle" };
  const rows = [
    [{ text: "Term", options: head }, { text: "Measure", options: head }, { text: "Effect", options: head }, { text: "Duration", options: head }, { text: "Owner", options: head }],
    [{ text: "Short", options: { rowspan: 2, bold: true, valign: "middle", align: "center", fill: { color: "EEF2FF" } } }, "Review stock levels", { text: "120", options: { align: "right" } }, "3 months", "Supply chain"],
    ["Trial of new prices", { text: "85", options: { align: "right" } }, "2 months", "Sales planning"],
    [{ text: "Medium", options: { bold: true, align: "center", fill: { color: "EEF2FF" } } }, "需要予測モデルの導入", { text: "340", options: { align: "right", bold: true, color: ORANGE } }, "9 months", "Digital office"],
    [{ text: "Total", options: { colspan: 2, bold: true, align: "center", fill: { color: "F3F4F6" } } }, { text: "545", options: { align: "right", bold: true, fill: { color: "F3F4F6" } } }, { text: "—", options: { colspan: 2, align: "center", fill: { color: "F3F4F6" } } }],
  ];
  slide.addTable(rows, { x: 0.5, y: 1.5, w: 12.3, colW: [1.5, 4.6, 2.2, 1.8, 2.2], rowH: 0.6, fontSize: 14, color: INK, border: { type: "solid", color: "9CA3AF", pt: 1 }, valign: "middle" });
  slide.addText("Merged cells, borders and alignment come from the file.", { x: 0.5, y: 4.9, w: 12.3, h: 0.3, fontSize: 11, color: GRAY });
}

// 5. Charts
{
  const slide = pptx.addSlide({ masterName: "CONTENT" });
  heading(slide, "Charts / グラフ");
  const labels = ["Q1", "Q2", "Q3", "Q4"];
  slide.addChart(pptx.ChartType.bar, [{ name: "Revenue", labels, values: [120, 150, 170, 210] }, { name: "Cost", labels, values: [90, 100, 130, 140] }], { x: 0.5, y: 1.4, w: 6, h: 2.7, barDir: "col", showLegend: true, legendPos: "b", showTitle: true, title: "Revenue and cost", chartColors: [NAVY, ORANGE], showValue: true });
  slide.addChart(pptx.ChartType.line, [{ name: "Users", labels, values: [10, 24, 31, 52] }, { name: "Churn", labels, values: [2, 3, 6, 5] }], { x: 6.9, y: 1.4, w: 6, h: 2.7, showLegend: true, legendPos: "r", lineSize: 3, chartColors: ["059669", "D97706"] });
  slide.addChart(pptx.ChartType.pie, [{ name: "Share", labels: ["Product A", "Product B", "Product C", "Other"], values: [45, 30, 15, 10] }], { x: 0.5, y: 4.2, w: 6, h: 2.7, showLegend: true, legendPos: "r", showPercent: true, chartColors: [NAVY, "2563EB", "93C5FD", "D1D5DB"] });
  slide.addChart(pptx.ChartType.doughnut, [{ name: "Progress", labels: ["Done", "In progress", "Not started"], values: [60, 25, 15] }], { x: 6.9, y: 4.2, w: 6, h: 2.7, holeSize: 60, showLegend: true, legendPos: "b", chartColors: ["059669", "FBBF24", "E5E7EB"] });
}

// 6. Images
{
  const slide = pptx.addSlide({ masterName: "CONTENT" });
  heading(slide, "Images / 画像");
  slide.addImage({ data: png, x: 0.5, y: 1.5, w: 4, h: 2.5 });
  slide.addImage({ data: png, x: 4.9, y: 1.5, w: 2.5, h: 2.5, sizing: { type: "cover", w: 2.5, h: 2.5 } });
  slide.addImage({ data: png, x: 7.8, y: 1.5, w: 2.5, h: 2.5, rounding: true });
  slide.addImage({ data: png, x: 10.6, y: 1.8, w: 2.2, h: 1.4, rotate: 15 });
  slide.addImage({ data: png, x: 0.5, y: 4.9, w: 2.4, h: 1.5, hyperlink: { url: "https://example.com/image", tooltip: "An image with a link" } });
  const caption = { h: 0.3, fontSize: 12, align: "center", color: GRAY };
  slide.addText("As it is", { ...caption, x: 0.5, y: 4.1, w: 4 });
  slide.addText("Cropped to cover", { ...caption, x: 4.9, y: 4.1, w: 2.5 });
  slide.addText("Cut to a circle", { ...caption, x: 7.8, y: 4.1, w: 2.5 });
  slide.addText("Rotated 15°", { ...caption, x: 10.6, y: 4.1, w: 2.2 });
  slide.addText("Linked", { ...caption, x: 0.5, y: 6.5, w: 2.4 });
}

// 7. Hidden slide
{
  const slide = pptx.addSlide({ masterName: "CONTENT" });
  slide.hidden = true;
  heading(slide, "A hidden slide / 非表示スライド");
  slide.addText("PowerPoint skips this slide in a slide show. The viewer shows it and marks it as hidden.", { x: 0.5, y: 1.5, w: 12.3, h: 1, fontSize: 18, color: INK });
}

// 8. Notes
{
  const slide = pptx.addSlide({ masterName: "CONTENT" });
  heading(slide, "Speaker notes / ノート");
  slide.addText("The panel below the slide shows the notes of the slide being viewed.", { x: 0.5, y: 1.5, w: 12.3, h: 1, fontSize: 18, color: INK });
  slide.addNotes(
    Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1} of a long note, long enough for the panel to scroll.`).join("\n"),
  );
}

// Padding, to try the viewer with a large presentation.
for (let number = 9; number <= totalSlides; number++) {
  const slide = pptx.addSlide({ masterName: "CONTENT" });
  heading(slide, `Slide ${number}`);
  slide.addText(`Filler text for slide ${number}.`, { x: 0.5, y: 1.5, w: 6, h: 0.6, fontSize: 18, color: INK });
  if (number % 5 === 0) {
    slide.addChart(pptx.ChartType.bar, [{ name: "Series", labels: ["A", "B", "C"], values: [number % 7, number % 11, number % 13] }], { x: 0.5, y: 2.4, w: 6, h: 3.5, barDir: "col", chartColors: [BLUE] });
  } else {
    slide.addImage({ data: png, x: 7.2, y: 1.6, w: 5.2, h: 3.25 });
  }
  if (number % 3 === 0) slide.addNotes(`Notes of slide ${number}.`);
}

mkdirSync(path.dirname(outFile), { recursive: true });
await pptx.writeFile({ fileName: outFile });
const shown = path.relative(process.cwd(), outFile);
console.log(`Wrote ${shown.startsWith("..") ? outFile : shown}`);
