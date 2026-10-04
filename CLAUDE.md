# PageWatch

网页元素变化监测工具。用来监测软件官网更新，好及时在自己网站上传新版本。计划部署到宝塔面板。

## 结构
- `server.js` — Express 服务 + 全部 API，读取 `.env`。登录必需：账号（scrypt）和会话（只存令牌哈希）在 db.json；第一次访问走 `/api/setup`；同 IP 输错 5 次锁 10 分钟
- `src/store.js` — JSON 文件存储（`data/db.json`），故意不用数据库，免得宝塔上编译原生模块
- `src/browser.js` — Playwright Chromium：`readElement`（定时检查，屏蔽图片/字体）；`snapshot` 打开的网页会保留 5 分钟（sessions），`preview` 直接在上面读，几乎零等待。不要再等 networkidle 到超时，那是之前慢的主因
- `src/picker.js` — 注入快照里的点选脚本，通过 postMessage 与面板通信；`/api/snapshot` 用 CSP nonce 只允许它执行
- `src/rules.js` — 判断规则 changed / gt / lt / increased
- `src/checker.js` — 每 20 秒扫一次到期的监测，并发 2
- `src/template.js` — 按词 LCS 对比新旧内容 + `{{中文变量}}` 模板；feishu（lark_md）和 plain 两种输出格式
- `src/notify.js` — 飞书卡片（支持签名）和通用 Webhook，都按模板生成；出错通知固定格式
- `scripts/reset-password.js` — 忘记密码时用（需先停服务）
- `public/` — 无构建步骤的原生 HTML/CSS/JS 前端

## 约定
- 状态 `updated` 会一直保留，直到用户点“已处理”（`/ack`）
- 出错只在刚开始出错时通知一次
- 运行：`npm start`，默认端口 3600
- 部署：`npm run pack` 打包 → 服务器 `bash deploy/install.sh`（国内镜像、自动识别 apt/dnf、找宝塔的 /www/server/nodejs）。playwright 锁定版本，升级前先确认 npmmirror 上有对应浏览器版本；服务器上 `PLAYWRIGHT_BROWSERS_PATH=0` 把浏览器装在项目内
