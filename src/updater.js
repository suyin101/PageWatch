// 在线更新：从 GitHub Releases 检查新版本，下载、校验、备份、安装，然后重启。
// 任何一步失败都会自动恢复到更新前的文件。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const WORK_DIR = path.join(APP_DIR, '.update');
const BACKUP_DIR = path.join(WORK_DIR, 'backups');
const KEEP_BACKUPS = 3;
// 这些不属于程序本身，更新和备份都不碰
const KEEP = new Set(['node_modules', 'data', '.env', '.update', '.git', '.user.ini']);

const REPO = process.env.UPDATE_REPO || 'suyin101/PageWatch';
const API = process.env.UPDATE_API || 'https://api.github.com';
const NPM_MIRROR = 'https://registry.npmmirror.com';
const PLAYWRIGHT_MIRROR = 'https://registry.npmmirror.com/-/binary/playwright';
// 国内服务器直连 GitHub 下载可能很慢，失败就换加速地址。
// 只有拿到 GitHub 官方给的文件指纹（sha256）时才会用加速地址，下载后核对指纹，防止文件被篡改
const MIRRORS = (process.env.UPDATE_MIRRORS ?? 'https://ghfast.top/,https://gh-proxy.com/')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const RESTART_CODE = 99;

// ---------- 版本号 ----------
function currentVersion() {
  return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
}

function parseVersion(v) {
  const m = String(v || '').match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return m ? m.slice(1).map(Number) : null;
}

function compare(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// ---------- 检查更新 ----------
let cache = null; // { at, result }
const CACHE_MS = 10 * 60_000; // GitHub 对未登录的访问有频率限制，结果缓存 10 分钟

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'PageWatch-Updater', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub 访问太频繁，请过一会儿再试');
  if (res.status === 404) throw new Error(`在 GitHub 上找不到更新源 ${REPO}`);
  if (!res.ok) throw new Error(`GitHub 返回错误 ${res.status}`);
  return res.json();
}

function toRelease(r) {
  const version = String(r.tag_name).replace(/^v/, '');
  const asset = (r.assets || []).find((a) => /^pagewatch-v?[\d.]+\.tar\.gz$/.test(a.name));
  const sumFile = (r.assets || []).find((a) => a.name === `${asset?.name}.sha256`);
  return {
    version,
    notes: (r.body || '').trim(),
    publishedAt: r.published_at,
    asset: asset && {
      name: asset.name,
      url: asset.browser_download_url,
      size: asset.size,
      digest: /^sha256:[0-9a-f]{64}$/.test(asset.digest || '') ? asset.digest.slice(7) : null,
      sumUrl: sumFile?.browser_download_url || null,
    },
  };
}

async function check({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return { ...cache.result, current: currentVersion() };
  let list;
  try {
    list = await getJson(`${API}/repos/${REPO}/releases?per_page=30`);
  } catch (e) {
    if (e.name === 'TimeoutError' || /fetch failed/.test(e.message)) throw new Error('连不上 GitHub，可能是服务器网络问题，稍后再试');
    throw e;
  }
  const releases = list
    .filter((r) => !r.draft && !r.prerelease && parseVersion(r.tag_name))
    .map(toRelease)
    .filter((r) => r.asset)
    .sort((a, b) => compare(b.version, a.version));
  const current = currentVersion();
  const latest = releases[0] || null;
  const result = {
    current,
    latest,
    hasUpdate: !!latest && compare(latest.version, current) > 0,
    // 跳过了好几个版本时，把中间每个版本的更新说明都列出来
    newer: releases.filter((r) => compare(r.version, current) > 0).map(({ version, notes, publishedAt }) => ({ version, notes, publishedAt })),
    checkedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), result };
  return result;
}

// ---------- 执行更新 ----------
const STEPS = ['下载新版本', '校验文件', '解压', '备份当前版本', '安装新文件', '安装依赖', '重启'];
let status = { state: 'idle' };

function getStatus() {
  return { ...status, steps: STEPS, current: currentVersion(), underLauncher: !!process.env.PAGEWATCH_LAUNCHER };
}

function setStep(i, message) {
  status = { ...status, step: i, message: message || STEPS[i] + '…' };
  console.log(`[更新] ${status.message}`);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// onProgress(已下载字节, 总字节)：给页面显示下载进度用，总大小未知时为 0
async function download(url, { allowMirrors, onProgress }) {
  const candidates = ['', ...(allowMirrors ? MIRRORS : [])];
  const errors = [];
  for (const prefix of candidates) {
    try {
      const res = await fetch(prefix + url, { headers: { 'User-Agent': 'PageWatch-Updater' }, signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!onProgress) return Buffer.from(await res.arrayBuffer());
      const total = Number(res.headers.get('content-length')) || 0;
      const chunks = [];
      let got = 0;
      onProgress(0, total);
      for await (const chunk of res.body) {
        chunks.push(chunk);
        got += chunk.length;
        onProgress(got, total);
      }
      return Buffer.concat(chunks);
    } catch (e) {
      errors.push(`${prefix || '直连 GitHub'}：${e.message}`);
      if (prefix === '' && candidates.length > 1) setStep(0, '直连 GitHub 下载失败，换加速地址重试…');
    }
  }
  throw new Error('下载失败（' + errors.join('；') + '）');
}

// 运行命令，返回输出；失败时带上最后几行输出方便排查
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const nodeDir = path.dirname(process.execPath);
    const p = spawn(cmd, args, {
      cwd: APP_DIR,
      env: { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH}`, ...opts.env },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} ${args[0]} 失败：` + out.trim().split('\n').slice(-3).join(' ')));
    });
  });
}

const npmBin = () => {
  const local = path.join(path.dirname(process.execPath), 'npm');
  return fs.existsSync(local) ? local : 'npm';
};

// 程序自己的文件（不含 node_modules、data、.env 等）
function appEntries(dir) {
  return fs.readdirSync(dir).filter((name) => !KEEP.has(name));
}

function copyApp(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of appEntries(from)) fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true, force: true });
}

function readPkg(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

// 依赖清单的指纹。忽略里面 PageWatch 自己的版本号，只有依赖真的变了才需要重新安装
function lockHash(dir) {
  const f = path.join(dir, 'package-lock.json');
  if (!fs.existsSync(f)) return '';
  const lock = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete lock.version;
  if (lock.packages?.['']) delete lock.packages[''].version;
  return sha256(JSON.stringify(lock));
}

async function installDeps(oldPkg, newPkg, { lockChanged }) {
  if (lockChanged) {
    setStep(5, '依赖有变化，正在安装（国内镜像）…');
    await run(npmBin(), ['install', '--omit=dev', '--no-audit', '--no-fund', `--registry=${NPM_MIRROR}`]);
  }
  // 浏览器组件版本变了，要下载对应的新浏览器
  if (oldPkg.dependencies?.playwright !== newPkg.dependencies?.playwright) {
    setStep(5, '浏览器组件有新版本，正在下载浏览器（约 120MB）…');
    const npx = path.join(path.dirname(npmBin()), 'npx');
    await run(fs.existsSync(npx) ? npx : 'npx', ['playwright', 'install', '--only-shell', 'chromium'], {
      env: { PLAYWRIGHT_DOWNLOAD_HOST: PLAYWRIGHT_MIRROR },
    });
  }
}

// 以 root 运行时，新文件的主人改成和项目目录一样（宝塔常用 www 用户）
async function fixOwner() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const { uid, gid } = fs.statSync(APP_DIR);
  if (uid === 0) return;
  await run('chown', ['-R', `${uid}:${gid}`, APP_DIR]).catch(() => {}); // 宝塔锁定的 .user.ini 会报错，忽略
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((d) => fs.existsSync(path.join(BACKUP_DIR, d, 'package.json')))
    .map((d) => ({ id: d, version: readPkg(path.join(BACKUP_DIR, d)).version, at: fs.statSync(path.join(BACKUP_DIR, d)).mtime.toISOString() }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

function restart() {
  status = { ...status, step: 6, message: '正在重启…' };
  if (process.env.PAGEWATCH_LAUNCHER) {
    setTimeout(() => process.exit(RESTART_CODE), 1000);
    return false;
  }
  // 没有通过启动器运行（比如直接 node server.js），只能请你手动重启
  return true;
}

async function apply(targetVersion) {
  if (status.state === 'running') throw new Error('正在更新中，请稍等');
  const info = await check({ force: true });
  if (!info.hasUpdate) throw new Error('已经是最新版本了');
  const rel = info.latest;
  if (targetVersion && rel.version !== targetVersion) throw new Error(`最新版本已变成 v${rel.version}，请重新检测更新`);

  status = { state: 'running', from: info.current, to: rel.version, startedAt: new Date().toISOString() };
  // 后台进行，页面通过 /api/update/status 看进度
  doApply(rel).catch(() => {});
  return getStatus();
}

async function doApply(rel) {
  const oldPkg = readPkg(APP_DIR);
  const oldLock = lockHash(APP_DIR);
  const backup = path.join(BACKUP_DIR, `v${oldPkg.version}-${Date.now()}`);
  let backedUp = false;
  let filesReplaced = false;
  let depsTouched = false;
  try {
    // 1. 下载
    setStep(0);
    let expected = rel.asset.digest;
    if (!expected && rel.asset.sumUrl) {
      // 指纹只从 GitHub 直连获取，不经过加速地址
      expected = (await download(rel.asset.sumUrl, { allowMirrors: false })).toString().trim().split(/\s+/)[0];
    }
    const file = await download(rel.asset.url, {
      allowMirrors: !!expected,
      onProgress: (got, total) => (status = { ...status, downloaded: got, total }),
    });

    // 2. 校验
    setStep(1);
    if (!expected) throw new Error('拿不到官方文件指纹，为了安全不能更新');
    if (sha256(file) !== expected.toLowerCase()) throw new Error('下载的文件和官方指纹对不上，可能下载不完整或被篡改，已停止更新');

    // 3. 解压到临时目录并检查
    setStep(2);
    fs.rmSync(path.join(WORK_DIR, 'staging'), { recursive: true, force: true });
    const staging = path.join(WORK_DIR, 'staging');
    fs.mkdirSync(staging, { recursive: true });
    const tarFile = path.join(WORK_DIR, rel.asset.name);
    fs.writeFileSync(tarFile, file);
    await run('tar', ['-xzf', tarFile, '-C', staging]);
    const root = fs.existsSync(path.join(staging, 'pagewatch', 'package.json')) ? path.join(staging, 'pagewatch') : staging;
    const newPkg = readPkg(root);
    if (newPkg.version !== rel.version || !fs.existsSync(path.join(root, 'server.js'))) throw new Error('更新包内容不对，已停止更新');

    // 4. 备份
    setStep(3);
    copyApp(APP_DIR, backup);
    backedUp = true;
    for (const old of listBackups().slice(KEEP_BACKUPS)) fs.rmSync(path.join(BACKUP_DIR, old.id), { recursive: true, force: true });

    // 5. 覆盖新文件
    setStep(4);
    filesReplaced = true;
    copyApp(root, APP_DIR);

    // 6. 依赖
    setStep(5, '检查依赖…');
    const lockChanged = lockHash(APP_DIR) !== oldLock;
    depsTouched = lockChanged;
    await installDeps(oldPkg, newPkg, { lockChanged });
    await fixOwner();

    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(tarFile, { force: true });

    // 7. 重启
    const manual = restart();
    status = { ...status, state: 'done', needsManualRestart: manual, message: manual ? '更新完成，请到宝塔重启项目' : '更新完成，正在重启…' };
  } catch (e) {
    let message = '更新失败：' + e.message;
    if (filesReplaced && backedUp) {
      // 恢复旧文件；如果依赖装到一半，按旧的依赖清单重新装回去
      try {
        copyApp(backup, APP_DIR);
        if (depsTouched) {
          await run(npmBin(), ['install', '--omit=dev', '--no-audit', '--no-fund', `--registry=${NPM_MIRROR}`]).catch(() => {});
        }
        message += '。已自动恢复到更新前的版本，程序照常运行';
      } catch (re) {
        message += `。自动恢复也失败了（${re.message}），请把这段文字发给开发者`;
      }
    } else {
      message += '。程序文件没有改动，照常运行';
    }
    console.error('[更新] ' + message);
    status = { ...status, state: 'error', message };
  }
}

// ---------- 回滚 ----------
async function rollback() {
  if (status.state === 'running') throw new Error('正在更新中，请稍等');
  const [latest] = listBackups();
  if (!latest) throw new Error('没有可以回退的备份');
  const dir = path.join(BACKUP_DIR, latest.id);
  const oldLock = lockHash(APP_DIR);
  const oldPkg = readPkg(APP_DIR);
  status = { state: 'running', from: oldPkg.version, to: latest.version, rollback: true };
  try {
    setStep(4, `正在恢复 v${latest.version} 的文件…`);
    copyApp(dir, APP_DIR);
    await installDeps(oldPkg, readPkg(APP_DIR), { lockChanged: lockHash(APP_DIR) !== oldLock });
    await fixOwner();
    fs.rmSync(dir, { recursive: true, force: true }); // 用掉的备份删除，避免反复回到同一个版本
    cache = null;
    const manual = restart();
    status = { ...status, state: 'done', needsManualRestart: manual, message: manual ? '已回退，请到宝塔重启项目' : '已回退，正在重启…' };
  } catch (e) {
    status = { ...status, state: 'error', message: '回退失败：' + e.message };
    throw e;
  }
  return getStatus();
}

module.exports = { currentVersion, check, apply, rollback, getStatus, listBackups };
