import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { runRipgrep } from "../tools/search";
import type { VectorStore } from "./vectorStore";

export interface BenchmarkQuery {
    /** A natural-language question, e.g. "where do we handle retries with backoff". */
    query: string;
    /** Workspace-relative path of the file that actually answers this query. */
    expectedFile: string;
    /** Optional: only counted correct if the expected file appears AND this line range overlaps. */
    expectedLineHint?: number;
}

interface BenchmarkRow {
    query: string;
    expectedFile: string;
    ripgrepHit: boolean;
    semanticHit: boolean;
    ripgrepTopFiles: string[];
    semanticTopFiles: string[];
    expectedFileIndexed: boolean;
    semanticRawTop: Array<{ filePath: string; score: number }>;
}

export interface BenchmarkReport {
    rows: BenchmarkRow[];
    ripgrepRecallAtK: number;
    semanticRecallAtK: number;
    topK: number;
    chunkCount: number;
    relevanceThreshold: number;
}

const DEFAULT_QUERIES_RELATIVE_PATH = ".pixa/benchmark-queries.json";
const REPORT_RELATIVE_PATH = ".pixa/benchmark-report.md";

/** Sample starter file written if the user doesn't have one yet — replace with real queries about your own repo. */
const SAMPLE_QUERIES: BenchmarkQuery[] = [
    {
        query: "where do we handle retries or exponential backoff",
        expectedFile: "REPLACE_ME/example.ts",
    },
    {
        query: "where is the user authentication token validated",
        expectedFile: "REPLACE_ME/example.ts",
    },
];

export function loadOrCreateQueries(workspaceRoot: string): { queries: BenchmarkQuery[]; created: boolean } {
    const filePath = path.join(workspaceRoot, DEFAULT_QUERIES_RELATIVE_PATH);
    if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        return { queries: JSON.parse(raw) as BenchmarkQuery[], created: false };
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(SAMPLE_QUERIES, null, 2));
    return { queries: SAMPLE_QUERIES, created: true };
}

/** Baseline: run the query text as a literal ripgrep pattern, same as search_workspace does. */
async function ripgrepTopFiles(workspaceRoot: string, query: string, topK: number): Promise<string[]> {
    const args = ["-n", "--no-heading", "--max-count", "50", "--glob", "!.pixa/**", "-e", query, "."];
    const { code, out } = await runRipgrep(workspaceRoot, args);
    if (code > 1 || !out.trim()) return [];

    const files: string[] = [];
    const seen = new Set<string>();
    for (const line of out.trim().split("\n")) {
        // ripgrep -n output format: "path:lineNumber:matchText"
        const idx = line.indexOf(":");
        if (idx === -1) continue;
        const file = line.slice(0, idx).replace(/^\.\//, "");
        if (!seen.has(file)) {
            seen.add(file);
            files.push(file);
        }
        if (files.length >= topK) break;
    }
    return files;
}

async function semanticTopFiles(vectorStore: VectorStore, query: string, topK: number) {
    const diagnostics = await vectorStore.queryWithDiagnostics(query, topK);
    const files: string[] = [];
    const seen = new Set<string>();
    for (const r of diagnostics.results) {
        if (!seen.has(r.filePath)) {
            seen.add(r.filePath);
            files.push(r.filePath);
        }
    }

    const rawFiles: string[] = [];
    const rawSeen = new Set<string>();
    for (const candidate of diagnostics.rawCandidates) {
        if (!rawSeen.has(candidate.filePath)) {
            rawSeen.add(candidate.filePath);
            rawFiles.push(candidate.filePath);
        }
    }

    return {
        files,
        rawTop: diagnostics.rawCandidates.map((c) => ({
            filePath: c.filePath,
            score: c.score,
        })),
        rawTopFiles: rawFiles,
        threshold: diagnostics.threshold,
        chunkCount: diagnostics.chunkCount,
    };
}

export async function runRecallBenchmark(
    workspaceRoot: string,
    vectorStore: VectorStore,
    queries: BenchmarkQuery[],
    topK = 5
): Promise<BenchmarkReport> {
    const rows: BenchmarkRow[] = [];
    let chunkCount = 0;
    let relevanceThreshold = 0;

    for (const q of queries) {
        const [ripgrepFiles, semantic] = await Promise.all([
            ripgrepTopFiles(workspaceRoot, q.query, topK),
            semanticTopFiles(vectorStore, q.query, topK),
        ]);
        chunkCount = semantic.chunkCount;
        relevanceThreshold = semantic.threshold;
        const expectedFileIndexed = await vectorStore.isFileIndexed(q.expectedFile);

        rows.push({
            query: q.query,
            expectedFile: q.expectedFile,
            ripgrepHit: ripgrepFiles.includes(q.expectedFile),
            semanticHit: semantic.files.includes(q.expectedFile),
            ripgrepTopFiles: ripgrepFiles,
            semanticTopFiles: semantic.files,
            expectedFileIndexed,
            semanticRawTop: semantic.rawTop,
        });
    }

    const ripgrepHits = rows.filter((r) => r.ripgrepHit).length;
    const semanticHits = rows.filter((r) => r.semanticHit).length;

    return {
        rows,
        ripgrepRecallAtK: rows.length ? ripgrepHits / rows.length : 0,
        semanticRecallAtK: rows.length ? semanticHits / rows.length : 0,
        topK,
        chunkCount,
        relevanceThreshold,
    };
}

export function renderReportMarkdown(report: BenchmarkReport): string {
    const lines: string[] = [];
    lines.push(`# Retrieval recall benchmark (top-${report.topK})`);
    lines.push("");
    lines.push(`**Indexed chunks:** ${report.chunkCount}`);
    lines.push(`**Relevance threshold:** ${report.relevanceThreshold}`);
    lines.push("");
    lines.push(
        `**ripgrep (baseline) recall@${report.topK}:** ${(report.ripgrepRecallAtK * 100).toFixed(0)}%  `
    );
    lines.push(
        `**semantic_search recall@${report.topK}:** ${(report.semanticRecallAtK * 100).toFixed(0)}%`
    );
    lines.push("");
    lines.push("| Query | Expected file | ripgrep hit? | semantic hit? |");
    lines.push("|---|---|---|---|");
    for (const row of report.rows) {
        lines.push(
            `| ${row.query} | \`${row.expectedFile}\` | ${row.ripgrepHit ? "✅" : "❌"} | ${row.semanticHit ? "✅" : "❌"} |`
        );
    }
    lines.push("");
    lines.push("## Detail (top files returned per query)");
    for (const row of report.rows) {
        lines.push("");
        lines.push(`### ${row.query}`);
        lines.push(`Expected: \`${row.expectedFile}\``);
        lines.push(`- expected file indexed: ${row.expectedFileIndexed ? "yes" : "no"}`);
        lines.push(`- ripgrep top files: ${row.ripgrepTopFiles.map((f) => `\`${f}\``).join(", ") || "(none)"}`);
        lines.push(`- semantic top files: ${row.semanticTopFiles.map((f) => `\`${f}\``).join(", ") || "(none)"}`);
        if (row.semanticTopFiles.length === 0 && row.semanticRawTop.length > 0) {
            lines.push(
                `- semantic raw top (below threshold?): ${row.semanticRawTop
                    .map((r) => `\`${r.filePath}\` (${r.score.toFixed(3)})`)
                    .join(", ")}`
            );
        }
    }
    return lines.join("\n");
}

/** Runs the benchmark end-to-end and writes the report to .pixa/benchmark-report.md, opening it in the editor. */
export async function runAndSaveBenchmark(workspaceRoot: string, vectorStore: VectorStore): Promise<void> {
    const { queries, created } = loadOrCreateQueries(workspaceRoot);

    if (created) {
        const filePath = path.join(workspaceRoot, DEFAULT_QUERIES_RELATIVE_PATH);
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
        void vscode.window.showInformationMessage(
            `Pixa: created ${DEFAULT_QUERIES_RELATIVE_PATH} with sample queries. Edit it with real queries/expected files for your repo, then run the benchmark again.`
        );
        return;
    }

    const purged = await vectorStore.purgeNonIndexableFiles();
    if (purged > 0) {
      void vscode.window.showInformationMessage(
        `Pixa: removed ${purged} stale .pixa file(s) from the semantic index before benchmarking.`
      );
    }

    const chunkCount = await vectorStore.size();
    if (chunkCount === 0) {
      void vscode.window.showWarningMessage(
        'Pixa: semantic index is empty. Run "Pixa: Rebuild Semantic Index" first, then re-run the benchmark.'
      );
      return;
    }

    const report = await runRecallBenchmark(workspaceRoot, vectorStore, queries);
    const markdown = renderReportMarkdown(report);

    const reportPath = path.join(workspaceRoot, REPORT_RELATIVE_PATH);
    fs.writeFileSync(reportPath, markdown);

    const doc = await vscode.workspace.openTextDocument(reportPath);
    await vscode.window.showTextDocument(doc, { preview: false });
}