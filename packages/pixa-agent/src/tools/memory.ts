import type { Tool } from "./types";
import { addNote, listNotes, removeNote, formatNotes } from "../memory/projectMemory";

const saveProjectNote: Tool = {
  schema: {
    name: "save_project_note",
    description:
      "Save a short, durable note about this project's architecture, conventions, or a past decision — something worth remembering in future sessions. Use sparingly: only for things that would genuinely help a future conversation (e.g. 'auth tokens are validated in middleware/auth.ts, not per-route', 'this repo intentionally has no retry logic'). Do not use this for task-specific or temporary information.",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "The note text, ideally one or two sentences." },
      },
      required: ["note"],
    },
  },
  async execute(args: { note: string }, ctx) {
    if (!args?.note || typeof args.note !== "string" || !args.note.trim()) {
      return "Error: 'note' is required.";
    }
    const saved = addNote(ctx.workspaceRoot, args.note);
    return `Saved project note [${saved.id.slice(0, 8)}]: ${saved.text}`;
  },
};

const listProjectNotes: Tool = {
  schema: {
    name: "list_project_notes",
    description:
      "List all saved project notes from previous sessions (architecture notes, past decisions). Call this at the start of a task to check for relevant prior context before exploring the codebase from scratch.",
    parameters: { type: "object", properties: {} },
  },
  async execute(_args, ctx) {
    return formatNotes(listNotes(ctx.workspaceRoot));
  },
};

const forgetProjectNote: Tool = {
  schema: {
    name: "forget_project_note",
    description:
      "Remove a previously saved project note, e.g. because it's outdated or was incorrect. Use list_project_notes first to find the note's id.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The note id (or its 8-character prefix) from list_project_notes." },
      },
      required: ["id"],
    },
  },
  async execute(args: { id: string }, ctx) {
    if (!args?.id) return "Error: 'id' is required.";
    const notes = listNotes(ctx.workspaceRoot);
    const match = notes.find((n) => n.id === args.id || n.id.startsWith(args.id));
    if (!match) return `No note found matching id "${args.id}". Use list_project_notes to see current notes.`;
    removeNote(ctx.workspaceRoot, match.id);
    return `Removed note [${match.id.slice(0, 8)}]: ${match.text}`;
  },
};

export const memoryTools: Tool[] = [saveProjectNote, listProjectNotes, forgetProjectNote];