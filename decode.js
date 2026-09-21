'use strict';
/**
 * 极简 HTTP 解码器：base64 dataURL → {data, width, height, channels}
 * 支持 JPEG (jpeg-js) 与 PNG (pngjs)，无原生依赖
 */

const { decodeImage: decodeAny } = (() => {
  try { return require('./decode_impl'); } catch (e) { return {}; }
})();

function sniff(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  return null;
}

function decodeImage(dataURL) {
  const b64 = dataURL.includes(',') ? dataURL.split(',')[1] : dataURL;
  const buf = Buffer.from(b64, 'base64');
  const type = sniff(buf);
  if (type === 'jpeg') {
    const jpeg = require('jpeg-js');
    const raw = jpeg.decode(buf, { useTArray: true }); // 默认 RGBA
    return { data: raw.data, width: raw.width, height: raw.height, channels: 4 };
  }
  if (type === 'png') {
    const { PNG } = require('pngjs');
    const png = PNG.sync.read(buf);
    return { data: png.data, width: png.width, height: png.height, channels: 4 };
  }
  throw new Error('unsupported image format');
}

module.exports = { decodeImage };
