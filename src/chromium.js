// 找浏览器、浏览器丢了自动重新下载。必须在 require('playwright') 之前加载（Playwright 启动时就读定浏览器位置）。
//
// 浏览器默认放在项目里的 .browsers 文件夹：以前放在 node_modules/playwright-core 里面，
// 只要 npm 重新安装一次依赖（比如在线更新时），浏览器就跟着被删掉了，检查全部失败。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const OWN_DIR = path.join(APP_DIR, '.browsers');
const CORE_DIR = path.dirname(require.resolve('playwright-core/package.json'));
const MIRROR = 'https://registry.npmmirror.com/-/binary/playwright';

// 需要的浏览器版本，比如 chromium_headless_shell-1243
const REVISION = JSON.parse(fs.readFileSync(path.join(CORE_DIR, 'browsers.json'), 'utf8')).browsers.find(
  (b) => b.name === 'chromium-headless-shell'
).revision;
const NEED = `chromium_headless_shell-${REVISION}`;

function defaultCache() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'ms-playwright');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
}

// 浏览器装好以后，版本目录里会有一个 INSTALLATION_COMPLETE 标记
const hasBrowser = (dir) => fs.existsSync(path.join(dir, NEED, 'INSTALLATION_COMPLETE'));

// 依次看这些地方有没有装好的浏览器：.env 指定的、项目 .browsers、node_modules 里的、系统默认位置
function locate() {
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const candidates = [
    env && env !== '0' ? path.resolve(APP_DIR, env) : null,
    OWN_DIR,
    path.join(CORE_DIR, '.local-browsers'),
    defaultCache(),
  ].filter(Boolean);
  return candidates.find(hasBrowser) || null;
}

const found = locate();
const BROWSERS_DIR = found || OWN_DIR; // 哪里都没有，就装到项目的 .browsers
process.env.PLAYWRIGHT_BROWSERS_PATH = BROWSERS_DIR;

let status = found ? { state: 'ok' } : { state: 'missing', message: '还没有浏览器组件' };
let installing = null;

// 下载浏览器（国内镜像，约 120MB）。同一时间只下载一次
function install() {
  if (installing) return installing;
  status = { state: 'installing', message: '浏览器组件丢失，正在自动重新下载（约 120MB，需要几分钟）…' };
  console.log('[浏览器] ' + status.message);
  installing = new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(CORE_DIR, 'cli.js'), 'install', '--only-shell', 'chromium'], {
      cwd: APP_DIR,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: BROWSERS_DIR, PLAYWRIGHT_DOWNLOAD_HOST: process.env.PLAYWRIGHT_DOWNLOAD_HOST || MIRROR },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0 && hasBrowser(BROWSERS_DIR)) resolve();
      else reject(new Error('浏览器组件下载失败：' + out.trim().split('\n').slice(-2).join(' ')));
    });
  })
    .then(() => {
      status = { state: 'ok' };
      console.log('[浏览器] 浏览器组件已下载好：' + BROWSERS_DIR);
    })
    .catch((e) => {
      status = { state: 'error', message: e.message };
      console.error('[浏览器] ' + e.message);
      throw e;
    })
    .finally(() => (installing = null));
  return installing;
}

// 启动浏览器前调用：浏览器不在了就先下载
async function ensure() {
  if (hasBrowser(BROWSERS_DIR)) {
    if (status.state !== 'ok') status = { state: 'ok' };
    return;
  }
  await install();
}

const isMissingError = (e) => /Executable doesn't exist|browserType\.launch: .*(not found|ENOENT)/i.test(e?.message || '');

module.exports = { ensure, install, isMissingError, getStatus: () => status, BROWSERS_DIR };
