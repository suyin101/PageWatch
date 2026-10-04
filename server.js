const fs = require('fs');
const path = require('path');

// 读取项目目录下的 .env 配置文件（宝塔上改这个文件最方便）
const ENV_FILE = path.join(__dirname, '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const express = require('express');
const compression = require('compression');
const crypto = require('crypto');
const store = require('./src/store');
const checker = require('./src/checker');
const browser = require('./src/browser');
const { notify, preview: previewTemplates, SAMPLE_EVENT } = require('./src/notify');
const { RULES } = require('./src/rules');
const tpl = require('./src/template');

const PORT = Number(process.env.PORT) || 3600;
const HOST = process.env.HOST || '0.0.0.0';

// 可以在 .env 里预先设置管理员账号，部署到服务器时就不用担心被别人抢先注册
if (!store.hasAccount() && process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) {
  store.setAccount(process.env.ADMIN_USER, process.env.ADMIN_PASSWORD);
  console.log(`已根据 .env 创建管理员账号：${process.env.ADMIN_USER}`);
}

const app = express();
app.set('trust proxy', true);
app.use(compression()); // 网页文件和数据压缩后再传，打开更快
app.use(express.json({ limit: '1mb' }));

// ---------- 登录 ----------
const COOKIE = 'pw_session';

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}

const isAuthed = (req) => store.validSession(readCookie(req, COOKIE));

function startSession(req, res) {
  const { token, maxAge } = store.createSession();
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

// 防止暴力猜密码：同一个 IP 连续输错 5 次，锁 10 分钟
const failures = new Map(); // ip -> { count, until }
function lockedFor(ip) {
  const f = failures.get(ip);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60_000) : 0;
}
function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) {
    f.until = Date.now() + 10 * 60_000;
    f.count = 0;
  }
  failures.set(ip, f);
}

function checkNewAccount(username, password) {
  if (!/^[\w\u4e00-\u9fa5.@-]{2,32}$/.test(username)) throw new Error('用户名 2-32 位，可以用中文、字母、数字');
  if (password.length < 6) throw new Error('密码至少 6 位');
}

const wrap = (fn) => (req, res) =>
  Promise.resolve().then(() => fn(req, res)).catch((e) => res.status(400).json({ error: e.message.split('\n')[0] }));

function view(m) {
  const { history, ...rest } = m;
  return { ...rest, checking: checker.isChecking(m.id) };
}

function meta() {
  return {
    rules: RULES,
    variables: tpl.VARIABLES,
    defaults: { feishuTitleTemplate: tpl.DEFAULT_FEISHU_TITLE, feishuTemplate: tpl.DEFAULT_FEISHU_BODY },
  };
}

// 打开页面需要的所有数据一次给全，省掉好几轮来回请求（服务器在远处时每一轮都要等）
function bootstrap() {
  return {
    authed: true,
    hasAccount: true,
    username: store.getUsername(),
    meta: meta(),
    settings: store.getSettings(),
    monitors: store.listMonitors().map(view),
  };
}

app.get('/api/me', (req, res) =>
  res.json({ authed: isAuthed(req), hasAccount: store.hasAccount(), username: isAuthed(req) ? store.getUsername() : '' })
);

app.get('/api/bootstrap', (req, res) =>
  res.json(isAuthed(req) ? bootstrap() : { authed: false, hasAccount: store.hasAccount() })
);

// 第一次使用：创建管理员账号（已有账号时不能再调用）
app.post(
  '/api/setup',
  wrap((req, res) => {
    if (store.hasAccount()) return res.status(403).json({ error: '管理员账号已经存在，请直接登录' });
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    checkNewAccount(username, password);
    store.setAccount(username, password);
    startSession(req, res);
    res.json({ ok: true, ...bootstrap() });
  })
);

app.post('/api/login', (req, res) => {
  const mins = lockedFor(req.ip);
  if (mins) return res.status(429).json({ error: `密码错误次数太多，请 ${mins} 分钟后再试` });
  if (!store.checkPassword(String(req.body.username || '').trim(), String(req.body.password || ''))) {
    recordFailure(req.ip);
    return res.status(401).json({ error: '用户名或密码不对' });
  }
  failures.delete(req.ip);
  startSession(req, res);
  res.json({ ok: true, ...bootstrap() });
});

app.post('/api/logout', (req, res) => {
  store.deleteSession(readCookie(req, COOKIE));
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// 下面所有接口都要先登录
app.use('/api', (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: '请先登录' })));

app.put(
  '/api/account',
  wrap((req, res) => {
    if (!store.checkPassword(store.getUsername(), String(req.body.currentPassword || ''))) throw new Error('当前密码不对');
    const username = String(req.body.username || store.getUsername()).trim();
    const password = String(req.body.newPassword || '') || String(req.body.currentPassword);
    checkNewAccount(username, password);
    store.setAccount(username, password); // 会让所有设备退出登录
    startSession(req, res); // 当前这台保持登录
    res.json({ ok: true, username });
  })
);

// ---------- 接口 ----------

function validate(body, partial) {
  if (!partial || body.url !== undefined) {
    try {
      const u = new URL(body.url);
      if (!/^https?:$/.test(u.protocol)) throw 0;
    } catch {
      throw new Error('网址格式不对，要以 http:// 或 https:// 开头');
    }
  }
  if ((!partial || body.selector !== undefined) && !String(body.selector || '').trim()) throw new Error('请先选择一个网页元素');
  if (body.rule !== undefined && !RULES[body.rule]) throw new Error('未知的判断规则');
  if (['gt', 'lt'].includes(body.rule) && (body.threshold === '' || Number.isNaN(Number(body.threshold))))
    throw new Error('“大于/小于”规则需要填写一个数字');
}

app.get('/api/meta', (req, res) => res.json(meta()));

function checkTemplates(settings) {
  if (settings.webhookTemplate) tpl.renderJson(settings.webhookTemplate, tpl.variables(SAMPLE_EVENT, 'plain'));
}

app.get('/api/settings', (req, res) => res.json(store.getSettings()));
app.put(
  '/api/settings',
  wrap((req, res) => {
    checkTemplates({ ...store.getSettings(), ...req.body });
    res.json(store.updateSettings(req.body));
  })
);

// 用示例数据预览模板效果（可以传入还没保存的模板）
app.post(
  '/api/templates/preview',
  wrap((req, res) => res.json(previewTemplates({ ...store.getSettings(), ...req.body })))
);
app.post(
  '/api/settings/test',
  wrap(async (req, res) => {
    const results = await notify(SAMPLE_EVENT);
    if (!results.length) throw new Error('还没有填写任何通知地址');
    res.json({ results });
  })
);

app.get('/api/monitors', (req, res) => res.json(store.listMonitors().map(view)));

app.get('/api/monitors/:id', (req, res) => {
  const m = store.getMonitor(req.params.id);
  m ? res.json({ ...view(m), history: m.history }) : res.status(404).json({ error: '监测不存在' });
});

app.post(
  '/api/monitors',
  wrap((req, res) => {
    validate(req.body, false);
    const m = store.createMonitor(req.body);
    if (m.enabled) checker.enqueue(m.id); // 马上检查一次，记下当前值
    res.json(view(m));
  })
);

app.put(
  '/api/monitors/:id',
  wrap((req, res) => {
    validate(req.body, true);
    const m = store.updateMonitor(req.params.id, req.body);
    if (!m) return res.status(404).json({ error: '监测不存在' });
    if (m.enabled && m.status === 'pending') checker.enqueue(m.id);
    res.json(view(m));
  })
);

app.delete('/api/monitors/:id', (req, res) => {
  store.deleteMonitor(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: '监测不存在' });
});

app.post(
  '/api/monitors/:id/check',
  wrap(async (req, res) => {
    if (checker.isChecking(req.params.id)) throw new Error('正在检查中，请稍等');
    const r = await checker.checkMonitor(req.params.id);
    res.json({ ...r, monitor: r.monitor && view(r.monitor) });
  })
);

app.post('/api/monitors/:id/ack', (req, res) => {
  const m = store.acknowledge(req.params.id);
  m ? res.json(view(m)) : res.status(404).json({ error: '监测不存在' });
});

// 不保存，只试读一下元素内容
app.post(
  '/api/preview',
  wrap(async (req, res) => {
    validate(req.body, false);
    res.json(await browser.preview(req.body.url, req.body.selector, req.body.attribute));
  })
);

// 编辑监测时“发送测试通知”：用这个监测自己的名称、网址和内容，模拟一次变化发出去
function fakeChange(value) {
  // 把最后一个数字加 1，比如 v2.3.1 → v2.3.2，这样能看到“变化”是怎么标出来的
  const m = value.match(/(\d+)(?!.*\d)/s);
  if (m) return value.slice(0, m.index) + (Number(m[1]) + 1) + value.slice(m.index + m[1].length);
  return value + '（新）';
}

app.post(
  '/api/monitors/test-notify',
  wrap(async (req, res) => {
    const b = req.body;
    const s = store.getSettings();
    const feishu = !!s.feishuWebhook && b.notifyFeishu !== false;
    const hook = !!s.customWebhook && b.notifyWebhook !== false;
    if (!s.feishuWebhook && !s.customWebhook) throw new Error('还没填写通知地址，请先到「设置 → 通知渠道」里填写');
    if (!feishu && !hook) throw new Error('这个监测的「飞书通知」和「Webhook 通知」都没勾选');
    const saved = b.id ? store.getMonitor(b.id) : null;
    const value = String(b.value || saved?.lastValue || '').trim() || '示例内容 v1.0';
    const monitor = {
      id: b.id || 'test',
      name: `【测试】${b.name || '未命名监测'}`,
      url: b.url || 'https://example.com',
      selector: b.selector || '',
      rule: b.rule || 'changed',
      threshold: b.threshold,
      note: b.note || '',
      notifyFeishu: b.notifyFeishu !== false,
      notifyWebhook: b.notifyWebhook !== false,
    };
    const results = await notify({ kind: 'test', monitor, oldValue: value, newValue: fakeChange(value) });
    res.json({ results });
  })
);

// 给“点选元素”用的网页快照，在 iframe 里显示
const PICKER_JS = fs.readFileSync(path.join(__dirname, 'src', 'picker.js'), 'utf8');

app.get('/api/snapshot', async (req, res) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  // 只允许我们自己的点选脚本运行，网页原来的脚本一律不执行
  res.setHeader('Content-Security-Policy', `script-src 'nonce-${nonce}'; frame-ancestors 'self'; form-action 'none'`);
  res.type('html');
  try {
    validate({ url: req.query.url, selector: 'x' }, false);
    // fresh=0：重新打开编辑窗口时，直接用已经打开着的网页，不用再等
    const { html } = await browser.snapshot(req.query.url, { fresh: req.query.fresh !== '0' });
    const inject = `<script nonce="${nonce}">${PICKER_JS}</script>`;
    res.send(html.includes('</body>') ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, inject + '</body>') : html + inject);
  } catch (e) {
    const msg = String(e.message).split('\n')[0].replace(/[<>&]/g, '');
    res.send(
      `<!doctype html><meta charset="utf-8"><body style="font:15px -apple-system,sans-serif;padding:40px;color:#b42318">` +
        `网页加载失败：${msg}<br><br><span style="color:#666">可以检查网址是否正确，或者直接在右侧手动填写 CSS 选择器。</span>` +
        `<script nonce="${nonce}">parent.postMessage({type:'pw-loaded',ok:false},'*')</script></body>`
    );
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, HOST, () => {
  console.log(`PageWatch 已启动：http://localhost:${PORT}`);
  if (!store.hasAccount()) console.log('第一次使用：打开上面的地址创建管理员账号');
  browser.warmup();
  checker.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await browser.closeBrowser();
    process.exit(0);
  });
}

// 万一某个地方出了没预料到的错，记下来，但不要让整个程序退出（否则监测就停了）
process.on('unhandledRejection', (e) => console.error('[未处理的错误]', e));
process.on('uncaughtException', (e) => console.error('[未处理的错误]', e));
