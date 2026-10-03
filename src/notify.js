const crypto = require('crypto');
const store = require('./store');
const { describe } = require('./rules');
const tpl = require('./template');

const PUBLIC_URL = process.env.PUBLIC_URL || '';

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

function buttons(monitor) {
  const actions = [{ tag: 'button', text: { tag: 'plain_text', content: '打开网页' }, url: monitor.url, type: 'primary' }];
  if (PUBLIC_URL) actions.push({ tag: 'button', text: { tag: 'plain_text', content: '打开监测面板' }, url: PUBLIC_URL, type: 'default' });
  return { tag: 'action', actions };
}

function card(title, color, body, monitor) {
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: title }, template: color },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: body } }, { tag: 'hr' }, buttons(monitor)],
    },
  };
}

// 按模板生成飞书卡片；settings 可以传入还没保存的模板，用来预览
function feishuMessage(event, settings) {
  const { monitor } = event;
  if (event.kind === 'error') {
    const body = [`**错误原因：**${event.error}`, `**规则：**${describe(monitor)}`, '网页打不开或元素找不到，可能需要重新选择元素。恢复正常之前不会重复提醒。']
      .join('\n');
    return card(`⚠️ 监测出错：${monitor.name || monitor.url}`, 'red', body, monitor);
  }
  const title = tpl.renderText(settings.feishuTitleTemplate || tpl.DEFAULT_FEISHU_TITLE, tpl.variables(event, 'plain'));
  const body = tpl.renderText(settings.feishuTemplate || tpl.DEFAULT_FEISHU_BODY, tpl.variables(event, 'feishu'));
  return card(title, 'orange', body, monitor);
}

function webhookMessage(event, settings) {
  const { monitor } = event;
  if (settings.webhookTemplate && event.kind !== 'error') {
    return tpl.renderJson(settings.webhookTemplate, tpl.variables(event, 'plain'));
  }
  // 默认格式：所有信息都给全，方便你自己的程序处理
  const vars = event.oldValue != null && event.newValue != null ? tpl.variables(event, 'plain') : null;
  return {
    event: event.kind, // "updated" | "error" | "test"
    monitor: { id: monitor.id, name: monitor.name, url: monitor.url, selector: monitor.selector, rule: monitor.rule, note: monitor.note },
    oldValue: event.oldValue ?? null,
    newValue: event.newValue ?? null,
    changes: vars ? tpl.diff(event.oldValue, event.newValue).changes : [],
    summary: vars ? vars.变化 : null,
    error: event.error ?? null,
    time: new Date().toISOString(),
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

// 补上规则说明，模板里的 {{规则}} 要用
function withRule(event) {
  return { ...event, ruleText: describe(event.monitor) };
}

// 发送通知，返回每个渠道的结果，单个渠道失败不影响其它渠道
async function notify(event, settings = store.getSettings()) {
  event = withRule(event);
  const { monitor } = event;
  const results = [];
  if (settings.feishuWebhook && monitor.notifyFeishu !== false) {
    try {
      await sendFeishu(settings.feishuWebhook, settings.feishuSecret, feishuMessage(event, settings));
      results.push({ channel: '飞书', ok: true });
    } catch (e) {
      results.push({ channel: '飞书', ok: false, error: e.message });
    }
  }
  if (settings.customWebhook && monitor.notifyWebhook !== false) {
    try {
      await postJson(settings.customWebhook, webhookMessage(event, settings));
      results.push({ channel: 'Webhook', ok: true });
    } catch (e) {
      results.push({ channel: 'Webhook', ok: false, error: e.message });
    }
  }
  for (const r of results) if (!r.ok) console.error(`[通知失败] ${r.channel}: ${r.error}`);
  return results;
}

// 测试和预览用的示例数据
const SAMPLE_EVENT = {
  kind: 'test',
  monitor: {
    id: 'sample',
    name: '百度网盘 SVIP 优惠（示例）',
    url: 'https://pan.baidu.com',
    selector: '.title',
    rule: 'changed',
    note: '这是一条测试通知',
  },
  oldValue: '置顶 百度网盘SVIP优惠购！季卡优惠48/季度，青春卡178/年',
  newValue: '置顶 百度网盘SVIP优惠购！季卡优惠49/季度，青春卡178/年',
};

// 预览：返回飞书标题、正文和 Webhook 的 JSON，不真的发送
function preview(settings) {
  const event = withRule(SAMPLE_EVENT);
  const msg = feishuMessage(event, settings);
  let webhook;
  try {
    webhook = { ok: true, body: webhookMessage(event, settings) };
  } catch (e) {
    webhook = { ok: false, error: e.message };
  }
  return { feishu: { title: msg.card.header.title.content, body: msg.card.elements[0].text.content }, webhook };
}

module.exports = { notify, preview, SAMPLE_EVENT };
