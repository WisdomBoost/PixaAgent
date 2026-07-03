# Build the branded Pixa IDE distribution from VS Code OSS with pixa-agent as a built-in extension.
#
# Prerequisites (see ide/README.md): Node 20+, Python 3.11+, Visual Studio Build Tools
# with the "Desktop development with C++" workload. Expect the first build to take 1-2 hours.
#
# Usage:  pwsh ide/build.ps1 [-VSCodeTag 1.96.0]

param(
    [string]$VSCodeTag = "1.96.0"
)

$ErrorActionPreference = "Stop"
$ideDir = $PSScriptRoot
$repoRoot = Split-Path $ideDir -Parent
$vscodeDir = Join-Path $ideDir "vscode"

Write-Host "==> Pixa IDE build (VS Code OSS $VSCodeTag)" -ForegroundColor Cyan

# 1. Package the pixa-agent extension.
Write-Host "==> Packaging pixa-agent VSIX"
Push-Location (Join-Path $repoRoot "packages/pixa-agent")
try {
    npm run compile
    npx @vscode/vsce package --no-dependencies --out (Join-Path $ideDir "pixa-agent.vsix")
} finally {
    Pop-Location
}

# 2. Fetch VS Code OSS at the pinned tag.
if (-not (Test-Path $vscodeDir)) {
    Write-Host "==> Cloning microsoft/vscode at $VSCodeTag (shallow)"
    git clone --depth 1 --branch $VSCodeTag https://github.com/microsoft/vscode.git $vscodeDir
} else {
    Write-Host "==> Reusing existing clone at $vscodeDir"
}

# 3. Apply Pixa branding: merge our overrides into the OSS product.json.
Write-Host "==> Applying Pixa branding to product.json"
$productPath = Join-Path $vscodeDir "product.json"
$product = Get-Content $productPath -Raw | ConvertFrom-Json -AsHashtable
$overrides = Get-Content (Join-Path $ideDir "product.json") -Raw | ConvertFrom-Json -AsHashtable
foreach ($key in $overrides.Keys) { $product[$key] = $overrides[$key] }
$product | ConvertTo-Json -Depth 20 | Set-Content $productPath -Encoding utf8NoBOM

# 4. Stage pixa-agent as a built-in extension.
Write-Host "==> Bundling pixa-agent as built-in extension"
$builtinDir = Join-Path $vscodeDir ".build/builtInExtensions/pixa-agent"
New-Item -ItemType Directory -Force $builtinDir | Out-Null
# A VSIX is a zip; the extension payload lives under /extension.
Expand-Archive -Path (Join-Path $ideDir "pixa-agent.vsix") -DestinationPath (Join-Path $ideDir "vsix-tmp") -Force
Copy-Item -Recurse -Force (Join-Path $ideDir "vsix-tmp/extension/*") $builtinDir
Remove-Item -Recurse -Force (Join-Path $ideDir "vsix-tmp")

# 5. Build the OSS distribution (the long part).
Write-Host "==> Building VS Code OSS (this takes 1-2 hours on first run)"
Push-Location $vscodeDir
try {
    npm ci
    npm run gulp -- "vscode-win32-x64"
} finally {
    Pop-Location
}

Write-Host "==> Done. Output: $(Join-Path $ideDir 'VSCode-win32-x64') (sibling of the clone)" -ForegroundColor Green
Write-Host "    Launch Code.exe from that folder — Pixa Agent is built in."
