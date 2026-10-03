# PageWatch 网页监测

监测任意网页上的某个元素（版本号、更新日期、下载链接、价格……），一旦变化就通过 **飞书机器人** 或 **Webhook** 通知你。

## 功能

- 输入网址 → 在网页预览里**直接点击**要监测的元素
- 判断规则：内容发生变化 / 数字大于某值 / 数字小于某值 / 数字或版本号比上次大
- 总面板：全部、有更新待处理、正常、出错、已暂停 数量一目了然，点击卡片可筛选
- 每个监测都可以编辑、删除、暂停、立即检查、查看变化历史
- 发现更新后状态保持“有更新”，处理完（比如已上传新版本）点 **✓ 已处理** 即可
- 网页打不开或元素找不到时也会通知一次，避免监测悄悄失效

## 在 Mac 上运行

```bash
cd ~/Projects/PageWatch
npm install        # 第一次运行需要，会自动下载 Chromium 浏览器
npm start
```

然后打开浏览器访问 http://localhost:3600

> 只有电脑开着、终端里程序在运行时才会定时检查。

## 部署到宝塔面板

1. **上传代码**：把整个项目文件夹（不需要 `node_modules` 和 `data`）上传到服务器，比如 `/www/wwwroot/pagewatch`
2. **安装 Node.js**：宝塔 → 软件商店 → 安装「Node.js 版本管理器」，装 Node 18 或更新版本
3. **写配置**：在项目文件夹里把 `.env.example` 复制为 `.env`，**一定要设置 `PASSWORD`**
4. **安装依赖**：宝塔 → 终端，执行
   ```bash
   cd /www/wwwroot/pagewatch
   npm install
   npx playwright install-deps chromium   # 安装浏览器需要的系统库（Ubuntu/Debian）
   ```
   如果是 CentOS 系统，`install-deps` 不支持，请改用 Ubuntu/Debian 系统，或参考 Playwright 文档手动安装依赖。
5. **添加项目**：宝塔 → 网站 → Node 项目 → 添加 Node 项目
   - 项目目录：`/www/wwwroot/pagewatch`
   - 启动选项：`npm start`（或启动文件 `server.js`）
   - 端口：`3600`（和 `.env` 里一致）
   - 绑定域名，然后在「SSL」里申请证书开启 HTTPS
6. 访问你的域名，输入密码登录

**内存提示**：每次检查会打开一个浏览器页面，建议服务器至少 1GB 内存。内存小的话可以把 `src/checker.js` 里的 `CONCURRENCY` 改成 1。

**数据备份**：所有数据都在 `data/db.json` 一个文件里，备份它就行。

## 通用 Webhook 的数据格式

有更新时会向你填写的地址发送 `POST` 请求，内容是 JSON：

```json
{
  "event": "updated",
  "monitor": { "id": "…", "name": "达芬奇最新版", "url": "https://…", "selector": "span.ver", "rule": "increased", "note": "" },
  "oldValue": "Version 19.1.3",
  "newValue": "Version 19.1.4",
  "error": null,
  "time": "2026-10-04T08:00:00.000Z"
}
```

`event` 可能是 `updated`（发现更新）、`error`（监测出错）、`test`（测试通知）。

## 小技巧

- 点到的范围太小（比如只选中了一个数字），点右侧的 **⬆ 选父级** 扩大范围
- 想监测下载链接是否变了，在「读取内容」里选 **链接地址（href）**
- 保存前点 **🔄 真实读取测试**，确认后台真的能读到这个元素
- 第一次检查只会记下当前内容作为基准，之后有变化才通知
