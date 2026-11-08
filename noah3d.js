// =============================================================================
// noah3d.js — N.O.A.H. 盤面の3D表示（テスト版・v352〜）
// -----------------------------------------------------------------------------
// index.html が vendor/three-r170.min.js（window.THREE）のあとに普通のスクリプトとして読み込み、
// window.NOAH3D.start(bridge) を呼ぶ（v353〜。ESモジュールをやめ、HTMLビューアーの file:// でも読めるようにした）。
// ゲームの中身（ルール・カード・UI）は変えず、盤面の「見え方」と「タップの受け取り方」だけを差し替える。
//
// 座標：盤面は x 0〜7（左→右）、y 0〜7（奥→手前）。3D空間では 1マス = 1。
//       X = x - 3.5、Z = y - 3.5（手前が +Z）、Y は上。カメラは手前（基地側）の斜め上から、奥の怪獣を正面寄りに見る。
//
// 重なり（下から）：
//   ① 地形（2Dと同じステージ画像を地面に貼ってスクロール）・左右の木／岩山（3D）
//   ② 怪獣（3D）
//   ③ 戦術パネル：2Dの「移動先・攻撃予測・HPバー」をそのまま描いた絵を、機体の飛行高度に浮かべる
//   ④ 機体・ミサイル・麻酔弾（3D）
//   ⑤ カード演出：2Dの演出を、1つずつ3Dの位置（機体・怪獣の胸の前）に合わせ、画面に平行に描く（v353〜）。
//      研究の演出は怪獣の前に立てた面に描く。爆発のときは3Dの光で怪獣・機体を照らす。
//
// v354〜：怪獣・機体5機・木・岩山は Meshy の本番モデル（models/*.js。GLB を base64 で埋め込んだもの）。
//   tools/noah_glb_optimize.py で向き・大きさをそろえ、画像を WebP に縮めてある。ミサイル・麻酔弾は仮モデルのまま。
//   読み込みは裏で行い、届くまで（または読めない端末では）これまでの仮モデルを出す。
//   怪獣は Meshy の Smart Rig の骨を、ここで手続き的に動かす（歩き・呼吸・尾・突進・溜め）。
// =============================================================================
(function () {
'use strict';
const THREE = window.THREE;
if (!THREE) throw new Error('three.js（vendor/three-r170.min.js）が読み込まれていません');

const FLY_Y = 1.1;              // 機体の飛行高度
const PANEL_Y = FLY_Y - 0.12;   // 戦術パネルの高さ（機体の少し下）
const KAIJU_Z = -2;             // 怪獣の足元の中心（3×3マスの中心 y=1.5）
const TILE_W = 16.8;            // 地形画像1枚の横幅（2Dの「盤面の横幅の2.4倍」表示と同じ縮尺）
const TACTICAL_TEX = 512;       // 戦術パネルの絵の解像度
const UNIT_BOARD_COLS = [1, 3, 5];
const TACTICAL_ROWS = [4, 5, 6];

// 演出の面：盤面の y=5.5（中列の機体）では機体の高さ、y=1.7（2Dでミサイルが当たる所）では怪獣の胸の前を通る
const FX_ROW = 5.5, FX_HIT_ROW = 1.7, FX_HIT_Y = 2.0, FX_HIT_Z = KAIJU_Z + 0.9;
const FX_K_Y = (FX_HIT_Y - FLY_Y) / (FX_ROW - FX_HIT_ROW);
const FX_K_Z = (FX_HIT_Z - (FX_HIT_ROW - 3.5)) / (FX_ROW - FX_HIT_ROW);
function effectPlanePoint(bx, by, out = new THREE.Vector3()) {
  return out.set(bx - 3.5, FLY_Y + FX_K_Y * (FX_ROW - by), by - 3.5 + FX_K_Z * (FX_ROW - by));
}

// カメラの構え。elev は見下ろす角度（度）。fit は画面に必ず入れる点（ここから毎回カメラの距離を決める）。
// v359：移動フェイズ（移動先・出撃先を選ぶ間も）は真上から（top）。それ以外は斜めから、v358 までより寄せて（oblique）、
//       盤面の四隅ではなく「怪獣」と「機体の3×3のマス」が画面いっぱいに入るようにした。左上の視点ボタンは無くした。
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const CAMERA_POSES = {
  oblique: {
    name: 'oblique', elev: 42, fov: 36, target: V3(0, 1.15, 0.55),
    fit: [
      V3(-3.05, PANEL_Y, 0.45), V3(3.05, PANEL_Y, 0.45), V3(-3.05, PANEL_Y, 3.6), V3(3.05, PANEL_Y, 3.6),   // 機体のマス
      V3(-2.0, PANEL_Y, 3.95), V3(2.0, PANEL_Y, 3.95),                                                   // 手前の機体のHPの札
      V3(-2.7, FLY_Y + 0.2, 3.5), V3(2.7, FLY_Y + 0.2, 3.5),                                             // 手前の機体
      V3(0, 3.75, KAIJU_Z - 0.5), V3(-1.75, 2.7, KAIJU_Z + 0.2), V3(1.75, 2.7, KAIJU_Z + 0.2),           // 怪獣の頭と腕の刃
    ],
  },
  top: {
    name: 'top', elev: 90, fov: 30, target: V3(0, PANEL_Y, 0.45),
    fit: [
      V3(-3.05, PANEL_Y, 0.45), V3(3.05, PANEL_Y, 0.45), V3(-3.05, PANEL_Y, 3.6), V3(3.05, PANEL_Y, 3.6),   // 機体のマス
      V3(-2.0, PANEL_Y, 3.85), V3(2.0, PANEL_Y, 3.85),                                                   // 手前の機体のHPの札
      V3(0, 3.4, KAIJU_Z - 0.5), V3(-1.6, 2.6, KAIJU_Z + 0.3), V3(1.6, 2.6, KAIJU_Z + 0.3),              // 怪獣（頭と腕）
      V3(0, 2.6, KAIJU_Z - 1.15),                                                                        // 怪獣の背中
    ],
  },
};

// env … 映り込み用の空の明るさ（v354〜。機体と怪獣にだけ映す）
const STAGE_LOOK = {
  forest:   { fog: 0x9db3a6, fogNear: 18, fogFar: 48, sky: 0xe2f0ff, ground: 0x34402a, hemi: 1.25, sun: 0xfff0d2, sunI: 2.4, exposure: 1.02, env: 0.8, envSun: 3 },
  seafloor: { fog: 0x0f4b57, fogNear: 12, fogFar: 36, sky: 0xa6ecff, ground: 0x0a2a30, hemi: 1.1,  sun: 0xc8f2ff, sunI: 1.6, exposure: 1.1, env: 0.7, envSun: 2.5 },
};

// -----------------------------------------------------------------------------
// 小物
// -----------------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const clamp01 = v => Math.max(0, Math.min(1, v));
const easeInOutSine = p => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(p));
const smooth = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const stripeTexture = () => canvasTexture(64, 128, (g) => {
  g.fillStyle = '#1c6f9a'; g.fillRect(0, 0, 64, 128);
  for (let i = 0; i < 9; i++) {
    const x = 4 + i * 6.6;
    const grd = g.createLinearGradient(x - 3, 0, x + 3, 0);
    grd.addColorStop(0, 'rgba(120,240,255,0)'); grd.addColorStop(0.5, 'rgba(190,250,255,1)'); grd.addColorStop(1, 'rgba(120,240,255,0)');
    g.fillStyle = grd; g.fillRect(x - 3, 6, 6, 116);
  }
});

// 押しているマスの枠（2:1）
const frameTexture = () => canvasTexture(256, 128, (g) => {
  g.shadowColor = 'rgba(160,255,250,1)'; g.shadowBlur = 16;
  g.strokeStyle = 'rgba(225,255,255,1)'; g.lineWidth = 7;
  const r = 18, x = 12, y = 12, w = 232, h = 104;
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.stroke();
  g.fillStyle = 'rgba(150,255,245,.20)'; g.fill();
});

const glowTexture = () => canvasTexture(64, 64, (g) => {
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,.55)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
});

// 必殺技の溜め中に怪獣の頭上に出す「！」（2Dの警告アイコンと同じ配色）
const warnTexture = () => canvasTexture(128, 128, (g) => {
  const cx = 64, cy = 66, r = 50;
  g.shadowColor = 'rgba(255,64,64,.85)'; g.shadowBlur = 14;
  g.beginPath(); g.moveTo(cx, cy - r * 0.98); g.lineTo(cx - r * 0.92, cy + r * 0.72); g.lineTo(cx + r * 0.92, cy + r * 0.72); g.closePath();
  g.fillStyle = 'rgba(255,214,68,.95)'; g.fill();
  g.shadowBlur = 0; g.lineWidth = 6; g.strokeStyle = 'rgba(255,70,70,1)'; g.stroke();
  g.fillStyle = 'rgba(52,18,10,.96)'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '900 70px system-ui, sans-serif'; g.fillText('!', cx, cy + 10);
});

// -----------------------------------------------------------------------------
// 砂ぼこり・泡（v356〜）
//   ・怪獣の足が地面に着くたびに、足元から砂ぼこりが広がる（森林は土ぼこり、海底は砂けむり。海底では泡も少し）
//   ・海底では、ミサイルなどが炸裂したときに泡が出る。ときどき、ステージのどこかから泡がぽこぽこ昇っていく
//   粒は四角い板をカメラに向けて並べ、種類ごとにまとめて1回で描く（数は多くても百数十。軽い）。
//   地形が流れる（怪獣が歩く）と、粒も地面と一緒に流れる（水や空気は地面と一緒に止まっているので）。
// -----------------------------------------------------------------------------
// もこもこした砂ぼこりのかたまり（白。色は粒ごとに付ける）
const dustTexture = () => canvasTexture(128, 128, (g) => {
  const r = rng(4242);
  for (let i = 0; i < 10; i++) {
    const a = r() * Math.PI * 2, d = i ? 10 + r() * 14 : 0;
    const x = 64 + Math.cos(a) * d, y = 64 + Math.sin(a) * d, rad = i ? 20 + r() * 14 : 40;
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, `rgba(255,255,255,${i ? 0.45 : 0.7})`);
    grd.addColorStop(0.5, `rgba(255,255,255,${i ? 0.22 : 0.34})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  }
});
// 泡：うすい中身・明るい縁・その外の細い暗い縁（白い怪獣の前でも見えるように）・左上の光の点
const bubbleTexture = () => canvasTexture(64, 64, (g) => {
  const c = 32, R = 26;
  let grd = g.createRadialGradient(c, c, 0, c, c, R + 4);
  grd.addColorStop(0, 'rgba(255,255,255,0.10)');
  grd.addColorStop(0.62, 'rgba(255,255,255,0.18)');
  grd.addColorStop(0.8, 'rgba(255,255,255,0.88)');
  grd.addColorStop(0.88, 'rgba(255,255,255,0.6)');
  grd.addColorStop(0.92, 'rgba(18,58,74,0.55)');
  grd.addColorStop(1, 'rgba(18,58,74,0)');
  g.fillStyle = grd; g.beginPath(); g.arc(c, c, R + 4, 0, Math.PI * 2); g.fill();
  grd = g.createRadialGradient(c - 9, c - 10, 0, c - 9, c - 10, 8);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  grd = g.createRadialGradient(c + 8, c + 11, 0, c + 8, c + 11, 6);
  grd.addColorStop(0, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
});

const FX_VERT = `
attribute vec3 iPos;
attribute vec3 iColor;
attribute vec3 iData;   // 大きさ・濃さ・回転
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
#include <fog_pars_vertex>
void main() {
  vUv = uv; vColor = iColor; vAlpha = iData.y;
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iData.z), s = sin(iData.z);
  vec2 q = position.xy * iData.x;
  mvPosition.xy += vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const FX_FRAG = `
uniform sampler2D map;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;
#include <common>
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(map, vUv);
  float a = t.a * vAlpha;
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor * t.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
function makeParticleLayer(tex, max, order) {
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setIndex(base.getIndex());
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  const pos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  const color = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  const data = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  [pos, color, data].forEach(a => a.setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('iPos', pos); geo.setAttribute('iColor', color); geo.setAttribute('iData', data);
  geo.instanceCount = 0;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null } }]);
  uniforms.map.value = tex;        // merge は画像を複製してしまうので、あとから入れる
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: FX_VERT, fragmentShader: FX_FRAG, transparent: true, depthWrite: false, fog: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = order;          // 怪獣のあと・戦術パネルの前（移動先などの表示が粒に隠れないように）
  mesh.visible = false;
  return { mesh, pos, color, data, max, dispose() { geo.dispose(); base.dispose(); mat.dispose(); tex.dispose(); } };
}

const FX_DUST = {
  // color は sRGB。size は板の一辺（1マス = 1）。life は秒。speed は横に広がる速さ、up は舞い上がる速さ（毎秒）
  forest:   { color: 0xcdbb95, n: 11, life: [1.3, 1.9], size: [0.4, 0.62], grow: 2.4, speed: [0.7, 1.3], up: [0.15, 0.38], drag: 3.0, rise: 0.06, alpha: 0.82 },
  seafloor: { color: 0xc6e0d5, n: 11, life: [2.0, 2.9], size: [0.42, 0.64], grow: 2.6, speed: [0.4, 0.8], up: [0.14, 0.32], drag: 2.0, rise: 0.12, alpha: 0.75 },
};
const FX_BUBBLE_COLOR = 0xe2f8ff;
const lerpRange = ([a, b]) => a + Math.random() * (b - a);

function makeStageFx() {
  const dustL = makeParticleLayer(dustTexture(), 72, 0.5);
  const bubL = makeParticleLayer(bubbleTexture(), 120, 0.55);
  const group = new THREE.Group();
  group.add(dustL.mesh, bubL.mesh);
  const dust = [], bubbles = [], emitters = [];
  const dustColor = { forest: new THREE.Color(FX_DUST.forest.color), seafloor: new THREE.Color(FX_DUST.seafloor.color) };
  const bubbleColor = new THREE.Color(FX_BUBBLE_COLOR);
  let sea = false, lite = false, warming = false, nextAmbient = 0, lastNow = 0, lastScroll = null;
  const camPos = new THREE.Vector3(), camDir = new THREE.Vector3();

  function setStage(stage) {
    sea = stage === 'seafloor';
    dust.length = 0; bubbles.length = 0; emitters.length = 0; nextAmbient = 0;
  }
  // 泡を n 個。kind … 'burst'（炸裂）・'step'（足元）・'ambient'（ステージのどこか）
  function bubbleAt(x, y, z, n, kind, spread) {
    for (let i = 0; i < n && bubbles.length < bubL.max; i++) {
      const burst = kind === 'burst';
      const s = burst ? 0.14 + Math.random() * 0.16 : 0.1 + Math.random() * 0.09;
      const a = Math.random() * Math.PI * 2, sp = burst ? 0.35 + Math.random() * 0.8 : 0.04;
      bubbles.push({
        x: x + (Math.random() - 0.5) * spread, y: y + (Math.random() - 0.5) * spread * 0.6, z: z + (Math.random() - 0.5) * spread,
        vx: Math.cos(a) * sp, vy: burst ? (Math.random() - 0.25) * 0.6 : 0.12, vz: Math.sin(a) * sp * 0.6,
        age: 0, life: burst ? 2.0 + Math.random() * 1.2 : 2.6 + Math.random() * 1.6,
        s0: s, s1: s * 1.18, a: 0.8 + Math.random() * 0.2, rot: 0, vr: 0, c: bubbleColor,
        drag: 2.6, buoy: 1.1, maxUp: 0.42 + s * 3.2, lift: 0,
        wob: 0.015 + Math.random() * 0.03, wobF: 5 + Math.random() * 5, wobP: Math.random() * 6.28, fin: 0.08, fout: 0.72,
      });
    }
  }
  // 怪獣の足が地面に着いた（x, z は足首の真下）
  function footfall(x, z) {
    const D = sea ? FX_DUST.seafloor : FX_DUST.forest;
    const n = Math.round(D.n * (lite ? 0.5 : 1));
    for (let i = 0; i < n && dust.length < dustL.max; i++) {
      const a = Math.random() * Math.PI * 2, sp = lerpRange(D.speed), r0 = 0.1 + Math.random() * 0.14;
      const s0 = lerpRange(D.size);
      dust.push({
        x: x + Math.cos(a) * r0, y: 0, z: z + Math.sin(a) * r0 * 0.8,
        vx: Math.cos(a) * sp, vy: lerpRange(D.up), vz: Math.sin(a) * sp * 0.8,
        age: 0, life: lerpRange(D.life), s0, s1: s0 * D.grow, a: D.alpha * (0.7 + Math.random() * 0.3),
        rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.9, c: sea ? dustColor.seafloor : dustColor.forest,
        drag: D.drag, buoy: D.rise, maxUp: 0.45, lift: 0.32, wob: 0, fin: 0.07, fout: 0.5,
      });
    }
    if (sea && Math.random() < 0.4) bubbleAt(x, 0.12, z, 1 + (Math.random() < 0.4 ? 1 : 0), 'step', 0.3);
  }
  // 炸裂（海底だけ泡を出す）。peak … 光の強さ（大きな炸裂ほど泡が多い）
  function burst(x, y, z, peak) {
    if (!sea) return;
    const n = Math.max(2, Math.round(peak * 0.42 * (lite ? 0.6 : 1)));
    bubbleAt(x, y, z, n, 'burst', 0.35);
  }
  function ambient(now) {
    if (!nextAmbient) nextAmbient = now + 1200 + Math.random() * 2000;
    if (now >= nextAmbient) {
      nextAmbient = now + (lite ? 2 : 1) * (3000 + Math.random() * 4000);   // 3〜7秒おき（ときどき・ほんの少し）
      // 6割は道の外（岩場のすき間）、4割は道の上から
      const outside = Math.random() < 0.6;
      const x = outside ? (Math.random() < 0.5 ? -1 : 1) * (2.2 + Math.random() * 2.6) : (Math.random() - 0.5) * 3.2;
      emitters.push({ x, z: -6.5 + Math.random() * 9, left: 3 + Math.floor(Math.random() * 4), next: now });
    }
    for (let i = emitters.length - 1; i >= 0; i--) {
      const e = emitters[i];
      if (now >= e.next) { bubbleAt(e.x, 0.08, e.z, 1, 'ambient', 0.08); e.left--; e.next = now + 110 + Math.random() * 260; }
      if (e.left <= 0) emitters.splice(i, 1);
    }
  }
  function step(list, dt, ds) {
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.age += dt;
      if (p.age >= p.life) { list[i] = list[list.length - 1]; list.pop(); continue; }
      const k = Math.exp(-p.drag * dt);
      p.vx *= k; p.vz *= k;
      p.vy = Math.min(p.maxUp, p.vy * k + p.buoy * dt);
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt - ds;
      p.rot += p.vr * dt;
    }
  }
  function write(layer, list) {
    const n = Math.min(list.length, layer.max);
    layer.mesh.visible = n > 0;
    layer.mesh.geometry.instanceCount = n;
    if (!n) return;
    for (const p of list) p.depth = (p.x - camPos.x) * camDir.x + (p.y - camPos.y) * camDir.y + (p.z - camPos.z) * camDir.z;
    list.sort((a, b) => b.depth - a.depth);   // 遠いものから描く
    const P = layer.pos.array, C = layer.color.array, D = layer.data.array;
    for (let i = 0; i < n; i++) {
      const p = list[i], u = p.age / p.life, j = i * 3;
      const size = p.s0 + (p.s1 - p.s0) * (1 - Math.pow(1 - u, 2.2));   // はじめに速く広がり、だんだんゆっくり
      let x = p.x, z = p.z;
      if (p.wob) { x += Math.sin(p.age * p.wobF + p.wobP) * p.wob; z += Math.cos(p.age * p.wobF * 0.8 + p.wobP) * p.wob * 0.6; }
      P[j] = x; P[j + 1] = p.y + p.lift * size; P[j + 2] = z;   // 砂ぼこりは板の下の端が地面に沈まないよう少し浮かせる
      C[j] = p.c.r; C[j + 1] = p.c.g; C[j + 2] = p.c.b;
      const fadeIn = Math.min(1, p.age / p.fin);
      const f = u <= p.fout ? 0 : (u - p.fout) / (1 - p.fout);
      const fadeOut = 1 - f * f * (3 - 2 * f);      // なめらかに消える
      D[j] = size; D[j + 1] = p.a * fadeIn * fadeOut; D[j + 2] = p.rot;
    }
    layer.pos.needsUpdate = true; layer.color.needsUpdate = true; layer.data.needsUpdate = true;
  }
  // 毎フレーム。now … ミリ秒、scroll … 地形の流れた量（マス）
  function update(now, scroll, camera) {
    const dt = lastNow ? Math.min(0.1, Math.max(0, (now - lastNow) / 1000)) : 0;
    lastNow = now;
    const ds = lastScroll == null || Math.abs(scroll - lastScroll) > 3 ? 0 : scroll - lastScroll;
    lastScroll = scroll;
    step(dust, dt, ds);
    step(bubbles, dt, ds);
    for (const e of emitters) e.z -= ds;
    if (sea) ambient(now);
    camera.getWorldPosition(camPos); camera.getWorldDirection(camDir);
    if (warming) return;
    write(dustL, dust);
    write(bubL, bubbles);
  }
  // 下ごしらえ用：見えない粒を1つずつ置いて、絵の作り方（シェーダー）を作らせる
  function warm(on) {
    warming = on;
    for (const L of [dustL, bubL]) {
      L.data.array[0] = 0.01; L.data.array[1] = 0; L.data.needsUpdate = true;
      L.mesh.geometry.instanceCount = on ? 1 : 0;
      L.mesh.visible = on;
    }
  }
  return {
    group, setStage, footfall, burst, update, warm,
    setLite(on) { lite = !!on; },
    count: () => ({ dust: dust.length, bubbles: bubbles.length, emitters: emitters.length }),
    // テスト用：すぐに泡を出す
    debugAmbient(now) { nextAmbient = now; },
    dispose() { dustL.dispose(); bubL.dispose(); },
  };
}

// -----------------------------------------------------------------------------
// 仮モデル：怪獣（白い装甲・紺の体・青く光る胸・三日月の角・刃のある前腕・長い尾）。正面は +Z（カメラ側）
// -----------------------------------------------------------------------------
function makeKaiju() {
  const M = {
    dark: new THREE.MeshStandardMaterial({ color: 0x27325a, roughness: 0.78, metalness: 0.08, flatShading: true }),
    armor: new THREE.MeshStandardMaterial({ color: 0xe3e5e2, roughness: 0.5, metalness: 0.1, flatShading: true }),
    blue: new THREE.MeshStandardMaterial({ color: 0x86c0ea, roughness: 0.45, metalness: 0.1, flatShading: true, emissive: 0x0b3350, emissiveIntensity: 0.7 }),
    glow: new THREE.MeshStandardMaterial({ color: 0x0f4d6e, emissive: 0x48d6ff, emissiveIntensity: 2.2, emissiveMap: stripeTexture(), roughness: 0.3 }),
    eye: new THREE.MeshBasicMaterial({ color: 0xffe6a0 }),
    claw: new THREE.MeshStandardMaterial({ color: 0xece6d8, roughness: 0.38, flatShading: true }),
  };
  const mesh = (geo, mat, opt = {}) => {
    const m = new THREE.Mesh(geo, mat);
    if (opt.p) m.position.set(...opt.p);
    if (opt.r) m.rotation.set(...opt.r);
    if (opt.s) m.scale.set(...opt.s);
    return m;
  };
  const ball = new THREE.SphereGeometry(1, 12, 9);
  const root = new THREE.Group();          // 足元
  const body = new THREE.Group();          // 揺れ・突進
  root.add(body);
  const hips = new THREE.Group(); hips.position.set(0, 1.28, 0); body.add(hips);
  hips.add(mesh(ball, M.dark, { s: [0.62, 0.5, 0.56] }));

  // 脚
  const legs = [];
  for (const side of [-1, 1]) {
    const thigh = new THREE.Group(); thigh.position.set(side * 0.47, -0.06, 0.02); hips.add(thigh);
    thigh.add(mesh(new THREE.CylinderGeometry(0.29, 0.21, 0.74, 8), M.armor, { p: [0, -0.35, 0.05], r: [0.12, 0, 0] }));
    thigh.add(mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.7, 7), M.dark, { p: [side * -0.04, -0.34, -0.06] }));
    const knee = new THREE.Group(); knee.position.set(0, -0.68, 0.12); thigh.add(knee);
    knee.add(mesh(new THREE.CylinderGeometry(0.18, 0.12, 0.62, 7), M.dark, { p: [0, -0.3, -0.07], r: [0.28, 0, 0] }));
    knee.add(mesh(new THREE.BoxGeometry(0.22, 0.46, 0.08), M.armor, { p: [0, -0.24, 0.08], r: [0.28, 0, 0] }));
    const ankle = new THREE.Group(); ankle.position.set(0, -0.58, -0.16); knee.add(ankle);
    ankle.add(mesh(new THREE.BoxGeometry(0.44, 0.15, 0.58), M.dark, { p: [0, -0.02, 0.14] }));
    for (let k = -1; k <= 1; k++) {
      ankle.add(mesh(new THREE.ConeGeometry(0.055, 0.24, 6), M.claw, { p: [k * 0.14, -0.05, 0.47], r: [Math.PI / 2, 0, 0] }));
    }
    legs.push({ side, thigh, knee, ankle });
  }

  // 胴体
  const spine = new THREE.Group(); spine.position.set(0, 0.16, 0); spine.rotation.x = 0.32; hips.add(spine);
  spine.add(mesh(ball, M.dark, { p: [0, 0.62, 0], s: [0.84, 0.95, 0.68] }));
  spine.add(mesh(ball, M.armor, { p: [0, 0.42, 0.36], s: [0.56, 0.66, 0.3] }));
  const chest = mesh(ball, M.glow, { p: [0, 0.8, 0.54], s: [0.33, 0.5, 0.15] });
  spine.add(chest);
  for (const side of [-1, 1]) {
    spine.add(mesh(ball, M.armor, { p: [side * 0.7, 1.1, 0.0], r: [0, 0, side * -0.38], s: [0.44, 0.25, 0.42] }));
    for (let k = 0; k < 3; k++) {
      spine.add(mesh(new THREE.ConeGeometry(0.08, 0.34, 6), M.blue, { p: [side * (0.6 + k * 0.17), 1.33 - k * 0.07, -0.08 - k * 0.04], r: [-0.25, 0, side * (-0.5 - k * 0.25)] }));
    }
  }
  for (let k = 0; k < 4; k++) {
    spine.add(mesh(new THREE.ConeGeometry(0.09, 0.4 - k * 0.05, 6), M.blue, { p: [0, 1.05 - k * 0.24, -0.5 + k * 0.03], r: [-0.9, 0, 0] }));
  }

  // 首・頭・三日月の角
  const neck = new THREE.Group(); neck.position.set(0, 1.34, 0.26); spine.add(neck);
  neck.add(mesh(new THREE.CylinderGeometry(0.2, 0.26, 0.34, 8), M.dark, { p: [0, 0.08, 0.05], r: [0.6, 0, 0] }));
  const head = new THREE.Group(); head.position.set(0, 0.18, 0.24); neck.add(head);
  head.add(mesh(ball, M.armor, { s: [0.31, 0.25, 0.45] }));
  head.add(mesh(new THREE.BoxGeometry(0.34, 0.1, 0.38), M.dark, { p: [0, -0.15, 0.1] }));
  for (const side of [-1, 1]) head.add(mesh(new THREE.SphereGeometry(0.045, 8, 6), M.eye, { p: [side * 0.13, 0.03, 0.33] }));
  const crestArc = Math.PI * 1.12;
  head.add(mesh(new THREE.TorusGeometry(0.47, 0.06, 6, 22, crestArc), M.armor, { p: [0, 0.2, -0.16], r: [-0.62, 0, Math.PI / 2 - crestArc / 2] }));
  for (const side of [-1, 1]) {
    head.add(mesh(new THREE.ConeGeometry(0.06, 0.3, 6), M.armor, { p: [side * 0.5, 0.38, -0.3], r: [-0.4, 0, side * -0.55] }));
  }

  // 腕（前腕に大きな三日月の刃）
  const arms = [];
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Group(); shoulder.position.set(side * 0.94, 0.95, 0.12); spine.add(shoulder);
    shoulder.add(mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.62, 7), M.dark, { p: [0, -0.3, 0] }));
    const elbow = new THREE.Group(); elbow.position.set(0, -0.6, 0); shoulder.add(elbow);
    elbow.add(mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.56, 7), M.dark, { p: [0, -0.27, 0.06], r: [0.2, 0, 0] }));
    elbow.add(mesh(new THREE.TorusGeometry(0.52, 0.05, 5, 16, 1.9), M.armor, { p: [side * 0.18, -0.32, -0.05], r: [0, Math.PI / 2, side > 0 ? 2.2 : 0.95] }));
    const hand = new THREE.Group(); hand.position.set(0, -0.56, 0.12); elbow.add(hand);
    for (let k = -1; k <= 1; k++) {
      hand.add(mesh(new THREE.ConeGeometry(0.045, 0.26, 6), M.claw, { p: [k * 0.07, -0.08, 0.06], r: [Math.PI * 0.85, 0, k * 0.15] }));
    }
    arms.push({ side, shoulder, elbow });
  }

  // 尾（7節）
  const tail = [];
  let parent = new THREE.Group(); parent.position.set(0, 0.02, -0.46); hips.add(parent);
  for (let i = 0; i < 7; i++) {
    const seg = new THREE.Group();
    if (i > 0) seg.position.set(0, 0, -0.4);
    parent.add(seg);
    const r0 = 0.3 * (1 - i / 8.2), r1 = 0.3 * (1 - (i + 1) / 8.2);
    seg.add(mesh(new THREE.CylinderGeometry(r0, r1 + 0.01, 0.44, 8), M.dark, { p: [0, 0, -0.2], r: [Math.PI / 2, 0, 0] }));
    seg.add(mesh(new THREE.ConeGeometry(0.075 * (1 - i / 9), 0.3 * (1 - i / 10), 6), M.blue, { p: [0, r0 * 0.9, -0.18], r: [-0.6, 0, 0] }));
    seg.rotation.x = i === 0 ? 0.3 : -0.06;
    tail.push(seg);
    parent = seg;
  }

  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  const localBox = new THREE.Box3().setFromObject(root);
  return { root, body, hips, spine, neck, head, chest, legs, arms, tail, mats: Object.values(M), glowMat: M.glow, localBox };
}

function animateKaiju(k, t, walkPhase, walkAmp, jitterX, lunge) {
  const a = walkAmp;
  const breathe = Math.sin(t * 1.6);
  k.body.position.set(jitterX, 0, lunge * 0.22);
  k.body.rotation.x = lunge * 0.12;
  k.hips.position.y = 1.28 + a * 0.06 * Math.abs(Math.sin(walkPhase)) + breathe * 0.012;
  k.hips.rotation.z = a * 0.05 * Math.sin(walkPhase);
  for (const leg of k.legs) {
    const s = leg.side < 0 ? 1 : -1;
    const swing = Math.sin(walkPhase) * s;
    leg.thigh.rotation.x = a * 0.42 * swing;
    leg.knee.rotation.x = a * 0.5 * Math.max(0, Math.cos(walkPhase + (s > 0 ? 0 : Math.PI)));
    leg.ankle.rotation.x = -leg.thigh.rotation.x * 0.6 - leg.knee.rotation.x * 0.4;
  }
  k.spine.rotation.x = 0.32 + breathe * 0.02 + lunge * 0.1;
  k.spine.rotation.z = a * 0.05 * Math.sin(walkPhase + 0.4);
  k.spine.scale.set(1 + breathe * 0.012, 1 + breathe * 0.008, 1 + breathe * 0.012);
  for (const arm of k.arms) {
    const s = arm.side < 0 ? -1 : 1;
    arm.shoulder.rotation.x = -0.15 - a * 0.28 * Math.sin(walkPhase) * s + Math.sin(t * 1.2 + s) * 0.04 - lunge * 0.5;
    arm.shoulder.rotation.z = s * (0.18 + Math.sin(t * 0.9 + s) * 0.03 + lunge * 0.25);
    arm.elbow.rotation.x = -0.35 - lunge * 0.4;
  }
  k.neck.rotation.x = -0.25 + Math.sin(t * 0.7) * 0.04 - lunge * 0.2;
  k.head.rotation.y = Math.sin(t * 0.45) * 0.18;
  k.head.rotation.x = Math.sin(t * 0.8) * 0.04;
  k.tail.forEach((seg, i) => {
    seg.rotation.y = 0.16 * Math.sin(t * 1.25 - i * 0.6) + a * 0.12 * Math.sin(walkPhase - i * 0.5);
  });
  k.glowMat.emissiveIntensity = 1.9 + 0.7 * (0.5 + 0.5 * breathe);
}

// -----------------------------------------------------------------------------
// 仮モデル：機体（v357 までの2Dの5機の形をなぞった簡単な形。機首は奥＝-Z。本番モデルが届くまでの間だけ出す）
// -----------------------------------------------------------------------------
// body・accent は、モデルを読み込むまでの間に出す仮の機体の色（v358 の機体の色に合わせた）。glow は噴射の色
const AIRCRAFT_LOOKS = [
  { body: 0x2a4cc0, accent: 0xff7a2e, glow: 0xffb35a },   // AA1 青と橙の双発機
  { body: 0x1fb0b4, accent: 0xff7a3c, glow: 0xa8ffd8 },   // AA2 青緑と橙の双発機
  { body: 0xd2262b, accent: 0xf2c232, glow: 0xffa24c },   // AA3 赤と黄の四発ガンシップ
  { body: 0x2f7fe0, accent: 0xffd23a, glow: 0xffd28c },   // AA4 青と黄の細身の機体
  { body: 0x1f6a3c, accent: 0xe8742a, glow: 0xffe3a4 },   // AA5 緑と橙の双発機
];

// XZ 平面の板（points は [x, z]。z は奥が負）
function flatShape(points) {
  const s = new THREE.Shape();
  points.forEach(([x, z], i) => (i ? s.lineTo(x, z) : s.moveTo(x, z)));
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.025, bevelEnabled: false });
  g.rotateX(Math.PI / 2);
  g.translate(0, 0.0125, 0);
  return g;
}

function makeAircraft(type) {
  const look = AIRCRAFT_LOOKS[type] || AIRCRAFT_LOOKS[0];
  const mats = {
    body: new THREE.MeshStandardMaterial({ color: look.body, roughness: 0.42, metalness: 0.35, flatShading: true }),
    accent: new THREE.MeshStandardMaterial({ color: look.accent, roughness: 0.5, metalness: 0.2, flatShading: true }),
    canopy: new THREE.MeshStandardMaterial({ color: 0x3a2a10, emissive: 0xffa53a, emissiveIntensity: 0.55, roughness: 0.2 }),
  };
  const glowMat = new THREE.MeshBasicMaterial({ color: look.glow, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const g = new THREE.Group();
  const add = (geo, mat, p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(...p); m.rotation.set(...r); m.scale.set(...s); m.castShadow = true; g.add(m); return m;
  };
  const engines = [];
  const engine = (x, y, z, r = 0.045, len = 0.18) => {
    add(new THREE.CylinderGeometry(r, r * 1.1, len, 8), mats.accent, [x, y, z], [Math.PI / 2, 0, 0]);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(r * 0.9, r * 4.5, 8, 1, true), glowMat);
    flame.rotation.x = Math.PI / 2;               // 先端を後ろ（+Z）へ
    flame.position.set(x, y, z + len / 2 + r * 2.25);
    flame.renderOrder = 4;
    g.add(flame); engines.push(flame);
  };
  const capsuleZ = (r, len, mat, p) => add(new THREE.CapsuleGeometry(r, len, 4, 10), mat, p, [Math.PI / 2, 0, 0]);
  if (type === 0) {
    capsuleZ(0.075, 0.52, mats.body, [0, 0.02, 0]);
    add(flatShape([[0, -0.2], [0.42, 0.24], [0.07, 0.2], [-0.07, 0.2], [-0.42, 0.24]]), mats.body);
    add(new THREE.BoxGeometry(0.5, 0.012, 0.035), mats.accent, [0, 0.03, 0.12]);
    add(new THREE.SphereGeometry(1, 10, 8), mats.canopy, [0, 0.07, -0.16], [0, 0, 0], [0.05, 0.04, 0.1]);
    engine(-0.065, 0.0, 0.3); engine(0.065, 0.0, 0.3);
  } else if (type === 1) {
    capsuleZ(0.045, 0.7, mats.body, [0, 0.02, 0]);
    for (const side of [-1, 1]) {
      add(new THREE.TorusGeometry(0.27, 0.026, 5, 20, 4.2), mats.body, [side * 0.2, 0.02, 0.04], [Math.PI / 2, 0, side > 0 ? -2.1 : 1.0]);
      add(new THREE.CapsuleGeometry(0.035, 0.16, 3, 8), mats.accent, [side * 0.08, 0.02, 0.05], [Math.PI / 2, 0, 0]);
    }
    add(new THREE.SphereGeometry(1, 10, 8), mats.canopy, [0, 0.055, -0.18], [0, 0, 0], [0.035, 0.03, 0.09]);
    engine(0, 0.0, 0.4, 0.035, 0.12);
  } else if (type === 2) {
    add(new THREE.BoxGeometry(0.34, 0.15, 0.62), mats.body, [0, 0.02, 0]);
    add(new THREE.BoxGeometry(0.16, 0.12, 0.42), mats.accent, [0, 0.1, -0.02]);
    for (const side of [-1, 1]) {
      add(new THREE.BoxGeometry(0.14, 0.1, 0.5), mats.body, [side * 0.26, 0.0, 0.04]);
      add(new THREE.BoxGeometry(0.2, 0.025, 0.2), mats.accent, [side * 0.4, 0.0, 0.0]);
    }
    add(new THREE.SphereGeometry(1, 10, 8), mats.canopy, [0, 0.12, -0.24], [0, 0, 0], [0.06, 0.04, 0.08]);
    for (const x of [-0.27, -0.09, 0.09, 0.27]) engine(x, -0.01, 0.37, 0.05, 0.14);
  } else if (type === 3) {
    capsuleZ(0.05, 0.62, mats.body, [0, 0.02, 0]);
    add(flatShape([[0, -0.28], [0.5, 0.26], [0.44, 0.31], [0.05, 0.08], [-0.05, 0.08], [-0.44, 0.31], [-0.5, 0.26]]), mats.body);
    for (const side of [-1, 1]) add(new THREE.BoxGeometry(0.34, 0.014, 0.03), mats.accent, [side * 0.22, 0.03, 0.06], [0, side * -0.82, 0]);
    add(new THREE.SphereGeometry(1, 10, 8), mats.canopy, [0, 0.06, -0.2], [0, 0, 0], [0.04, 0.032, 0.1]);
    engine(-0.04, 0.0, 0.36, 0.035, 0.12); engine(0.04, 0.0, 0.36, 0.035, 0.12);
  } else {
    add(new THREE.CylinderGeometry(0.36, 0.36, 0.09, 6), mats.body, [0, 0.0, 0], [0, Math.PI / 6, 0]);
    add(new THREE.TorusGeometry(0.22, 0.03, 5, 18), mats.accent, [0, 0.05, 0], [Math.PI / 2, 0, 0]);
    add(new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mats.accent, [0, 0.045, 0], [0, 0, 0], [0.13, 0.09, 0.13]);
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2 + Math.PI / 6;
      const spike = add(new THREE.ConeGeometry(0.04, 0.2, 6), mats.accent, [Math.sin(a) * 0.42, 0, -Math.cos(a) * 0.42]);
      spike.lookAt(Math.sin(a) * 2, 0, -Math.cos(a) * 2);   // +Z を外向きに
      spike.rotateX(Math.PI / 2);                           // 円錐の先（+Y）を外向きに
    }
    add(new THREE.SphereGeometry(1, 10, 8), mats.canopy, [0, 0.05, -0.34], [0, 0, 0], [0.05, 0.035, 0.06]);
    engine(-0.12, -0.02, 0.3, 0.04, 0.12); engine(0.12, -0.02, 0.3, 0.04, 0.12);
  }
  g.scale.setScalar(1.15);
  const matList = [mats.body, mats.accent, mats.canopy];
  return {
    real: false, group: g, engines, mats: matList, glowMat, type,
    setAlpha: a => setOpacity(matList, a),
    dispose() { disposeObject(g); },
  };
}

function setOpacity(mats, alpha) {
  for (const m of mats) {
    const t = alpha < 0.999;
    if (m.transparent !== t) { m.transparent = t; m.depthWrite = !t; m.needsUpdate = true; }
    m.opacity = alpha;
  }
}

// -----------------------------------------------------------------------------
// 仮モデル：ミサイル（誘導弾・赤い弾頭）と麻酔弾（細身・緑の弾頭）
// -----------------------------------------------------------------------------
function makeProjectile(kind, glowTex) {
  const g = new THREE.Group();
  const fire = kind === 'fire';
  const bodyMat = new THREE.MeshStandardMaterial({ color: fire ? 0xf2efe6 : 0xd7e4e8, roughness: 0.35, metalness: 0.4, flatShading: true });
  const tipMat = new THREE.MeshStandardMaterial({ color: fire ? 0xd63a2e : 0x2fd6a4, emissive: fire ? 0x5a0d08 : 0x0e6a50, emissiveIntensity: 1, roughness: 0.4 });
  const bodyR = fire ? 0.034 : 0.02;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(bodyR, bodyR, fire ? 0.32 : 0.3, 8), bodyMat);
  body.rotation.x = Math.PI / 2; g.add(body);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(bodyR, fire ? 0.11 : 0.09, 8), tipMat);
  tip.rotation.x = -Math.PI / 2; tip.position.z = -(fire ? 0.215 : 0.195); g.add(tip);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(fire ? 0.11 : 0.08, 0.006, fire ? 0.07 : 0.09), fire ? bodyMat : tipMat);
    fin.position.z = 0.12; fin.rotation.z = i * Math.PI / 2; g.add(fin);
  }
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: fire ? 0xffa04a : 0x7dffd8, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
  glow.scale.setScalar(fire ? 0.34 : 0.24); glow.position.z = fire ? 0.2 : 0.17; glow.renderOrder = 6; g.add(glow);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.scale.setScalar(1.75);
  const trail = [];
  for (let i = 0; i < 9; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: fire ? 0xffd2a0 : 0xbfffee, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.62 * (1 - i / 9), toneMapped: false }));
    s.scale.setScalar((fire ? 0.3 : 0.2) * (1 - i / 12));
    s.renderOrder = 6;
    trail.push(s);
  }
  return { group: g, trail };
}

// =============================================================================
// 本番モデルの読み込み（v354〜）
// -----------------------------------------------------------------------------
// models/<名前>-v354.js が window.NOAH3D_MODEL_DATA[名前] に GLB（base64）を入れる。<script> で読むので、
// HTMLビューアー（file://）でも読める。GLB の中の画像は、ページの中で作った blob: の URL から <img> で読み、
// WebGL に渡せるか（ブラウザの安全のための制限に掛からないか）を確かめてから使う。だめなら仮モデルのまま。
// 3D⇄2D を切り替えても読み直さないよう、GLB のデータ（ArrayBuffer）はページを開いている間とっておく。
// =============================================================================
const MODEL_DIR = './models/';
// models/ のファイル名。中身を変えたときはファイル名ごと変える（端末に保存した古い版を使わないように）。
const MODEL_FILES = {
  celevarn: 'celevarn-v354', AA1: 'aa1-v358', AA2: 'aa2-v358', AA3: 'aa3-v358', AA4: 'aa4-v358', AA5: 'aa5-v358',   // v358：機体を新しいモデルに
  tree: 'tree-v354', rock: 'rock-v354',
  // HTMLビューアー（file://）用の地面の画像（v355〜）。ふつうの画像は file:// では3Dに使えないため、文字にして埋め込んだもの
  'ground-forest': 'ground-forest-v355', 'ground-seafloor': 'ground-seafloor-v355',
};
const GLTF_LOADER_SRC = './vendor/three-r170-gltfloader.min.js';
const AIRCRAFT_MODEL_NAMES = ['AA1', 'AA2', 'AA3', 'AA4', 'AA5'];
const KAIJU_MODEL_NAME = 'celevarn';
const modelBuffers = new Map();
let gltfLoaderReady = null, webpReady = null;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => { el.remove(); reject(new Error('読み込めませんでした: ' + src)); };
    document.head.appendChild(el);
  });
}
function ensureGLTFLoader() {
  if (window.NOAH_GLTFLoader) return Promise.resolve();
  if (!gltfLoaderReady) {
    gltfLoaderReady = loadScriptOnce(GLTF_LOADER_SRC)
      .then(() => { if (!window.NOAH_GLTFLoader) throw new Error('GLTFLoader がありません'); })
      .catch(err => { gltfLoaderReady = null; throw err; });
  }
  return gltfLoaderReady;
}
// WebP を表示できる端末か（iOS 14 以降は可）
function ensureWebP() {
  if (!webpReady) {
    webpReady = new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img.width > 0 && img.height > 0);
      img.onerror = () => resolve(false);
      img.src = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
    });
  }
  return webpReady;
}
function base64ToBuffer(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
function modelBuffer(name) {
  if (modelBuffers.has(name)) return modelBuffers.get(name);
  const p = (async () => {
    if (!(await ensureWebP())) throw new Error('WebP の画像を表示できない端末です');
    const store = () => window.NOAH3D_MODEL_DATA || {};
    if (!MODEL_FILES[name]) throw new Error('モデルの名前が登録されていません: ' + name);
    if (!store()[name]) await loadScriptOnce(`${MODEL_DIR}${MODEL_FILES[name]}.js`);
    const b64 = store()[name];
    if (typeof b64 !== 'string' || !b64) throw new Error('モデルのデータがありません: ' + name);
    delete window.NOAH3D_MODEL_DATA[name];      // 文字列のままでは持たない（メモリの節約）
    return base64ToBuffer(b64);
  })();
  modelBuffers.set(name, p);
  p.catch(() => { if (modelBuffers.get(name) === p) modelBuffers.delete(name); });   // 失敗したら次の機会に読み直す
  return p;
}

// 画像を WebGL に渡せるか（HTMLビューアーなどで、画像が「別の場所のもの」扱いになると渡せない）
function imageSafeForWebGL(img) {
  try {
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, 1, 1); g.getImageData(0, 0, 1, 1);
    return true;
  } catch (e) { return false; }
}
// GLTFLoader の画像の読み込み役の代わり（いつも <img> で読む。iOS の古い版の ImageBitmap の不具合も避けられる）
// 画像の展開（数十ミリ秒かかる）は img.decode() で裏で済ませ、画面の動きを止めないようにする（v355〜）
function loadImageDecoded(url) {
  return new Promise((resolve, reject) => {
    const img = document.createElement('img');
    let settled = false;
    const ok = () => { if (!settled) { settled = true; img.onload = img.onerror = null; resolve(img); } };
    const ng = () => { if (!settled) { settled = true; img.onload = img.onerror = null; reject(new Error('画像を読み込めませんでした')); } };
    img.src = url;
    if (typeof img.decode === 'function') img.decode().then(ok, () => { if (img.complete && img.naturalWidth) ok(); else { img.onload = ok; img.onerror = ng; } });
    else { img.onload = ok; img.onerror = ng; }
  });
}
const safeImageLoader = {
  load(url, onLoad, onProgress, onError) {
    loadImageDecoded(url).then(img => {
      if (!imageSafeForWebGL(img)) throw new Error('この画像は3Dに使えません（ブラウザの安全のための制限）');
      const tex = new THREE.Texture(img);
      tex.needsUpdate = true;
      onLoad(tex);
    }).catch(err => { if (onError) onError(err); });
  },
};
// ひと息つく（重い処理の合間に、タップや音の処理を先に通す）
const yieldToUi = (ms = 0) => new Promise(r => setTimeout(r, ms));
function parseModel(name) {
  return Promise.all([modelBuffer(name), ensureGLTFLoader()]).then(([buffer]) => new Promise((resolve, reject) => {
    const loader = new window.NOAH_GLTFLoader();
    loader.register(parser => { parser.textureLoader = safeImageLoader; return { name: 'NOAH_safe_images' }; });
    loader.parse(buffer, '', resolve, reject);
  }));
}
function disposeObject(root) {
  root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    mats.forEach(m => {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap']) if (m[k]) m[k].dispose();
      m.dispose();
    });
  });
}

// -----------------------------------------------------------------------------
// 半透明にするとき（退場する怪獣・帰還中の機体・移動先の半透明の機体）に、体の奥の面が透けて見えないよう、
// 先に「奥行きだけ」を書く影を重ねる。order は半透明のときの描く順番（小さいほど先）。
// -----------------------------------------------------------------------------
function makeFader(meshes, order) {
  const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true, opacity: 1 });
  const pre = meshes.map(m => {
    let d;
    if (m.isSkinnedMesh) { d = new THREE.SkinnedMesh(m.geometry, depthMat); d.bind(m.skeleton, m.bindMatrix); }
    else d = new THREE.Mesh(m.geometry, depthMat);
    d.position.copy(m.position); d.quaternion.copy(m.quaternion); d.scale.copy(m.scale);
    d.frustumCulled = m.frustumCulled;
    d.visible = false;
    d.renderOrder = order - 0.05;
    d.userData.noahDepthOnly = true;
    m.parent.add(d);
    return d;
  });
  const mats = [...new Set(meshes.map(m => m.material))];
  let alpha = 1;
  return {
    mats,
    set(a) {
      if (a === alpha) return;
      alpha = a;
      const t = a < 0.999;
      for (const m of mats) {
        if (m.transparent !== t) { m.transparent = t; m.depthWrite = !t; m.needsUpdate = true; }
        m.opacity = a;
      }
      meshes.forEach(m => { m.renderOrder = t ? order : 0; });
      pre.forEach(d => { d.visible = t; });
    },
    dispose() { depthMat.dispose(); pre.forEach(d => { if (d.parent) d.parent.remove(d); }); },
  };
}

// -----------------------------------------------------------------------------
// 本番の怪獣（セレヴァーン）。Meshy の Smart Rig の骨をモデルの座標の軸で回して動かす。
//  ・Meshy のモデルは下半身は正面を向いているが、上半身と顔が正面から約12°左（-X）を向いていたので、
//    全体を +12° 回して顔を正面（カメラ側 +Z）に向けた（足先はわずかに右を向くが、ほとんど目立たない）。
//  ・首の骨（Bone_026/025）にはほとんど重みが付いていないので、頭は Bone_024 で動かす。
// -----------------------------------------------------------------------------
const KAIJU_MODEL = {
  yawDeg: 12,          // 顔を正面へ
  height: 3.0,         // 3マス（2Dの絵と同じ「見えている体の高さ＝3マス」）
  stepsPerCell: 1,     // 地形が1マス流れる間に1歩（足が地面に対して滑らない歩幅）
  bones: {
    hips: 'Bone_000', spine: ['Bone_004', 'Bone_003', 'Bone_002'], head: 'Bone_024', jaw: 'Bone_042',
    legs: [['Bone_009', 'Bone_008', 'Bone_007'], ['Bone_014', 'Bone_013', 'Bone_012']],     // 太もも・すね・足首（-X 側, +X 側）
    arms: [['Bone_036', 'Bone_035', 'Bone_034'], ['Bone_040', 'Bone_039', 'Bone_038']],     // 鎖骨・上腕・前腕
    tail: ['Bone_023', 'Bone_022', 'Bone_021', 'Bone_020', 'Bone_019', 'Bone_018', 'Bone_017', 'Bone_016', 'Bone_015'],
    ankles: ['Bone_006', 'Bone_011'],
  },
};

function makeKaijuFromModel(gltf) {
  const model = gltf.scene;
  const skinned = [];
  model.traverse(o => { if (o.isSkinnedMesh) skinned.push(o); });
  if (!skinned.length) throw new Error('怪獣のモデルに骨のあるメッシュがありません');
  const root = new THREE.Group();     // 足元（index 側の y=1.5 のマスの中心）
  const body = new THREE.Group();     // 攻撃の揺れ・突進
  const holder = new THREE.Group();   // 向き・大きさ・原点合わせ
  root.add(body); body.add(holder); holder.add(model);
  holder.rotation.y = THREE.MathUtils.degToRad(KAIJU_MODEL.yawDeg);
  root.updateMatrixWorld(true);
  const box0 = new THREE.Box3().setFromObject(holder);
  holder.scale.setScalar(KAIJU_MODEL.height / Math.max(1e-6, box0.max.y - box0.min.y));
  root.updateMatrixWorld(true);
  const byName = {};
  model.traverse(o => { if (o.isBone) byName[o.name] = o; });
  const BN = KAIJU_MODEL.bones;
  // 原点：左右は腰と両足首の真ん中、前後は両足首の真ん中、高さは足の裏
  const box = new THREE.Box3().setFromObject(holder);
  let cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
  const hipsB = byName[BN.hips], a0 = byName[BN.ankles[0]], a1 = byName[BN.ankles[1]];
  if (hipsB && a0 && a1) {
    const h = hipsB.getWorldPosition(new THREE.Vector3()), p0 = a0.getWorldPosition(new THREE.Vector3()), p1 = a1.getWorldPosition(new THREE.Vector3());
    cx = (h.x + (p0.x + p1.x) / 2) / 2; cz = (p0.z + p1.z) / 2;
  }
  holder.position.set(-cx, -box.min.y, -cz);
  root.updateMatrixWorld(true);
  const localBox = new THREE.Box3().setFromObject(root);

  const mats = [];
  skinned.forEach(m => {
    m.castShadow = true; m.receiveShadow = false; m.frustumCulled = false;
    if (!mats.includes(m.material)) mats.push(m.material);
  });
  const glowMats = mats.filter(m => m.emissiveMap);
  glowMats.forEach(m => { m.emissive.set(0xffffff); m.emissiveIntensity = 1.2; });

  // 骨：バインド時の「モデルの座標から見た向き」を覚えておき、モデルの座標の軸で回す
  const modelInvQ = model.getWorldQuaternion(new THREE.Quaternion()).invert();
  const rig = name => {
    const b = byName[name];
    if (!b) return null;
    const w = b.getWorldQuaternion(new THREE.Quaternion()).premultiply(modelInvQ);
    return { bone: b, local: b.quaternion.clone(), pos: b.position.clone(), w, wInv: w.clone().invert() };
  };
  const R = {
    hips: rig(BN.hips), spine: BN.spine.map(rig), head: rig(BN.head), jaw: rig(BN.jaw),
    legs: BN.legs.map(l => l.map(rig)), arms: BN.arms.map(l => l.map(rig)), tail: BN.tail.map(rig),
  };
  const Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion(), E = new THREE.Euler();
  function pose(b, x, y, z) {
    if (!b) return;
    E.set(x, y, z, 'YXZ'); Q.setFromEuler(E);
    Q2.copy(b.wInv).multiply(Q).multiply(b.w);
    b.bone.quaternion.copy(b.local).multiply(Q2);
  }
  const fader = makeFader(skinned, 0);
  const head = R.head ? R.head.bone : model;

  // scroll … 地形の流れた量（マス）。a … 歩きの強さ 0〜1。lunge … 攻撃の突進 0〜1。charge … 必殺技の溜め 0〜1
  function animate(t, scroll, a, jitterX, lunge, charge) {
    const ph = scroll * Math.PI * KAIJU_MODEL.stepsPerCell;
    const breathe = Math.sin(t * 1.6);
    body.position.set(jitterX, 0, lunge * 0.22);
    body.rotation.x = lunge * 0.05;
    if (R.hips) {
      R.hips.bone.position.copy(R.hips.pos);
      R.hips.bone.position.y += a * 0.012 * Math.cos(ph * 2) - charge * 0.03 + breathe * 0.002;
      pose(R.hips, 0, a * 0.05 * Math.sin(ph), a * 0.022 * Math.sin(ph));
    }
    // 脚：太もも（前後に振る）・すね（振り出すときに持ち上げる）・足首（足をほぼ水平に保つ）。溜めでは少しかがむ
    R.legs.forEach((leg, i) => {
      const p = ph + (i ? Math.PI : 0);
      const swing = a * 0.34 * Math.sin(p) - 0.14 * charge;
      const lift = a * 0.5 * Math.max(0, -Math.cos(p)) + 0.24 * charge;
      pose(leg[0], swing, 0, 0);
      pose(leg[1], lift, 0, 0);
      pose(leg[2], -(swing + lift) * 0.85, 0, 0);
    });
    // 背骨：呼吸・突進で前へ・溜めで胸を反らす
    pose(R.spine[0], lunge * 0.09 - charge * 0.05 + breathe * 0.008, -a * 0.04 * Math.sin(ph), 0);
    pose(R.spine[1], lunge * 0.06 - charge * 0.05 + breathe * 0.012, -a * 0.03 * Math.sin(ph), 0);
    pose(R.spine[2], lunge * 0.05 - charge * 0.08 + breathe * 0.01, 0, 0);
    // 腕：同じ側の脚と逆に振る。突進で刃を前へ、溜めで左右に広げる
    R.arms.forEach((arm, i) => {
      const side = i ? 1 : -1;
      const p = ph + (i ? Math.PI : 0);
      const swing = -a * 0.2 * Math.sin(p) + Math.sin(t * 1.2 + i * 1.7) * 0.03;
      pose(arm[0], 0, 0, side * (breathe * 0.015 + charge * 0.08));
      pose(arm[1], swing - lunge * 0.75 - charge * 0.2, 0, side * (lunge * 0.22 + charge * 0.45));
      pose(arm[2], -lunge * 0.45 - charge * 0.3, 0, 0);
    });
    // 頭：ゆっくり見回す。突進で前へ、溜めで上を向いて口を開く
    pose(R.head, Math.sin(t * 0.8) * 0.035 + lunge * 0.12 - charge * 0.22, Math.sin(t * 0.45) * 0.14 * (1 - charge), 0);
    pose(R.jaw, lunge * 0.35 + charge * 0.25, 0, 0);
    // 尾：根元から先へ伝わる波
    R.tail.forEach((b, i) => pose(b, -charge * 0.03, 0.045 * Math.sin(t * 1.25 - i * 0.55) + a * 0.035 * Math.sin(ph - i * 0.5), 0));
    // 喉〜胸の器官の光：呼吸に合わせて明滅、溜めで強く脈打つ
    for (const m of glowMats) m.emissiveIntensity = 1.0 + 0.5 * (0.5 + 0.5 * breathe) + charge * (1.6 + 1.2 * Math.sin(t * 9));
  }
  // 足首の骨（-X 側, +X 側）。歩きの周期で足が地面に着くのは、地形が「1.5マス（-X 側）・0.5マス（+X 側）＋2マスごと」流れたとき
  //（前へ歩くとき。後ろへ下がるときは左右が入れ替わる）。砂ぼこりはそこに出す（v356〜）
  const feet = BN.ankles.map(n => byName[n] || null);
  return {
    real: true, root, body, head, localBox, mats, skinned, animate, feet,
    setAlpha: a => { fader.set(a); skinned.forEach(m => { m.castShadow = a > 0.35; }); },
    dispose() { fader.dispose(); disposeObject(root); },
  };
}

// -----------------------------------------------------------------------------
// 本番の機体。噴射口の位置（機首 -Z・全幅1にそろえた座標）に、仮モデルと同じ揺らめく炎を付ける
// -----------------------------------------------------------------------------
// 噴射口の位置 [x, y, z, 太さ]（v358 の機体。後ろから正射影で撮って、噴射口の中心に合わせた。太さは 1 で半径 0.028）
const AIRCRAFT_ENGINES = [
  [[-0.093, 0.006, 0.44, 1.25], [0.093, 0.006, 0.44, 1.25]],                                              // AA1
  [[-0.082, 0.058, 0.44, 0.85], [0.082, 0.058, 0.44, 0.85]],                                              // AA2
  [[-0.187, 0.005, 0.395, 1.0], [-0.078, 0.005, 0.395, 1.0], [0.079, 0.005, 0.395, 1.0], [0.187, 0.005, 0.395, 1.0]],   // AA3
  [[-0.031, 0.022, 0.44, 0.7], [0.029, 0.022, 0.44, 0.7]],                                                // AA4
  [[-0.186, 0.004, 0.44, 1.25], [0.182, 0.004, 0.44, 1.25]],                                              // AA5
];
function makeAircraftFromModel(template, type) {
  const look = AIRCRAFT_LOOKS[type] || AIRCRAFT_LOOKS[0];
  const g = new THREE.Group();
  const model = template.clone(true);          // 形と画像は共有し、材質だけ機体ごとに複製（半透明を別々にするため）
  const meshes = [];
  model.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); o.castShadow = true; o.receiveShadow = false; meshes.push(o); } });
  g.add(model);
  model.updateMatrixWorld(true);
  const glowMat = new THREE.MeshBasicMaterial({ color: look.glow, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const flameGeo = new THREE.ConeGeometry(0.028, 0.15, 8, 1, true);
  const engines = [];
  for (const [x, y, z, r = 1] of (AIRCRAFT_ENGINES[type] || [])) {
    const flame = new THREE.Mesh(flameGeo, glowMat);
    flame.rotation.x = Math.PI / 2;     // 先端を後ろ（+Z）へ
    flame.userData.r = r;                 // 太さ（噴射口の大きさに合わせる）。長さも少しだけ合わせる
    flame.userData.len = 0.75 + 0.25 * r;
    flame.scale.set(r, flame.userData.len, r);
    flame.position.set(x, y, z + 0.075 * flame.userData.len);
    flame.renderOrder = 4;
    g.add(flame); engines.push(flame);
  }
  const fader = makeFader(meshes, 3.5);
  return {
    real: true, group: g, engines, glowMat, type, mats: fader.mats,
    setAlpha: a => fader.set(a),
    dispose() { fader.dispose(); meshes.forEach(m => m.material.dispose()); flameGeo.dispose(); glowMat.dispose(); },
  };
}

// -----------------------------------------------------------------------------
// 映り込み用の空（ステージの色のグラデーション）。金属の機体や怪獣の甲殻に、空と地面の色を映す
// -----------------------------------------------------------------------------
function makeEnvironment(renderer, look) {
  const pm = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 32, 16);
  const pos = geo.attributes.position;
  const sky = new THREE.Color(look.sky), hor = new THREE.Color(look.fog), gnd = new THREE.Color(look.ground);
  const c = new THREE.Color(), col = [];
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    if (y >= 0) c.copy(hor).lerp(sky, Math.pow(y, 0.55)); else c.copy(hor).lerp(gnd, Math.pow(-y, 0.45));
    col.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true }));
  envScene.add(dome);
  const sunGeo = new THREE.SphereGeometry(1.1, 16, 8);
  const sunMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(look.sun).multiplyScalar(look.envSun || 3) });
  const sunBlob = new THREE.Mesh(sunGeo, sunMat);
  sunBlob.position.set(-5.5, 12, 6.5).normalize().multiplyScalar(8.5);
  envScene.add(sunBlob);
  const rt = pm.fromScene(envScene, 0.035);
  pm.dispose(); geo.dispose(); dome.material.dispose(); sunGeo.dispose(); sunMat.dispose();
  return rt;
}

// -----------------------------------------------------------------------------
// 左右の景色（森林：木／海底：岩山）。地形と一緒にスクロールする
// -----------------------------------------------------------------------------
const SCENERY_ZMIN = -24, SCENERY_PERIOD = 34;

// 木・岩山は数が多く画面の左右を広く覆うので、光の計算の軽い材質にする（ざらざらした物なので見た目はほぼ同じ）
function toLambert(root) {
  root.traverse(o => {
    if (!o.isMesh || o.material.isMeshLambertMaterial) return;
    const src = o.material;
    const lam = new THREE.MeshLambertMaterial({
      map: src.map || null, normalMap: src.normalMap || null, color: src.color ? src.color.clone() : 0xffffff,
      side: src.side, alphaTest: src.alphaTest || 0, transparent: false,
    });
    if (src.normalScale) lam.normalScale.copy(src.normalScale);
    if (lam.alphaTest > 0) lam.alphaToCoverage = true;     // 葉の縁を滑らかに（マルチサンプル）
    o.material = lam;
    src.dispose();
  });
}

// 本番モデルのメッシュ（1つ）から、並べる用の形と材質を取り出す
function sceneryParts(template) {
  let mesh = null;
  template.traverse(o => { if (o.isMesh && !mesh) mesh = o; });
  if (!mesh) return null;
  template.updateMatrixWorld(true);
  // tools/noah_glb_optimize.py の出力は位置・向きを頂点に焼き込んであるので、そのまま使える（形と材質は元のモデルと共有）
  if (!mesh.matrixWorld.equals(new THREE.Matrix4())) return null;
  return { geometry: mesh.geometry, material: mesh.material };
}

function buildScenery(stage, templates = {}) {
  const real = stage === 'seafloor' ? templates.rock : templates.tree;
  if (real) {
    const parts = sceneryParts(real);
    if (parts) return buildRealScenery(stage, parts);
  }
  const group = new THREE.Group();
  const items = [];
  const r = rng(stage === 'seafloor' ? 917 : 331);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  let meshes = [];
  const col = new THREE.Color();
  if (stage === 'seafloor') {
    const N = 240;
    const rocks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0.02, flatShading: true }), N);
    rocks.castShadow = true; rocks.receiveShadow = true;
    for (let i = 0; i < N; i++) {
      const side = r() < 0.5 ? -1 : 1;
      const ax = 2.0 + Math.pow(r(), 0.8) * 9;            // 道の中心からの距離
      // 道に近いほど小さく、外側ほど大きな岩山に（道へはみ出さない）
      const maxR = Math.min(1.6, (ax - 1.9) * 0.55);
      const rad = Math.max(0.08, maxR * (0.35 + r() * 0.65));
      const tall = Math.min(2.2, 0.3 + (ax - 2) * 0.32) * (0.55 + r() * 0.45);
      items.push({ mesh: rocks, i, x: side * ax, z0: SCENERY_ZMIN + r() * SCENERY_PERIOD, y: tall * 0.3, s: [rad, tall, rad * (0.8 + r() * 0.4)], rot: [r() * 0.4, r() * Math.PI * 2, r() * 0.4] });
      col.setHSL(0.5 + r() * 0.05, 0.16 + r() * 0.12, 0.2 + r() * 0.13);
      rocks.setColorAt(i, col);
    }
    meshes = [rocks];
  } else {
    const N = 320;
    const trunkGeo = new THREE.CylinderGeometry(0.035, 0.05, 1, 5); trunkGeo.translate(0, 0.5, 0);
    const crownGeo = new THREE.ConeGeometry(1, 1, 7); crownGeo.translate(0, 0.5, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1, flatShading: true }), N);
    const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), N);
    crowns.castShadow = true; crowns.receiveShadow = true; trunks.castShadow = true;
    for (let i = 0; i < N; i++) {
      const side = r() < 0.5 ? -1 : 1;
      const x = side * (2.15 + Math.pow(r(), 0.9) * 8.3);
      const h = 0.5 + r() * 0.36;
      const rad = 0.2 + r() * 0.14;
      const z0 = SCENERY_ZMIN + r() * SCENERY_PERIOD;
      const yaw = r() * Math.PI * 2;
      items.push({ mesh: trunks, i, x, z0, y: 0, s: [1, h * 0.38, 1], rot: [0, yaw, 0] });
      items.push({ mesh: crowns, i, x, z0, y: h * 0.25, s: [rad, h * 0.8, rad], rot: [0, yaw, 0] });
      col.setHSL(0.27 + r() * 0.08, 0.42 + r() * 0.2, 0.17 + r() * 0.12);
      crowns.setColorAt(i, col);
    }
    meshes = [trunks, crowns];
  }
  meshes.forEach(m => { m.frustumCulled = false; group.add(m); if (m.instanceColor) m.instanceColor.needsUpdate = true; });
  let lastScroll = NaN;
  function update(scroll) {
    if (scroll === lastScroll) return;
    lastScroll = scroll;
    for (const it of items) {
      let z = it.z0 - scroll;
      z = ((z - SCENERY_ZMIN) % SCENERY_PERIOD + SCENERY_PERIOD) % SCENERY_PERIOD + SCENERY_ZMIN;
      pos.set(it.x, it.y, z);
      e.set(it.rot[0], it.rot[1], it.rot[2]); q.setFromEuler(e);
      scl.set(it.s[0], it.s[1], it.s[2]);
      m4.compose(pos, q, scl);
      it.mesh.setMatrixAt(it.i, m4);
    }
    meshes.forEach(m => { m.instanceMatrix.needsUpdate = true; });
  }
  function dispose() { meshes.forEach(m => { m.geometry.dispose(); m.material.dispose(); m.dispose(); }); }
  return { group, update, dispose, real: false };
}

// 本番モデルの木（森林）・岩山（海底）。同じ形を、大きさ・向き・色を少しずつ変えて並べる（InstancedMesh）。
// 本数が多いので、カメラに映る分（と影が映りそうな少し外側）だけを毎回選んで描く。
function buildRealScenery(stage, parts) {
  const sea = stage === 'seafloor';
  const group = new THREE.Group();
  const items = [];
  const r = rng(sea ? 917 : 331);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const N = sea ? 110 : 150;
  const mesh = new THREE.InstancedMesh(parts.geometry, parts.material, N);
  // 影は怪獣と機体だけにする（木・岩山の影まで毎回描くと重いため。v355〜）
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.count = 0;
  for (let i = 0; i < N; i++) {
    const side = r() < 0.5 ? -1 : 1;
    const color = new THREE.Color();
    if (sea) {
      // 道に近いほど小さく、外側ほど大きな岩山に（道へはみ出さない）。仮モデルと同じ並べ方
      const ax = 2.0 + Math.pow(r(), 0.85) * 7.2;
      const maxR = Math.min(1.6, (ax - 1.9) * 0.55);
      const rad = Math.max(0.08, maxR * (0.35 + r() * 0.65));
      const tall = Math.min(2.2, 0.3 + (ax - 2) * 0.32) * (0.55 + r() * 0.45);
      const sy = tall * 1.3, sxz = rad * 1.8;
      const s = [sxz * (0.85 + r() * 0.3), sy, sxz * (0.85 + r() * 0.3)];
      items.push({ x: side * ax, z0: SCENERY_ZMIN + r() * SCENERY_PERIOD, y: -0.05 * sy, s, rot: [(r() - 0.5) * 0.16, r() * Math.PI * 2, (r() - 0.5) * 0.16], cy: sy * 0.45, rad: Math.max(s[0], s[2]) * 0.6 + sy * 0.3, color });
      const k = 0.78 + r() * 0.3;
      color.setRGB(k * (0.94 + r() * 0.08), k, k * (0.96 + r() * 0.08));
    } else {
      const x = side * (2.25 + Math.pow(r(), 1.2) * 5.7);
      const h = 0.58 + r() * 0.46;
      items.push({ x, z0: SCENERY_ZMIN + r() * SCENERY_PERIOD, y: -0.02, s: [h * (0.88 + r() * 0.24), h, h * (0.88 + r() * 0.24)], rot: [(r() - 0.5) * 0.08, r() * Math.PI * 2, (r() - 0.5) * 0.08], cy: h * 0.5, rad: h * 0.6, color });
      const k = 0.8 + r() * 0.28, warm = r();
      color.setRGB(k * (0.92 + warm * 0.12), k, k * (0.9 + (1 - warm) * 0.1));
    }
  }
  group.add(mesh);
  const sphere = new THREE.Sphere();
  let lastScroll = NaN, lastVisible = '', lite = false;
  // scroll … 地形の流れた量（マス）。frustum … カメラに映る範囲（無ければ全部描く）
  function update(scroll, frustum) {
    if (scroll !== lastScroll) {
      lastScroll = scroll; lastVisible = '';
      for (const it of items) {
        let z = it.z0 - scroll;
        it.z = ((z - SCENERY_ZMIN) % SCENERY_PERIOD + SCENERY_PERIOD) % SCENERY_PERIOD + SCENERY_ZMIN;
      }
    }
    const vis = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      sphere.center.set(it.x, it.cy, it.z); sphere.radius = it.rad + 1.2;
      if (!frustum || frustum.intersectsSphere(sphere)) vis.push(i);
    }
    const key = vis.join(',');
    if (key === lastVisible) return;
    lastVisible = key;
    vis.forEach((idx, k) => {
      const it = items[idx];
      pos.set(it.x, it.y, it.z);
      e.set(it.rot[0], it.rot[1], it.rot[2]); q.setFromEuler(e);
      scl.set(it.s[0], it.s[1], it.s[2]);
      m4.compose(pos, q, scl);
      mesh.setMatrixAt(k, m4);
      mesh.setColorAt(k, it.color);
    });
    mesh.count = vis.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }
  // 形と材質は本番モデルのものを共有しているので、ここでは並べた分だけ片付ける
  function dispose() { mesh.dispose(); }
  // いちばん軽い段では木・岩山を出さない（地面の画像だけでも左右の森・岩場は見える）
  return { group, update, dispose, real: true, meshes: [mesh], visibleCount: () => (group.visible ? mesh.count : 0), total: N, setLite(on) { lite = !!on; group.visible = !lite; } };
}

// =============================================================================
// 本体
// =============================================================================
function start(bridge) {
  const host = bridge.host;
  const board2d = bridge.boardCanvas;
  const saved2dStyle = {};
  for (const k of ['position', 'left', 'top', 'transform', 'transformOrigin', 'pointerEvents', 'zIndex', 'willChange']) saved2dStyle[k] = board2d.style[k];

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  const cleanups = [];
  try {
    return run();
  } catch (err) {
    cleanups.forEach(fn => { try { fn(); } catch (e) {} });
    try { renderer.dispose(); renderer.domElement.remove(); } catch (e) {}
    Object.assign(board2d.style, saved2dStyle);
    throw err;
  }

  function run() {
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.className = 'noah3dCanvas';
  Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', touchAction: 'none', zIndex: '1', display: 'block' });
  host.insertBefore(canvas, host.firstChild);
  cleanups.push(() => canvas.remove());
  Object.assign(board2d.style, { position: 'absolute', left: '0', top: '0', transform: '', transformOrigin: '0 0', pointerEvents: 'none', zIndex: '2', willChange: '' });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x333333, 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(-5.5, 12, 6.5);
  sun.target.position.set(0, 0, -1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 40 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  // 地形（2Dと同じ、継ぎ目を馴染ませた1枚を繰り返す。横は鏡写しで隣の道が見えないようにする）
  const GROUND_W = 32, GROUND_L = 64, GROUND_ZC = -8;
  const groundTex = new THREE.Texture();
  groundTex.wrapS = THREE.MirroredRepeatWrapping;
  groundTex.wrapT = THREE.RepeatWrapping;
  groundTex.colorSpace = THREE.SRGBColorSpace;
  groundTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, map: groundTex, envMapIntensity: 0 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_W, GROUND_L), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, GROUND_ZC);
  ground.receiveShadow = true;
  scene.add(ground);
  let groundImg = null, tileH = TILE_W;
  // HTMLビューアーなどでファイルを直接開いたときは、画像をWebGLに渡せないことがある（ブラウザの安全のための制限）
  const textureSafe = imageSafeForWebGL;
  // HTMLビューアー（file://）では、ステージの画像が「別の場所のもの」扱いになって3Dに使えない。
  // そのときは models/ に文字で埋め込んだ同じ画像を読んで使う（届くまでは簡単な地面）。v355〜
  const safeGround = {};   // 'forest' | 'seafloor' → 'loading' | 'failed' | 画像（2Dと同じく継ぎ目をなじませたもの）
  function loadSafeGround(stage) {
    const key = stage === 'seafloor' ? 'seafloor' : 'forest';
    if (safeGround[key]) return Promise.resolve();
    safeGround[key] = 'loading';
    return modelBuffer('ground-' + key)
      .then(buf => {
        const url = URL.createObjectURL(new Blob([buf], { type: 'image/webp' }));
        return loadImageDecoded(url).finally(() => URL.revokeObjectURL(url));
      })
      .then(img => {
        if (!running) return;
        const tile = bridge.periodicTerrain ? bridge.periodicTerrain(img) : img;
        if (!imageSafeForWebGL(img) || !imageSafeForWebGL(tile)) throw new Error('埋め込んだ画像も3Dに使えませんでした');
        safeGround[key] = tile;
        groundImg = null;        // 次のコマで地面を貼り直す
      })
      .catch(err => { safeGround[key] = 'failed'; console.warn('[N.O.A.H. 3D] 地面の画像を使えませんでした（簡単な地面のまま）', err); });
  }
  const groundFallback = {};
  function proceduralGround(stage) {
    const key = stage === 'seafloor' ? 'seafloor' : 'forest';
    if (groundFallback[key]) return groundFallback[key];
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    const sea = key === 'seafloor';
    const r = rng(sea ? 77 : 55);
    g.fillStyle = sea ? '#17393d' : '#1f3a1d'; g.fillRect(0, 0, 512, 512);
    const blob = (x, y, rad, color) => { for (const oy of [-512, 0, 512]) { g.fillStyle = color; g.beginPath(); g.ellipse(x, y + oy, rad, rad * (0.6 + r() * 0.5), r() * 3, 0, Math.PI * 2); g.fill(); } };
    for (let i = 0; i < 900; i++) {
      const l = sea ? 14 + r() * 16 : 12 + r() * 18;
      blob(r() * 512, r() * 512, 3 + r() * 14, sea ? `hsla(${185 + r() * 14},${18 + r() * 16}%,${l}%,.55)` : `hsla(${95 + r() * 30},${35 + r() * 25}%,${l}%,.6)`);
    }
    // 中央の道（2Dの画像と同じく、幅およそ2割）
    const x0 = 512 * 0.385, x1 = 512 * 0.595;
    const grd = g.createLinearGradient(x0 - 14, 0, x1 + 14, 0);
    const pathCol = sea ? '120,175,170' : '118,112,62';
    grd.addColorStop(0, `rgba(${pathCol},0)`); grd.addColorStop(0.08, `rgba(${pathCol},.92)`); grd.addColorStop(0.92, `rgba(${pathCol},.92)`); grd.addColorStop(1, `rgba(${pathCol},0)`);
    g.fillStyle = grd; g.fillRect(x0 - 14, 0, x1 - x0 + 28, 512);
    for (let i = 0; i < 260; i++) blob(x0 + r() * (x1 - x0), r() * 512, 1 + r() * 4, sea ? `rgba(200,240,230,${0.05 + r() * 0.1})` : `rgba(${60 + r() * 50},${60 + r() * 40},30,${0.15 + r() * 0.2})`);
    groundFallback[key] = c;
    return c;
  }

  let scenery = null;

  // ---------------------------------------------------------------------------
  // 本番モデル（裏で読み込み、届いたら仮モデルと差し替える。読めなければ仮モデルのまま）
  // ---------------------------------------------------------------------------
  const templates = {};            // 名前 → このセッションで読み込んだモデル（機体・木・岩山の元）
  const requested = new Map();
  const parsedScenes = [];         // 片付け用
  const modelErrors = {};
  // 映り込みの空は、金属の多い機体と怪獣にだけ付ける（地面・木・岩山には付けない。画面の大部分を占めるので重くなる）
  let envTex = null, envIntensity = 1;
  function applyEnv(obj) {
    obj.traverse(o => {
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      for (const m of mats) {
        if (!m.userData || !m.userData.noahEnv) continue;
        if (m.envMap !== envTex) { m.envMap = envTex; m.needsUpdate = true; }
        m.envMapIntensity = envIntensity;
      }
    });
  }
  // 読み込みは1つずつ順番に（いちどに全部すると、その間タップや音の処理がもたつくため。v355〜）
  let loadChain = Promise.resolve();
  function enqueue(task) {
    const p = loadChain.then(() => (running ? task() : Promise.reject(new Error('3D表示を止めました'))));
    loadChain = p.catch(() => {}).then(() => yieldToUi(40));
    return p;
  }
  // 画像を先にGPUへ送っておく（差し替えた瞬間に止まらないように）。1枚ずつ、合間にひと息つく。
  // シェーダーはここでは作らない：タイトル画面の下ごしらえ（warmUp）でまとめて作る。ゲーム中に届いたものは、初めて描くときに作る。
  // （v354 の compileAsync は、作っている途中で3Dを止めると three.js の中でエラーになることがあったのでやめた）
  async function prepareObject(obj, useEnv) {
    const textures = new Set();
    obj.traverse(o => {
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      mats.forEach(m => {
        if (useEnv && m.isMeshStandardMaterial) m.userData.noahEnv = true;
        if (m.map) m.map.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) if (m[k]) textures.add(m[k]);
      });
    });
    if (useEnv) applyEnv(obj);
    for (const t of textures) {
      if (!running) return;
      try { renderer.initTexture(t); } catch (e) {}
      await yieldToUi();
    }
  }
  function requestModel(name, prepare) {
    if (requested.has(name)) return requested.get(name);
    const p = enqueue(async () => {
      const gltf = await parseModel(name);
      if (!running) { disposeObject(gltf.scene); throw new Error('3D表示を止めました'); }
      parsedScenes.push(gltf.scene);
      await yieldToUi();
      if (prepare) await prepare(gltf);
      return gltf;
    });
    p.catch(err => { if (running) { modelErrors[name] = String(err && err.message || err); console.warn('[N.O.A.H. 3D] モデルを読み込めませんでした（仮モデルのまま）', name, err); } });
    requested.set(name, p);
    return p;
  }
  // 機体・木・岩山：読み込みを頼み、届いていればその元を返す（まだなら null）
  function templateFor(name) {
    if (templates[name]) return templates[name];
    if (!requested.has(name)) {
      const isScenery = name === 'tree' || name === 'rock';
      requestModel(name, async gltf => {
        if (isScenery) toLambert(gltf.scene);
        await prepareObject(gltf.scene, !isScenery);
        if (running) templates[name] = gltf.scene;
      }).then(() => { if (running && isScenery) rebuildScenery(); }).catch(() => {});
    }
    return null;
  }
  const aircraftTemplate = type => templateFor(AIRCRAFT_MODEL_NAMES[type] || AIRCRAFT_MODEL_NAMES[0]);

  // 怪獣（読み込みが終わるまでは仮モデル）
  function placeholderKaiju() {
    const k = makeKaiju();
    k.real = false;
    k.animate = (t, scroll, a, jx, lunge) => animateKaiju(k, t, scroll * Math.PI * 3, a, jx, lunge);
    k.setAlpha = a => setOpacity(k.mats, a);
    k.dispose = () => disposeObject(k.root);
    return k;
  }
  let kaiju = placeholderKaiju();
  kaiju.root.position.set(0, 0, KAIJU_Z);
  scene.add(kaiju.root);
  const glowTex = glowTexture();
  // 砂ぼこり・泡（v356〜）
  const stageFx = makeStageFx();
  scene.add(stageFx.group);
  const tmpFoot = new THREE.Vector3();
  // 怪獣の足が地面に着いたら砂ぼこりを出す。prev → cur は、このコマの間に地形が流れた量（マス）
  function kaijuFootfalls(prev, cur, alpha) {
    if (!kaiju.real || !kaiju.feet || walkAmp < 0.3 || alpha < 0.5 || !kaiju.root.visible) return;
    const spc = KAIJU_MODEL.stepsPerCell;
    const a = prev * spc, b = cur * spc, d = b - a;
    if (!(Math.abs(d) > 1e-6 && Math.abs(d) < 1.5)) return;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    for (let m = Math.ceil(lo - 0.5); m + 0.5 <= hi; m++) {
      if (m + 0.5 <= lo) continue;
      const even = ((m % 2) + 2) % 2 === 0;
      const leg = d > 0 ? (even ? 1 : 0) : (even ? 0 : 1);
      const bone = kaiju.feet[leg];
      if (!bone) continue;
      bone.getWorldPosition(tmpFoot);
      stageFx.footfall(tmpFoot.x, tmpFoot.z + 0.08 * kaiju.root.scale.z);
    }
  }
  // 炸裂の泡（海底）：演出が始まった瞬間に1回だけ
  const blasted = new WeakSet();
  const tmpBlast = new THREE.Vector3();
  function blastBubbles(g, now) {
    for (const ef of g.effects) {
      const f = FLASH_TYPES[ef.type];
      if (!f || blasted.has(ef) || now < ef.start) continue;
      blasted.add(ef);
      if (now - ef.start > Math.min(1500, ef.duration || 620)) continue;     // もう終わった演出（盤面が隠れている間に始まったもの）には出さない
      const info = f(ef);
      if (!info.p) continue;
      effectPlanePoint(info.p.x, info.p.y, tmpBlast);
      stageFx.burst(tmpBlast.x, tmpBlast.y, tmpBlast.z, info.peak);
    }
  }
  const warnSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: warnTexture(), depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
  warnSprite.renderOrder = 9;
  warnSprite.visible = false;
  scene.add(warnSprite);
  const tmpHead = new THREE.Vector3();
  // 研究UR（生体解析）：怪獣の体に光る網目を重ねる。本番の怪獣は骨で動くので、同じ骨で動く網目を重ね、法線の向きに少し膨らませる
  const scanMat = new THREE.MeshBasicMaterial({ color: 0x7ff6ff, wireframe: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  scanMat.onBeforeCompile = sh => { sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\ttransformed += normalize( normal ) * 0.012;'); };
  function attachScan(k) {
    const list = [];
    if (k.real) {
      for (const m of k.skinned) {
        const w = new THREE.SkinnedMesh(m.geometry, scanMat);
        w.bind(m.skeleton, m.bindMatrix);
        w.position.copy(m.position); w.quaternion.copy(m.quaternion); w.scale.copy(m.scale);
        w.frustumCulled = false; w.renderOrder = 7; w.visible = false;
        m.parent.add(w); list.push(w);
      }
    } else {
      const bodyMeshes = []; k.root.traverse(o => { if (o.isMesh) bodyMeshes.push(o); });
      for (const o of bodyMeshes) { const w = new THREE.Mesh(o.geometry, scanMat); w.scale.setScalar(1.03); w.renderOrder = 7; w.visible = false; o.add(w); list.push(w); }
    }
    return list;
  }
  let scanMeshes = attachScan(kaiju);
  function updateScan(g) {
    const sp = bridge.kaijuScan ? bridge.kaijuScan() : -1;
    const on = sp >= 0 && kaiju.root.visible;
    for (const w of scanMeshes) w.visible = on;
    if (on) scanMat.opacity = (kaiju.real ? 0.3 : 0.8) * Math.min(1, sp / 0.1) * Math.min(1, (1 - sp) / 0.25) * (0.75 + 0.25 * Math.sin(sp * 40));
  }
  function swapKaiju(next) {
    const prev = kaiju;
    scanMeshes.forEach(w => { if (w.parent) w.parent.remove(w); });
    scene.remove(prev.root);
    prev.dispose();
    kaiju = next;
    kaiju.root.position.set(0, 0, KAIJU_Z);
    scene.add(kaiju.root);
    scanMeshes = attachScan(kaiju);
  }
  // 先に読み始めておく（順番に）：怪獣 → いまの機体（タイトル画面では初期の3機）→ 森林の木と海底の岩山。
  // そろったら、まだ盤面が出ていなければ（タイトル画面・作戦の準備の間）、使うシェーダーを全部作っておく。
  const preload = [];
  preload.push(requestModel(KAIJU_MODEL_NAME, async gltf => {
    const k = makeKaijuFromModel(gltf);
    await prepareObject(k.root, true);
    if (running) swapKaiju(k); else k.dispose();
  }).catch(err => { if (running) { modelErrors[KAIJU_MODEL_NAME] = modelErrors[KAIJU_MODEL_NAME] || String(err && err.message || err); console.warn('[N.O.A.H. 3D] 怪獣のモデルを使えませんでした（仮モデルのまま）', err); } }));
  try {
    const g0 = bridge.game;
    const names = new Set();
    if (g0 && g0.units) g0.units.forEach(u => names.add(AIRCRAFT_MODEL_NAMES[bridge.aircraftIndex(u)] || AIRCRAFT_MODEL_NAMES[0]));
    names.add(bridge.stageId() === 'seafloor' ? 'rock' : 'tree');
    names.add('tree'); names.add('rock');
    for (const n of names) { templateFor(n); if (requested.has(n)) preload.push(requested.get(n).catch(() => {})); }
    if (location.protocol === 'file:') for (const st of ['forest', 'seafloor']) preload.push(enqueue(() => loadSafeGround(st)).catch(() => {}));
  } catch (e) {}
  Promise.all(preload).then(() => yieldToUi(60)).then(() => warmUp());

  // 戦術パネル（2Dの絵を機体の高度に浮かべる）
  const tacticalCanvas = document.createElement('canvas');
  tacticalCanvas.width = tacticalCanvas.height = TACTICAL_TEX;
  const tacticalTex = new THREE.CanvasTexture(tacticalCanvas);
  tacticalTex.colorSpace = THREE.SRGBColorSpace;
  tacticalTex.generateMipmaps = false;
  tacticalTex.minFilter = THREE.LinearFilter;
  tacticalTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const tacticalPlane = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), new THREE.MeshBasicMaterial({ map: tacticalTex, transparent: true, depthWrite: false, toneMapped: false }));
  tacticalPlane.rotation.x = -Math.PI / 2;
  tacticalPlane.position.set(0, PANEL_Y, 0);
  tacticalPlane.renderOrder = 1;
  scene.add(tacticalPlane);
  let lastTacticalDraw = 0, lastTacticalLevel = -1;

  // 移動先の目印（地面から戦術パネルまでの光の柱）と、押しているマスの枠
  const pillarMat = new THREE.MeshBasicMaterial({ color: 0x8ff6ff, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const pillarGeo = new THREE.CylinderGeometry(0.018, 0.018, PANEL_Y, 6); pillarGeo.translate(0, PANEL_Y / 2, 0);
  const footGeo = new THREE.RingGeometry(0.13, 0.18, 24); footGeo.rotateX(-Math.PI / 2);
  const pillars = [];
  for (const col of [0, 1, 2]) for (const row of TACTICAL_ROWS) {
    const g = new THREE.Group();
    const stem = new THREE.Mesh(pillarGeo, pillarMat); stem.renderOrder = 2; g.add(stem);
    const foot = new THREE.Mesh(footGeo, pillarMat); foot.position.y = 0.02; foot.renderOrder = 2; g.add(foot);
    g.position.set(UNIT_BOARD_COLS[col] + 0.5 - 3.5, 0, row + 0.5 - 3.5);
    g.visible = false;
    scene.add(g);
    pillars.push({ col, row, g });
  }
  const pickFrame = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), new THREE.MeshBasicMaterial({ map: frameTexture(), transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  pickFrame.rotation.x = -Math.PI / 2;
  pickFrame.renderOrder = 8;
  pickFrame.visible = false;
  scene.add(pickFrame);
  const pickRing = new THREE.Mesh(new THREE.RingGeometry(1.55, 1.72, 48), new THREE.MeshBasicMaterial({ color: 0xffd0a0, transparent: true, opacity: 0.8, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  pickRing.rotation.x = -Math.PI / 2;
  pickRing.position.set(0, 0.04, KAIJU_Z);
  pickRing.renderOrder = 8;
  pickRing.visible = false;
  scene.add(pickRing);

  // 行動中の機体の輪
  const activeRing = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.47, 40), new THREE.MeshBasicMaterial({ color: 0xfff2a1, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
  activeRing.rotation.x = -Math.PI / 2;
  activeRing.renderOrder = 3;
  activeRing.visible = false;
  scene.add(activeRing);

  // 機体・ミサイル
  const aircraft = new Map();     // unit → { model, type, pos, drones }
  const projectiles = new Map();  // effect → { model, history, start, end, side }
  const droneGeo = new THREE.OctahedronGeometry(0.06, 0);

  // ---------------------------------------------------------------------------
  // カメラ（盤面の四隅・手前の機体・怪獣の頭が画面に収まる距離を毎回求める）
  // ---------------------------------------------------------------------------
  const cam = { elev: CAMERA_POSES.oblique.elev, fov: CAMERA_POSES.oblique.fov, target: CAMERA_POSES.oblique.target.clone(), dist: 0 };
  let camSettling = false;   // カメラが動いている途中（このあいだは毎秒60回描く）
  const tmpV = new THREE.Vector3();
  function placeCamera(elevDeg, dist, target, fov, aspect) {
    const el = THREE.MathUtils.degToRad(elevDeg);
    camera.fov = fov; camera.aspect = aspect;
    camera.position.set(target.x, target.y + Math.sin(el) * dist, target.z + Math.cos(el) * dist);
    if (elevDeg > 85) camera.up.set(0, 0, -1); else camera.up.set(0, 1, 0);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
  }
  function fitDistance(elevDeg, target, fov, aspect, pts) {
    let lo = 3, hi = 90;
    for (let i = 0; i < 22; i++) {
      const d = (lo + hi) / 2;
      placeCamera(elevDeg, d, target, fov, aspect);
      let ok = true;
      for (const p of pts) {
        tmpV.copy(p).project(camera);
        if (Math.abs(tmpV.x) > 0.95 || Math.abs(tmpV.y) > 0.93 || tmpV.z > 1) { ok = false; break; }
      }
      if (ok) hi = d; else lo = d;
    }
    return hi;
  }
  // 構えの中心：入れる点の上下の真ん中が画面の真ん中に来るよう、target を奥・手前へずらしておく（画面の縦横比ごとに1回）
  const poseFrames = new Map();
  function poseTarget(pose, aspect) {
    const key = pose.name + ':' + aspect.toFixed(3);
    let t = poseFrames.get(key);
    if (t) return t;
    t = pose.target.clone();
    for (let k = 0; k < 3; k++) {
      placeCamera(pose.elev, fitDistance(pose.elev, t, pose.fov, aspect, pose.fit), t, pose.fov, aspect);
      let lo = Infinity, hi = -Infinity;
      for (const p of pose.fit) { tmpV.copy(p).project(camera); lo = Math.min(lo, tmpV.y); hi = Math.max(hi, tmpV.y); }
      const y0 = tmpV.copy(t).project(camera).y;
      const per = tmpV.set(t.x, t.y, t.z - 1).project(camera).y - y0;   // 点を奥へ1動かしたときの、画面の縦の動き
      if (!(Math.abs(per) > 1e-6)) break;
      t.z -= ((lo + hi) / 2) / per;
    }
    poseFrames.set(key, t);
    return t;
  }
  function choosingCell(g) { return !!(g && !g.gameOver && !g.introHideUnits && (g.mode === 'move' || g.mode === 'sortie')); }
  // 移動フェイズ（と、移動先・出撃先を選んでいる間）は真上から。それ以外は斜めから
  function desiredPose(g) {
    if (choosingCell(g)) return CAMERA_POSES.top;
    if (g && !g.gameOver && !g.introHideUnits && g.phase === 'move') return CAMERA_POSES.top;
    return CAMERA_POSES.oblique;
  }

  // ---------------------------------------------------------------------------
  // 大きさ（CSS の変形の影響を受けないレイアウト上の大きさを使う）
  // ---------------------------------------------------------------------------
  let W = 1, H = 1;
  function resize() {
    W = Math.max(1, host.clientWidth); H = Math.max(1, host.clientHeight);
    renderer.setSize(W, H, false);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  cleanups.push(() => ro.disconnect());
  resize();

  // ---------------------------------------------------------------------------
  // 画面上の位置（host 内の CSS px）
  // ---------------------------------------------------------------------------
  const scr = new THREE.Vector3();
  function toScreen(v) {
    scr.copy(v).project(camera);
    return { x: (scr.x + 1) / 2 * W, y: (1 - scr.y) / 2 * H, behind: scr.z > 1 };
  }
  const tacticalCells = [];
  for (const col of [0, 1, 2]) for (const row of TACTICAL_ROWS) {
    const bx = UNIT_BOARD_COLS[col];
    tacticalCells.push({ col, row, bx, center: new THREE.Vector3(bx + 0.5 - 3.5, PANEL_Y, row + 0.5 - 3.5) });
  }

  // 押した位置から、選ぶマスを決める（いちばん近いマスに吸い付く。少し外れていても拾う）
  const P = new THREE.Vector3();
  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * (W / Math.max(1, rect.width));
    const py = (clientY - rect.top) * (H / Math.max(1, rect.height));
    const g = bridge.game;
    let best = null, bestD = Infinity;
    if (g && !g.introHideUnits) {
      for (const c of tacticalCells) {
        const s = toScreen(c.center);
        const l = toScreen(P.set(c.center.x - 1, PANEL_Y, c.center.z)).x;
        const r = toScreen(P.set(c.center.x + 1, PANEL_Y, c.center.z)).x;
        const f = toScreen(P.set(c.center.x, PANEL_Y, c.center.z - 0.5)).y;
        const n = toScreen(P.set(c.center.x, PANEL_Y, c.center.z + 0.5)).y;
        const hw = Math.max(12, Math.abs(r - l) / 2), hh = Math.max(12, Math.abs(n - f) / 2);
        const d = Math.hypot((px - s.x) / hw, (py - s.y) / hh);
        if (d < bestD) { bestD = d; best = c; }
      }
    }
    if (best && bestD <= 1.2) return { kind: 'cell', cell: { x: best.bx, y: best.row }, ref: best };
    // 怪獣（画面上の外形の箱）
    const box = kaiju.localBox.clone().applyMatrix4(kaiju.root.matrixWorld);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const s = toScreen(P.set(x, y, z));
      minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x); minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
    }
    const padX = (maxX - minX) * 0.06;
    if (kaiju.root.visible && px >= minX + padX && px <= maxX - padX && py >= minY && py <= maxY) return { kind: 'kaiju', cell: { x: 3, y: 1 } };
    return null;
  }

  let pressId = null, pressTarget = null;
  function showPick(target) { pressTarget = target; }
  // 押している間の目印：選んだマスの枠（選べないマスは赤）と、移動先に半透明の機体。怪獣を押しているときは足元の輪
  let ghost = null;
  function updatePickVisuals(g) {
    const target = pressId !== null ? pressTarget : null;
    const unit = bridge.curUnit();
    let frameOn = false, valid = true, ghostOn = false;
    if (target && target.kind === 'cell' && unit) {
      const { col, row } = target.ref;
      if (choosingCell(g)) {
        frameOn = true;
        const current = g.mode === 'move' && bridge.unitCol(unit) === col && unit.row === row;
        valid = current || !bridge.isGridOccupied(col, row, g.mode === 'move' ? unit : null);
        ghostOn = valid && !current;
      } else if (g.phase === 'move' && unit.state === 'deployed' && bridge.unitCol(unit) === col && unit.row === row) {
        frameOn = true;   // 自機のマス：押すと移動を始められる
      }
    }
    pickFrame.visible = frameOn;
    pickRing.visible = !!(target && target.kind === 'kaiju');
    if (frameOn) {
      pickFrame.position.set(target.ref.center.x, PANEL_Y + 0.01, target.ref.center.z);
      pickFrame.material.color.set(valid ? 0xffffff : 0xff4a4a);
    }
    if (ghostOn) {
      const type = bridge.aircraftIndex(unit);
      const tpl = aircraftTemplate(type);
      if (!ghost || ghost.type !== type || (tpl && !ghost.model.real)) {
        if (ghost) { scene.remove(ghost.model.group); ghost.model.dispose(); }
        const model = tpl ? makeAircraftFromModel(tpl, type) : makeAircraft(type);
        model.setAlpha(0.42);
        model.glowMat.opacity = 0.35;
        model.group.traverse(o => { if (o.isMesh) { o.castShadow = false; o.renderOrder = o.userData.noahDepthOnly ? 4.95 : 5; } });
        scene.add(model.group);
        ghost = { model, type };
      }
      const c = target.ref.center;
      ghost.model.group.position.set(c.x, FLY_Y + 0.04 + Math.sin(performance.now() / 300) * 0.03, c.z);
    }
    if (ghost) ghost.model.group.visible = ghostOn;
  }
  function onDown(e) {
    if (pressId !== null) return;
    if (bridge.inputLocked()) return;
    pressId = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    showPick(pick(e.clientX, e.clientY));
    e.preventDefault();
  }
  function onMove(e) {
    if (pressId !== e.pointerId) return;
    showPick(pick(e.clientX, e.clientY));
  }
  function onUp(e) {
    if (pressId !== e.pointerId) return;
    const target = pick(e.clientX, e.clientY);
    pressId = null;
    showPick(null);
    if (bridge.inputLocked()) return;
    bridge.tap(target ? target.cell : { x: -1, y: -1 });
  }
  function onCancel(e) { if (pressId !== e.pointerId) return; pressId = null; showPick(null); }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);

  // ---------------------------------------------------------------------------
  // カード演出の置き場所。index.html は2Dの演出を1つずつ、ここで求めた画面上の位置・大きさに合わせて
  // 画面に平行に描く（地面に寝かせない）。
  //   plane(x, y)    … 盤面の位置を「中列では機体の高さ、奥では怪獣の胸の前」を通る面に置いたときの画面の位置
  //   standing(x, y) … 怪獣の前に立てた面（研究の演出用）。盤面の y=0 が怪獣の頭の上、y=3 が足元
  // ---------------------------------------------------------------------------
  const EP = new THREE.Vector3();
  const STAND_Z = KAIJU_Z + 1.0, STAND_H = 1.1;
  const fxProject = {
    plane(bx, by) { const s = toScreen(effectPlanePoint(bx, by, EP)); return { x: s.x, y: s.y }; },
    standing(bx, by) { const s = toScreen(EP.set(bx - 3.5, (3 - by) * STAND_H, STAND_Z)); return { x: s.x, y: s.y }; },
  };

  // 爆発・着弾の光：演出に合わせて、その場所で一瞬だけ3Dの光をともし、怪獣や機体を照らす
  const flash = new THREE.PointLight(0xffa24a, 0, 7, 2);
  scene.add(flash);
  const FLASH_TYPES = {
    explosion: ef => ({ p: ef.cell ? { x: ef.cell.x + 0.5 + (ef.offsetX || 0), y: ef.cell.y + 0.5 + (ef.offsetY || 0) } : null, peak: (ef.scale || 1) < 0.8 ? 5 : 14, color: ef.kind === 'support' ? 0x9effe0 : 0xffa24a }),
    guidanceFxExplosion: ef => ({ p: ef.point, peak: 14, color: 0xffb070 }),
    guidanceFxLR: ef => ({ p: ef.point, peak: 20, color: 0xd8ecff }),
    supportFx: ef => ({ p: ef.point, peak: 9, color: 0x9effe0 }),
  };
  function updateFlash(g, now) {
    let best = 0, bestP = null, bestColor = 0xffa24a;
    for (const ef of g.effects) {
      const f = FLASH_TYPES[ef.type];
      if (!f) continue;
      const p = (now - ef.start) / (ef.duration || 620);
      if (p < 0 || p > 1) continue;
      const info = f(ef);
      if (!info.p) continue;
      const v = info.peak * Math.pow(1 - p, 2) * Math.min(1, p / 0.05);
      if (v > best) { best = v; bestP = info.p; bestColor = info.color; }
    }
    flash.intensity = best;
    if (bestP) {
      effectPlanePoint(bestP.x, bestP.y, flash.position);
      flash.position.z += 0.8; flash.position.y += 0.1;
      flash.color.set(bestColor);
    }
  }

  // ---------------------------------------------------------------------------
  // ステージ
  // ---------------------------------------------------------------------------
  let lookStage = '';
  let envRT = null;
  function applyStage(stage) {
    if (stage === lookStage) return;
    lookStage = stage;
    const L = STAGE_LOOK[stage] || STAGE_LOOK.forest;
    scene.fog = new THREE.Fog(L.fog, L.fogNear, L.fogFar);
    scene.background = new THREE.Color(L.fog);
    hemi.color.set(L.sky); hemi.groundColor.set(L.ground); hemi.intensity = L.hemi;
    sun.color.set(L.sun); sun.intensity = L.sunI;
    renderer.toneMappingExposure = L.exposure;
    stageFx.setStage(stage);
    // 映り込みの空（ステージの色）
    try {
      const next = makeEnvironment(renderer, L);
      envTex = next.texture; envIntensity = L.env;
      applyEnv(scene);
      Object.values(templates).forEach(applyEnv);
      if (envRT) envRT.dispose();
      envRT = next;
    } catch (e) { console.warn('[N.O.A.H. 3D] 映り込みの空を作れませんでした', e); }
    rebuildScenery();
  }
  function rebuildScenery() {
    if (!lookStage) return;
    const sea = lookStage === 'seafloor';
    templateFor(sea ? 'rock' : 'tree');     // 読み込みを頼む（届いたらもう一度ここに来る）
    if (scenery) { scene.remove(scenery.group); scenery.dispose(); }
    scenery = buildScenery(sea ? 'seafloor' : 'forest', templates);
    if (scenery.setLite) scenery.setLite(quality >= 2);
    scene.add(scenery.group);
  }

  // ---------------------------------------------------------------------------
  // 機体・ミサイル・目印
  // ---------------------------------------------------------------------------
  function removeAircraft(a) {
    scene.remove(a.model.group);
    a.model.dispose();
    a.drones.forEach(m => { scene.remove(m); m.material.dispose(); });
  }
  // ---------------------------------------------------------------------------
  // 機体のHP（v359）：盤面の上に重ねた小さな札。文字は HTML なので小さくてもくっきり読める。
  // 機体の真下に付いて動き、HPが減ったときは一瞬赤く光る。アタックフェイズ（自分で操作できる間）だけ隠す（v277 の決まり）
  // ---------------------------------------------------------------------------
  const hpLayer = document.createElement('div');
  hpLayer.className = 'noah3dHpLayer';
  hpLayer.setAttribute('aria-hidden', 'true');
  Object.assign(hpLayer.style, { position: 'absolute', left: '0', top: '0', right: '0', bottom: '0', overflow: 'hidden', pointerEvents: 'none', zIndex: '3' });
  host.appendChild(hpLayer);
  cleanups.push(() => hpLayer.remove());
  const hpPlates = new Map();   // unit → 札
  const HP_TONES = [[0.25, '#ff5b5b'], [0.5, '#ffd352'], [Infinity, '#57efbc']];   // 2D のHPバーと同じ色分け
  function makeHpPlate() {
    const el = document.createElement('div');
    el.className = 'noah3dHpPlate';
    el.style.cssText = 'position:absolute;left:0;top:0;display:flex;align-items:center;gap:4px;padding:2px 5px 2px 4px;border-radius:5px;' +
      'background:rgba(4,9,16,.84);border:1px solid rgba(190,225,255,.42);box-shadow:0 1px 5px rgba(0,0,0,.6);' +
      'font:700 11px/1 var(--f-hud,system-ui,sans-serif);color:#fff;white-space:nowrap;will-change:transform;visibility:hidden;' +
      'transition:border-color .25s,box-shadow .25s;';
    const label = document.createElement('span');
    label.textContent = 'HP';
    label.style.cssText = 'font-size:8.5px;letter-spacing:.06em;color:rgba(200,225,245,.78);';
    const num = document.createElement('b');
    num.style.cssText = 'min-width:13px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;';
    const bar = document.createElement('span');
    bar.style.cssText = 'position:relative;display:block;width:30px;height:5px;border-radius:3px;background:rgba(255,255,255,.16);overflow:hidden;';
    const fill = document.createElement('i');
    fill.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:100%;border-radius:3px;transition:width .4s ease,background-color .3s;';
    bar.appendChild(fill);
    el.append(label, num, bar);
    hpLayer.appendChild(el);
    return { el, num, fill, hp: null, max: null, w: 0, h: 0, flashUntil: 0, flashing: false, shown: false, x: 0, y: 0, opacity: '' };
  }
  const hpA = new THREE.Vector3(), hpB = new THREE.Vector3();
  function updateHpPlates(g, now) {
    const entering = typeof g.aircraftEntryProgress === 'number' && g.aircraftEntryProgress < 1;
    let hideAll = !!g.introHideUnits || entering || !!g.gameOver;
    if (!hideAll && bridge.hpHidden) { try { hideAll = !!bridge.hpHidden(); } catch (e) {} }
    const seen = new Set();
    for (const [u, a] of aircraft) {
      seen.add(u);
      let p = hpPlates.get(u);
      if (!p) { p = makeHpPlate(); hpPlates.set(u, p); }
      if (hideAll) { if (p.shown) { p.el.style.visibility = 'hidden'; p.shown = false; } continue; }
      const max = Math.max(1, Math.round(Number(u.maxHp) || 1));
      const hp = Math.max(0, Math.min(max, Math.round(Number(u.hp) || 0)));
      if (hp !== p.hp || max !== p.max) {
        if (p.hp != null && hp < p.hp) p.flashUntil = now + 700;
        p.hp = hp; p.max = max;
        const r = hp / max;
        p.num.textContent = String(hp);
        p.fill.style.width = (r * 100).toFixed(1) + '%';
        p.fill.style.backgroundColor = HP_TONES.find(t => r <= t[0])[1];
        p.w = 0;   // 桁が変わったら大きさを測り直す
      }
      const flashing = now < p.flashUntil;
      if (flashing !== p.flashing) {
        p.flashing = flashing;
        p.el.style.borderColor = flashing ? 'rgba(255,120,120,.98)' : 'rgba(190,225,255,.42)';
        p.el.style.boxShadow = flashing ? '0 0 10px rgba(255,70,70,.75),0 1px 5px rgba(0,0,0,.6)' : '0 1px 5px rgba(0,0,0,.6)';
      }
      if (!p.w) { p.w = p.el.offsetWidth; p.h = p.el.offsetHeight; }
      // 位置：機体の中心の真下で、マスの手前の縁をまたぐ（札の下の端が、手前のマスの1/4ほどまで）。
      // 真上でも斜めでも、機体を隠しすぎず、手前のマスの攻撃予測（マスの真ん中）にも掛からない
      const grp = a.model.group;
      const c = toScreen(hpA.set(grp.position.x, grp.position.y, grp.position.z));
      const edge = toScreen(hpB.set(grp.position.x, PANEL_Y, grp.position.z + 0.5)).y;
      const back = toScreen(hpB.set(grp.position.x, PANEL_Y, grp.position.z - 0.5)).y;
      const cellH = Math.max(8, edge - back);
      let x = c.x - p.w / 2, y = Math.max(edge + cellH * 0.24 - p.h, c.y + 4);
      x = Math.max(2, Math.min(W - p.w - 2, x));
      y = Math.max(2, Math.min(H - p.h - 2, y));
      if (Math.abs(x - p.x) > 0.25 || Math.abs(y - p.y) > 0.25 || !p.shown) {
        p.x = x; p.y = y;
        p.el.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
      }
      const opacity = u.state === 'returning' ? '0.6' : '1';
      if (opacity !== p.opacity) { p.opacity = opacity; p.el.style.opacity = opacity; }
      if (!p.shown) { p.el.style.visibility = 'visible'; p.shown = true; }
    }
    for (const [u, p] of hpPlates) if (!seen.has(u)) { p.el.remove(); hpPlates.delete(u); }
  }

  function syncAircraft(g, now, dt) {
    const seen = new Set();
    const hide = !!g.introHideUnits;
    g.units.forEach((u, i) => {
      if (hide || !bridge.unitOccupiesBoard(u)) return;
      seen.add(u);
      let a = aircraft.get(u);
      const type = bridge.aircraftIndex(u);
      const tpl = aircraftTemplate(type);
      if (!a || a.type !== type || (tpl && !a.model.real)) {
        const keepPos = a && a.type === type ? a.pos : null;
        const keepDrones = a && a.type === type ? a.drones : null;
        if (a) { scene.remove(a.model.group); a.model.dispose(); if (!keepDrones) a.drones.forEach(m => { scene.remove(m); m.material.dispose(); }); }
        const model = tpl ? makeAircraftFromModel(tpl, type) : makeAircraft(type);
        scene.add(model.group);
        a = { model, type, pos: keepPos, drones: keepDrones || [] };
        aircraft.set(u, a);
      }
      const target = new THREE.Vector3(bridge.boardX(u) + 0.5 - 3.5, FLY_Y, u.row + 0.5 - 3.5);
      if (typeof g.aircraftEntryProgress === 'number' && g.aircraftEntryProgress < 1) {
        const p = easeInOutSine(g.aircraftEntryProgress);
        target.z += (1 - p) * (7 - (u.row + 0.5) + 1.05 + i * 0.12 + 2.5);
        target.y += (1 - p) * 0.4;
      }
      if (!a.pos) a.pos = target.clone();
      if (a.pos.distanceToSquared(target) > 2e-5) aircraftMoving = true;
      const dx = target.x - a.pos.x;
      a.pos.lerp(target, 1 - Math.exp(-dt * 9));
      const phase = now / 330 + type * 1.45, phase2 = now / 520 + type * 0.9;
      const bob = Math.sin(phase) * (type === 0 ? 0.038 : type === 1 ? 0.034 : 0.03);
      const grp = a.model.group;
      grp.position.set(a.pos.x + Math.cos(phase2) * 0.012, a.pos.y + bob, a.pos.z);
      grp.rotation.set(Math.sin(phase * 0.7) * 0.03, 0, THREE.MathUtils.clamp(-dx * 0.9, -0.5, 0.5) + Math.sin(phase2) * 0.03);
      a.model.setAlpha(u.state === 'returning' ? 0.58 : 1);
      const flick = 0.85 + Math.sin(now / 37 + type) * 0.1 + Math.random() * 0.08;
      a.model.engines.forEach(f => { const r = f.userData.r || 1; f.scale.set(r, flick * (f.userData.len || 1), r); });
      // 追従ドローン
      const colors = bridge.followDroneColors(u);
      while (a.drones.length < colors.length) {
        const m = new THREE.Mesh(droneGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.3, flatShading: true }));
        m.castShadow = true; scene.add(m); a.drones.push(m);
      }
      while (a.drones.length > colors.length) { const m = a.drones.pop(); scene.remove(m); m.material.dispose(); }
      a.drones.forEach((m, di) => {
        const ang = now / 720 + di * (Math.PI * 2 / Math.max(1, colors.length));
        m.position.set(grp.position.x + Math.cos(ang) * 0.5, grp.position.y + 0.06 + Math.sin(ang * 2) * 0.03, grp.position.z + Math.sin(ang) * 0.34);
        m.rotation.y = ang * 2;
        m.material.color.set(colors[di]); m.material.emissive.set(colors[di]);
      });
      if (i === g.active) {
        activeRing.visible = true;
        activeRing.position.set(grp.position.x, PANEL_Y + 0.005, grp.position.z);
        activeRing.material.opacity = 0.55 + 0.35 * (0.5 + 0.5 * Math.sin(now / 260));
      }
    });
    for (const [u, a] of aircraft) {
      if (seen.has(u)) continue;
      removeAircraft(a);
      aircraft.delete(u);
    }
  }

  const tmpA = new THREE.Vector3();
  // まっすぐ飛ぶ（撃った直後は少しゆっくり、だんだん速く）
  function flightPoint(pr, p, out) {
    return out.lerpVectors(pr.start, pr.end, p * (0.62 + 0.38 * p));
  }
  function disposeProjectile(pr) {
    scene.remove(pr.model.group);
    pr.model.trail.forEach(s => { scene.remove(s); s.material.dispose(); });
    pr.model.group.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } else if (o.isSprite) o.material.dispose(); });
  }
  function syncProjectiles(g, now) {
    const seen = new Set();
    for (const ef of g.effects) {
      if (ef.type !== 'cardProjectile') continue;
      const p = (now - ef.start) / (ef.duration || 480);
      if (p < 0 || p > 1) continue;
      seen.add(ef);
      let pr = projectiles.get(ef);
      if (!pr) {
        const model = makeProjectile(bridge.cardCategory(ef.cardId) === 'fire' ? 'fire' : 'support', glowTex);
        scene.add(model.group);
        model.trail.forEach(s => scene.add(s));
        const sx = (ef.startCell ? ef.startCell.x : 3.5) - 3.5, sz = (ef.startCell ? ef.startCell.y : 5.5) - 3.5;
        const end = effectPlanePoint(3.5 + (Math.random() - 0.5) * 0.3, FX_HIT_ROW, new THREE.Vector3());
        end.y += (Math.random() - 0.5) * 0.2;
        pr = { model, history: [], start: new THREE.Vector3(sx, FLY_Y + 0.02, sz), end };
        projectiles.set(ef, pr);
      }
      const pos = flightPoint(pr, p, tmpA);
      pr.model.group.position.copy(pos);
      pr.model.group.lookAt(pr.end);
      pr.model.group.rotateY(Math.PI);           // 模型の機首は -Z。lookAt は +Z を向けるので反転
      pr.history.unshift(pos.clone());
      if (pr.history.length > 20) pr.history.length = 20;
      pr.model.trail.forEach((s, i) => {
        const h = pr.history[Math.min(pr.history.length - 1, i * 2 + 1)];
        if (h) { s.position.copy(h); s.visible = true; } else s.visible = false;
      });
    }
    for (const [ef, pr] of projectiles) {
      if (seen.has(ef)) continue;
      disposeProjectile(pr);
      projectiles.delete(ef);
    }
  }

  function updatePillars(g, now) {
    const choosing = choosingCell(g);
    const unit = choosing ? bridge.curUnit() : null;
    pillarMat.opacity = 0.22 + 0.12 * (0.5 + 0.5 * Math.sin(now / 260));
    for (const p of pillars) {
      let show = false;
      if (choosing) {
        const occupied = bridge.isGridOccupied(p.col, p.row, g.mode === 'move' ? unit : null);
        const current = g.mode === 'move' && unit && bridge.unitCol(unit) === p.col && unit.row === p.row;
        show = !occupied || !!current;
      }
      p.g.visible = show;
    }
  }

  // ---------------------------------------------------------------------------
  // 下ごしらえ（v355〜）：タイトル画面など盤面が出ていない間に、ゲームで使う「絵の作り方」（シェーダー）を
  // いちど全部作っておく。iPhone では、初めて使う絵の作り方を作るたびに一瞬止まるので、作戦の開始・
  // 初めての移動（半透明の機体・光の柱）・初めての演出のときに引っかからないようにする。
  // ---------------------------------------------------------------------------
  let warmed = false;
  // 1回分：仮の物を置いて1枚描き、すぐ片付ける（描く合間に盤面が出ても、仮の物が映らないように）
  function warmPass(transparent) {
    const temps = [], shown = [];
    const show = o => { if (o && !o.visible) { o.visible = true; shown.push(o); } };
    try {
      if (!transparent) {
        // 森林の木・海底の岩山の材質（1本ずつ）
        for (const nm of ['tree', 'rock']) {
          const parts = templates[nm] && sceneryParts(templates[nm]);
          if (!parts) continue;
          const im = new THREE.InstancedMesh(parts.geometry, parts.material, 1);
          im.setMatrixAt(0, new THREE.Matrix4());
          im.frustumCulled = false;
          scene.add(im);
          temps.push({ obj: im, dispose: () => im.dispose() });
        }
        // ミサイル・麻酔弾と軌跡、追従ドローン
        for (const kind of ['fire', 'support']) {
          const pm = makeProjectile(kind, glowTex);
          pm.group.position.set(kind === 'fire' ? -0.5 : 0.5, FLY_Y, 0);
          scene.add(pm.group);
          pm.trail.forEach(sp => { sp.position.set(0, FLY_Y, 0.3); scene.add(sp); });
          temps.push({ obj: pm.group, dispose: () => disposeProjectile({ model: pm }) });
        }
        const drone = new THREE.Mesh(droneGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.3, flatShading: true }));
        drone.castShadow = true; drone.position.set(0, FLY_Y, 1.5);
        scene.add(drone);
        temps.push({ obj: drone, dispose: () => drone.material.dispose() });
        // 移動先の光の柱・押しているマスの枠・怪獣の足元の輪・行動中の輪・戦術パネル・「！」
        show(tacticalPlane); show(pickFrame); show(pickRing); show(activeRing); show(warnSprite);
        if (pillars[0]) show(pillars[0].g);
        // 砂ぼこり・泡（見えない粒を1つずつ）
        stageFx.warm(true);
        temps.push({ obj: null, dispose: () => stageFx.warm(false) });
      }
      // 機体：ふつうのもの／半透明のもの（移動先・帰還中）
      const tplName = AIRCRAFT_MODEL_NAMES.find(n => templates[n]);
      if (tplName) {
        const type = AIRCRAFT_MODEL_NAMES.indexOf(tplName);
        const m = makeAircraftFromModel(templates[tplName], type);
        m.setAlpha(transparent ? 0.42 : 1);
        m.group.position.set(0, FLY_Y, 1);
        m.group.traverse(o => { if (o.isMesh) o.frustumCulled = false; });
        scene.add(m.group);
        temps.push({ obj: m.group, dispose: () => m.dispose() });
      }
      // 半透明の怪獣（退場）と、研究URの網目
      if (transparent) { kaiju.setAlpha(0.5); scanMeshes.forEach(w => { w.visible = true; }); }
      const aspect = W / H;
      placeCamera(cam.elev, fitDistance(cam.elev, cam.target, cam.fov, aspect, CAMERA_POSES.oblique.fit), cam.target, cam.fov, aspect);
      kaiju.root.updateMatrixWorld(true);
      renderer.render(scene, camera);
    } finally {
      if (transparent) { try { kaiju.setAlpha(1); } catch (e) {} scanMeshes.forEach(w => { w.visible = false; }); }
      shown.forEach(o => { o.visible = false; });
      temps.forEach(t => { if (t.obj) scene.remove(t.obj); try { t.dispose(); } catch (e) {} });
    }
  }
  async function warmUp() {
    if (warmed || !running || contextLost) return;
    if (bridge.boardVisible()) return;          // もうゲームが始まっていたら、その場その場で作る
    warmed = true;
    const t0 = performance.now();
    try {
      applyStage(bridge.stageId());            // 霧・光・映り込みの空・景色
      for (const transparent of [false, true]) {
        await yieldToUi(50);                   // 1回ごとにひと息つく（タップや音を先に通す）
        if (!running || contextLost || bridge.boardVisible()) break;
        warmPass(transparent);
      }
    } catch (e) {
      console.warn('[N.O.A.H. 3D] 下ごしらえで問題がありました（ゲームには影響しません）', e);
    }
    stats.warmMs = Math.round(performance.now() - t0);
  }

  // ---------------------------------------------------------------------------
  // 毎フレーム
  // ---------------------------------------------------------------------------
  let raf = 0, last = performance.now(), running = true, lastRender = 0, errors = 0;
  let walkAmp = 0, lastScroll = null, lunge = 0, charge = 0, aircraftMoving = false;
  const viewProj = new THREE.Matrix4(), viewFrustum = new THREE.Frustum();
  let debugPose = null;   // テスト用：怪獣の姿勢を固定する（{ walk, scroll, lunge, charge, t }）
  const stats = { frames: 0, renderMs: 0, frameMs: 0, tacticalMs: 0, tacticalDraws: 0, effectsMs: 0 };
  // 端末が追いつかない（4秒間、画面の更新が毎秒38回を下回る）ときは、解像度などを1段ずつ下げる
  // 戦術パネル（移動先・攻撃予測）の描き直しは毎秒10回（v355〜。毎秒15回のとき、描き直しの間隔でコマが抜けているように見えたため）
  let quality = 0, qualityLocked = false, tacticalInterval = 100, lastRaf = 0, windowStart = 0, startedAt = performance.now();
  const intervals = [];
  function applyQuality() {
    if (quality >= 1) renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    if (quality >= 2) {
      renderer.setPixelRatio(1);
      tacticalInterval = 125;
      sun.shadow.mapSize.set(512, 512);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    // いちばん軽い段では、左右の木・岩山を出さない（砂ぼこり・泡も少なめに）
    if (scenery && scenery.setLite) scenery.setLite(quality >= 2);
    stageFx.setLite(quality >= 2);
    resize();
  }
  function watchSpeed(now) {
    if (lastRaf && now - lastRaf < 1000) intervals.push(now - lastRaf);
    lastRaf = now;
    if (!windowStart) windowStart = now;
    if (now - windowStart < 4000) return;
    if (!qualityLocked && now - startedAt > 5000 && intervals.length > 30 && quality < 2) {
      const sorted = intervals.slice().sort((a, b) => a - b);
      const at = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      // v355: 低電力モードや本体が熱いとき、iPhone は描く回数を毎秒30回に抑える（ブラウザ側の制限）。
      // そのときは軽くしても速くならないので、毎秒30回できれいに揃っている間は段を下げない
      // （画質が粗くなったり、木・岩山が消えたりしないように）。
      const steady30 = at(0.2) > 30 && at(0.8) < 37;
      if (at(0.5) > 26 && !steady30) { quality++; applyQuality(); }
    }
    intervals.length = 0; windowStart = now;
  }
  let contextLost = false;
  const onLost = (e) => { e.preventDefault(); contextLost = true; };
  const onRestored = () => { contextLost = false; groundImg = null; };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  function frame() {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    // 時刻が戻ったとき（テスト用の止めた時計など。実機では起きない）に、動きが暴れたり描くのが止まったりしないように
    if (now < last) { lastRender = 0; lastRaf = 0; windowStart = 0; intervals.length = 0; }
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    if (contextLost || !bridge.boardVisible()) { lastRaf = 0; windowStart = 0; intervals.length = 0; return; }
    const g = bridge.game;
    if (!g) return;
    watchSpeed(now);
    // 動きの少ないときは毎秒30回ほどに抑えて電池を節約する
    const busy = g.effects.length > 0 || walkAmp > 0.02 || pressId !== null || lunge > 0.02 || charge > 0.02 || aircraftMoving ||
      (typeof g.aircraftEntryProgress === 'number' && g.aircraftEntryProgress < 1) || camSettling || Math.abs(cam.elev - desiredPose(g).elev) > 0.3;
    if (!busy && now - lastRender < 31) return;
    lastRender = now;
    try {
      const f0 = performance.now();
      renderFrame(g, now, dt);
      stats.frameMs += performance.now() - f0;
      errors = 0;
    } catch (err) {
      errors++;
      if (errors === 1) console.warn('[N.O.A.H. 3D]', err);
      if (errors > 20 && bridge.onFatal) { running = false; bridge.onFatal(err); }
    }
  }

  function renderFrame(g, now, dt) {
    const t = now / 1000;
    const geom = bridge.geom();

    // ステージと地形
    applyStage(bridge.stageId());
    const src = bridge.groundImage();
    if (src && src !== groundImg && (src.naturalWidth || src.width)) {
      groundImg = src;
      let img = src;
      if (!textureSafe(src)) {
        const safe = safeGround[lookStage === 'seafloor' ? 'seafloor' : 'forest'];
        if (safe && typeof safe === 'object') img = safe;
        else { img = proceduralGround(lookStage); loadSafeGround(lookStage); }
      }
      groundTex.image = img;
      groundTex.needsUpdate = true;
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      tileH = TILE_W * ih / Math.max(1, iw);
      groundTex.repeat.set(GROUND_W / TILE_W, GROUND_L / tileH);
      groundTex.offset.x = 0.5 - 0.5 * groundTex.repeat.x;
    }
    const scroll = Number.isFinite(g.bgVisualOffsetCells) ? g.bgVisualOffsetCells : (g.bgOffsetCells || 0);
    const oy = (geom.offsetY || 0) / (geom.cell || 1);
    groundTex.offset.y = 1 - (GROUND_ZC + GROUND_L / 2) / tileH - (3.5 + oy + scroll) / tileH;

    // 怪獣：地形が流れている間は歩く
    if (lastScroll === null) lastScroll = scroll;
    const prevScroll = lastScroll;
    const speed = Math.abs(scroll - lastScroll) / Math.max(dt, 1e-3);
    lastScroll = scroll;
    walkAmp = smooth(walkAmp, speed > 0.05 ? 1 : 0, speed > 0.05 ? 8 : 3, dt);
    const jitter = bridge.kaijuJitter() || { x: 0 };
    const cellPx = geom.cell || 50;
    const attacking = now < (g.kaijuAttackJitterUntil || 0) && (g.kaijuAttackJitterScale == null || g.kaijuAttackJitterScale > 0.5);
    lunge = smooth(lunge, attacking ? 1 : 0, attacking ? 10 : 4, dt);
    const kAlpha = Math.max(0, 1 - clamp01(Number(g.kaijuFadeProgress) || 0));
    const charging = kAlpha > 0.16 && bridge.kaijuCharging();
    charge = smooth(charge, charging ? 1 : 0, charging ? 2.5 : 4, dt);
    if (debugPose) kaiju.animate(debugPose.t != null ? debugPose.t : t, debugPose.scroll != null ? debugPose.scroll : scroll, debugPose.walk || 0, 0, debugPose.lunge || 0, debugPose.charge || 0);
    else kaiju.animate(t, scroll, walkAmp, (jitter.x || 0) / cellPx, lunge, charge);
    kaiju.root.visible = kAlpha > 0.01;
    kaiju.setAlpha(kAlpha);
    kaiju.root.scale.setScalar(bridge.kaijuHeightCells() / 3);
    kaiju.root.updateMatrixWorld(true);
    if (!debugPose) kaijuFootfalls(prevScroll, scroll, kAlpha);
    warnSprite.visible = charging;
    if (warnSprite.visible) {
      kaiju.head.getWorldPosition(tmpHead);
      const pulse = 0.5 + 0.5 * Math.sin(now / 180);
      warnSprite.position.set(tmpHead.x, tmpHead.y + 0.95, tmpHead.z);
      warnSprite.scale.setScalar(0.82 + pulse * 0.1);
    }

    // 機体・ミサイル・目印
    activeRing.visible = false;
    aircraftMoving = false;
    syncAircraft(g, now, dt);
    syncProjectiles(g, now);
    updatePillars(g, now);
    updatePickVisuals(g);
    updateFlash(g, now);
    updateScan(g);

    // カメラ
    const pose = desiredPose(g);
    const rate = 4.5;
    const aspect = W / H;
    const poseT = poseTarget(pose, aspect);
    cam.elev = smooth(cam.elev, pose.elev, rate, dt);
    cam.fov = smooth(cam.fov, pose.fov, rate, dt);
    cam.target.x = smooth(cam.target.x, poseT.x, rate, dt);
    cam.target.y = smooth(cam.target.y, poseT.y, rate, dt);
    cam.target.z = smooth(cam.target.z, poseT.z, rate, dt);
    // 距離：いまの角度で、この構えの点がすべて画面に入る距離へ、なめらかに寄せる（構えが変わったときに跳ばないように）
    const wantDist = fitDistance(cam.elev, cam.target, cam.fov, aspect, pose.fit);
    cam.dist = cam.dist > 0 ? smooth(cam.dist, wantDist, rate, dt) : wantDist;
    camSettling = Math.abs(cam.dist - wantDist) > 0.01 || Math.abs(cam.elev - pose.elev) > 0.3 || Math.abs(cam.target.z - poseT.z) > 0.01;
    placeCamera(cam.elev, cam.dist, cam.target, cam.fov, aspect);
    // 機体のHPの札（カメラが決まってから位置を合わせる）
    updateHpPlates(g, now);
    // 左右の景色（カメラに映る分だけ）
    if (scenery) {
      viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      viewFrustum.setFromProjectionMatrix(viewProj);
      scenery.update(scroll, viewFrustum);
    }
    // 砂ぼこり・泡
    blastBubbles(g, now);
    stageFx.update(now, scroll, camera);

    // 戦術パネル（2Dで描いた絵を写す）。何も出ないときは写さない。動きのある表示は毎秒10回（重い端末では8回）、HPバーだけなら毎秒4回
    const level = bridge.tacticalLevel ? bridge.tacticalLevel() : 2;
    tacticalPlane.visible = level > 0;
    if (level > 0 && (level !== lastTacticalLevel || now - lastTacticalDraw > (level >= 2 ? tacticalInterval : 250))) {
      const t0 = performance.now();
      lastTacticalDraw = now;
      bridge.drawTactical(tacticalCanvas);   // 盤面の正方形をそのまま 512×512 に描いてもらう
      tacticalTex.needsUpdate = true;
      stats.tacticalMs += performance.now() - t0; stats.tacticalDraws++;
    }
    lastTacticalLevel = level;

    const r0 = performance.now();
    renderer.render(scene, camera);
    stats.renderMs += performance.now() - r0;
    stats.frames++;

    // カード演出（2Dのまま、3Dの位置に合わせて画面に平行に描く）
    const e0 = performance.now();
    bridge.drawEffects(fxProject);
    stats.effectsMs += performance.now() - e0;
  }
  raf = requestAnimationFrame(frame);

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    for (const pr of projectiles.values()) disposeProjectile(pr);
    projectiles.clear();
    for (const a of aircraft.values()) removeAircraft(a);
    aircraft.clear();
    if (ghost) { scene.remove(ghost.model.group); ghost.model.dispose(); ghost = null; }
    if (scenery) { scene.remove(scenery.group); scenery.dispose(); scenery = null; }
    scene.remove(stageFx.group); stageFx.dispose();
    scanMeshes.forEach(w => { if (w.parent) w.parent.remove(w); });
    scene.remove(kaiju.root);
    kaiju.dispose();
    disposeObject(scene);
    parsedScenes.forEach(s => disposeObject(s));
    parsedScenes.length = 0;
    scanMat.dispose();
    if (envRT) { envRT.dispose(); envRT = null; }
    envTex = null;
    groundTex.dispose(); tacticalTex.dispose(); glowTex.dispose();
    cleanups.forEach(fn => { try { fn(); } catch (e) {} });
    renderer.dispose();
    try { renderer.forceContextLoss(); } catch (e) {}
    board2d.style.transform = '';
    Object.assign(board2d.style, saved2dStyle);
  }

  return {
    stop,
    setCameraMode() {},   // v359：視点はフェイズで自動（移動フェイズは真上・それ以外は斜め）。古い呼び出しのために残す
    setQuality(q, lock) { qualityLocked = !!lock; quality = Math.max(0, Math.min(2, q | 0)); if (quality === 0) { renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); tacticalInterval = 100; } applyQuality(); },
    get cameraMode() { const g = bridge.game; return desiredPose(g) === CAMERA_POSES.top ? 'top' : 'oblique'; },
    stats() {
      return {
        frames: stats.frames,
        avgRenderMs: stats.frames ? stats.renderMs / stats.frames : 0,
        avgFrameMs: stats.frames ? stats.frameMs / stats.frames : 0,
        avgTacticalMs: stats.tacticalDraws ? stats.tacticalMs / stats.tacticalDraws : 0, tacticalDraws: stats.tacticalDraws,
        avgEffectsMs: stats.frames ? stats.effectsMs / stats.frames : 0,
        camDist: cam.dist, elev: cam.elev, size: [W, H], pixelRatio: renderer.getPixelRatio(),
        calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
        aircraft: aircraft.size, projectiles: projectiles.size, stage: lookStage, warn: warnSprite.visible,
        pillars: pillars.filter(p => p.g.visible).length,
        running, contextLost, errors, visible: bridge.boardVisible(), quality,
        models: {
          kaiju: kaiju.real ? 'real' : 'placeholder',
          aircraftReal: [...aircraft.values()].filter(a => a.model.real).length,
          scenery: scenery ? (scenery.real ? 'real' : 'placeholder') : 'none',
          sceneryDrawn: scenery && scenery.visibleCount ? scenery.visibleCount() + '/' + scenery.total : '',
          loaded: Object.keys(templates).concat(kaiju.real ? [KAIJU_MODEL_NAME] : []),
          errors: Object.assign({}, modelErrors),
        },
        charge, warmMs: stats.warmMs == null ? null : stats.warmMs,
        fx: stageFx.count(),
        cameraPose: desiredPose(bridge.game) === CAMERA_POSES.top ? 'top' : 'oblique',
        hp: [...hpPlates.values()].map(p => ({ hp: p.hp, max: p.max, shown: p.shown, x: Math.round(p.x), y: Math.round(p.y), w: p.w, h: p.h })),
      };
    },
    // テスト用：砂ぼこり・泡をすぐに出す（{ foot: [x, z] } / { burst: [bx, by, peak] } / { ambient: true }）
    debugFx(o) {
      if (o && o.foot) stageFx.footfall(o.foot[0], o.foot[1]);
      if (o && o.burst) { const v = effectPlanePoint(o.burst[0], o.burst[1]); stageFx.burst(v.x, v.y, v.z, o.burst[2] || 14); }
      if (o && o.ambient) stageFx.debugAmbient(performance.now());
      return stageFx.count();
    },
    // テスト用：怪獣の姿勢を固定する（null で元に戻す）
    debugKaijuPose(p) { debugPose = p || null; },
    // テスト用：場面の中身（重さの内訳を調べるときに一部を隠す）
    debugParts() { return { scene, kaiju: kaiju.root, scenery: scenery && scenery.group, ground, aircraft: [...aircraft.values()].map(a => a.model.group), sun }; },
    // テスト用：盤面の位置（x, y）が画面のどこに映っているか（host 内の CSS px）
    screenOfCell(bx, by, y) { return toScreen(new THREE.Vector3(bx - 3.5, y == null ? PANEL_Y : y, by - 3.5)); },
    screenOfKaiju() { return toScreen(new THREE.Vector3(0, 1.6, KAIJU_Z)); },
    screenOfEffectPoint(bx, by) { return toScreen(effectPlanePoint(bx, by)); },
    debugProjectiles() { return [...projectiles.values()].map(pr => { const p = pr.model.group.position; const s = toScreen(p); return { pos: [p.x, p.y, p.z].map(v => +v.toFixed(2)), screen: [Math.round(s.x), Math.round(s.y)], visible: pr.model.group.visible, inScene: !!pr.model.group.parent }; }); },
  };
  }
}

window.NOAH3D = { start, version: 'v359' };
})();
