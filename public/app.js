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
  if (res.status === 401 && !['/login', '/setup'].includes(path)) {
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
  // 关掉编辑窗口：卸掉预览网页（省你电脑的内存），也让服务器关掉后台打开的网页（省服务器内存）
  if (id === 'editor') {
    frame.removeAttribute('src');
    fetch('/api/browse/close', { method: 'POST' }).catch(() => {});
  }
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
// 还没有账号时显示“创建管理员账号”，有账号时显示登录
let setupMode = false;
function showLogin(hasAccount = true) {
  setupMode = !hasAccount;
  $('#splash').classList.add('hidden');
  const lf = $('#loginForm');
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#loginHint').textContent = setupMode ? '第一次使用，请创建管理员账号' : '请登录后台';
  $('#loginBtn').textContent = setupMode ? '创建账号并进入' : '登录';
  lf.password2.classList.toggle('hidden', !setupMode);
  lf.password2.required = setupMode;
  lf.password.autocomplete = setupMode ? 'new-password' : 'current-password';
  lf.password.placeholder = setupMode ? '密码（至少 6 位）' : '密码';
  lf.username.focus();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#loginError').textContent = '';
  try {
    if (setupMode && f.password.value !== f.password2.value) throw new Error('两次输入的密码不一样');
    const body = { username: f.username.value.trim(), password: f.password.value };
    setLoginBusy(true);
    // 登录接口直接带回所有数据，拿到就能显示，不用再等好几轮请求
    const data = await api(setupMode ? '/setup' : '/login', { method: 'POST', body });
    f.reset();
    showApp(data);
  } catch (err) {
    $('#loginError').textContent = err.message;
  } finally {
    setLoginBusy(false);
  }
});

function setLoginBusy(busy) {
  const b = $('#loginBtn');
  b.disabled = busy;
  b.innerHTML = busy ? '<span class="spinner sm"></span>' + (setupMode ? '正在创建…' : '登录中…') : setupMode ? '创建账号并进入' : '登录';
}

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
        const rawTitle = m.extract && m.lastRaw ? `原文：${m.lastRaw}` : m.lastValue;
        value += `<div class="value" title="${esc(rawTitle)}">${esc(m.lastValue)}</div>`;
        if (m.lastDownloadUrl) value += `<a class="dl-link" href="${esc(m.lastDownloadUrl)}" target="_blank" rel="noopener noreferrer">⬇ 下载</a>`;
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
      // 下面几个操作先在页面上立刻改好（不等服务器），服务器出错再改回来，点了马上有反应
      case 'ack':
        m.status = m.lastError ? 'error' : 'ok';
        render();
        toast('已标记为处理完成');
        await api(`/monitors/${id}/ack`, { method: 'POST' });
        break;
      case 'toggle': {
        const enabled = !m.enabled;
        m.enabled = enabled;
        render();
        toast(enabled ? '已启用' : '已暂停');
        await api(`/monitors/${id}`, { method: 'PUT', body: { enabled } });
        break;
      }
      case 'delete':
        if (!confirm(`确定删除“${m.name || m.url}”吗？历史记录也会一起删除。`)) return;
        state.monitors = state.monitors.filter((x) => x.id !== id);
        render();
        toast('已删除');
        await api(`/monitors/${id}`, { method: 'DELETE' });
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
  refresh(true);
});

// 自动刷新：服务器的数据没变就不重画列表（用 ETag 判断），页面切到后台时暂停
let refreshTimer;
async function refresh(force = false) {
  clearTimeout(refreshTimer);
  if (document.hidden) return; // 回到这个页面时会马上刷新
  try {
    const res = await fetch('/api/monitors', { cache: 'no-cache' });
    if (res.status === 401) return showLogin();
    if (!res.ok) throw new Error();
    showBrowserStatus(res.headers.get('X-PW-Browser'));
    const etag = res.headers.get('ETag');
    // “几分钟前”这类时间要更新，所以就算没变化，每分钟也重画一次
    if (force || !etag || etag !== state.etag || Date.now() - state.renderedAt > 60_000) {
      state.monitors = await res.json();
      state.etag = etag;
      state.renderedAt = Date.now();
      render();
    }
    $('#refreshInfo').textContent = `自动刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch {}
  scheduleRefresh();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.username) refresh();
});

// 浏览器组件丢失、正在重新下载时，在页面顶上提示
function showBrowserStatus(header) {
  let b = null;
  try {
    b = typeof header === 'string' ? JSON.parse(decodeURIComponent(header)) : header;
  } catch {}
  const el = $('#browserBanner');
  if (!b || b.state === 'ok') return el.classList.add('hidden');
  el.className = 'banner ' + (b.state === 'error' ? 'err' : '');
  el.textContent =
    b.state === 'error'
      ? `⚠ ${b.message}。程序会在下次检查时自动再试；一直不行的话，把这段文字发给开发者`
      : '⏳ ' + (b.message || '正在准备浏览器组件…') + ' 下载好之前，检查和加载网页会失败，好了以后自动恢复';
}

// 有正在检查的就刷新得勤一点
function scheduleRefresh() {
  clearTimeout(refreshTimer);
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
      ${m.extract ? `<dt>只看</dt><dd>${esc(state.extractModes[m.extract])}${m.extract === 'regex' ? ` <code>${esc(m.extractPattern)}</code>` : ''}</dd>` : ''}
      ${m.extract && m.lastRaw ? `<dt>原文</dt><dd>${esc(m.lastRaw)}</dd>` : ''}
      ${m.lastDownloadUrl ? `<dt>下载链接</dt><dd><a href="${esc(m.lastDownloadUrl)}" target="_blank" rel="noopener noreferrer">${esc(m.lastDownloadUrl)}</a></dd>` : ''}
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

// raw：真正读到的原文（text 里可能还带着提示文字），用来做“只看版本号”这类提取
function setPreview(text, ok = true, meta = '', metaClass = '', raw = text) {
  const box = $('#previewValue');
  box.textContent = text;
  box.className = 'preview-value ' + (ok ? 'has' : 'muted');
  state.previewRaw = ok ? raw : null;
  setPreviewMeta(meta, metaClass);
  refreshExtract();
}

// 按“只看哪部分”的设置，显示实际用来比较的内容；和服务器用的是同一份代码（extract.js）
function refreshExtract() {
  const mode = form.extract.value;
  const raw = state.previewRaw;
  $('#patternRow').classList.toggle('hidden', mode !== 'regex');
  const row = $('#extractedRow');
  const hint = $('#extractHint');
  row.classList.add('hidden');
  hint.classList.add('hidden');
  if (raw == null) return;
  if (mode) {
    row.classList.remove('hidden');
    try {
      $('#extractedValue').textContent = PWExtract.extract(raw, mode, form.extractPattern.value);
      row.classList.remove('err');
    } catch (err) {
      $('#extractedValue').textContent = '⚠ ' + err.message;
      row.classList.add('err');
    }
    return;
  }
  // 整段文字模式下，如果里面有版本号，提醒可以只看版本号
  const v = PWExtract.suggestVersion(raw);
  if (v) {
    hint.innerHTML = `💡 内容里有版本号 <b>${esc(v)}</b>。现在旁边的文字（日期、下载次数等）变了也会通知你，建议
      <button type="button" class="link" id="btnUseVersion">只看版本号</button>`;
    hint.classList.remove('hidden');
    $('#btnUseVersion').onclick = () => {
      form.extract.value = 'version';
      refreshExtract();
    };
  }
}

// ---------- 选择下载按钮 ----------
function setPickTarget(target) {
  state.pickTarget = target;
  $('#pickBanner').classList.toggle('hidden', target !== 'download');
}

function showDownload(url, { tried = false } = {}) {
  const box = $('#downloadPreview');
  state.downloadUrl = url || null;
  if (url) {
    box.className = 'preview-meta ok';
    box.innerHTML = `⬇ 下载链接：<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`;
  } else if (tried && form.downloadSelector.value.trim()) {
    box.className = 'preview-meta err';
    box.textContent = '⚠ 这个元素上没读到下载链接，换一个元素试试（比如点按钮本身而不是里面的文字）';
  } else {
    box.textContent = '';
  }
}

$('#btnPickDownload').addEventListener('click', () => {
  if (frame.classList.contains('hidden')) return toast('请先在左边加载网页', true);
  setFrameMode('pick');
  setPickTarget('download');
});
$('#btnCancelPick').addEventListener('click', () => setPickTarget('main'));
form.downloadSelector.addEventListener('input', () => showDownload(null));

function setPreviewMeta(html, cls = '') {
  const m = $('#previewMeta');
  m.innerHTML = html;
  m.className = 'preview-meta ' + cls;
}

// 等待时每秒更新一次提示，让人知道还在干活
function startTimer(onTick) {
  const started = Date.now();
  const tick = () => onTick(Math.floor((Date.now() - started) / 1000));
  tick();
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}

function toggleThreshold() {
  $('#thresholdRow').classList.toggle('hidden', !['gt', 'lt'].includes(form.rule.value));
}

function openEditor(m) {
  state.editingId = m ? m.id : null;
  state.lastPick = null;
  state.autoName = null;
  $('#editorTitle').textContent = m ? '编辑监测' : '新建监测';
  $('#formError').textContent = '';
  $('#notifyTestMsg').textContent = '';
  form.reset();
  form.name.value = m?.name || '';
  form.selector.value = m?.selector || '';
  form.attribute.value = m?.attribute || '';
  form.extract.value = m?.extract || '';
  form.extractPattern.value = m?.extractPattern || '';
  form.downloadSelector.value = m?.downloadSelector || '';
  setPickTarget('main');
  showDownload(m?.lastDownloadUrl);
  form.rule.value = m?.rule || 'changed';
  form.threshold.value = m?.threshold ?? '';
  form.interval.value = m?.interval || state.settings.defaultInterval || 30;
  form.note.value = m?.note || '';
  form.enabled.checked = m ? m.enabled : true;
  form.notifyFeishu.checked = m ? m.notifyFeishu : true;
  form.notifyWebhook.checked = m ? m.notifyWebhook : true;
  toggleThreshold();
  const raw = m?.lastRaw ?? m?.lastValue;
  setPreview(raw ?? '还没选择元素', raw != null);
  $('#fUrl').value = m?.url || '';
  state.navStack = [];
  state.warnedSameUrl = false;
  setFrameMode('pick');
  $('#modeBar').classList.add('hidden');
  frame.classList.add('hidden');
  frame.removeAttribute('src');
  $('#frameLoading').classList.add('hidden');
  $('#frameTip').classList.remove('hidden');
  openModal('editor');
  if (m) loadFrame(false);
  else $('#fUrl').focus();
}
window.openEditor = openEditor;

const LOADING_STEPS = [
  [0, '正在连接网站…'],
  [3, '正在等待网页内容加载…'],
  [8, '这个网站比较慢，再稍等一下…'],
  [20, '网站响应很慢，最多等 45 秒…'],
];
let stopLoadingTimer = () => {};

// fresh=false：编辑时如果这个网页几分钟内打开过，直接用，不再重新加载
// keepPage：浏览时点了链接，加载新页面期间旧页面不消失，只盖一层半透明的“加载中”，像平常浏览网页一样
function loadFrame(fresh = true, { keepPage = false } = {}) {
  const url = $('#fUrl').value.trim();
  if (!url) return;
  $('#frameTip').classList.add('hidden');
  $('#frameLoading').classList.remove('hidden');
  $('#frameLoading').classList.toggle('overlay', keepPage);
  if (!keepPage) frame.classList.add('hidden');
  stopLoadingTimer();
  stopLoadingTimer = startTimer((sec) => {
    $('#loadingText').textContent = LOADING_STEPS.filter(([t]) => sec >= t).pop()[1];
    $('#loadingTime').textContent = sec ? `已用 ${sec} 秒` : '';
  });
  frame.src = `/api/snapshot?fresh=${fresh ? 1 : 0}&url=${encodeURIComponent(url)}`;
}

$('#urlForm').addEventListener('submit', (e) => {
  e.preventDefault();
  state.navStack = [];
  loadFrame();
});

// 粘贴网址后直接开始加载，不用再点按钮
$('#fUrl').addEventListener('paste', () =>
  setTimeout(() => {
    if (!/^https?:\/\/\S+$/i.test($('#fUrl').value.trim())) return;
    state.navStack = [];
    loadFrame();
  })
);

// ---------- 选择元素 / 浏览网页 ----------
// 浏览模式下点网页，是在后台真实的网页上点（进入链接、切换标签页都行），点完再显示新的样子
const MODE_HINTS = {
  pick: '点击网页上的内容，选择要监测的元素',
  browse: '像平常一样点链接进入别的页面，到了要监测的页面再切回「选择元素」',
};

function setFrameMode(mode) {
  state.frameMode = mode;
  for (const b of $('#modeSeg').children) b.classList.toggle('on', b.dataset.mode === mode);
  $('#modeHint').textContent = MODE_HINTS[mode];
  $('#btnBack').disabled = !state.navStack?.length;
  if (frame.src) frame.contentWindow?.postMessage({ type: 'pw-mode', mode }, location.origin);
}

$('#modeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setFrameMode(b.dataset.mode);
});

$('#btnBack').addEventListener('click', () => {
  const prev = state.navStack.pop();
  if (!prev) return;
  $('#fUrl').value = prev;
  $('#btnBack').disabled = !state.navStack.length;
  clearPicks();
  loadFrame(false);
});

// 换了一个网页，之前选的元素属于上一个网页，清掉，免得保存了一个在新网页上找不到的元素
function clearPicks() {
  if (!form.selector.value && !form.downloadSelector.value) return;
  form.selector.value = '';
  form.downloadSelector.value = '';
  state.lastPick = null;
  showDownload(null);
  setPreview('已进入新页面。切到「🎯 选择元素」，在网页上点一下要监测的内容', false);
}

// 在快照上选好元素后，到后台真实网页里核对一下，换成在真实网页上算出的选择器（更准）
async function verifyPick(d, field) {
  const url = $('#fUrl').value.trim();
  try {
    const r = await api('/browse/locate', { method: 'POST', body: { url, selector: d.selector, pwi: d.pwi } });
    if (r.unknown || field.value !== d.selector) return; // 没法核对，或者已经又选了别的
    if (r.found) {
      field.value = r.selector;
      if (field === form.selector && state.lastPick === d) d.selector = r.selector;
    } else if (field === form.selector) {
      setPreviewMeta('⚠ 后台打开的网页里找不到这个元素（网页可能刚变过）。点「加载网页」重新加载后再选一次', 'err');
    } else {
      showDownload(null);
      $('#downloadPreview').className = 'preview-meta err';
      $('#downloadPreview').textContent = '⚠ 后台打开的网页里找不到这个按钮，点「加载网页」重新加载后再选一次';
    }
  } catch {}
}

async function browseClick(d) {
  const from = $('#fUrl').value.trim();
  $('#frameLoading').classList.remove('hidden');
  $('#frameLoading').classList.add('overlay');
  $('#loadingText').textContent = '正在打开…';
  $('#loadingTime').textContent = '';
  let scrollY = 0;
  try {
    scrollY = frame.contentWindow.scrollY;
  } catch {}
  try {
    const r = await api('/browse/click', { method: 'POST', body: { url: from, selector: d.selector, href: d.href, pwi: d.pwi } });
    if (r.url !== from) {
      state.navStack.push(from);
      $('#fUrl').value = r.url;
      clearPicks();
      const host = (u) => new URL(u).hostname.replace(/^www\./, '');
      if (host(r.url) !== host(from))
        toast(`已跳到另一个网站（${host(r.url)}）。如果不是你想去的页面（比如点到了广告），按「← 返回」`);
    } else {
      // 同一个网页里切换了内容（比如标签页），回到刚才看的位置
      state.restoreScroll = scrollY;
      if (!state.warnedSameUrl) toast('网址没变。如果要监测的内容是点了以后才出现的，定时检查时可能读不到，保存前请点「真实读取测试」确认');
      state.warnedSameUrl = true;
    }
    $('#btnBack').disabled = !state.navStack.length;
    loadFrame(false, { keepPage: true });
  } catch (err) {
    toast(err.message, true);
    $('#frameLoading').classList.add('hidden');
  }
}

window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.source !== frame.contentWindow) return;
  const d = e.data || {};
  if (d.type === 'pw-loaded') {
    stopLoadingTimer();
    $('#frameLoading').classList.add('hidden');
    frame.classList.remove('hidden');
    if (state.restoreScroll) frame.contentWindow.scrollTo(0, state.restoreScroll);
    state.restoreScroll = 0;
    $('#modeBar').classList.toggle('hidden', !d.ok);
    if (d.ok) setFrameMode(state.frameMode);
    // 网页自己跳转了的话（快照里记着跳转后的网址），换成跳转后的网址，定时检查直接打开它
    if (d.ok) {
      try {
        const real = frame.contentDocument.baseURI;
        if (/^https?:/.test(real) && real !== $('#fUrl').value.trim()) $('#fUrl').value = real;
      } catch {}
    }
    // 名称没填，或还是之前自动填的网页标题（浏览到了别的页面），就换成现在网页的标题
    if (d.ok && (!form.name.value || form.name.value === state.autoName)) {
      try {
        form.name.value = state.autoName = frame.contentDocument.title.trim().slice(0, 60);
      } catch {}
    }
    if (d.ok && form.selector.value) frame.contentWindow.postMessage({ type: 'pw-highlight', selector: form.selector.value }, location.origin);
  } else if (d.type === 'pw-click') {
    browseClick(d);
  } else if (d.type === 'pw-pick' && state.pickTarget === 'download') {
    form.downloadSelector.value = d.selector;
    setPickTarget('main');
    showDownload(d.link || d.attrs.href, { tried: true });
    verifyPick(d, form.downloadSelector);
  } else if (d.type === 'pw-pick') {
    state.lastPick = d;
    form.selector.value = d.selector;
    // 点到链接/图片时，自动建议读取地址还是文字
    if (!d.text && d.attrs.href) form.attribute.value = 'href';
    else if (!d.text && d.attrs.src) form.attribute.value = 'src';
    showPickValue();
    verifyPick(d, form.selector);
  } else if (d.type === 'pw-highlight-result') {
    if (!d.found) setPreview('⚠ 这个页面上找不到之前选的元素，请在网页上重新点一下要监测的内容', false);
    else {
      state.lastPick = null;
      setPreview(d.text + (d.count > 1 ? `\n\n（匹配到 ${d.count} 个元素，只会读取第一个）` : ''), true, '', '', d.text);
    }
  }
});

function showPickValue() {
  const p = state.lastPick;
  if (!p) return;
  const attr = form.attribute.value;
  const v = attr ? p.attrs[attr] : p.text;
  if (v == null || v === '') setPreview(attr ? `⚠ 这个元素没有 ${attr}，换成“元素的文字”试试，或点“选父级”` : '（这个元素没有文字，可以点“选父级”扩大范围，或改为读取链接地址）', false);
  else setPreview(v, true, '这是预览里看到的内容，保存前可以点「真实读取测试」确认后台也能读到');
}

form.attribute.addEventListener('change', showPickValue);
form.extract.addEventListener('change', refreshExtract);
form.extractPattern.addEventListener('input', refreshExtract);
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
  const stop = startTimer((sec) =>
    setPreviewMeta(`<span class="spinner sm"></span>后台正在读取${sec >= 2 ? `，已用 ${sec} 秒（需要重新打开网页时会慢一些）` : '…'}`)
  );
  try {
    const r = await api('/preview', {
      method: 'POST',
      body: {
        url: $('#fUrl').value.trim(),
        selector: form.selector.value.trim(),
        attribute: form.attribute.value,
        extract: form.extract.value,
        extractPattern: form.extractPattern.value,
        downloadSelector: form.downloadSelector.value.trim(),
      },
    });
    stop();
    showDownload(r.downloadUrl, { tried: true });
    const how = r.live ? '直接读取已打开的网页' : '重新打开网页读取，和定时检查一样';
    setPreview(r.value || '（内容为空）', !!r.value, `✅ 读取成功 · 用时 ${r.ms < 100 ? '不到 0.1' : (r.ms / 1000).toFixed(1)} 秒（${how}）`, 'ok');
  } catch (err) {
    stop();
    setPreview('读取失败', false, '❌ ' + esc(err.message), 'err');
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
    extract: form.extract.value,
    extractPattern: form.extractPattern.value.trim(),
    downloadSelector: form.downloadSelector.value.trim(),
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

function currentCompareValue() {
  if (state.previewRaw == null) return null;
  try {
    return PWExtract.extract(state.previewRaw, form.extract.value, form.extractPattern.value);
  } catch {
    return null;
  }
}

$('#btnMonitorTestNotify').addEventListener('click', async () => {
  const btn = $('#btnMonitorTestNotify');
  const msg = $('#notifyTestMsg');
  btn.disabled = true;
  msg.className = 'preview-meta';
  msg.innerHTML = '<span class="spinner sm"></span>正在发送…';
  try {
    const valueBox = $('#previewValue');
    const { results } = await api('/monitors/test-notify', {
      method: 'POST',
      body: {
        id: state.editingId,
        name: form.name.value.trim(),
        url: $('#fUrl').value.trim(),
        selector: form.selector.value.trim(),
        rule: form.rule.value,
        threshold: form.threshold.value,
        note: form.note.value.trim(),
        notifyFeishu: form.notifyFeishu.checked,
        notifyWebhook: form.notifyWebhook.checked,
        // 用当前读到的内容来模拟变化（设置了“只看版本号”就用提取后的；还没读到就用示例内容）
        value: currentCompareValue() ?? (valueBox.classList.contains('has') ? valueBox.textContent : ''),
        downloadUrl: state.downloadUrl,
      },
    });
    const ok = results.filter((r) => r.ok).map((r) => r.channel);
    const bad = results.filter((r) => !r.ok);
    msg.className = 'preview-meta ' + (bad.length ? 'err' : 'ok');
    msg.textContent = [ok.length ? `✅ 已发送到：${ok.join('、')}，去看看收到没有` : '', ...bad.map((r) => `❌ ${r.channel}：${r.error}`)]
      .filter(Boolean)
      .join('\n');
  } catch (err) {
    msg.className = 'preview-meta err';
    msg.textContent = '❌ ' + err.message;
  } finally {
    btn.disabled = false;
  }
});

$('#btnAdd').addEventListener('click', () => openEditor());

// ---------- 设置 ----------
const channelsForm = $('#channelsForm');
const templatesForm = $('#templatesForm');
const accountForm = $('#accountForm');

function panelMsg(panel, text, ok) {
  const p = panel.closest('.tab-panel');
  p.querySelector('[data-msg=ok]').textContent = ok ? text : '';
  p.querySelector('[data-msg=error]').textContent = ok ? '' : text;
}

function switchTab(name) {
  for (const b of document.querySelectorAll('#settingsTabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of document.querySelectorAll('#settings .tab-panel')) p.classList.toggle('hidden', p.dataset.panel !== name);
  if (name === 'templates') updateTemplatePreview();
  if (name === 'update') openUpdateTab();
  if (name === 'backup') loadBackups();
}
$('#settingsTabs').addEventListener('click', (e) => e.target.dataset.tab && switchTab(e.target.dataset.tab));

$('#btnSettings').onclickAsync = async () => {
  state.settings = await api('/settings');
  const s = state.settings;
  for (const k of ['feishuWebhook', 'feishuSecret', 'customWebhook', 'defaultInterval']) channelsForm[k].value = s[k] ?? '';
  // 模板没改过时显示默认模板，方便在它的基础上修改
  templatesForm.feishuTitleTemplate.value = s.feishuTitleTemplate || state.defaults.feishuTitleTemplate;
  templatesForm.feishuTemplate.value = s.feishuTemplate || state.defaults.feishuTemplate;
  templatesForm.webhookTemplate.value = s.webhookTemplate || '';
  accountForm.reset();
  accountForm.username.value = state.username;
  for (const el of document.querySelectorAll('#settings [data-msg]')) el.textContent = '';
  switchTab('channels');
  openModal('settings');
};
$('#btnSettings').addEventListener('click', () => $('#btnSettings').onclickAsync());

function channelsBody() {
  return {
    feishuWebhook: channelsForm.feishuWebhook.value.trim(),
    feishuSecret: channelsForm.feishuSecret.value.trim(),
    customWebhook: channelsForm.customWebhook.value.trim(),
    defaultInterval: Number(channelsForm.defaultInterval.value),
  };
}

// 和默认模板一样就存成空，以后默认模板升级了也能自动用上
function templatesBody() {
  const v = (k) => templatesForm[k].value.trim();
  return {
    feishuTitleTemplate: v('feishuTitleTemplate') === state.defaults.feishuTitleTemplate ? '' : v('feishuTitleTemplate'),
    feishuTemplate: v('feishuTemplate') === state.defaults.feishuTemplate ? '' : v('feishuTemplate'),
    webhookTemplate: v('webhookTemplate'),
  };
}

async function saveSettings(form) {
  const body = form === channelsForm ? channelsBody() : templatesBody();
  state.settings = await api('/settings', { method: 'PUT', body });
}

for (const f of [channelsForm, templatesForm]) {
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await saveSettings(f);
      panelMsg(f, '✅ 已保存', true);
    } catch (err) {
      panelMsg(f, err.message, false);
    }
  });
}

for (const btn of document.querySelectorAll('[data-test-notify]')) {
  btn.addEventListener('click', async () => {
    const f = btn.closest('form');
    panelMsg(f, '正在发送…', true);
    try {
      // 先保存再测试，测的就是当前填写的内容
      await saveSettings(f);
      const { results } = await api('/settings/test', { method: 'POST' });
      const ok = results.filter((r) => r.ok).map((r) => r.channel);
      const bad = results.filter((r) => !r.ok);
      if (bad.length) panelMsg(f, bad.map((r) => `❌ ${r.channel}：${r.error}`).join('\n') + (ok.length ? `\n✅ 已发送：${ok.join('、')}` : ''), false);
      else panelMsg(f, `✅ 已发送到：${ok.join('、')}，去看看收到没有`, true);
    } catch (err) {
      panelMsg(f, err.message, false);
    }
  });
}

// --- 模板编辑 ---
const WEBHOOK_PRESETS = {
  default: '',
  wecom: JSON.stringify(
    {
      msgtype: 'markdown',
      markdown: {
        content: '**🔔 {{名称}} 有更新**\n> 变化：<font color="warning">{{变化}}</font>\n> 现在：{{对比}}\n> 之前：{{旧内容}}\n> 时间：{{时间}}\n[打开网页]({{网址}})',
      },
    },
    null,
    2
  ),
  dingtalk: JSON.stringify(
    {
      msgtype: 'markdown',
      markdown: {
        title: '{{名称}} 有更新',
        text: '### 🔔 {{名称}} 有更新\n\n**变化：**{{变化}}\n\n**现在：**{{对比}}\n\n**之前：**{{旧内容}}\n\n**时间：**{{时间}}\n\n[打开网页]({{网址}})',
      },
    },
    null,
    2
  ),
};

let lastTplField = null;
for (const el of templatesForm.querySelectorAll('[data-tpl]')) {
  el.addEventListener('focus', () => (lastTplField = el));
  el.addEventListener('input', schedulePreview);
}

function renderChips() {
  $('#varChips').innerHTML = Object.entries(state.variables)
    .map(([k, d]) => `<button type="button" class="chip" data-var="${esc(k)}" title="${esc(d)}">{{${esc(k)}}}</button>`)
    .join('');
}

$('#varChips').addEventListener('click', (e) => {
  const k = e.target.dataset.var;
  if (!k) return;
  const el = lastTplField || templatesForm.feishuTemplate;
  const text = `{{${k}}}`;
  const { selectionStart: a = el.value.length, selectionEnd: b = el.value.length } = el;
  el.value = el.value.slice(0, a) + text + el.value.slice(b);
  el.focus();
  el.setSelectionRange(a + text.length, a + text.length);
  schedulePreview();
});

templatesForm.addEventListener('click', (e) => {
  const preset = e.target.dataset.preset;
  if (preset !== undefined) {
    templatesForm.webhookTemplate.value = WEBHOOK_PRESETS[preset];
    schedulePreview();
  }
  if (e.target.dataset.reset === 'feishu') {
    templatesForm.feishuTitleTemplate.value = state.defaults.feishuTitleTemplate;
    templatesForm.feishuTemplate.value = state.defaults.feishuTemplate;
    schedulePreview();
  }
});

// 把飞书 lark_md 简单转成网页显示（只认我们用到的几种格式）
function larkToHtml(md) {
  let s = md.replace(/<font color='(\w+)'>/g, '\u0001$1\u0002').replace(/<\/font>/g, '\u0003');
  s = s.replace(/</g, '&lt;');
  s = s.replace(/\u0001(\w+)\u0002/g, '<span class="c-$1">').replace(/\u0003/g, '</span>');
  return s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/~~(.+?)~~/g, '<s>$1</s>');
}

let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updateTemplatePreview, 300);
}

async function updateTemplatePreview() {
  try {
    const r = await api('/templates/preview', { method: 'POST', body: templatesBody() });
    $('#pvTitle').textContent = r.feishu.title;
    $('#pvBody').innerHTML = larkToHtml(r.feishu.body);
    $('#pvWebhook').textContent = r.webhook.ok ? JSON.stringify(r.webhook.body, null, 2) : '⚠ ' + r.webhook.error;
    $('#pvWebhook').classList.toggle('err-text', !r.webhook.ok);
  } catch (err) {
    $('#pvBody').textContent = '⚠ ' + err.message;
  }
}

// --- 账号 ---
accountForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const r = await api('/account', {
      method: 'PUT',
      body: {
        username: accountForm.username.value.trim(),
        currentPassword: accountForm.currentPassword.value,
        newPassword: accountForm.newPassword.value,
      },
    });
    state.username = r.username;
    accountForm.currentPassword.value = accountForm.newPassword.value = '';
    panelMsg(accountForm, '✅ 已保存，其它设备需要重新登录', true);
  } catch (err) {
    panelMsg(accountForm, err.message, false);
  }
});

$('#btnLogout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

// ---------- 数据备份 ----------
const backupPanel = document.querySelector('[data-panel=backup]');

function backupLabel(b) {
  const m = b.name.match(/^auto-(\d{4}-\d{2}-\d{2})\.json$/);
  if (m) return `自动备份 · ${m[1]}`;
  if (b.name.startsWith('before-restore-')) return `导入/恢复前的备份 · ${fullTime(b.at)}`;
  return b.name;
}

async function loadBackups() {
  const list = await api('/backups').catch(() => []);
  $('#backupList').innerHTML = list.length
    ? list
        .map(
          (b) => `<li>
          <span class="grow">${esc(backupLabel(b))}</span>
          <span class="small muted">${b.monitors ?? '?'} 个监测 · ${Math.max(1, Math.round(b.size / 1024))} KB</span>
          <a class="btn sm" href="/api/backups/file/${encodeURIComponent(b.name)}" download>下载</a>
          <button type="button" class="btn sm" data-restore="${esc(b.name)}">恢复</button>
        </li>`
        )
        .join('')
    : '<li class="muted">还没有备份（程序每天会自动备份一次）</li>';
}

$('#backupList').addEventListener('click', async (e) => {
  const name = e.target.dataset.restore;
  if (!name) return;
  if (!confirm('用这份备份替换现在全部的监测和通知设置吗？\n（现在的数据会先自动备份一份，登录账号不受影响）')) return;
  try {
    const r = await api(`/backups/file/${encodeURIComponent(name)}/restore`, { method: 'POST' });
    panelMsg(backupPanel, `✅ 已恢复，共 ${r.total} 个监测`, true);
    loadBackups();
    refresh();
  } catch (err) {
    panelMsg(backupPanel, err.message, false);
  }
});

// 选好文件后先看看内容，再让你选“合并”还是“覆盖”
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
    if (data.app !== 'PageWatch' || !Array.isArray(data.monitors)) throw new Error();
  } catch {
    return panelMsg(backupPanel, '这不是 PageWatch 的备份文件', false);
  }
  const box = $('#importChoice');
  box.innerHTML = `备份里有 <b>${data.monitors.length}</b> 个监测（导出于 ${fullTime(data.exportedAt)}，v${esc(data.version || '?')}）。要怎么导入？
    <div class="update-actions">
      <button type="button" class="btn sm primary" data-mode="merge">合并：保留现有的，只添加新的</button>
      <button type="button" class="btn sm" data-mode="replace">覆盖：用备份替换全部</button>
      <button type="button" class="btn sm ghost" data-mode="">取消</button>
    </div>`;
  box.classList.remove('hidden');
  box.onclick = async (ev) => {
    const mode = ev.target.dataset.mode;
    if (mode === undefined) return;
    box.classList.add('hidden');
    if (!mode) return;
    try {
      const r = await api('/backups/import', { method: 'POST', body: { data, mode } });
      panelMsg(
        backupPanel,
        mode === 'merge' ? `✅ 导入完成：新增 ${r.added} 个${r.skipped ? `，${r.skipped} 个已存在所以跳过` : ''}，现在共 ${r.total} 个监测` : `✅ 已用备份覆盖，现在共 ${r.total} 个监测`,
        true
      );
      loadBackups();
      refresh();
    } catch (err) {
      panelMsg(backupPanel, err.message, false);
    }
  };
});

// ---------- 版本更新 ----------
function renderVersionBadge() {
  const b = $('#verBadge');
  const u = state.updateInfo;
  const has = u && u.hasUpdate;
  b.textContent = has ? `v${state.version} · 有新版本` : `v${state.version}`;
  b.classList.toggle('has-update', !!has);
  b.title = has ? `可以更新到 v${u.latest.version}` : '版本更新';
}

$('#verBadge').addEventListener('click', async () => {
  await $('#btnSettings').onclickAsync();
  switchTab('update');
});

// 更新说明是 GitHub 上的 Markdown，这里只认列表和标题，其它按普通文字显示
function notesToHtml(md) {
  const lines = esc(md || '（没有写更新说明）').split(/\r?\n/);
  let out = '';
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    const item = line.match(/^[-*]\s+(.*)/);
    if (item && !inList) (out += '<ul>'), (inList = true);
    if (!item && inList) (out += '</ul>'), (inList = false);
    if (item) out += `<li>${item[1].replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>')}</li>`;
    else if (/^#+\s/.test(line)) out += `<div><b>${line.replace(/^#+\s/, '')}</b></div>`;
    else if (line) out += `<div>${line}</div>`;
  }
  return out + (inList ? '</ul>' : '');
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('zh-CN') : '');

function renderUpdateResult(r) {
  const box = $('#updateResult');
  if (!r.hasUpdate) {
    box.innerHTML = `<p class="ok">✅ 已经是最新版本${r.latest ? `（最新发布：v${esc(r.latest.version)}，${fmtDate(r.latest.publishedAt)}）` : ''}</p>`;
    return;
  }
  box.innerHTML =
    `<h3>发现新版本 v${esc(r.latest.version)}</h3>` +
    r.newer
      .map(
        (rel, i) => `
      <div class="release ${i === 0 ? 'latest' : ''}">
        <div class="release-head"><b>v${esc(rel.version)}</b><span class="small muted">${fmtDate(rel.publishedAt)}</span></div>
        ${notesToHtml(rel.notes)}
      </div>`
      )
      .join('') +
    `<div class="update-actions">
      <button type="button" class="btn primary" id="btnApplyUpdate">立即更新到 v${esc(r.latest.version)}</button>
      <span class="small muted">更新前会自动备份，失败会自动恢复。更新时会短暂重启，大约 10 秒。</span>
    </div>`;
  $('#btnApplyUpdate').addEventListener('click', () => startUpdate(r.latest.version));
}

function renderRollback(backups) {
  const box = $('#rollbackBox');
  if (!backups || !backups.length) return (box.innerHTML = '');
  const b = backups[0];
  box.innerHTML = `<div class="small muted">新版本有问题？可以回到更新前的版本（备份于 ${fullTime(b.at)}）</div>
    <div class="update-actions"><button type="button" class="btn sm" id="btnRollback">↩ 回退到 v${esc(b.version)}</button></div>`;
  $('#btnRollback').addEventListener('click', async () => {
    if (!confirm(`确定回退到 v${b.version} 吗？程序会短暂重启。`)) return;
    try {
      const s = await api('/update/rollback', { method: 'POST' });
      watchUpdate(s);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// 更新日志：项目里的 CHANGELOG.md，按“## v1.2.3 — 日期”分成一个个版本
function parseChangelog(text) {
  return text
    .split(/^## /m)
    .slice(1)
    .map((sec) => {
      const [head, ...body] = sec.split(/\r?\n/);
      const [, version = head, date = ''] = head.match(/^v?([\d.]+)\s*(?:[—-]+\s*(.*))?/) || [];
      return { version, date, notes: body.join('\n').trim() };
    });
}

async function renderChangelog() {
  const box = $('#changelogBox');
  if (box.dataset.loaded) return;
  try {
    const { text } = await api('/changelog');
    const releases = parseChangelog(text);
    box.innerHTML =
      '<h3>更新日志</h3>' +
      releases
        .map(
          (rel) => `
      <div class="release ${rel.version === state.version ? 'current' : ''}">
        <div class="release-head"><b>v${esc(rel.version)}${rel.version === state.version ? '<span class="tag">当前版本</span>' : ''}</b><span class="small muted">${esc(rel.date)}</span></div>
        ${notesToHtml(rel.notes)}
      </div>`
        )
        .join('');
    box.dataset.loaded = '1';
  } catch (err) {
    box.innerHTML = `<p class="small muted">更新日志读取失败：${esc(err.message)}</p>`;
  }
}

async function openUpdateTab() {
  $('#curVersion').textContent = 'v' + state.version;
  renderChangelog();
  const s = await api('/update/status').catch(() => null);
  if (s && s.state === 'running') return watchUpdate(s);
  $('#updateProgress').classList.add('hidden');
  renderRollback(s && s.backups);
  if (state.updateInfo) renderUpdateResult(state.updateInfo);
  else checkUpdate(false);
}

async function checkUpdate(force = true) {
  const btn = $('#btnCheckUpdate');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner sm dark"></span>检测中…';
  try {
    state.updateInfo = await api('/update/check' + (force ? '?force=1' : ''));
    renderUpdateResult(state.updateInfo);
    renderVersionBadge();
  } catch (err) {
    $('#updateResult').innerHTML = `<p class="error">❌ ${esc(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '检测更新';
  }
}
$('#btnCheckUpdate').addEventListener('click', () => checkUpdate(true));

async function startUpdate(version) {
  if (!confirm(`确定更新到 v${version} 吗？更新时程序会短暂重启。`)) return;
  try {
    const s = await api('/update/apply', { method: 'POST', body: { version } });
    watchUpdate(s);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderSteps(s) {
  $('#progressTitle').textContent = s.rollback ? `正在回退到 v${s.to}` : `正在更新：v${s.from} → v${s.to}`;
  $('#updateSteps').innerHTML = s.steps
    .map((name, i) => {
      let cls = '';
      let mark = '·';
      if (i < s.step || s.state === 'done') (cls = 'done'), (mark = '✓');
      if (i === s.step && s.state === 'running') (cls = 'active'), (mark = '<span class="spinner sm dark"></span>');
      if (i === s.step && s.state === 'error') (cls = 'fail'), (mark = '✗');
      return `<li class="${cls}"><span class="mark">${mark}</span>${name}</li>`;
    })
    .join('');
  const msg = $('#updateMsg');
  msg.textContent = s.message || '';
  msg.className = 'small ' + (s.state === 'error' ? 'err-text' : s.state === 'done' ? 'ok' : 'muted');
}

// 盯着更新进度；程序重启后，等新版本起来就刷新页面
// 进度条：每一步开始时的百分比。下载占大头，按实际下载的字节数走；重启后等新版本起来算最后一段
const STEP_PCT = [0, 55, 60, 68, 76, 84, 92];
const fmtMB = (n) => (n / 1048576).toFixed(n < 10485760 ? 2 : 1) + ' MB';

function setProgress(pct, text, cls = '') {
  const fill = $('#pbarFill');
  fill.style.width = Math.max(2, Math.min(100, pct)) + '%';
  fill.className = 'pbar-fill ' + cls;
  $('#pbarText').textContent = `${Math.round(pct)}%　${text}`;
}

function updateProgress(s) {
  if (s.state === 'error') return setProgress(STEP_PCT[s.step || 0] + 2, '更新没有完成', 'fail');
  if (s.state === 'done') return setProgress(92, '新版本已装好，正在重启…');
  const step = s.step || 0;
  let pct = STEP_PCT[step];
  let text = (s.steps[step] || '') + '…';
  if (step === 0 && s.downloaded) {
    pct = Math.max(3, s.total ? (s.downloaded / s.total) * 55 : Math.min(50, s.downloaded / 20480));
    text = `正在下载新版本${s.source ? `（${s.source}）` : ''}　${fmtMB(s.downloaded)}${s.total ? ' / ' + fmtMB(s.total) : ''}`;
  } else if (step === 0) {
    // 还没连上下载地址：进度条慢慢往前走一点，并说明在干什么，不会一直停在 0%
    const waited = s.startedAt ? (Date.now() - new Date(s.startedAt)) / 1000 : 0;
    pct = Math.min(3, 1 + waited / 10);
    text = s.message && !/^下载新版本/.test(s.message) ? s.message : '正在连接下载服务器（GitHub 或国内加速地址）…';
  }
  setProgress(pct, text);
}

// 盯着更新进度；程序重启后，等新版本起来就提示成功并刷新页面
async function watchUpdate(s) {
  $('#updateResult').innerHTML = '';
  $('#rollbackBox').innerHTML = '';
  $('#updateProgress').classList.remove('hidden');
  $('#btnCheckUpdate').disabled = true;
  const stopTimer = startTimer((sec) => ($('#pbarTime').textContent = `已用 ${sec} 秒`));
  while (s.state === 'running') {
    renderSteps(s);
    updateProgress(s);
    await new Promise((r) => setTimeout(r, 800));
    s = await api('/update/status').catch(() => s);
  }
  renderSteps(s);
  updateProgress(s);
  $('#btnCheckUpdate').disabled = false;
  if (s.state !== 'done') return stopTimer();
  if (s.needsManualRestart) {
    stopTimer();
    return setProgress(95, '新版本已装好，请到宝塔 → Node项目 → 点「重启」');
  }

  const target = s.to;
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    await new Promise((r) => setTimeout(r, 1500));
    const waited = Math.round((Date.now() - started) / 1000);
    setProgress(92 + Math.min(7, waited / 3), `正在重启，等待新版本启动…（${waited} 秒）`);
    const data = await fetch('/api/bootstrap').then((r) => r.json()).catch(() => null);
    if (data && data.version === target) {
      stopTimer();
      setProgress(100, s.rollback ? `回退成功，现在是 v${target}` : `更新成功！现在是 v${target}`, 'ok');
      $('#updateMsg').textContent = '正在刷新页面…';
      $('#updateMsg').className = 'small ok';
      toast(s.rollback ? `✅ 已回退到 v${target}` : `🎉 更新成功，已经是 v${target}`);
      if (!s.rollback) {
        try {
          localStorage.setItem('pw-just-updated', target);
        } catch {}
      }
      setTimeout(() => location.reload(), 2000);
      return;
    }
  }
  stopTimer();
  setProgress(95, '重启时间有点长', 'fail');
  $('#updateMsg').textContent = '如果过一会儿还是打不开，请到宝塔 → Node项目 → 点「重启」';
  $('#updateMsg').className = 'small err-text';
}

// ---------- 启动 ----------
// 数据都准备好、界面画好以后再显示，避免先看到空白
function showApp(data) {
  state.username = data.username;
  state.rules = data.meta.rules;
  state.variables = data.meta.variables;
  state.defaults = data.meta.defaults;
  state.settings = data.settings;
  state.monitors = data.monitors;
  form.rule.innerHTML = Object.entries(state.rules).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  state.extractModes = data.meta.extractModes;
  form.extract.innerHTML = Object.entries(data.meta.extractModes).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
  renderChips();
  render();
  $('#refreshInfo').textContent = `自动刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  $('#btnLogout').title = `退出登录（${data.username}）`;
  state.version = data.version;
  renderVersionBadge();
  showBrowserStatus(data.browser);
  // 后台悄悄检查一下有没有新版本，有的话在版本号上提示
  api('/update/check')
    .then((r) => {
      state.updateInfo = r;
      renderVersionBadge();
    })
    .catch(() => {});
  $('#splash').classList.add('hidden');
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  scheduleRefresh();
  showWhatsNew();
}

// 刚更新到新版本时，自动打开「版本更新」，让人看到这次更新了什么
function showWhatsNew() {
  let seen = null;
  let just = null;
  try {
    seen = localStorage.getItem('pw-seen-version');
    just = localStorage.getItem('pw-just-updated');
    localStorage.setItem('pw-seen-version', state.version);
    localStorage.removeItem('pw-just-updated');
  } catch {}
  if (just === state.version || (seen && seen !== state.version)) openWhatsNew();
}

// 弹窗显示当前版本的更新内容
async function openWhatsNew() {
  $('#whatsNewTitle').textContent = `🎉 更新成功，现在是 v${state.version}`;
  $('#whatsNewBody').innerHTML = '<p class="muted">正在读取更新内容…</p>';
  openModal('whatsNew');
  try {
    const rel = parseChangelog((await api('/changelog')).text).find((r) => r.version === state.version);
    $('#whatsNewBody').innerHTML =
      `<div class="release-head"><b>这次更新了什么</b><span class="small muted">${esc(rel?.date || '')}</span></div>` +
      notesToHtml(rel?.notes) +
      '<p class="small muted">以后想再看：设置 → 版本更新 → 更新日志</p>';
  } catch {
    $('#whatsNewBody').innerHTML = '<p class="muted">更新内容可以在 设置 → 版本更新 里查看</p>';
  }
}

async function boot() {
  try {
    const data = await fetch('/api/bootstrap').then((r) => r.json());
    if (!data.authed) return showLogin(data.hasAccount);
    showApp(data);
  } catch {
    $('#splash').innerHTML = '<div>连不上服务器，请检查网络后刷新页面</div>';
  }
}

boot();
