import { describe, expect, it } from "vitest";
import { format, isSafeExternalUrl, joinSentences, parseWebviewMessage } from "../src/shared/protocol";

describe("parseWebviewMessage", () => {
  it("accepts the messages that carry nothing, dropping anything attached to them", () => {
    for (const type of ["ready", "requestReload", "showLog"]) {
      expect(parseWebviewMessage({ type, extra: "x" })).toStrictEqual({ type });
    }
  });

  it("accepts the outcome of a load", () => {
    const message = { type: "loadResult", requestId: 3, ok: true, slideCount: 12, detail: "" };
    expect(parseWebviewMessage({ ...message, extra: 1 })).toStrictEqual(message);
  });

  it("fills in what the outcome of a load leaves out and shortens a long explanation", () => {
    expect(parseWebviewMessage({ type: "loadResult", requestId: 0, ok: false })).toStrictEqual({
      type: "loadResult",
      requestId: 0,
      ok: false,
      slideCount: 0,
      detail: "",
    });
    const parsed = parseWebviewMessage({ type: "loadResult", requestId: 1, ok: false, slideCount: -4, detail: "x".repeat(5000) });
    expect(parsed).toMatchObject({ slideCount: 0 });
    expect(parsed?.type === "loadResult" && parsed.detail.length).toBe(2000);
  });

  it("rejects the outcome of a load that does not say which load or how it went", () => {
    for (const requestId of [-1, 1.5, "3", Number.NaN, undefined]) {
      expect(parseWebviewMessage({ type: "loadResult", requestId, ok: true })).toBeUndefined();
    }
    expect(parseWebviewMessage({ type: "loadResult", requestId: 1, ok: "true" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "loadResult", requestId: 1 })).toBeUndefined();
  });

  it("accepts a slide change with whole, non-negative numbers only", () => {
    expect(parseWebviewMessage({ type: "slideChanged", slide: 2, slideCount: 10, extra: 1 })).toStrictEqual({
      type: "slideChanged",
      slide: 2,
      slideCount: 10,
    });
    expect(parseWebviewMessage({ type: "slideChanged", slide: -1, slideCount: 10 })).toBeUndefined();
    expect(parseWebviewMessage({ type: "slideChanged", slide: 2.5, slideCount: 10 })).toBeUndefined();
    expect(parseWebviewMessage({ type: "slideChanged", slide: 2 })).toBeUndefined();
  });

  it("accepts a link of a reasonable length", () => {
    expect(parseWebviewMessage({ type: "openLink", url: "https://example.com/", extra: 1 })).toStrictEqual({
      type: "openLink",
      url: "https://example.com/",
    });
    const longest = `https://example.com/${"a".repeat(8192 - 20)}`;
    expect(parseWebviewMessage({ type: "openLink", url: longest })).toStrictEqual({ type: "openLink", url: longest });
    expect(parseWebviewMessage({ type: "openLink", url: `${longest}a` })).toBeUndefined();
    expect(parseWebviewMessage({ type: "openLink", url: 42 })).toBeUndefined();
    expect(parseWebviewMessage({ type: "openLink" })).toBeUndefined();
  });

  it("accepts a diagnostic, at a level it knows", () => {
    expect(parseWebviewMessage({ type: "diagnostic", level: "error", message: "broken" })).toStrictEqual({
      type: "diagnostic",
      level: "error",
      message: "broken",
    });
    expect(parseWebviewMessage({ type: "diagnostic", level: "warn", message: "odd" })).toMatchObject({ level: "warn" });
    expect(parseWebviewMessage({ type: "diagnostic", level: "shout", message: "odd" })).toMatchObject({ level: "info" });
    expect(parseWebviewMessage({ type: "diagnostic", message: "odd" })).toMatchObject({ level: "info" });
    expect(parseWebviewMessage({ type: "diagnostic", level: "error", message: "x".repeat(5000) })).toMatchObject({
      message: "x".repeat(2000),
    });
    expect(parseWebviewMessage({ type: "diagnostic", level: "error", message: { text: "broken" } })).toBeUndefined();
  });

  it("rejects everything else", () => {
    const rejected: unknown[] = [
      undefined,
      null,
      "ready",
      42,
      [],
      {},
      { type: 1 },
      { type: "READY" },
      // Messages of the other direction are not the webview's to send.
      { type: "load", data: new ArrayBuffer(4), requestId: 1, reason: "open", final: true },
      { type: "command", command: "zoomIn" },
      { type: "goToSlide", slide: 2 },
    ];
    for (const value of rejected) expect(parseWebviewMessage(value)).toBeUndefined();
  });
});

describe("isSafeExternalUrl", () => {
  it("lets web and mail addresses through", () => {
    for (const url of [
      "https://example.com",
      "http://example.com/path?query=1#part",
      "HTTPS://EXAMPLE.COM",
      "mailto:someone@example.com",
      "  https://example.com  ",
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(true);
    }
  });

  it("holds back everything else", () => {
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "vscode://publisher.extension/path",
      "command:workbench.action.terminal.new",
      "ftp://example.com/file",
      "httpsx://example.com",
      "//example.com",
      "/relative/path",
      "example.com",
      "javascript:https://example.com",
      "",
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
  });
});

describe("format", () => {
  it("puts the values in place of the numbered placeholders", () => {
    expect(format("{0} of {1}", 2, 10)).toBe("2 of 10");
    expect(format("{1}/{0}", "a", "b")).toBe("b/a");
    expect(format("{0} and {0}", "x")).toBe("x and x");
    expect(format("Slide {0}", 0)).toBe("Slide 0");
  });

  it("leaves a placeholder that has no value, and text that has no placeholder", () => {
    expect(format("{0} of {1}", 2)).toBe("2 of {1}");
    expect(format("Nothing here")).toBe("Nothing here");
    expect(format("{name} {}", "x")).toBe("{name} {}");
  });
});

describe("joinSentences", () => {
  it("separates sentences with a space", () => {
    expect(joinSentences("It could not be reloaded.", "The file no longer exists.")).toBe(
      "It could not be reloaded. The file no longer exists.",
    );
  });

  it("adds no space after punctuation that carries its own", () => {
    expect(joinSentences("再読み込みできませんでした。", "ファイルが見つかりません。")).toBe(
      "再読み込みできませんでした。ファイルが見つかりません。",
    );
    expect(joinSentences("本当に！", "はい。")).toBe("本当に！はい。");
    expect(joinSentences("本当に？", "はい。")).toBe("本当に？はい。");
  });

  it("returns the one sentence when the other is missing", () => {
    expect(joinSentences("Only this.", "")).toBe("Only this.");
    expect(joinSentences("", "Only that.")).toBe("Only that.");
    expect(joinSentences("", "")).toBe("");
  });
});
