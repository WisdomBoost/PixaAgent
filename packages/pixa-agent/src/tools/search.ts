import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { QueryResult } from "../indexer/vectorStore";
import type { Tool } from "./types";

/** Locate ripgrep: prefer the binary VS Code ships, fall back to PATH. */
export function findRipgrep(): string {
  try {
    // Lazy require so unit tests / non-vscode contexts don't explode.
    const vscode = require("vscode");
    const bundled = path.join(
      vscode.env.appRoot,
      "node_modules",
      "@vscode/ripgrep",
      "bin",
      process.platform === "win32" ? "rg.exe" : "rg"
    );
    if (fs.existsSync(bundled)) return bundled;
    const bundledLegacy = path.join(
      vscode.env.appRoot,
      "node_modules.asar.unpacked",
      "@vscode/ripgrep",
      "bin",
      process.platform === "win32" ? "rg.exe" : "rg"
    );
    if (fs.existsSync(bundledLegacy)) return bundledLegacy;
  } catch {
    // not running inside vscode
  }
  return "rg";
}

export function runRipgrep(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      findRipgrep(),
      args,
      { cwd, maxBuffer: 2 * 1024 * 1024, timeout: 30_000, windowsHide: true },
      (err, stdout, stderr) => {
        const rawCode: unknown = err ? (err as NodeJS.ErrnoException).code ?? 1 : 0;
        resolve({ code: typeof rawCode === "number" ? rawCode : 1, out: stdout || stderr || "" });
      }
    );
  });
}

const searchWorkspace: Tool = {
  schema: {
    name: "search_workspace",
    description:
      "Search file contents across the workspace with a regular expression (ripgrep syntax). Returns matching lines with file:line prefixes. Best for exact strings, symbol names, or literal text. For conceptual queries ('where do we handle retries'), try semantic_search instead if available.",
    parameters: {
      type: "object",
      properties: {
        regex: { type: "string", description: "Regular expression to search for" },
        glob: { type: "string", description: "Optional file glob filter, e.g. '*.ts' or 'src/**'" },
      },
      required: ["regex"],
    },
  },
  async execute(args: { regex: string; glob?: string }, ctx) {
    const rgArgs = ["-n", "--no-heading", "--max-count", "50", "--max-columns", "300", "-e", args.regex];
    if (args.glob) rgArgs.push("--glob", args.glob);
    rgArgs.push(".");
    const { code, out } = await runRipgrep(ctx.workspaceRoot, rgArgs);
    if (code === 1 && !out.trim()) return "No matches found.";
    if (code > 1) return `Error: search failed: ${out.slice(0, 300)}`;
    const lines = out.trim().split("\n");
    const capped = lines.slice(0, 200);
    return capped.join("\n") + (lines.length > 200 ? `\n… (${lines.length - 200} more matches)` : "");
  },
};

const getProjectMap: Tool = {
  schema: {
    name: "get_project_map",
    description: "Get a compact tree of the workspace's files and folders. Use this first to orient yourself.",
    parameters: { type: "object", properties: {} },
  },
  async execute(_args, ctx) {
    return ctx.index.getProjectMap();
  },
};

const getFileOutline: Tool = {
  schema: {
    name: "get_file_outline",
    description: "Get the symbol outline (classes, functions, methods with line numbers) of a source file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative file path" },
      },
      required: ["path"],
    },
  },
  async execute(args: { path: string }, ctx) {
    return ctx.index.getFileOutline(args.path);
  },
};

interface SemanticSearchArgs {
  query: string;
}

function hasSemanticQuery(
  index: unknown
): index is {
  query(text: string, topK?: number): Promise<QueryResult[]>;
  chunkCount?(): Promise<number>;
} {
  return !!index && typeof (index as { query?: unknown }).query === "function";
}

const semanticSearch: Tool = {
  schema: {
    name: "semantic_search",
    description:
      "Search code by meaning/concept rather than exact text. Use for conceptual questions a keyword search would miss, e.g. 'where do we handle retries' or 'where is the auth token validated'. For exact strings, symbol names, or literal text, use search_workspace instead.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A natural-language description of the code you're looking for.",
        },
      },
      required: ["query"],
    },
  },
  async execute(args: SemanticSearchArgs, ctx) {
    if (!args?.query || typeof args.query !== "string" || !args.query.trim()) {
      return "Error: 'query' is required.";
    }

    if (!hasSemanticQuery(ctx.index)) {
      return "Semantic search is not enabled for this workspace. Use search_workspace instead.";
    }

    if (ctx.index.chunkCount) {
      const count = await ctx.index.chunkCount();
      if (count === 0) {
        return "Semantic index is empty or still building. Use search_workspace for exact text matches, or wait for indexing to finish (see the Pixa status bar).";
      }
    }

    let results: QueryResult[];
    try {
      results = await ctx.index.query(args.query, 10);
    } catch (e) {
      return `Error: semantic search failed: ${(e as Error).message}`;
    }

    if (results.length === 0) {
      return "No relevant results found. Try rephrasing the query or use search_workspace for exact text.";
    }

    return results
      .map((r) => {
        const label = r.symbolName ? r.symbolName : "unnamed region";
        return `${r.filePath}:${r.startLine + 1}-${r.endLine + 1} (${label}, score ${r.score.toFixed(2)})\n${r.text}`;
      })
      .join("\n\n");
  },
};

export const searchTools: Tool[] = [searchWorkspace, semanticSearch, getProjectMap, getFileOutline];