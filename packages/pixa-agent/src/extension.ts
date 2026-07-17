import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadModels, ProviderRegistry } from "./providers/registry";
import { OpenRouterProvider } from "./providers/openrouter";
import { LocalEmbeddingsProvider, initEmbeddingCache, prewarmEmbeddingModel } from "./providers/embeddings";
import { ToolRegistry, registerBuiltinTools } from "./tools/registry";
import { ChangeSet } from "./edits/changeSet";
import { EmbeddingIndex } from "./indexer/embeddingIndex";
import { VectorStore } from "./indexer/vectorStore";
import { indexWorkspaceWithProgress, registerIncrementalIndexing } from "./indexer/indexingPipeline";
import { runAndSaveBenchmark } from "./indexer/recallBenchmark";
import { DiffPreview } from "./ui/diffPreview";
import { ChatViewProvider } from "./ui/chatViewProvider";
import { McpManager } from "./mcp/manager";
import type { McpServerConfig } from "./mcp/client";
import { DEFAULT_GATEWAY_URL, GATEWAY_TOKEN_SECRET } from "./config";

async function hidePixaFolderFromExplorer(workspaceRoot: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === workspaceRoot);
  const config = vscode.workspace.getConfiguration("files", folder?.uri);
  const current = config.get<Record<string, boolean>>("exclude") ?? {};
  if (current[".pixa"] === true) return;
  await config.update("exclude", { ...current, ".pixa": true }, vscode.ConfigurationTarget.WorkspaceFolder);
}

function resolveGatewayUrl(): string {
  const configured = vscode.workspace.getConfiguration("pixa").get<string>("gatewayUrl")?.trim();
  return configured || DEFAULT_GATEWAY_URL;
}

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const indexOutput = vscode.window.createOutputChannel("Pixa Index");
  context.subscriptions.push(indexOutput);
  const log = (msg: string) => indexOutput.appendLine(`[${new Date().toISOString()}] ${msg}`);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("pixa.setGatewayToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "Enter your Pixa gateway auth token (stored in VS Code secret storage)",
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await context.secrets.store(GATEWAY_TOKEN_SECRET, token.trim());
        void vscode.window.showInformationMessage("Pixa: gateway token saved.");
      }
    })
  );

  if (!workspaceRoot) {
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider("pixa.chat", {
        resolveWebviewView(view) {
          view.webview.html =
            "<html><body><p style='font-family:sans-serif;padding:8px'>Open a folder to use Pixa Agent.</p></body></html>";
        },
      })
    );
    return;
  }

  log(`Activating for workspace: ${workspaceRoot}`);
  void hidePixaFolderFromExplorer(workspaceRoot);

  const modelsPath = path.join(context.extensionPath, "dist", "models.json");
  const models = loadModels(fs.readFileSync(modelsPath, "utf8"));
  const providers = new ProviderRegistry();
  const openRouter = new OpenRouterProvider(resolveGatewayUrl(), () =>
    context.secrets.get(GATEWAY_TOKEN_SECRET) as Promise<string | undefined>
  );
  providers.register(openRouter);
  providers.register(new LocalEmbeddingsProvider());

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("pixa.gatewayUrl")) {
        openRouter.setGatewayUrl(resolveGatewayUrl());
      }
    })
  );

  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  initEmbeddingCache(context.globalStorageUri.fsPath);
  log(`Embedding model cache dir: ${context.globalStorageUri.fsPath}`);

  void prewarmEmbeddingModel((err) => log(`Embedding model prewarm failed (will retry lazily on first use): ${err}`));

  const tools = new ToolRegistry();
  registerBuiltinTools(tools);

  const mcpOutput = vscode.window.createOutputChannel("Pixa MCP");
  const mcpManager = new McpManager((m) => mcpOutput.appendLine(m));
  const mcpServers = vscode.workspace.getConfiguration("pixa").get<Record<string, McpServerConfig>>("mcpServers") ?? {};
  void mcpManager.connectAll(mcpServers, tools);
  context.subscriptions.push(mcpOutput, { dispose: () => mcpManager.dispose() });

  const changeSet = new ChangeSet();

  const vectorStore = new VectorStore(workspaceRoot);
  const index = new EmbeddingIndex(workspaceRoot, vectorStore);

  log("VectorStore constructed — .pixa/index/ should now exist on disk.");

  const runInitialIndex = async () => {
    statusBar.text = "$(sync~spin) Pixa: indexing…";
    statusBar.tooltip = "Pixa is building its semantic search index for this workspace.";
    statusBar.show();
    try {
      const result = await indexWorkspaceWithProgress(workspaceRoot, vectorStore);
      log(
        `Initial index complete: ${result.filesIndexed} file(s) processed, ${result.filesSkipped} unchanged (skipped), ${result.chunksIndexed} chunk(s) written.`
      );
      statusBar.text = `$(check) Pixa: index ready (${result.filesIndexed} indexed, ${result.filesSkipped} skipped)`;
      setTimeout(() => statusBar.hide(), 5000);
    } catch (err: any) {
      log(`Initial index FAILED: ${err?.stack ?? err}`);
      statusBar.text = "$(error) Pixa: indexing failed";
      statusBar.tooltip = "See the \"Pixa Index\" output channel for details.";
      void vscode.window.showErrorMessage(
        `Pixa: initial semantic index failed — see "Pixa Index" output channel for details. (${err?.message ?? err})`
      );
    }
  };
  void runInitialIndex();

  registerIncrementalIndexing(context, workspaceRoot, vectorStore);

  context.subscriptions.push(
    vscode.commands.registerCommand("pixa.rebuildSemanticIndex", async () => {
      log("Manual rebuild triggered.");
      await runInitialIndex();
      void vscode.window.showInformationMessage("Pixa: semantic index rebuilt.");
    }),
    vscode.commands.registerCommand("pixa.runRecallBenchmark", async () => {
      await runAndSaveBenchmark(workspaceRoot, vectorStore);
    })
  );

  // TEMPORARY DEBUG COMMAND — remove once confirmed working. Bypasses the
  // LLM entirely, talks straight to the vector store: no cost, no rate limit.
  context.subscriptions.push(
    vscode.commands.registerCommand("pixa.debugSemanticSearch", async () => {
      const testQuery = await vscode.window.showInputBox({
        prompt: "Test query for semantic search (debug, bypasses the LLM)",
        value: "retry backoff exponential wait",
      });
      if (!testQuery) return;

      log(`[DEBUG] Running test query: "${testQuery}"`);
      try {
        const chunkCount = await vectorStore.size();
        log(`[DEBUG] Total chunks currently in index: ${chunkCount}`);
        if (chunkCount === 0) {
          log(`[DEBUG] Index is EMPTY. Indexing may still be running, or failed. Check the log above for "Initial index complete" or "FAILED".`);
          void vscode.window.showWarningMessage("Pixa debug: index is empty (0 chunks). See \"Pixa Index\" output.");
          return;
        }

        const start = Date.now();
        const diagnostics = await vectorStore.queryWithDiagnostics(testQuery, 5);
        const ms = Date.now() - start;
        const results = diagnostics.results;

        log(`[DEBUG] Model responded in ${ms}ms. ${results.length} result(s) above the ${diagnostics.threshold} relevance threshold.`);
        if (results.length === 0) {
          log(`[DEBUG] Zero results above threshold. Raw top candidates before threshold:`);
          for (const r of diagnostics.rawCandidates) {
            log(`[DEBUG]   raw score=${r.score.toFixed(3)}  ${r.filePath}  (${r.symbolName ?? "unnamed"})`);
          }
          if (diagnostics.rawCandidates.length === 0) {
            log(`[DEBUG] No candidates at all — index may be empty or query embedding failed.`);
          }
        }
        for (const r of results) {
          log(`[DEBUG]   score=${r.score.toFixed(3)}  ${r.filePath}:${r.startLine + 1}-${r.endLine + 1}  (${r.symbolName ?? "unnamed"})`);
        }

        void vscode.window.showInformationMessage(
          `Pixa debug: responded in ${ms}ms, ${results.length} result(s), ${chunkCount} chunks indexed. See "Pixa Index" output for details.`
        );
      } catch (err: any) {
        log(`[DEBUG] Semantic search THREW: ${err?.stack ?? err}`);
        void vscode.window.showErrorMessage(`Pixa debug: query failed — ${err?.message ?? err}. See output channel.`);
      }
    })
  );

  const diffPreview = new DiffPreview(changeSet);
  diffPreview.register(context);

  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  let debounce: NodeJS.Timeout | undefined;
  const invalidate = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => index.refresh(), 2000);
  };
  watcher.onDidCreate(invalidate);
  watcher.onDidDelete(invalidate);
  context.subscriptions.push(watcher);

  const chatProvider = new ChatViewProvider(
    context,
    providers,
    tools,
    models,
    changeSet,
    index,
    diffPreview,
    workspaceRoot
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("pixa.chat", chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("pixa.newSession", () => chatProvider.newSession())
  );
}

export function deactivate(): void {}
