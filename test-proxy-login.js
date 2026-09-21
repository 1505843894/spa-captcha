'use strict';
// 代理登录测试：从本地代理池 API 取低延迟代理 → 逐个尝试登录（单代理最多 2 次提交）
// 代理池接口约定：GET /api/proxies?limit=10&sort=latency 返回 {proxies:[{host,port,latency}]}
// 也可以直接传第 3 个参数指定 socks5://host:port
// 用法: SITE_ORIGIN=https://your-site node test-proxy-login.js <userName> <pwd> [proxyUrl]
const { login, apiGet } = require('./spa-login');
const http = require('http');

const PROXY_POOL_API = process.env.PROXY_POOL_API || 'http://127.0.0.1:3040';

function fetchProxies(limit = 10) {
  return new Promise((resolve, reject) => {
    http.get(`${PROXY_POOL_API}/api/proxies?limit=${limit}&sort=latency`, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(b);
          resolve(d.proxies.map(p => ({ url: `socks5://${p.host}:${p.port}`, latency: p.latency })));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function testProxy(proxyUrl) {
  // 先连通性测试（8s 超时）
  try {
    const { SocksProxyAgent } = require('socks-proxy-agent');
    const https = require('https');
    const agent = new SocksProxyAgent(proxyUrl);
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: new URL(process.env.SITE_ORIGIN || 'https://example.com').hostname,
        path: '/common/captcha', method: 'GET',
        agent, timeout: 8000,
      }, res => { res.resume(); res.on('end', resolve); });
      req.on('timeout', () => req.destroy(new Error('proxy timeout')));
      req.on('error', reject);
      req.end();
    });
    return true;
  } catch { return false; }
}

(async () => {
  const [,, userName, pwd, explicit] = process.argv;
  if (!userName || !pwd) { console.error('usage: node test-proxy-login.js <user> <pwd> [proxyUrl]'); process.exit(1); }

  let candidates;
  if (explicit) {
    candidates = [{ url: explicit, latency: 0 }];
  } else {
    console.log(`从代理池 ${PROXY_POOL_API} 取代理...`);
    candidates = await fetchProxies(10);
    console.log(`候选 ${candidates.length} 个`);
  }

  for (const { url, latency } of candidates) {
    process.stdout.write(`测试 ${url} (延迟${latency}ms) ... `);
    if (!(await testProxy(url))) { console.log('连通性失败，跳过'); continue; }
    console.log('连通 ✅');
    const t0 = Date.now();
    const r = await login({ userName, pwd, proxy: url, maxAttempts: 2 });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (r.ok) {
      console.log(`登录成功 ✅ attempts=${r.attempts} 耗时=${dt}s (via ${url})`);
      const ui = await apiGet(r.jar, r.token, '/api/userInfo?Switch=4');
      if (ui.Id !== undefined) {
        console.log(`userInfo: Id=${ui.Id} UserName=${ui.UserName} VName=${ui.VName}`);
        console.log('★ 代理全链路验证通过');
      } else {
        console.log('userInfo 失败:', JSON.stringify(ui).slice(0, 100));
      }
      process.exit(0);
    }
    console.log(`登录失败: ${r.lastError} (${dt}s)`);
    // 验证码错误可以换代理/重试；密码错误/冻结类错误直接停
    if (r.lastError && r.lastError.includes('账户或密码错误')) {
      console.log('→ 触发账号风控签名，停止所有尝试');
      break;
    }
  }
  console.log('所有候选代理均失败');
  process.exit(2);
})().catch(e => { console.error(e); process.exit(1); });
