// 定时检查：每隔一会儿看看哪些监测到时间了，排队去检查
const store = require('./store');
const { readElement } = require('./browser');
const { evaluate } = require('./rules');
const { notify } = require('./notify');

const TICK_MS = 20_000;
const CONCURRENCY = 2; // 同时最多开几个网页，服务器内存小就调低

const running = new Set();
const queue = [];

async function checkMonitor(id, { silent = false } = {}) {
  const m = store.getMonitor(id);
  if (!m) throw new Error('监测不存在');
  const previous = m.lastValue;
  const wasError = m.status === 'error';
  try {
    const value = await readElement(m.url, m.selector, m.attribute);
    const { triggered } = evaluate(m, value, previous);
    const updated = store.recordCheck(id, { value, triggered });
    if (triggered && !silent) await notify({ kind: 'updated', monitor: updated, oldValue: previous, newValue: value });
    return { ok: true, value, triggered, monitor: updated };
  } catch (e) {
    const msg = e.message.split('\n')[0];
    const updated = store.recordCheck(id, { error: msg });
    // 只在刚开始出错时提醒一次，不然每次检查都会刷屏
    if (!wasError && !silent && updated) await notify({ kind: 'error', monitor: updated, error: msg });
    return { ok: false, error: msg, monitor: updated };
  }
}

function isDue(m) {
  if (!m.enabled) return false;
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
