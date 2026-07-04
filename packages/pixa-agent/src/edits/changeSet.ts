/**
 * Staged multi-file edits. The agent never writes disk directly: every file
 * mutation lands here first and is applied only after user review.
 * Pure module — no vscode imports — so it stays unit-testable.
 */

export type ChangeStatus = "pending" | "applied" | "rejected" | "reverted";

export interface FileChange {
  path: string;
  /** null when the change creates a new file. */
  originalContent: string | null;
  newContent: string;
  status: ChangeStatus;
}

export type StageEditResult = { ok: true; newContent: string } | { ok: false; error: string };

export class ChangeSet {
  private changes = new Map<string, FileChange>();

  /**
   * Stage an exact-string replacement. If the file already has a pending
   * change, the edit applies to the pending content so sequential edits compose.
   */
  stageEdit(path: string, original: string, oldStr: string, newStr: string): StageEditResult {
    const existing = this.changes.get(path);
    const base = existing?.status === "pending" ? existing.newContent : original;

    const count = countOccurrences(base, oldStr);
    if (count === 0) {
      return { ok: false, error: `old_string not found in ${path}. Read the file again — its pending content may differ.` };
    }
    if (count > 1) {
      return { ok: false, error: `old_string matches ${count} times in ${path}. Provide a longer, unique old_string.` };
    }

    const newContent = base.replace(oldStr, newStr);
    this.changes.set(path, {
      path,
      originalContent: existing?.originalContent ?? original,
      newContent,
      status: "pending",
    });
    return { ok: true, newContent };
  }

  stageWrite(path: string, original: string | null, content: string): void {
    const existing = this.changes.get(path);
    this.changes.set(path, {
      path,
      originalContent: existing?.originalContent ?? original,
      newContent: content,
      status: "pending",
    });
  }

  get(path: string): FileChange | undefined {
    return this.changes.get(path);
  }

  list(): FileChange[] {
    return [...this.changes.values()];
  }

  markApplied(path: string): void {
    const c = this.changes.get(path);
    if (c) c.status = "applied";
  }

  markRejected(path: string): void {
    const c = this.changes.get(path);
    if (c) c.status = "rejected";
  }

  /** Only applied changes can revert (their original is what disk held before apply). */
  markReverted(path: string): void {
    const c = this.changes.get(path);
    if (c && c.status === "applied") c.status = "reverted";
  }

  /** Drop applied/rejected entries, keeping only pending ones. */
  clearResolved(): void {
    for (const [path, c] of this.changes) {
      if (c.status !== "pending") this.changes.delete(path);
    }
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count++;
    idx += needle.length;
  }
  return count;
}
