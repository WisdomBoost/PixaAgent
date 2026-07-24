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

  const welcomeEl = $("welcome");

  function clearMessages() {
    messagesEl.innerHTML = "";
    messagesEl.appendChild(welcomeEl);
    welcomeEl.classList.remove("hidden");
  }

  function addMessage(cls, html) {
    welcomeEl.classList.add("hidden");
    const wrap = document.createElement("div");
    wrap.className = "msg " + cls;
    if (cls === "user" || cls === "assistant") {
      const role = document.createElement("div");
      role.className = "msg-role";
      role.textContent = cls === "user" ? "You" : "Pixa";
      wrap.appendChild(role);
    }
    const body = document.createElement("div");
    body.className = "msg-body";
    body.innerHTML = html;
    wrap.appendChild(body);
    messagesEl.appendChild(wrap);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return body;
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
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
      case "transcript": {
        clearMessages();
        for (const entry of msg.entries) {
          addMessage(entry.role === "user" ? "user" : "assistant", renderMarkdown(entry.text));
        }
        if (typeof msg.sessionCostUsd === "number") {
          $("session-cost").textContent = formatCost(msg.sessionCostUsd);
        }
        $("history-panel").classList.add("hidden");
        currentAssistantEl = null;
        break;
      }
      case "sessions":
        renderSessions(msg.sessions, msg.activeId);
        break;
      case "active-model-changed":
        modelSelect.value = msg.modelId;
        break;
      case "plan": {
        const items = msg.steps.map((s) => "<li>" + escapeHtml(s.text) + "</li>").join("");
        addMessage("plan", '<div class="plan-title">Plan</div><ol class="plan-steps">' + items + "</ol>");
        currentAssistantEl = null;
        break;
      }
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
      case "providers":
        renderProviders(msg.list);
        break;
      case "fetched-models":
        renderFetchedModels(msg.models);
        break;
      case "fetch-models-failed":
        setFetchStatus(msg.reason + " — enter model ids manually below.");
        break;
      case "provider-saved":
        $("provider-error").classList.add("hidden");
        $("pf-reload-banner").classList.remove("hidden");
        resetProviderForm();
        break;
      case "provider-error":
        $("provider-error").textContent = msg.message;
        $("provider-error").classList.remove("hidden");
        break;
      case "provider-deleted":
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
          ? '<button data-a="open-diff">Review</button><button data-a="apply">Apply</button><button data-a="reject">Reject</button>'
          : f.status === "applied"
            ? '<em>applied</em> <button data-a="revert">Revert</button>'
            : "<em>" + f.status + "</em>";
      // The filename is clickable for pending files — the natural "show me the
      // change" gesture opens the diff, so reviewing before Apply is obvious.
      const pathClickable = f.status === "pending";
      row.innerHTML =
        '<span class="cs-dot"></span><span class="cs-path' + (pathClickable ? " cs-path-clickable" : "") +
        '" title="' + escapeHtml(pathClickable ? "Click to review this change" : f.path) + '">' +
        escapeHtml(f.path) + '</span><span class="cs-actions">' + actions + "</span>";
      if (pathClickable) {
        row.querySelector(".cs-path").addEventListener("click", () =>
          vscode.postMessage({ type: "changeset-action", path: f.path, action: "open-diff" })
        );
      }
      row.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () =>
          vscode.postMessage({ type: "changeset-action", path: f.path, action: btn.dataset.a })
        );
      });
      changesetFiles.appendChild(row);
    }
  }

  function renderSessions(sessions, activeId) {
    const list = $("history-list");
    list.innerHTML = "";
    if (sessions.length === 0) {
      list.innerHTML = '<div class="history-empty">No chats yet.</div>';
      return;
    }
    for (const s of sessions) {
      const row = document.createElement("div");
      row.className = "history-row" + (s.id === activeId ? " active" : "");
      row.innerHTML =
        '<div class="history-main"><div class="history-title">' + escapeHtml(s.title) +
        '</div><div class="history-meta">' + timeAgo(s.updatedAt) +
        (s.costUsd ? " · " + formatCost(s.costUsd) : "") +
        '</div></div><button class="history-delete" title="Delete chat">✕</button>';
      row.querySelector(".history-main").addEventListener("click", () => {
        vscode.postMessage({ type: "load-session", id: s.id });
      });
      row.querySelector(".history-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: "delete-session", id: s.id });
      });
      list.appendChild(row);
    }
  }

  /* ---------- providers view ---------- */

  // Mirrors src/providers/providerForm.ts's PRESETS. Duplicated deliberately:
  // the webview is plain JS, not bundled with the TS extension host, so
  // there's no shared-import path without adding a build step for four
  // short entries. Keep the two lists in sync if presets change.
  const PRESET_CARDS = [
    { id: "ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1", requiresApiKey: false },
    { id: "lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1", requiresApiKey: false },
    { id: "vllm", label: "vLLM", baseUrl: "http://localhost:8000/v1", requiresApiKey: false },
    { id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1", requiresApiKey: true },
  ];

  function renderProviders(list) {
    const el = $("providers-list");
    el.innerHTML = "";
    if (list.length === 0) {
      el.innerHTML =
        '<div class="providers-empty">No providers configured. Pixa\'s built-in models require an ' +
        "OpenRouter key — add a provider below to use your own endpoint or a local model.</div>";
      return;
    }
    for (const p of list) {
      const row = document.createElement("div");
      row.className = "provider-row";
      row.innerHTML =
        '<div class="provider-main"><div class="provider-name">' + escapeHtml(p.name) +
        '</div><div class="provider-meta">' + escapeHtml(p.baseUrl) + " · " + p.modelCount +
        " model" + (p.modelCount === 1 ? "" : "s") +
        '</div></div><button class="provider-delete" title="Delete provider">✕</button>';
      row.querySelector(".provider-delete").addEventListener("click", () => {
        vscode.postMessage({ type: "delete-provider", id: p.id });
      });
      el.appendChild(row);
    }
  }

  function renderPresetCards() {
    const el = $("preset-cards");
    el.innerHTML = "";
    for (const preset of PRESET_CARDS) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "preset-card";
      card.textContent = preset.label;
      card.addEventListener("click", () => fillPresetForm(preset));
      el.appendChild(card);
    }
    const orCard = document.createElement("button");
    orCard.type = "button";
    orCard.className = "preset-card";
    orCard.textContent = "OpenRouter";
    orCard.title = "OpenRouter is built in — this opens the API key setup instead of the form below.";
    orCard.addEventListener("click", () => vscode.postMessage({ type: "set-api-key" }));
    el.appendChild(orCard);
  }

  function fillPresetForm(preset) {
    $("pf-id").value = preset.id;
    $("pf-name").value = preset.label;
    $("pf-baseurl").value = preset.baseUrl;
    $("pf-requires-key").checked = preset.requiresApiKey;
    $("pf-apikey-row").classList.toggle("hidden", !preset.requiresApiKey);
    $("pf-fetched-list").innerHTML = "";
    $("pf-manual-list").innerHTML = "";
    setFetchStatus("");
    addManualModelRow("", "");
  }

  function resetProviderForm() {
    $("provider-form").reset();
    $("pf-apikey-row").classList.add("hidden");
    $("pf-fetched-list").innerHTML = "";
    $("pf-manual-list").innerHTML = "";
    setFetchStatus("");
    addManualModelRow("", "");
  }

  function addManualModelRow(id, name) {
    const row = document.createElement("div");
    row.className = "pf-manual-row";
    row.innerHTML =
      '<input class="pf-manual-id" placeholder="model-id" value="' + escapeHtml(id || "") + '">' +
      '<input class="pf-manual-name" placeholder="Display name (optional)" value="' + escapeHtml(name || "") + '">' +
      '<button type="button" class="pf-remove-row">✕</button>';
    row.querySelector(".pf-remove-row").addEventListener("click", () => row.remove());
    $("pf-manual-list").appendChild(row);
  }

  function renderFetchedModels(models) {
    const el = $("pf-fetched-list");
    el.innerHTML = "";
    for (const id of models) {
      const row = document.createElement("label");
      row.className = "pf-fetched-row";
      row.innerHTML =
        '<input type="checkbox" class="pf-fetched-checkbox" value="' + escapeHtml(id) + '" checked> ' + escapeHtml(id);
      el.appendChild(row);
    }
    setFetchStatus(models.length + " model(s) found — uncheck any you don't want.");
  }

  function setFetchStatus(text) {
    $("pf-fetch-status").textContent = text;
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
  stopBtn.addEventListener("click", () => {
    // Optimistically flip the UI back to idle immediately so the button
    // feels responsive — the host will confirm with "run-finished" shortly.
    setRunning(false);
    addMessage("status", "Stopping…");
    vscode.postMessage({ type: "stop" });
  });
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
    clearMessages();
    $("session-cost").textContent = formatCost(0);
    $("history-panel").classList.add("hidden");
    vscode.postMessage({ type: "new-session" });
  });
  $("show-history").addEventListener("click", () => {
    $("history-panel").classList.toggle("hidden");
    vscode.postMessage({ type: "list-sessions" });
  });
  $("close-history").addEventListener("click", () => $("history-panel").classList.add("hidden"));
  $("apply-all").addEventListener("click", () =>
    vscode.postMessage({ type: "changeset-action", path: null, action: "apply-all" })
  );
  $("set-key-link").addEventListener("click", (e) => {
    e.preventDefault();
    vscode.postMessage({ type: "set-api-key" });
  });

  $("show-providers").addEventListener("click", () => {
    $("providers-panel").classList.toggle("hidden");
    vscode.postMessage({ type: "list-providers" });
  });
  $("close-providers").addEventListener("click", () => $("providers-panel").classList.add("hidden"));
  $("pf-requires-key").addEventListener("change", () => {
    $("pf-apikey-row").classList.toggle("hidden", !$("pf-requires-key").checked);
  });
  $("pf-fetch-models").addEventListener("click", () => {
    const baseUrl = $("pf-baseurl").value.trim();
    if (!baseUrl) {
      setFetchStatus("Enter a base URL first.");
      return;
    }
    setFetchStatus("Fetching…");
    const apiKey = $("pf-apikey").value.trim();
    vscode.postMessage({ type: "fetch-models", baseUrl, apiKey: apiKey || undefined });
  });
  $("pf-add-model-row").addEventListener("click", () => addManualModelRow("", ""));
  $("pf-reload-btn").addEventListener("click", () => vscode.postMessage({ type: "reload-window" }));
  $("provider-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const models = [];
    document.querySelectorAll(".pf-fetched-checkbox:checked").forEach((cb) => models.push({ id: cb.value }));
    document.querySelectorAll(".pf-manual-row").forEach((row) => {
      const id = row.querySelector(".pf-manual-id").value.trim();
      if (!id) return;
      const name = row.querySelector(".pf-manual-name").value.trim();
      models.push(name ? { id, name } : { id });
    });
    vscode.postMessage({
      type: "save-provider",
      id: $("pf-id").value.trim(),
      name: $("pf-name").value.trim(),
      baseUrl: $("pf-baseurl").value.trim(),
      requiresApiKey: $("pf-requires-key").checked,
      apiKey: $("pf-apikey").value.trim() || undefined,
      models,
    });
  });

  renderPresetCards();
  addManualModelRow("", "");

  vscode.postMessage({ type: "ready" });
})();
