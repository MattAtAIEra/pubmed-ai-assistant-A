import * as THREE from 'three';
import { ATLAS_COLS, ATLAS_ROWS, bookAtlas, rng } from './textures';

/** 一個書櫃的一面：books 沿著 z 方向排，書背朝 nx（+1 或 -1）方向。 */
export interface ShelfFace {
  caseIndex: number;
  cx: number; // 書櫃中心 x
  nx: 1 | -1; // 書背朝向
  z0: number; // 沿牆方向的起點與終點（z0 < z1）
  z1: number;
  dividers: number[]; // 直立隔板的 z 位置
  shelfY: number[]; // 每層層板上緣的高度
  oldRatio: number; // 這一面舊書（皮革裝幀）的比例
}

export interface BookRecord {
  caseIndex: number;
  isNew: boolean;
  matrix: THREE.Matrix4;
  size: THREE.Vector3;
}

/** 書本的單位方塊：x 是厚度、y 是高度、z 是深度，書背在 +z 面。 */
function bookGeometry(stripV: number) {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  // BoxGeometry 六個面的順序：+x, -x, +y, -y, +z, -z，每面四個頂點
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      if (f === 4) {
        // 書背：使用整張書背圖（扣掉最下方那條純色）
        uv.setXY(i, uv.getX(i), stripV + uv.getY(i) * (1 - stripV));
      } else if (f === 0 || f === 1) {
        uv.setXY(i, 0.25, stripV * 0.5); // 封面與封底：封面色
      } else {
        uv.setXY(i, 0.75, stripV * 0.5); // 上下與書口：書頁色
      }
    }
  }
  uv.needsUpdate = true;
  return geo;
}

function atlasMaterial(map: THREE.Texture, opts: THREE.MeshStandardMaterialParameters = {}) {
  const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.6, metalness: 0.0, ...opts });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aTile;')
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
#ifdef USE_MAP
  vMapUv = (vMapUv + aTile) * vec2(${(1 / ATLAS_COLS).toFixed(6)}, ${(1 / ATLAS_ROWS).toFixed(6)});
#endif`,
      );
  };
  return mat;
}

export function buildBooks(faces: ShelfFace[], newOnCases: number[]) {
  const { texture, stripV } = bookAtlas();
  const r = rng(2024);
  const records: BookRecord[] = [];
  const glowRecords: BookRecord[] = [];
  const tiles: number[] = [];
  const glowTiles: number[] = [];
  const tints: number[] = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qLean = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0), zAxis = new THREE.Vector3(0, 0, 1);
  const glowDone = new Set<number>();

  for (const face of faces) {
    const stops = [face.z0, ...face.dividers, face.z1].sort((a, b) => a - b);
    for (let level = 0; level < face.shelfY.length; level++) {
      const y0 = face.shelfY[level];
      const gap = (face.shelfY[level + 1] ?? y0 + 0.4) - y0 - 0.035;
      for (let sgi = 0; sgi < stops.length - 1; sgi++) {
        let z = stops[sgi] + 0.035;
        const zEnd = stops[sgi + 1] - 0.035;
        // 這一段要不要放「新到館」的發光書：只挑視線高度、指定的書櫃、每個書櫃一處
        const wantGlow = newOnCases.includes(face.caseIndex) && !glowDone.has(face.caseIndex) && level === 3 && sgi === 1 && face.nx === 1;
        let glowLeft = wantGlow ? 4 : 0;
        let run = 0; // 同一套書連續幾本
        let runTile = [0, 0], runH = 0.25, runT = 0.03;
        while (z < zEnd) {
          const old = r() < face.oldRatio;
          if (run <= 0) {
            runTile = [old ? Math.floor(r() * 4) : 4 + Math.floor(r() * 4), Math.floor(r() * ATLAS_ROWS)];
            runH = Math.min(gap, old ? 0.24 + r() * 0.1 : 0.2 + r() * 0.12);
            runT = old ? 0.035 + r() * 0.035 : 0.018 + r() * 0.03;
            run = r() < 0.25 ? 2 + Math.floor(r() * 5) : 1;
          }
          run--;
          const t = runT * (0.92 + r() * 0.16);
          const h = runH * (0.985 + r() * 0.03);
          const d = 0.19 + r() * 0.06;
          if (z + t > zEnd) break;
          // 偶爾留一點空隙，旁邊那本斜靠
          let lean = 0;
          if (r() < 0.025 && z + t + 0.06 < zEnd) {
            lean = (r() < 0.5 ? 1 : -1) * (0.08 + r() * 0.08);
            z += 0.035;
          }
          const spineX = face.cx + face.nx * (0.4 - r() * 0.035);
          const pos = new THREE.Vector3(spineX - face.nx * d * 0.5, y0 + h / 2 + Math.abs(lean) * 0.01, z + t / 2);
          q.setFromAxisAngle(yAxis, face.nx * Math.PI * 0.5);
          if (lean) q.multiply(qLean.setFromAxisAngle(zAxis, lean));
          const size = new THREE.Vector3(t, h, d);
          m.compose(pos, q, size);
          const rec: BookRecord = { caseIndex: face.caseIndex, isNew: false, matrix: m.clone(), size };
          const midSeg = z > (stops[sgi] + zEnd) / 2 - 0.2;
          if (glowLeft > 0 && midSeg) {
            rec.isNew = true;
            glowRecords.push(rec);
            glowTiles.push(4 + Math.floor(r() * 4), runTile[1]);
            glowLeft--;
            if (glowLeft === 0) glowDone.add(face.caseIndex);
            run = 0;
          } else {
            records.push(rec);
            tiles.push(runTile[0], runTile[1]);
            const b = 0.82 + r() * 0.3;
            tints.push(b, b, b);
          }
          z += t + 0.0015 + (lean ? 0.03 : 0);
        }
      }
    }
  }

  const geo = bookGeometry(stripV);
  geo.setAttribute('aTile', new THREE.InstancedBufferAttribute(new Float32Array(tiles), 2));
  const mesh = new THREE.InstancedMesh(geo, atlasMaterial(texture), records.length);
  records.forEach((b, i) => mesh.setMatrixAt(i, b.matrix));
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(tints), 3);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();

  const glowGeo = bookGeometry(stripV);
  glowGeo.setAttribute('aTile', new THREE.InstancedBufferAttribute(new Float32Array(glowTiles), 2));
  const glowMat = atlasMaterial(texture, { emissive: new THREE.Color(1.0, 0.72, 0.25), emissiveIntensity: 1.2 });
  const glow = new THREE.InstancedMesh(glowGeo, glowMat, Math.max(1, glowRecords.length));
  glow.count = glowRecords.length;
  glowRecords.forEach((b, i) => glow.setMatrixAt(i, b.matrix));
  glow.instanceMatrix.needsUpdate = true;
  glow.computeBoundingSphere();

  return { mesh, glow, glowMat, records, glowRecords };
}
