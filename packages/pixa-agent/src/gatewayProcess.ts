import * as vscode from "vscode";
import * as child_process from "child_process";
import * as path from "path";
import * as fs from "fs";

let gatewayProcess: child_process.ChildProcess | null = null;
let gatewayOutputChannel: vscode.OutputChannel | null = null;
let startedByUs = false;

export async function isGatewayRunning(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1000);
  try {
    const healthUrl = url.replace(/\/v1\/chat\/?$/, "/healthz");
    const res = await fetch(healthUrl, { signal: controller.signal });
    if (res.ok) {
      const data = (await res.json()) as any;
      return data?.ok === true;
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolves the path to the gateway executable or script.
 * Returns { command: string, args: string[], cwd: string } or null.
 */
export function resolveGatewayExecutable(context: vscode.ExtensionContext): {
  command: string;
  args: string[];
  cwd: string;
} | null {
  const binName = process.platform === "win32" ? "pixa-gateway.exe" : "pixa-gateway";

  const prodBinPath = path.join(context.extensionPath, "dist", binName);
  const binFolderBinPath = path.join(context.extensionPath, "bin", binName);
  const prodJsPath = path.join(context.extensionPath, "dist", "gateway", "server.js");
  const devTsPath = path.join(context.extensionPath, "..", "gateway", "src", "server.ts");

  if (fs.existsSync(devTsPath)) {
    const gatewayDir = path.dirname(path.dirname(devTsPath));
    // Prefer the locally-installed tsx binary over `npx tsx` — npx adds several
    // seconds of resolution/download overhead on Windows that can push cold-start
    // past the health-check timeout. The gateway package always has tsx as a
    // devDependency, so node_modules/.bin/tsx should always be present.
    const localTsxBin = process.platform === "win32"
      ? path.join(gatewayDir, "node_modules", ".bin", "tsx.cmd")
      : path.join(gatewayDir, "node_modules", ".bin", "tsx");
    if (fs.existsSync(localTsxBin)) {
      return {
        command: localTsxBin,
        args: [devTsPath],
        cwd: gatewayDir,
      };
    }
    // Fallback: npx tsx (requires shell on Windows so npx resolves correctly)
    return { command: "npx", args: ["tsx", devTsPath], cwd: gatewayDir };
  } else if (fs.existsSync(prodBinPath)) {
    return { command: prodBinPath, args: [], cwd: path.dirname(prodBinPath) };
  } else if (fs.existsSync(binFolderBinPath)) {
    return { command: binFolderBinPath, args: [], cwd: path.dirname(binFolderBinPath) };
  } else if (fs.existsSync(prodJsPath)) {
    return { command: "node", args: [prodJsPath], cwd: path.dirname(prodJsPath) };
  }

  return null;
}

/**
 * Spawns the gateway process.
 */
export function startGateway(
  context: vscode.ExtensionContext,
  gatewayUrl: string,
  log: (msg: string) => void,
  onExitCallback?: (code: number | null, signal: string | null, stderrText: string) => void
): void {
  if (gatewayProcess) {
    log("[GATEWAY] Process already spawned in this session.");
    return;
  }

  gatewayOutputChannel = vscode.window.createOutputChannel("Pixa Gateway");
  context.subscriptions.push(gatewayOutputChannel);

  const execConfig = resolveGatewayExecutable(context);
  if (!execConfig) {
    const errorMsg = "Error: Could not find gateway entry point or binary.";
    log(`[GATEWAY] ${errorMsg}`);
    gatewayOutputChannel.appendLine(errorMsg);
    if (onExitCallback) {
      onExitCallback(null, null, errorMsg);
    }
    return;
  }

  const port = new URL(gatewayUrl).port || "8080";
  const env = {
    ...process.env,
    PORT: port,
  };

  log(`[GATEWAY] Starting gateway at: ${execConfig.cwd} using command: ${execConfig.command} ${execConfig.args.join(" ")}`);
  gatewayOutputChannel.appendLine(`[GATEWAY] Starting gateway at: ${execConfig.cwd}`);
  gatewayOutputChannel.appendLine(`[GATEWAY] Command: ${execConfig.command} ${execConfig.args.join(" ")}`);

  let stderrBuffer = "";

  try {
    const options: child_process.SpawnOptions = {
      cwd: execConfig.cwd,
      env,
      // shell=true is only needed for npx (a batch script on Windows that CMD
      // must interpret). Direct binary paths (.exe, .cmd, node) don't need it.
      shell: execConfig.command === "npx" || execConfig.command.endsWith(".cmd") ? true : undefined,
    };

    gatewayProcess = child_process.spawn(execConfig.command, execConfig.args, options);
    startedByUs = true;

    gatewayProcess.stdout?.on("data", (data) => {
      const text = data.toString();
      gatewayOutputChannel?.append(text);
    });

    gatewayProcess.stderr?.on("data", (data) => {
      const text = data.toString();
      stderrBuffer += text;
      gatewayOutputChannel?.append(`[stderr] ${text}`);
    });

    gatewayProcess.on("exit", (code, signal) => {
      log(`[GATEWAY] Process exited with code ${code}, signal ${signal}`);
      gatewayOutputChannel?.appendLine(`[GATEWAY] Process exited with code ${code}, signal ${signal}`);
      gatewayProcess = null;
      if (onExitCallback) {
        onExitCallback(code, signal, stderrBuffer);
      }
    });

    gatewayProcess.on("error", (err) => {
      log(`[GATEWAY] Process spawn error: ${err.message}`);
      gatewayOutputChannel?.appendLine(`[GATEWAY] Process spawn error: ${err.message}`);
      if (onExitCallback) {
        onExitCallback(null, null, err.message);
      }
    });

  } catch (err: any) {
    log(`[GATEWAY] Failed to spawn process: ${err.message}`);
    gatewayOutputChannel.appendLine(`Failed to spawn process: ${err.message}`);
    if (onExitCallback) {
      onExitCallback(null, null, err.message);
    }
  }
}

/**
 * Ensures the gateway is running.
 * 1. Checks if it is already running. If yes, returns true immediately.
 * 2. If not, spawns the gateway and polls /healthz for up to 30 seconds.
 * 3. Monitors for early exit (e.g. port conflict / EADDRINUSE) and reports it immediately.
 * 4. Returns { ok: true } or { ok: false, error: string }.
 */
export async function ensureGatewayRunning(
  context: vscode.ExtensionContext,
  gatewayUrl: string,
  log: (msg: string) => void
): Promise<{ ok: boolean; error?: string }> {
  const isRunning = await isGatewayRunning(gatewayUrl);
  if (isRunning) {
    log("[GATEWAY] Gateway is already running.");
    return { ok: true };
  }

  log("[GATEWAY] Gateway is not running. Starting in background...");
  const port = new URL(gatewayUrl).port || "8080";

  let spawnError: string | null = null;
  let hasExitedEarly = false;

  // Start the gateway process in background
  startGateway(context, gatewayUrl, log, (code, signal, stderrText) => {
    hasExitedEarly = true;
    if (
      stderrText.includes("EADDRINUSE") ||
      stderrText.includes("address already in use") ||
      stderrText.includes("port already in use") ||
      stderrText.includes("listen EADDRINUSE")
    ) {
      spawnError = `Unable to start the local gateway because port ${port} is already in use.`;
    } else {
      spawnError = `Local gateway exited immediately with code ${code ?? "unknown"} (signal: ${signal ?? "none"}).\nStderr: ${stderrText || "none"}`;
    }
  });

  // Poll healthz.
  // 30s: tsx cold-start on Windows (TypeScript compilation + better-sqlite3
  // native module load) regularly takes 15-25s on a warm disk cache, and even
  // longer on a cold one. 10s was too tight for dev mode.
  const start = Date.now();
  const timeoutMs = 30000;
  const pollInterval = 250;

  while (Date.now() - start < timeoutMs) {
    if (hasExitedEarly) {
      return { ok: false, error: spawnError || `Local gateway process exited unexpectedly during startup.` };
    }

    if (await isGatewayRunning(gatewayUrl)) {
      log("[GATEWAY] Gateway is now running and responsive.");
      return { ok: true };
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  // If we timed out, check if process died or is still running but unresponsive
  if (gatewayProcess) {
    return {
      ok: false,
      error: `Local gateway started but failed to respond to health checks at ${gatewayUrl} within ${timeoutMs / 1000}s. Check output logs.`
    };
  }

  return { ok: false, error: spawnError || `Local gateway failed to start within ${timeoutMs / 1000}s.` };
}

/**
 * Register deactivation hook to kill gateway process only if it was started by this instance.
 */
export function deactivateGateway(log: (msg: string) => void): void {
  if (startedByUs && gatewayProcess) {
    log("[GATEWAY] Killing gateway process started by us on deactivation.");
    gatewayProcess.kill();
    gatewayProcess = null;
  }
}
