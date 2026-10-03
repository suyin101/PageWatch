# PageWatch

网页元素变化监测工具。用来监测软件官网更新，好及时在自己网站上传新版本。计划部署到宝塔面板。

## 结构
- `server.js` — Express 服务 + 全部 API，读取 `.env`，可选 `PASSWORD` 登录（cookie）
- `src/store.js` — JSON 文件存储（`data/db.json`），故意不用数据库，免得宝塔上编译原生模块
- `src/browser.js` — Playwright Chromium：`readElement` 读元素、`snapshot` 生成去掉脚本的静态快照
- `src/picker.js` — 注入快照里的点选脚本，通过 postMessage 与面板通信；`/api/snapshot` 用 CSP nonce 只允许它执行
- `src/rules.js` — 判断规则 changed / gt / lt / increased
- `src/checker.js` — 每 20 秒扫一次到期的监测，并发 2
- `src/notify.js` — 飞书卡片（支持签名）和通用 Webhook
- `public/` — 无构建步骤的原生 HTML/CSS/JS 前端

## 约定
- 状态 `updated` 会一直保留，直到用户点“已处理”（`/ack`）
- 出错只在刚开始出错时通知一次
- 运行：`npm start`，默认端口 3600
