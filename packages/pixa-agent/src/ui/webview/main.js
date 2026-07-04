// Pixa Agent chat webview. Vanilla JS; talks to the extension host via postMessage.
(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const messagesEl = $("messages");
  const inputEl = $("input");
  const sendBtn = $("send");
  const stopBtn = $("stop");
  const modelSelect = $("model-select");
  const changesetEl = $("changeset");
  const changesetFiles = $("changeset-files");

  let currentAssistantEl = null;
  let running = false;

  /* ---------- rendering helpers ---------- */

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Minimal markdown: fenced code blocks + inline code. Everything else is escaped text.
  function renderMarkdown(text) {
    const escaped = escapeHtml(text);
    let html = escaped.replace(/```([\w-]*)\n([\s\S]*?)```/g, function (_m, _lang, code) {
      return "<pre><code>" + code + "</code></pre>";
    });
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    return html.replace(/\n/g, "<br>");
  }

  function addMessage(cls, html) {
    const el = document.createElement("div");
    el.className = "msg " + cls;
    el.innerHTML = html;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  // OpenRouter returns real billed cost, not an estimate; costs are tiny so show more precision below a cent.
  function formatCost(n) {
    if (n === null || n === undefined) return "—";
    if (n === 0) return "$0.00";
    return "$" + n.toFixed(n < 0.01 ? 6 : 4);
  }

  function ensureAssistantEl() {
    if (!currentAssistantEl) {
      currentAssistantEl = addMessage("assistant", "");
      currentAssistantEl.dataset.raw = "";
    }
    return currentAssistantEl;
  }

  function setRunning(state) {
    running = state;
    sendBtn.classList.toggle("hidden", state);
    stopBtn.classList.toggle("hidden", !state);
  }

  /* ---------- events from extension host ---------- */

  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "init": {
        modelSelect.innerHTML = "";
        for (const m of msg.models) {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = m.label;
          if (m.id === msg.currentModelId) opt.selected = true;
          modelSelect.appendChild(opt);
        }
        $("api-key-warning").classList.toggle("hidden", msg.hasApiKey);
        break;
      }
      case "api-key-status":
        $("api-key-warning").classList.toggle("hidden", msg.hasApiKey);
        break;
      case "assistant-delta": {
        const el = ensureAssistantEl();
        el.dataset.raw += msg.text;
        el.innerHTML = renderMarkdown(el.dataset.raw);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        break;
      }
      case "assistant-done":
        currentAssistantEl = null;
        break;
      case "tool-start": {
        const el = addMessage("tool", "");
        el.id = "tool-" + msg.callId;
        el.innerHTML =
          '<div class="tool-head"><span class="spinner"></span><span class="tool-name">' +
          escapeHtml(msg.name) +
          "</span> <span class='tool-summary'>" +
          escapeHtml(msg.summary || "") +
          "</span></div>";
        currentAssistantEl = null;
        break;
      }
      case "tool-end": {
        const el = document.getElementById("tool-" + msg.callId);
        if (el) {
          el.querySelector(".spinner").className = "done-dot";
          const details = document.createElement("details");
          details.innerHTML =
            "<summary>result</summary><pre>" + escapeHtml(msg.result) + "</pre>";
          el.appendChild(details);
        }
        break;
      }
      case "approval-request": {
        const el = addMessage("approval", "");
        const label = msg.kind === "commit" ? "Commit" : "Run";
        el.innerHTML =
          '<div class="approval-title">Agent wants to ' +
          (msg.kind === "commit" ? "commit" : "run a command") +
          ':</div><pre>' + escapeHtml(msg.detail) + "</pre>" +
          '<div class="approval-actions"><button class="approve">' + label +
          '</button><button class="deny">Skip</button></div>';
        el.querySelector(".approve").addEventListener("click", () => {
          vscode.postMessage({ type: "approval-response", requestId: msg.requestId, approved: true });
          el.querySelector(".approval-actions").innerHTML = "<em>approved</em>";
        });
        el.querySelector(".deny").addEventListener("click", () => {
          vscode.postMessage({ type: "approval-response", requestId: msg.requestId, approved: false });
          el.querySelector(".approval-actions").innerHTML = "<em>skipped</em>";
        });
        break;
      }
      case "changeset-updated":
        renderChangeSet(msg.files);
        break;
      case "usage": {
        $("session-cost").textContent = formatCost(msg.sessionCostUsd);
        const perTurn =
          msg.requestCostUsd === null
            ? "usage: " + msg.promptTokens + " in / " + msg.completionTokens + " out tok (this model doesn't report cost)"
            : "usage: " +
              formatCost(msg.requestCostUsd) +
              " (" + msg.promptTokens + " in / " + msg.completionTokens + " out tok) · session total " +
              formatCost(msg.sessionCostUsd);
        addMessage("cost", escapeHtml(perTurn));
        break;
      }
      case "status":
        addMessage("status", escapeHtml(msg.text));
        currentAssistantEl = null;
        break;
      case "error":
        addMessage("error", escapeHtml(msg.message));
        currentAssistantEl = null;
        break;
      case "run-finished":
        setRunning(false);
        currentAssistantEl = null;
        break;
    }
  });

  function renderChangeSet(files) {
    const pending = files.filter((f) => f.status === "pending");
    changesetEl.classList.toggle("hidden", files.length === 0);
    changesetFiles.innerHTML = "";
    $("apply-all").classList.toggle("hidden", pending.length === 0);
    for (const f of files) {
      const row = document.createElement("div");
      row.className = "cs-row cs-" + f.status;
      const actions =
        f.status === "pending"
          ? '<button data-a="open-diff">Diff</button><button data-a="apply">Apply</button><button data-a="reject">Reject</button>'
          : f.status === "applied"
            ? '<em>applied</em> <button data-a="revert">Revert</button>'
            : "<em>" + f.status + "</em>";
      row.innerHTML =
        '<span class="cs-dot"></span><span class="cs-path" title="' + escapeHtml(f.path) + '">' +
        escapeHtml(f.path) + '</span><span class="cs-actions">' + actions + "</span>";
      row.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () =>
          vscode.postMessage({ type: "changeset-action", path: f.path, action: btn.dataset.a })
        );
      });
      changesetFiles.appendChild(row);
    }
  }

  /* ---------- user actions ---------- */

  function send() {
    const text = inputEl.value.trim();
    if (!text || running) return;
    addMessage("user", renderMarkdown(text));
    inputEl.value = "";
    setRunning(true);
    currentAssistantEl = null;
    vscode.postMessage({ type: "send", text });
  }

  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  modelSelect.addEventListener("change", () =>
    vscode.postMessage({ type: "selectModel", modelId: modelSelect.value })
  );
  $("new-session").addEventListener("click", () => {
    messagesEl.innerHTML = "";
    $("session-cost").textContent = formatCost(0);
    vscode.postMessage({ type: "new-session" });
  });
  $("apply-all").addEventListener("click", () =>
    vscode.postMessage({ type: "changeset-action", path: null, action: "apply-all" })
  );
  $("set-key-link").addEventListener("click", (e) => {
    e.preventDefault();
    vscode.postMessage({ type: "set-api-key" });
  });

  vscode.postMessage({ type: "ready" });
})();
