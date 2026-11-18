import * as THREE from 'three';
import type { AABB } from './library';

/**
 * 行走操作，沿用電玩的習慣：
 *   ↑ / ↓（或 W / S）前進、後退
 *   ↑ 或 ↓ 加上 ← / →：邊走邊轉向
 *   只按 ← / →（或 A / D）：橫向平移
 *   滑鼠：轉動視線    Shift：快走
 */
export class Walker {
  pos = new THREE.Vector3(-23.2, 0, 0);
  yaw = -Math.PI / 2; // 面向 +x（大廳方向）
  pitch = 0;
  eye = 1.62;
  enabled = false;
  moving = 0; // 目前的移動速度，給走路晃動用
  private eyeTarget = 1.62;
  private keys = new Set<string>();
  private vel = new THREE.Vector3();
  private bob = 0;
  private dragging = false;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(private camera: THREE.PerspectiveCamera, private dom: HTMLElement, private walkRects: AABB[], private colliders: AABB[]) {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const k = this.norm(e);
      if (k) { this.keys.add(k); e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => { const k = this.norm(e); if (k) this.keys.delete(k); });
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      const locked = document.pointerLockElement === this.dom;
      if (!locked && !this.dragging) return;
      if (Math.abs(e.movementX) > 150 || Math.abs(e.movementY) > 150) return; // 鎖定滑鼠的瞬間有些瀏覽器會送出一筆很大的位移
      const s = locked ? 0.0022 : 0.004;
      this.yaw -= e.movementX * s;
      this.pitch = Math.max(-1.25, Math.min(1.25, this.pitch - e.movementY * s));
    });
    this.dom.addEventListener('mousedown', () => { this.dragging = true; });
    window.addEventListener('mouseup', () => { this.dragging = false; });
  }

  private norm(e: KeyboardEvent): string | null {
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': return 'up';
      case 'ArrowDown': case 'KeyS': return 'down';
      case 'ArrowLeft': case 'KeyA': return 'left';
      case 'ArrowRight': case 'KeyD': return 'right';
      case 'ShiftLeft': case 'ShiftRight': return 'run';
      default: return null;
    }
  }

  clearKeys() { this.keys.clear(); }

  /** 嘗試鎖定滑鼠（桌機瀏覽器才有）；不支援時改用按住拖曳轉視線。 */
  lockPointer() {
    try {
      const p = this.dom.requestPointerLock?.() as unknown;
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {});
    } catch { /* 不支援就算了 */ }
  }

  private blocked(x: number, z: number) {
    const R = 0.34;
    let ok = false;
    for (const r of this.walkRects) if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) { ok = true; break; }
    if (!ok) return true;
    for (const c of this.colliders) if (x > c.x0 - R && x < c.x1 + R && z > c.z0 - R && z < c.z1 + R) return true;
    return false;
  }

  /** 坐下或站起來。 */
  setSeated(seat: THREE.Vector3 | null, yaw?: number) {
    if (seat) {
      this.pos.set(seat.x, 0, seat.z);
      this.eyeTarget = seat.y;
      if (yaw !== undefined) { this.yaw = yaw; this.pitch = -0.28; }
    } else {
      this.eyeTarget = 1.62;
    }
  }

  teleport(x: number, z: number, yaw: number) {
    this.pos.set(x, 0, z);
    this.yaw = yaw;
    this.pitch = 0;
    this.vel.set(0, 0, 0);
  }

  update(dt: number, canMove: boolean) {
    const k = this.keys;
    const fwd = canMove ? (k.has('up') ? 1 : 0) - (k.has('down') ? 1 : 0) : 0;
    const lr = canMove ? (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0) : 0;
    let strafe = 0;
    if (fwd === 0) strafe = lr; // 只按左右：橫向平移
    else this.yaw -= lr * 1.9 * dt; // 同時按上或下：轉向
    const speed = k.has('run') ? 5.2 : 2.7;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const tx = (fx * fwd + rx * strafe) * speed, tz = (fz * fwd + rz * strafe) * speed;
    const ease = 1 - Math.exp(-dt * 10);
    this.vel.x += (tx - this.vel.x) * ease;
    this.vel.z += (tz - this.vel.z) * ease;
    const nx = this.pos.x + this.vel.x * dt, nz = this.pos.z + this.vel.z * dt;
    if (!this.blocked(nx, this.pos.z)) this.pos.x = nx; else this.vel.x = 0;
    if (!this.blocked(this.pos.x, nz)) this.pos.z = nz; else this.vel.z = 0;
    this.moving = Math.hypot(this.vel.x, this.vel.z);

    this.eye += (this.eyeTarget - this.eye) * (1 - Math.exp(-dt * 5));
    if (!this.reducedMotion) this.bob += this.moving * dt * 2.1;
    const bobY = this.reducedMotion ? 0 : Math.sin(this.bob * 2) * 0.022 * Math.min(1, this.moving / 2.7);
    this.camera.position.set(this.pos.x, this.eye + bobY, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
