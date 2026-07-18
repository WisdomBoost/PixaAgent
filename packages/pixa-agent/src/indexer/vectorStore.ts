import { LocalIndex } from "vectra";
import * as fs from "node:fs";
import * as path from "node:path";
import { embed } from "../providers/embeddings";
import type { Chunk } from "./chunker";
import { isIndexablePath } from "./indexablePaths";

// MiniLM cosine scores for NL-query vs code-chunk pairs are often 0.15–0.40 even
// when the match is correct; unrelated pairs can be negative. Keep this low.
const RELEVANCE_THRESHOLD = 0.12;
const OVERFETCH_MULTIPLIER = 5;
const OVERFETCH_MIN = 25;

export interface QueryResult {
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName: string | null;
  symbolKind: string | null;
  text: string;
  score: number;
}

export interface QueryDiagnostics {
  chunkCount: number;
  threshold: number;
  results: QueryResult[];
  rawCandidates: Array<{
    filePath: string;
    score: number;
    symbolName: string | null;
  }>;
}

// Vectra's MetadataTypes doesn't allow null, so nullable Chunk fields are
// coerced to "" before storage and coerced back to null when read.
//
// IMPORTANT: chunk text is deliberately NOT stored here anymore. Storing raw
// source text in the vector index roughly doubled disk usage (on top of the
// vector arrays themselves, which are already large as serialized JSON) for
// zero benefit — the real text is already sitting on disk in the file. We
// read it back from disk at query time instead (see readTextForChunk below).
interface ChunkMetadata {
  [key: string]: string | number;
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName: string; // "" means "no symbol"
  symbolKind: string; // "" means "no symbol"
}

function chunkMetaFromChunk(chunk: Chunk): ChunkMetadata {
  return {
    filePath: chunk.filePath,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    symbolName: chunk.symbolName ?? "",
    symbolKind: chunk.symbolKind ?? "",
  };
}

/**
 * Thin wrapper around Vectra's LocalIndex. Nothing outside this file should
 * import from "vectra" directly.
 */
export class VectorStore {
  private index: LocalIndex;
  private folderPath: string;
  /** filePath -> set of chunk ids currently stored for that file. Rebuilt from disk on load. */
  private fileToIds = new Map<string, Set<string>>();
  private ready: Promise<void>;

  constructor(private workspaceRoot: string) {
    this.folderPath = path.join(workspaceRoot, ".pixa", "index");
    this.index = new LocalIndex(this.folderPath);
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    fs.mkdirSync(this.folderPath, { recursive: true });
    this.ensureGitignored();
    this.writeReadmeIfMissing();

    if (!(await this.index.isIndexCreated())) {
      await this.index.createIndex();
    }

    // Rebuild the filePath -> ids map from whatever's already on disk, so
    // deleteChunksForFile works correctly across extension restarts.
    try {
      const items = await this.index.listItems();
      for (const item of items) {
        const meta = item.metadata as unknown as ChunkMetadata;
        if (!meta?.filePath) continue;
        const set = this.fileToIds.get(meta.filePath) ?? new Set<string>();
        set.add(String(item.id));
        this.fileToIds.set(meta.filePath, set);
      }
    } catch {
      // Index file is corrupt (truncated JSON, etc.) — wipe it and start fresh.
      // This can happen if the extension host was killed mid-write.
      this.fileToIds.clear();
      fs.rmSync(this.folderPath, { recursive: true, force: true });
      fs.mkdirSync(this.folderPath, { recursive: true });
      this.index = new LocalIndex(this.folderPath);
      await this.index.createIndex();
    }
  }

  private ensureGitignored(): void {
    const gitignorePath = path.join(this.workspaceRoot, ".gitignore");
    const entry = ".pixa/";
    try {
      if (!fs.existsSync(gitignorePath)) {
        fs.writeFileSync(gitignorePath, `${entry}\n`);
        return;
      }
      const existing = fs.readFileSync(gitignorePath, "utf8");
      const alreadyPresent = existing
        .split(/\r?\n/)
        .some((line) => line.trim() === entry || line.trim() === ".pixa");
      if (!alreadyPresent) {
        const needsNewline = existing.length > 0 && !existing.endsWith("\n");
        fs.appendFileSync(gitignorePath, `${needsNewline ? "\n" : ""}${entry}\n`);
      }
    } catch {
      // Non-fatal — worst case the .pixa folder shows up as untracked in git status.
    }
  }

  /** Plain-English explanation dropped in .pixa/ so anyone who stumbles into
   * the folder via terminal/search understands what it is instead of
   * assuming something suspicious is happening to their codebase. */
  private writeReadmeIfMissing(): void {
    const readmePath = path.join(this.workspaceRoot, ".pixa", "README.md");
    if (fs.existsSync(readmePath)) return;
    try {
      fs.writeFileSync(
        readmePath,
        [
          "# .pixa/",
          "",
          "This folder is Pixa Agent's local search index — cached numeric",
          "representations (embeddings) of your code, used for semantic",
          "('search by meaning') code search inside the editor.",
          "",
          "- It never leaves your machine — everything here is generated and",
          "  read locally, nothing is uploaded.",
          "- It is safe to delete. Pixa will automatically rebuild it.",
          "- It is git-ignored and should never be committed.",
          "",
          "If a file inside here looks like gibberish or partial code",
          "fragments, that's expected — it's index data, not a copy of your",
          "repository.",
          "",
        ].join("\n")
      );
    } catch {
      // Non-fatal
    }
  }

  /**
   * Upserts a batch of chunks in a SINGLE transaction. This is the fix for
   * the slowness bug: LocalIndex rewrites its entire index.json to disk on
   * every insert/delete unless operations are wrapped in one
   * beginUpdate()/endUpdate() pair. Previously each chunk triggered its own
   * delete+insert (2 full-file rewrites per chunk); now a whole file's worth
   * of chunks costs exactly one disk write.
   */
  async upsertChunks(chunks: Chunk[]): Promise<void> {
    await this.ready;
    if (chunks.length === 0) return;

    const vectors = await embed(chunks.map((c) => c.text));

    await this.index.beginUpdate();
    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const vector = vectors[i];

        // upsertItem replaces in place if the id already exists — no
        // separate delete step needed (that was the old, slower pattern).
        await this.index.upsertItem({
          id: chunk.id,
          vector,
          metadata: chunkMetaFromChunk(chunk),
        });

        const set = this.fileToIds.get(chunk.filePath) ?? new Set<string>();
        set.add(chunk.id);
        this.fileToIds.set(chunk.filePath, set);
      }
      await this.index.endUpdate();
    } catch (e) {
      this.index.cancelUpdate();
      throw e;
    }
  }

  /**
   * Deletes all chunks belonging to a file, also in a single transaction
   * (was previously one deleteItem call — and therefore one disk rewrite —
   * per chunk).
   */
  /** Remove indexed chunks for paths that should never be embedded (e.g. stale .pixa/ data). */
  async purgeNonIndexableFiles(): Promise<number> {
    await this.ready;
    let purged = 0;
    for (const relPath of [...this.fileToIds.keys()]) {
      if (!isIndexablePath(relPath)) {
        await this.deleteChunksForFile(relPath);
        purged++;
      }
    }
    return purged;
  }

  async deleteChunksForFile(relPath: string): Promise<void> {
    await this.ready;
    const ids = this.fileToIds.get(relPath);
    if (!ids || ids.size === 0) return;

    await this.index.beginUpdate();
    try {
      for (const id of ids) {
        await this.index.deleteItem(id);
      }
      await this.index.endUpdate();
    } catch (e) {
      this.index.cancelUpdate();
      throw e;
    }
    this.fileToIds.delete(relPath);
  }

  /** Reads the actual current text for a chunk straight from disk, since we
   * no longer duplicate it into the index. Returns "" if the file no longer
   * exists or the line range is out of bounds. */
  private readTextForChunk(filePath: string, startLine: number, endLine: number): string {
    try {
      const abs = path.join(this.workspaceRoot, filePath);
      const content = fs.readFileSync(abs, "utf8");
      const lines = content.split(/\r?\n/);
      return lines.slice(startLine, endLine + 1).join("\n");
    } catch {
      return "";
    }
  }

  async query(text: string, topK = 10): Promise<QueryResult[]> {
    const diagnostics = await this.queryWithDiagnostics(text, topK);
    return diagnostics.results;
  }

  async queryWithDiagnostics(text: string, topK = 10): Promise<QueryDiagnostics> {
    await this.ready;
    const chunkCount = await this.size();
    const fetchK = Math.min(Math.max(topK * OVERFETCH_MULTIPLIER, OVERFETCH_MIN), Math.max(chunkCount, topK));
    const [vector] = await embed([text]);
    const results = await this.index.queryItems(vector, text, fetchK);

    const rawCandidates: QueryDiagnostics["rawCandidates"] = [];
    const filtered: QueryResult[] = [];

    for (const r of results) {
      const meta = r.item.metadata as unknown as ChunkMetadata;
      if (!isIndexablePath(meta.filePath)) continue;

      rawCandidates.push({
        filePath: meta.filePath,
        score: r.score,
        symbolName: meta.symbolName || null,
      });

      if (r.score < RELEVANCE_THRESHOLD || filtered.length >= topK) continue;

      filtered.push({
        filePath: meta.filePath,
        startLine: meta.startLine,
        endLine: meta.endLine,
        symbolName: meta.symbolName || null,
        symbolKind: meta.symbolKind || null,
        text: this.readTextForChunk(meta.filePath, meta.startLine, meta.endLine),
        score: r.score,
      });
    }

    return {
      chunkCount,
      threshold: RELEVANCE_THRESHOLD,
      results: filtered,
      rawCandidates: rawCandidates.slice(0, topK),
    };
  }

  /** Workspace-relative paths that currently have at least one indexed chunk. */
  async listIndexedFiles(): Promise<string[]> {
    await this.ready;
    return [...this.fileToIds.keys()].filter(isIndexablePath).sort();
  }

  async isFileIndexed(relPath: string): Promise<boolean> {
    await this.ready;
    const ids = this.fileToIds.get(relPath);
    return !!ids && ids.size > 0;
  }

  /** Total chunk count currently stored — useful for tests and progress reporting. */
  async size(): Promise<number> {
    await this.ready;
    const items = await this.index.listItems();
    return items.length;
  }
}