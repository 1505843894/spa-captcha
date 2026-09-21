'use strict';
/**
 * go-captcha (slide / rotate) 纯 JS 求解器
 *
 * - slide: 双算法 (灰度 NCC + Canny 边缘 matchTemplate) 交叉验证，输出缺口左上角画布坐标 x
 *          提交格式: points = "x,thumbY"   (x=缺口左上角x, thumbY=服务端返回的初始 y)
 * - rotate: 旋转搜索与主图中心圆最小 MSE，输出矫正角 a*；提交 angle = (360 - a*) % 360
 *
 * 校验依据 (go-captcha 官方 v2):
 *   slide.Validate(sx, sy, block.X, block.Y, padding)   → 提交点须在缺口坐标 ±padding 内
 *   rotate.Validate(angle, dAngle, padding)             → angle + dAngle ≈ 360
 */

const { decodeImage } = require('./decode');

/* ---------------- 灰度与卷积工具 ---------------- */

function toGray(data, width, height, channels) {
  // data: Uint8Array (RGB 或 RGBA)
  const g = new Float32Array(width * height);
  const step = channels;
  for (let i = 0, p = 0; i < width * height; i++, p += step) {
    g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return g;
}

function convolve3(src, w, h, kernel) {
  const out = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          s += src[(y + dy) * w + (x + dx)] * kernel[k++];
        }
      }
      out[y * w + x] = s;
    }
  }
  return out;
}

function gaussianBlur(src, w, h) {
  const k = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const s = k.reduce((a, b) => a + b, 0);
  return convolve3(src, w, h, k.map(v => v / s));
}

function canny(gray, w, h) {
  // 简化 Canny：Sobel 梯度幅值 + 双阈值(50/150 比例) + 强弱边缘二值化
  const gx = convolve3(gray, w, h, [-1, 0, 1, -2, 0, 2, -1, 0, 1]);
  const gy = convolve3(gray, w, h, [-1, -2, -1, 0, 0, 0, 1, 2, 1]);
  const mag = new Float32Array(w * h);
  let maxM = 0;
  for (let i = 0; i < w * h; i++) {
    mag[i] = Math.hypot(gx[i], gy[i]);
    if (mag[i] > maxM) maxM = mag[i];
  }
  if (maxM === 0) return mag;
  const out = new Uint8Array(w * h);
  const lo = 50 / 255 * maxM, hi = 150 / 255 * maxM;
  for (let i = 0; i < w * h; i++) {
    if (mag[i] >= hi) out[i] = 255;
    else if (mag[i] >= lo) out[i] = 128; // 弱边缘
  }
  // 弱边缘连通强边缘则保留（简化滞后阈值）
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (out[i] === 128) {
        let strong = false;
        for (let dy = -1; dy <= 1 && !strong; dy++)
          for (let dx = -1; dx <= 1 && !strong; dx++)
            if (out[(y + dy) * w + (x + dx)] === 255) strong = true;
        out[i] = strong ? 255 : 0;
      }
    }
  }
  return out;
}

/* ---------------- slide 求解 ---------------- */

/**
 * 解 slide 验证码
 * @param {{masterImage:string, tileImage:string, thumbX:number, thumbY:number, thumbWidth:number, thumbHeight:number}} info
 * @returns {{x:number, agree:boolean, nccConf:number, cannyConf:number, xNcc:number, xCanny:number}}
 *          x 为建议提交值（缺口左上角画布 x），agree=false 时建议刷新重拉
 */
function solveSlide(info) {
  const bg = decodeImage(info.masterImage);   // {data,width,height,channels}
  const tilePng = decodeImage(info.tileImage);
  const W = bg.width, H = bg.height, ch = bg.channels;
  const tw = info.thumbWidth, th = info.thumbHeight;
  const bgGray = toGray(bg.data, W, H, ch);

  // --- 求解器1: 灰度 NCC（用 alpha>200 的像素）---
  const tGray = toGray(tilePng.data, tilePng.width, tilePng.height, tilePng.channels);
  const tAlpha = new Uint8Array(tilePng.width * tilePng.height);
  if (tilePng.channels === 4) {
    for (let i = 0; i < tAlpha.length; i++) tAlpha[i] = tilePng.data[i * 4 + 3];
  } else {
    tAlpha.fill(255);
  }
  const pts = [], tvals = [];
  for (let y = 1; y < th - 1; y += 2) {
    for (let x = 1; x < tw - 1; x += 2) {
      if (tAlpha[y * tilePng.width + x] > 200) {
        pts.push([x, y]);
        tvals.push(tGray[y * tilePng.width + x]);
      }
    }
  }
  const mt = tvals.reduce((a, b) => a + b, 0) / tvals.length;
  const td = tvals.map(v => v - mt);
  const st = Math.sqrt(td.reduce((a, b) => a + b * b, 0) / td.length);

  const nccAt = (ox, oy) => {
    let s = 0, s2 = 0;
    const xs = new Float32Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const v = bgGray[(oy + pts[i][1]) * W + (ox + pts[i][0])];
      xs[i] = v; s += v; s2 += v * v;
    }
    const mb = s / xs.length;
    const sb = Math.sqrt(s2 / xs.length - mb * mb);
    if (sb < 1e-6) return 0;
    let dot = 0;
    for (let i = 0; i < xs.length; i++) dot += (xs[i] - mb) * td[i];
    return dot / (st * sb);
  };

  let best = [-1, 0, 0];
  const yLo = Math.max(0, info.thumbY - 9), yHi = Math.min(H - th, info.thumbY + 9);
  for (let oy = yLo; oy <= yHi; oy++) {
    for (let ox = 0; ox <= W - tw; ox += 2) {
      const v = nccAt(ox, oy);
      if (v > best[0]) best = [v, ox, oy];
    }
  }
  for (let oy = Math.max(0, best[2] - 1); oy <= Math.min(H - th, best[2] + 1); oy++) {
    for (let ox = Math.max(0, best[1] - 2); ox <= Math.min(W - tw, best[1] + 2); ox++) {
      const v = nccAt(ox, oy);
      if (v > best[0]) best = [v, ox, oy];
    }
  }
  const xNcc = best[1], nccConf = best[0];

  // --- 求解器2: Canny 边缘 + NCC 匹配（内容坐标，画布坐标 = 内容位置 - bbox偏移）---
  let bx0 = 0, by0 = 0;
  for (let y = 0; y < tilePng.height; y++) {
    for (let x = 0; x < tilePng.width; x++) {
      if (tAlpha[y * tilePng.width + x] > 100) {
        if (x < bx0 || (bx0 === 0 && x === 0)) bx0 = x;
        if (y < by0) by0 = y;
      }
    }
  }
  // 重新精确求 bbox（首行首列最小值）
  bx0 = tilePng.width; by0 = tilePng.height;
  for (let y = 0; y < tilePng.height; y++) {
    for (let x = 0; x < tilePng.width; x++) {
      if (tAlpha[y * tilePng.width + x] > 100) {
        if (x < bx0) bx0 = x;
        if (y < by0) by0 = y;
      }
    }
  }
  let x1 = 0, y1 = 0;
  for (let y = 0; y < tilePng.height; y++) {
    for (let x = 0; x < tilePng.width; x++) {
      if (tAlpha[y * tilePng.width + x] > 100) {
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  const cw = x1 - bx0 + 1, chh = y1 - by0 + 1;
  // 内容区灰度
  const contentGray = new Float32Array(cw * chh);
  for (let y = 0; y < chh; y++) {
    for (let x = 0; x < cw; x++) {
      contentGray[y * cw + x] = tGray[(by0 + y) * tilePng.width + (bx0 + x)];
    }
  }
  const bgEdge = canny(bgGray, W, H);
  const tileEdge = canny(canny ? gaussianBlur(contentGray, cw, chh) : contentGray, cw, chh);
  // tileEdge 与 bgEdge 做 NCC 滑动匹配（边缘图上的 NCC 等价于 TM_CCOEFF_NORMED 的线性部分）
  const cwW = W - cw, cwH = H - chh;
  let cbest = [-1, 0, 0];
  for (let oy = 0; oy <= cwH; oy += 2) {
    for (let ox = 0; ox <= cwW; ox += 2) {
      let s = 0, s2 = 0, dot = 0, n = 0;
      for (let y = 0; y < chh; y += 2) {
        for (let x = 0; x < cw; x += 2) {
          const b = bgEdge[(oy + y) * W + (ox + x)];
          const t = tileEdge[y * cw + x];
          s += b; s2 += b * b; dot += b * t; n++;
        }
      }
      const mb = s / n, sb = Math.sqrt(Math.max(s2 / n - mb * mb, 1e-9));
      let tb = 0, tb2 = 0;
      for (let y = 0; y < chh; y += 2) {
        for (let x = 0; x < cw; x += 2) {
          const t = tileEdge[y * cw + x];
          tb += t; tb2 += t * t;
        }
      }
      const mtn = tb / n, stn = Math.sqrt(Math.max(tb2 / n - mtn * mtn, 1e-9));
      const v = (dot / n - mb * mtn) / (sb * stn);
      if (v > cbest[0]) cbest = [v, ox, oy];
    }
  }
  const xCanny = cbest[1] - bx0, cannyConf = cbest[0];
  const agree = Math.abs(xNcc - xCanny) <= 8;
  const x = agree ? Math.round((xNcc + xCanny) / 2) : xNcc;
  return { x, agree, nccConf, cannyConf, xNcc, xCanny };
}

/* ---------------- rotate 求解 ---------------- */

/**
 * 解 rotate 验证码
 * @param {{masterImage:string, thumbImage:string}} info
 * @returns {{angle:number, aStar:number}} angle 为建议提交值；aStar 为矫正角（仅参考）
 */
function solveRotate(info) {
  const master = decodeImage(info.masterImage);
  const thumb = decodeImage(info.thumbImage);
  const mw = master.width, mh = master.height;
  const tw = thumb.width, th = thumb.height;
  const mGray = toGray(master.data, mw, mh, master.channels);
  const tGray = toGray(thumb.data, tw, th, thumb.channels);

  const bx = (mw - tw) >> 1, by = (mh - th) >> 1;
  const boxGray = new Float32Array(tw * th);
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++)
      boxGray[y * tw + x] = mGray[(by + y) * mw + (bx + x)];

  // 采样点：内圆 r<=70%（去边缘白圈）
  const pts = [];
  const rMax = 0.42 * tw * tw; // (0.65*tw/2)^2 近似
  for (let y = 8; y < th - 8; y += 2) {
    for (let x = 8; x < tw - 8; x += 2) {
      const dx = x - tw / 2, dy = y - th / 2;
      if (dx * dx + dy * dy <= 0.42 * (tw / 2) * (tw / 2)) pts.push([x, y]);
    }
  }
  const nearest = (g, w, h, fx, fy) => {
    // 最近邻采样旋转后的像素
    const x = Math.round(fx), y = Math.round(fy);
    if (x < 0 || y < 0 || x >= w || y >= h) return -1;
    return g[y * w + x];
  };

  const score = (angleDeg, srcW, srcH, srcGray) => {
    const rad = -angleDeg * Math.PI / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const cx = tw / 2, cy = th / 2;
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const x = pts[i][0], y = pts[i][1];
      const dx = x - cx, dy = y - cy;
      // 目标图(x,y) ← 源图旋转坐标
      const sx = c * dx - s * dy + cx, sy = s * dx + c * dy + cy;
      const v = nearest(srcGray, srcW, srcH, sx, sy);
      if (v < 0) return Infinity;
      sum += (boxGray[y * tw + x] - v) * (boxGray[y * tw + x] - v);
    }
    return sum;
  };

  // 粗搜步长 2 取 top5，再各自 ±2 细搜（与实测 7/7 的 Python 版一致）
  const coarse = [];
  for (let a = 0; a < 360; a += 2) {
    coarse.push([score(a, tw, th, tGray), a]);
  }
  coarse.sort((p, q) => p[0] - q[0]);
  const cands = new Set();
  for (let i = 0; i < 5 && i < coarse.length; i++) {
    const a0 = coarse[i][1];
    for (let a = a0 - 2; a <= a0 + 2; a++) cands.add((a + 360) % 360);
  }
  let bestA = 0, bestV = Infinity;
  for (const a of cands) {
    const v = score(a, tw, th, tGray);
    if (v < bestV) { bestV = v; bestA = a; }
  }
  return { angle: (360 - bestA) % 360, aStar: bestA };
}

module.exports = { solveSlide, solveRotate };
