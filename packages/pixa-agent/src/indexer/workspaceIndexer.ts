import * as vscode from "vscode";
import * as path from "node:path";
import type { RepoIndex } from "./types";
import { resolveInWorkspace } from "../tools/paths";

export { isIndexablePath } from "./indexablePaths";

export const MAX_FILES = 5000;
const MAP_CHAR_CAP = 8000; // ~2000 tokens
const COLLAPSE_THRESHOLD = 20;
export const EXCLUDE = "**/{node_modules,.git,dist,out,build,.next,coverage,__pycache__,.venv,target,.pixa}/**";

/**
 * V1 index backend: fast workspace scan for the project map plus VS Code's
 * language-server symbol providers for per-file outlines. A future
 * embedding/vector backend implements the same RepoIndex interface.
 */
export class WorkspaceIndexer implements RepoIndex {
  private mapCache: string | null = null;

  constructor(private workspaceRoot: string) { }

  refresh(): void {
    this.mapCache = null;
  }

  async getProjectMap(): Promise<string> {
    if (this.mapCache) return this.mapCache;
    const uris = await vscode.workspace.findFiles("**/*", EXCLUDE, MAX_FILES);
    const relPaths = uris
      .map((u) => path.relative(this.workspaceRoot, u.fsPath).split(path.sep).join("/"))
      .filter((p) => p && !p.startsWith(".."))
      .sort();

    this.mapCache = renderTree(relPaths);
    return this.mapCache;
  }

  async getFileOutline(relPath: string): Promise<string> {
    const abs = resolveInWorkspace(this.workspaceRoot, relPath);
    const uri = vscode.Uri.file(abs);
    let symbols: vscode.DocumentSymbol[] | undefined;
    try {
      symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri
      );
    } catch {
      symbols = undefined;
    }
    if (!symbols || symbols.length === 0) {
      return `No symbols available for ${relPath} (no language support or empty file). Use read_file instead.`;
    }
    const lines: string[] = [];
    renderSymbols(symbols, 0, lines);
    return lines.slice(0, 200).join("\n");
  }
}

function renderSymbols(symbols: vscode.DocumentSymbol[], depth: number, out: string[]): void {
  for (const s of symbols) {
    out.push(
      `${"  ".repeat(depth)}${vscode.SymbolKind[s.kind].toLowerCase()} ${s.name} — line ${s.range.start.line + 1}`
    );
    if (s.children?.length) renderSymbols(s.children, depth + 1, out);
  }
}

interface TreeDir {
  dirs: Map<string, TreeDir>;
  files: string[];
}

/** Render a compact tree; directories with many entries are collapsed to a count. */
export function renderTree(relPaths: string[]): string {
  const root: TreeDir = { dirs: new Map(), files: [] };
  for (const p of relPaths) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { dirs: new Map(), files: [] };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.push(parts[parts.length - 1]);
  }

  const lines: string[] = [];
  const walk = (node: TreeDir, prefix: string, depth: number) => {
    const entryCount = node.dirs.size + node.files.length;
    if (depth > 0 && entryCount > COLLAPSE_THRESHOLD) {
      lines.push(`${prefix}… (${countFiles(node)} files)`);
      return;
    }
    for (const [name, child] of [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${prefix}${name}/`);
      walk(child, prefix + "  ", depth + 1);
    }
    for (const f of node.files.sort()) {
      lines.push(`${prefix}${f}`);
    }
  };
  walk(root, "", 0);

  let text = lines.join("\n");
  if (text.length > MAP_CHAR_CAP) {
    text = text.slice(0, MAP_CHAR_CAP) + "\n… (project map truncated — use list_directory / search_workspace to explore further)";
  }
  return text || "(empty workspace)";
}

function countFiles(node: TreeDir): number {
  let n = node.files.length;
  for (const child of node.dirs.values()) n += countFiles(child);
  return n;
}