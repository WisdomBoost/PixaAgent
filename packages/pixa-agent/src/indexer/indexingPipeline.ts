import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { EXCLUDE, MAX_FILES, isIndexablePath } from "./workspaceIndexer";
import { chunkFile } from "./chunker";
import type { VectorStore } from "./vectorStore";
import { resolveInWorkspace } from "../tools/paths";
import { redactSecrets } from "../security/redact";

/** Files larger than this are skipped entirely. */
const MAX_FILE_SIZE_BYTES = 500 * 1024;

/** Tracks each file's mtime+size so unchanged files are skipped on the next run. */
const MANIFEST_RELATIVE_PATH = path.join(".pixa", "index-manifest.json");

interface ManifestEntry {
  mtimeMs: number;
  size: number;
}
type Manifest = Record<string, ManifestEntry>;

function loadManifest(workspaceRoot: string): Manifest {
  const manifestPath = path.join(workspaceRoot, MANIFEST_RELATIVE_PATH);
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return {};
  }
}

function saveManifest(workspaceRoot: string, manifest: Manifest): void {
  const manifestPath = path.join(workspaceRoot, MANIFEST_RELATIVE_PATH);
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  } catch {
    // Non-fatal
  }
}

async function getSymbolsForFile(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
  try {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      uri
    );
    return symbols ?? [];
  } catch {
    return [];
  }
}

async function indexOneFile(
  workspaceRoot: string,
  relPath: string,
  vectorStore: VectorStore
): Promise<number> {
  const abs = resolveInWorkspace(workspaceRoot, relPath);

  let content: string;
  try {
    content = fs.readFileSync(abs, "utf8");
  } catch {
    return 0;
  }

  const uri = vscode.Uri.file(abs);
  const symbols = await getSymbolsForFile(uri);
  const chunks = chunkFile(relPath, content, symbols).map((c) => ({
    ...c,
    text: redactSecrets(c.text),
  }));

  if (chunks.length > 0) {
    await vectorStore.upsertChunks(chunks);
  }
  return chunks.length;
}

export async function indexWorkspace(
  workspaceRoot: string,
  vectorStore: VectorStore,
  onProgress?: (message: string, fraction: number) => void
): Promise<{ filesIndexed: number; filesSkipped: number; chunksIndexed: number }> {
  await vectorStore.purgeNonIndexableFiles();

  const uris = await vscode.workspace.findFiles("**/*", EXCLUDE, MAX_FILES);
  const relPaths = uris
    .map((u) => path.relative(workspaceRoot, u.fsPath).split(path.sep).join("/"))
    .filter((p) => isIndexablePath(p));

  const manifest = loadManifest(workspaceRoot);
  for (const relPath of Object.keys(manifest)) {
    if (!isIndexablePath(relPath)) {
      delete manifest[relPath];
    }
  }
  const seenPaths = new Set<string>();

  let filesIndexed = 0;
  let filesSkipped = 0;
  let chunksIndexed = 0;

  for (let i = 0; i < relPaths.length; i++) {
    const relPath = relPaths[i];
    seenPaths.add(relPath);

    const abs = resolveInWorkspace(workspaceRoot, relPath);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      onProgress?.(relPath, (i + 1) / relPaths.length);
      continue;
    }

    const existing = manifest[relPath];
    const unchanged = existing && existing.mtimeMs === stat.mtimeMs && existing.size === stat.size;

    if (unchanged) {
      filesSkipped++;
      onProgress?.(relPath, (i + 1) / relPaths.length);
      continue;
    }

    if (stat.size > MAX_FILE_SIZE_BYTES) {
      filesIndexed++;
      onProgress?.(relPath, (i + 1) / relPaths.length);
      continue;
    }

    const count = await indexOneFile(workspaceRoot, relPath, vectorStore);
    chunksIndexed += count;
    filesIndexed++;
    manifest[relPath] = { mtimeMs: stat.mtimeMs, size: stat.size };
    onProgress?.(relPath, (i + 1) / relPaths.length);
  }

  for (const knownPath of Object.keys(manifest)) {
    if (!seenPaths.has(knownPath)) {
      await vectorStore.deleteChunksForFile(knownPath);
      delete manifest[knownPath];
    }
  }

  saveManifest(workspaceRoot, manifest);

  return { filesIndexed, filesSkipped, chunksIndexed };
}

export async function indexWorkspaceWithProgress(
  workspaceRoot: string,
  vectorStore: VectorStore
): Promise<{ filesIndexed: number; filesSkipped: number; chunksIndexed: number }> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Pixa: indexing workspace for semantic search",
      cancellable: false,
    },
    async (progress) => {
      let lastFraction = 0;
      return indexWorkspace(workspaceRoot, vectorStore, (relPath, fraction) => {
        const increment = (fraction - lastFraction) * 100;
        lastFraction = fraction;
        progress.report({ increment, message: relPath });
      });
    }
  );
}

export async function indexFile(
  workspaceRoot: string,
  vectorStore: VectorStore,
  relPath: string
): Promise<void> {
  await vectorStore.deleteChunksForFile(relPath);

  if (!isIndexablePath(relPath)) {
    const manifest = loadManifest(workspaceRoot);
    if (manifest[relPath]) {
      delete manifest[relPath];
      saveManifest(workspaceRoot, manifest);
    }
    return;
  }

  const abs = resolveInWorkspace(workspaceRoot, relPath);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    const manifest = loadManifest(workspaceRoot);
    if (manifest[relPath]) {
      delete manifest[relPath];
      saveManifest(workspaceRoot, manifest);
    }
    return;
  }

  await indexOneFile(workspaceRoot, relPath, vectorStore);

  const manifest = loadManifest(workspaceRoot);
  manifest[relPath] = { mtimeMs: stat.mtimeMs, size: stat.size };
  saveManifest(workspaceRoot, manifest);
}

export function registerIncrementalIndexing(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  vectorStore: VectorStore
): void {
  const pending = new Map<string, NodeJS.Timeout>();
  const DEBOUNCE_MS = 1500;

  const disposable = vscode.workspace.onDidSaveTextDocument((doc) => {
    const relPath = path.relative(workspaceRoot, doc.uri.fsPath).split(path.sep).join("/");
    if (!isIndexablePath(relPath)) return;

    const existing = pending.get(relPath);
    if (existing) clearTimeout(existing);

    pending.set(
      relPath,
      setTimeout(() => {
        pending.delete(relPath);
        void indexFile(workspaceRoot, vectorStore, relPath);
      }, DEBOUNCE_MS)
    );
  });

  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  watcher.onDidDelete((uri) => {
    const relPath = path.relative(workspaceRoot, uri.fsPath).split(path.sep).join("/");
    if (relPath && !relPath.startsWith("..")) {
      void vectorStore.deleteChunksForFile(relPath);
      const manifest = loadManifest(workspaceRoot);
      if (manifest[relPath]) {
        delete manifest[relPath];
        saveManifest(workspaceRoot, manifest);
      }
    }
  });

  context.subscriptions.push(disposable, watcher);
}