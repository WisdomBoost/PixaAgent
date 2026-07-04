import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadModels, ProviderRegistry } from "./providers/registry";
import { OpenRouterProvider } from "./providers/openrouter";
import { ToolRegistry, registerBuiltinTools } from "./tools/registry";
import { ChangeSet } from "./edits/changeSet";
import { WorkspaceIndexer } from "./indexer/workspaceIndexer";
import { DiffPreview } from "./ui/diffPreview";
import { ChatViewProvider } from "./ui/chatViewProvider";
import { McpManager } from "./mcp/manager";
import type { McpServerConfig } from "./mcp/client";

const API_KEY_SECRET = "pixa.openrouter.apiKey";

export function activate(context: vscode.ExtensionContext): void {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  context.subscriptions.push(
    vscode.commands.registerCommand("pixa.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        prompt: "Enter your OpenRouter API key (stored in VS Code secret storage)",
        password: true,
        ignoreFocusOut: true,
      });
      if (key) {
        await context.secrets.store(API_KEY_SECRET, key.trim());
        void vscode.window.showInformationMessage("Pixa: OpenRouter API key saved.");
      }
    })
  );

  if (!workspaceRoot) {
    // No folder open: register a placeholder view so the sidebar explains itself.
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

  // Model registry — data-driven; adding models/providers never touches this file beyond registration.
  const modelsPath = path.join(context.extensionPath, "dist", "models.json");
  const models = loadModels(fs.readFileSync(modelsPath, "utf8"));
  const providers = new ProviderRegistry();
  providers.register(new OpenRouterProvider(() => context.secrets.get(API_KEY_SECRET) as Promise<string | undefined>));

  const tools = new ToolRegistry();
  registerBuiltinTools(tools);

  // MCP servers: their tools land in the same registry the agent already uses.
  const mcpOutput = vscode.window.createOutputChannel("Pixa MCP");
  const mcpManager = new McpManager((m) => mcpOutput.appendLine(m));
  const mcpServers = vscode.workspace.getConfiguration("pixa").get<Record<string, McpServerConfig>>("mcpServers") ?? {};
  void mcpManager.connectAll(mcpServers, tools);
  context.subscriptions.push(mcpOutput, { dispose: () => mcpManager.dispose() });

  const changeSet = new ChangeSet();
  const index = new WorkspaceIndexer(workspaceRoot);
  const diffPreview = new DiffPreview(changeSet);
  diffPreview.register(context);

  // Debounced index invalidation on file changes.
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
