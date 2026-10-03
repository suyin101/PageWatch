// 判断规则：拿到新值和上次的值，决定要不要通知
const RULES = {
  changed: '内容发生变化',
  gt: '数字大于设定值',
  lt: '数字小于设定值',
  increased: '数字/版本号比上次大',
};

// 取文字里的第一个数字，比如 "¥1,299.00" → 1299
function extractNumber(text) {
  const m = String(text ?? '').match(/-?\d[\d,]*(\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, '')) : NaN;
}

// 取版本号的各段数字，比如 "Version 2.10.3 (Build 45)" → [2, 10, 3]
function extractVersion(text) {
  const m = String(text ?? '').match(/\d+(\.\d+)*/);
  return m ? m[0].split('.').map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// 返回 { triggered, reason }
function evaluate(monitor, value, previous) {
  const isFirst = previous == null;
  switch (monitor.rule) {
    case 'gt':
    case 'lt': {
      const n = extractNumber(value);
      if (Number.isNaN(n)) throw new Error(`读到的内容里没有数字：“${value}”`);
      const t = Number(monitor.threshold);
      const ok = monitor.rule === 'gt' ? n > t : n < t;
      // 条件成立并且值有变化才通知，避免每次检查都重复提醒
      return { triggered: ok && (isFirst || value !== previous), reason: `${n} ${monitor.rule === 'gt' ? '>' : '<'} ${t}` };
    }
    case 'increased': {
      if (isFirst) return { triggered: false };
      const now = extractVersion(value);
      const before = extractVersion(previous);
      if (!now) throw new Error(`读到的内容里没有数字：“${value}”`);
      if (!before) return { triggered: false };
      return { triggered: compareVersions(now, before) > 0, reason: `${now.join('.')} > ${before.join('.')}` };
    }
    case 'changed':
    default:
      // 第一次检查只是记下当前值，作为以后比较的基准
      return { triggered: !isFirst && value !== previous, reason: '内容变化' };
  }
}

function describe(monitor) {
  const base = RULES[monitor.rule] || RULES.changed;
  if (monitor.rule === 'gt' || monitor.rule === 'lt') return base.replace('设定值', ` ${monitor.threshold}`);
  return base;
}

module.exports = { RULES, evaluate, describe };
