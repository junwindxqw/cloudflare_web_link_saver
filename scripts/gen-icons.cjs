// 生成扩展图标（16/32/48/128）：蓝色圆角方块 + 白色书签图形，纯 Node 实现，无第三方依赖
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 点是否在多边形内（射线法）
function inPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const r = size * 0.22; // 圆角半径
  // 对角线渐变：左上 #6ea8ff → 右下 #1d4ed8
  const topLeft = [0x6e, 0xa8, 0xff];
  const bottomRight = [0x1d, 0x4e, 0xd8];
  // 书签多边形（比例坐标）：更舒展的比例 + 更深的缺口
  const poly = [
    [0.3, 0.16],
    [0.7, 0.16],
    [0.7, 0.84],
    [0.5, 0.68],
    [0.3, 0.84],
  ].map(([x, y]) => [x * size, y * size]);

  const SS = 4; // 4x4 超采样抗锯齿
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCov = 0;
      let bmCov = 0;
      let hiCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          // 圆角方块：角外为透明
          const cx = Math.min(Math.max(px, r), size - r);
          const cy = Math.min(Math.max(py, r), size - r);
          if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) {
            bgCov++;
            if (inPolygon(px, py, poly)) bmCov++;
            // 左上角柔光：模拟玻璃高光，增加层次感
            const hx = px - size * 0.28;
            const hy = py - size * 0.22;
            const d = Math.sqrt(hx * hx + hy * hy) / (size * 0.6);
            if (d < 1) hiCov += 0.22 * (1 - d) * (1 - d);
          }
        }
      }
      const total = SS * SS;
      const bgA = bgCov / total;
      const bmA = bmCov / total;
      const hiA = hiCov / total;
      const idx = (y * size + x) * 4;
      // 对角渐变权重：沿 (x+y) 方向
      const t = Math.min(Math.max((x + y) / (2 * Math.max(size - 1, 1)), 0), 1);
      const bg = [0, 1, 2].map((i) => topLeft[i] + (bottomRight[i] - topLeft[i]) * t);
      // 高光叠加到背景（书签区域保持纯白）
      const mixed = [0, 1, 2].map((i) => bg[i] * (1 - hiA) + 255 * hiA);
      for (let i = 0; i < 3; i++) {
        rgba[idx + i] = Math.round(mixed[i] * (1 - bmA) + 255 * bmA);
      }
      rgba[idx + 3] = Math.round(255 * bgA);
    }
  }
  return rgba;
}

const outDir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), encodePng(size, draw(size)));
  console.log(`icon${size}.png done`);
}
