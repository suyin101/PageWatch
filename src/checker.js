// 定时检查：每隔一会儿看看哪些监测到时间了，排队去检查
const store = require('./store');
const { readElement } = require('./browser');
const { evaluate } = require('./rules');
const { notify } = require('./notify');

const TICK_MS = 20_000;
const CONCURRENCY = 2; // 同时最多开几个网页，服务器内存小就调低
const FAIL_THRESHOLD = 3; // 连续失败几次才算真的出错，避免偶尔的网络抖动也来打扰
const RETRY_MS = 2 * 60_000; // 失败后多久重试
const WAKE_GRACE_MS = 30_000; // 电脑刚醒来时网络还没连上，先等一会儿再检查

const running = new Set();
const queue = [];
const failures = new Map(); // id -> 连续失败次数
const retryAt = new Map(); // id -> 下次重试的时间

// ---------- 识别电脑睡眠 ----------
// Mac 合上盖子会睡眠，期间还会时不时短暂醒来几秒。程序在这几秒里开始的检查，
// 往往网页还没打开就又睡着了，醒来就成了“超时”。用心跳来发现睡眠：
// 心跳本该每 5 秒一次，如果两次之间隔了很久，说明中间睡着了。
const HEARTBEAT_MS = 5_000;
let lastBeat = Date.now();
let lastWake = 0;
setInterval(() => {
  const now = Date.now();
  if (now - lastBeat > HEARTBEAT_MS * 4) {
    lastWake = now;
    console.log(`[睡眠] 电脑刚从睡眠中醒来（睡了约 ${Math.round((now - lastBeat) / 60_000)} 分钟）`);
  }
  lastBeat = now;
}, HEARTBEAT_MS).unref();

const justWoke = () => Date.now() - lastWake < WAKE_GRACE_MS;

async function checkMonitor(id, { silent = false } = {}) {
  const m = store.getMonitor(id);
  if (!m) throw new Error('监测不存在');
  const previous = m.lastValue;
  const startedAt = Date.now();
  try {
    const value = await readElement(m.url, m.selector, m.attribute);
    const { triggered } = evaluate(m, value, previous);
    failures.delete(id);
    retryAt.delete(id);
    const updated = store.recordCheck(id, { value, triggered });
    if (triggered && !silent) await notify({ kind: 'updated', monitor: updated, oldValue: previous, newValue: value });
    return { ok: true, value, triggered, monitor: updated };
  } catch (e) {
    const msg = e.message.split('\n')[0];

    // 检查途中电脑睡着过，或者刚醒网络还没好：这次不算，过一会儿重新检查
    if (lastWake > startedAt || justWoke()) {
      console.log(`[睡眠] “${m.name}” 的检查被睡眠打断，稍后重试`);
      retryAt.set(id, Date.now() + WAKE_GRACE_MS * 2);
      return { ok: false, error: '电脑刚从睡眠中醒来，网络还没准备好，稍后会自动重试', monitor: m };
    }

    const count = (failures.get(id) || 0) + 1;
    failures.set(id, count);
    if (count < FAIL_THRESHOLD) {
      console.log(`[重试] “${m.name}” 第 ${count} 次失败（${msg}），${RETRY_MS / 60_000} 分钟后重试`);
      retryAt.set(id, Date.now() + RETRY_MS);
      return { ok: false, error: `${msg}（第 ${count} 次失败，${RETRY_MS / 60_000} 分钟后自动重试）`, monitor: m };
    }

    retryAt.delete(id);
    const wasError = !!m.lastError;
    const updated = store.recordCheck(id, { error: msg });
    // 只在刚开始出错时提醒一次，不然每次检查都会刷屏
    if (!wasError && !silent && updated) {
      await notify({ kind: 'error', monitor: updated, error: `${msg}（已连续失败 ${count} 次）` });
    }
    return { ok: false, error: msg, monitor: updated };
  }
}

function isDue(m) {
  if (!m.enabled) return false;
  if (retryAt.has(m.id)) return Date.now() >= retryAt.get(m.id);
  if (!m.lastCheckedAt) return true;
  return Date.now() - new Date(m.lastCheckedAt).getTime() >= m.interval * 60_000;
}

function enqueue(id) {
  if (running.has(id) || queue.includes(id)) return;
  queue.push(id);
  pump();
}

function pump() {
  while (running.size < CONCURRENCY && queue.length) {
    const id = queue.shift();
    running.add(id);
    checkMonitor(id)
      .catch((e) => console.error('[检查失败]', e))
      .finally(() => {
        running.delete(id);
        pump();
      });
  }
}

function tick() {
  if (justWoke()) return;
  for (const m of store.listMonitors()) if (isDue(m)) enqueue(m.id);
}

function start() {
  tick();
  setInterval(tick, TICK_MS);
}

function isChecking(id) {
  return running.has(id) || queue.includes(id);
}

module.exports = { start, enqueue, checkMonitor, isChecking };
