/**
 * The part of the `vscode` module that the code shared with the development page uses.
 * The build of that page resolves `import "vscode"` to this file.
 */

let translations: Readonly<Record<string, string>> = {};

/** Installs a localization bundle (the contents of l10n/bundle.l10n.<language>.json). */
export function setTranslations(bundle: Readonly<Record<string, string>>): void {
  translations = bundle;
}

export const l10n = {
  t(message: string, ...values: readonly (string | number | boolean)[]): string {
    return (translations[message] ?? message).replace(/\{(\d+)\}/g, (placeholder, index: string) => {
      const value = values[Number(index)];
      return value === undefined ? placeholder : String(value);
    });
  },
};
