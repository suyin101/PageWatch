// 「网站能否打开」监测：不开浏览器，直接访问网址，看网站有没有正常回应。
// 打不开（连不上、超时、返回 5xx/4xx、证书有问题）就算出错；还可以要求网页里必须有某段文字，
// 防止网站挂了但服务器返回一个“看起来正常”的错误页
const TIMEOUT = 20_000;
const MAX_BYTES = 2 * 1024 * 1024; // 找文字最多看这么多内容

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CERT_ERRORS = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/;

function why(e) {
  const c = e.cause?.code || '';
  if (e.name === 'TimeoutError') return `网站没有响应（${TIMEOUT / 1000} 秒内没有回应）`;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return '找不到这个网站（域名无法解析），可能域名过期或解析出错';
  if (c === 'ECONNREFUSED') return '网站拒绝连接，可能网站服务没在运行';
  if (c === 'ECONNRESET' || c === 'UND_ERR_SOCKET') return '连接被网站中途断开';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH') return '连不到服务器，可能服务器关机或网络故障';
  if (c === 'CERT_HAS_EXPIRED') return 'HTTPS 证书已过期，浏览器会提示不安全';
  if (CERT_ERRORS.test(c)) return `HTTPS 证书有问题（${c}），浏览器会提示不安全`;
  return '访问失败：' + (c || e.message);
}

async function readText(res) {
  // 只读前面一部分，网页很大时不用全部下载完
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

async function checkOnce(url, keyword) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (e) {
    throw new Error(why(e));
  }
  const ms = Date.now() - started;
  if (res.status >= 500) throw new Error(`网站出错了（HTTP ${res.status}${res.status === 502 || res.status === 504 ? '，一般是后台程序挂了' : ''}）`);
  if (res.status === 404) throw new Error('网页不存在（HTTP 404），检查网址对不对');
  if (res.status >= 400) throw new Error(`网站拒绝访问（HTTP ${res.status}）`);
  if (keyword) {
    let text;
    try {
      text = await readText(res);
    } catch (e) {
      throw new Error(why(e));
    }
    if (!text.includes(keyword)) throw new Error(`网页能打开，但里面找不到「${keyword}」，可能打开的是错误页`);
  } else {
    res.body?.cancel().catch(() => {});
  }
  return { status: res.status, ms };
}

// 偶尔一次连不上不算数，等 5 秒再试一次
async function checkSite(url, keyword) {
  keyword = String(keyword || '').trim();
  try {
    return await checkOnce(url, keyword);
  } catch (e) {
    if (/HTTP 404|域名无法解析|找不到「|证书/.test(e.message)) throw e;
    await new Promise((r) => setTimeout(r, 5000));
    return checkOnce(url, keyword);
  }
}

const secs = (ms) => `${Math.max(0.1, ms / 1000).toFixed(1)} 秒`;

// 返回格式和 browser.readElement 一样：比较的值固定是「正常」，原文里带上响应速度
async function readUptime(url, keyword) {
  const { status, ms } = await checkSite(url, keyword);
  return { raw: `正常（HTTP ${status}，用时 ${secs(ms)}）`, value: '正常', ms, downloadUrl: null };
}

module.exports = { readUptime };
