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
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode", "vectra", "@huggingface/transformers"],
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
