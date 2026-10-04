// 简单的 JSON 文件存储：监测数量一般只有几十个，不需要数据库，
// 部署到宝塔时也不用编译任何原生模块。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const HISTORY_LIMIT = 50;

const DEFAULT_DB = {
  settings: {
    feishuWebhook: '',
    feishuSecret: '',
    customWebhook: '',
    defaultInterval: 30,
    // 通知模板，留空表示使用默认模板
    feishuTitleTemplate: '',
    feishuTemplate: '',
    webhookTemplate: '',
  },
  monitors: [],
  auth: null, // { username, salt, hash }
  sessions: [], // [{ id: 令牌的 sha256, expires }]
};

let db = load();

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) return structuredClone(DEFAULT_DB);
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return {
    settings: { ...DEFAULT_DB.settings, ...raw.settings },
    monitors: raw.monitors || [],
    auth: raw.auth || null,
    sessions: (raw.sessions || []).filter((x) => x.expires > Date.now()),
  };
}

function save() {
  // 先写临时文件再改名，避免写到一半断电把数据写坏
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- 登录账号 ----------
const SESSION_DAYS = 30;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function hasAccount() {
  return !!db.auth;
}

function getUsername() {
  return db.auth?.username || '';
}

function setAccount(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.auth = { username, salt, hash: hashPassword(password, salt) };
  db.sessions = []; // 改密码后所有设备都要重新登录
  save();
}

function checkPassword(username, password) {
  if (!db.auth || username !== db.auth.username) return false;
  const a = Buffer.from(hashPassword(password, db.auth.salt), 'hex');
  return crypto.timingSafeEqual(a, Buffer.from(db.auth.hash, 'hex'));
}

// 返回给浏览器的是随机令牌，文件里只存它的哈希
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions = db.sessions.filter((x) => x.expires > Date.now());
  db.sessions.push({ id: sha256(token), expires: Date.now() + SESSION_DAYS * 86400_000 });
  save();
  return { token, maxAge: SESSION_DAYS * 86400 };
}

function validSession(token) {
  if (!token) return false;
  const id = sha256(token);
  return db.sessions.some((x) => x.id === id && x.expires > Date.now());
}

function deleteSession(token) {
  const id = sha256(token || '');
  db.sessions = db.sessions.filter((x) => x.id !== id);
  save();
}

function getSettings() {
  return db.settings;
}

function updateSettings(patch) {
  db.settings = { ...db.settings, ...pick(patch, Object.keys(DEFAULT_DB.settings)) };
  db.settings.defaultInterval = Math.max(1, Number(db.settings.defaultInterval) || 30);
  save();
  return db.settings;
}

const EDITABLE = ['name', 'url', 'selector', 'attribute', 'extract', 'extractPattern', 'downloadSelector', 'rule', 'threshold', 'interval', 'enabled', 'notifyFeishu', 'notifyWebhook', 'note'];

function normalize(m) {
  m.interval = Math.max(1, Number(m.interval) || db.settings.defaultInterval);
  if (m.threshold !== '' && m.threshold != null) m.threshold = Number(m.threshold);
  m.enabled = m.enabled !== false;
  m.notifyFeishu = m.notifyFeishu !== false;
  m.notifyWebhook = m.notifyWebhook !== false;
  return m;
}

function listMonitors() {
  return db.monitors;
}

function getMonitor(id) {
  return db.monitors.find((m) => m.id === id);
}

function createMonitor(data) {
  const m = normalize({
    id: crypto.randomUUID(),
    name: '',
    url: '',
    selector: '',
    attribute: '',
    extract: '', // '' 整段 | version 版本号 | number 数字 | regex 自定义
    extractPattern: '',
    downloadSelector: '',
    rule: 'changed',
    threshold: '',
    note: '',
    ...pick(data, EDITABLE),
    status: 'pending', // pending | ok | updated | error
    lastValue: null, // 提取后用来比较的值
    lastRaw: null, // 元素的原始内容
    previousValue: null,
    lastDownloadUrl: null,
    lastCheckedAt: null,
    lastChangedAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
    history: [],
  });
  db.monitors.push(m);
  save();
  return m;
}

function updateMonitor(id, patch) {
  const m = getMonitor(id);
  if (!m) return null;
  const changed = (k) => patch[k] !== undefined && (patch[k] || '') !== (m[k] || '');
  // 读什么、取哪部分变了，旧值就没有比较意义了
  const targetChanged = ['url', 'selector', 'attribute', 'extract', 'extractPattern'].some(changed);
  Object.assign(m, pick(patch, EDITABLE));
  normalize(m);
  // 网址或元素换了，旧的值已经没有比较意义，重新建立基准
  if (targetChanged) {
    m.lastValue = null;
    m.previousValue = null;
    m.status = 'pending';
    m.lastError = null;
  }
  save();
  return m;
}

// 记录一次检查结果（由 checker 调用）
function recordCheck(id, result) {
  const m = getMonitor(id);
  if (!m) return null;
  const now = new Date().toISOString();
  m.lastCheckedAt = now;
  if (result.error) {
    m.lastError = result.error;
    if (m.status !== 'updated') m.status = 'error';
  } else {
    m.lastError = null;
    if (result.triggered) {
      m.status = 'updated';
      m.lastChangedAt = now;
    } else if (m.status !== 'updated') {
      // “已更新”状态会一直保留，直到你手动点“已处理”
      m.status = 'ok';
    }
    if (result.value !== m.lastValue) {
      if (m.lastValue != null) m.previousValue = m.lastValue;
      m.history.unshift({ at: now, value: result.value, triggered: !!result.triggered });
      m.history = m.history.slice(0, HISTORY_LIMIT);
    }
    m.lastValue = result.value;
    m.lastRaw = result.raw ?? result.value;
    if (result.downloadUrl !== undefined) m.lastDownloadUrl = result.downloadUrl;
  }
  save();
  return m;
}

function acknowledge(id) {
  const m = getMonitor(id);
  if (!m) return null;
  m.status = m.lastError ? 'error' : 'ok';
  save();
  return m;
}

function deleteMonitor(id) {
  const before = db.monitors.length;
  db.monitors = db.monitors.filter((m) => m.id !== id);
  save();
  return db.monitors.length < before;
}

// ---------- 备份 ----------
// 备份只包含设置和监测（含历史），不含登录账号，换台服务器也能直接导入
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_AUTO = 7;
const KEEP_SAFETY = 5;
const appVersion = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;

function exportData() {
  return {
    app: 'PageWatch',
    type: 'backup',
    version: appVersion(),
    exportedAt: new Date().toISOString(),
    settings: db.settings,
    monitors: db.monitors,
  };
}

function today() {
  // 按北京时间算“今天”
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

function writeBackup(name) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const file = path.join(BACKUP_DIR, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(exportData(), null, 2));
  fs.renameSync(file + '.tmp', file);
  return name;
}

function prune(prefix, keep) {
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort().reverse();
  for (const f of files.slice(keep)) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
}

// 每天自动备份一次，保留最近 7 天
function autoBackup() {
  const name = `auto-${today()}.json`;
  if (fs.existsSync(path.join(BACKUP_DIR, name))) return null;
  writeBackup(name);
  prune('auto-', KEEP_AUTO);
  return name;
}

// 导入、恢复之前先存一份，万一弄错还能找回来
function safetyBackup() {
  const name = `before-restore-${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace(/[-:T]/g, '')}.json`;
  writeBackup(name);
  prune('before-restore-', KEEP_SAFETY);
  return name;
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^[\w.-]+\.json$/.test(f))
    .map((f) => {
      const file = path.join(BACKUP_DIR, f);
      let monitors = null;
      try {
        monitors = JSON.parse(fs.readFileSync(file, 'utf8')).monitors.length;
      } catch {}
      return { name: f, auto: f.startsWith('auto-'), size: fs.statSync(file).size, at: fs.statSync(file).mtime.toISOString(), monitors };
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

function readBackup(name) {
  if (!/^[\w.-]+\.json$/.test(name || '')) throw new Error('备份文件名不对');
  const file = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(file)) throw new Error('找不到这个备份');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function checkBackup(data) {
  if (!data || data.app !== 'PageWatch' || !Array.isArray(data.monitors) || typeof data.settings !== 'object') {
    throw new Error('这不是 PageWatch 的备份文件');
  }
}

// mode = 'replace'：用备份替换全部监测和设置；'merge'：保留现有的，只添加备份里没有的监测
function importData(data, mode) {
  checkBackup(data);
  const safety = safetyBackup();
  const clean = (m) => normalize({ history: [], ...m, id: m.id || crypto.randomUUID() });
  let added = 0;
  let skipped = 0;
  if (mode === 'replace') {
    db.settings = { ...DEFAULT_DB.settings, ...data.settings };
    db.monitors = data.monitors.map(clean);
    added = db.monitors.length;
  } else {
    const key = (m) => `${m.url}\n${m.selector}`;
    const have = new Set(db.monitors.map(key));
    const ids = new Set(db.monitors.map((m) => m.id));
    for (const m of data.monitors) {
      if (have.has(key(m))) {
        skipped++;
        continue;
      }
      const copy = clean(m);
      if (ids.has(copy.id)) copy.id = crypto.randomUUID();
      db.monitors.push(copy);
      ids.add(copy.id);
      added++;
    }
    // 通知地址这类设置，只补上现在还空着的
    for (const [k, v] of Object.entries(data.settings)) if (k in DEFAULT_DB.settings && !db.settings[k] && v) db.settings[k] = v;
  }
  save();
  return { added, skipped, total: db.monitors.length, safety };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

module.exports = {
  hasAccount,
  getUsername,
  setAccount,
  checkPassword,
  createSession,
  validSession,
  deleteSession,
  getSettings,
  updateSettings,
  listMonitors,
  getMonitor,
  createMonitor,
  updateMonitor,
  recordCheck,
  acknowledge,
  deleteMonitor,
  exportData,
  autoBackup,
  listBackups,
  readBackup,
  importData,
  BACKUP_DIR,
};
