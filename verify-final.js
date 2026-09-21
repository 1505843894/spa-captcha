'use strict';
// 全链路验证：login() → apiGet('/api/userInfo') （走 SITE_ORIGIN 指定的站点）
// 用法: SITE_ORIGIN=https://your-site node verify-final.js <userName> <pwd>
const { login, apiGet } = require('./spa-login');

(async () => {
  const [,, userName, pwd] = process.argv;
  if (!userName || !pwd) { console.error('usage: node verify-final.js <userName> <pwd>'); process.exit(1); }
  const r = await login({ userName, pwd });
  if (!r.ok) {
    console.log(JSON.stringify({ ok: false, attempts: r.attempts, lastError: r.lastError }));
    process.exit(2);
  }
  const ui = await apiGet(r.jar, r.token, '/api/userInfo?Switch=4');
  if (ui && ui.Id !== undefined) {
    console.log(JSON.stringify({
      ok: true,
      loginAttempts: r.attempts,
      userId: ui.Id,
      userName: ui.UserName,
      level: ui.Level,
      vipName: ui.VName,
      balance: ui.Balance,
    }, null, 2));
  } else {
    console.log(JSON.stringify({ ok: false, stage: 'userInfo', resp: ui }, null, 2));
    process.exit(2);
  }
})().catch(e => { console.error(e); process.exit(1); });
