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

const EDITABLE = ['name', 'url', 'selector', 'attribute', 'rule', 'threshold', 'interval', 'enabled', 'notifyFeishu', 'notifyWebhook', 'note'];

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
    rule: 'changed',
    threshold: '',
    note: '',
    ...pick(data, EDITABLE),
    status: 'pending', // pending | ok | updated | error
    lastValue: null,
    previousValue: null,
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
  const targetChanged = (patch.url && patch.url !== m.url) || (patch.selector && patch.selector !== m.selector) ||
    (patch.attribute !== undefined && patch.attribute !== m.attribute);
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
};
