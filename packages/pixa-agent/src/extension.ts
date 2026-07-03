import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(view: vscode.WebviewView) {
      view.webview.options = { enableScripts: true };
      view.webview.html = `<html><body><p style="font-family:sans-serif">Pixa Agent is loading…</p></body></html>`;
    },
  };

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("pixa.chat", provider),
    vscode.commands.registerCommand("pixa.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        prompt: "Enter your OpenRouter API key",
        password: true,
        ignoreFocusOut: true,
      });
      if (key) {
        await context.secrets.store("pixa.openrouter.apiKey", key.trim());
        void vscode.window.showInformationMessage("Pixa: OpenRouter API key saved.");
      }
    }),
    vscode.commands.registerCommand("pixa.newSession", () => {
      void vscode.window.showInformationMessage("Pixa: new session (agent not wired yet).");
    })
  );
}

export function deactivate(): void {}
