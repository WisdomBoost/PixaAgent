#!/usr/bin/env bash
# Build the branded Pixa IDE distribution from VS Code OSS with pixa-agent built in.
# Linux/macOS equivalent of build.ps1. See ide/README.md for prerequisites.
#
# Usage:  ide/build.sh [vscode-tag]
set -euo pipefail

VSCODE_TAG="${1:-1.96.0}"
IDE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$IDE_DIR")"
VSCODE_DIR="$IDE_DIR/vscode"

echo "==> Pixa IDE build (VS Code OSS $VSCODE_TAG)"

echo "==> Packaging pixa-agent VSIX"
(cd "$REPO_ROOT/packages/pixa-agent" \
  && npm run compile \
  && npx @vscode/vsce package --no-dependencies --out "$IDE_DIR/pixa-agent.vsix")

if [ ! -d "$VSCODE_DIR" ]; then
  echo "==> Cloning microsoft/vscode at $VSCODE_TAG (shallow)"
  git clone --depth 1 --branch "$VSCODE_TAG" https://github.com/microsoft/vscode.git "$VSCODE_DIR"
else
  echo "==> Reusing existing clone at $VSCODE_DIR"
fi

echo "==> Applying Pixa branding to product.json"
node -e '
const fs = require("fs");
const productPath = process.argv[1];
const overridesPath = process.argv[2];
const product = JSON.parse(fs.readFileSync(productPath, "utf8"));
const overrides = JSON.parse(fs.readFileSync(overridesPath, "utf8"));
fs.writeFileSync(productPath, JSON.stringify({ ...product, ...overrides }, null, 2));
' "$VSCODE_DIR/product.json" "$IDE_DIR/product.json"

echo "==> Bundling pixa-agent as built-in extension"
BUILTIN_DIR="$VSCODE_DIR/.build/builtInExtensions/pixa-agent"
mkdir -p "$BUILTIN_DIR" "$IDE_DIR/vsix-tmp"
unzip -oq "$IDE_DIR/pixa-agent.vsix" -d "$IDE_DIR/vsix-tmp"
cp -R "$IDE_DIR/vsix-tmp/extension/." "$BUILTIN_DIR/"
rm -rf "$IDE_DIR/vsix-tmp"

echo "==> Building VS Code OSS (this takes 1-2 hours on first run)"
TARGET="vscode-linux-x64"
[ "$(uname)" = "Darwin" ] && TARGET="vscode-darwin-$(uname -m | sed 's/x86_64/x64/')"
(cd "$VSCODE_DIR" && npm ci && npm run gulp -- "$TARGET")

echo "==> Done. Output is a sibling folder of the clone (e.g. VSCode-linux-x64). Pixa Agent is built in."
