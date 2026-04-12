#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "用法: ./build.sh <version>"
  echo "示例: ./build.sh 0.3.2"
  exit 1
fi

DIST_DIR="$ROOT_DIR/dist"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# Collect files to restore on exit (build modifies package.json versions)
RESTORE_FILES=()
cleanup() {
  for f in "${RESTORE_FILES[@]}"; do
    [ -f "$f.bak" ] && mv "$f.bak" "$f"
  done
  rm -rf "$ROOT_DIR/server/dist"
}
trap cleanup EXIT

# Save a file for restore on exit
save_for_restore() {
  cp "$1" "$1.bak"
  RESTORE_FILES+=("$1")
}

PLATFORM=$(node -e "process.stdout.write(process.platform)")
echo "=== 构建 agent-tools v${VERSION} (${PLATFORM}) ==="

# Helper: pack minimal + full for a given package directory
# Usage: pack_both <dir> <output-prefix>
pack_both() {
  local dir="$1"
  local prefix="$2"

  cd "$dir"
  save_for_restore "$dir/package.json"

  npm install --ignore-scripts --omit=dev
  npm version "$VERSION" --no-git-tag-version --allow-same-version

  # ── Minimal ──
  npm pack
  local minimal="${prefix}-${VERSION}.tgz"
  for f in *.tgz; do
    [ "$f" = "$minimal" ] || mv "$f" "$minimal"
  done
  cp "$minimal" "$DIST_DIR/"
  rm -f "$minimal"
  echo "  -> $DIST_DIR/$minimal"

  # ── Full (bundle all dependencies, platform-specific) ──
  # Re-install WITH scripts so native modules (better-sqlite3) are compiled
  npm install --omit=dev
  node -e "
    const pkg = require('./package.json');
    pkg.bundleDependencies = true;
    require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  npm pack
  local full="${prefix}-full-${PLATFORM}-${VERSION}.tgz"
  for f in *.tgz; do
    [ "$f" = "$full" ] || mv "$f" "$full"
  done
  cp "$full" "$DIST_DIR/"
  rm -f "$full"
  echo "  -> $DIST_DIR/$full"
}

# ── CLI ──
echo ""
echo "── 1. 构建 CLI ──"
pack_both "$ROOT_DIR/cli" "agent-tools-cli"

# ── 内嵌 CLI minimal tgz 到 Server ──
echo ""
echo "── 2. 内嵌 CLI tgz 到 Server ──"
mkdir -p "$ROOT_DIR/server/dist"
cp "$DIST_DIR/agent-tools-cli-${VERSION}.tgz" "$ROOT_DIR/server/dist/agent-tools-cli.tgz"
echo "  -> server/dist/agent-tools-cli.tgz"

# ── Server ──
echo ""
echo "── 3. 构建 Server ──"
pack_both "$ROOT_DIR/server" "agent-tools-server"

# ── 完成 ──
echo ""
echo "=== 构建完成 ==="
echo ""
echo "产物目录: $DIST_DIR/"
ls -lh "$DIST_DIR/"
echo ""
echo "安装方式 (minimal，需联网下载依赖):"
echo "  npm install -g $DIST_DIR/agent-tools-cli-${VERSION}.tgz"
echo "  npm install -g $DIST_DIR/agent-tools-server-${VERSION}.tgz"
echo ""
echo "安装方式 (full，离线安装，仅限 ${PLATFORM}):"
echo "  npm install -g $DIST_DIR/agent-tools-cli-full-${PLATFORM}-${VERSION}.tgz"
echo "  npm install -g $DIST_DIR/agent-tools-server-full-${PLATFORM}-${VERSION}.tgz"
