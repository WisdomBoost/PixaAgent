# Pixa IDE distribution layer

This folder turns VS Code OSS into the branded **Pixa IDE** with `pixa-agent`
shipped as a built-in extension. This is the same architecture Cursor-class
products use: the AI product logic lives in the extension (identical code in
stock VS Code and in the fork), and this layer only handles branding and
packaging. Nothing in `packages/pixa-agent` depends on the fork.

## Prerequisites (Windows)

- Node.js 20+ (22 recommended by upstream)
- Python 3.11+
- Visual Studio Build Tools with the **Desktop development with C++** workload
  (required by VS Code's native modules)
- ~30 GB free disk, and expect **1–2 hours** for the first build

See upstream's guide for the authoritative list:
https://github.com/microsoft/vscode/wiki/How-to-Contribute

## Build

```powershell
pwsh ide/build.ps1                # uses the pinned default VS Code tag
pwsh ide/build.ps1 -VSCodeTag 1.97.0
```

Linux/macOS: `ide/build.sh [tag]`

What it does:

1. Compiles and packages `pixa-agent` into a VSIX.
2. Shallow-clones `microsoft/vscode` at the pinned tag into `ide/vscode/`
   (gitignored).
3. Merges `ide/product.json` (branding, OpenVSX gallery) over the OSS
   `product.json`.
4. Unpacks the VSIX into `.build/builtInExtensions/pixa-agent` so it ships
   built in.
5. Runs the standard OSS `gulp vscode-win32-x64` build.

The output folder (e.g. `VSCode-win32-x64`, created as a sibling of the clone)
contains `Code.exe` — rename/installer polish comes later. Pixa Agent appears
in the activity bar out of the box.

## Day-to-day development

You do NOT need the fork build to work on the product. From the repo root:

1. `npm install && npm run compile`
2. Open this repo in VS Code and press **F5** ("Run Pixa Agent") — an
   Extension Development Host launches with the exact same extension the fork
   ships.

## Extension marketplace note

The fork points at **Open VSX** (open-vsx.org), not Microsoft's marketplace —
Microsoft's marketplace terms only allow official VS Code builds to use it.

## Upgrading the base

Bump the tag argument. Because we never patch VS Code source (only
`product.json` + a built-in extension), upstream upgrades are a re-run of the
script, not a merge.
