'use strict';
/**
 * spa-login.js — 目标商城站登录 + go-captcha 自动求解（通用模板）
 * 纯 Node.js (>=16)，无原生依赖。依赖: jpeg-js, pngjs, socks-proxy-agent(可选)
 *
 * 用法:
 *   把 SITE_ORIGIN 改成你的目标站点（go-captcha 后端），登录接口路径/字段名按实际调整
 *   const { login } = require('./spa-login');
 *   const res = await login({ userName: 'xxx', pwd: 'xxx' });
 *   // res = { ok: true, token, jar, attempts } 或 { ok:false, attempts, lastError }
 *
 * CLI:
 *   node spa-login.js <userName> <pwd> [socks5://host:port]
 */

const crypto = require('crypto');
const { URL } = require('url');
const { solveSlide, solveRotate } = require('./gocaptcha-solver');
const { decodeImage } = require('./decode');
const { SocksProxyAgent } = require('socks-proxy-agent');

// Node 内置 URL 自动处理 IDN（中文域名 → punycode）
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://example.com'; // ← 改成目标站点
const ORIGIN = SITE_ORIGIN;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

class CookieJar {
  constructor(agent = null) { this.map = new Map(); this.agent = agent; }
  store(res) {
    const set = res.headers['set-cookie'] || [];
    for (const line of set) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.map.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function request(method, url, { headers = {}, body = null, timeout = 20000, agent = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: {
        'User-Agent': UA,
        'Origin': ORIGIN,
        'Referer': ORIGIN + '/',
        ...headers,
      },
      timeout,
      ...(agent ? { agent } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getCaptcha(jar) {
  const res = await request('GET', `${ORIGIN}/common/captcha`, { headers: { Cookie: jar.header() }, agent: jar.agent || null });
  jar.store(res);
  const j = JSON.parse(res.body.toString('utf8'));
  if (j.error !== 0) throw new Error('captcha pull failed: ' + JSON.stringify(j));
  return j.info;
}

async function postLogin(jar, { userName, pwd, uuid, extra }) {
  const params = new URLSearchParams({ UserName: userName, Pwd: pwd, uuid });
  for (const [k, v] of Object.entries(extra || {})) params.set(k, String(v));
  const res = await request('POST', `${ORIGIN}/api/login`, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Cookie: jar.header(),
    },
    body: params.toString(),
    agent: jar.agent || null,
  });
  jar.store(res);
  return JSON.parse(res.body.toString('utf8'));
}

/**
 * 登录（自动处理 slide/rotate 验证码；click 或双算法分歧时自动刷新重试）
 * 返回的 session 含登录后会话 cookie，请求需鉴权的接口时请同时携带 token 与 cookie
 * （见 apiGet/apiPost —— 站点鉴权同时依赖 Bearer token 与登录会话 cookie）
 * @param {object} opts
 * @param {string} opts.userName
 * @param {string} opts.pwd
 * @param {number} [opts.maxAttempts=15] 真正提交的次数上限（分歧/click 刷新不计入）
 * @param {string} [opts.proxy] SOCKS5 代理，如 "socks5://1.2.3.4:1080"（可选）
 * @returns {Promise<{ok:boolean, token?:string, jar?:CookieJar, attempts:number, lastError?:string}>}
 */
async function login(opts) {
  const { userName, pwd, maxAttempts = 15, proxy = null } = opts;
  const agent = proxy ? new SocksProxyAgent(proxy) : null;
  const jar = new CookieJar(agent);
  let submitted = 0;
  let lastError = '';
  let pullFails = 0;
  for (let attempt = 0; attempt < 60 && submitted < maxAttempts; attempt++) {
    let info;
    try {
      info = await getCaptcha(jar);
      pullFails = 0;
    } catch (e) {
      lastError = `captcha pull: ${e.message}`;
      if (++pullFails >= 3) break; // 连续拉取失败（代理失效等），立即熔断
      continue;
    }
    const type = info.CaptchaType;
    let extra;
    if (type === 'slide') {
      const s = solveSlide(info);
      if (!s.agree) { lastError = `slide disagree (ncc=${s.xNcc}, canny=${s.xCanny}), refresh`; continue; }
      extra = { points: `${s.x},${info.thumbY}` };
    } else if (type === 'rotate') {
      const r = solveRotate(info);
      extra = { angle: r.angle };
    } else {
      lastError = `unsupported type ${type}, refresh`;
      continue; // click 等：刷新换一张
    }
    submitted++;
    const resp = await postLogin(jar, { userName, pwd, uuid: info.uuid, extra });
    if (resp.error === 0) {
      return { ok: true, token: resp.info, jar, attempts: submitted };
    }
    lastError = resp.info || `error=${resp.error}`;
  }
  return { ok: false, attempts: submitted, lastError };
}

/**
 * 带 token + session cookie 的 GET（站点鉴权需同时携带两者）
 */
async function apiGet(jar, token, path) {
  const res = await request('GET', `${ORIGIN}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Cookie': jar.header() },
    agent: jar.agent || null,
  });
  jar.store(res);
  return JSON.parse(res.body.toString('utf8'));
}

/**
 * 带 token + session cookie 的 POST（x-www-form-urlencoded）
 */
async function apiPost(jar, token, path, params) {
  const body = new URLSearchParams(params || {}).toString();
  const res = await request('POST', `${ORIGIN}${path}`, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'Authorization': `Bearer ${token}`,
      'Cookie': jar.header(),
    },
    body,
    agent: jar.agent || null,
  });
  jar.store(res);
  return JSON.parse(res.body.toString('utf8'));
}

module.exports = { login, apiGet, apiPost, getCaptcha, postLogin, solveSlide, solveRotate, CookieJar, ORIGIN };

/* CLI */
if (require.main === module) {
  const [userName, pwd, proxy] = process.argv.slice(2);
  if (!userName || !pwd) {
    console.error('usage: node spa-login.js <userName> <pwd> [socks5://host:port]');
    process.exit(1);
  }
  login({ userName, pwd, proxy: proxy || null }).then(r => {
    const { jar, ...rest } = r;
    console.log(JSON.stringify(rest, null, 2));
    process.exit(r.ok ? 0 : 2);
  }).catch(e => { console.error(e); process.exit(1); });
}
