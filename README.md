# spa-captcha — go-captcha (slide/rotate) 纯 Node.js 自动求解器 + 登录模块

针对 [go-captcha](https://github.com/wenlng/go-captcha) 体系的**滑块 (slide)** 与**旋转 (rotate)** 验证码纯算法求解，并封装了完整的「拉取验证码 → 本地求解 → 提交登录 → 鉴权请求」登录链路。

纯 Node.js (>=16) 实现，**无原生编译依赖**（仅 `jpeg-js` + `pngjs` 两个纯 JS 包；`socks-proxy-agent` 可选用于代理）。

> 仅用于学习研究 / 对自己拥有账号的系统做自动化。请遵守目标站点的服务条款。

## 文件

| 文件 | 说明 |
|---|---|
| `gocaptcha-solver.js` | 求解核心：slide 双算法（灰度 NCC + Canny 边缘交叉验证）、rotate 全角度搜索 |
| `spa-login.js` | 登录入口：验证码拉取 → 求解 → `POST /api/login` → `apiGet/apiPost` 鉴权请求；支持 SOCKS5 代理 |
| `decode.js` | base64 dataURL → RGBA 像素（JPEG/PNG） |
| `verify-final.js` | 全链路验证：登录 + userInfo |
| `test-e2e.js` | 端到端登录测试 |
| `test-proxy-login.js` | 代理池一键测试（自动取低延迟代理逐个尝试） |
| `regression.js` | 求解器样例回归（对齐 Python 参考实现） |

## 快速开始

```bash
npm install
SITE_ORIGIN=https://your-site.example node test-e2e.js <userName> <pwd>
```

代码默认 `SITE_ORIGIN=https://example.com`，接入目标站点时改环境变量即可；登录接口路径/字段名（`UserName`/`Pwd`/`uuid`/`points`/`angle`）按实际站点微调。

## 接口事实（对标准 go-captcha 后端的逆向确认）

- 登录：`POST /api/login`，`Content-Type: application/x-www-form-urlencoded`
  - 参数：`UserName` / `Pwd` / `uuid`（验证码 id）/ `points`（slide）或 `angle`（rotate）
  - 返回：`{error:0, info:"<token>"}`；`error:1` 业务错误；`error:3` 未登录；`error:4` 冻结
- 验证码：`GET /common/captcha`（拉取与校验**必须同一会话 cookie**）
- 后续请求带 `Authorization: Bearer <token>`
- 注册：`POST /api/register`，`UserName/Pwd/Phone`

## go-captcha 校验语义（官方源码 v2 实证）

- **slide**：`slide.Validate(sx, sy, block.X, block.Y, padding=4)`
  → 提交 `points = "<缺口左上角x>,<thumbY>"`。y 恒用服务端返回的 `thumbY`（前端滑块只能横移），x 需识别缺口左上角。
- **rotate**：`rotate.Validate(angle, dAngle, padding)`
  → 提交 `angle = (360 - 矫正角) % 360`。矫正角 = thumb 旋转回去与主图中心圆对齐的角度。
- **click**：服务端逐点校验，算法不可解 → 代码里直接刷新换一张（拉取免费）。

## 求解算法与实测通过率

| 类型 | 方法 | 实测 |
|---|---|---|
| slide | 灰度 NCC + Canny 边缘匹配双求解，结果一致（≤8px）才提交，否则刷新 | 一致时 4/4，分歧提交 0/2 → 分歧必刷 |
| rotate | thumb 全角度旋转与主图中心圆 MSE 最小化，粗搜步长2 + 细搜 ±2 | 7/7 |
| click | 刷新换一张 | — |

## 风控（重要）

登录接口通常有 **IP 级频控**：同一 IP 连续失败 ≥3 次后，所有账号（包括密码必然正确的）登录都返回
"账户或密码错误…被冻结了请联系客服"之类的假密码错（注册接口不受影响）。

模块默认策略：
- 不确定的 slide（双算法分歧）与 click **直接刷新**，绝不盲提交
- 生产使用建议部署在住宅 IP / 独立出口，或控制登录频率

## 用法

```js
const { login } = require('./spa-login');
const res = await login({ userName: 'xxx', pwd: 'xxx', maxAttempts: 15 });
// { ok:true, token:"...", jar, attempts:2 } 或 { ok:false, attempts:15, lastError:"..." }
```

CLI：

```bash
SITE_ORIGIN=https://your-site.example node spa-login.js <userName> <pwd>
```

## 代理登录（绕 IP 风控）

```js
const { login, apiGet } = require('./spa-login');
const r = await login({ userName, pwd, proxy: 'socks5://1.2.3.4:1080' });
const ui = await apiGet(r.jar, r.token, '/api/userInfo?Switch=4');
```

- 依赖 `socks-proxy-agent`（纯 JS）；`proxy` 可选，不传则直连
- CLI：`SITE_ORIGIN=... node spa-login.js <user> <pwd> [socks5://host:port]`
- 一键测试（自动从代理池取低延迟代理逐个尝试，`PROXY_POOL_API` 环境变量指定池地址）：
  `SITE_ORIGIN=... node test-proxy-login.js <user> <pwd>`
- 实测：代理池方案 1 次尝试登录成功 + userInfo 通过；每次登录换不同代理可完全规避 IP 风控
- 免费代理可能中途失效：`login()` 内置"连续 3 次拉验证码失败即熔断"，不会挂死

## 已知问题 / 注意事项

1. **鉴权双要素**：该类站点受保护接口（如 `/api/userInfo`）需要同时携带 `Authorization: Bearer <token>`
   和登录会话 cookie（同一 jar 贯穿 拉验证码→登录→业务请求）。只带 token 会返回 `error:3 请重新登录`。
   模块的 `login()` 返回 `{ token, jar }`，后续用 `apiGet(jar, token, path)` / `apiPost(jar, token, path, params)`。
2. **click 占比高**（实测约 50%），加上 slide 双算法分歧需刷新的部分，一次成功登录平均要拉
   3~8 张验证码，都在本地/免费接口完成，只有双算法一致的 slide 或任意 rotate 才会真正提交。
3. 风控冷却约 20 分钟；`maxAttempts` 只统计"真正提交"的次数（分歧/click 刷新不计入）。

## License

[GPL-3.0](./LICENSE)
