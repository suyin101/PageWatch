# PageWatch

网页元素变化监测工具，主要用来监测软件官网更新。界面和文档都是中文。部署在宝塔面板（国内服务器）。

## 结构
- `server.js` — Express 服务 + 全部 API，读取 `.env`。登录必需：账号（scrypt）和会话（只存令牌哈希）在 db.json；第一次访问走 `/api/setup`；同 IP 输错 5 次锁 10 分钟
- `src/store.js` — JSON 文件存储（`data/db.json`），故意不用数据库，免得宝塔上编译原生模块
- `src/browser.js` — Playwright Chromium：`readElement`（定时检查，屏蔽图片/字体）；`snapshot` 打开的网页会保留 5 分钟（sessions），`preview` 直接在上面读，几乎零等待。不要再等 networkidle 到超时，那是之前慢的主因
- `src/picker.js` — 注入快照里的点选脚本，通过 postMessage 与面板通信；`/api/snapshot` 用 CSP nonce 只允许它执行。两种模式：pick 选元素；browse 把点击发给 `/api/browse/click`，由 `clickInSession` 在后台真实网页上点（处理跳转/新窗口/弹窗），网址变了就把 session 改记到新网址下，前端再用新网址 `fresh=0` 取快照，并清掉上一页选的元素
- `src/selector.js` — 生成 CSS 选择器，快照（和 picker.js 一起注入）和后台真实网页（`locate`，用字符串 evaluate 绕开网站 CSP）共用。`snapshot` 会给真实网页每个元素打 `data-pw-i` 编号，快照里带着；点选后 `/api/browse/locate` 按编号在真实网页里重新生成选择器，浏览点击也优先按编号找
- `src/extract.js` — 「只看哪部分」提取（版本号/数字/正则），UMD 写法，服务器和网页（/extract.js）共用同一份
- `src/rules.js` — 判断规则 changed / gt / lt / increased
- `src/checker.js` — 每 20 秒扫一次到期的监测，并发 2
- `src/template.js` — 按词 LCS 对比新旧内容 + `{{中文变量}}` 模板；feishu（lark_md）和 plain 两种输出格式
- `src/notify.js` — 飞书卡片（支持签名）和通用 Webhook，都按模板生成；出错通知固定格式
- `launcher.js` — `npm start` 的入口，用子进程跑 server.js：退出码 99 立即重启（在线更新用），崩溃自动重启；子进程通过 ipc 断开感知启动器被杀
- `src/updater.js` — 在线更新：GitHub Releases（默认 suyin101/PageWatch）→ 下载（失败换加速镜像，仅在有官方 sha256 指纹时）→ 校验 → 解压 → 备份到 .update/backups → 覆盖 → 依赖变了才 npm install → exit(99)。失败自动恢复。status 带 downloaded/total 给前端进度条；前端更新成功后写 localStorage pw-just-updated，刷新后弹出本版本更新内容
- `scripts/reset-password.js` — 忘记密码时用（需先停服务）
- `public/` — 无构建步骤的原生 HTML/CSS/JS 前端

## 发布新版本
- 在 CHANGELOG.md 写好 `## vX.Y.Z — 日期` 一节（网站「设置 → 版本更新」通过 `/api/changelog` 直接显示这个文件，所以每个版本都必须写，用户能看懂的大白话），然后 `npm run release -- X.Y.Z`（改版本号、提交、打标签、git archive 打包 + sha256、推送、gh release create）
- 版本号：新功能加中间位，修 bug 加末位
- 服务器在国内，GitHub 可能慢；更新包要小，别把大文件提交进仓库

## 约定
- 监测的 `lastValue` 是提取后用来比较的值，`lastRaw` 是原文；下载链接读不到不算出错
- 备份不含登录账号；导入/恢复前先自动备份（before-restore-*），每日自动备份 auto-日期.json 保留 7 份
- 状态 `updated` 会一直保留，直到用户点“已处理”（`/ack`）
- 出错只在刚开始出错时通知一次
- 运行：`npm start`，默认端口 3600
- 部署：`npm run pack`（默认不带 data，首次搬家用 `--with-data`）→ 服务器首次 `bash deploy/install.sh`，更新用 `bash deploy/update.sh`（国内镜像、自动识别 apt/dnf、找宝塔的 /www/server/nodejs）。playwright 锁定版本，升级前先确认 npmmirror 上有对应浏览器版本；服务器上 `PLAYWRIGHT_BROWSERS_PATH=0` 把浏览器装在项目内
