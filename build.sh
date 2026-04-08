#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "用法: ./build.sh <version>"
  echo "示例: ./build.sh 0.3.1"
  exit 1
fi

DIST_DIR="$ROOT_DIR/dist"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

echo "=== 构建 agent-tools v${VERSION} ==="

# ── CLI ──
echo ""
echo "── 1. 构建 CLI ──"
cd "$ROOT_DIR/cli"
npm install --ignore-scripts --omit=dev
npm version "$VERSION" --no-git-tag-version --allow-same-version
npm pack
CLI_TGZ="agent-tools-cli-${VERSION}.tgz"
for f in *.tgz; do
  [ "$f" = "$CLI_TGZ" ] || mv "$f" "$CLI_TGZ"
done
cp "$CLI_TGZ" "$DIST_DIR/"
echo "  -> $DIST_DIR/$CLI_TGZ"

# ── 内嵌 CLI tgz 到 Server ──
echo ""
echo "── 2. 内嵌 CLI tgz 到 Server ──"
mkdir -p "$ROOT_DIR/server/dist"
cp "$CLI_TGZ" "$ROOT_DIR/server/dist/agent-tools-cli.tgz"
echo "  -> server/dist/agent-tools-cli.tgz"

# ── 生成版本清单 ──
echo ""
echo "── 3. 生成 client-version.json ──"
RELEASED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > "$ROOT_DIR/server/src/client-version.json" << EOF
{
  "version": "${VERSION}",
  "releasedAt": "${RELEASED_AT}"
}
EOF
echo "  -> version: ${VERSION}, releasedAt: ${RELEASED_AT}"

# ── Server ──
echo ""
echo "── 4. 构建 Server ──"
cd "$ROOT_DIR/server"
npm install --ignore-scripts --omit=dev
npm version "$VERSION" --no-git-tag-version --allow-same-version
npm pack
SERVER_TGZ="agent-tools-server-${VERSION}.tgz"
for f in *.tgz; do
  [ "$f" = "$SERVER_TGZ" ] || mv "$f" "$SERVER_TGZ"
done
cp "$SERVER_TGZ" "$DIST_DIR/"
echo "  -> $DIST_DIR/$SERVER_TGZ"

# ── 清理工作区临时文件 ──
echo ""
echo "── 5. 清理 ──"
rm -f "$ROOT_DIR/cli/$CLI_TGZ"
rm -f "$ROOT_DIR/server/$SERVER_TGZ"

# ── 完成 ──
echo ""
echo "=== 构建完成 ==="
echo "产物目录: $DIST_DIR/"
ls -lh "$DIST_DIR/"
echo ""
echo "安装方式:"
echo "  npm install -g $DIST_DIR/$CLI_TGZ"
echo "  npm install -g $DIST_DIR/$SERVER_TGZ"
