// 自检：确认浏览器能启动、能打开网页。npm run selftest
const fs = require('fs');
const path = require('path');
const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const browser = require('../src/browser');

(async () => {
  const url = process.argv[2] || 'https://www.baidu.com';
  const t = Date.now();
  try {
    const { raw: title } = await browser.readElement(url, 'title');
    console.log(`✅ 浏览器正常：打开 ${url} 用时 ${((Date.now() - t) / 1000).toFixed(1)} 秒，标题“${title}”`);
    process.exitCode = 0;
  } catch (e) {
    console.error(`❌ 自检失败：${e.message}`);
    process.exitCode = 1;
  } finally {
    await browser.closeBrowser();
  }
})();
