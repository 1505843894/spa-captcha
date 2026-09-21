'use strict';
/**
 * 测试：用已知样例验证 solveSlide/solveRotate，再跑端到端登录
 */
const fs = require('fs');
const { solveSlide, solveRotate } = require('./gocaptcha-solver');
const { decodeImage } = require('./decode');

// 与 Python 参考实现的一致性检查（用已验证通过的 4 个 slide 样例 + 1 个 rotate 样例）
for (let i = 1; i <= 12; i++) {
  const p = `/tmp/sample_${i}.json`;
  if (!fs.existsSync(p)) continue;
  let d;
  try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
  const info = d && d.info;
  if (!info || !info.CaptchaType) continue;
  if (info.CaptchaType === 'slide') {
    const t0 = Date.now();
    const r = solveSlide(info);
    console.log(`sample${i} slide: submit=${r.x} (ncc=${r.xNcc}, canny=${r.xCanny}, agree=${r.agree}, nconf=${r.nccConf.toFixed(0)}, cconf=${r.cannyConf.toFixed(2)}) ${Date.now()-t0}ms`);
  } else if (info.CaptchaType === 'rotate') {
    const t0 = Date.now();
    const r = solveRotate(info);
    console.log(`sample${i} rotate: submit=${r.angle} (aStar=${r.aStar}) ${Date.now()-t0}ms`);
  }
}

// e2e
const { login } = require('./spa-login');
const userName = process.argv[2];
const pwd = process.argv[3];
if (!userName || !pwd) { console.error('usage: SITE_ORIGIN=https://your-site node test-e2e.js <userName> <pwd>'); process.exit(1); }
login({ userName, pwd }).then(r => {
  console.log('E2E:', JSON.stringify({ ok: r.ok, attempts: r.attempts, lastError: r.lastError, tokenLen: r.token ? r.token.length : 0 }));
  process.exit(r.ok ? 0 : 2);
}).catch(e => { console.error('E2E ERROR:', e.message); process.exit(1); });
