import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface MemoryNote {
  id: string;
  text: string;
  createdAt: string; // ISO timestamp
}

const MEMORY_RELATIVE_PATH = path.join(".pixa", "memory.json");

// Caps chosen to keep this cheap to inject into context every session
// without needing summarization/eviction logic beyond "drop the oldest".
const MAX_NOTES = 50;
const MAX_TOTAL_CHARS = 6000;
const MAX_NOTE_CHARS = 500; // a single note shouldn't become a mini-essay

function loadNotes(workspaceRoot: string): MemoryNote[] {
  const filePath = path.join(workspaceRoot, MEMORY_RELATIVE_PATH);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // missing or corrupt — treat as "no notes yet"
  }
}

function saveNotes(workspaceRoot: string, notes: MemoryNote[]): void {
  const filePath = path.join(workspaceRoot, MEMORY_RELATIVE_PATH);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(notes, null, 2));
  } catch {
    // Non-fatal — the note just won't persist this time.
  }
}

/** Drops the oldest notes until both the count cap and total-char cap are satisfied. */
function enforceCaps(notes: MemoryNote[]): MemoryNote[] {
  let result = notes.slice(-MAX_NOTES); // keep at most MAX_NOTES, newest last
  let totalChars = result.reduce((sum, n) => sum + n.text.length, 0);
  while (totalChars > MAX_TOTAL_CHARS && result.length > 0) {
    const dropped = result.shift()!;
    totalChars -= dropped.text.length;
  }
  return result;
}

/**
 * Adds a note. Exact-duplicate text is a no-op (returns the existing note)
 * rather than creating a second identical entry.
 */
export function addNote(workspaceRoot: string, text: string): MemoryNote {
  const trimmed = text.trim().slice(0, MAX_NOTE_CHARS);
  const notes = loadNotes(workspaceRoot);

  const existing = notes.find((n) => n.text === trimmed);
  if (existing) return existing;

  const note: MemoryNote = {
    id: crypto.randomUUID(),
    text: trimmed,
    createdAt: new Date().toISOString(),
  };
  const updated = enforceCaps([...notes, note]);
  saveNotes(workspaceRoot, updated);
  return note;
}

export function listNotes(workspaceRoot: string): MemoryNote[] {
  return loadNotes(workspaceRoot);
}

/** Returns true if a note with this id existed and was removed. */
export function removeNote(workspaceRoot: string, id: string): boolean {
  const notes = loadNotes(workspaceRoot);
  const filtered = notes.filter((n) => n.id !== id);
  if (filtered.length === notes.length) return false;
  saveNotes(workspaceRoot, filtered);
  return true;
}

/** Formats notes for injection into a tool result or system prompt. */
export function formatNotes(notes: MemoryNote[]): string {
  if (notes.length === 0) return "(no project notes saved yet)";
  return notes
    .map((n) => `- [${n.id.slice(0, 8)}] ${n.text} (${n.createdAt.slice(0, 10)})`)
    .join("\n");
}