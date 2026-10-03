// 通知模板：找出新旧内容到底哪里变了，再把 {{变量}} 替换成实际内容

const VARIABLES = {
  名称: '监测的名称',
  变化: '只列出变了的部分，如 48 → 49',
  对比: '新内容全文，变化处高亮',
  新内容: '现在的完整内容',
  旧内容: '之前的完整内容',
  网址: '监测的网页地址',
  规则: '判断规则，如“内容发生变化”',
  备注: '监测的备注',
  时间: '发现变化的时间',
  面板地址: '.env 里 PUBLIC_URL 填的地址',
};

const DEFAULT_FEISHU_TITLE = '🔔 {{名称}} 有更新';
const DEFAULT_FEISHU_BODY = [
  '**变化：**{{变化}}',
  '**现在：**{{对比}}',
  '**之前：**{{旧内容}}',
  '**规则：**{{规则}}',
  '**备注：**{{备注}}',
  '**时间：**{{时间}}',
].join('\n');

// ---------- 对比 ----------
// 按“词”切分：连续的字母数字（含小数点）算一个词，其它字符（包括每个汉字）各算一个，
// 这样 48 → 49 会整体显示，而不是只显示 8 → 9
function tokenize(s) {
  return String(s ?? '').match(/[A-Za-z0-9.]+|\s+|[\s\S]/gu) || [];
}

// 最长公共子序列，得到 same / del / add 片段
function diffTokens(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 1_000_000) return [{ type: 'del', text: a.join('') }, { type: 'add', text: b.join('') }];
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  const push = (type, text) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) push('same', a[i++]), j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', a[i++]);
    else push('add', b[j++]);
  }
  while (i < n) push('del', a[i++]);
  while (j < m) push('add', b[j++]);
  return ops;
}

// 把相邻的删除/新增合成一处“变化”，得到 [{ same: '…' } | { old: '…', new: '…' }]
// 两处变化之间只隔一个空格时也合成一处，比如 “19.1” → “20 Beta”
function group(ops) {
  const out = [];
  let cur = null;
  let gap = ''; // 变化后面暂存的空格，下一个还是变化就并进去
  for (const op of ops) {
    if (op.type !== 'same') {
      if (cur && gap) (cur.old += gap), (cur.new += gap);
      else if (!cur) out.push((cur = { old: '', new: '' }));
      gap = '';
      cur[op.type === 'del' ? 'old' : 'new'] += op.text;
    } else if (cur && !gap && /^\s$/.test(op.text)) {
      gap = op.text;
    } else {
      out.push({ same: gap + op.text });
      cur = null;
      gap = '';
    }
  }
  if (gap) out.push({ same: gap });
  return out;
}

function diff(oldText, newText) {
  const segs = group(diffTokens(tokenize(oldText), tokenize(newText)));
  const changes = segs.filter((s) => s.same === undefined).map((c) => ({ old: c.old.trim(), new: c.new.trim() }));
  return { segs, changes };
}

// ---------- 输出格式 ----------
// 飞书 lark_md：转义特殊字符，避免内容里的 * ~ < 被当成格式
function escFeishu(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*/g, '&#42;')
    .replace(/~/g, '&#126;')
    .replace(/_/g, '&#95;')
    .replace(/`/g, '&#96;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;');
}

// old/new：“变化”里的旧值和新值；change：“对比”全文里的一处变化
const FORMATS = {
  feishu: {
    esc: escFeishu,
    old: (s) => `<font color='grey'>${escFeishu(s)}</font>`,
    new: (s) => `<font color='red'>**${escFeishu(s)}**</font>`,
    change: (o, n) =>
      (o ? `<font color='grey'>~~${escFeishu(o)}~~</font>` : '') + (o && n ? '→' : '') + (n ? `<font color='red'>**${escFeishu(n)}**</font>` : ''),
  },
  plain: {
    esc: (s) => String(s ?? ''),
    old: (s) => s,
    new: (s) => s,
    change: (o, n) => (o && n ? `【${o}→${n}】` : o ? `【删除:${o}】` : `【新增:${n}】`),
  },
};

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function summary(changes, fmt) {
  if (!changes.length) return '';
  const shown = changes.slice(0, 5).map((c) => {
    const o = c.old ? fmt.old(truncate(c.old, 80)) : fmt.esc('（无）');
    const n = c.new ? fmt.new(truncate(c.new, 80)) : fmt.esc('（删除）');
    return o + ' → ' + n;
  });
  const more = changes.length > 5 ? fmt.esc(`；等共 ${changes.length} 处`) : '';
  return shown.join(fmt.esc('；')) + more;
}

// 新内容全文，变化处标出来；没变的长段落只保留前后一点，避免通知太长
function inline(segs, fmt) {
  const CONTEXT = 40;
  return segs
    .map((seg, idx) => {
      if (seg.same === undefined) return fmt.change(truncate(seg.old.trim(), 80), truncate(seg.new.trim(), 200));
      let t = seg.same;
      if (t.length > CONTEXT * 2 + 10) {
        if (idx === 0) t = '…' + t.slice(-CONTEXT);
        else if (idx === segs.length - 1) t = t.slice(0, CONTEXT) + '…';
        else t = t.slice(0, CONTEXT) + ' … ' + t.slice(-CONTEXT);
      }
      return fmt.esc(t);
    })
    .join('');
}

// 生成所有变量的值。kind = 'feishu' | 'plain'
function variables(event, kind) {
  const fmt = FORMATS[kind];
  const { monitor, oldValue, newValue } = event;
  const d = oldValue == null ? null : diff(oldValue, newValue);
  return {
    名称: fmt.esc(monitor.name || monitor.url),
    变化: d ? summary(d.changes, fmt) || fmt.esc('（内容相同）') : fmt.esc(`首次检查，当前值 ${truncate(newValue, 100)}`),
    对比: d ? inline(d.segs, fmt) : fmt.esc(truncate(newValue, 500)),
    新内容: fmt.esc(truncate(newValue, 500)),
    旧内容: fmt.esc(oldValue == null ? '' : truncate(oldValue, 500)),
    网址: monitor.url,
    规则: fmt.esc(event.ruleText || ''),
    备注: fmt.esc(monitor.note || ''),
    时间: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
    面板地址: process.env.PUBLIC_URL || '',
  };
}

const VAR_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

// 普通文本模板：某一行用到的变量全是空的，就把这一行去掉（比如没写备注时不显示“备注：”）
function renderText(template, vars) {
  return template
    .split('\n')
    .filter((line) => {
      const used = [...line.matchAll(VAR_RE)].map((m) => m[1]);
      return !used.length || used.some((k) => vars[k]);
    })
    .map((line) => line.replace(VAR_RE, (all, k) => (k in vars ? vars[k] : all)))
    .join('\n')
    .trim();
}

// JSON 模板（通用 Webhook）：变量值按 JSON 字符串规则转义后再替换，结果必须是合法 JSON
function renderJson(template, vars) {
  const out = template.replace(VAR_RE, (all, k) => (k in vars ? JSON.stringify(String(vars[k])).slice(1, -1) : all));
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error('Webhook 模板不是合法的 JSON：' + e.message);
  }
}

module.exports = {
  VARIABLES,
  DEFAULT_FEISHU_TITLE,
  DEFAULT_FEISHU_BODY,
  diff,
  variables,
  renderText,
  renderJson,
};
