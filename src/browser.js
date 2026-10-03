// 用 Playwright 无头浏览器打开网页，这样需要 JS 加载出来的内容也能读到。
const { chromium } = require('playwright');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const NAV_TIMEOUT = 45_000;
const SELECTOR_TIMEOUT = 15_000;

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

async function withPage(url, fn) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'zh-CN',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  try {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } catch (e) {
      throw new Error(friendlyError(e.message));
    }
    // 再等一会儿让异步内容加载完；有些网站一直有请求，所以超时也不算错
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    return await fn(page);
  } finally {
    await context.close();
  }
}

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

// 读取某个元素的内容。attribute 为空时读文字，否则读属性（比如下载链接的 href）
async function readElement(url, selector, attribute) {
  return withPage(url, async (page) => {
    const loc = page.locator(selector).first();
    try {
      await loc.waitFor({ state: 'attached', timeout: SELECTOR_TIMEOUT });
    } catch {
      throw new Error('在网页上找不到这个元素，可能网页改版了，请重新选择元素');
    }
    if (attribute) {
      const v = await loc.getAttribute(attribute);
      if (v == null) throw new Error(`元素没有 ${attribute} 属性`);
      // 链接类属性转成完整网址，方便直接点开
      if (['href', 'src'].includes(attribute)) {
        return loc.evaluate((el, a) => el[a] || el.getAttribute(a), attribute);
      }
      return cleanText(v);
    }
    return cleanText(await loc.evaluate((el) => el.innerText || el.textContent));
  });
}

// 生成一份“静态快照”给前端点选元素用：去掉网页自己的脚本，只保留样子
async function snapshot(url) {
  return withPage(url, async (page) => {
    // 慢慢滚到底，触发懒加载内容
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight && y < 20000; y += 800) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 80));
      }
      window.scrollTo(0, 0);
    }).catch(() => {});
    await page.evaluate(() => {
      document.querySelectorAll('script, noscript, iframe, object, embed').forEach((el) => el.remove());
      document.querySelectorAll('meta[http-equiv]').forEach((el) => el.remove());
      for (const el of document.querySelectorAll('*')) {
        for (const attr of [...el.attributes]) {
          if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
        }
      }
      // 懒加载图片：把 data-src 换成 src，预览更完整
      document.querySelectorAll('img[data-src]').forEach((img) => {
        if (!img.getAttribute('src') || img.getAttribute('src').startsWith('data:')) img.src = img.dataset.src;
      });
      document.querySelectorAll('base').forEach((el) => el.remove());
      const base = document.createElement('base');
      base.href = location.href;
      document.head.prepend(base);
    });
    return { html: await page.content(), finalUrl: page.url() };
  });
}

async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (b) await b.close().catch(() => {});
}

module.exports = { readElement, snapshot, closeBrowser };
