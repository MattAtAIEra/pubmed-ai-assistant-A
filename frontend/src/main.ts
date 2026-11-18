import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import './style.css';
import { CASES, HALL, VEST, buildLibrary, type Interactable } from './library';
import { Walker } from './controls';
import { Precipitation, Shafts, WEATHER_LABEL, computeLight, fetchWeather, guessLocation, makeSky, type Weather } from './sky';
import type { BookRecord } from './books';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

async function boot() {
  // 名牌上的中文字要等字型載入才畫得出來；等不到就用系統字型
  const signText = CASES.map((c) => c.title + c.sub).join('') + '訂閱櫃檯';
  try {
    await Promise.race([
      Promise.all([document.fonts.load('900 48px "Noto Serif TC"', signText), document.fonts.load('600 24px "Noto Serif TC"', signText)]),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch { /* 用系統字型 */ }

  const canvas = $<HTMLCanvasElement>('view');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x9a8f7a, 0.006);
  const camera = new THREE.PerspectiveCamera(64, 1, 0.06, 800);

  const lib = buildLibrary();
  scene.add(lib.group);

  const sky = makeSky();
  scene.add(sky.mesh);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a6a44, 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const sc = sun.shadow.camera;
  sc.left = -26; sc.right = 26; sc.top = 26; sc.bottom = -26; sc.near = 10; sc.far = 140;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  const center = new THREE.Vector3(-3, 1, 0);
  sun.target.position.copy(center);
  scene.add(sun, sun.target);

  const shafts = new Shafts(lib.windows);
  scene.add(shafts.group);
  const precip = new Precipitation(scene, lib.windows);

  // 滑鼠指到的那本書的外框
  const hl = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffd060, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
  hl.matrixAutoUpdate = false;
  hl.visible = false;
  scene.add(hl);

  // 後製：光暈與色調
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  // 過濾無效數值：只要畫面裡有一個像素算出 NaN 或無限大，光暈的模糊會把它擴散成大片黑色方塊，
  // 所以在進入光暈之前先把這種像素歸零，並限制最大亮度。
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
      float safe(float v){ if (isnan(v) || isinf(v)) return 0.0; return (v >= 0.0 && v <= 64.0) ? v : (v > 64.0 ? 64.0 : 0.0); }
      void main(){ vec4 c = texture2D(tDiffuse, vUv); gl_FragColor = vec4(safe(c.r), safe(c.g), safe(c.b), 1.0); }`,
  }));
  const bloom = new UnrealBloomPass(new THREE.Vector2(4, 4), 0.3, 0.6, 1.15);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // 環境反射：讓地板與木頭映出窗戶的亮面
  const cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(0.1, 400, cubeRT);
  cubeCam.position.set(2, 2.4, 0);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT: THREE.WebGLRenderTarget | null = null;
  let envTimer = 0;
  const captureEnv = () => {
    shafts.group.visible = false;
    hl.visible = false;
    scene.environment = null;
    cubeCam.update(renderer, scene);
    const next = pmrem.fromCubemap(cubeRT.texture);
    envRT?.dispose();
    envRT = next;
    scene.environment = next.texture;
    scene.environmentIntensity = 0.55;
    shafts.group.visible = true;
  };

  const walker = new Walker(camera, canvas, lib.walkRects, lib.colliders);

  // ---------- 時間與天氣 ----------
  let loc = guessLocation();
  const env = { auto: true, hour: 10, weatherMode: 'auto' as 'auto' | Weather, live: null as Weather | null };
  if (params.has('hour')) { env.auto = false; env.hour = Number(params.get('hour')); }
  if (params.has('weather')) env.weatherMode = params.get('weather') as Weather;
  let exposureBase = 1;

  const currentDate = () => {
    if (env.auto) return new Date();
    const d = new Date();
    d.setHours(Math.floor(env.hour), Math.round((env.hour % 1) * 60), 0, 0);
    return d;
  };
  const currentWeather = (): Weather => (env.weatherMode === 'auto' ? env.live ?? 'clear' : env.weatherMode);

  const applyLight = () => {
    const date = currentDate(), weather = currentWeather();
    const L = computeLight(date, loc.lat, loc.lon, weather);
    sun.color.copy(L.color);
    sun.intensity = L.intensity;
    sun.position.copy(center).addScaledVector(L.dir, 70);
    sun.target.updateMatrixWorld();
    hemi.color.copy(L.hemiSky);
    hemi.groundColor.copy(L.hemiGround);
    hemi.intensity = L.hemiIntensity;
    sky.mat.uniforms.uTop.value.copy(L.skyTop);
    sky.mat.uniforms.uHor.value.copy(L.skyHorizon);
    sky.mat.uniforms.uGain.value = L.skyGain;
    sky.mat.uniforms.uSun.value.copy(L.dir);
    sky.mat.uniforms.uSunCol.value.copy(L.color);
    sky.mat.uniforms.uSunAmt.value = L.isSun ? Math.min(1, L.intensity / 4) : 0.15;
    shafts.update(L.dir, L.color, L.shaft, renderer.domElement.height);
    for (const m of lib.lampMaterials) m.emissiveIntensity = 0.15 + 5 * L.lamp;
    lib.ceilMat.emissiveIntensity = 0.05 + 0.2 * L.dayness + 0.1 * L.lamp;
    for (const l of lib.lampLights) l.intensity = (l.userData.power as number) * L.lamp;
    lib.oculusMat.color.copy(L.skyTop).lerp(L.skyHorizon, 0.4).multiplyScalar(Math.max(0.25, L.skyGain * 0.6));
    lib.oculusLight.color.copy(L.skyHorizon);
    lib.oculusLight.intensity = 6 + 40 * L.dayness;
    (scene.fog as THREE.FogExp2).density = L.fog;
    (scene.fog as THREE.FogExp2).color.copy(L.fogColor);
    precip.set(weather === 'rain' ? 'rain' : weather === 'snow' ? 'snow' : null);
    exposureBase = L.exposure;
    renderer.shadowMap.needsUpdate = true;
    clearTimeout(envTimer);
    envTimer = window.setTimeout(captureEnv, 120);
    const hh = String(date.getHours()).padStart(2, '0'), mm = String(date.getMinutes()).padStart(2, '0');
    $('env-status').textContent = `${loc.name}　${hh}:${mm}　${WEATHER_LABEL[weather]}　太陽高度 ${L.elevationDeg.toFixed(0)} 度`;
    $('t-out').textContent = `${hh}:${mm}`;
  };

  const refreshWeather = async () => {
    const w = await fetchWeather(loc.lat, loc.lon);
    env.live = w;
    applyLight();
  };

  // ---------- 畫面大小 ----------
  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    composer.setPixelRatio(renderer.getPixelRatio());
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', () => { resize(); applyLight(); });
  resize();

  // ---------- 互動 ----------
  const hud = $('hud'), prompt = $('prompt'), locEl = $('loc'), panel = $('panel'), mapEl = $('map');
  let hoverBook: BookRecord | null = null;
  let nearby: Interactable | null = null;
  let seated = false;
  const standPos = new THREE.Vector3();
  let standYaw = 0;
  let started = false;
  const ray = new THREE.Raycaster();
  ray.far = 2.5;

  const panelOpen = () => !panel.hidden;
  const openPanel = (title: string, html: string) => {
    $('panel-title').textContent = title;
    $('panel-body').innerHTML = html;
    panel.hidden = false;
    document.exitPointerLock?.();
    walker.clearKeys();
  };
  const closePanel = () => {
    panel.hidden = true;
    if (seated) { seated = false; walker.setSeated(null); walker.teleport(standPos.x, standPos.z, standYaw); } // 站起來回到坐下前的位置
  };
  $('panel-close').addEventListener('click', closePanel);

  const note = '<p class="small">現在是第一階段，這裡先放說明。真正的功能會在後面的階段接上。</p>';
  const interact = () => {
    if (hoverBook) {
      const c = CASES[hoverBook.caseIndex];
      openPanel('示意書籍', `${hoverBook.isNew ? '<span class="tag">新到館</span>' : ''}<p>所在書櫃：${c.title}（${c.sub}）</p><p>第二階段起，這裡每一本書都會是一篇真正的 PubMed 文獻。翻開會看到重點整理、原始摘要、作者、期刊與 PubMed 連結。</p>${note}`);
      return;
    }
    if (!nearby) return;
    if (nearby.kind === 'counter') {
      openPanel('訂閱櫃檯', `<p>在這裡告訴館員你想追蹤的主題，或自己挑 PubMed 的檢索欄位組合。館員會組出檢索式、先試查，再把這個訂閱放進對應專科的書櫃。</p><p>之後系統定期到 PubMed 收新文獻、整理重點，並通知你。</p>${note}`);
    } else if (nearby.kind === 'cart') {
      openPanel('新書推車', `<p>上次來訪之後新到館的文獻都會放在這台推車上，依訂閱主題分好。</p>${note}`);
    } else if (nearby.kind === 'desk' && nearby.seat) {
      seated = true;
      standPos.copy(walker.pos);
      standYaw = walker.yaw;
      walker.setSeated(nearby.seat, nearby.seatYaw);
      openPanel('閱覽書桌', `<p>坐下來之後，可以針對自己書櫃裡的文獻連續追問，回答的每個論點都會標上 PMID。</p><p>取來的書會疊在桌上，可以指定只根據這幾篇回答，也可以做成 PowerPoint。</p><p class="small">按 Esc 站起來。</p>${note}`);
    }
  };

  // 平面圖
  const sx = (x: number) => (x - VEST.x0 + 1) * 17, sz = (z: number) => (z - HALL.z0 + 1) * 17;
  const buildMap = () => {
    const W = sx(HALL.x1 + 1), H = sz(HALL.z1 + 1);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="平面圖"><g fill="none" stroke="#f6ead0" stroke-width="2">`;
    s += `<rect x="${sx(HALL.x0)}" y="${sz(HALL.z0)}" width="${(HALL.x1 - HALL.x0) * 17}" height="${(HALL.z1 - HALL.z0) * 17}"/>`;
    s += `<rect x="${sx(VEST.x0)}" y="${sz(VEST.z0)}" width="${(VEST.x1 - VEST.x0) * 17}" height="${(VEST.z1 - VEST.z0) * 17}"/></g>`;
    s += `<line x1="${sx(HALL.x1)}" y1="${sz(-2.7)}" x2="${sx(HALL.x1)}" y2="${sz(2.7)}" stroke="#ffd66e" stroke-width="5"/>`;
    const hit = (x: number, z: number, w: number, d: number, fill: string, label: string, tx: number, tz: number, yaw: number, sub = '') =>
      `<g class="hit" tabindex="0" data-x="${tx}" data-z="${tz}" data-yaw="${yaw}"><rect x="${sx(x)}" y="${sz(z)}" width="${w * 17}" height="${d * 17}" fill="${fill}" rx="2"/><text x="${sx(x + w / 2)}" y="${sz(z + d / 2) + (d > 3 ? 0 : 4)}" fill="#f6ead0" font-size="12" text-anchor="middle" ${d > 3 ? `writing-mode="vertical-rl"` : ''}>${label}</text>${sub}</g>`;
    lib.cases.forEach((c) => {
      s += hit(c.x - 0.45, Math.min(c.side * 2.4, c.side * 7), 0.9, 4.6, '#7e4f24', c.title, c.x - 1.4, c.side * 1.5, c.side > 0 ? Math.PI : 0);
    });
    s += hit(-15.2, 3, 3, 1.3, '#3a5a84', '訂閱櫃檯', -13.7, 1.9, Math.PI);
    s += hit(11, 3.35, 5, 1.9, '#7b4a62', '閱覽書桌', 13.5, 2.3, Math.PI);
    s += hit(11, -5.25, 5, 1.9, '#7b4a62', '閱覽書桌', 13.5, -2.3, 0);
    s += `<text x="${sx(-21.8)}" y="${sz(0) + 4}" fill="#f6ead0" font-size="12" text-anchor="middle">玄關</text>`;
    s += `<circle id="map-me" r="6" fill="#ffd66e" stroke="#1b120a" stroke-width="1.5"/></svg>`;
    $('map-svg').innerHTML = s;
    $('map-svg').querySelectorAll<SVGGElement>('.hit').forEach((g) => {
      const go = () => {
        walker.teleport(Number(g.dataset.x), Number(g.dataset.z), Number(g.dataset.yaw));
        mapEl.hidden = true;
      };
      g.addEventListener('click', go);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
  };
  buildMap();

  const whereAmI = () => {
    const { x, z } = walker.pos;
    if (x < HALL.x0) return '玄關';
    if (nearby?.kind === 'counter' || nearby?.kind === 'cart') return '訂閱櫃檯';
    if (x > 10.4 && Math.abs(z) > 2.3) return '閱覽書桌';
    if (Math.abs(z) > 2.3) {
      let best = lib.cases[0], bd = 99;
      for (const c of lib.cases) if (Math.sign(z) === c.side && Math.abs(c.x - x) < bd) { bd = Math.abs(c.x - x); best = c; }
      if (bd < 2.4) return `「${best.title}」書櫃 · ${best.sub}`;
    }
    return '主廳 · 中央走道';
  };

  window.addEventListener('keydown', (e) => {
    if (!started) return;
    if (e.code === 'Escape') {
      if (!mapEl.hidden) mapEl.hidden = true;
      else if (panelOpen()) closePanel();
      else if (!$('env').hidden) { $('env').hidden = true; $('env-btn').setAttribute('aria-expanded', 'false'); }
      return;
    }
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
    if (e.code === 'KeyM') { mapEl.hidden = !mapEl.hidden; if (!mapEl.hidden) document.exitPointerLock?.(); walker.clearKeys(); }
    else if ((e.code === 'KeyE' || e.code === 'Enter') && mapEl.hidden && !panelOpen()) interact();
  });
  canvas.addEventListener('click', () => { if (started && !panelOpen() && mapEl.hidden) walker.lockPointer(); });

  // 時間與天氣的調整面板
  const envBox = $('env'), tHour = $<HTMLInputElement>('t-hour'), tAuto = $<HTMLInputElement>('t-auto'), tManual = $<HTMLInputElement>('t-manual'), wSel = $<HTMLSelectElement>('w-sel');
  tHour.value = String(env.hour);
  tAuto.checked = env.auto; tManual.checked = !env.auto;
  wSel.value = env.weatherMode;
  $('env-btn').addEventListener('click', () => {
    envBox.hidden = !envBox.hidden;
    $('env-btn').setAttribute('aria-expanded', String(!envBox.hidden));
    if (!envBox.hidden) document.exitPointerLock?.();
  });
  tAuto.addEventListener('change', () => { env.auto = true; applyLight(); });
  tManual.addEventListener('change', () => { env.auto = false; env.hour = Number(tHour.value); applyLight(); });
  tHour.addEventListener('input', () => { env.auto = false; tManual.checked = true; env.hour = Number(tHour.value); applyLight(); });
  wSel.addEventListener('change', () => { env.weatherMode = wSel.value as 'auto' | Weather; applyLight(); });
  $('geo-btn').addEventListener('click', () => {
    if (!navigator.geolocation) { $('geo-btn').textContent = '這個瀏覽器不提供位置'; return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { loc = { lat: p.coords.latitude, lon: p.coords.longitude, name: '我的位置' }; $('geo-btn').textContent = '已使用我的位置'; refreshWeather(); },
      () => { $('geo-btn').textContent = '沒有取得位置，沿用時區推估'; },
      { timeout: 8000 },
    );
  });

  applyLight();
  refreshWeather();
  setInterval(() => { if (env.auto) applyLight(); }, 60000);
  setInterval(refreshWeather, 15 * 60000);

  // ---------- 進場 ----------
  const enter = $<HTMLButtonElement>('enter');
  const start = () => {
    started = true;
    walker.enabled = true;
    $('start').hidden = true;
    hud.hidden = false;
    canvas.focus();
    walker.lockPointer();
  };
  enter.disabled = false;
  enter.textContent = '走進圖書館';
  enter.addEventListener('click', start);
  if (params.has('x')) walker.teleport(Number(params.get('x')), Number(params.get('z') ?? 0), Number(params.get('yaw') ?? -Math.PI / 2));
  if (params.has('pitch')) walker.pitch = Number(params.get('pitch'));
  if (params.has('auto')) { started = true; walker.enabled = true; $('start').hidden = true; hud.hidden = false; }
  (window as unknown as Record<string, unknown>).__hall = { walker, env, applyLight };

  // ---------- 主迴圈 ----------
  const clock = new THREE.Clock();
  let probe = 0, exposure = 1.6;
  const tmp = new THREE.Vector3();
  const loop = () => {
    const dt = Math.min(0.1, clock.getDelta()), t = clock.elapsedTime;
    walker.update(dt, started && !panelOpen() && mapEl.hidden && !seated);

    probe += dt;
    if (started && probe > 0.1) {
      probe = 0;
      // 準星對到哪一本書
      hoverBook = null;
      if (!panelOpen() && walker.pos.x > HALL.x0) {
        ray.setFromCamera(new THREE.Vector2(0, 0), camera);
        const hit = ray.intersectObjects([lib.books.mesh, lib.books.glow], false)[0];
        if (hit && hit.instanceId !== undefined) hoverBook = (hit.object === lib.books.glow ? lib.books.glowRecords : lib.books.records)[hit.instanceId];
      }
      if (hoverBook) { hl.matrix.copy(hoverBook.matrix).scale(tmp.set(1.06, 1.02, 1.06)); hl.visible = true; } else hl.visible = false;
      // 附近可以互動的東西
      nearby = null;
      let bd = 99;
      for (const it of lib.interactables) {
        const d = Math.hypot(it.pos.x - walker.pos.x, it.pos.z - walker.pos.z);
        if (d < it.radius && d < bd) { bd = d; nearby = it; }
      }
      const text = panelOpen() ? '' : hoverBook ? `按 E 翻閱這本書${hoverBook.isNew ? '（新到館）' : ''}` : nearby ? `按 E ${nearby.label}` : '';
      prompt.hidden = !text;
      prompt.textContent = text;
      locEl.textContent = whereAmI();
      if (!mapEl.hidden) {
        const me = document.getElementById('map-me');
        me?.setAttribute('cx', String(sx(walker.pos.x)));
        me?.setAttribute('cy', String(sz(walker.pos.z)));
      }
    }

    // 從暗處走到亮處，眼睛慢慢適應
    const target = exposureBase * (walker.pos.x < HALL.x0 - 0.3 ? 1.75 : 1);
    exposure += (target - exposure) * (1 - Math.exp(-dt * 0.9));
    renderer.toneMappingExposure = exposure;
    lib.books.glowMat.emissiveIntensity = 0.3 + Math.sin(t * 2.2) * 0.12;
    lib.newBookMat.emissiveIntensity = 1.1 + Math.sin(t * 2.2 + 1) * 0.3;
    shafts.tick(t);
    precip.tick(dt);
    sky.mesh.position.copy(camera.position);
    composer.render();
    requestAnimationFrame(loop);
  };
  loop();
}

boot();
