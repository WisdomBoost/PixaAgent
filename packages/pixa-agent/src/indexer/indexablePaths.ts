/** Paths under .pixa/ are local index/benchmark data — never embed them. */
export function isIndexablePath(relPath: string): boolean {
  if (!relPath || relPath.startsWith("..")) return false;
  const normalized = relPath.replace(/\\/g, "/");
  return normalized !== ".pixa" && !normalized.startsWith(".pixa/");
}
