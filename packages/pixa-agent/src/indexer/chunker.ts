import * as vscode from "vscode";
import * as crypto from "node:crypto";
import { estimateTokens } from "../agent/contextManager";

export interface Chunk {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName: string | null;
  symbolKind: string | null;
  text: string;
}

function computeHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function chunkFile(
  relPath: string,
  content: string,
  symbols: vscode.DocumentSymbol[]
): Chunk[] {
  const lines = content.split(/\r?\n/);
  const N = lines.length;

  if (symbols.length > 0) {
    const chunks: Chunk[] = [];

    const processSymbol = (symbol: vscode.DocumentSymbol): void => {
      const start = symbol.range.start.line;
      const end = Math.min(symbol.range.end.line, N - 1);
      const text = lines.slice(start, end + 1).join("\n");
      const tokens = estimateTokens(text);

      if (tokens > 400 && symbol.children && symbol.children.length > 0) {
        for (const child of symbol.children) {
          processSymbol(child);
        }
      } else {
        const id = computeHash(`${relPath}:${start}:${end}`);
        chunks.push({
          id,
          filePath: relPath,
          startLine: start,
          endLine: end,
          symbolName: symbol.name,
          symbolKind: vscode.SymbolKind[symbol.kind] ? vscode.SymbolKind[symbol.kind].toString() : null,
          text,
        });
      }
    };

    for (const symbol of symbols) {
      processSymbol(symbol);
    }

    return chunks;
  } else {
    // If symbols.length === 0: split content into 50-line windows with 10-line overlap.
    const chunks: Chunk[] = [];
    if (N === 0 || (N === 1 && lines[0] === "")) {
      return chunks;
    }

    const windowSize = 50;
    const overlap = 10;
    const step = windowSize - overlap; // 40

    for (let startLine = 0; startLine < N; startLine += step) {
      const endLine = Math.min(startLine + windowSize - 1, N - 1);
      const text = lines.slice(startLine, endLine + 1).join("\n");
      const id = computeHash(`${relPath}:${startLine}:${endLine}`);
      chunks.push({
        id,
        filePath: relPath,
        startLine,
        endLine,
        symbolName: null,
        symbolKind: null,
        text,
      });
    }

    return chunks;
  }
}
