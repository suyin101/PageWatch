// 用 Playwright 无头浏览器打开网页，这样需要 JS 加载出来的内容也能读到。
const fs = require('fs');
const path = require('path');

// 先定好浏览器在哪（丢了会自动重新下载），再加载 Playwright
const chromiumFiles = require('./chromium');
const { chromium } = require('playwright');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV_TIMEOUT = 45_000;
const SELECTOR_TIMEOUT = 15_000;
const SESSION_IDLE_MS = 3 * 60_000; // 编辑时打开的网页保留 3 分钟，方便马上试读；关掉编辑窗口就立刻关
const MAX_SESSIONS = 2;
const CHECK_TIMEOUT = 90_000; // 一次检查最多 90 秒，网页卡死也不会一直占着
const BROWSER_IDLE_MS = 3 * 60_000; // 浏览器闲着 3 分钟就关掉，把内存还给服务器，要用时再开（约 1 秒）

// 省内存的启动参数。宝塔/Linux 上一般以 root 或 www 运行，需要 --no-sandbox
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-sync',
  '--mute-audio',
  '--no-first-run',
  '--renderer-process-limit=4',
];

let browserPromise = null;
let busy = 0; // 正在进行的检查数
let lastUsed = Date.now();

async function launch() {
  await chromiumFiles.ensure();
  try {
    return await chromium.launch({ args: LAUNCH_ARGS });
  } catch (e) {
    // 浏览器文件被删了（比如被重新安装依赖），重新下载后再试一次
    if (!chromiumFiles.isMissingError(e)) throw e;
    await chromiumFiles.install();
    return chromium.launch({ args: LAUNCH_ARGS });
  }
}

async function getBrowser() {
  lastUsed = Date.now();
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.isConnected()) return b;
  }
  browserPromise = launch();
  return browserPromise;
}

// 启动时先准备好浏览器（丢了就先下载），第一次检查不用等
function warmup() {
  getBrowser().catch((e) => console.error('[浏览器启动失败]', e.message));
}

// 闲着的浏览器关掉：没有在检查、没有打开着的编辑网页，并且有一阵子没用了
setInterval(async () => {
  if (!browserPromise || busy || sessions.size || Date.now() - lastUsed < BROWSER_IDLE_MS) return;
  const p = browserPromise;
  browserPromise = null;
  editContextPromise = null;
  const b = await p.catch(() => null);
  if (b) await b.close().catch(() => {});
}, 60_000).unref();

async function newContext() {
  const browser = await getBrowser();
  return browser.newContext({ userAgent: UA, locale: 'zh-CN', viewport: { width: 1366, height: 900 } });
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() =>
    clearTimeout(timer)
  );
}

async function gotoPage(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch (e) {
    // 连接偶尔被网站掐断（防火墙、网络抖动），隔一秒再试一次
    if (!/ERR_(CONNECTION_(RESET|CLOSED)|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR|NETWORK_CHANGED)/.test(e.message)) throw new Error(friendlyError(e.message));
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } catch (e2) {
      throw new Error(friendlyError(e2.message));
    }
  }
}

// 很多网站会一直在后台发请求，“等所有请求结束”经常要等到超时，所以只短暂等一下
const settle = (page, ms) => page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});

function friendlyError(msg) {
  const known = [
    [/ERR_NAME_NOT_RESOLVED/, '找不到这个网站（域名无法解析），检查一下网址'],
    [/ERR_CONNECTION_REFUSED/, '网站拒绝连接，可能网站挂了'],
    [/ERR_CONNECTION_(RESET|CLOSED)|ERR_EMPTY_RESPONSE/, '连接被网站中断，可能被网站拦截了'],
    [/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/, '电脑没有联网'],
    [/ERR_CERT|SSL/, '网站的 HTTPS 证书有问题'],
    [/Timeout/i, '网页打开超时（超过 45 秒）'],
  ];
  for (const [re, text] of known) if (re.test(msg)) return text;
  return '网页打开失败：' + msg.replace(/^page\.goto:\s*/, '').split('\n')[0];
}

function cleanText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// 在已经打开的网页里读取元素。attribute 为空时读文字，否则读属性（比如下载链接的 href）
async function readFromPage(page, selector, attribute, settleMs = 2500) {
  const loc = page.locator(selector).first();
  try {
    await loc.waitFor({ state: 'attached', timeout: SELECTOR_TIMEOUT });
  } catch {
    throw new Error('在网页上找不到这个元素，可能网页改版了，请重新选择元素');
  }
  // 元素出现后再稍等一下，让 JS 把内容填完整
  if (settleMs) await settle(page, settleMs);
  if (attribute) {
    const v = await loc.getAttribute(attribute);
    if (v == null) throw new Error(`元素没有 ${attribute} 属性`);
    // 链接类属性转成完整网址，方便直接点开
    if (['href', 'src'].includes(attribute)) return loc.evaluate((el, a) => el[a] || el.getAttribute(a), attribute);
    return cleanText(v);
  }
  return cleanText(await loc.evaluate((el) => el.innerText || el.textContent));
}

// 读下载按钮的链接。读不到不算出错（下载按钮只是附带信息），返回 null
async function readDownload(page, selector) {
  if (!selector) return null;
  try {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'attached', timeout: 5000 });
    return await loc.evaluate((el) => {
      // 点到的可能是按钮里面的文字，往外找最近的链接
      const a = el.closest('a[href]') || el.querySelector('a[href]');
      const url = (a && a.href) || el.getAttribute('data-href') || el.getAttribute('data-url') || '';
      if (!url || /^javascript:/i.test(url)) return null;
      // 只是跳到本页某个位置（#xxx）的不算下载链接
      if (url.split('#')[0] === location.href.split('#')[0] && url.includes('#')) return null;
      return new URL(url, location.href).href;
    });
  } catch {
    return null;
  }
}

// 广告、统计脚本：和网页内容无关，还会让网页迟迟“加载不完”，后台打开时直接拦掉
const JUNK_HOSTS =
  /(^|\.)(googlesyndication|doubleclick|google-analytics|googletagmanager|googletagservices|googleadservices|adservice\.google|fundingchoicesmessages\.google|hm\.baidu|cnzz|umeng|51\.la|clarity\.ms|hotjar|facebook\.net|connect\.facebook)\.|^pos\.baidu\.com$/;

// 不用下载的请求：图片、视频、字体，以及广告统计
function isJunk(req) {
  if (['image', 'media', 'font'].includes(req.resourceType())) return true;
  try {
    return JUNK_HOSTS.test(new URL(req.url()).hostname);
  } catch {
    return false;
  }
}

// 定时检查用：不加载图片、视频、字体，只要文字，所以更快。
// 返回 { raw: 元素内容, downloadUrl: 下载链接或 null }
async function readElement(url, selector, attribute, opts = {}) {
  busy++;
  try {
    await chromiumFiles.ensure(); // 浏览器丢了先下载，下载时间不算在 90 秒里
    return await withTimeout(readElementOnce(url, selector, attribute, opts), CHECK_TIMEOUT, '检查超时（超过 90 秒），网站太慢或卡住了');
  } finally {
    busy--;
    lastUsed = Date.now();
  }
}

async function readElementOnce(url, selector, attribute, { downloadSelector } = {}) {
  const context = await newContext();
  try {
    await context.route('**/*', (route) => (isJunk(route.request()) ? route.abort() : route.continue()));
    const page = await context.newPage();
    await gotoPage(page, url);
    let raw;
    try {
      raw = await readFromPage(page, selector, attribute);
    } catch (e) {
      // 有的网站偶尔不给内容（比如 B 站有时会返回反爬虫页面），刷新再试一次
      if (!/找不到这个元素/.test(e.message)) throw e;
      await gotoPage(page, url);
      raw = await readFromPage(page, selector, attribute);
    }
    return { raw, downloadUrl: await readDownload(page, downloadSelector) };
  } finally {
    await context.close();
  }
}

// ---------- 编辑时用的“实时网页” ----------
// 点选元素时打开的网页先不关，“真实读取测试”直接在这个网页上读，几乎不用等
const sessions = new Map(); // url -> { page, css, timer, ready }

// 编辑用的网页都开在同一个浏览器环境里，共用缓存：同一个网站点进下一页、重新加载时，脚本和样式不用再下载。
// 注意不能用 context.route 拦请求（Playwright 一用 route 就关掉缓存），改用浏览器自带的“屏蔽网址”
let editContextPromise = null;
async function editContext() {
  const c = editContextPromise && (await editContextPromise.catch(() => null));
  if (c && c.browser()?.isConnected()) return c;
  editContextPromise = newContext();
  return editContextPromise;
}

const BLANK_GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const BLOCK_PATTERNS = [
  ...['woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'm3u8', 'mp3', 'flv'].flatMap((e) => [`*.${e}`, `*.${e}?*`, `*.${e}@*`]),
  ...['googlesyndication.com', 'doubleclick.net', 'google-analytics.com', 'googletagmanager.com', 'googletagservices.com', 'googleadservices.com',
    'fundingchoicesmessages.google.com', 'hm.baidu.com', 'pos.baidu.com', 'cnzz.com', 'umeng.com', '51.la', 'clarity.ms', 'hotjar.com', 'facebook.net'].map((h) => `*://*${h}/*`),
];

function touch(url) {
  const s = sessions.get(url);
  if (!s) return;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => closeSession(url), SESSION_IDLE_MS);
}

async function closeSession(url) {
  const s = sessions.get(url);
  if (!s) return;
  sessions.delete(url);
  clearTimeout(s.timer);
  await s.page.close().catch(() => {});
}

// 等 JS 生成的内容出来，再快速滚到底触发懒加载。图片不用等：快照里图片由你的浏览器自己去加载
async function prime(page) {
  await settle(page, 1500);
  await page
    .evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight && y < 10000; y += 1000) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
      }
      window.scrollTo(0, 0);
    })
    .catch(() => {});
}

// 后台打开编辑用的网页：不下载图片（用透明小图代替）、视频、字体和广告统计，网页更快“加载完”。快照里的图片由你的浏览器自己加载。
// 样式表照常下载，并且记下内容，生成快照时直接嵌进去，你的浏览器就不用再去网站下载
// （有的网站会拒绝别处来的样式表请求，快照就没有样式了）
async function newSessionPage() {
  const context = await editContext();
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: BLOCK_PATTERNS });
    // 图片不真的下载，直接回一张 1 像素的透明图：网页以为图片加载成功了。
    // 直接屏蔽的话，有的网站（比如 B 站）会以为图片坏了，把封面换成“什么都没有”
    cdp.on('Fetch.requestPaused', ({ requestId }) =>
      cdp
        .send('Fetch.fulfillRequest', {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: 'Content-Type', value: 'image/gif' },
            { name: 'Cache-Control', value: 'no-store' },
          ],
          body: BLANK_GIF,
        })
        .catch(() => {})
    );
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Image', requestStage: 'Request' }] });
  } catch {} // 屏蔽不了也能用，只是慢一点
  const css = new Map(); // 样式表网址 -> Promise<内容>
  page.on('response', (res) => {
    if (res.request().resourceType() !== 'stylesheet' || !res.ok()) return;
    const text = res.text().catch(() => null);
    css.set(res.url(), text);
    const from = res.request().redirectedFrom();
    if (from) css.set(from.url(), text);
  });
  return { page, css };
}

// 样式表里的相对地址（背景图、@import 等）换成完整网址，嵌进快照后才找得到
function absolutizeCss(text, base) {
  return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
    if (/^(data:|#)/i.test(u)) return m;
    try {
      return `url("${new URL(u, base).href}")`;
    } catch {
      return m;
    }
  }).replace(/@import\s+(['"])([^'"]+)\1/g, (m, q, u) => {
    try {
      return `@import "${new URL(u, base).href}"`;
    } catch {
      return m;
    }
  });
}

async function openSession(url, fresh) {
  const existing = sessions.get(url);
  if (existing && !fresh) {
    await existing.ready;
    touch(url);
    return existing.page;
  }
  if (existing) await closeSession(url);
  while (sessions.size >= MAX_SESSIONS) await closeSession(sessions.keys().next().value);

  const { page, css } = await newSessionPage();
  const ready = (async () => {
    await gotoPage(page, url);
    await prime(page);
  })();
  sessions.set(url, { page, css, ready, timer: null });
  try {
    await ready;
  } catch (e) {
    await closeSession(url);
    throw e;
  }
  // 网页自己跳转了（比如 http 跳到 https、B 站 /video 跳到 /upload/video），改记在跳转后的网址下，
  // 前端也会换成这个网址，定时检查直接打开它，更稳
  const final = page.url();
  if (final !== url && /^https?:/.test(final) && sessions.get(url)?.page === page) {
    if (sessions.has(final)) await closeSession(final);
    const s = sessions.get(url);
    sessions.delete(url);
    sessions.set(final, s);
    touch(final);
  } else touch(url);
  return page;
}

// 生成一份“静态快照”给前端点选元素用：复制一份网页，去掉脚本，只保留样子
async function snapshot(url, { fresh = true } = {}) {
  const page = await openSession(url, fresh);
  // 记下的样式表内容（只要快照用得到的，太大的不嵌，免得快照太大）
  const s = [...sessions.values()].find((x) => x.page === page);
  const styles = {};
  let total = 0;
  for (const [href, p] of s ? s.css : []) {
    const text = await p;
    if (text == null || total + text.length > 3_000_000) continue;
    total += text.length;
    styles[href] = absolutizeCss(text, href).replace(/<\/style/gi, '<\\/style');
  }
  const html = await page.evaluate((styles) => {
    // 给真实网页里每个元素编个号，快照里也带着。这样在快照上点到哪个，后台就能准确找到同一个元素
    let n = window.__pwNext || 0;
    for (const el of document.querySelectorAll('*')) if (!el.hasAttribute('data-pw-i')) el.setAttribute('data-pw-i', n++);
    window.__pwNext = n;

    const doc = document.documentElement.cloneNode(true);
    // 很多网站用 onload 事件让样式表生效（先 media=print 或 rel=preload，加载完再切换），去掉 onload 前先切换好
    for (const link of doc.querySelectorAll('link[onload]')) {
      const js = link.getAttribute('onload');
      if (link.media === 'print' && /media/.test(js)) link.media = 'all';
      if (link.rel === 'preload' && link.getAttribute('as') === 'style') link.rel = 'stylesheet';
    }
    // 样式表换成后台已经下载好的内容
    for (const link of doc.querySelectorAll('link[rel~="stylesheet"]')) {
      const text = styles[link.href];
      if (text == null) continue;
      const style = document.createElement('style');
      if (link.media) style.media = link.media;
      style.textContent = text;
      link.replaceWith(style);
    }
    doc.querySelectorAll('script, noscript, iframe, object, embed, base, meta[http-equiv]').forEach((el) => el.remove());
    for (const el of doc.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
    }
    // 懒加载图片：把 data-src 换成 src，预览更完整
    doc.querySelectorAll('img[data-src]').forEach((img) => {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) img.setAttribute('src', img.dataset.src);
    });
    let head = doc.querySelector('head');
    if (!head) doc.prepend((head = document.createElement('head')));
    const base = document.createElement('base');
    base.href = location.href;
    head.prepend(base);
    // 不告诉图片网站“从哪个网页来的”：很多网站（比如 B 站）的图片会拒绝别的网站来的请求
    const ref = document.createElement('meta');
    ref.name = 'referrer';
    ref.content = 'no-referrer';
    head.prepend(ref);
    return '<!DOCTYPE html>' + doc.outerHTML;
  }, styles);
  return { html, finalUrl: page.url() };
}

// “浏览网页”模式：在真实网页上点一下（链接、按钮、标签页都行），等网页反应完，返回现在的网址。
// 网址变了的话，这个打开着的网页就改记在新网址名下，前端接着用新网址取快照
async function clickInSession(url, selector, href, pwi) {
  const page = await openSession(url, false);
  const context = page.context();
  // 原本在新窗口打开的链接，改成在当前网页打开
  await page.evaluate(() => document.querySelectorAll('a[target]').forEach((a) => a.removeAttribute('target'))).catch(() => {});

  // 点完后最多等 2 秒，看会不会跳转或弹出新窗口
  let cleanup = () => {};
  const reaction = new Promise((resolve) => {
    const onNav = (f) => f === page.mainFrame() && resolve({ nav: true });
    const onPopup = async (p) => (await p.opener()) === page && resolve({ popup: p });
    page.on('framenavigated', onNav);
    context.on('page', onPopup);
    const timer = setTimeout(() => resolve({}), 2000);
    cleanup = () => {
      page.off('framenavigated', onNav);
      context.off('page', onPopup);
      clearTimeout(timer);
    };
  });

  // 优先按编号找（快照上点的就是它），找不到再按选择器找
  let loc = null;
  for (const sel of [pwi != null && `[data-pw-i="${Number(pwi)}"]`, selector].filter(Boolean)) {
    const l = page.locator(sel).first();
    if (await l.count().catch(() => 0)) {
      loc = l;
      break;
    }
  }
  let clicked = !!loc && (await loc.click({ timeout: 5000 }).then(() => true, () => false));
  // 元素被挡住或看不见时，直接用 JS 点
  if (loc && !clicked) clicked = await loc.evaluate((el) => (el.click(), true), null, { timeout: 3000 }).catch(() => false);

  if (!clicked) {
    cleanup();
    if (!href) throw new Error('在网页上点不到这个元素，换一个地方点试试');
    await gotoPage(page, href);
  } else {
    const r = await reaction;
    cleanup();
    if (r.popup) {
      // 弹出了新窗口：拿到它的网址，在当前网页打开
      await r.popup.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      const popupUrl = r.popup.url();
      await r.popup.close().catch(() => {});
      if (/^https?:/.test(popupUrl)) await gotoPage(page, popupUrl);
    } else if (r.nav) {
      await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT }).catch(() => {});
    }
  }
  await prime(page);

  const now = page.url();
  if (now !== url && sessions.get(url)?.page === page) {
    if (sessions.has(now)) await closeSession(now);
    const s = sessions.get(url);
    sessions.delete(url);
    sessions.set(now, s);
  }
  touch(now);
  return now;
}

// 在快照上选好元素后，到后台真实网页里核对一遍：按编号找到同一个元素，用真实网页重新生成选择器。
// 快照去掉了脚本、iframe，网页自己的 JS 也可能又改过内容，快照里算的选择器在真实网页上不一定对得上。
// 没有打开着的网页时返回 null（没法核对）
const SELECTOR_JS = fs.readFileSync(path.join(__dirname, 'selector.js'), 'utf8');

async function locate(url, selector, pwi) {
  const s = sessions.get(url);
  if (!s) return null;
  await s.ready;
  touch(url);
  const check = ({ selector, pwi }) => {
    const { cssPath, text } = window.PWSelector;
    const el = pwi != null ? document.querySelector(`[data-pw-i="${Number(pwi)}"]`) : null;
    if (el) return { found: true, selector: cssPath(el), text: text(el).slice(0, 500) };
    let first = null;
    try {
      first = document.querySelector(selector);
    } catch {}
    return { found: !!first, selector, text: first ? text(first).slice(0, 500) : '' };
  };
  // 用字符串执行：不受网站自己的安全策略（CSP）限制
  return s.page.evaluate(`${SELECTOR_JS}\n(${check})(${JSON.stringify({ selector, pwi })})`);
}

// “真实读取测试”：有打开着的网页就直接读，没有就像定时检查一样重新打开
async function preview(url, selector, attribute, { downloadSelector } = {}) {
  const started = Date.now();
  const s = sessions.get(url);
  if (s) {
    try {
      await s.ready;
      touch(url);
      const value = await readFromPage(s.page, selector, attribute, 0);
      const downloadUrl = await readDownload(s.page, downloadSelector);
      return { value, downloadUrl, ms: Date.now() - started, live: true };
    } catch (e) {
      if (/找不到这个元素|没有 .* 属性/.test(e.message)) throw e;
      // 网页可能已经坏了，退回到重新打开
    }
  }
  const { raw, downloadUrl } = await readElement(url, selector, attribute, { downloadSelector });
  return { value: raw, downloadUrl, ms: Date.now() - started, live: false };
}

// 关掉编辑窗口时调用：编辑用的网页全部关掉，立刻释放内存
async function closeSessions() {
  for (const url of [...sessions.keys()]) await closeSession(url);
}

async function closeBrowser() {
  for (const url of [...sessions.keys()]) await closeSession(url);
  if (editContextPromise) await (await editContextPromise.catch(() => null))?.close().catch(() => {});
  editContextPromise = null;
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

module.exports = { readElement, snapshot, preview, clickInSession, locate, warmup, closeSessions, closeBrowser, status: chromiumFiles.getStatus };
