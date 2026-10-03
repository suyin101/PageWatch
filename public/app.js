// PageWatch 前端：总面板、监测列表、新建/编辑（点选元素）、详情、设置
const $ = (s, root = document) => root.querySelector(s);

const state = {
  monitors: [],
  rules: {},
  settings: {},
  filter: 'all',
  search: '',
  editingId: null,
  lastPick: null,
};

// ---------- 工具 ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    showLogin();
    throw new Error('请先登录');
  }
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function ago(iso) {
  if (!iso) return '从未';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function fullTime(iso) {
  return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function ruleText(m) {
  const t = state.rules[m.rule] || '';
  return m.rule === 'gt' || m.rule === 'lt' ? t.replace('设定值', ` ${m.threshold}`) : t;
}

function category(m) {
  if (m.status === 'updated') return 'updated';
  if (!m.enabled) return 'paused';
  if (m.status === 'error') return 'error';
  return 'ok';
}

function openModal(id) {
  $('#' + id).classList.remove('hidden');
}
function closeModal(id) {
  $('#' + id).classList.add('hidden');
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) closeModal(c.closest('.modal').id);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.modal:not(.hidden)')].pop();
  if (open) closeModal(open.id);
});

// ---------- 登录 ----------
function showLogin() {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/login', { method: 'POST', body: { password: e.target.password.value } });
    $('#login').classList.add('hidden');
    boot();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

// ---------- 总面板 ----------
const STAT_DEFS = [
  ['all', '全部监测', ''],
  ['updated', '有更新待处理', 'updated'],
  ['ok', '正常', 'ok'],
  ['error', '出错', 'error'],
  ['paused', '已暂停', ''],
];

function renderStats() {
  const counts = { all: state.monitors.length, updated: 0, ok: 0, error: 0, paused: 0 };
  for (const m of state.monitors) counts[category(m)]++;
  $('#stats').innerHTML = STAT_DEFS.map(
    ([key, label, dot]) => `
      <button class="stat ${key} ${state.filter === key ? 'active' : ''} ${counts[key] ? 'has' : ''}" data-filter="${key}">
        <div class="num">${counts[key]}</div>
        <div class="lbl">${dot ? `<span class="dot ${dot}"></span>` : ''}${label}</div>
      </button>`
  ).join('');
  document.title = counts.updated ? `(${counts.updated}) PageWatch 网页监测` : 'PageWatch 网页监测';
}

$('#stats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  state.filter = state.filter === b.dataset.filter ? 'all' : b.dataset.filter;
  render();
});

$('#search').addEventListener('input', (e) => {
  state.search = e.target.value.trim().toLowerCase();
  renderList();
});

const ORDER = { updated: 0, error: 1, ok: 2, paused: 3 };

function renderList() {
  const list = $('#list');
  if (!state.monitors.length) {
    list.innerHTML = `<div class="empty">还没有任何监测<br><button class="btn primary" onclick="openEditor()">＋ 新建第一个监测</button></div>`;
    return;
  }
  const items = state.monitors
    .filter((m) => state.filter === 'all' || category(m) === state.filter)
    .filter((m) => !state.search || [m.name, m.url, m.note, m.lastValue].join(' ').toLowerCase().includes(state.search))
    .sort((a, b) => ORDER[category(a)] - ORDER[category(b)] || (a.name || '').localeCompare(b.name || '', 'zh'));

  if (!items.length) {
    list.innerHTML = `<div class="empty">没有符合条件的监测</div>`;
    return;
  }

  list.innerHTML = items
    .map((m) => {
      const cat = category(m);
      const dot = m.checking ? 'pending' : !m.enabled && cat !== 'updated' ? '' : m.status;
      let value;
      if (m.lastValue == null && m.lastError) value = `<div class="err-text">⚠ ${esc(m.lastError)}</div>`;
      else if (m.lastValue == null) value = `<div class="muted">${m.checking ? '正在读取…' : '等待第一次检查'}</div>`;
      else {
        value = '';
        if (cat === 'updated' && m.previousValue != null) value += `<div class="value old" title="${esc(m.previousValue)}">${esc(m.previousValue)}</div>`;
        value += `<div class="value" title="${esc(m.lastValue)}">${esc(m.lastValue)}</div>`;
        if (m.lastError) value += `<div class="err-text">⚠ ${esc(m.lastError)}</div>`;
      }
      return `
      <div class="item ${cat} ${!m.enabled ? 'paused' : ''}" data-id="${m.id}">
        <div>
          <div class="title" data-act="detail"><span class="dot ${dot}"></span><span>${esc(m.name || '未命名')}</span>${cat === 'updated' ? '<em class="badge">有更新</em>' : ''}</div>
          <a class="url" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.url)}</a>
          ${m.note ? `<div class="note">📝 ${esc(m.note)}</div>` : ''}
        </div>
        <div>${value}</div>
        <div class="meta">
          <div>${esc(ruleText(m))}</div>
          <div>${m.enabled ? `每 ${m.interval} 分钟` : '已暂停'} · ${m.checking ? '检查中…' : `检查于 ${ago(m.lastCheckedAt)}`}</div>
          ${cat === 'updated' ? `<div>发现于 ${ago(m.lastChangedAt)}</div>` : ''}
        </div>
        <div class="actions">
          ${cat === 'updated' ? `<button class="btn sm warn" data-act="ack" title="已经处理过这次更新（比如已上传新版本）">✓ 已处理</button>` : ''}
          <button class="btn sm" data-act="check" ${m.checking ? 'disabled' : ''}>${m.checking ? '检查中…' : '立即检查'}</button>
          <button class="btn sm" data-act="edit">编辑</button>
          <button class="btn sm" data-act="toggle">${m.enabled ? '暂停' : '启用'}</button>
          <button class="btn sm danger" data-act="delete">删除</button>
        </div>
      </div>`;
    })
    .join('');
}

function render() {
  renderStats();
  renderList();
}

$('#list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.item').dataset.id;
  const m = state.monitors.find((x) => x.id === id);
  try {
    switch (btn.dataset.act) {
      case 'detail':
        return openDetail(id);
      case 'edit':
        return openEditor(m);
      case 'ack':
        await api(`/monitors/${id}/ack`, { method: 'POST' });
        toast('已标记为处理完成');
        break;
      case 'toggle':
        await api(`/monitors/${id}`, { method: 'PUT', body: { enabled: !m.enabled } });
        toast(m.enabled ? '已暂停' : '已启用');
        break;
      case 'delete':
        if (!confirm(`确定删除“${m.name || m.url}”吗？历史记录也会一起删除。`)) return;
        await api(`/monitors/${id}`, { method: 'DELETE' });
        toast('已删除');
        break;
      case 'check': {
        m.checking = true;
        renderList();
        const r = await api(`/monitors/${id}/check`, { method: 'POST' });
        if (!r.ok) toast('检查出错：' + r.error, true);
        else toast(r.triggered ? '🔔 发现更新，已发送通知' : '检查完成，没有变化');
        break;
      }
    }
  } catch (err) {
    toast(err.message, true);
  }
  refresh();
});

let refreshTimer;
async function refresh() {
  clearTimeout(refreshTimer);
  try {
    state.monitors = await api('/monitors');
    render();
    $('#refreshInfo').textContent = `自动刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch {}
  // 有正在检查的就刷新得勤一点
  refreshTimer = setTimeout(refresh, state.monitors.some((m) => m.checking) ? 3000 : 15000);
}

// ---------- 详情 ----------
async function openDetail(id) {
  const m = await api(`/monitors/${id}`);
  $('#detailTitle').textContent = m.name || '详情';
  $('#detailBody').innerHTML = `
    <dl class="kv">
      <dt>网址</dt><dd><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.url)}</a></dd>
      <dt>元素</dt><dd><code>${esc(m.selector)}</code>${m.attribute ? ` → 读取 <code>${esc(m.attribute)}</code>` : ''}</dd>
      <dt>规则</dt><dd>${esc(ruleText(m))}</dd>
      <dt>检查间隔</dt><dd>每 ${m.interval} 分钟${m.enabled ? '' : '（已暂停）'}</dd>
      <dt>上次检查</dt><dd>${fullTime(m.lastCheckedAt)}</dd>
      <dt>上次更新</dt><dd>${fullTime(m.lastChangedAt)}</dd>
      ${m.lastError ? `<dt>错误</dt><dd class="err-text">${esc(m.lastError)}</dd>` : ''}
      ${m.note ? `<dt>备注</dt><dd>${esc(m.note)}</dd>` : ''}
    </dl>
    <h3>变化历史（最近 50 条）</h3>
    ${
      m.history.length
        ? `<ul class="history">${m.history
            .map((h) => `<li><span class="t">${fullTime(h.at)}${h.triggered ? ' 🔔' : ''}</span><span class="value">${esc(h.value)}</span></li>`)
            .join('')}</ul>`
        : '<p class="muted">还没有记录</p>'
    }`;
  openModal('detail');
}

// ---------- 新建/编辑 ----------
const form = $('#monitorForm');
const frame = $('#frame');

function setPreview(text, ok = true) {
  const box = $('#previewValue');
  box.textContent = text;
  box.className = 'preview-value ' + (ok ? 'has' : 'muted');
}

function toggleThreshold() {
  $('#thresholdRow').classList.toggle('hidden', !['gt', 'lt'].includes(form.rule.value));
}

function openEditor(m) {
  state.editingId = m ? m.id : null;
  state.lastPick = null;
  $('#editorTitle').textContent = m ? '编辑监测' : '新建监测';
  $('#formError').textContent = '';
  form.reset();
  form.name.value = m?.name || '';
  form.selector.value = m?.selector || '';
  form.attribute.value = m?.attribute || '';
  form.rule.value = m?.rule || 'changed';
  form.threshold.value = m?.threshold ?? '';
  form.interval.value = m?.interval || state.settings.defaultInterval || 30;
  form.note.value = m?.note || '';
  form.enabled.checked = m ? m.enabled : true;
  form.notifyFeishu.checked = m ? m.notifyFeishu : true;
  form.notifyWebhook.checked = m ? m.notifyWebhook : true;
  toggleThreshold();
  setPreview(m?.lastValue ?? '还没选择元素', m?.lastValue != null);
  $('#fUrl').value = m?.url || '';
  frame.classList.add('hidden');
  frame.removeAttribute('src');
  $('#frameLoading').classList.add('hidden');
  $('#frameTip').classList.remove('hidden');
  openModal('editor');
  if (m) loadFrame();
  else $('#fUrl').focus();
}
window.openEditor = openEditor;

function loadFrame() {
  const url = $('#fUrl').value.trim();
  if (!url) return;
  $('#frameTip').classList.add('hidden');
  $('#frameLoading').classList.remove('hidden');
  frame.classList.add('hidden');
  frame.src = '/api/snapshot?url=' + encodeURIComponent(url);
}

$('#urlForm').addEventListener('submit', (e) => {
  e.preventDefault();
  loadFrame();
});

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
  const d = e.data || {};
  if (d.type === 'pw-loaded') {
    $('#frameLoading').classList.add('hidden');
    frame.classList.remove('hidden');
    if (d.ok && !form.name.value) {
      try {
        form.name.value = frame.contentDocument.title.trim().slice(0, 60);
      } catch {}
    }
    if (d.ok && form.selector.value) frame.contentWindow.postMessage({ type: 'pw-highlight', selector: form.selector.value }, location.origin);
  } else if (d.type === 'pw-pick') {
    state.lastPick = d;
    form.selector.value = d.selector;
    // 点到链接/图片时，自动建议读取地址还是文字
    if (!d.text && d.attrs.href) form.attribute.value = 'href';
    else if (!d.text && d.attrs.src) form.attribute.value = 'src';
    showPickValue();
  } else if (d.type === 'pw-highlight-result') {
    if (!d.found) setPreview('⚠ 在网页上找不到这个选择器', false);
    else {
      state.lastPick = null;
      setPreview(d.text + (d.count > 1 ? `\n\n（匹配到 ${d.count} 个元素，只会读取第一个）` : ''), true);
    }
  }
});

function showPickValue() {
  const p = state.lastPick;
  if (!p) return;
  const attr = form.attribute.value;
  const v = attr ? p.attrs[attr] : p.text;
  if (v == null || v === '') setPreview(attr ? `⚠ 这个元素没有 ${attr}，换成“元素的文字”试试，或点“选父级”` : '（这个元素没有文字，可以点“选父级”扩大范围，或改为读取链接地址）', false);
  else setPreview(v, true);
}

form.attribute.addEventListener('change', showPickValue);
form.rule.addEventListener('change', toggleThreshold);

let selTimer;
form.selector.addEventListener('input', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    if (frame.src && !frame.classList.contains('hidden'))
      frame.contentWindow.postMessage({ type: 'pw-highlight', selector: form.selector.value.trim() }, location.origin);
  }, 400);
});

$('#btnParent').addEventListener('click', () => {
  if (!frame.src) return toast('请先加载网页并选择一个元素', true);
  frame.contentWindow.postMessage({ type: 'pw-parent' }, location.origin);
});

$('#btnTest').addEventListener('click', async () => {
  const btn = $('#btnTest');
  btn.disabled = true;
  btn.textContent = '读取中…';
  try {
    const r = await api('/preview', { method: 'POST', body: { url: $('#fUrl').value.trim(), selector: form.selector.value.trim(), attribute: form.attribute.value } });
    setPreview(r.value || '（内容为空）', !!r.value);
  } catch (err) {
    setPreview('⚠ ' + err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = '🔄 真实读取测试';
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#formError').textContent = '';
  const body = {
    name: form.name.value.trim(),
    url: $('#fUrl').value.trim(),
    selector: form.selector.value.trim(),
    attribute: form.attribute.value,
    rule: form.rule.value,
    threshold: form.threshold.value,
    interval: Number(form.interval.value),
    note: form.note.value.trim(),
    enabled: form.enabled.checked,
    notifyFeishu: form.notifyFeishu.checked,
    notifyWebhook: form.notifyWebhook.checked,
  };
  try {
    if (state.editingId) await api(`/monitors/${state.editingId}`, { method: 'PUT', body });
    else await api('/monitors', { method: 'POST', body });
    closeModal('editor');
    toast(state.editingId ? '已保存' : '已添加，正在进行第一次检查…');
    refresh();
  } catch (err) {
    $('#formError').textContent = err.message;
  }
});

$('#btnAdd').addEventListener('click', () => openEditor());

// ---------- 设置 ----------
const sform = $('#settingsForm');

$('#btnSettings').addEventListener('click', async () => {
  state.settings = await api('/settings');
  for (const k of ['feishuWebhook', 'feishuSecret', 'customWebhook', 'defaultInterval']) sform[k].value = state.settings[k] ?? '';
  $('#settingsError').textContent = $('#settingsOk').textContent = '';
  openModal('settings');
});

function settingsBody() {
  return {
    feishuWebhook: sform.feishuWebhook.value.trim(),
    feishuSecret: sform.feishuSecret.value.trim(),
    customWebhook: sform.customWebhook.value.trim(),
    defaultInterval: Number(sform.defaultInterval.value),
  };
}

sform.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    state.settings = await api('/settings', { method: 'PUT', body: settingsBody() });
    closeModal('settings');
    toast('设置已保存');
  } catch (err) {
    $('#settingsError').textContent = err.message;
  }
});

$('#btnTestNotify').addEventListener('click', async () => {
  $('#settingsError').textContent = $('#settingsOk').textContent = '';
  try {
    // 先保存再测试，测的就是当前填写的地址
    state.settings = await api('/settings', { method: 'PUT', body: settingsBody() });
    const { results } = await api('/settings/test', { method: 'POST' });
    const ok = results.filter((r) => r.ok).map((r) => r.channel);
    const bad = results.filter((r) => !r.ok);
    if (ok.length) $('#settingsOk').textContent = `✅ 已发送：${ok.join('、')}`;
    if (bad.length) $('#settingsError').textContent = bad.map((r) => `❌ ${r.channel}：${r.error}`).join('\n');
  } catch (err) {
    $('#settingsError').textContent = err.message;
  }
});

// ---------- 启动 ----------
async function boot() {
  const me = await fetch('/api/me').then((r) => r.json());
  if (!me.authed) return showLogin();
  $('#app').classList.remove('hidden');
  const [meta, settings] = await Promise.all([api('/meta'), api('/settings')]);
  state.rules = meta.rules;
  state.settings = settings;
  form.rule.innerHTML = Object.entries(state.rules).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  refresh();
}

boot();
