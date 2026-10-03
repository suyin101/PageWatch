// 忘记密码时用：node scripts/reset-password.js 用户名 新密码
// 注意：先停止 PageWatch 再运行，改完再启动，否则正在运行的程序会把改动覆盖掉
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');
if (fs.existsSync(ENV_FILE)) {
  const m = fs.readFileSync(ENV_FILE, 'utf8').match(/^\s*DATA_DIR\s*=\s*(.+?)\s*$/m);
  if (m && !process.env.DATA_DIR) process.env.DATA_DIR = m[1].replace(/^(['"])(.*)\1$/, '$2');
}

const [username, password] = process.argv.slice(2);
if (!username || !password || password.length < 6) {
  console.log('用法：npm run reset-password -- 用户名 新密码（密码至少 6 位）');
  process.exit(1);
}
require('../src/store').setAccount(username, password);
console.log(`✅ 已把管理员账号改为 ${username}，所有设备需要重新登录。现在可以重新启动 PageWatch 了。`);
