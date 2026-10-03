const crypto = require('crypto');
const store = require('./store');
const { describe } = require('./rules');

const PUBLIC_URL = process.env.PUBLIC_URL || '';

function truncate(s, n = 300) {
  s = String(s ?? '（空）');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text;
}

function feishuCard(event) {
  const { monitor, oldValue, newValue, kind, error } = event;
  const isError = kind === 'error';
  const lines = isError
    ? [`**错误：**${error}`, `**规则：**${describe(monitor)}`]
    : [`**规则：**${describe(monitor)}`, `**之前：**${truncate(oldValue)}`, `**现在：**${truncate(newValue)}`];
  if (monitor.note) lines.push(`**备注：**${monitor.note}`);
  lines.push(`**时间：**${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

  const actions = [{ tag: 'button', text: { tag: 'plain_text', content: '打开网页' }, url: monitor.url, type: 'primary' }];
  if (PUBLIC_URL) actions.push({ tag: 'button', text: { tag: 'plain_text', content: '打开监测面板' }, url: PUBLIC_URL, type: 'default' });

  return {
    msg_type: 'interactive',
    card: {
      header: {
        title: { tag: 'plain_text', content: `${isError ? '⚠️ 监测出错' : '🔔 检测到更新'}：${monitor.name || monitor.url}` },
        template: isError ? 'red' : 'orange',
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
        { tag: 'action', actions },
      ],
    },
  };
}

async function sendFeishu(webhook, secret, body) {
  if (secret) {
    // 飞书机器人“签名校验”：用 时间戳+\n+密钥 作为 key 对空字符串做 HmacSHA256
    const timestamp = Math.floor(Date.now() / 1000).toString();
    body.timestamp = timestamp;
    body.sign = crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
  }
  const text = await postJson(webhook, body);
  const data = JSON.parse(text || '{}');
  if (data.code && data.code !== 0) throw new Error(`飞书返回错误 ${data.code}: ${data.msg}`);
}

function webhookPayload(event) {
  const { monitor, oldValue, newValue, kind, error } = event;
  return {
    event: kind, // "updated" | "error" | "test"
    monitor: { id: monitor.id, name: monitor.name, url: monitor.url, selector: monitor.selector, rule: monitor.rule, note: monitor.note },
    oldValue: oldValue ?? null,
    newValue: newValue ?? null,
    error: error ?? null,
    time: new Date().toISOString(),
  };
}

// 发送通知，返回每个渠道的结果，单个渠道失败不影响其它渠道
async function notify(event) {
  const s = store.getSettings();
  const { monitor } = event;
  const results = [];
  if (s.feishuWebhook && monitor.notifyFeishu !== false) {
    try {
      await sendFeishu(s.feishuWebhook, s.feishuSecret, feishuCard(event));
      results.push({ channel: '飞书', ok: true });
    } catch (e) {
      results.push({ channel: '飞书', ok: false, error: e.message });
    }
  }
  if (s.customWebhook && monitor.notifyWebhook !== false) {
    try {
      await postJson(s.customWebhook, webhookPayload(event));
      results.push({ channel: 'Webhook', ok: true });
    } catch (e) {
      results.push({ channel: 'Webhook', ok: false, error: e.message });
    }
  }
  for (const r of results) if (!r.ok) console.error(`[通知失败] ${r.channel}: ${r.error}`);
  return results;
}

module.exports = { notify };
