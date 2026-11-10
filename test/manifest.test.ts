/** Checks that the extension manifest, its translations and the code agree with each other. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG_SECTION, VIEWER_COMMANDS, VIEW_TYPE } from "../src/shared/protocol";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8");
const readJson = <T>(path: string): T => JSON.parse(read(path)) as T;
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

interface MenuItem {
  readonly command: string;
  readonly when?: string;
}

interface Manifest {
  readonly icon: string;
  readonly l10n: string;
  readonly contributes: {
    readonly customEditors: readonly { readonly viewType: string }[];
    readonly commands: readonly { readonly command: string; readonly title: string }[];
    readonly menus: Readonly<Record<string, readonly MenuItem[]>>;
    readonly configuration: { readonly properties: Readonly<Record<string, unknown>> };
  };
}

const manifestText = read("package.json");
const manifest = JSON.parse(manifestText) as Manifest;
const contributed = manifest.contributes.commands.map((entry) => entry.command);

describe("commands", () => {
  it("are contributed exactly when the extension registers them", () => {
    // The commands the extension host carries out itself, plus the ones it forwards to the webview.
    const ownCommands = [...read("src/extension.ts").matchAll(/\bcommand\("(\w+)"/g)].map((match) => match[1] ?? "");
    expect(ownCommands.length).toBeGreaterThan(0);
    const registered = [...ownCommands, ...VIEWER_COMMANDS].map((name) => `${CONFIG_SECTION}.${name}`);
    expect(sorted(contributed)).toEqual(sorted(registered));
    expect(contributed).toHaveLength(new Set(contributed).size);
  });

  it("show in the Command Palette only while a presentation is the active editor", () => {
    const palette = manifest.contributes.menus.commandPalette ?? [];
    expect(sorted(palette.map((item) => item.command))).toEqual(sorted(contributed));
    for (const item of palette) expect(item.when, item.command).toContain(`activeCustomEditorId == '${VIEW_TYPE}'`);
  });

  it("are known wherever a menu refers to them", () => {
    for (const [menu, items] of Object.entries(manifest.contributes.menus)) {
      for (const item of items) expect(contributed, `${menu}: ${item.command}`).toContain(item.command);
    }
  });
});

describe("identifiers", () => {
  it("are the same in the manifest and in the code", () => {
    expect(manifest.contributes.customEditors.map((editor) => editor.viewType)).toEqual([VIEW_TYPE]);
    for (const setting of Object.keys(manifest.contributes.configuration.properties)) {
      expect(setting.startsWith(`${CONFIG_SECTION}.`), setting).toBe(true);
    }
  });

  it("cover every setting the code reads", () => {
    const settings = Object.keys(manifest.contributes.configuration.properties).map((key) => key.slice(CONFIG_SECTION.length + 1));
    const source = sourceFiles().map(read).join("\n");
    const used = [...source.matchAll(/\.get(?:<[^>]*>)?\(\s*"(\w+)"/g)].map((match) => match[1] ?? "");
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(settings, name).toContain(name);
  });

  it("point at files that exist", () => {
    expect(existsSync(`${root}${manifest.icon}`), manifest.icon).toBe(true);
    expect(existsSync(`${root}${manifest.l10n}`), manifest.l10n).toBe(true);
  });
});

function sourceFiles(): string[] {
  return readdirSync(`${root}src`, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `src/${name}`);
}

const placeholders = (text: string): string[] => sorted(text.match(/\{\d+\}/g) ?? []);

describe("translations of the manifest", () => {
  const english = readJson<Record<string, string>>("package.nls.json");
  const japanese = readJson<Record<string, string>>("package.nls.ja.json");

  it("define every text the manifest refers to, and nothing else", () => {
    const referenced = [...manifestText.matchAll(/"%([^%"]+)%"/g)].map((match) => match[1] ?? "");
    expect(referenced.length).toBeGreaterThan(0);
    expect(sorted(Object.keys(english))).toEqual(sorted(referenced));
  });

  it("exist in Japanese for every text", () => {
    expect(sorted(Object.keys(japanese))).toEqual(sorted(Object.keys(english)));
    for (const [key, text] of Object.entries(japanese)) expect(text.trim(), key).not.toBe("");
  });
});

describe("translations of the interface", () => {
  const bundle = readJson<Record<string, string>>("l10n/bundle.l10n.ja.json");
  const source = sourceFiles().map(read).join("\n");
  const messages = [...source.matchAll(/\bl10n\.t\(\s*("(?:[^"\\]|\\.)*")/g)].map((match) => JSON.parse(match[1] ?? '""') as string);

  it("can be collected: every text is written out where it is translated", () => {
    expect(messages.length).toBeGreaterThan(0);
    expect(messages).toHaveLength(source.match(/\bl10n\.t\(/g)?.length ?? 0);
  });

  it("exist in Japanese for every text, with none left over", () => {
    expect(sorted(Object.keys(bundle))).toEqual(sorted(messages));
  });

  it("keep the placeholders of the original", () => {
    for (const [message, translation] of Object.entries(bundle)) {
      expect(translation.trim(), message).not.toBe("");
      expect(placeholders(translation), message).toEqual(placeholders(message));
    }
  });
});
