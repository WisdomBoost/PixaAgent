import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "node:fs";

const watch = process.argv.includes("--watch");

const copyAssets = {
  name: "copy-assets",
  setup(build) {
    build.onEnd(() => {
      mkdirSync("dist/webview", { recursive: true });
      if (existsSync("src/ui/webview")) {
        cpSync("src/ui/webview", "dist/webview", { recursive: true });
      }
      if (existsSync("models.json")) {
        cpSync("models.json", "dist/models.json");
      }
      // Copy compiled gateway if it exists in the monorepo sibling (without node_modules)
      const gatewayDist = "../gateway/dist";
      if (existsSync(gatewayDist)) {
        mkdirSync("dist/gateway", { recursive: true });
        cpSync(gatewayDist, "dist/gateway", { recursive: true });
        if (existsSync("../gateway/package.json")) {
          cpSync("../gateway/package.json", "dist/gateway/package.json");
        }
      }
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  // vectra is pure JS and lazy-requires @huggingface/transformers only when
  // embeddings are actually used, so it's safe to bundle. transformers itself
  // (and its native onnxruntime binary) stays external and unbundled — vsce
  // package --no-dependencies ships no node_modules, so any eager top-level
  // require of it would crash activation. It's only ever dynamically
  // imported behind try/catch (see providers/embeddings.ts), so when it's
  // missing, semantic search just fails to enable instead of taking down the
  // whole extension.
  external: ["vscode", "@huggingface/transformers"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  plugins: [copyAssets],
});

if (watch) {
  await ctx.watch();
  console.log("[esbuild] watching...");
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log("[esbuild] build complete");
}
