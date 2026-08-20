/** Turn a chat prompt into a safe filename slug. */
export function slugify(text: string, fallback = "model"): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

/**
 * Trigger a browser download of a model buffer.
 * Must be called synchronously inside a user-gesture handler (iOS Safari
 * ignores programmatic blob-anchor clicks outside one), and the object URL
 * is revoked on a delay (immediate revocation can cancel the download in
 * Firefox/Safari).
 */
export function downloadModel(buffer: ArrayBuffer, filename: string, ext: "stl" | "3mf"): void {
  const blob = new Blob([buffer], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadStl(buffer: ArrayBuffer, filename: string): void {
  downloadModel(buffer, filename, "stl");
}
