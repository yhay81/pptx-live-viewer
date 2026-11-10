/** URI helpers that do not need the `vscode` module, so they can be unit-tested. */

export interface ResourceLike {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly fsPath: string;
}

/**
 * A string that is equal for two URIs naming the same file.
 *
 * File watchers do not always report a path the way it was opened: macOS reports names in
 * decomposed Unicode (a Japanese "プ" arrives as "フ" plus a combining mark), and on macOS and
 * Windows the letter case can differ. Both are normalized here; without that a changed file
 * would not be recognised and the viewer would never reload.
 */
export function resourceKey(resource: ResourceLike, platform: string = process.platform): string {
  const local = resource.scheme === "file";
  const path = (local ? resource.fsPath : resource.path).normalize("NFC");
  const caseInsensitive = local && (platform === "darwin" || platform === "win32");
  return `${resource.scheme}://${resource.authority.toLowerCase()}/${caseInsensitive ? path.toLowerCase() : path}`;
}

export function isSameResource(a: ResourceLike, b: ResourceLike, platform: string = process.platform): boolean {
  return resourceKey(a, platform) === resourceKey(b, platform);
}

/** The last segment of a URI path, for display. */
export function baseName(resource: Pick<ResourceLike, "path">): string {
  const path = resource.path.replace(/\/+$/, "");
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A typed-array view as an ArrayBuffer that holds exactly its bytes, copying only when it must. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const { buffer, byteOffset, byteLength } = bytes;
  if (buffer instanceof ArrayBuffer && byteOffset === 0 && byteLength === buffer.byteLength) return buffer;
  return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer;
}
