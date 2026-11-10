import { describe, expect, it } from "vitest";
import { type ResourceLike, baseName, isSameResource, resourceKey, toArrayBuffer } from "../src/editor/resource";

const file = (fsPath: string): ResourceLike => ({ scheme: "file", authority: "", path: fsPath, fsPath });
const remote = (authority: string, path: string): ResourceLike => ({ scheme: "vscode-remote", authority, path, fsPath: path });

describe("isSameResource", () => {
  it("recognises a name the file watcher reports in decomposed Unicode", () => {
    const opened = "/Users/me/資料/プレゼン.pptx";
    const reported = opened.normalize("NFD");
    expect(reported).not.toBe(opened);
    for (const platform of ["darwin", "linux", "win32"]) {
      expect(isSameResource(file(opened), file(reported), platform)).toBe(true);
    }
  });

  it("ignores letter case where the file system does", () => {
    const a = file("/Users/me/Deck.PPTX");
    const b = file("/users/me/deck.pptx");
    expect(isSameResource(a, b, "darwin")).toBe(true);
    expect(isSameResource(a, b, "win32")).toBe(true);
    expect(isSameResource(a, b, "linux")).toBe(false);
  });

  it("tells different files apart", () => {
    expect(isSameResource(file("/work/a.pptx"), file("/work/b.pptx"), "darwin")).toBe(false);
    expect(isSameResource(file("/work/a.pptx"), file("/work/sub/a.pptx"), "darwin")).toBe(false);
  });

  it("compares a file that is not on this machine by its path, case and all", () => {
    const a = remote("ssh-remote+box", "/home/me/Deck.pptx");
    expect(isSameResource(a, remote("ssh-remote+box", "/home/me/deck.pptx"), "darwin")).toBe(false);
    expect(isSameResource(a, remote("SSH-Remote+Box", "/home/me/Deck.pptx"), "darwin")).toBe(true);
    expect(isSameResource(a, remote("ssh-remote+other", "/home/me/Deck.pptx"), "darwin")).toBe(false);
    // `fsPath` means nothing for such a file.
    expect(isSameResource(a, { ...a, fsPath: "\\\\somewhere\\else" }, "win32")).toBe(true);
  });

  it("tells the same path under different schemes apart", () => {
    const local = file("/work/deck.pptx");
    expect(isSameResource(local, { ...local, scheme: "vscode-vfs" }, "linux")).toBe(false);
  });
});

describe("resourceKey", () => {
  it("uses the platform it runs on unless told otherwise", () => {
    const resource = file("/Work/Deck.pptx");
    expect(resourceKey(resource)).toBe(resourceKey(resource, process.platform));
  });
});

describe("baseName", () => {
  it("is the last segment of the path", () => {
    expect(baseName({ path: "/work/slides/deck.pptx" })).toBe("deck.pptx");
    expect(baseName({ path: "/work/四半期 報告.pptx" })).toBe("四半期 報告.pptx");
    expect(baseName({ path: "deck.pptx" })).toBe("deck.pptx");
  });

  it("ignores trailing slashes", () => {
    expect(baseName({ path: "/work/slides/" })).toBe("slides");
    expect(baseName({ path: "/" })).toBe("");
  });
});

describe("toArrayBuffer", () => {
  it("hands over the buffer itself when the view covers all of it", () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    expect(toArrayBuffer(bytes)).toBe(bytes.buffer);
  });

  it("copies exactly the bytes of a view into part of a buffer", () => {
    const whole = Uint8Array.from([0, 1, 2, 3, 4, 5]);
    const tail = toArrayBuffer(whole.subarray(2, 5));
    expect(tail).not.toBe(whole.buffer);
    expect([...new Uint8Array(tail)]).toEqual([2, 3, 4]);
    const head = toArrayBuffer(whole.subarray(0, 2));
    expect([...new Uint8Array(head)]).toEqual([0, 1]);
  });

  it("copes with a Node.js buffer, which may share its memory with others", () => {
    const result = toArrayBuffer(Buffer.from("PK\u0003\u0004 pooled", "latin1"));
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder("latin1").decode(result)).toBe("PK\u0003\u0004 pooled");
  });
});
