#!/bin/bash
# 在 Mac 上运行：npm run pack
# 生成上传到服务器用的压缩包（放在桌面），不包含 node_modules（服务器上会重新安装）
set -e
cd "$(dirname "$0")/.."
OUT="$HOME/Desktop/pagewatch.zip"
rm -f "$OUT"
EXCLUDE=(-x "node_modules/*" -x ".git/*" -x ".env" -x "*.DS_Store" -x "data/*.tmp")
if [ "$1" = "--no-data" ]; then
  EXCLUDE+=(-x "data/*")
  echo "不带数据：服务器上会是全新的空白状态"
else
  echo "带上数据：你现在的监测、通知设置、登录账号都会一起搬到服务器"
fi
zip -qr "$OUT" . "${EXCLUDE[@]}"
echo "✅ 已生成：${OUT}（$(du -h "$OUT" | cut -f1)）"
