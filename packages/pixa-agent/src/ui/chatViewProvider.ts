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
import { parseMentions, formatAttachedFiles, type AttachedFile } from "../agent/mentions";
import type { ChatMessage } from "../providers/types";
import type { ProvidersConfig } from "../providers/config";
import { validateProviderForm, parseModelsResponse, modelsEndpointUrl } from "../providers/providerForm";
import { providerSecretKey } from "../providers/secretKeys";

const SESSIONS_KEY = "pixa.sessions.v1";
const MAX_SESSIONS = 30;

interface StoredSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  costUsd: number;
  history: ChatMessage[];
}

interface SessionStore {
  sessions: StoredSession[];
  activeId: string | null;
}

/** Messages the webview sends to the extension host. */
type WebviewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "selectModel"; modelId: string }
  | { type: "approval-response"; requestId: string; approved: boolean }
  | { type: "changeset-action"; path: string | null; action: "apply" | "reject" | "apply-all" | "open-diff" | "revert" }
  | { type: "new-session" }
  | { type: "list-sessions" }
  | { type: "load-session"; id: string }
  | { type: "delete-session"; id: string }
  | { type: "set-api-key" }
  | { type: "list-providers" }
  | { type: "fetch-models"; baseUrl: string; apiKey?: string }
  | {
      type: "save-provider";
      id: string;
      name: string;
      baseUrl: string;
      requiresApiKey: boolean;
      apiKey?: string;
      models: { id: string; name?: string }[];
    }
  | { type: "delete-provider"; id: string }
  | { type: "reload-window" };

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
      emit: (event: AgentEvent) => {
        // Keep the host's selection in sync when the loop auto-switches to a
        // working model, so the next message starts there directly.
        if (event.type === "active-model-changed") {
          this.currentModelId = event.modelId;
        }
        this.post(event);
      },
    };
    this.loop = new AgentLoop({
      registry: this.registry,
      tools: this.tools,
      models: this.models,
      ctx,
      workspaceInfo: async () => {
        const editor = vscode.window.activeTextEditor;
        let activeFile: string | undefined;
        let selection: string | undefined;
        if (editor && editor.document.uri.scheme === "file") {
          const rel = path.relative(this.workspaceRoot, editor.document.uri.fsPath);
          if (rel && !rel.startsWith("..")) {
            activeFile = rel.split(path.sep).join("/");
            const selected = editor.document.getText(editor.selection);
            if (selected.trim()) selection = selected.slice(0, 2000);
          }
        }
        return {
          workspaceName: path.basename(this.workspaceRoot),
          os: `${os.type()} ${os.release()} (${os.platform()})`,
          activeFile,
          selection,
        };
      },
      maxTokens: () => vscode.workspace.getConfiguration("pixa").get<number>("maxTokens") ?? 8192,
      // Persist mid-task so a reload/crash during a long run doesn't discard
      // the work already done.
      onCheckpoint: () => this.saveSession(),
    });
  }

  private resolveDefaultModelId(): string {
    const configured = vscode.workspace.getConfiguration("pixa").get<string>("defaultModel") ?? "nemotron-free";
    const chatModels = this.models.filter((m) => m.provider !== "local-embeddings");
    return chatModels.some((m) => m.id === configured) ? configured : chatModels[0]?.id ?? "nemotron-free";
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
    this.saveSession(); // preserve what we're leaving
    this.loop.reset();
    this.changeSet.clearResolved();
    const store = this.loadStore();
    store.activeId = null;
    this.saveStore(store);
    this.activeSessionId = null;
    this.post({ type: "transcript", entries: [], sessionCostUsd: 0 } as any);
    this.postSessions();
  }

  /* ---------- session store (Copilot-style history) ---------- */

  private activeSessionId: string | null = null;

  private loadStore(): SessionStore {
    const raw = this.context.workspaceState.get<SessionStore>(SESSIONS_KEY);
    return raw && Array.isArray(raw.sessions) ? raw : { sessions: [], activeId: null };
  }

  private saveStore(store: SessionStore): void {
    void this.context.workspaceState.update(SESSIONS_KEY, store);
  }

  /** Upsert the active session from the loop's current state. */
  private saveSession(): void {
    if (this.loop.history.length === 0) return;
    const store = this.loadStore();
    const now = Date.now();
    if (!this.activeSessionId) this.activeSessionId = crypto.randomUUID();
    const existing = store.sessions.find((s) => s.id === this.activeSessionId);
    const title = existing?.title ?? this.deriveTitle();
    const session: StoredSession = {
      id: this.activeSessionId,
      title,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      costUsd: this.loop.sessionCost,
      history: this.loop.history.slice(-200), // bound growth; context manager prunes anyway
    };
    store.sessions = [session, ...store.sessions.filter((s) => s.id !== session.id)].slice(0, MAX_SESSIONS);
    store.activeId = session.id;
    this.saveStore(store);
    this.postSessions();
  }

  private deriveTitle(): string {
    const firstUser = this.loop.history.find((m) => m.role === "user");
    const text = (firstUser?.content ?? "New chat").replace(/\n*<attached-files>[\s\S]*<\/attached-files>/, "").trim();
    return text.slice(0, 48) + (text.length > 48 ? "…" : "") || "New chat";
  }

  /** Rehydrate the active session and replay its transcript into the webview. */
  private restoreSession(): void {
    if (this.loop.history.length > 0) {
      // Live in-memory session — the panel was hidden, not the window reloaded.
      this.post({ type: "transcript", entries: this.transcript(), sessionCostUsd: this.loop.sessionCost } as any);
      this.postSessions();
      return;
    }
    const store = this.loadStore();
    const active = store.sessions.find((s) => s.id === store.activeId);
    if (active) {
      this.activeSessionId = active.id;
      this.loop.restore(active.history, active.costUsd ?? 0);
      this.post({ type: "transcript", entries: this.transcript(), sessionCostUsd: this.loop.sessionCost } as any);
    }
    this.postSessions();
  }

  private switchSession(id: string): void {
    this.abort?.abort();
    this.saveSession();
    const store = this.loadStore();
    const target = store.sessions.find((s) => s.id === id);
    if (!target) return;
    this.activeSessionId = target.id;
    store.activeId = target.id;
    this.saveStore(store);
    this.loop.restore(target.history, target.costUsd ?? 0);
    this.changeSet.clearResolved();
    this.post({ type: "transcript", entries: this.transcript(), sessionCostUsd: this.loop.sessionCost } as any);
    this.postSessions();
  }

  private deleteSession(id: string): void {
    const store = this.loadStore();
    store.sessions = store.sessions.filter((s) => s.id !== id);
    if (store.activeId === id) {
      store.activeId = null;
      if (this.activeSessionId === id) {
        this.activeSessionId = null;
        this.loop.reset();
        this.post({ type: "transcript", entries: [], sessionCostUsd: 0 } as any);
      }
    }
    this.saveStore(store);
    this.postSessions();
  }

  private postSessions(): void {
    const store = this.loadStore();
    this.post({
      type: "sessions",
      activeId: this.activeSessionId,
      sessions: store.sessions
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, costUsd: s.costUsd })),
    } as any);
  }

  private transcript(): { role: string; text: string }[] {
    return this.loop.history
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
      .map((m) => ({
        role: m.role,
        // Hide bulky attached-file blocks from the replayed view.
        text: m.content.replace(/\n*<attached-files>[\s\S]*<\/attached-files>/, " [attached files]"),
      }));
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case "ready": {
        const hasApiKey = !!(await this.context.secrets.get("pixa.openrouter.apiKey"));
        this.post({
          type: "init",
          models: this.models
            .filter((m) => m.provider !== "local-embeddings")
            .map((m) => ({ id: m.id, label: m.label })),
          currentModelId: this.currentModelId,
          hasApiKey,
        } as any);
        this.restoreSession();
        this.postChangeSet();
        break;
      }
      case "send": {
        if (this.running) return;
        this.running = true;
        this.abort = new AbortController();
        try {
          const text = await this.resolveMentions(msg.text);
          await this.loop.run(text, this.currentModelId, this.abort.signal);
        } finally {
          this.running = false;
          this.post({ type: "run-finished" } as any);
          this.saveSession();
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
        if (this.models.some((m) => m.id === msg.modelId && m.provider !== "local-embeddings")) {
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
      case "list-sessions":
        this.postSessions();
        break;
      case "load-session":
        this.switchSession(msg.id);
        break;
      case "delete-session":
        this.deleteSession(msg.id);
        break;
      case "set-api-key": {
        await vscode.commands.executeCommand("pixa.setApiKey");
        const hasApiKey = !!(await this.context.secrets.get("pixa.openrouter.apiKey"));
        this.post({ type: "api-key-status", hasApiKey } as any);
        if (hasApiKey) this.post({ type: "status", text: "API key updated." });
        break;
      }
      case "list-providers":
        this.postProviders();
        break;
      case "fetch-models": {
        const result = await this.fetchModels(msg.baseUrl, msg.apiKey);
        if (result.ok) {
          this.post({ type: "fetched-models", models: result.models });
        } else {
          this.post({ type: "fetch-models-failed", reason: result.reason });
        }
        break;
      }
      case "save-provider":
        await this.saveProvider(msg);
        break;
      case "delete-provider":
        await this.deleteProvider(msg.id);
        break;
      case "reload-window":
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        break;
    }
  }

  /* ---------- provider management ---------- */

  private postProviders(): void {
    const cfg = vscode.workspace.getConfiguration("pixa").get<ProvidersConfig>("providers") ?? {};
    this.post({
      type: "providers",
      list: Object.entries(cfg).map(([id, p]) => ({
        id,
        name: p.name?.trim() || id,
        baseUrl: p.baseUrl,
        modelCount: Object.keys(p.models ?? {}).length,
      })),
    });
  }

  private async fetchModels(
    baseUrl: string,
    apiKey?: string
  ): Promise<{ ok: true; models: string[] } | { ok: false; reason: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(modelsEndpointUrl(baseUrl), {
        signal: controller.signal,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!res.ok) return { ok: false, reason: `Server responded with ${res.status}.` };
      const models = parseModelsResponse(await res.json());
      if (models.length === 0) return { ok: false, reason: "No models found in the server's response." };
      return { ok: true, models };
    } catch (e: any) {
      return { ok: false, reason: e?.message ?? "Request failed." };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async saveProvider(msg: {
    id: string;
    name: string;
    baseUrl: string;
    requiresApiKey: boolean;
    apiKey?: string;
    models: { id: string; name?: string }[];
  }): Promise<void> {
    const config = vscode.workspace.getConfiguration("pixa");
    const cfg = config.get<ProvidersConfig>("providers") ?? {};

    const result = validateProviderForm(
      { id: msg.id, name: msg.name, baseUrl: msg.baseUrl, requiresApiKey: msg.requiresApiKey, models: msg.models },
      Object.keys(cfg)
    );
    if (!result.ok) {
      const message = Object.values(result.errors).filter(Boolean).join(" ");
      this.post({ type: "provider-error", message });
      return;
    }

    const id = msg.id.trim();
    try {
      await config.update("providers", { ...cfg, [id]: result.config }, vscode.ConfigurationTarget.Global);
    } catch (e: any) {
      this.post({ type: "provider-error", message: `Failed to save: ${e?.message ?? e}` });
      return;
    }

    if (msg.requiresApiKey && msg.apiKey?.trim()) {
      await this.context.secrets.store(providerSecretKey(id), msg.apiKey.trim());
    }

    this.post({ type: "provider-saved", id });
    this.postProviders();
  }

  private async deleteProvider(id: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("pixa");
    const cfg = config.get<ProvidersConfig>("providers") ?? {};
    if (!(id in cfg)) return;
    const next = { ...cfg };
    delete next[id];
    await config.update("providers", next, vscode.ConfigurationTarget.Global);
    await this.context.secrets.delete(providerSecretKey(id));
    this.post({ type: "provider-deleted", id });
    this.postProviders();
  }

  private async onChangeSetAction(
    relPath: string | null,
    action: "apply" | "reject" | "apply-all" | "open-diff" | "revert"
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
        if (action === "revert") await this.revertChange(relPath);
      }
      this.postChangeSet();
    } catch (e) {
      this.post({ type: "error", message: (e as Error).message });
    }
  }

  /** Restore an applied file to its pre-apply content (delete it if we created it). */
  private async revertChange(relPath: string): Promise<void> {
    const change = this.changeSet.get(relPath);
    if (!change || change.status !== "applied") return;
    const abs = resolveInWorkspace(this.workspaceRoot, relPath);
    const uri = vscode.Uri.file(abs);
    if (change.originalContent === null) {
      await vscode.workspace.fs.delete(uri, { useTrash: true });
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(change.originalContent, "utf8"));
    }
    this.changeSet.markReverted(relPath);
    this.diffPreview.invalidate(relPath);
  }

  private async applyChange(relPath: string): Promise<void> {
    const change = this.changeSet.get(relPath);
    if (!change || change.status !== "pending") return;
    const abs = resolveInWorkspace(this.workspaceRoot, relPath);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(abs), Buffer.from(change.newContent, "utf8"));
    this.changeSet.markApplied(relPath);
    this.diffPreview.invalidate(relPath);
  }

  /** Resolve @path mentions against workspace files and append their contents. */
  private async resolveMentions(text: string): Promise<string> {
    const mentions = parseMentions(text);
    if (mentions.length === 0) return text;
    const attached: AttachedFile[] = [];
    const unresolved: string[] = [];
    for (const mention of mentions) {
      try {
        const norm = mention.replace(/\\/g, "/");
        // Exact relative path first, then a suffix match anywhere in the workspace.
        let uri: vscode.Uri | undefined;
        const exact = vscode.Uri.file(path.join(this.workspaceRoot, norm));
        try {
          await vscode.workspace.fs.stat(exact);
          uri = exact;
        } catch {
          const found = await vscode.workspace.findFiles(`**/${norm}`, "**/node_modules/**", 1);
          uri = found[0];
        }
        if (!uri) {
          unresolved.push(mention);
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        const rel = path.relative(this.workspaceRoot, uri.fsPath).split(path.sep).join("/");
        attached.push({ path: rel, content: Buffer.from(bytes).toString("utf8") });
      } catch {
        unresolved.push(mention);
      }
    }
    return text + formatAttachedFiles(attached, unresolved);
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
      <span id="session-cost" title="Total spend this session (from OpenRouter usage accounting)">$0.00</span>
      <button id="show-history" class="icon-btn" title="Chat history">🕘</button>
      <button id="new-session" class="icon-btn" title="New chat">＋</button>
      <button id="show-providers" class="icon-btn" title="Providers">⚙</button>
    </div>
    <div id="history-panel" class="hidden">
      <div id="history-header">
        <span>Chats</span>
        <button id="close-history" class="icon-btn" title="Back to chat">✕</button>
      </div>
      <div id="history-list"></div>
    </div>
    <div id="providers-panel" class="hidden">
      <div id="providers-header">
        <span>Providers</span>
        <button id="close-providers" class="icon-btn" title="Back to chat">✕</button>
      </div>
      <div id="providers-body">
        <div id="pf-reload-banner" class="hidden">
          Provider added. <button id="pf-reload-btn">Reload window</button>
        </div>

        <div class="section-title">Configured</div>
        <div id="providers-list"></div>

        <div class="section-title">Quick setup</div>
        <div id="preset-cards"></div>

        <form id="provider-form">
          <div class="section-title">Add provider</div>
          <div id="provider-error" class="hidden"></div>
          <label>Provider ID<input id="pf-id" placeholder="ollama" autocomplete="off"></label>
          <label>Display name<input id="pf-name" placeholder="Ollama (local)" autocomplete="off"></label>
          <label>Base URL<input id="pf-baseurl" placeholder="http://localhost:11434/v1" autocomplete="off"></label>
          <label class="pf-checkbox"><input type="checkbox" id="pf-requires-key"> Requires API key</label>
          <label id="pf-apikey-row" class="hidden">API key<input id="pf-apikey" type="password" autocomplete="off"></label>

          <div class="section-title">Models</div>
          <div class="pf-fetch-row">
            <button type="button" id="pf-fetch-models">Fetch models</button>
            <span id="pf-fetch-status"></span>
          </div>
          <div id="pf-fetched-list"></div>
          <div id="pf-manual-list"></div>
          <button type="button" id="pf-add-model-row">+ Add model manually</button>

          <button type="submit" id="pf-submit">Add provider</button>
        </form>
      </div>
    </div>
    <div id="messages">
      <div id="welcome">
        <div class="welcome-title">Pixa Agent</div>
        <div class="welcome-line">Describe a task — I'll read your code, propose diffs you approve, and run commands only with your permission.</div>
        <div class="welcome-line dim">Tips: <code>@file.ts</code> attaches a file · select code in the editor before asking about it · switch models from the dropdown above.</div>
      </div>
    </div>
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
      <textarea id="input" rows="3" placeholder="Describe a task… @file.ts attaches a file (Enter to send, Shift+Enter for newline)"></textarea>
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
