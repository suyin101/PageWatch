// 启动器：npm start 运行的是它，由它来运行真正的程序 server.js。
// 好处：在线更新完成后 server.js 退出，启动器马上用新代码重新启动它；
// 程序万一崩溃也会自动拉起来。宝塔只需要管启动器这一个进程。
const { spawn } = require('child_process');
const path = require('path');

const RESTART_CODE = 99; // server.js 用这个退出码表示“请重启我”（更新完成）
let child = null;
let stopping = false;
let quickCrashes = 0;

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'], // ipc：启动器没了，server.js 会知道并跟着退出
    env: { ...process.env, PAGEWATCH_LAUNCHER: '1' },
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return process.exit(0);
    if (code === RESTART_CODE) {
      console.log('[启动器] 更新完成，正在用新版本重新启动…');
      quickCrashes = 0;
      return start();
    }
    // 意外退出：自动重启。短时间内反复崩溃就等久一点，别疯狂重启
    quickCrashes = Date.now() - startedAt < 30_000 ? quickCrashes + 1 : 0;
    const wait = Math.min(60, 2 ** quickCrashes) * 1000;
    console.error(`[启动器] 程序意外退出（${signal || '退出码 ' + code}），${wait / 1000} 秒后自动重启`);
    setTimeout(start, wait);
  });
}

// 宝塔点“停止”时，把 server.js 一起停掉
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill('SIGTERM');
    else process.exit(0);
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

start();
