// 用 Playwright 无头浏览器打开网页，这样需要 JS 加载出来的内容也能读到。
const fs = require('fs');
const path = require('path');

// 服务器上的安装脚本把浏览器装在项目里（node_modules/playwright-core/.local-browsers）。
// 发现有的话就用它，不依赖 .env 里的 PLAYWRIGHT_BROWSERS_PATH，免得找到 /root/.cache 去
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const local = path.join(path.dirname(require.resolve('playwright-core/package.json')), '.local-browsers');
  if (fs.existsSync(local)) process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
}

const { chromium } = require('playwright');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV_TIMEOUT = 45_000;
const SELECTOR_TIMEOUT = 15_000;
const SESSION_IDLE_MS = 5 * 60_000; // 编辑时打开的网页保留 5 分钟，方便马上试读
const MAX_SESSIONS = 3;

let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.isConnected()) return b;
  }
  // 宝塔/Linux 服务器上一般以 root 运行，需要 --no-sandbox
  browserPromise = chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  return browserPromise;
}

// 启动时先把浏览器打开，第一次检查就不用等浏览器启动
function warmup() {
  getBrowser().catch((e) => console.error('[浏览器启动失败]', e.message));
}

async function newContext() {
  const browser = await getBrowser();
  return browser.newContext({ userAgent: UA, locale: 'zh-CN', viewport: { width: 1366, height: 900 } });
}

async function gotoPage(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  } catch (e) {
    throw new Error(friendlyError(e.message));
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

// 定时检查用：不加载图片、视频、字体，只要文字，所以更快。
// 返回 { raw: 元素内容, downloadUrl: 下载链接或 null }
async function readElement(url, selector, attribute, { downloadSelector } = {}) {
  const context = await newContext();
  try {
    await context.route('**/*', (route) =>
      ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()
    );
    const page = await context.newPage();
    await gotoPage(page, url);
    const raw = await readFromPage(page, selector, attribute);
    return { raw, downloadUrl: await readDownload(page, downloadSelector) };
  } finally {
    await context.close();
  }
}

// ---------- 编辑时用的“实时网页” ----------
// 点选元素时打开的网页先不关，“真实读取测试”直接在这个网页上读，几乎不用等
const sessions = new Map(); // url -> { context, page, timer, ready }

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
  await s.context.close().catch(() => {});
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

  const context = await newContext();
  const page = await context.newPage();
  const ready = (async () => {
    await gotoPage(page, url);
    await settle(page, 1500);
    // 图片不用等：快照里图片由你的浏览器自己去加载。只要 JS 生成的内容出来就行
    // 快速滚到底，触发懒加载的内容
    await page
      .evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight && y < 10000; y += 1000) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 40));
        }
        window.scrollTo(0, 0);
      })
      .catch(() => {});
  })();
  sessions.set(url, { context, page, ready, timer: null });
  try {
    await ready;
  } catch (e) {
    await closeSession(url);
    throw e;
  }
  touch(url);
  return page;
}

// 生成一份“静态快照”给前端点选元素用：复制一份网页，去掉脚本，只保留样子
async function snapshot(url, { fresh = true } = {}) {
  const page = await openSession(url, fresh);
  const html = await page.evaluate(() => {
    const doc = document.documentElement.cloneNode(true);
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
    return '<!DOCTYPE html>' + doc.outerHTML;
  });
  return { html, finalUrl: page.url() };
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

async function closeBrowser() {
  for (const url of [...sessions.keys()]) await closeSession(url);
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

module.exports = { readElement, snapshot, preview, warmup, closeBrowser };
