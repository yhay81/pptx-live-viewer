// Bundles the extension host entry and the webview script.
//   node esbuild.mjs               development build (source maps)
//   node esbuild.mjs --watch       rebuild on change
//   node esbuild.mjs --production  minified build + dist/ThirdPartyNotices.txt
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import("esbuild").BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : "linked",
  logLevel: "info",
  legalComments: production ? "none" : "inline",
  metafile: production,
};

/** @type {import("esbuild").BuildOptions[]} */
const builds = [
  {
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["vscode"],
  },
  {
    ...common,
    entryPoints: ["src/webview/main.ts"],
    outfile: "dist/webview/main.js",
    platform: "browser",
    format: "iife",
    target: "es2022",
  },
];

// The development page (dev/index.html) needs a stand-in for the extension host. It reuses the
// extension's own code, with `vscode` replaced by the few functions that code calls.
if (!production) {
  builds.push({
    ...common,
    entryPoints: ["dev/harness.ts"],
    outfile: "dist/dev/harness.js",
    platform: "browser",
    format: "iife",
    target: "es2022",
    alias: { vscode: path.join(root, "dev", "vscode-shim.ts") },
  });
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice|third[-_]party[-_]notices?)([.\-_].*)?$/i;

/** Every file of a package that states license terms, including a `licenses/` folder. */
async function licenseTexts(packageDir) {
  const texts = [];
  const names = (await readdir(packageDir)).sort();
  for (const name of names) {
    const file = path.join(packageDir, name);
    const info = await stat(file);
    if (info.isFile() && LICENSE_FILE.test(name)) {
      texts.push({ name, text: await readFile(file, "utf8") });
    } else if (info.isDirectory() && /^licen[cs]es$/i.test(name)) {
      for (const inner of (await readdir(file)).sort()) {
        const innerFile = path.join(file, inner);
        if ((await stat(innerFile)).isFile()) {
          texts.push({ name: `${name}/${inner}`, text: await readFile(innerFile, "utf8") });
        }
      }
    }
  }
  return texts;
}

/**
 * Lists every npm package whose code ended up in the bundles, with its license text,
 * so the published extension carries the notices its dependencies require.
 */
async function writeThirdPartyNotices(metafiles, outfile) {
  const packageDirs = new Set();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll("\\", "/"));
      if (match) packageDirs.add(match[1]);
    }
  }

  const sections = [];
  for (const dir of [...packageDirs].sort()) {
    const packageDir = path.resolve(root, dir);
    const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
    const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
    const header = [
      `${manifest.name} ${manifest.version}`,
      `License: ${manifest.license ?? "see below"}`,
      ...(repository ? [`Source: ${repository}`] : []),
    ];
    const texts = await licenseTexts(packageDir);
    const body = texts.length
      ? texts.map(({ name, text }) => `--- ${name} ---\n${text.trim()}`).join("\n\n")
      : "(The package does not ship a license file; see its license identifier above.)";
    sections.push(`${header.join("\n")}\n\n${body}`);
  }

  const divider = `\n\n${"=".repeat(78)}\n\n`;
  const intro =
    "THIRD-PARTY SOFTWARE NOTICES\n\n" +
    "This extension bundles the following third-party packages. Each is listed with the\n" +
    "license it is distributed under.";
  await writeFile(path.resolve(root, outfile), `${intro}${divider}${sections.join(divider)}\n`);
  console.log(`  ${outfile}  (${packageDirs.size} packages)`);
}

const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
try {
  if (watch) {
    await Promise.all(contexts.map((context) => context.watch()));
    await new Promise(() => {}); // keep watching until the process is interrupted
  } else {
    const results = await Promise.all(contexts.map((context) => context.rebuild()));
    if (production) {
      await writeThirdPartyNotices(
        results.map((result) => result.metafile),
        "dist/ThirdPartyNotices.txt",
      );
    }
  }
} finally {
  await Promise.all(contexts.map((context) => context.dispose()));
}
