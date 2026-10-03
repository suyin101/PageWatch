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
const crypto = require('crypto');
const store = require('./src/store');
const checker = require('./src/checker');
const { readElement, snapshot, closeBrowser } = require('./src/browser');
const { notify } = require('./src/notify');
const { RULES } = require('./src/rules');

const PORT = Number(process.env.PORT) || 3600;
const HOST = process.env.HOST || '0.0.0.0';
// 设置了 PASSWORD 才需要登录。放到公网（宝塔）上一定要设置！
const PASSWORD = process.env.PASSWORD || '';
const TOKEN = PASSWORD ? crypto.createHmac('sha256', PASSWORD).update('pagewatch-session').digest('hex') : '';

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// ---------- 登录 ----------
function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : '';
}

function isAuthed(req) {
  if (!PASSWORD) return true;
  const t = readCookie(req, 'pw_session');
  return t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

app.post('/api/login', (req, res) => {
  if (!PASSWORD) return res.json({ ok: true });
  const given = String(req.body.password || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: '密码不对' });
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `pw_session=${TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'pw_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ authed: isAuthed(req), needPassword: !!PASSWORD }));

app.use('/api', (req, res, next) => (isAuthed(req) ? next() : res.status(401).json({ error: '请先登录' })));

// ---------- 接口 ----------
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => res.status(400).json({ error: e.message.split('\n')[0] }));

function view(m) {
  const { history, ...rest } = m;
  return { ...rest, checking: checker.isChecking(m.id) };
}

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

app.get('/api/meta', (req, res) => res.json({ rules: RULES }));

app.get('/api/settings', (req, res) => res.json(store.getSettings()));
app.put('/api/settings', wrap((req, res) => res.json(store.updateSettings(req.body))));
app.post(
  '/api/settings/test',
  wrap(async (req, res) => {
    const results = await notify({
      kind: 'test',
      monitor: { id: 'test', name: '测试通知', url: 'https://example.com', selector: 'h1', rule: 'changed', note: '收到这条说明通知配置正确 ✅' },
      oldValue: 'v1.0.0',
      newValue: 'v1.0.1',
    });
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
    res.json({ value: await readElement(req.body.url, req.body.selector, req.body.attribute) });
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
    const { html } = await snapshot(req.query.url);
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
  if (!PASSWORD) console.log('提示：没有设置 PASSWORD，任何能访问这个地址的人都能使用。放到服务器上请务必设置。');
  checker.start();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await closeBrowser();
    process.exit(0);
  });
}
