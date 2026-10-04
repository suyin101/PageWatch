#!/bin/bash
# 在 Mac 上运行，生成上传到服务器用的压缩包（放在桌面），不包含 node_modules（服务器上会重新安装）
#   npm run pack                  更新用：不带数据，不会覆盖服务器上的监测和设置
#   npm run pack -- --with-data   第一次搬家用：带上 Mac 上的监测、设置和账号
set -e
cd "$(dirname "$0")/.."
OUT="$HOME/Desktop/pagewatch.zip"
rm -f "$OUT"
EXCLUDE=(-x "node_modules/*" -x ".git/*" -x "dist/*" -x ".update/*" -x ".env" -x "*.DS_Store" -x "data/*.tmp")
if [ "$1" = "--with-data" ]; then
  echo "⚠️  带上数据：Mac 上的监测、通知设置、登录账号会一起打包，解压到服务器会覆盖那边的数据"
else
  EXCLUDE+=(-x "data/*")
  echo "不带数据：放心解压覆盖，服务器上的监测和设置不会被动"
fi
zip -qr "$OUT" . "${EXCLUDE[@]}"
echo "✅ 已生成：${OUT}（$(du -h "$OUT" | cut -f1 | tr -d ' ')）"
