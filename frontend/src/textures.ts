import * as THREE from 'three';

/** 所有材質貼圖都用程式畫出來，不需要外部圖檔。 */

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!] as const;
}

function toTexture(c: HTMLCanvasElement, rx = 1, ry = 1, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 橡木：直向木紋。hue/sat/light 決定深淺。 */
export function woodTexture(h: number, s: number, l: number, rx = 1, ry = 1, seed = 1) {
  const [c, g] = makeCanvas(512, 512);
  const r = rng(seed);
  g.fillStyle = `hsl(${h} ${s}% ${l}%)`;
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 260; i++) {
    const x0 = r() * 512;
    const dark = r() < 0.7;
    g.strokeStyle = dark ? `hsla(${h - 4} ${s}% ${l * 0.55}% / ${0.06 + r() * 0.16})` : `hsla(${h + 4} ${s}% ${l * 1.5}% / ${0.05 + r() * 0.1})`;
    g.lineWidth = 0.6 + r() * 2.2;
    g.beginPath();
    let x = x0;
    g.moveTo(x, 0);
    const amp = 1 + r() * 5, f = 0.005 + r() * 0.012, ph = r() * 6;
    for (let y = 0; y <= 512; y += 16) {
      x = x0 + Math.sin(y * f + ph) * amp;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  for (let i = 0; i < 3; i++) {
    const x = r() * 512, y = r() * 512;
    const gr = g.createRadialGradient(x, y, 1, x, y, 14 + r() * 10);
    gr.addColorStop(0, `hsla(${h - 6} ${s}% ${l * 0.4}% / .55)`);
    gr.addColorStop(1, `hsla(${h} ${s}% ${l}% / 0)`);
    g.fillStyle = gr;
    g.fillRect(x - 30, y - 30, 60, 60);
  }
  return toTexture(c, rx, ry);
}

/** 地板：寬版橡木地板，沿著 U 方向鋪。一張貼圖約 2 公尺見方。 */
export function floorTexture(rx: number, ry: number) {
  const [c, g] = makeCanvas(1024, 1024);
  const r = rng(7);
  const rows = 8, rh = 1024 / rows;
  for (let i = 0; i < rows; i++) {
    let x = -r() * 400;
    while (x < 1024) {
      const w = 420 + r() * 380;
      const l = 38 + r() * 6, hh = 29 + r() * 4;
      g.fillStyle = `hsl(${hh} 46% ${l}%)`;
      g.fillRect(x, i * rh, w, rh);
      for (let k = 0; k < 34; k++) {
        g.strokeStyle = `hsla(${hh - 4} 50% ${l * (r() < 0.6 ? 0.6 : 1.35)}% / ${0.06 + r() * 0.12})`;
        g.lineWidth = 0.6 + r() * 1.6;
        const y = i * rh + r() * rh;
        g.beginPath();
        g.moveTo(x, y);
        g.bezierCurveTo(x + w * 0.3, y + (r() - 0.5) * 10, x + w * 0.7, y + (r() - 0.5) * 10, x + w, y + (r() - 0.5) * 6);
        g.stroke();
      }
      g.fillStyle = 'rgba(30,18,8,.55)';
      g.fillRect(x + w - 1.5, i * rh, 3, rh);
      x += w;
    }
    g.fillStyle = 'rgba(30,18,8,.6)';
    g.fillRect(0, i * rh - 1.5, 1024, 3);
  }
  return toTexture(c, rx, ry);
}

/** 石材：帶砌縫的石灰岩。 */
export function stoneTexture(rx: number, ry: number, joints = true, light = 62) {
  const [c, g] = makeCanvas(512, 512);
  const r = rng(21);
  g.fillStyle = `hsl(40 16% ${light}%)`;
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `hsla(${34 + r() * 14} 14% ${light - 22 + r() * 40}% / ${0.05 + r() * 0.12})`;
    const s = 1 + r() * 4;
    g.fillRect(r() * 512, r() * 512, s, s);
  }
  for (let i = 0; i < 26; i++) {
    const x = r() * 512, y = r() * 512, rad = 20 + r() * 60;
    const gr = g.createRadialGradient(x, y, 2, x, y, rad);
    gr.addColorStop(0, `hsla(36 18% ${light - 14 + r() * 24}% / .16)`);
    gr.addColorStop(1, 'hsla(36 18% 50% / 0)');
    g.fillStyle = gr;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  if (joints) {
    g.fillStyle = 'rgba(60,50,38,.5)';
    for (let i = 0; i < 4; i++) {
      g.fillRect(0, i * 128 - 1, 512, 2.5);
      const off = (i % 2) * 128;
      for (let x = off; x < 512; x += 256) g.fillRect(x - 1, i * 128, 2.5, 128);
    }
  }
  return toTexture(c, rx, ry);
}

export function plasterTexture(rx: number, ry: number) {
  const [c, g] = makeCanvas(512, 512);
  const r = rng(33);
  g.fillStyle = '#e4d9c2';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 60; i++) {
    const x = r() * 512, y = r() * 512, rad = 30 + r() * 90;
    const gr = g.createRadialGradient(x, y, 2, x, y, rad);
    gr.addColorStop(0, `hsla(${36 + r() * 8} 30% ${70 + r() * 18}% / .22)`);
    gr.addColorStop(1, 'hsla(40 30% 80% / 0)');
    g.fillStyle = gr;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  return toTexture(c, rx, ry);
}

/** 彩繪天花板：一張貼圖是 2×2 塊格板，每塊中央有一本打開的書的紋章。 */
export function ceilingTexture(rx: number, ry: number) {
  const [c, g] = makeCanvas(1024, 1024);
  const grounds = ['#2f4f7c', '#34604a', '#7d2f2a', '#2f4f7c'];
  for (let i = 0; i < 4; i++) {
    const ox = (i % 2) * 512, oy = Math.floor(i / 2) * 512;
    g.fillStyle = '#3a2413';
    g.fillRect(ox, oy, 512, 512);
    g.fillStyle = grounds[(i + Math.floor(i / 2)) % 4];
    g.fillRect(ox + 22, oy + 22, 468, 468);
    g.strokeStyle = '#c9a34a';
    g.lineWidth = 7;
    g.strokeRect(ox + 40, oy + 40, 432, 432);
    g.lineWidth = 2.5;
    g.strokeRect(ox + 56, oy + 56, 400, 400);
    // 四角的金色花飾
    g.fillStyle = '#d4b25a';
    for (const [dx, dy] of [[92, 92], [420, 92], [92, 420], [420, 420]]) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        g.beginPath();
        g.ellipse(ox + dx + Math.cos(a) * 12, oy + dy + Math.sin(a) * 12, 9, 4, a, 0, Math.PI * 2);
        g.fill();
      }
    }
    // 盾形紋章
    g.fillStyle = '#efe6cc';
    g.beginPath();
    g.moveTo(ox + 176, oy + 150);
    g.lineTo(ox + 336, oy + 150);
    g.lineTo(ox + 336, oy + 270);
    g.quadraticCurveTo(ox + 336, oy + 350, ox + 256, oy + 384);
    g.quadraticCurveTo(ox + 176, oy + 350, ox + 176, oy + 270);
    g.closePath();
    g.fill();
    g.strokeStyle = '#8a6a22';
    g.lineWidth = 4;
    g.stroke();
    // 打開的書
    g.fillStyle = '#2b3f66';
    g.fillRect(ox + 204, oy + 206, 104, 70);
    g.fillStyle = '#fbf6e6';
    g.fillRect(ox + 210, oy + 210, 44, 60);
    g.fillRect(ox + 258, oy + 210, 44, 60);
    g.strokeStyle = 'rgba(60,50,30,.7)';
    g.lineWidth = 1.6;
    for (let k = 0; k < 5; k++) {
      g.beginPath();
      g.moveTo(ox + 216, oy + 222 + k * 10);
      g.lineTo(ox + 248, oy + 222 + k * 10);
      g.moveTo(ox + 264, oy + 222 + k * 10);
      g.lineTo(ox + 296, oy + 222 + k * 10);
      g.stroke();
    }
  }
  return toTexture(c, rx, ry);
}

/** 書桌桌面的紫紅色皮面。 */
export function deskTopTexture() {
  const [c, g] = makeCanvas(256, 256);
  const r = rng(5);
  g.fillStyle = '#7b4860';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) {
    g.fillStyle = `hsla(${328 + r() * 10} 28% ${28 + r() * 22}% / .12)`;
    g.fillRect(r() * 256, r() * 256, 1.5, 1.5);
  }
  return toTexture(c, 3, 1);
}

/** 書櫃側板的名牌：大字是專科，小字是訂閱主題。 */
export function signTexture(title: string, sub: string) {
  const [c, g] = makeCanvas(512, 240);
  g.fillStyle = '#b08d3c';
  g.fillRect(0, 0, 512, 240);
  g.fillStyle = '#f3ead2';
  g.fillRect(12, 12, 488, 216);
  g.strokeStyle = '#3a2a16';
  g.lineWidth = 3;
  g.strokeRect(22, 22, 468, 196);
  g.fillStyle = '#2a1c0e';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = '900 86px "Noto Serif TC","Songti TC","PMingLiU",serif';
  g.fillText(title, 256, sub ? 100 : 122, 440);
  if (sub) {
    g.fillStyle = '#6b4a22';
    g.font = '600 40px "Noto Serif TC","Songti TC","PMingLiU",serif';
    g.fillText(sub, 256, 180, 440);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 書背貼圖集：8×8 共 64 款書背。左四欄是皮革燙金的舊書，右四欄是彩色的新書。 */
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 8;
export function bookAtlas() {
  const TW = 96, TH = 384;
  const [c, g] = makeCanvas(TW * ATLAS_COLS, TH * ATLAS_ROWS);
  const r = rng(99);
  const gold = (a = 1) => `hsla(44 62% 58% / ${a})`;
  for (let row = 0; row < ATLAS_ROWS; row++) {
    for (let col = 0; col < ATLAS_COLS; col++) {
      const x = col * TW, y = (ATLAS_ROWS - 1 - row) * TH;
      const strip = 22; // 最下方一條純色：左半是封面色，右半是書頁色
      const bodyH = TH - strip;
      const leather = col < 4;
      let h: number, s: number, l: number;
      if (leather) {
        const k = r();
        if (k < 0.55) { h = 18 + r() * 16; s = 40 + r() * 20; l = 20 + r() * 16; }
        else if (k < 0.72) { h = 4 + r() * 6; s = 50; l = 22 + r() * 8; }
        else if (k < 0.86) { h = 40 + r() * 6; s = 36; l = 52 + r() * 12; }
        else { h = 90 + r() * 50; s = 22; l = 20 + r() * 8; }
      } else {
        const k = r();
        if (k < 0.16) { h = 44; s = 26; l = 80 + r() * 10; }
        else { h = [355, 212, 150, 42, 22, 200, 190, 5, 130, 30, 262][Math.floor(r() * 11)] + r() * 10; s = 38 + r() * 24; l = 24 + r() * 22; }
      }
      const cover = `hsl(${h} ${s}% ${l}%)`;
      g.fillStyle = cover;
      g.fillRect(x, y, TW, TH);
      g.fillStyle = '#e9dfc4';
      g.fillRect(x + TW / 2, y + bodyH, TW / 2, strip);
      // 皮革或布面的細紋
      for (let i = 0; i < 500; i++) {
        g.fillStyle = `hsla(${h} ${s}% ${l + (r() - 0.5) * 22}% / .2)`;
        g.fillRect(x + r() * TW, y + r() * bodyH, 1 + r() * 2, 1 + r() * 3);
      }
      const light = l > 60;
      const ink = light ? `hsla(${h} 40% 18% / .9)` : gold(0.95);
      if (leather) {
        // 竹節（凸起的橫帶）與燙金線
        const bands = 4 + Math.floor(r() * 2);
        for (let b = 1; b <= bands; b++) {
          const by = y + (bodyH * b) / (bands + 1);
          g.fillStyle = `hsla(${h} ${s}% ${l * 0.55}% / .9)`;
          g.fillRect(x, by - 4, TW, 8);
          g.fillStyle = `hsla(${h} ${s}% ${l * 1.5}% / .6)`;
          g.fillRect(x, by - 5, TW, 2);
          g.fillStyle = gold(0.9);
          g.fillRect(x + 4, by - 9, TW - 8, 1.6);
          g.fillRect(x + 4, by + 7, TW - 8, 1.6);
        }
        // 書名標籤
        const ly = y + bodyH / (bands + 1) + 12, lh = bodyH / (bands + 1) - 24;
        g.fillStyle = r() < 0.5 ? 'hsl(4 55% 24%)' : 'hsl(140 30% 16%)';
        g.fillRect(x + 8, ly, TW - 16, lh);
        g.strokeStyle = gold();
        g.lineWidth = 1.5;
        g.strokeRect(x + 11, ly + 3, TW - 22, lh - 6);
        g.fillStyle = gold();
        for (let k = 0; k < 3; k++) g.fillRect(x + 20 + r() * 8, ly + 12 + k * 11, TW - 40 - r() * 16, 3.5);
        // 格間的小花飾
        for (let b = 2; b <= bands; b++) {
          const cy = y + (bodyH * (b + 0.5)) / (bands + 1);
          if (cy > y + bodyH - 20) continue;
          g.strokeStyle = gold(0.8);
          g.lineWidth = 1.4;
          g.beginPath();
          g.arc(x + TW / 2, cy, 7, 0, Math.PI * 2);
          g.moveTo(x + TW / 2 - 12, cy);
          g.lineTo(x + TW / 2 + 12, cy);
          g.moveTo(x + TW / 2, cy - 12);
          g.lineTo(x + TW / 2, cy + 12);
          g.stroke();
        }
      } else {
        const kind = r();
        if (kind < 0.4) {
          // 上方色塊加直排書名
          g.fillStyle = `hsl(${(h + 180) % 360} ${s * 0.6}% ${light ? 30 : 78}%)`;
          g.fillRect(x, y + 26, TW, 60 + r() * 50);
        } else if (kind < 0.7) {
          g.fillStyle = `hsla(0 0% 100% / ${light ? 0 : 0.85})`;
          g.fillRect(x + 12, y + 40, TW - 24, bodyH * 0.5);
        }
        // 直排書名（幾道粗細不一的短線）
        const tx = x + TW / 2 - 14 + r() * 8;
        const tc = kind >= 0.4 && kind < 0.7 && !light ? 'rgba(20,20,30,.85)' : ink;
        g.fillStyle = tc;
        let ty = y + 60 + r() * 30;
        for (let k = 0; k < 9 && ty < y + bodyH * 0.72; k++) {
          const hh = 10 + r() * 22;
          g.fillRect(tx, ty, 10 + r() * 8, hh);
          g.fillRect(tx + 20, ty + r() * 6, 5, hh * (0.5 + r() * 0.5));
          ty += hh + 6;
        }
        // 下方出版社標記
        g.fillStyle = ink;
        g.beginPath();
        g.arc(x + TW / 2, y + bodyH - 34, 9, 0, Math.PI * 2);
        g.fill();
        g.fillRect(x + 14, y + bodyH - 16, TW - 28, 2);
      }
      // 書背的圓弧：兩側壓暗、中間提亮
      const gr = g.createLinearGradient(x, 0, x + TW, 0);
      gr.addColorStop(0, 'rgba(0,0,0,.55)');
      gr.addColorStop(0.22, 'rgba(0,0,0,.06)');
      gr.addColorStop(0.45, 'rgba(255,255,255,.14)');
      gr.addColorStop(0.75, 'rgba(0,0,0,.08)');
      gr.addColorStop(1, 'rgba(0,0,0,.6)');
      g.fillStyle = gr;
      g.fillRect(x, y, TW, bodyH);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  return { texture: t, stripV: 22 / 384 };
}
