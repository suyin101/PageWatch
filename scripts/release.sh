#!/bin/bash
# 发布新版本（开发者在 Mac 上用）：npm run release -- 1.5.0
# 前提：CHANGELOG.md 里已经写好 “## v1.5.0” 这一节；已用 gh auth login 登录 GitHub
# 会做：改版本号 → 提交并打标签 → 生成更新包和指纹 → 推送到 GitHub → 创建 Release
set -euo pipefail
cd "$(dirname "$0")/.."
VER="${1:-}"
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "用法：npm run release -- 1.5.0"; exit 1; }
TAG="v$VER"
git rev-parse "$TAG" >/dev/null 2>&1 && { echo "❌ $TAG 已经存在"; exit 1; }
grep -q "^## $TAG" CHANGELOG.md || { echo "❌ 请先在 CHANGELOG.md 里写好 “## $TAG” 这一节"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "❌ 还没登录 GitHub，先运行 gh auth login"; exit 1; }

# 从 CHANGELOG 里取出这个版本的更新说明
NOTES=$(awk -v tag="## $TAG" 'index($0, tag) == 1 {on=1; next} /^## v/ {on=0} on' CHANGELOG.md | sed -e '/./,$!d')

npm version "$VER" --no-git-tag-version >/dev/null
git add -A
git commit -qm "发布 $TAG"
git tag -a "$TAG" -m "PageWatch $TAG"

mkdir -p dist
ASSET="dist/pagewatch-$TAG.tar.gz"
git archive --format=tar.gz --prefix=pagewatch/ -o "$ASSET" "$TAG"
(cd dist && shasum -a 256 "pagewatch-$TAG.tar.gz" > "pagewatch-$TAG.tar.gz.sha256")

BRANCH=$(git rev-parse --abbrev-ref HEAD)
git push -q origin "$BRANCH" "$TAG"
gh release create "$TAG" "$ASSET" "$ASSET.sha256" --title "PageWatch $TAG" --notes "$NOTES"
echo "🎉 已发布 $TAG，服务器上点「检测更新」就能看到"
