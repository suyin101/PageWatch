#!/bin/bash
# 更新 PageWatch（上传新版并解压覆盖后，在宝塔终端运行）：
#   cd /www/wwwroot/你的项目目录 && bash deploy/update.sh
# 只安装新增的依赖，不会重新下载浏览器，也不会动 data 和 .env
set -e
cd "$(dirname "$0")/.."
NODE_BIN=""
for n in $(command -v node 2>/dev/null) $(ls -d /www/server/nodejs/v*/bin/node 2>/dev/null | sort -V -r); do
  v=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$v" -ge 20 ]; then NODE_BIN=$n; break; fi
done
[ -n "$NODE_BIN" ] || { echo "❌ 没找到 Node.js 20+"; exit 1; }
export PATH="$(dirname "$NODE_BIN"):$PATH"
echo "==== 安装依赖（国内镜像）===="
npm install --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund
echo "==== 检查浏览器组件（丢了会自动下载，国内镜像）===="
node -e "require('./src/chromium').ensure().then(() => console.log('浏览器组件正常'), (e) => { console.error(e.message); process.exit(1); })"
id www >/dev/null 2>&1 && { chown -R www:www . 2>/dev/null || true; }
echo
echo "🎉 更新完成！最后一步：宝塔 → 网站 → Node项目 → PageWatch 那一行点「重启」"
