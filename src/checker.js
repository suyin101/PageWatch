// 定时检查：每隔一会儿看看哪些监测到时间了，排队去检查
const store = require('./store');
const { readElement } = require('./browser');
const { readApi } = require('./api');
const { readUptime } = require('./uptime');
const { evaluate } = require('./rules');
const { extract } = require('./extract');
const { notify } = require('./notify');

const TICK_MS = 20_000;
// 同时最多检查几个网页。每个网页要占 100~300MB 内存：内存不到 3GB 的服务器一次只查一个，免得把服务器拖慢。
// 可以在 .env 里用 CHECK_CONCURRENCY 指定
const CONCURRENCY = Number(process.env.CHECK_CONCURRENCY) || (require('os').totalmem() < 3 * 1024 ** 3 ? 1 : 2);
const FAIL_THRESHOLD = 3; // 连续失败几次才算真的出错，避免偶尔的网络抖动也来打扰
const RETRY_MS = 2 * 60_000; // 失败后多久重试
// 「网站能否打开」要尽快知道：每次检查里已经自己重试过一次，再隔 1 分钟确认一次就通知
const UPTIME_FAIL_THRESHOLD = 2;
const UPTIME_RETRY_MS = 60_000;
const WAKE_GRACE_MS = 30_000; // 电脑刚醒来时网络还没连上，先等一会儿再检查

const running = new Set();
const queue = [];
const failures = new Map(); // id -> 连续失败次数
const retryAt = new Map(); // id -> 下次重试的时间
const failedSince = new Map(); // id -> 第一次失败的时间（网站从什么时候开始打不开）

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
    const uptime = m.source === 'uptime';
    const { raw, downloadUrl } =
      m.source === 'api'
        ? await readApi(m.url, m.selector)
        : uptime
          ? await readUptime(m.url, m.selector)
          : await readElement(m.url, m.selector, m.attribute, { downloadSelector: m.downloadSelector });
    // 只取出关键部分（比如版本号）来比较；网站能否打开只看通不通，不比较内容
    const value = uptime ? '正常' : extract(raw, m.extract, m.extractPattern);
    const { triggered } = uptime ? { triggered: false } : evaluate(m, value, previous);
    failures.delete(id);
    retryAt.delete(id);
    failedSince.delete(id);
    const wasDown = uptime && !!m.lastError;
    const downSince = m.errorSince;
    const updated = store.recordCheck(id, { value, raw, downloadUrl, triggered });
    if (triggered && !silent) {
      await notify({ kind: 'updated', monitor: updated, oldValue: previous, newValue: value, raw, downloadUrl });
    }
    // 网站之前报过打不开，现在好了，告诉一声
    if (wasDown && !silent) await notify({ kind: 'recovered', monitor: updated, since: downSince, raw });
    return { ok: true, value, triggered, monitor: updated };
  } catch (e) {
    const msg = e.message.split('\n')[0];

    // 检查途中电脑睡着过，或者刚醒网络还没好：这次不算，过一会儿重新检查
    if (lastWake > startedAt || justWoke()) {
      console.log(`[睡眠] “${m.name}” 的检查被睡眠打断，稍后重试`);
      retryAt.set(id, Date.now() + WAKE_GRACE_MS * 2);
      return { ok: false, error: '电脑刚从睡眠中醒来，网络还没准备好，稍后会自动重试', monitor: m };
    }

    const uptime = m.source === 'uptime';
    const threshold = uptime ? UPTIME_FAIL_THRESHOLD : FAIL_THRESHOLD;
    const retryMs = uptime ? UPTIME_RETRY_MS : RETRY_MS;
    const count = (failures.get(id) || 0) + 1;
    failures.set(id, count);
    if (!failedSince.has(id)) failedSince.set(id, new Date(startedAt).toISOString());
    if (count < threshold) {
      console.log(`[重试] “${m.name}” 第 ${count} 次失败（${msg}），${retryMs / 60_000} 分钟后重试`);
      retryAt.set(id, Date.now() + retryMs);
      return { ok: false, error: `${msg}（第 ${count} 次失败，${retryMs / 60_000} 分钟后自动重试）`, monitor: m };
    }

    // 网站打不开期间照常按 1 分钟一次检查，恢复了能马上知道
    if (uptime) retryAt.set(id, Date.now() + retryMs);
    else retryAt.delete(id);
    const wasError = !!m.lastError;
    const updated = store.recordCheck(id, { error: msg, since: failedSince.get(id) });
    // 只在刚开始出错时提醒一次，不然每次检查都会刷屏
    if (!wasError && !silent && updated) {
      await notify({ kind: 'error', monitor: updated, error: `${msg}（已连续失败 ${count} 次）`, since: failedSince.get(id) });
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

// 哪些正在检查/排队，网页据此判断列表有没有变化
const signature = () => [...running, '|', ...queue].join(',');

module.exports = { start, enqueue, checkMonitor, isChecking, signature };
