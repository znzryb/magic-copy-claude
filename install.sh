#!/usr/bin/env bash
# 把插件同步到 Chrome 实际加载的目录。
#
# Chrome 里那个「已加载的扩展程序」指向的是 ~/chrome-extensions/magic-copy-claude/，
# 不是这个仓库目录。改完代码只在仓库里改是不生效的 —— 必须跑一遍本脚本，
# 再去 chrome://extensions 点「重新加载」。
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/chrome-extensions/magic-copy-claude"

mkdir -p "$DEST"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'test' \
  --exclude '__pycache__' \
  --exclude '.DS_Store' \
  --exclude 'install.sh' \
  "$SRC/" "$DEST/"

echo "已同步 → $DEST"
echo "接着去 chrome://extensions 点一下「重新加载」才会生效。"
