'use strict';
// 样例回归：Node 求解器输出 vs 已实测验证的 Python 参考值
const fs = require('fs');
const { solveSlide, solveRotate } = require('./gocaptcha-solver');

for (let i = 1; i <= 12; i++) {
  try {
    const info = JSON.parse(fs.readFileSync('/tmp/sample_' + i + '.json', 'utf8')).info;
    if (info.CaptchaType === 'slide') {
      const r = solveSlide(info);
      console.log(`sample${i} slide: x=${r.x} agree=${r.agree} (ncc=${r.xNcc}, canny=${r.xCanny})`);
    } else if (info.CaptchaType === 'rotate') {
      const r = solveRotate(info);
      console.log(`sample${i} rotate: angle=${r.angle} (aStar=${r.aStar})`);
    }
  } catch (e) { /* skip */ }
}
