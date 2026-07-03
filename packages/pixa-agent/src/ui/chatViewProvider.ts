import * as vscode from "vscode";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as os from "node:os";
import type { ModelEntry } from "../providers/types";
import { ProviderRegistry } from "../providers/registry";
import { ToolRegistry } from "../tools/registry";
import type { ApprovalService, ToolContext } from "../tools/types";
import type { AgentEvent } from "../agent/events";
import { AgentLoop } from "../agent/loop";
import { ChangeSet } from "../edits/changeSet";
import type { RepoIndex } from "../indexer/types";
import { DiffPreview } from "./diffPreview";
import { resolveInWorkspace } from "../tools/paths";

/** Messages the webview sends to the extension host. */
type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "selectModel"; modelId: string }
  | { type: "approval-response"; requestId: string; approved: boolean }
  | { type: "changeset-action"; path: string | null; action: "apply" | "reject" | "apply-all" | "open-diff" }
  | { type: "new-session" }
  | { type: "set-api-key" };

export class ChatViewProvider implements vscode.WebviewViewProvider, ApprovalService {
  private view: vscode.WebviewView | undefined;
  private loop: AgentLoop;
  private abort: AbortController | undefined;
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private currentModelId: string;
  private running = false;

  constructor(
    private context: vscode.ExtensionContext,
    private registry: ProviderRegistry,
    private tools: ToolRegistry,
    private models: ModelEntry[],
    private changeSet: ChangeSet,
    private index: RepoIndex,
    private diffPreview: DiffPreview,
    private workspaceRoot: string
  ) {
    this.currentModelId = this.resolveDefaultModelId();
    const ctx: ToolContext = {
      workspaceRoot: this.workspaceRoot,
      changeSet: this.changeSet,
      index: this.index,
      approvals: this,
      readWorkspaceFile: async (absPath: string) => {
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absPath));
          return Buffer.from(bytes).toString("utf8");
        } catch {
          return null;
        }
      },
      emit: (event: AgentEvent) => this.post(event),
    };
    this.loop = new AgentLoop({
      registry: this.registry,
      tools: this.tools,
      models: this.models,
      ctx,
      workspaceInfo: async () => ({
        workspaceName: path.basename(this.workspaceRoot),
        os: `${os.type()} ${os.release()} (${os.platform()})`,
      }),
      maxTokens: () => vscode.workspace.getConfiguration("pixa").get<number>("maxTokens") ?? 8192,
    });
  }

  private resolveDefaultModelId(): string {
    const configured = vscode.workspace.getConfiguration("pixa").get<string>("defaultModel") ?? "qwen-free";
    return this.models.some((m) => m.id === configured) ? configured : this.models[0]?.id ?? "qwen-free";
  }

  /* ---------- ApprovalService ---------- */

  requestApproval(kind: "command" | "commit", detail: string): Promise<boolean> {
    const requestId = crypto.randomUUID();
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(requestId, resolve);
      this.post({ type: "approval-request", requestId, kind, detail });
    });
  }

  /* ---------- WebviewViewProvider ---------- */

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.onMessage(msg));
  }

  newSession(): void {
    this.abort?.abort();
    this.loop.reset();
    this.changeSet.clearResolved();
    this.post({ type: "status", text: "New session started." });
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready": {
        const hasApiKey = !!(await this.context.secrets.get("pixa.openrouter.apiKey"));
        this.post({
          type: "init",
          models: this.models.map((m) => ({ id: m.id, label: m.label })),
          currentModelId: this.currentModelId,
          hasApiKey,
        } as any);
        this.postChangeSet();
        break;
      }
      case "send": {
        if (this.running) return;
        this.running = true;
        this.abort = new AbortController();
        try {
          await this.loop.run(msg.text, this.currentModelId, this.abort.signal);
        } finally {
          this.running = false;
          this.post({ type: "run-finished" } as any);
        }
        break;
      }
      case "stop":
        this.abort?.abort();
        // Unblock any approval the loop is awaiting, otherwise Stop can't take effect.
        for (const [id, resolve] of this.pendingApprovals) {
          resolve(false);
          this.pendingApprovals.delete(id);
        }
        break;
      case "selectModel":
        if (this.models.some((m) => m.id === msg.modelId)) {
          this.currentModelId = msg.modelId;
        }
        break;
      case "approval-response": {
        const resolve = this.pendingApprovals.get(msg.requestId);
        if (resolve) {
          this.pendingApprovals.delete(msg.requestId);
          resolve(msg.approved);
        }
        break;
      }
      case "changeset-action":
        await this.onChangeSetAction(msg.path, msg.action);
        break;
      case "new-session":
        this.newSession();
        break;
      case "set-api-key": {
        await vscode.commands.executeCommand("pixa.setApiKey");
        const hasApiKey = !!(await this.context.secrets.get("pixa.openrouter.apiKey"));
        this.post({ type: "api-key-status", hasApiKey } as any);
        if (hasApiKey) this.post({ type: "status", text: "API key updated." });
        break;
      }
    }
  }

  private async onChangeSetAction(
    relPath: string | null,
    action: "apply" | "reject" | "apply-all" | "open-diff"
  ): Promise<void> {
    try {
      if (action === "open-diff" && relPath) {
        await this.diffPreview.open(relPath);
        return;
      }
      if (action === "apply-all") {
        for (const change of this.changeSet.list()) {
          if (change.status === "pending") await this.applyChange(change.path);
        }
      } else if (relPath) {
        if (action === "apply") await this.applyChange(relPath);
        if (action === "reject") this.changeSet.markRejected(relPath);
      }
      this.postChangeSet();
    } catch (e) {
      this.post({ type: "error", message: (e as Error).message });
    }
  }

  private async applyChange(relPath: string): Promise<void> {
    const change = this.changeSet.get(relPath);
    if (!change || change.status !== "pending") return;
    const abs = resolveInWorkspace(this.workspaceRoot, relPath);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(abs), Buffer.from(change.newContent, "utf8"));
    this.changeSet.markApplied(relPath);
    this.diffPreview.invalidate(relPath);
  }

  private postChangeSet(): void {
    this.post({
      type: "changeset-updated",
      files: this.changeSet.list().map((f) => ({ path: f.path, status: f.status })),
    });
  }

  private post(event: AgentEvent | Record<string, unknown>): void {
    void this.view?.webview.postMessage(event);
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview", "style.css")
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
</head>
<body>
  <div id="app">
    <div id="header">
      <select id="model-select" title="Model"></select>
      <button id="new-session" title="New session">＋</button>
    </div>
    <div id="messages"></div>
    <div id="changeset" class="hidden">
      <div id="changeset-header">
        <span>Proposed changes</span>
        <button id="apply-all">Apply all</button>
      </div>
      <div id="changeset-files"></div>
    </div>
    <div id="composer">
      <div id="api-key-warning" class="hidden">
        No API key set. <a href="#" id="set-key-link">Set OpenRouter API key</a>
      </div>
      <textarea id="input" rows="3" placeholder="Describe a task… (Enter to send, Shift+Enter for newline)"></textarea>
      <div id="composer-actions">
        <button id="stop" class="hidden">Stop</button>
        <button id="send">Send</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
