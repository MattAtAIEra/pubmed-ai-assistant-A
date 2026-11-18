import * as THREE from 'three';
import type { WindowInfo } from './library';

/** 陽光、天空、天氣：依瀏覽者當地的時間、緯度與天氣算出來。 */

export type Weather = 'clear' | 'partly' | 'overcast' | 'rain' | 'snow' | 'fog';
export const WEATHER_LABEL: Record<Weather, string> = { clear: '晴', partly: '多雲', overcast: '陰', rain: '雨', snow: '雪', fog: '霧' };

const RAD = Math.PI / 180;

/** 太陽的方位角（從正北順時針）與高度角，單位弧度。 */
export function solarPosition(date: Date, latDeg: number, lonDeg: number) {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
  const L = (280.46 + 0.9856474 * d) % 360;
  const g = ((357.528 + 0.9856003 * d) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * d) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + lonDeg) * RAD - ra;
  const lat = latDeg * RAD;
  const el = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha));
  return { az, el };
}

/** 由時區推估城市等級的位置；查不到就用時差換算經度。 */
const TZ: Record<string, [number, number]> = {
  'Asia/Taipei': [25.03, 121.56], 'Asia/Tokyo': [35.68, 139.69], 'Asia/Seoul': [37.57, 126.98], 'Asia/Shanghai': [31.23, 121.47],
  'Asia/Hong_Kong': [22.32, 114.17], 'Asia/Singapore': [1.35, 103.82], 'Asia/Bangkok': [13.76, 100.5], 'Asia/Kolkata': [28.61, 77.21],
  'Asia/Dubai': [25.2, 55.27], 'Europe/London': [51.75, -1.26], 'Europe/Paris': [48.86, 2.35], 'Europe/Berlin': [52.52, 13.4],
  'Europe/Madrid': [40.42, -3.7], 'Europe/Rome': [41.9, 12.5], 'Europe/Zurich': [47.37, 8.54], 'America/New_York': [40.71, -74.01],
  'America/Chicago': [41.88, -87.63], 'America/Denver': [39.74, -104.99], 'America/Los_Angeles': [34.05, -118.24],
  'America/Toronto': [43.65, -79.38], 'America/Sao_Paulo': [-23.55, -46.63], 'Australia/Sydney': [-33.87, 151.21],
  'Australia/Melbourne': [-37.81, 144.96], 'Pacific/Auckland': [-36.85, 174.76], 'Africa/Johannesburg': [-26.2, 28.05],
};
export function guessLocation(): { lat: number; lon: number; name: string } {
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* 忽略 */ }
  if (TZ[tz]) return { lat: TZ[tz][0], lon: TZ[tz][1], name: tz.split('/')[1].replace('_', ' ') };
  const lon = (-new Date().getTimezoneOffset() / 60) * 15;
  return { lat: 30, lon, name: tz || '依時差推估' };
}

/** 向公開氣象服務查目前天氣。只送出四捨五入到小數一位的座標。失敗就回傳 null。 */
export async function fetchWeather(lat: number, lon: number): Promise<Weather | null> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(1)}&longitude=${lon.toFixed(1)}&current=weather_code,cloud_cover`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const j = await res.json();
    const code: number = j.current?.weather_code ?? 0;
    const cloud: number = j.current?.cloud_cover ?? 0;
    if (code === 45 || code === 48) return 'fog';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return 'rain';
    if (code === 3 || cloud > 80) return 'overcast';
    if (code === 2 || cloud > 35) return 'partly';
    return 'clear';
  } catch {
    return null;
  }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix3 = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

export interface LightState {
  dir: THREE.Vector3; // 指向光源的方向
  isSun: boolean;
  color: THREE.Color;
  intensity: number;
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  skyGain: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  shaft: number; // 光束的強度
  lamp: number; // 室內燈的亮度 0..1
  fog: number;
  fogColor: THREE.Color;
  exposure: number;
  dayness: number;
  elevationDeg: number;
}

const CLOUD: Record<Weather, number> = { clear: 0, partly: 0.35, overcast: 0.88, rain: 0.92, snow: 0.8, fog: 0.75 };

/** 由日期時間、位置、天氣算出整套光線參數。 */
export function computeLight(date: Date, lat: number, lon: number, weather: Weather): LightState {
  const { az, el } = solarPosition(date, lat, lon);
  const elDeg = el / RAD;
  const dayness = smooth(-7, 5, elDeg);
  const cloud = CLOUD[weather];

  // 建築的座向：大窗朝向赤道那一側，所以正午的陽光會順著走道照進來
  const north = lat >= 0 ? new THREE.Vector3(-1, 0, 0) : new THREE.Vector3(1, 0, 0);
  const east = lat >= 0 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 0, 1);
  // 太陽太高時光照不進窗戶，所以畫面上把高度限制在 12 到 34 度之間
  const showEl = Math.min(34, Math.max(12, Math.abs(elDeg))) * RAD;
  const isSun = dayness > 0.35;
  const azUse = isSun ? az : az + Math.PI; // 月亮放在太陽的對面
  const dir = new THREE.Vector3()
    .addScaledVector(north, Math.cos(azUse) * Math.cos(showEl))
    .addScaledVector(east, Math.sin(azUse) * Math.cos(showEl))
    .add(new THREE.Vector3(0, Math.sin(isSun ? showEl : Math.max(showEl, 30 * RAD)), 0))
    .normalize();

  // 太陽顏色：越低越暖
  const warm = smooth(0, 35, elDeg);
  let sunCol = mix3([1.0, 0.5, 0.24], [1.0, 0.8, 0.56], smooth(0, 0.35, warm));
  sunCol = mix3(sunCol, [1.0, 0.95, 0.86], smooth(0.3, 1, warm));
  sunCol = mix3(sunCol, [0.86, 0.9, 0.96], cloud * 0.8);
  const sunI = 9.5 * smooth(-1, 12, elDeg) * (1 - cloud * 0.93);
  const moonI = 0.5 * (1 - smooth(-12, -4, elDeg)) * (1 - cloud * 0.8);

  // 天空
  const dayTop = [0.2, 0.42, 0.9], dayHor = [0.72, 0.85, 1.0];
  const duskTop = [0.2, 0.22, 0.45], duskHor = [1.0, 0.5, 0.24];
  const nightTop = [0.006, 0.01, 0.03], nightHor = [0.02, 0.03, 0.07];
  const dusk = smooth(-8, 2, elDeg) * (1 - smooth(4, 18, elDeg));
  let top = mix3(nightTop, dayTop, dayness), hor = mix3(nightHor, dayHor, dayness);
  top = mix3(top, duskTop, dusk * 0.8);
  hor = mix3(hor, duskHor, dusk);
  const grey = weather === 'rain' ? [0.42, 0.46, 0.52] : weather === 'snow' ? [0.8, 0.82, 0.86] : [0.66, 0.69, 0.73];
  const greyNow = grey.map((v) => v * (0.04 + 0.96 * dayness));
  top = mix3(top, greyNow, cloud);
  hor = mix3(hor, greyNow.map((v) => v * 1.08), cloud);

  const hemiI = (0.1 + 0.62 * dayness) * (1 - cloud * 0.25) * (weather === 'rain' ? 0.75 : 1);
  const lamp = Math.min(1, 1 - dayness + (weather === 'rain' ? 0.7 : weather === 'overcast' || weather === 'fog' ? 0.4 : 0));

  return {
    dir,
    isSun,
    color: isSun ? new THREE.Color(sunCol[0], sunCol[1], sunCol[2]) : new THREE.Color(0.55, 0.66, 1.0),
    intensity: isSun ? sunI : moonI,
    skyTop: new THREE.Color(top[0], top[1], top[2]),
    skyHorizon: new THREE.Color(hor[0], hor[1], hor[2]),
    skyGain: 0.5 + 1.3 * dayness,
    hemiSky: new THREE.Color(hor[0], hor[1], hor[2]).lerp(new THREE.Color(1, 0.92, 0.78), 0.6),
    hemiGround: new THREE.Color(0.85, 0.66, 0.44),
    hemiIntensity: hemiI,
    shaft: (isSun ? smooth(1, 14, elDeg) : 0.12 * (1 - dayness)) * (1 - cloud) * (weather === 'fog' ? 0.6 : 1),
    lamp,
    fog: weather === 'fog' ? 0.028 : weather === 'rain' ? 0.01 : 0.0035,
    fogColor: new THREE.Color(hor[0], hor[1], hor[2]).lerp(new THREE.Color(1, 0.88, 0.7), 0.5).multiplyScalar(0.1 + 0.45 * dayness),
    exposure: 0.95 + 0.4 * (1 - dayness),
    dayness,
    elevationDeg: elDeg,
  };
}

/** 天空球。 */
export function makeSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTop: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uGain: { value: 1 }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() }, uSunAmt: { value: 0 } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uTop; uniform vec3 uHor; uniform float uGain; uniform vec3 uSun; uniform vec3 uSunCol; uniform float uSunAmt; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -0.2, 1.0);
        vec3 c = mix(uHor, uTop, pow(max(h,0.0), 0.55));
        c = mix(c, uHor * vec3(0.5,0.56,0.5), smoothstep(0.0, -0.12, d.y));
        float s = max(dot(d, normalize(uSun)), 0.0);
        c += uSunCol * uSunAmt * (pow(s, 600.0) * 30.0 + pow(s, 24.0) * 0.35);
        gl_FragColor = vec4(c * uGain, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(300, 32, 16), mat);
  mesh.frustumCulled = false;
  return { mesh, mat };
}

/** 窗戶射進來的光束與光束裡的微塵。 */
export class Shafts {
  group = new THREE.Group();
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private dustMat: THREE.ShaderMaterial;
  private dust: THREE.Points;
  private readonly SL = 7; // 每扇窗、每個方向的切片數
  private readonly DUST = 70; // 每扇窗的微塵數
  private seeds: Float32Array;

  constructor(private windows: WindowInfo[]) {
    const quads = windows.length * this.SL * 2;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(quads * 4 * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(quads * 4 * 2), 2));
    geo.setAttribute('aVis', new THREE.BufferAttribute(new Float32Array(quads * 4), 1));
    const idx: number[] = [];
    for (let q = 0; q < quads; q++) idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
    geo.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uColor: { value: new THREE.Color(1, 0.9, 0.7) }, uOpacity: { value: 0 }, uTime: { value: 0 } },
      vertexShader: `attribute float aVis; varying vec2 vUv; varying float vVis; varying vec3 vW;
        void main(){ vUv = uv; vVis = aVis; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform vec3 uColor; uniform float uOpacity; uniform float uTime; varying vec2 vUv; varying float vVis; varying vec3 vW;
        void main(){
          float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
          float along = pow(1.0 - vUv.y, 1.25) * smoothstep(0.0, 0.04, vUv.y);
          float n = 0.8 + 0.2 * sin(vW.x * 2.3 + vW.y * 3.1 + vW.z * 1.7 + uTime * 0.25);
          float a = uOpacity * vVis * edge * along * n;
          gl_FragColor = vec4(uColor * a, a);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.group.add(this.mesh);

    const n = windows.length * this.DUST;
    const dgeo = new THREE.BufferGeometry();
    dgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.seeds = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i++) this.seeds[i] = Math.random();
    dgeo.setAttribute('aSeed', new THREE.BufferAttribute(this.seeds, 4));
    dgeo.setAttribute('aVis', new THREE.BufferAttribute(new Float32Array(n), 1));
    this.dustMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uColor: { value: new THREE.Color(1, 0.92, 0.75) }, uOpacity: { value: 0 }, uTime: { value: 0 }, uScale: { value: 600 } },
      vertexShader: `attribute vec4 aSeed; attribute float aVis; uniform float uTime; uniform float uScale; varying float vA;
        void main(){
          vec3 p = position;
          float t = uTime * (0.05 + aSeed.x * 0.06);
          p += vec3(sin(t * 2.0 + aSeed.y * 6.28), sin(t * 1.3 + aSeed.z * 6.28) * 0.6, cos(t * 1.7 + aSeed.w * 6.28)) * 0.25;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (0.008 + aSeed.w * 0.013) * uScale / max(0.3, -mv.z);
          vA = aVis * (0.35 + 0.65 * abs(sin(t * 6.0 + aSeed.x * 20.0)));
        }`,
      fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying float vA;
        void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.1, d) * vA * uOpacity; gl_FragColor = vec4(uColor * a, a); }`,
    });
    this.dust = new THREE.Points(dgeo, this.dustMat);
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 6;
    this.group.add(this.dust);
  }

  /** 光源方向或強度改變時重建光束。 */
  update(dir: THREE.Vector3, color: THREE.Color, strength: number, viewportH: number) {
    const pos = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const uv = this.mesh.geometry.attributes.uv as THREE.BufferAttribute;
    const vis = this.mesh.geometry.attributes.aVis as THREE.BufferAttribute;
    const dpos = this.dust.geometry.attributes.position as THREE.BufferAttribute;
    const dvis = this.dust.geometry.attributes.aVis as THREE.BufferAttribute;
    const travel = dir.clone().negate(); // 光前進的方向
    const up = new THREE.Vector3(0, 1, 0);
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    let q = 0;
    this.windows.forEach((w, wi) => {
      const facing = dir.dot(w.normalOut); // 光源在這扇窗的室外那一側才照得進來
      const v = Math.max(0, Math.min(1, (facing - 0.08) * 4));
      // 光束走到地板為止，最長 24 公尺
      const len = Math.min(24, travel.y < -0.02 ? w.y1 / -travel.y : 24);
      const put = (i: number, p: THREE.Vector3, u: number, vv: number) => { pos.setXYZ(i, p.x, p.y, p.z); uv.setXY(i, u, vv); vis.setX(i, v); };
      for (let k = 0; k < this.SL; k++) {
        const f = (k + 0.5) / this.SL;
        // 直向切片：沿寬度分布
        a.copy(w.center).addScaledVector(w.across, (f - 0.5) * w.width).setY(w.y0);
        b.copy(a).setY(w.y1);
        put(q * 4, a, 0, 0); put(q * 4 + 1, b, 1, 0);
        put(q * 4 + 2, b.clone().addScaledVector(travel, len), 1, 1); put(q * 4 + 3, a.clone().addScaledVector(travel, len), 0, 1);
        q++;
        // 橫向切片：沿高度分布
        const y = w.y0 + (w.y1 - w.y0) * f;
        a.copy(w.center).addScaledVector(w.across, -0.5 * w.width).setY(y);
        b.copy(w.center).addScaledVector(w.across, 0.5 * w.width).setY(y);
        put(q * 4, a, 0, 0); put(q * 4 + 1, b, 1, 0);
        put(q * 4 + 2, b.clone().addScaledVector(travel, len), 1, 1); put(q * 4 + 3, a.clone().addScaledVector(travel, len), 0, 1);
        q++;
      }
      for (let k = 0; k < this.DUST; k++) {
        const i = wi * this.DUST + k;
        const s0 = this.seeds[i * 4], s1 = this.seeds[i * 4 + 1], s2 = this.seeds[i * 4 + 2];
        a.copy(w.center).addScaledVector(w.across, (s0 - 0.5) * w.width).setY(w.y0 + (w.y1 - w.y0) * s1).addScaledVector(travel, s2 * len * 0.92);
        if (a.y < 0.1) a.y = 0.1;
        dpos.setXYZ(i, a.x, a.y, a.z);
        dvis.setX(i, v);
      }
      void up;
    });
    pos.needsUpdate = uv.needsUpdate = vis.needsUpdate = true;
    dpos.needsUpdate = dvis.needsUpdate = true;
    this.mat.uniforms.uColor.value.copy(color);
    this.mat.uniforms.uOpacity.value = 0.23 * strength;
    this.dustMat.uniforms.uColor.value.copy(color);
    this.dustMat.uniforms.uOpacity.value = 0.9 * strength;
    this.dustMat.uniforms.uScale.value = viewportH;
  }

  tick(t: number) {
    this.mat.uniforms.uTime.value = t;
    this.dustMat.uniforms.uTime.value = t;
  }
}

/** 窗外的雨絲或雪花。 */
export class Precipitation {
  object: THREE.LineSegments | THREE.Points | null = null;
  private kind: 'rain' | 'snow' | null = null;
  private pts: Float32Array = new Float32Array(0);
  private count = 0;
  constructor(private scene: THREE.Scene, private windows: WindowInfo[]) {}

  set(kind: 'rain' | 'snow' | null) {
    if (kind === this.kind) return;
    if (this.object) { this.scene.remove(this.object); this.object.geometry.dispose(); this.object = null; }
    this.kind = kind;
    if (!kind) return;
    const per = kind === 'rain' ? 90 : 60;
    this.count = this.windows.length * per;
    this.pts = new Float32Array(this.count * 3);
    this.windows.forEach((w, wi) => {
      for (let k = 0; k < per; k++) {
        const i = (wi * per + k) * 3;
        const p = w.center.clone().addScaledVector(w.across, (Math.random() - 0.5) * (w.width + 1.5)).addScaledVector(w.normalOut, 0.9 + Math.random() * 3.5);
        this.pts[i] = p.x; this.pts[i + 1] = Math.random() * 9; this.pts[i + 2] = p.z;
      }
    });
    const geo = new THREE.BufferGeometry();
    if (kind === 'rain') {
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.count * 6), 3));
      this.object = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x7f8fa8, transparent: true, opacity: 0.75, fog: false }));
    } else {
      geo.setAttribute('position', new THREE.BufferAttribute(this.pts, 3));
      this.object = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.07, transparent: true, opacity: 0.9, fog: false }));
    }
    this.object.frustumCulled = false;
    this.scene.add(this.object);
  }

  tick(dt: number) {
    if (!this.object || !this.kind) return;
    const speed = this.kind === 'rain' ? 11 : 0.9;
    for (let i = 0; i < this.count; i++) {
      this.pts[i * 3 + 1] -= speed * dt;
      if (this.pts[i * 3 + 1] < 0) this.pts[i * 3 + 1] += 9;
    }
    const pos = this.object.geometry.attributes.position as THREE.BufferAttribute;
    if (this.kind === 'rain') {
      const arr = pos.array as Float32Array;
      for (let i = 0; i < this.count; i++) {
        const x = this.pts[i * 3], y = this.pts[i * 3 + 1], z = this.pts[i * 3 + 2];
        arr.set([x, y, z, x + 0.02, y - 0.38, z], i * 6);
      }
    }
    pos.needsUpdate = true;
  }
}
