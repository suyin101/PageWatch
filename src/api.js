// 「接口数据」监测：不开浏览器，直接请求网站的数据接口（返回 JSON 的网址），取其中一项。
// 比打开整个网页快得多也稳得多（B 站空间页这类网页脚本多、反爬严，在服务器上常常打不开）
const TIMEOUT = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FIELDS = 300; // 给编辑窗口列出的项最多这么多

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// B 站接口对“没有访客标识”的请求容易返回 412（风控）。先向 B 站要一个访客标识（buvid），之后的请求都带上，
// 像浏览器里的普通访客；被拦了就换一个新的
let biliCookie = null;
async function biliHeaders(fresh) {
  if (!biliCookie || fresh) {
    biliCookie = null;
    try {
      const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
      const d = (await r.json()).data;
      if (d?.b_3) biliCookie = `buvid3=${d.b_3}; buvid4=${encodeURIComponent(d.b_4 || '')}`;
    } catch {}
  }
  return { Referer: 'https://www.bilibili.com/', Origin: 'https://www.bilibili.com', ...(biliCookie && { Cookie: biliCookie }) };
}
const isBili = (url) => /(^|\.)bilibili\.com$/.test(new URL(url).hostname);

async function fetchOnce(url, { fresh = false } = {}) {
  let res;
  try {
    const extra = isBili(url) ? await biliHeaders(fresh) : {};
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9', ...extra },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    const c = e.cause?.code || '';
    if (e.name === 'TimeoutError') throw new Error(`接口超时（${TIMEOUT / 1000} 秒内没有返回）`);
    if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') throw new Error('找不到这个网站（域名无法解析），检查一下网址');
    if (c === 'ECONNREFUSED') throw new Error('网站拒绝连接，可能网站挂了');
    throw new Error('接口请求失败：' + (c || e.message));
  }
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('接口返回的内容太大了');
  if (res.status === 412 || res.status === 429) throw new Error(`接口暂时拒绝访问（HTTP ${res.status}），网站觉得访问太频繁，过一会儿会自动恢复`);
  if (!res.ok) throw new Error(`接口返回错误（HTTP ${res.status}）`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('这个网址返回的不是接口数据（JSON），请用「网页」方式监测');
  }
}

// 偶尔连接失败、超时或被风控拦一下，等几秒再请求（最多再试两次）
async function fetchJson(url) {
  for (let i = 0; ; i++) {
    try {
      return await fetchOnce(url, { fresh: i > 0 });
    } catch (e) {
      if (i >= 2 || /不是接口数据|HTTP (?!412|429)4\d\d|域名无法解析/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, (i + 1) * 4000));
    }
  }
}

// 路径写法：data.card.fans、data.list[0].title（也可以写 data.list.0.title）
function parsePath(path) {
  return String(path || '')
    .trim()
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
}

function getPath(json, path) {
  let v = json;
  for (const k of parsePath(path)) {
    if (v == null || typeof v !== 'object' || !(k in v)) return undefined;
    v = v[k];
  }
  return v;
}

const toText = (v) => (v != null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''));

// 列出所有可选的项（只列最里层的值），给编辑窗口点选
function listFields(json) {
  const out = [];
  const walk = (v, path) => {
    if (out.length >= MAX_FIELDS) return;
    if (v != null && typeof v === 'object') {
      const entries = Array.isArray(v) ? v.slice(0, 20).map((x, i) => [i, x]) : Object.entries(v);
      if (!entries.length) return;
      for (const [k, x] of entries) walk(x, Array.isArray(v) ? `${path}[${k}]` : path ? `${path}.${k}` : k);
      return;
    }
    out.push({ path, value: toText(v).slice(0, 200) });
  };
  walk(json, '');
  return out;
}

// 读接口里的一项。返回格式和 browser.readElement 一样
async function readApi(url, path) {
  const json = await fetchJson(url);
  const v = getPath(json, path);
  if (v === undefined) {
    // B 站等接口出错时会返回 code 和 message，一起显示出来方便判断
    const why = json && typeof json === 'object' && json.code && json.message ? `（接口说：${json.message}）` : '';
    throw new Error(`接口数据里找不到「${path}」这一项${why}`);
  }
  return { raw: toText(v).replace(/\s+/g, ' ').trim(), downloadUrl: null };
}

// 编辑窗口用：读出所有项，选了某一项就同时给出它的值
async function previewApi(url, path) {
  const started = Date.now();
  const json = await fetchJson(url);
  const r = { fields: listFields(json), ms: Date.now() - started };
  if (path) {
    const v = getPath(json, path);
    if (v === undefined) throw new Error(`接口数据里找不到「${path}」这一项`);
    r.value = toText(v).replace(/\s+/g, ' ').trim();
  }
  return r;
}

module.exports = { readApi, previewApi, getPath, listFields };
