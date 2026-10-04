#!/bin/bash
# PageWatch 服务器一键安装脚本（在宝塔终端里运行）
#   cd /www/wwwroot/pagewatch && bash deploy/install.sh
# 会做这些事：检查系统 → 找到 Node.js → 安装依赖 → 安装浏览器和系统库 → 生成 .env → 自检
# 全部使用国内镜像。可以重复运行，不会弄坏已有数据。
set -e
cd "$(dirname "$0")/.."
APP_DIR=$(pwd)
NPM_MIRROR=https://registry.npmmirror.com
export PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright
# 浏览器装在项目目录里，宝塔用 www 用户运行时也能用
export PLAYWRIGHT_BROWSERS_PATH=0

step() { echo; echo "==== $1 ===="; }
fail() { echo; echo "❌ $1"; exit 1; }

[ "$(id -u)" = "0" ] || fail "请用 root 运行（宝塔终端默认就是 root）"

step "1/6 检查系统"
. /etc/os-release 2>/dev/null || true
echo "系统：${PRETTY_NAME:-未知}  架构：$(uname -m)"
if [ "$ID" = "centos" ] && [ "${VERSION_ID%%.*}" = "7" ]; then
  fail "CentOS 7 太老了，装不了 Node.js 20 和新版浏览器。请在云服务器控制台把系统重装为 Ubuntu 22.04，再装宝塔。"
fi
if command -v apt-get >/dev/null; then PKG=apt
elif command -v dnf >/dev/null; then PKG=dnf
elif command -v yum >/dev/null; then PKG=yum
else fail "不认识的系统，没有 apt/dnf/yum"; fi
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
SWAP_MB=$(awk '/SwapTotal/ {print int($2/1024)}' /proc/meminfo)
echo "内存：${MEM_MB}MB  交换分区：${SWAP_MB}MB"
if [ "$MEM_MB" -lt 1800 ] && [ "$SWAP_MB" -lt 1000 ]; then
  echo "⚠️  内存偏小。建议在宝塔「软件商店 → Linux工具箱」里添加 2048MB 的 Swap，防止打开大网页时内存不够。"
fi

step "2/6 查找 Node.js（需要 20 或更新）"
NODE_BIN=""
for n in $(command -v node 2>/dev/null) $(ls -d /www/server/nodejs/v*/bin/node 2>/dev/null | sort -V -r); do
  v=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$v" -ge 20 ]; then NODE_BIN=$n; break; fi
done
[ -n "$NODE_BIN" ] || fail "没找到 Node.js 20+。请在宝塔「软件商店」安装「Node.js版本管理器」，再在里面安装 v20 或 v22，然后重新运行本脚本。"
export PATH="$(dirname "$NODE_BIN"):$PATH"
echo "使用 Node $(node -v)：$NODE_BIN"

step "3/6 安装项目依赖（国内镜像）"
npm ci --omit=dev --registry=$NPM_MIRROR --no-audit --no-fund

step "4/6 安装浏览器需要的系统库"
if [ "$PKG" = "apt" ]; then
  npx playwright install-deps chromium
else
  $PKG install -y nss atk at-spi2-atk cups-libs libdrm libxkbcommon libXcomposite libXdamage libXrandr \
    libXfixes libXext libX11 libxcb mesa-libgbm pango cairo alsa-lib libxshmfence expat \
    || echo "⚠️  有些库没装上，继续尝试；如果最后自检失败，把上面的报错发给我"
fi

step "5/6 下载浏览器（国内镜像，约 120MB）"
npx playwright install --only-shell chromium

step "6/6 配置并自检"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "已生成 .env（端口 3600）"
fi
grep -q '^PLAYWRIGHT_BROWSERS_PATH=' .env || printf '\n# 浏览器装在项目目录里（安装脚本自动添加）\nPLAYWRIGHT_BROWSERS_PATH=0\n' >> .env
mkdir -p data
# 宝塔的 Node 项目默认用 www 用户运行，让它能读写项目文件
id www >/dev/null 2>&1 && chown -R www:www "$APP_DIR"
node scripts/selftest.js https://www.baidu.com || fail "浏览器自检失败，把上面的输出发给我看看"

PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-3600}
echo
echo "🎉 安装完成！接下来在宝塔里添加 Node 项目："
echo "   项目目录：$APP_DIR"
echo "   启动选项：start（也就是 npm start）"
echo "   项目端口：$PORT"
echo "   Node 版本：$(node -v)"
