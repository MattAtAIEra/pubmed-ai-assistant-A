import * as THREE from 'three';
import { buildBooks, type ShelfFace } from './books';
import { ceilingTexture, deskTopTexture, floorTexture, plasterTexture, signTexture, stoneTexture, woodTexture } from './textures';

/**
 * 圖書館的建築。座標：x 是長廳方向（入口在 -x，大窗在 +x），z 是寬度，y 朝上，單位公尺。
 */
export const HALL = { x0: -18, x1: 18, z0: -7, z1: 7, h: 8 };
export const VEST = { x0: -25, x1: -18.6, z0: -2.5, z1: 2.5, h: 4.6 };

export interface AABB { x0: number; x1: number; z0: number; z1: number }
export interface WindowInfo {
  center: THREE.Vector3; // 開口中心（牆的內側面）
  width: number;
  y0: number;
  y1: number;
  normalOut: THREE.Vector3; // 朝室外的方向
  across: THREE.Vector3; // 沿著寬度的方向
}
export interface CaseInfo { index: number; title: string; sub: string; x: number; side: 1 | -1; aabb: AABB }
export interface Interactable { kind: 'counter' | 'desk' | 'cart'; pos: THREE.Vector3; radius: number; label: string; seat?: THREE.Vector3; seatYaw?: number }

/** 示意資料：每個書櫃的專科與訂閱主題。第二階段會換成使用者真正的訂閱。 */
export const CASES: { title: string; sub: string; side: 1 | -1; x: number; old: number; isNew?: boolean }[] = [
  { title: '神經', sub: '訂閱：偏頭痛', side: -1, x: -8, old: 0.35, isNew: true },
  { title: '免疫過敏', sub: '訂閱：血管性水腫', side: -1, x: -4, old: 0.2 },
  { title: '腸胃', sub: '訂閱：發炎性腸病', side: -1, x: 0, old: 0.3, isNew: true },
  { title: '腫瘤', sub: '訂閱：骨髓瘤', side: -1, x: 4, old: 0.15 },
  { title: '血液', sub: '訂閱：血友病', side: -1, x: 8, old: 0.4 },
  { title: '心臟血管', sub: '推薦主題', side: 1, x: -8, old: 0.7 },
  { title: '內分泌', sub: '推薦主題', side: 1, x: -4, old: 0.75 },
  { title: '感染', sub: '推薦主題', side: 1, x: 0, old: 0.8 },
  { title: '精神', sub: '推薦主題', side: 1, x: 4, old: 0.85 },
  { title: '作者與期刊', sub: '追蹤 2 項', side: 1, x: 8, old: 0.5 },
];

/** 把同一種材質的方塊集中成一個 InstancedMesh，減少繪製次數。 */
class BoxBatch {
  private items = new Map<string, THREE.Matrix4[]>();
  constructor(private mats: Record<string, THREE.Material>) {}
  add(mat: string, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rotY = 0) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(cx, cy, cz),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
      new THREE.Vector3(sx, sy, sz),
    );
    if (!this.items.has(mat)) this.items.set(mat, []);
    this.items.get(mat)!.push(m);
  }
  build(group: THREE.Group) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (const [key, list] of this.items) {
      const mesh = new THREE.InstancedMesh(geo, this.mats[key], list.length);
      list.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  }
}

/** 尖拱開口的輪廓。 */
function archPath(cx: number, w: number, sill: number, spring: number, apex: number) {
  const p = new THREE.Path();
  const hw = w / 2, k = spring + (apex - spring) * 0.72;
  p.moveTo(cx - hw, sill);
  p.lineTo(cx - hw, spring);
  p.quadraticCurveTo(cx - hw, k, cx, apex);
  p.quadraticCurveTo(cx + hw, k, cx + hw, spring);
  p.lineTo(cx + hw, sill);
  p.closePath();
  return p;
}

function wallGeometry(u0: number, u1: number, h: number, holes: THREE.Path[], depth: number) {
  const s = new THREE.Shape();
  s.moveTo(u0, 0);
  s.lineTo(u1, 0);
  s.lineTo(u1, h);
  s.lineTo(u0, h);
  s.closePath();
  s.holes.push(...holes);
  return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 10 });
}

export function buildLibrary() {
  const group = new THREE.Group();
  const colliders: AABB[] = [];
  const windows: WindowInfo[] = [];
  const interactables: Interactable[] = [];
  const lampMaterials: THREE.MeshStandardMaterial[] = [];
  const lampLights: THREE.PointLight[] = [];

  const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial(p);
  const mats: Record<string, THREE.Material> = {
    oak: std({ map: woodTexture(28, 48, 34, 1, 1, 1), roughness: 0.55 }),
    darkOak: std({ map: woodTexture(22, 45, 20, 1, 1, 2), roughness: 0.5 }),
    beam: std({ map: woodTexture(24, 46, 22, 1, 1, 3), roughness: 0.7 }),
    brass: std({ color: 0xb08a3c, roughness: 0.35, metalness: 0.9 }),
    deskTop: std({ map: deskTopTexture(), roughness: 0.75 }),
    stoneBlock: std({ map: stoneTexture(1, 1), roughness: 0.9 }),
    paper: std({ color: 0xf1e8d0, roughness: 0.9 }),
    door: std({ color: 0x1b1612, roughness: 0.6 }),
  };
  const plaster = std({ map: plasterTexture(0.25, 0.25), roughness: 0.95 });
  const stoneWall = std({ map: stoneTexture(0.4, 0.4), roughness: 0.92, color: 0x9a9a9a });
  const batch = new BoxBatch(mats);

  const lampMat = (color: number) => {
    const m = std({ color: 0x222222, emissive: color, emissiveIntensity: 0, roughness: 0.4 });
    lampMaterials.push(m);
    return m;
  };
  const addLampLight = (x: number, y: number, z: number, power: number, dist: number) => {
    const l = new THREE.PointLight(0xffc98a, 0, dist, 1.8);
    l.position.set(x, y, z);
    l.userData.power = power;
    group.add(l);
    lampLights.push(l);
  };

  // ---------- 地板、天花板、屋頂 ----------
  const hallW = HALL.x1 - HALL.x0, hallD = HALL.z1 - HALL.z0;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(hallW, hallD), std({ map: floorTexture(hallW / 2, hallD / 2), roughness: 0.38, metalness: 0.0 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  const ceilTex = ceilingTexture(hallW / 3, hallD / 3);
  const ceilMat = std({ map: ceilTex, roughness: 0.8, emissive: 0xffffff, emissiveMap: ceilTex, emissiveIntensity: 0.2 }); // 微微自發光，代替地板反射上來的光
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(hallW, hallD), ceilMat);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = HALL.h - 0.01;
  group.add(ceil);
  batch.add('beam', 0, HALL.h + 0.2, 0, hallW + 1.4, 0.4, hallD + 1.4); // 屋頂（擋住陽光）
  for (let z = -6; z <= 6.01; z += 1.5) batch.add('beam', 0, HALL.h - 0.1, z, hallW, 0.2, 0.14);
  for (let x = HALL.x0 + 1.5; x < HALL.x1; x += 1.5) batch.add('beam', x, HALL.h - 0.08, 0, 0.12, 0.16, hallD);

  // ---------- 牆與窗 ----------
  const T = 0.6;
  const sideWinX = [-14, -10, -6, -2, 2, 6, 10, 14];
  const sideHoles = () => sideWinX.map((x) => archPath(x, 1.8, 3.9, 5.7, 6.9));
  for (const s of [-1, 1] as const) {
    const wall = new THREE.Mesh(wallGeometry(HALL.x0 - T, HALL.x1 + T, HALL.h, sideHoles(), T), plaster);
    wall.position.z = s < 0 ? HALL.z0 - T : HALL.z1;
    wall.castShadow = wall.receiveShadow = true;
    group.add(wall);
    for (const x of sideWinX) {
      const zc = s * (7 + T / 2);
      batch.add('stoneBlock', x, 5.35, zc, 0.09, 2.9, 0.14); // 中梃
      batch.add('stoneBlock', x, 3.86, s * 7.02, 2.0, 0.1, 0.34); // 窗台
      windows.push({ center: new THREE.Vector3(x, 5.2, s * 7), width: 1.8, y0: 3.9, y1: 6.5, normalOut: new THREE.Vector3(0, 0, s), across: new THREE.Vector3(1, 0, 0) });
    }
    batch.add('darkOak', 0, 0.7, s * 6.96, hallW, 1.4, 0.07); // 護牆板
    batch.add('darkOak', 0, 1.43, s * 6.94, hallW, 0.07, 0.12);
  }
  // 盡頭的牆與大窗
  const GW = { w: 5.4, sill: 1.5, spring: 5.0, apex: 7.5 };
  const endWall = new THREE.Mesh(wallGeometry(HALL.z0, HALL.z1, HALL.h, [archPath(0, GW.w, GW.sill, GW.spring, GW.apex)], T), plaster);
  endWall.rotation.y = Math.PI / 2;
  endWall.position.x = HALL.x1;
  endWall.castShadow = endWall.receiveShadow = true;
  group.add(endWall);
  const gx = HALL.x1 + T / 2;
  for (const z of [-1.35, 0, 1.35]) batch.add('stoneBlock', gx, (GW.sill + 6.1) / 2 + (z === 0 ? 0.25 : 0), z, 0.16, 6.1 - GW.sill + (z === 0 ? 0.5 : 0), 0.12);
  batch.add('stoneBlock', gx, 3.5, 0, 0.16, 0.12, GW.w);
  batch.add('stoneBlock', HALL.x1 + 0.1, GW.sill - 0.06, 0, 0.5, 0.12, GW.w + 0.3);
  const ringMat = mats.stoneBlock;
  for (const [z, y, rr] of [[-1.05, 5.75, 0.52], [1.05, 5.75, 0.52], [0, 6.62, 0.42]]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.07, 8, 28), ringMat);
    ring.rotation.y = Math.PI / 2;
    ring.position.set(gx, y, z);
    ring.castShadow = true;
    group.add(ring);
  }
  windows.push({ center: new THREE.Vector3(HALL.x1, 4.2, 0), width: GW.w, y0: GW.sill, y1: 6.9, normalOut: new THREE.Vector3(1, 0, 0), across: new THREE.Vector3(0, 0, 1) });
  batch.add('darkOak', 17.96, 0.7, 0, 0.07, 1.4, hallD);
  // 入口那面牆與拱門
  const entWall = new THREE.Mesh(wallGeometry(HALL.z0, HALL.z1, HALL.h, [archPath(0, 2.6, 0, 2.6, 3.7)], T), stoneWall);
  entWall.rotation.y = Math.PI / 2;
  entWall.position.x = HALL.x0 - T;
  entWall.castShadow = entWall.receiveShadow = true;
  group.add(entWall);

  // ---------- 木拱架 ----------
  const trussShape = new THREE.Shape();
  trussShape.moveTo(-7, 4.7);
  trussShape.quadraticCurveTo(-6.4, 7.7, 0, 7.8);
  trussShape.quadraticCurveTo(6.4, 7.7, 7, 4.7);
  trussShape.lineTo(6.7, 4.7);
  trussShape.quadraticCurveTo(6.1, 7.35, 0, 7.45);
  trussShape.quadraticCurveTo(-6.1, 7.35, -6.7, 4.7);
  trussShape.closePath();
  const trussGeo = new THREE.ExtrudeGeometry(trussShape, { depth: 0.24, bevelEnabled: false, curveSegments: 16 });
  for (const x of [-16, -12, -8, -4, 0, 4, 8, 12, 16]) {
    const t = new THREE.Mesh(trussGeo, mats.beam);
    t.rotation.y = Math.PI / 2;
    t.position.set(x - 0.12, 0, 0);
    t.castShadow = true;
    group.add(t);
    batch.add('beam', x, 7.72, 0, 0.26, 0.3, hallD);
    for (const s of [-1, 1]) batch.add('stoneBlock', x, 4.55, s * 6.85, 0.4, 0.3, 0.3); // 托座
  }

  // ---------- 書櫃 ----------
  const shelfY = [0.17, 0.57, 0.97, 1.37, 1.77, 2.17, 2.57];
  const faces: ShelfFace[] = [];
  const cases: CaseInfo[] = [];
  CASES.forEach((c, index) => {
    const s = c.side, cx = c.x, zc = s * 4.7, zA = s * 2.4;
    batch.add('darkOak', cx, 0.075, zc, 0.94, 0.15, 4.6);
    batch.add('darkOak', cx, 1.6, zc, 0.05, 2.9, 4.5);
    batch.add('oak', cx, 1.55, s * 2.44, 0.98, 3.1, 0.08);
    for (const dx of [-0.46, 0.46]) batch.add('darkOak', cx + dx, 1.55, s * 2.42, 0.09, 3.1, 0.12);
    batch.add('darkOak', cx, 3.08, zc, 1.08, 0.14, 4.72);
    batch.add('oak', cx, 3.18, zc, 1.18, 0.06, 4.8);
    for (const y of shelfY) batch.add('oak', cx, y - 0.015, zc + s * 0.03, 0.86, 0.03, 4.5);
    const dividers = [1, 2, 3].map((k) => s * (2.48 + 1.13 * k));
    for (const zd of dividers) batch.add('oak', cx, 1.55, zd, 0.86, 2.9, 0.035);
    for (const nx of [1, -1] as const) {
      faces.push({ caseIndex: index, cx, nx, z0: Math.min(s * 2.5, s * 6.95), z1: Math.max(s * 2.5, s * 6.95), dividers, shelfY, oldRatio: c.old });
    }
    // 名牌
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.33), std({ map: signTexture(c.title, c.sub), roughness: 0.5 }));
    plate.position.set(cx, 2.0, zA - s * 0.005);
    plate.rotation.y = s > 0 ? Math.PI : 0;
    group.add(plate);
    const aabb = { x0: cx - 0.52, x1: cx + 0.52, z0: Math.min(zA, s * 7), z1: Math.max(zA, s * 7) };
    colliders.push(aabb);
    cases.push({ index, title: c.title, sub: c.sub, x: cx, side: s, aabb });
  });
  const books = buildBooks(faces, CASES.map((c, i) => (c.isNew ? i : -1)).filter((i) => i >= 0));
  group.add(books.mesh, books.glow);

  // ---------- 訂閱櫃檯與新書推車 ----------
  batch.add('oak', -13.7, 0.52, 3.65, 3.0, 1.04, 1.2);
  batch.add('darkOak', -13.7, 1.07, 3.65, 3.16, 0.06, 1.36);
  batch.add('darkOak', -13.7, 0.06, 3.0, 3.04, 0.12, 0.06);
  const cSign = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.5), std({ map: signTexture('訂閱櫃檯', ''), roughness: 0.5 }));
  cSign.position.set(-13.7, 0.6, 3.04);
  cSign.rotation.y = Math.PI;
  group.add(cSign);
  colliders.push({ x0: -15.3, x1: -12.1, z0: 2.95, z1: 4.35 });
  interactables.push({ kind: 'counter', pos: new THREE.Vector3(-13.7, 1, 2.6), radius: 1.9, label: '向館員辦理訂閱' });
  // 櫃檯上的綠罩檯燈
  batch.add('brass', -12.9, 1.25, 3.65, 0.03, 0.3, 0.03);
  batch.add('brass', -12.9, 1.11, 3.65, 0.16, 0.02, 0.12);
  const shade = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.07, 0.14), lampMat(0x7fe0a0));
  shade.position.set(-12.9, 1.42, 3.65);
  group.add(shade);
  addLampLight(-12.9, 1.5, 3.4, 9, 7);
  batch.add('paper', -14.1, 1.115, 3.5, 0.42, 0.03, 0.3, 0.2);
  // 推車
  const cartX = -11.0, cartZ = 4.9;
  for (const y of [0.25, 0.62]) batch.add('oak', cartX, y, cartZ, 0.95, 0.03, 0.45);
  for (const dx of [-0.47, 0.47]) batch.add('darkOak', cartX + dx, 0.5, cartZ, 0.03, 0.85, 0.45);
  const newBookMat = std({ color: 0xc8a050, emissive: 0xffb040, emissiveIntensity: 0.9, roughness: 0.5 });
  (mats as Record<string, THREE.Material>).newBook = newBookMat;
  for (let i = 0; i < 9; i++) batch.add('newBook', cartX - 0.36 + i * 0.065, 0.76, cartZ, 0.05, 0.24 + (i % 3) * 0.02, 0.2);
  colliders.push({ x0: cartX - 0.55, x1: cartX + 0.55, z0: cartZ - 0.3, z1: cartZ + 0.3 });
  interactables.push({ kind: 'cart', pos: new THREE.Vector3(cartX, 1, cartZ - 0.5), radius: 1.3, label: '看看新到館的文獻' });

  // ---------- 閱覽書桌 ----------
  for (const s of [-1, 1] as const) {
    const dx = 13.5, dz = s * 4.3;
    batch.add('oak', dx, 0.75, dz, 5.0, 0.06, 1.9);
    for (const o of [-0.52, 0.52]) batch.add('deskTop', dx, 0.786, dz + o, 4.6, 0.012, 0.74);
    batch.add('darkOak', dx, 0.9, dz, 4.6, 0.24, 0.14);
    batch.add('brass', dx, 1.06, dz, 4.6, 0.02, 0.02);
    for (const ex of [-2.4, 2.4]) batch.add('oak', dx + ex, 0.36, dz, 0.08, 0.72, 1.7);
    batch.add('darkOak', dx, 0.3, dz, 4.7, 0.5, 0.05);
    // 桌上的書與筆記
    batch.add('paper', dx - 0.9, 0.8, dz - s * 0.55, 0.42, 0.015, 0.3, 0.12);
    batch.add('paper', dx - 0.45, 0.8, dz - s * 0.55, 0.42, 0.015, 0.3, 0.12);
    batch.add('darkOak', dx + 1.2, 0.83, dz - s * 0.5, 0.3, 0.07, 0.22, -0.3);
    // 檯燈
    for (const lx of [-1.3, 1.3]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.03, 0.05), lampMat(0xffd9a0));
      bar.position.set(dx + lx, 1.22, dz);
      group.add(bar);
      batch.add('brass', dx + lx, 1.12, dz, 0.03, 0.2, 0.03);
    }
    addLampLight(dx, 1.7, dz, 6, 8);
    // 椅子
    for (const side of [-1, 1]) {
      for (const cxo of [-1.5, 0, 1.5]) {
        const x = dx + cxo, z = dz + side * 1.3;
        batch.add('oak', x, 0.46, z, 0.46, 0.05, 0.46);
        batch.add('oak', x, 0.78, z + side * 0.22, 0.46, 0.5, 0.04);
        for (const lx of [-0.2, 0.2]) for (const lz of [-0.2, 0.2]) batch.add('darkOak', x + lx, 0.22, z + lz, 0.04, 0.44, 0.04);
      }
    }
    colliders.push({ x0: dx - 2.6, x1: dx + 2.6, z0: dz - 1.6, z1: dz + 1.6 });
    // 坐下的位置：靠走道那一側中間的椅子
    interactables.push({
      kind: 'desk', pos: new THREE.Vector3(dx, 1, dz - s * 1.9), radius: 2.2, label: '坐下來，開始多輪問答',
      seat: new THREE.Vector3(dx, 1.16, dz - s * 1.15), seatYaw: s > 0 ? Math.PI : 0,
    });
  }

  // ---------- 走道上方的環形吊燈 ----------
  const ringLamp = lampMat(0xffd49a);
  for (const x of [-12, -4, 4, 12]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.028, 8, 48), ringLamp);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, 5.1, 0);
    group.add(ring);
    for (const a of [0, 2.094, 4.188]) batch.add('brass', x + Math.cos(a) * 0.95, 6.4, Math.sin(a) * 0.95, 0.008, 2.6, 0.008);
    addLampLight(x, 4.9, 0, 26, 14);
  }

  // ---------- 玄關 ----------
  const vw = VEST.x1 - VEST.x0, vd = VEST.z1 - VEST.z0, vcx = (VEST.x0 + VEST.x1) / 2;
  const vfloor = new THREE.Mesh(new THREE.PlaneGeometry(vw + 0.6, vd), std({ map: stoneTexture(3, 2, true, 50), roughness: 0.8, color: 0x666666 }));
  vfloor.rotation.x = -Math.PI / 2;
  vfloor.position.set(vcx - 0.3 + 0.6, 0.001, 0);
  vfloor.receiveShadow = true;
  group.add(vfloor);
  const vWallMat = std({ map: stoneTexture(3, 2), roughness: 0.92, color: 0x4c4c4c }); // 玄關刻意壓暗
  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(vw + 0.6, VEST.h, 0.5), vWallMat);
    w.position.set(vcx, VEST.h / 2, s * (VEST.z1 + 0.25));
    w.castShadow = w.receiveShadow = true;
    group.add(w);
  }
  const vEnd = new THREE.Mesh(new THREE.BoxGeometry(0.5, VEST.h, vd + 1), vWallMat);
  vEnd.position.set(VEST.x0 - 0.25, VEST.h / 2, 0);
  vEnd.castShadow = true;
  group.add(vEnd);
  const vRoof = new THREE.Mesh(new THREE.BoxGeometry(vw + 1.2, 0.4, vd + 1), vWallMat);
  vRoof.position.set(vcx, VEST.h + 0.2, 0);
  vRoof.castShadow = true;
  group.add(vRoof);
  batch.add('door', VEST.x0 + 0.06, 1.6, 0, 0.12, 3.2, 2.2); // 身後的大門
  batch.add('darkOak', vcx, 1.5, VEST.z0 + 0.04, vw - 1, 3.0, 0.06); // 一側的橡木壁板
  // 圓形天窗
  const oculusMat = new THREE.MeshBasicMaterial({ color: 0x88bbff });
  const oculus = new THREE.Mesh(new THREE.CircleGeometry(0.75, 40), oculusMat);
  oculus.rotation.x = Math.PI / 2;
  oculus.position.set(-21.6, VEST.h - 0.005, 0);
  group.add(oculus);
  const oculusLight = new THREE.SpotLight(0xbfd8ff, 0, 9, 0.5, 0.8, 1.2);
  oculusLight.position.set(-21.6, VEST.h - 0.1, 0);
  oculusLight.target.position.set(-21.6, 0, 0);
  group.add(oculusLight, oculusLight.target);

  batch.build(group);

  /** 可以走的範圍（已經扣掉人的半徑）。 */
  const walkRects: AABB[] = [
    { x0: HALL.x0 + 0.4, x1: HALL.x1 - 0.5, z0: HALL.z0 + 0.45, z1: HALL.z1 - 0.45 },
    { x0: -19.4, x1: HALL.x0 + 0.6, z0: -0.9, z1: 0.9 },
    { x0: VEST.x0 + 0.5, x1: -19.0, z0: VEST.z0 + 0.4, z1: VEST.z1 - 0.4 },
  ];

  return { group, colliders, walkRects, windows, interactables, cases, books, ceilMat, lampMaterials, lampLights, oculusMat, oculusLight, newBookMat };
}
