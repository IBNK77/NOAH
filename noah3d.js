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
// v365〜：見た目の強化（光の当て方・縁の光・雲の影／水面からの光・霧・光の筋・鳥や魚の群れ・火花と煙・足元の影・
//   画面の揺れ・にじむ光）。まとめて「v365 見た目の強化」の所にある。数字は STAGE_LOOK・ATMOS・BLOOM_LOOK で変えられる。
// =============================================================================
(function () {
'use strict';
const THREE = window.THREE;
if (!THREE) throw new Error('three.js（vendor/three-r170.min.js）が読み込まれていません');

// v361：怪獣を大きく・機体とマスを高高度に・カメラを低く（見上げ気味）にした。数字を変えるときはこの4つと CAMERA_POSES の elev / fov。
const KAIJU_SCALE = 1.9;        // 怪獣を大きく見せる倍率（ゲーム上の大きさ＝3マスは変えない。見た目だけ）
const FLY_Y = 3.0;              // 機体の飛行高度（v360 までは 1.1）
const PANEL_Y = FLY_Y - 0.12;   // 戦術パネルの高さ（機体の少し下）
const KAIJU_Z = -2.8;           // 怪獣の足元の中心（v360 までは -2。体が大きくなった分だけ奥へ）
const TILE_W = 16.8;            // 地形画像1枚の横幅（2Dの「盤面の横幅の2.4倍」表示と同じ縮尺）
// v363：怪獣を大きくしたので、地面の絵も広げて、道の真ん中を怪獣の足元にそろえる（両足が道に収まるように）。
//  絵の道は横幅の 38〜59%（中心 48.5%）、v362 までの道の幅は約3.4マス。セレヴァーン（1.9倍）の両足は x -1.9〜+2.3（中心 +0.2・幅 4.2マス）
const GROUND_ZOOM = 1.45;       // 地面の絵の拡大（道の幅 約3.4 → 約4.9マス）
const PATH_CENTER_U = 0.485;    // 絵の中の道の中心（横幅に対する割合）
const PATH_CENTER_X = 0.2;      // 道の中心を置く所（怪獣の両足の真ん中）
const TACTICAL_TEX = 512;       // 戦術パネルの絵の解像度
const UNIT_BOARD_COLS = [1, 3, 5];
const TACTICAL_ROWS = [4, 5, 6];

// 演出の面：盤面の y=5.5（中列の機体）では機体の高さ、y=1.7（2Dでミサイルが当たる所）では怪獣の胸の前を通る
const FX_ROW = 5.5, FX_HIT_ROW = 1.7, FX_HIT_Y = 2.0 * KAIJU_SCALE, FX_HIT_Z = KAIJU_Z + 0.9 * KAIJU_SCALE;
const FX_K_Y = (FX_HIT_Y - FLY_Y) / (FX_ROW - FX_HIT_ROW);
const FX_K_Z = (FX_HIT_Z - (FX_HIT_ROW - 3.5)) / (FX_ROW - FX_HIT_ROW);
function effectPlanePoint(bx, by, out = new THREE.Vector3()) {
  // 左右の広がりは、怪獣に近いほど怪獣の大きさに合わせて広げる（怪獣に当たる演出が、大きくなった体に合うように）
  const k = 1 + (KAIJU_SCALE - 1) * Math.max(0, Math.min(1.3, (FX_ROW - by) / (FX_ROW - FX_HIT_ROW)));
  return out.set((bx - 3.5) * k, FLY_Y + FX_K_Y * (FX_ROW - by), by - 3.5 + FX_K_Z * (FX_ROW - by));
}

// カメラの構え。elev は見下ろす角度（度）。fit は画面に必ず入れる点（ここから毎回カメラの距離を決める）。
// v359：移動フェイズ（移動先・出撃先を選ぶ間も）は真上から（top）。それ以外は斜めから、v358 までより寄せて（oblique）、
//       盤面の四隅ではなく「怪獣」と「機体の3×3のマス」が画面いっぱいに入るようにした。左上の視点ボタンは無くした。
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
const CAMERA_POSES = {
  oblique: {
    name: 'oblique', elev: 30, fov: 32, target: V3(0, FLY_Y, 0.55),
    fit: [
      V3(-3.05, PANEL_Y, 0.45), V3(3.05, PANEL_Y, 0.45), V3(-3.05, PANEL_Y, 3.6), V3(3.05, PANEL_Y, 3.6),   // 機体のマス
      V3(-2.0, PANEL_Y, 3.95), V3(2.0, PANEL_Y, 3.95),                                                   // 手前の機体のHPの札
      V3(-2.7, FLY_Y + 0.2, 3.5), V3(2.7, FLY_Y + 0.2, 3.5),                                             // 手前の機体
    ],
    // 怪獣の点（怪獣の高さ＝3 の単位で、足元の中心から [左右, 上下, 前後]）。怪獣の大きさに合わせて広げる（v362。poseFit）
    // 頭の上は 3.75（体のいちばん上は 3）。この余白に、中央上部の追跡の照準が入る
    kaijuFit: [[0, 3.75, -0.5], [-1.75, 2.7, 0.2], [1.75, 2.7, 0.2]],                                   // 頭の上と腕の刃
  },
  top: {
    name: 'top', elev: 90, fov: 30, target: V3(0, PANEL_Y, 0.45),
    fit: [
      V3(-3.05, PANEL_Y, 0.45), V3(3.05, PANEL_Y, 0.45), V3(-3.05, PANEL_Y, 3.6), V3(3.05, PANEL_Y, 3.6),   // 機体のマス
      V3(-2.0, PANEL_Y, 3.85), V3(2.0, PANEL_Y, 3.85),                                                   // 手前の機体のHPの札
    ],
    kaijuFit: [[0, 3.4, -0.5], [-1.6, 2.6, 0.3], [1.6, 2.6, 0.3], [0, 2.6, -1.15]],                    // 怪獣（頭と腕・背中）
  },
};
// 構えに入れる点（機体の点＋怪獣の点）。ks … 怪獣の大きさ（kaiju.root の倍率）
function poseFit(pose, ks) {
  const key = ks.toFixed(4);
  if (pose.fitKey !== key) {
    pose.fitKey = key;
    pose.fitAll = pose.fit.concat(pose.kaijuFit.map(([x, y, z]) => V3(x * ks, y * ks, KAIJU_Z + z * ks)));
  }
  return pose.fitAll;
}

// env … 映り込み用の空の明るさ（v354〜。機体と怪獣にだけ映す）
// にじむ光の [強さ, 明るさのしきい値]（v365）
const BLOOM_LOOK = { forest: [0.5, 0.8], seafloor: [0.55, 0.72] };
const STAGE_LOOK = {
  forest:   { fog: 0x9db3a6, fogNear: 17, fogFar: 52, sky: 0xe2f0ff, ground: 0x34402a, hemi: 1.08, sun: 0xffecc4, sunI: 3.1, exposure: 1.1, env: 0.8, envSun: 3,
              sunPos: [-9.5, 10.5, 3.2], rim: 0xcfe6ff, rimI: 0.62, rimHot: 0xff7a3c, cloud: 0.34, caustic: 0, causticColor: 0xffffff, edge: 0.22, contact: 0.5 },
  seafloor: { fog: 0x0f4b57, fogNear: 12, fogFar: 36, sky: 0xa6ecff, ground: 0x0a2a30, hemi: 0.95, sun: 0xc8f2ff, sunI: 1.7, exposure: 1.1, env: 0.7, envSun: 2.5,
              sunPos: [-6.5, 12, 2.5], rim: 0x66e6ff, rimI: 0.6, rimHot: 0xff8a50, cloud: 0, caustic: 1.0, causticColor: 0xbff4ff, edge: 0.4, contact: 0.42 },
};
// v365：見た目の強化。光の当て方を「左の少し手前の上から」に変えて、怪獣の右半分に陰・地面に影が出るようにした（立体感）。
//   sunPos … 太陽の位置。rim … 怪獣・機体の輪郭の光（縁の光）の色と強さ。rimHot … 必殺技の溜めのときの縁の色
//   cloud … 森林の、地面と怪獣を流れる雲の影の濃さ。caustic … 海底の、水面からの光のゆらめき（コースティクス）の強さ
//   edge … 地面の左右の端を暗くする強さ（真ん中の怪獣に目が行くように）。contact … 怪獣の足元の影の濃さ

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

// v362：必殺技の溜め中に怪獣の頭上に出していた「！」（warnTexture・warnSprite）はやめた。観測HUDの生体モニターで知らせる

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
  float c = cos(iData.z), s = sin(iData.z);
  vec2 q = position.xy * iData.x;
  vec2 qr = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  #ifdef FX_FLAT
  vec4 mvPosition = viewMatrix * vec4(iPos + vec3(qr.x, 0.0, qr.y), 1.0);   // 地面と平行に寝かせた板（v365 低い霧の層）
  #else
  vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
  mvPosition.xy += qr;
  #endif
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
// opt（v365）… flat：地面と平行に寝かせる／additive：光として足す（霧の色は混ぜない）
function makeParticleLayer(tex, max, order, opt = {}) {
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
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: FX_VERT, fragmentShader: FX_FRAG, transparent: true, depthWrite: false, fog: !opt.additive,
    defines: opt.flat ? { FX_FLAT: 1 } : {}, blending: opt.additive ? THREE.AdditiveBlending : THREE.NormalBlending, side: opt.flat ? THREE.DoubleSide : THREE.FrontSide });
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
  const dustL = makeParticleLayer(dustTexture(), 120, 0.5);
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
  function footfall(x, z, scale = 1) {
    const D = sea ? FX_DUST.seafloor : FX_DUST.forest;
    const n = Math.round(D.n * (lite ? 0.5 : 1));
    for (let i = 0; i < n && dust.length < dustL.max; i++) {
      const a = Math.random() * Math.PI * 2, sp = lerpRange(D.speed), r0 = 0.1 + Math.random() * 0.14;
      const s0 = lerpRange(D.size) * scale;
      dust.push({
        x: x + Math.cos(a) * r0 * scale, y: 0, z: z + Math.sin(a) * r0 * 0.8 * scale,
        vx: Math.cos(a) * sp * scale, vy: lerpRange(D.up), vz: Math.sin(a) * sp * 0.8,
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
  // 炸裂のあとに残る煙（v365。森林だけ。海底は泡が出る）
  const smokeColor = new THREE.Color(0x57504a);
  function smoke(x, y, z, peak) {
    if (sea || lite) return;
    const n = peak >= 14 ? 5 : peak >= 9 ? 3 : 2;
    for (let i = 0; i < n && dust.length < dustL.max; i++) {
      const a = Math.random() * Math.PI * 2, s0 = (0.22 + Math.random() * 0.16) * (peak >= 9 ? 1 : 0.7);
      dust.push({
        x: x + Math.cos(a) * 0.12, y: y + (Math.random() - 0.5) * 0.2, z: z + 0.3 + Math.sin(a) * 0.08,
        vx: Math.cos(a) * 0.35, vy: 0.25 + Math.random() * 0.3, vz: Math.sin(a) * 0.2,
        age: 0, life: 1.1 + Math.random() * 0.9, s0, s1: s0 * 3.2, a: 0.5 + Math.random() * 0.2,
        rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 1.2, c: smokeColor,
        drag: 2.2, buoy: 0.35, maxUp: 0.7, lift: 0, wob: 0, fin: 0.12, fout: 0.35,
      });
    }
  }
  // ミサイル・麻酔弾の航跡（v365）：森林では煙が少しの間残る。海底では細かい泡が昇っていく
  const trailColor = { fire: new THREE.Color(0xe9e3d8), support: new THREE.Color(0xc9efe0) };
  function trail(x, y, z, fire) {
    if (sea) { if (Math.random() < (lite ? 0.35 : 0.7)) bubbleAt(x, y, z, 1, 'ambient', 0.06); return; }
    if (dust.length >= dustL.max - 8) return;
    const s0 = fire ? 0.15 + Math.random() * 0.06 : 0.09 + Math.random() * 0.03;
    dust.push({
      x: x + (Math.random() - 0.5) * 0.05, y: y + (Math.random() - 0.5) * 0.05, z,
      vx: (Math.random() - 0.5) * 0.12, vy: 0.03 + Math.random() * 0.06, vz: (Math.random() - 0.5) * 0.12,
      age: 0, life: (fire ? 0.9 : 0.6) + Math.random() * 0.5, s0, s1: s0 * (fire ? 3.4 : 2.6), a: fire ? 0.72 : 0.5,
      rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 1.4, c: fire ? trailColor.fire : trailColor.support,
      drag: 2.5, buoy: 0.05, maxUp: 0.3, lift: 0, wob: 0, fin: 0.05, fout: 0.25,
    });
  }
  function ambient(now) {
    if (!nextAmbient) nextAmbient = now + 1200 + Math.random() * 2000;
    if (now >= nextAmbient) {
      nextAmbient = now + (lite ? 2 : 1) * (3000 + Math.random() * 4000);   // 3〜7秒おき（ときどき・ほんの少し）
      // 6割は道の外（岩場のすき間）、4割は道の上から（v363：広げた道に合わせる）
      const outside = Math.random() < 0.6;
      const x = PATH_CENTER_X + (outside ? (Math.random() < 0.5 ? -1 : 1) * (2.8 + Math.random() * 2.8) : (Math.random() - 0.5) * 4.2);
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
    group, setStage, footfall, burst, smoke, trail, update, warm,
    setLite(on) { lite = !!on; },
    count: () => ({ dust: dust.length, bubbles: bubbles.length, emitters: emitters.length }),
    // テスト用：すぐに泡を出す
    debugAmbient(now) { nextAmbient = now; },
    dispose() { dustL.dispose(); bubL.dispose(); },
  };
}

// =============================================================================
// v365 見た目の強化（iPhone SE3 で無理なく動く範囲で）
//   ① 光：怪獣・機体・地面の「絵の作り方」（シェーダー）に少しだけ書き足す（patchLit）
//        ・縁の光（輪郭が背景から浮き上がる。必殺技の溜めでは熱い色に変わる）
//        ・森林…雲の影が地面と怪獣を流れる／海底…水面からの光のゆらめき（コースティクス）が地面と怪獣に映る
//        ・地面の左右の端を少し暗くする
//   ② 空気（makeAtmos）：低い霧の層・光の筋・ただよう粒（森林は光る塵、海底はマリンスノー）・
//        鳥の群れ／魚の群れ（怪獣の大きさが分かる）・必殺技の溜めで胸の器官へ集まる光の粒
//   ③ にじむ光（makeBloom）：描いた絵の明るい所だけを小さくぼかして重ねる（胸の器官・噴射・白い甲殻のハイライトがふわっと光る）
//   どれも「追いつかない端末」では quality の段に合わせて減らす・止める（applyQuality）。
// =============================================================================
// 雲の影の元（R：大きなかたまり、G：細かいむら）。上下左右がつながる
const cloudNoiseTexture = () => {
  const N = 256, data = new Uint8Array(N * N * 4);
  const fbm = (seed, freqs) => {
    const out = new Float32Array(N * N);
    let amp = 1, tot = 0;
    freqs.forEach((f, o) => {
      const r = rng(seed + o * 131), g = new Float32Array(f * f);
      for (let i = 0; i < g.length; i++) g[i] = r();
      for (let y = 0; y < N; y++) {
        const v = y / N * f, y0 = Math.floor(v), fy = v - y0, sy = fy * fy * (3 - 2 * fy), ya = (y0 % f) * f, yb = ((y0 + 1) % f) * f;
        for (let x = 0; x < N; x++) {
          const u = x / N * f, x0 = Math.floor(u), fx = u - x0, sx = fx * fx * (3 - 2 * fx), xa = x0 % f, xb = (x0 + 1) % f;
          const a = g[ya + xa] + (g[ya + xb] - g[ya + xa]) * sx, b = g[yb + xa] + (g[yb + xb] - g[yb + xa]) * sx;
          out[y * N + x] += (a + (b - a) * sy) * amp;
        }
      }
      tot += amp; amp *= 0.5;
    });
    for (let i = 0; i < out.length; i++) out[i] /= tot;
    return out;
  };
  const a = fbm(911, [3, 6, 12, 24]), b = fbm(377, [5, 10, 20, 40]);
  for (let i = 0; i < N * N; i++) { data[i * 4] = a[i] * 255; data[i * 4 + 1] = b[i] * 255; data[i * 4 + 3] = 255; }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
};
// 水面からの光のゆらめきの元（細い光の網目）。上下左右がつながる。2枚を別々の速さで流して暗い方を取ると、ゆらめいて見える
const causticTexture = () => {
  const N = 256, C = 7, r = rng(2024), pts = [], data = new Uint8Array(N * N * 4);
  for (let i = 0; i < C * C; i++) pts.push([r(), r()]);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N * C, v = y / N * C, cx = Math.floor(u), cy = Math.floor(v);
    let f1 = 9, f2 = 9;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const p = pts[((cy + dy + C) % C) * C + ((cx + dx + C) % C)];
      const d = Math.hypot(u - (cx + dx + p[0]), v - (cy + dy + p[1]));
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    const line = Math.pow(1 - Math.min(1, (f2 - f1) / 0.42), 3.4);
    const c = Math.min(1, line * 0.92 + 0.08 * (1 - Math.min(1, f1)));
    const i = (y * N + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = c * 255; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
};
// 光の筋（上が明るく、下へ行くほど消える。左右の端もやわらかく消える）
const rayTexture = () => canvasTexture(64, 256, (g) => {
  const gv = g.createLinearGradient(0, 0, 0, 256);
  gv.addColorStop(0, 'rgba(255,255,255,0)'); gv.addColorStop(0.1, 'rgba(255,255,255,1)'); gv.addColorStop(0.55, 'rgba(255,255,255,.4)'); gv.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gv; g.fillRect(0, 0, 64, 256);
  g.globalCompositeOperation = 'destination-in';
  const gh = g.createLinearGradient(0, 0, 64, 0);
  gh.addColorStop(0, 'rgba(255,255,255,0)'); gh.addColorStop(0.5, 'rgba(255,255,255,1)'); gh.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gh; g.fillRect(0, 0, 64, 256);
});
// 足元の影（まん中が濃く、外へ消える）と、足が着いたときに地面に広がる輪
const blobTexture = () => canvasTexture(128, 128, (g) => {
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,1)'); grd.addColorStop(0.45, 'rgba(0,0,0,.62)'); grd.addColorStop(0.8, 'rgba(0,0,0,.14)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
});
const ringTexture = () => canvasTexture(128, 128, (g) => {
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,0)'); grd.addColorStop(0.55, 'rgba(255,255,255,.06)'); grd.addColorStop(0.8, 'rgba(255,255,255,.9)'); grd.addColorStop(0.9, 'rgba(255,255,255,.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
});
let sharedGlowTex = null;
const sharedGlow = () => sharedGlowTex || (sharedGlowTex = glowTexture());

// ① 光：みんなで使う値（毎コマ、本体が書きかえる）
const noahU = {
  uNoahScroll: { value: 0 },                          // 地形の流れた量（地面にくっついた模様にするため）
  uNoahWind: { value: new THREE.Vector2() },          // 雲の流れ
  uNoahNoise: { value: null }, uNoahCloud: { value: 0 },
  uNoahCausTex: { value: null }, uNoahCaus: { value: 0 }, uNoahCausColor: { value: new THREE.Color(1, 1, 1) },
  uNoahCausA: { value: new THREE.Vector2() }, uNoahCausB: { value: new THREE.Vector2() },
  uNoahRim: { value: new THREE.Color(0, 0, 0) },      // 縁の光の色（強さ込み）
  uNoahEdge: { value: 0 },
};
const NOAH_LIT_PARS = `
varying vec3 vNoahW;
uniform float uNoahScroll;
uniform vec2 uNoahWind;
uniform sampler2D uNoahNoise;
uniform float uNoahCloud;
uniform sampler2D uNoahCausTex;
uniform float uNoahCaus;
uniform vec3 uNoahCausColor;
uniform vec2 uNoahCausA;
uniform vec2 uNoahCausB;
uniform vec3 uNoahRim;
uniform float uNoahEdge;
`;
const NOAH_LIT_COMMON = `
	vec2 noahG = vec2( vNoahW.x, vNoahW.z + uNoahScroll );
	vec3 noahN = inverseTransformDirection( normal, viewMatrix );
	float noahCl = texture2D( uNoahNoise, noahG * 0.03 + uNoahWind ).r * 0.72 + texture2D( uNoahNoise, noahG * 0.085 - uNoahWind * 1.9 ).g * 0.28;
	outgoingLight *= 1.0 - uNoahCloud * smoothstep( 0.47, 0.63, noahCl );
	float noahCa = min( texture2D( uNoahCausTex, noahG * 0.15 + uNoahCausA ).r, texture2D( uNoahCausTex, noahG * 0.19 + uNoahCausB ).r );
	outgoingLight += ( diffuseColor.rgb * 0.8 + 0.035 ) * uNoahCausColor * ( noahCa * uNoahCaus * NOAH_CAUS_K * clamp( noahN.y * 0.75 + 0.45, 0.0, 1.0 ) );
`;
const noahRimCode = k => `
	float noahF = 1.0 - clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
	outgoingLight += uNoahRim * ( ${k.toFixed(2)} * pow( noahF, 2.6 ) * ( 0.3 + 0.7 * clamp( noahN.y * 0.5 + 0.62, 0.0, 1.0 ) ) );
`;
const NOAH_LIT_MAIN = {
  kaiju: '\n#define NOAH_CAUS_K 0.36' + NOAH_LIT_COMMON + noahRimCode(1),
  aircraft: '\n#define NOAH_CAUS_K 0.5' + NOAH_LIT_COMMON + noahRimCode(0.55),
  ground: '\n#define NOAH_CAUS_K 1.8' + NOAH_LIT_COMMON + `
	outgoingLight *= 1.0 - uNoahEdge * smoothstep( 3.6, 12.5, abs( vNoahW.x - ${PATH_CENTER_X.toFixed(2)} ) );
`,
};
// 材質に①を書き足す。kind … 'kaiju' | 'aircraft' | 'ground'
function patchLit(mat, kind) {
  if (!mat || !mat.isMeshStandardMaterial) return;
  mat.userData.noahLit = kind;
  mat.onBeforeCompile = sh => {
    for (const k in noahU) sh.uniforms[k] = noahU[k];
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNoahW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvNoahW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOAH_LIT_PARS)
      .replace('#include <opaque_fragment>', '{' + NOAH_LIT_MAIN[kind] + '}\n\t#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => 'noahLit-' + kind;
  mat.needsUpdate = true;
}

// ② 空気
const CRIT_VERT = `
attribute vec3 iPos;
attribute vec4 iData;   // 向き・大きさ・羽ばたきの位相・濃さ
attribute float aTip;
uniform float uTime;
uniform vec3 uFlapAxis;
uniform float uFlapAmp;
uniform float uFlapHz;
varying float vAlpha;
varying float vShade;
#include <fog_pars_vertex>
void main() {
  float fl = sin( uTime * uFlapHz + iData.z );
  vec3 p = position + uFlapAxis * ( aTip * fl * uFlapAmp );
  float c = cos( iData.x ), s = sin( iData.x );
  p = vec3( c * p.x + s * p.z, p.y, - s * p.x + c * p.z ) * iData.y;
  vec4 mvPosition = viewMatrix * vec4( iPos + p, 1.0 );
  vAlpha = iData.w;
  vShade = 0.8 + 0.2 * aTip * fl;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const CRIT_FRAG = `
uniform vec3 uColor;
varying float vAlpha;
varying float vShade;
#include <common>
#include <fog_pars_fragment>
void main() {
  gl_FragColor = vec4( uColor * vShade, vAlpha );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
const ATMOS = {
  forest: {
    sheets: { n: 9, color: 0xeef4ea, alpha: [0.1, 0.22], size: [4.2, 7.5], y: [0.14, 0.75], wind: [0.06, 0.16] },
    motes: { n: 22, color: 0xfff0c0, alpha: [0.18, 0.42], size: [0.05, 0.09], vy: 0.035, vx: 0.05 },
    rays: { n: 3, color: 0xfff1c8, alpha: 0.075 },
    crit: { fish: false, color: 0xf6f3ea, size: [0.1, 0.14], speed: [1.7, 2.3], n: [5, 9], every: [9000, 20000], y: [0.7, 2.0], startle: 0.34 },
  },
  seafloor: {
    sheets: { n: 8, color: 0x9fd8d2, alpha: [0.07, 0.14], size: [4.5, 8], y: [0.1, 0.5], wind: [0.02, 0.06] },
    motes: { n: 64, color: 0xd8f6ff, alpha: [0.2, 0.55], size: [0.05, 0.12], vy: -0.05, vx: 0.07 },
    rays: { n: 6, color: 0x8fe4ff, alpha: 0.42 },
    crit: { fish: true, color: 0xc4eef4, size: [0.1, 0.15], speed: [0.9, 1.35], n: [8, 14], every: [8000, 17000], y: [0.5, 2.2], startle: 0.26 },
  },
};
// 光の筋の場所 [x, z, 幅, 高さ, 傾き, 明るさ]（怪獣の後ろ・左右・少し手前。手前のものは怪獣に重なるので控えめに）
const RAY_SPOTS = [[-5.6, -7.5, 2.4, 13, 0.24], [3.9, -9.5, 3.0, 14, 0.2], [-1.6, -11.5, 2.2, 14, 0.27], [6.6, -4.5, 1.9, 12, 0.22], [-7.2, -1.5, 1.6, 11, 0.25], [1.6, 0.6, 1.3, 10, 0.21, 0.45]];
const EMBER_COLOR = 0x8fe6ff;

function makeAtmos() {
  const group = new THREE.Group();
  const sheetL = makeParticleLayer(dustTexture(), 16, 0.42, { flat: true });
  const moteL = makeParticleLayer(glowTexture(), 150, 0.62, { additive: true });
  group.add(sheetL.mesh, moteL.mesh);
  // 光の筋
  const rayTex = rayTexture();
  const rayGeo = new THREE.PlaneGeometry(1, 1); rayGeo.translate(0, 0.5, 0);
  const rays = RAY_SPOTS.map(([x, z, w, h, tilt, gain = 1], i) => {
    const mat = new THREE.MeshBasicMaterial({ map: rayTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(rayGeo, mat);
    m.position.set(x, -0.6, z); m.scale.set(w, h, 1); m.rotation.z = tilt;
    m.renderOrder = 0.46; m.visible = false; m.frustumCulled = false;
    group.add(m);
    return { m, mat, x, gain, ph: i * 1.7, sp: 0.23 + (i % 3) * 0.07 };
  });
  // 鳥・魚
  const CRIT_MAX = 44;
  const birdGeo = new THREE.InstancedBufferGeometry(), fishGeo = new THREE.InstancedBufferGeometry();
  // 鳥：後ろへ反った2枚の翼（先が羽ばたく）＋細い胴。魚：胴＋尾びれ（尾が左右に振れる）
  birdGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.34, 0, 0, 0.1, -1, 0, 0.5, 0, 0, 0.1, 0, 0, -0.34, 1, 0, 0.5, 0, 0, -0.5, -0.09, 0, 0.4, 0.09, 0, 0.4], 3));
  birdGeo.setAttribute('aTip', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 0], 1));
  fishGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.62, 0, 0.2, 0, 0, -0.2, 0, 0, 0.2, 0, 0, -0.2, 0, 0, 0, 0.5, 0, 0, 0.42, 0, 0.23, 0.82, 0, -0.23, 0.82], 3));
  fishGeo.setAttribute('aTip', new THREE.Float32BufferAttribute([0, 0.08, 0.08, 0.08, 0.08, 0.6, 0.6, 1, 1], 1));
  const critPos = new THREE.InstancedBufferAttribute(new Float32Array(CRIT_MAX * 3), 3);
  const critData = new THREE.InstancedBufferAttribute(new Float32Array(CRIT_MAX * 4), 4);
  critPos.setUsage(THREE.DynamicDrawUsage); critData.setUsage(THREE.DynamicDrawUsage);
  for (const geo of [birdGeo, fishGeo]) { geo.setAttribute('iPos', critPos); geo.setAttribute('iData', critData); geo.instanceCount = 0; }
  const critU = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uFlapAxis: { value: new THREE.Vector3(0, 1, 0) }, uFlapAmp: { value: 0.6 }, uFlapHz: { value: 11 }, uColor: { value: new THREE.Color(1, 1, 1) } }]);
  const critMat = new THREE.ShaderMaterial({ uniforms: critU, vertexShader: CRIT_VERT, fragmentShader: CRIT_FRAG, transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide });
  const critMesh = new THREE.Mesh(birdGeo, critMat);
  critMesh.frustumCulled = false; critMesh.renderOrder = 0.6; critMesh.visible = false;
  group.add(critMesh);

  const sheetColor = new THREE.Color(), moteColor = new THREE.Color(), emberColor = new THREE.Color(EMBER_COLOR);
  const sheets = [], motes = [], embers = [], flocks = [];
  let cfg = ATMOS.forest, level = 0, warming = false, lastNow = 0, lastScroll = null, nextFlock = 0, emberAcc = 0;
  const R = Math.random, pick = ([a, b]) => a + R() * (b - a);

  function newSheet(s, anyZ, dir) {
    const C = cfg.sheets;
    s.x = (R() - 0.5) * 22; s.y = pick(C.y); s.z = anyZ ? -22 + R() * 29 : (dir >= 0 ? -22 - R() * 3 : 7 + R() * 3);
    s.size = pick(C.size); s.a = pick(C.alpha); s.vx = pick(C.wind) * (R() < 0.8 ? 1 : -0.4);
    s.rot = R() * 6.28; s.vr = (R() - 0.5) * 0.04; s.ph = R() * 6.28;
    return s;
  }
  function newMote(m, any) {
    const C = cfg.motes;
    m.x = (R() - 0.5) * 15; m.z = -9 + R() * 15; m.y = any ? 0.2 + R() * 7 : (C.vy < 0 ? 7.2 : 0.2);
    m.size = pick(C.size) * (R() < 0.12 ? 1.9 : 1); m.a = pick(C.alpha); m.ph = R() * 6.28; m.f = 0.4 + R() * 0.8;
    m.vx = C.vx * (0.5 + R()); m.vy = C.vy * (0.6 + R() * 0.8);
    return m;
  }
  function setStage(stage) {
    cfg = ATMOS[stage === 'seafloor' ? 'seafloor' : 'forest'];
    sheetColor.set(cfg.sheets.color); moteColor.set(cfg.motes.color);
    sheets.length = 0; motes.length = 0; embers.length = 0; flocks.length = 0; sparks.length = 0; nextFlock = 0;
    for (let i = 0; i < cfg.sheets.n; i++) sheets.push(newSheet({}, true, 1));
    for (let i = 0; i < cfg.motes.n; i++) motes.push(newMote({}, true));
    rays.forEach((r, i) => { r.mat.color.set(cfg.rays.color); r.on = i < cfg.rays.n; });
    critMesh.geometry = cfg.crit.fish ? fishGeo : birdGeo;
    critU.uColor.value.set(cfg.crit.color);
    critU.uFlapAxis.value.set(cfg.crit.fish ? 1 : 0, cfg.crit.fish ? 0 : 1, 0);
    critU.uFlapAmp.value = cfg.crit.fish ? 0.3 : 0.62;
    critU.uFlapHz.value = cfg.crit.fish ? 13 : 11.5;
  }
  function critCount() { let n = 0; for (const f of flocks) n += f.m.length; return n; }
  // 群れ。ambient … 画面を横切る。startle … 怪獣の足音におどろいて、足元の外側から飛び立つ（泳ぎ去る）
  function spawnFlock(kind, fx, fz) {
    const C = cfg.crit;
    const n = Math.round(pick(C.n) * (kind === 'startle' ? 0.7 : 1));
    if (critCount() + n > CRIT_MAX) return;
    const f = { m: [], age: 0, kind };
    if (kind === 'startle') {
      const side = fx > PATH_CENTER_X ? 1 : -1;
      // 鳥は足元の森から、手前（カメラ側）へ舞い上がる。魚は足元から横へ泳ぎ去る（どちらも、画面の中に長くいるように）
      f.x = fx + side * (C.fish ? 0.9 : 1.5 + R() * 0.9); f.y = 0.25; f.z = fz + (R() - 0.3) * 1.4;
      if (C.fish) { f.vx = side * pick(C.speed) * 1.1; f.vy = 0.5; f.vz = (R() - 0.3) * 0.5; }
      else { f.vx = side * (0.35 + R() * 0.5); f.vy = 1.2; f.vz = 1.15 + R() * 0.5; }
      f.life = 4.4; f.spread = 0.25; f.grow = 0.9;
    } else {
      const side = R() < 0.5 ? 1 : -1, far = R() < 0.3;
      f.x = -side * (far ? 13 : 10.5); f.y = far ? 1 + R() * 2.4 : pick(C.y); f.z = far ? -13 + R() * 5 : -0.4 + R() * 3.1;
      f.vx = side * pick(C.speed); f.vy = 0; f.vz = (R() - 0.5) * 0.3;
      f.life = (far ? 26 : 21) / Math.abs(f.vx); f.spread = C.fish ? 0.75 : 1; f.grow = 0;
    }
    for (let i = 0; i < n; i++) {
      const row = Math.ceil(i / 2), sgn = i % 2 ? 1 : -1;      // 鳥は「く」の字、魚はかたまり
      const o = C.fish || kind === 'startle'
        ? [(R() - 0.5) * 1.5, (R() - 0.5) * 0.7, (R() - 0.5) * 1.0]
        : [-row * 0.34 + (R() - 0.5) * 0.12, (R() - 0.5) * 0.14, sgn * row * 0.3 + (R() - 0.5) * 0.1];
      f.m.push({ o, ph: R() * 6.28, size: pick(C.size), wob: 0.5 + R() });
    }
    flocks.push(f);
  }
  // 炸裂：火花が飛び散る（海底では水の抵抗ですぐ止まる）。peak … 光の強さ、color … 光の色
  const sparks = [];
  function burst(x, y, z, peak, color) {
    if (level >= 2 || warming) return;
    const n = Math.round((peak >= 14 ? 16 : peak >= 9 ? 10 : 6) * (level ? 0.6 : 1));
    const c = new THREE.Color(color);
    for (let i = 0; i < n && sparks.length < 70; i++) {
      const a = R() * 6.28, el = (R() - 0.25) * 2.2, sp = (1.6 + R() * 2.6) * (peak >= 9 ? 1 : 0.6) * (cfg.crit.fish ? 0.7 : 1);
      sparks.push({ x, y, z: z + 0.25, vx: Math.cos(a) * Math.cos(el) * sp, vy: Math.sin(el) * sp + 0.6, vz: Math.sin(a) * Math.cos(el) * sp * 0.6 + 0.5, age: 0, life: 0.45 + R() * 0.55, size: 0.07 + R() * 0.08, c });
    }
  }
  // 怪獣の足が地面に着いた
  function footfall(x, z) {
    if (level >= 2 || warming) return;
    if (R() < cfg.crit.startle) spawnFlock('startle', x, z);
  }

  function writeLayer(L, n) { L.mesh.visible = n > 0 && !warming; L.mesh.geometry.instanceCount = n; if (n) { L.pos.needsUpdate = true; L.color.needsUpdate = true; L.data.needsUpdate = true; } }
  // 毎コマ。charge … 必殺技の溜め 0〜1、chest … 胸の器官の場所、kz … 怪獣の足元、ks … 怪獣の大きさ
  function update(now, scroll, charge, chest, ks, kAlpha) {
    const dt = lastNow ? Math.min(0.1, Math.max(0, (now - lastNow) / 1000)) : 0;
    lastNow = now;
    const ds = lastScroll == null || Math.abs(scroll - lastScroll) > 3 ? 0 : scroll - lastScroll;
    lastScroll = scroll;
    const t = now / 1000;
    if (warming) return;
    // 低い霧の層（地面と一緒に流れる）
    {
      const P = sheetL.pos.array, C = sheetL.color.array, D = sheetL.data.array;
      const n = level >= 2 ? Math.min(sheets.length, 5) : sheets.length;
      sheets.sort((a, b) => a.y - b.y);
      for (let i = 0; i < n; i++) {
        const s = sheets[i];
        s.x += s.vx * dt; s.z -= ds; s.rot += s.vr * dt;
        if (s.z > 10.5) newSheet(s, false, 1); else if (s.z < -25.5) newSheet(s, false, -1);
        if (s.x > 13) s.x -= 26; else if (s.x < -13) s.x += 26;
        const j = i * 3;
        P[j] = s.x; P[j + 1] = s.y; P[j + 2] = s.z;
        C[j] = sheetColor.r; C[j + 1] = sheetColor.g; C[j + 2] = sheetColor.b;
        const edge = clamp01((10.5 - s.z) / 3) * clamp01((s.z + 25.5) / 3);
        D[j] = s.size; D[j + 1] = s.a * edge * (0.75 + 0.25 * Math.sin(t * 0.3 + s.ph)); D[j + 2] = s.rot;
      }
      writeLayer(sheetL, n);
    }
    // ただよう粒＋溜めの光の粒
    {
      const P = moteL.pos.array, C = moteL.color.array, D = moteL.data.array;
      let k = 0;
      const n = level >= 2 ? Math.floor(motes.length * 0.4) : motes.length;
      for (let i = 0; i < n; i++) {
        const m = motes[i];
        m.x += m.vx * dt; m.y += m.vy * dt; m.z -= ds;
        if (m.y < 0.1 || m.y > 7.4) newMote(m, false);
        if (m.x > 7.5) m.x -= 15; else if (m.x < -7.5) m.x += 15;
        if (m.z > 6) m.z -= 15; else if (m.z < -9) m.z += 15;
        const j = k * 3; k++;
        P[j] = m.x + Math.sin(t * m.f + m.ph) * 0.12; P[j + 1] = m.y + Math.cos(t * m.f * 0.7 + m.ph) * 0.08; P[j + 2] = m.z;
        C[j] = moteColor.r; C[j + 1] = moteColor.g; C[j + 2] = moteColor.b;
        D[j] = m.size; D[j + 1] = m.a * (0.6 + 0.4 * Math.sin(t * 1.3 * m.f + m.ph * 2)); D[j + 2] = 0;
      }
      // 溜め：怪獣のまわりから胸の器官へ、光の粒が吸い込まれていく
      if (charge > 0.12 && kAlpha > 0.5 && chest) {
        emberAcc += dt * charge * (level >= 2 ? 12 : 26);
        while (emberAcc >= 1 && embers.length < 60) {
          emberAcc -= 1;
          const a = R() * 6.28, rad = (0.95 + R() * 1.0) * ks;
          embers.push({ x: chest.x + Math.cos(a) * rad, y: 0.15 + R() * chest.y * 1.25, z: chest.z + 0.2 + Math.sin(a) * rad * 0.55, age: 0, life: 0.85 + R() * 0.6, size: 0.1 + R() * 0.1, sw: (R() - 0.5) * 1.6 });
        }
        if (emberAcc > 2) emberAcc = 0;
      }
      for (let i = embers.length - 1; i >= 0; i--) {
        const e = embers[i];
        e.age += dt;
        if (e.age >= e.life || !chest) { embers[i] = embers[embers.length - 1]; embers.pop(); continue; }
        if (k >= moteL.max) continue;
        const u = e.age / e.life, q = u * u, sw = Math.sin(u * Math.PI) * e.sw;
        const j = k * 3; k++;
        P[j] = e.x + (chest.x - e.x) * q + sw * 0.4; P[j + 1] = e.y + (chest.y - e.y) * q + Math.sin(u * Math.PI) * 0.35; P[j + 2] = e.z + (chest.z + 0.25 - e.z) * q;
        C[j] = emberColor.r; C[j + 1] = emberColor.g; C[j + 2] = emberColor.b;
        D[j] = e.size * (1.25 - 0.8 * u); D[j + 1] = Math.min(1, u / 0.15) * (1 - q * q) * kAlpha; D[j + 2] = 0;
      }
      // 炸裂の火花
      const sea = cfg.crit.fish, drag = Math.exp(-(sea ? 5.5 : 1.6) * dt);
      for (let i = sparks.length - 1; i >= 0; i--) {
        const p = sparks[i];
        p.age += dt;
        if (p.age >= p.life) { sparks[i] = sparks[sparks.length - 1]; sparks.pop(); continue; }
        p.vx *= drag; p.vz *= drag; p.vy = p.vy * drag - (sea ? 0.4 : 4.2) * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt - ds;
        if (k >= moteL.max) continue;
        const u = p.age / p.life, j = k * 3; k++;
        P[j] = p.x; P[j + 1] = p.y; P[j + 2] = p.z;
        C[j] = p.c.r; C[j + 1] = p.c.g; C[j + 2] = p.c.b;
        D[j] = p.size * (1 - 0.6 * u); D[j + 1] = 1 - u * u; D[j + 2] = 0;
      }
      writeLayer(moteL, k);
    }
    // 光の筋（ゆっくり明るさが変わり、左右に少し揺れる）
    for (const r of rays) {
      const on = r.on && level < 2;
      r.m.visible = on;
      if (!on) continue;
      r.mat.opacity = cfg.rays.alpha * r.gain * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * r.sp + r.ph)));
      r.m.position.x = r.x + Math.sin(t * 0.11 + r.ph) * 0.5;
    }
    // 鳥・魚の群れ
    if (level < 2) {
      if (!nextFlock) nextFlock = now + 2500 + R() * 4000;
      if (now >= nextFlock) { nextFlock = now + pick(cfg.crit.every) * (level ? 1.6 : 1); spawnFlock('ambient'); }
    } else flocks.length = 0;
    {
      const P = critPos.array, D = critData.array;
      let k = 0;
      for (let i = flocks.length - 1; i >= 0; i--) {
        const f = flocks[i];
        f.age += dt;
        if (f.age >= f.life) { flocks.splice(i, 1); continue; }
        if (f.kind === 'startle') { f.vy = Math.max(0.12, f.vy - dt * 0.42); f.spread += f.grow * dt * Math.exp(-f.age); }
        f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt - ds;
        const head = Math.atan2(-f.vx, -f.vz);
        const fade = Math.min(1, f.age / 0.5) * Math.min(1, (f.life - f.age) / 0.9);
        for (const m of f.m) {
          if (k >= CRIT_MAX) break;
          const j = k * 3, q = k * 4; k++;
          const dir = f.vx >= 0 ? 1 : -1;
          P[j] = f.x + m.o[0] * f.spread * dir + Math.sin(t * 0.9 * m.wob + m.ph) * 0.05;
          P[j + 1] = Math.max(0.12, f.y + m.o[1] * f.spread + Math.sin(t * 1.7 * m.wob + m.ph) * 0.05);
          P[j + 2] = f.z + m.o[2] * f.spread;
          D[q] = head + Math.sin(t * 0.8 + m.ph) * 0.08; D[q + 1] = m.size; D[q + 2] = m.ph; D[q + 3] = fade;
        }
      }
      critMesh.visible = k > 0;
      critMesh.geometry.instanceCount = k;
      if (k) { critPos.needsUpdate = true; critData.needsUpdate = true; critU.uTime.value = t % 1000; }
    }
  }
  // 下ごしらえ用：見えない物を1つずつ出して、絵の作り方を作らせる
  function warm(on) {
    warming = on;
    for (const L of [sheetL, moteL]) {
      L.data.array[0] = 0.01; L.data.array[1] = 0; L.data.needsUpdate = true;
      L.mesh.geometry.instanceCount = on ? 1 : 0; L.mesh.visible = on;
    }
    critData.array[1] = 0.001; critData.array[3] = 0; critData.needsUpdate = true;
    critMesh.geometry.instanceCount = on ? 1 : 0; critMesh.visible = on;
    if (rays[0]) { rays[0].mat.opacity = 0; rays[0].m.visible = on; }
  }
  setStage('forest');
  return {
    group, setStage, update, footfall, burst, warm,
    setLevel(q) { level = q | 0; },
    count: () => ({ sheets: sheets.length, motes: motes.length, embers: embers.length, flocks: flocks.length, critters: critCount(), rays: rays.filter(r => r.m.visible).length }),
    debugFlock(kind, x, z) { spawnFlock(kind || 'ambient', x || 2, z || -1); const f = flocks[flocks.length - 1]; if (f && kind !== 'startle' && x != null) { f.x = x; f.z = z; } return critCount(); },
    dispose() { sheetL.dispose(); moteL.dispose(); rayTex.dispose(); rayGeo.dispose(); rays.forEach(r => r.mat.dispose()); birdGeo.dispose(); fishGeo.dispose(); critMat.dispose(); },
  };
}

// ③ にじむ光：いま描いた絵（画面）を写し取り、明るい所だけを 1/4・1/8 の大きさでぼかして、上から足す。
//    もとの描き方（なめらかな輪郭・色）はそのままなので、うまく動かない端末では止めるだけでよい（何か起きたら自動で止まる）
const BLOOM_VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }';
const BLOOM_BRIGHT = `
uniform sampler2D tMap; uniform vec2 uTexel; uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D( tMap, vUv + uTexel * vec2( -1.0, -1.0 ) ).rgb + texture2D( tMap, vUv + uTexel * vec2( 1.0, -1.0 ) ).rgb
         + texture2D( tMap, vUv + uTexel * vec2( -1.0, 1.0 ) ).rgb + texture2D( tMap, vUv + uTexel * vec2( 1.0, 1.0 ) ).rgb;
  c *= 0.25;
  float l = max( c.r, max( c.g, c.b ) );
  gl_FragColor = vec4( c * smoothstep( uThreshold, uThreshold + 0.22, l ), 1.0 );
}`;
const BLOOM_BLUR = `
uniform sampler2D tMap; uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D( tMap, vUv ).rgb * 0.227027;
  c += ( texture2D( tMap, vUv + uDir * 1.384615 ).rgb + texture2D( tMap, vUv - uDir * 1.384615 ).rgb ) * 0.316216;
  c += ( texture2D( tMap, vUv + uDir * 3.230769 ).rgb + texture2D( tMap, vUv - uDir * 3.230769 ).rgb ) * 0.070270;
  gl_FragColor = vec4( c, 1.0 );
}`;
const BLOOM_MIX = `
uniform sampler2D tA; uniform sampler2D tB; uniform float uStrength;
varying vec2 vUv;
void main() {
  vec3 c = texture2D( tA, vUv ).rgb * 0.55 + texture2D( tB, vUv ).rgb * 0.75;
  gl_FragColor = vec4( c * uStrength, 1.0 );
}`;
function makeBloom(renderer) {
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const sc = new THREE.Scene(); sc.add(quad);
  const mk = (frag, uniforms, add) => new THREE.ShaderMaterial({ uniforms, vertexShader: BLOOM_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, toneMapped: false,
    transparent: !!add, blending: add ? THREE.AdditiveBlending : THREE.NoBlending, premultipliedAlpha: false });
  const mBright = mk(BLOOM_BRIGHT, { tMap: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0.74 } });
  const mBlur = mk(BLOOM_BLUR, { tMap: { value: null }, uDir: { value: new THREE.Vector2() } });
  const mMix = mk(BLOOM_MIX, { tA: { value: null }, tB: { value: null }, uStrength: { value: 0.6 } }, true);
  const rt = (w, h) => new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  let fb = null, a1 = null, a2 = null, b1 = null, b2 = null, fw = 0, fh = 0, failed = false;
  const size = new THREE.Vector2(), zero = new THREE.Vector2(0, 0);
  function free() { for (const o of [fb, a1, a2, b1, b2]) if (o) o.dispose(); fb = a1 = a2 = b1 = b2 = null; fw = fh = 0; }
  function pass(mat, target) { quad.material = mat; renderer.setRenderTarget(target); renderer.render(sc, cam); }
  // いま画面に描いた絵に、にじむ光を足す（renderer.render のすぐあとに呼ぶ）
  function apply(strength, threshold) {
    if (failed) return false;
    const prevAuto = renderer.autoClear;
    try {
      renderer.getDrawingBufferSize(size);
      const w = Math.floor(size.x), h = Math.floor(size.y);
      if (w < 16 || h < 16) return false;
      if (w !== fw || h !== fh) {
        free(); fw = w; fh = h;
        fb = new THREE.FramebufferTexture(w, h);
        fb.minFilter = fb.magFilter = THREE.LinearFilter;
        const qw = Math.max(4, w >> 2), qh = Math.max(4, h >> 2), ew = Math.max(2, w >> 3), eh = Math.max(2, h >> 3);
        a1 = rt(qw, qh); a2 = rt(qw, qh); b1 = rt(ew, eh); b2 = rt(ew, eh);
      }
      renderer.setRenderTarget(null);
      renderer.copyFramebufferToTexture(fb, zero);
      renderer.autoClear = false;
      mBright.uniforms.tMap.value = fb; mBright.uniforms.uTexel.value.set(1 / w, 1 / h); mBright.uniforms.uThreshold.value = threshold;
      pass(mBright, a1);
      mBlur.uniforms.tMap.value = a1.texture; mBlur.uniforms.uDir.value.set(1 / a1.width, 0); pass(mBlur, a2);
      mBlur.uniforms.tMap.value = a2.texture; mBlur.uniforms.uDir.value.set(0, 1 / a1.height); pass(mBlur, a1);
      mBlur.uniforms.tMap.value = a1.texture; mBlur.uniforms.uDir.value.set(1 / b1.width, 0); pass(mBlur, b2);
      mBlur.uniforms.tMap.value = b2.texture; mBlur.uniforms.uDir.value.set(0, 1 / b1.height); pass(mBlur, b1);
      mBlur.uniforms.tMap.value = b1.texture; mBlur.uniforms.uDir.value.set(1.6 / b1.width, 0); pass(mBlur, b2);
      mBlur.uniforms.tMap.value = b2.texture; mBlur.uniforms.uDir.value.set(0, 1.6 / b1.height); pass(mBlur, b1);
      mMix.uniforms.tA.value = a1.texture; mMix.uniforms.tB.value = b1.texture; mMix.uniforms.uStrength.value = strength;
      pass(mMix, null);
      return true;
    } catch (e) {
      failed = true;
      console.warn('[N.O.A.H. 3D] にじむ光を使えませんでした（無しで続けます）', e);
      try { renderer.setRenderTarget(null); } catch (e2) {}
      return false;
    } finally {
      renderer.autoClear = prevAuto;
    }
  }
  return { apply, get failed() { return failed; }, dispose() { free(); quad.geometry.dispose(); mBright.dispose(); mBlur.dispose(); mMix.dispose(); } };
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
  stepsPerCell: 1 / KAIJU_SCALE,   // 地形が1マス流れる間の歩数（体が大きい分だけ歩幅も広い。足が地面に対して滑らない歩幅）
  bones: {
    hips: 'Bone_000', spine: ['Bone_004', 'Bone_003', 'Bone_002'], head: 'Bone_024', jaw: 'Bone_042',
    legs: [['Bone_009', 'Bone_008', 'Bone_007'], ['Bone_014', 'Bone_013', 'Bone_012']],     // 太もも・すね・足首（-X 側, +X 側）
    arms: [['Bone_036', 'Bone_035', 'Bone_034'], ['Bone_040', 'Bone_039', 'Bone_038']],     // 鎖骨・上腕・前腕
    tail: ['Bone_023', 'Bone_022', 'Bone_021', 'Bone_020', 'Bone_019', 'Bone_018', 'Bone_017', 'Bone_016', 'Bone_015'],
    ankles: ['Bone_006', 'Bone_011'],
  },
  // v362：生体モニターの輪（ポインター）を付ける所。怪獣ごとに自由に決める（線は、輪がどこにあってもモニターにつながる）。
  //  bone   … この骨の位置を基準にする（体の動きに付いていく）。無い名前・書かないときは足元の中心
  //  offset … 基準からのずれ [左右(+右), 上下(+上), 前後(+手前＝カメラ側)]。単位は「怪獣の高さ＝3」（大きさを変えても同じ所を指す）
  //  セレヴァーンは、頭の骨から少し下・前の、喉〜胸の光る器官
  hudPointer: { bone: 'Bone_024', offset: [0, -0.4, 0.22] },
  // v364：怪獣の決まった所に出す演出（目視観察の照準などの研究の演出・麻酔弾URの霧・誘導LRの爆発）が狙う所＝顔。
  //       書き方は hudPointer と同じ（骨の名前＋ずれ。単位は怪獣の高さ＝3）。セレヴァーンは頭の甲殻のまん中
  fxAim: { bone: 'Bone_024', offset: [0, 0, 0.35] },
  // v365：胸の器官のまわりに重ねる、ふわっとした光（hudPointer の場所から [左右, 上下, 前後] ずらした所。単位は怪獣の高さ＝3）。
  //       size … 光の大きさ（同じ単位）。書かなければ出さない
  glow: { color: 0x58d6ff, offset: [0, 0.02, 0.1], size: 0.62, alpha: 0.5 },
};

// v360：腕（手・爪）と脚（太もも・ひざ）の両方に重みが付いている頂点を、どちらか一方にそろえる。
// Meshy の自動の骨入れで、太ももに触れている爪の先が脚にも引っぱられていて、必殺技の溜めで腕を広げると
// 爪が手からひざまで長く伸びて見えていた（歩くときも少し伸びていた）。モデルのファイルは変えず、読み込んだときに直す。
// どちらにそろえるかは、メッシュの表面をたどった距離で、重みが「腕だけ」の所と「脚だけ」の所のどちらに近いかで決める
//（爪の先は爪をたどれば手に着くが、脚へは肩・胴を回らないと着かない。太ももの頂点はその逆）。
// そろえたあとも爪の先と太ももを直接つないでいる三角形（9枚）は、腕を広げると細長く伸びるので消す（接している所なので、穴は見えない）。
function separateArmLegWeights(meshes, byName, bones) {
  const subtree = name => { const set = new Set(); const b = byName[name]; if (b) b.traverse(o => { if (o.isBone) set.add(o); }); return set; };
  const arm = new Set(), leg = new Set();
  bones.arms.forEach(chain => subtree(chain[0]).forEach(b => arm.add(b)));
  bones.legs.forEach(chain => subtree(chain[0]).forEach(b => leg.add(b)));
  const out = { mixed: 0, toArm: 0, toLeg: 0, cut: 0 };
  for (const m of meshes) {
    const g = m.geometry, sk = m.skeleton;
    const si = g.attributes.skinIndex, sw = g.attributes.skinWeight, pos = g.attributes.position, idx = g.index;
    if (!sk || !si || !sw || !pos || !idx) continue;
    const kind = sk.bones.map(b => arm.has(b) ? 1 : leg.has(b) ? 2 : 0);   // 1 腕 / 2 脚 / 0 そのほか
    const n = pos.count;
    const wa = new Float32Array(n), wl = new Float32Array(n);
    for (let v = 0; v < n; v++) for (let c = 0; c < 4; c++) {
      const k = kind[si.getComponent(v, c)], w = sw.getComponent(v, c);
      if (k === 1) wa[v] += w; else if (k === 2) wl[v] += w;
    }
    const mixed = [];
    for (let v = 0; v < n; v++) if (wa[v] > 0.02 && wl[v] > 0.02) mixed.push(v);
    out.mixed += mixed.length;
    if (!mixed.length) continue;
    // 位置が同じ頂点（UV の継ぎ目で分かれたもの）を1つの点にまとめる
    const keyOf = v => Math.round(pos.getX(v) * 1e5) + ',' + Math.round(pos.getY(v) * 1e5) + ',' + Math.round(pos.getZ(v) * 1e5);
    const nodeOf = new Int32Array(n), keys = new Map();
    for (let v = 0; v < n; v++) { const k = keyOf(v); let id = keys.get(k); if (id === undefined) { id = keys.size; keys.set(k, id); } nodeOf[v] = id; }
    const N = keys.size, px = new Float32Array(N * 3), label = new Uint8Array(N);
    for (let v = 0; v < n; v++) {
      const id = nodeOf[v]; px[id * 3] = pos.getX(v); px[id * 3 + 1] = pos.getY(v); px[id * 3 + 2] = pos.getZ(v);
      if (wa[v] >= 0.98) label[id] = 1; else if (wl[v] >= 0.98) label[id] = 2;
    }
    // 辺のつながり
    const adj = Array.from({ length: N }, () => []);
    const ia = idx.array;
    const link = (a, b) => { if (a !== b) { adj[a].push(b); adj[b].push(a); } };
    for (let t = 0; t < ia.length; t += 3) { const a = nodeOf[ia[t]], b = nodeOf[ia[t + 1]], c = nodeOf[ia[t + 2]]; link(a, b); link(b, c); link(c, a); }
    // 「腕だけ」「脚だけ」の点から同時に広げる（最短の道のり）
    const dist = new Float64Array(N).fill(Infinity), lab = new Uint8Array(N);
    const heap = [];   // [d, id]
    const push = (d, id) => { heap.push([d, id]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let s = i; if (l < heap.length && heap[l][0] < heap[s][0]) s = l; if (r < heap.length && heap[r][0] < heap[s][0]) s = r; if (s === i) break; [heap[s], heap[i]] = [heap[i], heap[s]]; i = s; } } return top; };
    for (let id = 0; id < N; id++) if (label[id]) { dist[id] = 0; lab[id] = label[id]; push(0, id); }
    while (heap.length) {
      const [d, id] = pop();
      if (d > dist[id]) continue;
      for (const nb of adj[id]) {
        const dx = px[id * 3] - px[nb * 3], dy = px[id * 3 + 1] - px[nb * 3 + 1], dz = px[id * 3 + 2] - px[nb * 3 + 2];
        const nd = d + Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (nd < dist[nb]) { dist[nb] = nd; lab[nb] = lab[id]; push(nd, nb); }
      }
    }
    // 重みを移す
    for (const v of mixed) {
      const keep = lab[nodeOf[v]] || (wa[v] >= wl[v] ? 1 : 2), drop = 3 - keep;
      const J = [0, 1, 2, 3].map(c => si.getComponent(v, c)), W = [0, 1, 2, 3].map(c => sw.getComponent(v, c));
      let top = -1;
      for (let c = 0; c < 4; c++) if (kind[J[c]] === keep && W[c] > 0 && (top < 0 || W[c] > W[top])) top = c;
      if (top < 0) continue;
      for (let c = 0; c < 4; c++) if (kind[J[c]] === drop) { W[top] += W[c]; W[c] = 0; }
      for (let c = 0; c < 4; c++) sw.setComponent(v, c, W[c]);
      if (keep === 1) out.toArm++; else out.toLeg++;
    }
    sw.needsUpdate = true;
    // それでも爪の先と太ももを直接つないでいる三角形（もとのモデルで接していた所。腕を広げると細長く伸びる）は消す
    if (!g.groups.length) {
      const side = new Uint8Array(n);
      for (let v = 0; v < n; v++) {
        let a = 0, l = 0;
        for (let c = 0; c < 4; c++) { const k = kind[si.getComponent(v, c)], w = sw.getComponent(v, c); if (k === 1) a += w; else if (k === 2) l += w; }
        side[v] = a > 0.5 ? 1 : l > 0.5 ? 2 : 0;
      }
      const kept = [];
      for (let t = 0; t < ia.length; t += 3) {
        if ((side[ia[t]] | side[ia[t + 1]] | side[ia[t + 2]]) === 3) { out.cut++; continue; }
        kept.push(ia[t], ia[t + 1], ia[t + 2]);
      }
      if (kept.length < ia.length) g.setIndex(new THREE.BufferAttribute(new (ia.constructor)(kept), 1));
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// 怪獣の攻撃の動き（v363〜）。index.html が攻撃のときに game.kaijuMotion = { kind, side, start, duration } を入れ、
// ここで腕・背骨・頭を、ふだんの動きに重ねて動かす。p は 0〜1 の進み具合。
//   strike … 最接近攻撃：片腕を振りかぶって、上から振り下ろす（side は振る腕。-1 画面の左の腕 / +1 右の腕）
//   sweep  … 前中列薙ぎ払い：両腕を横へ上げ、互い違いに前を横切って払う（side の腕が先）
//   special… 必殺技：両腕を高く広げて反り、交差させて振り下ろす（三日月弾・エネルギー波は今まで通り出る）
// 角度は骨の「モデルの座標の軸」での回転（x：マイナスで腕が前・上へ、y：横に上げた腕を前後へ回す、z：横へ上げる）。
// 当たる瞬間（振り切る所）は index.html の KAIJU_MOTIONS の hitMs と合わせてある。
// -----------------------------------------------------------------------------
const smoothRange = (e0, e1, p) => { const x = clamp01((p - e0) / (e1 - e0)); return x * x * (3 - 2 * x); };
function motionOffsets(m) {
  const o = { arm: [{ x: 0, y: 0, z: 0, f: 0 }, { x: 0, y: 0, z: 0, f: 0 }], spineX: 0, spineY: 0, headX: 0, jaw: 0, lunge: 0, glow: 0, swing: 0 };
  if (!m) return o;
  const p = m.p;
  if (m.kind === 'strike') {
    const s = m.side < 0 ? -1 : 1, A = o.arm[s < 0 ? 0 : 1], B = o.arm[s < 0 ? 1 : 0];
    const up = smoothRange(0.0, 0.40, p), down = smoothRange(0.42, 0.56, p), back = 1 - smoothRange(0.64, 1.0, p);
    A.x = (-2.4 * up + 1.95 * down) * back;     // 上へ振りかぶって → 前下へ振り下ろす
    A.z = s * (0.3 * up - 0.6 * down) * back;   // 振り下ろしながら体の前を斜めに横切る
    A.f = (-0.6 * up + 0.55 * down) * back;     // ひじを少し曲げて（爪を頭の横に立てる）→ 伸ばす
    B.x = 0.3 * up * back;                      // 反対の腕は少し後ろへ
    o.spineX = (-0.12 * up + 0.26 * down) * back;
    o.spineY = s * (0.14 * up - 0.2 * down) * back;
    o.headX = (-0.18 * up + 0.24 * down) * back;
    o.jaw = 0.3 * up * back;
    o.lunge = 0.7 * down * back;
    o.swing = down * (1 - down) * 4;            // 振っている最中（0〜1）
  } else if (m.kind === 'sweep') {
    const s0 = m.side < 0 ? -1 : 1, back = 1 - smoothRange(0.70, 1.0, p);
    const sweepArm = (A, s, w0, w1, h0, h1) => {
      const wind = smoothRange(w0, w1, p), hit = smoothRange(h0, h1, p);
      A.z = s * 1.2 * wind * back;                         // 横へ上げる
      A.y = s * (0.55 * wind - 2.05 * hit) * back;         // 後ろへ引いて → 前を横切る
      A.x = (-0.3 * wind - 0.25 * hit) * back;
      A.f = (-0.4 * wind + 0.3 * hit) * back;
      return hit * (1 - hit) * 4;
    };
    const s1 = sweepArm(o.arm[s0 < 0 ? 0 : 1], s0, 0.0, 0.28, 0.30, 0.44);
    const s2 = sweepArm(o.arm[s0 < 0 ? 1 : 0], -s0, 0.18, 0.46, 0.50, 0.64);
    const h1 = smoothRange(0.30, 0.44, p), h2 = smoothRange(0.50, 0.64, p);
    o.spineY = s0 * (-0.16 * smoothRange(0.0, 0.28, p) + 0.34 * h1 - 0.36 * h2) * back;   // 払う向きへ体をひねる
    o.spineX = 0.1 * Math.max(h1 * (1 - h2), h2) * back;
    o.lunge = 0.45 * Math.max(s1, s2);
    o.jaw = 0.2 * smoothRange(0.0, 0.3, p) * back;
    o.swing = Math.max(s1, s2);
  } else if (m.kind === 'special') {
    const up = smoothRange(0.0, 0.48, p), slash = smoothRange(0.50, 0.62, p), back = 1 - smoothRange(0.70, 1.0, p);
    for (const i of [0, 1]) {
      const s = i ? 1 : -1, A = o.arm[i];
      A.x = (-2.5 * up + 1.95 * slash) * back;
      A.z = s * (0.75 * up - 1.0 * slash) * back;          // 広げて → 内へ交差
      A.f = (-0.75 * up + 0.65 * slash) * back;
    }
    o.spineX = (-0.18 * up + 0.34 * slash) * back;
    o.headX = (-0.38 * up + 0.34 * slash) * back;
    o.jaw = 0.5 * up * back;
    o.lunge = 0.8 * slash * back;
    o.glow = up * back;
    o.swing = slash * (1 - slash) * 4;
  }
  return o;
}

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
  const weightFix = separateArmLegWeights(skinned, byName, BN);
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
  mats.forEach(m => patchLit(m, 'kaiju'));   // v365 縁の光・雲の影・水面からの光
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
  // motion … 攻撃の動き（v363。{ kind, side, p } か null。motionOffsets）
  function animate(t, scroll, a, jitterX, lunge, charge, motion) {
    const ph = scroll * Math.PI * KAIJU_MODEL.stepsPerCell;
    const breathe = Math.sin(t * 1.6);
    const M = motionOffsets(motion);
    const lg = lunge + M.lunge;
    body.position.set(jitterX, 0, lg * 0.22);
    body.rotation.x = lg * 0.05;
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
    pose(R.spine[0], lunge * 0.09 - charge * 0.05 + breathe * 0.008 + M.spineX * 0.35, -a * 0.04 * Math.sin(ph) + M.spineY * 0.35, 0);
    pose(R.spine[1], lunge * 0.06 - charge * 0.05 + breathe * 0.012 + M.spineX * 0.35, -a * 0.03 * Math.sin(ph) + M.spineY * 0.35, 0);
    pose(R.spine[2], lunge * 0.05 - charge * 0.08 + breathe * 0.01 + M.spineX * 0.3, M.spineY * 0.3, 0);
    // 腕：同じ側の脚と逆に振る。突進で刃を前へ、溜めで左右に広げる
    R.arms.forEach((arm, i) => {
      const side = i ? 1 : -1;
      const p = ph + (i ? Math.PI : 0);
      const swing = -a * 0.2 * Math.sin(p) + Math.sin(t * 1.2 + i * 1.7) * 0.03;
      const mo = M.arm[i];
      pose(arm[0], 0, 0, side * (breathe * 0.015 + charge * 0.08));
      pose(arm[1], swing - lunge * 0.75 - charge * 0.2 + mo.x, mo.y, side * (lunge * 0.22 + charge * 0.45) + mo.z);
      pose(arm[2], -lunge * 0.45 - charge * 0.3 + mo.f, 0, 0);
    });
    // 頭：ゆっくり見回す。突進で前へ、溜めで上を向いて口を開く
    pose(R.head, Math.sin(t * 0.8) * 0.035 + lunge * 0.12 - charge * 0.22 + M.headX, Math.sin(t * 0.45) * 0.14 * (1 - charge) + M.spineY * 0.25, 0);
    pose(R.jaw, lunge * 0.35 + charge * 0.25 + M.jaw, 0, 0);
    // 尾：根元から先へ伝わる波
    R.tail.forEach((b, i) => pose(b, -charge * 0.03, 0.045 * Math.sin(t * 1.25 - i * 0.55) + a * 0.035 * Math.sin(ph - i * 0.5), 0));
    // 喉〜胸の器官の光：呼吸に合わせて明滅、溜めで強く脈打つ
    const gl = Math.max(charge, M.glow);
    for (const m of glowMats) m.emissiveIntensity = 1.0 + 0.5 * (0.5 + 0.5 * breathe) + gl * (1.6 + 1.2 * Math.sin(t * 9));
    R.glowLevel = 0.5 + 0.5 * breathe + gl * (1.5 + 0.9 * Math.sin(t * 9));   // 胸の光の強さ（v365 重ねる光に使う）
  }
  // 足首の骨（-X 側, +X 側）。歩きの周期で足が地面に着くのは、地形が「1.5マス（-X 側）・0.5マス（+X 側）＋2マスごと」流れたとき
  //（前へ歩くとき。後ろへ下がるときは左右が入れ替わる）。砂ぼこりはそこに出す（v356〜）
  const feet = BN.ankles.map(n => byName[n] || null);
  // 生体モニターの輪の場所（v362）
  const hp = KAIJU_MODEL.hudPointer || {};
  const pointerNode = (hp.bone && byName[hp.bone]) || root;
  const pointerOffset = new THREE.Vector3().fromArray(hp.offset || [0, 2.2, 0.3]);
  // 決まった所に出す演出が狙う所（v364）
  const fa = KAIJU_MODEL.fxAim || {};
  const aimNode = (fa.bone && byName[fa.bone]) || head;
  const aimOffset = new THREE.Vector3().fromArray(fa.offset || [0, 0, 0.3]);
  return {
    real: true, root, body, head, localBox, mats, skinned, animate, feet, weightFix, pointerNode, pointerOffset, aimNode, aimOffset, bonesByName: byName,
    glowLevel: () => R.glowLevel || 0,
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
// 翼の両端（いちばん左・右の頂点）と、機体のいちばん上・後ろ（v365 航法灯を付ける所）。機体の元ごとに1回だけ調べる
function aircraftTips(template) {
  if (template.userData.noahTips) return template.userData.noahTips;
  template.updateMatrixWorld(true);
  const L = new THREE.Vector3(Infinity, 0, 0), Rt = new THREE.Vector3(-Infinity, 0, 0), v = new THREE.Vector3();
  let top = -Infinity, tail = -Infinity;
  template.traverse(o => {
    if (!o.isMesh || !o.geometry.attributes.position) return;
    const pos = o.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / 6000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.x < L.x) L.copy(v);
      if (v.x > Rt.x) Rt.copy(v);
      if (v.y > top) top = v.y;
      if (v.z > tail) tail = v.z;
    }
  });
  if (!Number.isFinite(L.x)) { L.set(-0.48, 0, 0.1); Rt.set(0.48, 0, 0.1); top = 0.08; tail = 0.44; }
  return (template.userData.noahTips = { left: L.clone(), right: Rt.clone(), top, tail });
}
function makeAircraftFromModel(template, type) {
  const look = AIRCRAFT_LOOKS[type] || AIRCRAFT_LOOKS[0];
  const g = new THREE.Group();
  const model = template.clone(true);          // 形と画像は共有し、材質だけ機体ごとに複製（半透明を別々にするため）
  const meshes = [];
  model.traverse(o => { if (o.isMesh) { o.material = o.material.clone(); patchLit(o.material, 'aircraft'); o.castShadow = true; o.receiveShadow = false; meshes.push(o); } });
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
  // v365：噴射口のにじむ光と、翼の端の航法灯（左＝赤・右＝緑）・尾の白い閃光灯。翼の端は形から探す
  const tips = aircraftTips(template);
  const spriteMats = [];
  const light = (color, x, y, z, size, base) => {
    const mat = new THREE.SpriteMaterial({ map: sharedGlow(), color, transparent: true, opacity: base, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false });
    const sp = new THREE.Sprite(mat);
    sp.position.set(x, y, z); sp.scale.setScalar(size); sp.renderOrder = 4.1;
    sp.userData.base = base;
    g.add(sp); spriteMats.push(mat);
    return sp;
  };
  const engineGlows = engines.map(f => light(look.glow, f.position.x, f.position.y, f.position.z - 0.02, 0.28 * (0.7 + 0.3 * (f.userData.r || 1)), 0.42));
  const lights = {
    engines: engineGlows,
    port: light(0xff3b30, tips.left.x, tips.left.y + 0.012, tips.left.z, 0.13, 0.95),
    star: light(0x3dff7a, tips.right.x, tips.right.y + 0.012, tips.right.z, 0.13, 0.95),
    strobe: light(0xffffff, 0, tips.top + 0.01, tips.tail - 0.04, 0.2, 1),
  };
  const fader = makeFader(meshes, 3.5);
  let alphaNow = 1;
  return {
    real: true, group: g, engines, glowMat, type, mats: fader.mats, lights,
    get alpha() { return alphaNow; },
    setAlpha: a => { alphaNow = a; fader.set(a); },
    dispose() { fader.dispose(); meshes.forEach(m => m.material.dispose()); flameGeo.dispose(); glowMat.dispose(); spriteMats.forEach(m => m.dispose()); },
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
// 観測HUD（v361〜）：盤面の上に重ねる飾りと計器。見た目は index.html の CSS（.noahHud〜）。
//   ・左の端：高度スケール（怪獣の足元 0m 〜 頭の高さ。怪獣の奥行きでの高さを画面に写したもの）と、機体の飛行高度の印。
//     目盛りの間隔は怪獣の高さに合わせて変わる（v362〜）
//   ・右上：生体モニター（興奮値で波が荒れ、生命安定が下がると信号が途切れる）＋行動予測＋必殺技の警告（v362〜。前の怪獣の頭の上の「！」の代わり）。
//     モニターの位置は決まっていて、怪獣の体の輪（ポインター）と線でつなぐ。輪の場所は怪獣ごとに KAIJU_MODEL.hudPointer で決める。
//     線は、輪がモニターの下・左・ずっと下のどこにあってもつながる（leaderPoints）
//   ・中央上部：追跡の照準（怪獣の頭の真上。v362〜）
//   ・左上：ステージの環境の数字（飾り）
//   真上の視点（移動フェイズ）では、高度スケール・輪・照準は消す。
// -----------------------------------------------------------------------------
const HUD_RING_R = 15;   // 輪の外側の半径（px）。線はここから出る
// 輪（中心 hx, hy）から、生体モニター（左 L・右 R・上 T・下 B）までの線の点。null のときは線を出さない（輪がモニターに重なっている）
function leaderPoints(hx, hy, L, R, T, B) {
  const rr = HUD_RING_R;
  const from = (dx, dy) => { const d = Math.hypot(dx, dy) || 1; return [hx + dx / d * rr, hy + dy / d * rr]; };
  if (hy - rr > B + 4) {                                  // 輪がモニターより下
    const ex = hx + (hy - B);                             // 45°で上がったとき、モニターの下の辺の高さに着く所
    if (ex <= R - 10) return [from(1, -1), [ex, B], [R, B]];                 // ふつう：斜めに上がって、下の辺を右の端まで
    if (hx < L + 6) {                                     // 輪がずっと下（斜めだと右へはみ出す）：まっすぐ上がってから斜め
      const ax = L + 6, ay = B + (ax - hx);
      return [from(0, -1), [hx, ay], [ax, B], [R, B]];
    }
    return hx <= R - 10 ? [from(0, -1), [hx, B], [R, B]] : [from(0, -1), [hx, B]];   // 輪がモニターの真下：まっすぐ上へ
  }
  if (hx + rr < L - 6) {                                  // 輪がモニターの横（左）：左の辺へ
    const y = Math.max(T + 10, Math.min(B - 2, hy));
    return [from(L - hx, y - hy), [L, y]];
  }
  return null;
}
function makeHud(host) {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const root = el('div', 'noahHud');
  root.setAttribute('aria-hidden', 'true');
  // 高度スケール
  const ruler = el('div', 'nhRuler');
  const axis = el('i', 'nhAxis');
  ruler.appendChild(axis);
  const ticks = [];
  const topMark = el('div', 'nhMark nhMarkTop'); topMark.append(el('b', '', ''));   // v362：「体高」の文字は付けない（数字だけ）
  const altMark = el('div', 'nhMark nhMarkAlt'); altMark.append(el('b', '', ''), el('span', '', 'AA ALT'));
  ruler.append(topMark, altMark);
  // 体の輪と、生体モニターへの線
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'nhLink');
  const ring = document.createElementNS(NS, 'circle'); ring.setAttribute('class', 'nhRing'); ring.setAttribute('r', '11');
  const ring2 = document.createElementNS(NS, 'circle'); ring2.setAttribute('class', 'nhRing2'); ring2.setAttribute('r', String(HUD_RING_R));
  const line = document.createElementNS(NS, 'polyline'); line.setAttribute('class', 'nhLine');
  svg.append(line, ring2, ring);
  // 生体モニター
  const bio = el('div', 'nhBio');
  const head = el('div', 'nhBioHead'); head.append(el('i', 'nhLamp'), el('span', '', 'BIO-SIGNAL'));
  const sig = el('span', 'nhSig'); for (let i = 0; i < 4; i++) sig.appendChild(el('i')); head.appendChild(sig);
  const wave = el('canvas', 'nhWave'); wave.width = 208; wave.height = 52;
  const rowA = el('div', 'nhRow'); const aKey = el('span', 'k', '興奮'), aVal = el('b', '', ''), aPct = el('em', '', ''); rowA.append(aKey, aVal, aPct);
  const rowV = el('div', 'nhRow'); const vKey = el('span', 'k', '生命'), vVal = el('b', '', ''), vPct = el('em', '', ''); rowV.append(vKey, vVal, vPct);
  const act = el('div', 'nhAct'); const actKey = el('span', 'k', '行動予測'), actVal = el('b', '', ''); act.append(actKey, actVal);
  // 必殺技の警告（v362）：準備中（次のラウンドに撃つ）・発動（このラウンドに撃つ）・音響誘導で逸らした
  const warn = el('div', 'nhWarn'); const warnHead = el('div', 'nhWarnHead'), warnName = el('div', 'nhWarnName'), warnSub = el('em', '', '');
  const warnHeadText = el('span', '', ''), warnHeadSub = el('em', '', '');
  warnHead.append(warnHeadText, warnHeadSub);
  warnName.append(el('b', '', ''), warnSub);
  warn.append(warnHead, warnName);
  bio.append(head, wave, rowA, rowV, act, warn);
  // 中央上部：追跡の照準（怪獣の頭の真上）
  const track = el('div', 'nhTrack');
  const trackLabel = el('div', 'nhTrackLabel'); const trackA = el('span', 'a', 'TRACKING'), trackB = el('span', 'b', '');
  trackLabel.append(el('i'), trackA, trackB);
  const trackBar = el('div', 'nhTrackBar'), trackTicks = el('i', 'nhTrackTicks');
  trackBar.append(trackTicks, el('i', 'nhTrackCaret'));
  track.append(trackLabel, trackBar);
  const env = el('div', 'nhEnv');
  root.append(ruler, svg, track, bio, env);
  host.appendChild(root);
  const g2 = wave.getContext('2d');
  const set = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const show = (node, on) => { const v = on ? '' : 'none'; if (node.style.display !== v) node.style.display = v; };
  let scale = 1, lastWave = 0, lastEnv = 0, agit = 1, vital = 1, hit = 0, rulerOn = null, actKeyNow = null, warnKeyNow = null, tone = '', step = 0;
  const AGIT = [[0.66, '激昂', '#ff8a5c'], [0.33, '興奮', '#ffd24f'], [0.001, '鎮静傾向', '#3fe0a3'], [-1, '沈静', '#3fe0a3']];
  const VITAL = [[0.5, '安定', ''], [0.25, '低下', 'warn'], [-1, '危険', 'bad']];
  // head … 1段目、sub … 名前の右に添える言葉。発動のときに行動予測にも同じ名前が出ていれば、名前の段は省いて1段にする
  const WARN = {
    charging: { head: '⚠ 必殺技 準備中', sub: '次R' },
    ready: { head: '⚠ 必殺技 発動', sub: '今R' },
    redirected: { head: '◆ 音響誘導 成功', sub: '' },
  };
  // 目盛りの間隔（m）。怪獣の高さに合わせて、目盛りが12本以下になるいちばん細かいもの（数字は2本に1本）
  const STEPS = [5, 10, 20, 25, 50, 100, 200, 500];
  // mode … '' / 'charging'（力を溜める：右へ行くほど振れが大きい）/ 'ready'（鋭いとげが走る）
  function drawWave(t, color, mode) {
    const w = wave.width, h = wave.height, mid = h / 2;
    g2.clearRect(0, 0, w, h);
    g2.strokeStyle = 'rgba(190,220,255,.13)'; g2.lineWidth = 1;
    g2.beginPath(); g2.moveTo(0, mid + 0.5); g2.lineTo(w, mid + 0.5); g2.stroke();
    const amp = (0.16 + 0.34 * agit) * h * (1 + hit * 0.8), f = 0.035 + 0.05 * agit + (mode ? 0.02 : 0);
    g2.strokeStyle = color; g2.lineWidth = 2.2; g2.lineJoin = 'round'; g2.shadowColor = color; g2.shadowBlur = mode ? 9 : 6;
    g2.beginPath();
    let pen = false;
    for (let x = 0; x <= w; x += 2) {
      // 生命安定が低いと、信号がところどころ途切れる
      const gap = vital < 0.5 && Math.sin(x * 0.045 + t * 1.7) > 0.25 + vital * 1.5;
      if (gap) { pen = false; continue; }
      let envl = 0.35 + 0.65 * Math.pow(Math.abs(Math.sin(x * 0.013 - t * 0.9)), 1.5);
      if (mode === 'charging') envl *= 0.25 + 0.95 * (x / w) * (0.85 + 0.15 * Math.sin(t * 7));
      let v = Math.sin(x * f + t * 5.2) * 0.62 + Math.sin(x * f * 2.7 - t * 8.1) * 0.28 * (0.3 + agit) + (hit > 0.05 ? (Math.random() - 0.5) * hit : 0);
      if (mode === 'ready') v += Math.pow(Math.abs(Math.sin(x * 0.06 - t * 7)), 14) * 1.4 * (Math.sin(x * 0.03 - t * 3.5) > 0 ? 1 : -1);
      const y = Math.max(2, Math.min(h - 2, mid + amp * envl * v));
      if (pen) g2.lineTo(x, y); else { g2.moveTo(x, y); pen = true; }
    }
    g2.stroke(); g2.shadowBlur = 0;
  }
  // info … { ep, epMax, hp, hpMax, heightM, stage, obs, action, special, specialName, alert, hit, pointerHidden }
  // view … 画面の位置など（start の中の updateHud が作る）。pointer … 体の輪の位置、track … 頭の真上の位置（どちらも盤面の中の px）
  function update(now, info, view) {
    const t = now / 1000;
    const on = !!info && view.kaijuAlpha > 0.5 && !view.hidden;
    root.style.opacity = on ? '1' : '0';
    if (!on) return;
    // 盤面の横幅に合わせて生体モニターを拡大・縮小する（基準は iPhone SE3 の 359px）。狭い盤面では飾りの文字を省く
    const k = Math.max(0.78, Math.min(1.4, view.W / 359));
    if (Math.abs(k - scale) > 0.005) { scale = k; bio.style.transform = `scale(${k.toFixed(3)})`; track.style.setProperty('--k', k.toFixed(3)); root.classList.toggle('compact', view.W < 315); }
    agit = Math.max(0, Math.min(1, info.epMax > 0 ? info.ep / info.epMax : 0));
    vital = Math.max(0, Math.min(1, info.hpMax > 0 ? info.hp / info.hpMax : 0));
    hit += ((info.hit ? 1 : 0) - hit) * 0.25;
    const A = AGIT.find(a => agit >= a[0]), V = VITAL.find(v => vital >= v[0]);
    set(aVal, A[1]); set(aPct, Math.round(agit * 100) + '%'); aVal.style.color = A[2];
    set(vVal, V[1]); set(vPct, Math.round(vital * 100) + '%'); if (rowV.dataset.tone !== V[2]) rowV.dataset.tone = V[2];
    const special = WARN[info.special] ? info.special : '';
    const key = info.action ? info.action.name + (special === 'ready' ? '!' : '') : '';
    if (key !== actKeyNow) { actKeyNow = key; show(act, !!info.action); if (info.action) set(actVal, info.action.name); act.classList.toggle('alert', special === 'ready'); }
    const sameName = special === 'ready' && !!info.action && info.action.name === info.specialName;
    const wkey = special ? special + '|' + (info.specialName || '') + '|' + sameName : '';
    if (wkey !== warnKeyNow) {
      warnKeyNow = wkey;
      show(warn, !!special);
      warn.dataset.kind = special;
      if (special) {
        const W = WARN[special];
        set(warnHeadText, W.head);
        set(warnHeadSub, sameName ? W.sub : ''); show(warnHeadSub, sameName);
        show(warnName, !sameName);
        set(warnName.firstChild, info.specialName || '');
        set(warnSub, W.sub); show(warnSub, !!W.sub);
      }
    }
    const nextTone = info.alert ? 'alert' : '';
    if (nextTone !== tone) { tone = nextTone; root.dataset.tone = tone; }
    // v364：顔を狙う演出（目視観察の照準など）が出ている間は、体の輪と線を消す（終わったら戻す。CSS でふわっと）
    const ptrOff = !!info.pointerHidden;
    if (ptrOff !== root.classList.contains('ptrOff')) root.classList.toggle('ptrOff', ptrOff);
    if (now - lastWave > 66) {
      lastWave = now;
      drawWave(t, info.alert ? '#ff5a6e' : A[2], info.alert ? special : '');
      const bars = hit > 0.3 ? 1 : vital < 0.25 ? 2 : vital < 0.5 ? 3 : 4;
      if (sig.dataset.n !== String(bars)) sig.dataset.n = String(bars);
    }
    if (now - lastEnv > 900) {
      lastEnv = now;
      const j = (base, amp, sp) => base + Math.sin(t * sp) * amp + Math.sin(t * sp * 2.7 + 1) * amp * 0.4;
      set(env, info.stage === 'seafloor'
        ? `DEPTH ${Math.round(j(3812, 3, 0.21)).toLocaleString('en-US')}m · ${j(2.1, 0.05, 0.13).toFixed(1)}℃ · ${j(38.4, 0.05, 0.17).toFixed(1)}MPa`
        : `WIND ${j(4.2, 0.9, 0.31).toFixed(1)}m/s · ${j(17.6, 0.15, 0.11).toFixed(1)}℃ · ${Math.round(j(64, 1.5, 0.09))}%RH`);
    }
    // 高度スケール：0m から頭の高さまで（目盛りの間隔は怪獣の高さで変える）
    const showRuler = view.oblique > 0.02 && view.heightM > 0;
    if (showRuler !== rulerOn) { rulerOn = showRuler; ruler.style.display = showRuler ? '' : 'none'; }
    if (showRuler) {
      ruler.style.opacity = view.oblique.toFixed(2);
      const st = STEPS.find(v => view.heightM / v <= 12) || STEPS[STEPS.length - 1];
      if (st !== step) { step = st; ticks.forEach(tk => { tk.dataset.m = ''; }); }
      const n = Math.floor(view.heightM / step) + 1;
      while (ticks.length < n) { const tk = el('div', 'nhTick'); tk.append(el('i'), el('span')); ruler.appendChild(tk); ticks.push(tk); }
      const yTop = view.yOfMetres(view.heightM), y0 = view.yOfMetres(0), lo = 36, hi = view.H - 20;
      const yMarkTop = Math.max(lo, view.yHead), yAlt = view.yOfMetres(view.altM);
      for (let i = 0; i < ticks.length; i++) {
        const tk = ticks[i], m = i * step, y = view.yOfMetres(m);
        const vis = i < n && y > lo && y < hi;
        tk.style.display = vis ? '' : 'none';
        if (!vis) continue;
        const major = i % 2 === 0;
        if (tk.dataset.m !== String(m)) { tk.dataset.m = String(m); tk.classList.toggle('major', major); tk.lastChild.textContent = major ? String(m) : ''; }
        tk.style.transform = `translate3d(0,${y.toFixed(1)}px,0)`;
        // 頭の高さ・機体の高度の印と重なる数字は隠す
        const clash = Math.abs(y - yMarkTop) < 10 || Math.abs(y - yAlt) < 10;
        if (tk.lastChild.style.visibility !== (clash ? 'hidden' : '')) tk.lastChild.style.visibility = clash ? 'hidden' : '';
      }
      const a0 = Math.max(lo, yTop), a1 = Math.min(hi, y0);
      axis.style.transform = `translate3d(0,${a0.toFixed(1)}px,0)`; axis.style.height = Math.max(0, a1 - a0).toFixed(1) + 'px';
      set(topMark.firstChild, Math.round(view.heightM) + 'm');
      topMark.style.transform = `translate3d(0,${yMarkTop.toFixed(1)}px,0)`;
      altMark.style.display = yAlt > lo && yAlt < hi ? '' : 'none';
      set(altMark.firstChild, Math.round(view.altM) + 'm');
      altMark.style.transform = `translate3d(0,${yAlt.toFixed(1)}px,0)`;
    }
    // 生体モニターの外形（右上を軸に拡大・縮小しているので、その分を足す）。
    // 線をつなぐ下の辺は、必殺技の警告の段が出ているときはその段の上の辺（警告の段の有り無しで線が跳ばないように。線は警告の段の上の線に重なる）
    const bw = bio.offsetWidth * scale, baseH = warn.style.display !== 'none' ? warn.offsetTop : bio.offsetHeight;
    const bR = bio.offsetLeft + bio.offsetWidth, bL = bR - bw, bT = bio.offsetTop, bB = bT + baseH * scale - 1;
    // 体の輪 → 生体モニター
    const p = view.pointer;
    const showRing = view.oblique > 0.5 && !!p && p.y > 12 && p.y < view.H - 12 && p.x > 4 && p.x < view.W - 4;
    show(svg, showRing);
    if (showRing) {
      ring.setAttribute('cx', p.x.toFixed(1)); ring.setAttribute('cy', p.y.toFixed(1));
      ring2.setAttribute('cx', p.x.toFixed(1)); ring2.setAttribute('cy', p.y.toFixed(1));
      ring2.setAttribute('stroke-dashoffset', (-t * (info.alert ? 40 : 14)).toFixed(1));
      const pts = leaderPoints(p.x, p.y, bL, bR, bT, bB);
      show(line, !!pts);
      if (pts) line.setAttribute('points', pts.map(q => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' '));
    }
    // 追跡の照準：頭の真上（モニターと盤面の左の端にかからない幅で）
    const tr = view.track;
    const room = tr ? Math.min(bL - 8 - tr.x, tr.x - 8) : 0;
    const showTrack = view.oblique > 0.5 && !!tr && room > 34;
    show(track, showTrack);
    if (showTrack) {
      set(trackA, info.alert ? 'WARNING' : 'TRACKING');
      set(trackB, info.obs || '');
      const w = Math.min(112 * scale, room * 2), h = track.offsetHeight || 26;
      const y = Math.max(34, tr.y - 16 * scale - h);   // 角の先より少し上（角は頭の骨より後ろへ反っていて、画面では少し上に出る）
      track.style.width = w.toFixed(1) + 'px';
      track.style.transform = `translate3d(${(tr.x - w / 2).toFixed(1)}px,${y.toFixed(1)}px,0)`;
      // 目盛りは頭の向きにつれて少し流れる（照準が頭を追っている感じ）
      trackTicks.style.backgroundPositionX = ((tr.drift || 0) * 3).toFixed(1) + 'px';
    }
  }
  return { update, dispose() { root.remove(); } };
}

// v360：左右の景色（森林の木・海底の岩山）の3Dモデルは無くした。地面の画像に描かれた森・岩場だけで十分立体的に見えるため
//（v354〜v359 の buildScenery・toLambert・tree-v354.js・rock-v354.js は使わない）

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
  renderer.info.autoReset = false;      // v365：1コマの中で何回か描く（にじむ光）ので、数える所は自分で区切る
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
  patchLit(groundMat, 'ground');   // v365 雲の影・水面からの光・左右の端を暗く
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
  // 機体：読み込みを頼み、届いていればその元を返す（まだなら null）
  function templateFor(name) {
    if (templates[name]) return templates[name];
    if (!requested.has(name)) {
      requestModel(name, async gltf => {
        await prepareObject(gltf.scene, true);
        if (running) templates[name] = gltf.scene;
      }).catch(() => {});
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
    k.pointerNode = k.chest;                          // 仮モデルは胸の光る所
    k.pointerOffset = new THREE.Vector3(0, 0, 0.12);
    k.aimNode = k.head;                               // 決まった所に出す演出は頭へ（v364）
    k.aimOffset = new THREE.Vector3(0, 0, 0.2);
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
  // ---------------------------------------------------------------------------
  // v365 見た目の強化：空気・足元の影・足音の輪・胸の光・画面の揺れ・にじむ光
  // ---------------------------------------------------------------------------
  const cloudTex = cloudNoiseTexture(), causTex = causticTexture();
  noahU.uNoahNoise.value = cloudTex; noahU.uNoahCausTex.value = causTex;
  const atmos = makeAtmos();
  scene.add(atmos.group);
  const bloom = makeBloom(renderer);
  let bloomOn = true, bloomUsed = false;
  cleanups.push(() => { atmos.dispose(); bloom.dispose(); cloudTex.dispose(); causTex.dispose(); noahU.uNoahNoise.value = null; noahU.uNoahCausTex.value = null; });
  // 足元の影：体の下の大きな影＋両足の下の濃い影（足が上がると薄くなる）。太陽の影とは別に、地面に「乗っている」感じを出す
  const blobTex = blobTexture(), ringTex = ringTexture();
  const flatGeo = new THREE.PlaneGeometry(1, 1); flatGeo.rotateX(-Math.PI / 2);
  const blobMat = () => new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  const contact = [0, 1, 2].map(i => { const m = new THREE.Mesh(flatGeo, blobMat()); m.renderOrder = 0.2 + i * 0.01; m.visible = false; m.frustumCulled = false; scene.add(m); return m; });
  // 足が着いたときに地面に広がる輪（砂・土が押しのけられる）
  const rings = [0, 1, 2, 3].map(() => {
    const m = new THREE.Mesh(flatGeo, new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, opacity: 0, depthWrite: false }));
    m.renderOrder = 0.3; m.visible = false; m.frustumCulled = false; scene.add(m);
    return { m, age: 9, life: 0.8 };
  });
  let ringNext = 0;
  const ringColor = new THREE.Color();
  cleanups.push(() => { blobTex.dispose(); ringTex.dispose(); flatGeo.dispose(); contact.forEach(m => m.material.dispose()); rings.forEach(r => r.m.material.dispose()); });
  // 胸の器官のまわりの光
  const chestGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }));
  chestGlow.renderOrder = 0.4; chestGlow.visible = false;
  scene.add(chestGlow);
  cleanups.push(() => chestGlow.material.dispose());
  const chestPos = new THREE.Vector3();
  let footY0 = [null, null];
  // 画面の揺れ（怪獣の足音・炸裂）。盤面の上の文字（HPの札・計器）は揺らさず、3Dの景色だけを揺らす
  let shakeAmp = 0;
  const addShake = v => { if (quality < 2) shakeAmp = Math.min(0.11, Math.max(shakeAmp, v)); };
  let rimHot = 0;
  const rimBase = new THREE.Color(), rimHotC = new THREE.Color();
  function footImpact(x, z) {
    const r = rings[ringNext]; ringNext = (ringNext + 1) % rings.length;
    r.age = 0; r.m.position.set(x, 0.03, z); r.m.material.color.copy(ringColor);
    addShake(0.055);
    atmos.footfall(x, z);
  }
  function updateLook(g, now, dt, scroll, ds, kAlpha) {
    const t = now / 1000, L = STAGE_LOOK[lookStage] || STAGE_LOOK.forest, ks = kaiju.root.scale.x;
    noahU.uNoahScroll.value = scroll;
    noahU.uNoahWind.value.set((t * 0.0055) % 1, (t * 0.002) % 1);
    noahU.uNoahCausA.value.set((t * 0.021) % 1, (t * 0.013) % 1);
    noahU.uNoahCausB.value.set(1 - (t * 0.017) % 1, (t * 0.019) % 1);
    // 縁の光：必殺技の溜めで熱い色へ
    const chg = debugPose ? (debugPose.charge || 0) : charge;
    rimHot = smooth(rimHot, chg, 4, dt);
    noahU.uNoahRim.value.copy(rimBase).lerp(rimHotC, clamp01(rimHot) * (0.75 + 0.25 * Math.sin(t * 9)));
    // 炸裂の光が当たっている間は、縁もその色で光る（当たった手ごたえ）
    if (flash.intensity > 0.2) { const fk = Math.min(1.1, flash.intensity / 12), rc = noahU.uNoahRim.value; rc.r += flash.color.r * fk; rc.g += flash.color.g * fk; rc.b += flash.color.b * fk; }
    // 胸の場所
    kaiju.pointerNode.getWorldPosition(chestPos);
    chestPos.addScaledVector(kaiju.pointerOffset, ks);
    const G = kaiju.real ? KAIJU_MODEL.glow : null;
    chestGlow.visible = !!G && kAlpha > 0.02 && kaiju.root.visible;
    if (chestGlow.visible) {
      const lv = kaiju.glowLevel ? kaiju.glowLevel() : 0.5;
      chestGlow.position.set(chestPos.x + G.offset[0] * ks, chestPos.y + G.offset[1] * ks, chestPos.z + G.offset[2] * ks);
      chestGlow.scale.setScalar(G.size * ks * (0.92 + 0.1 * Math.min(2.5, lv)));
      chestGlow.material.color.set(G.color);
      chestGlow.material.opacity = Math.min(1, G.alpha * (0.55 + 0.45 * Math.min(2.4, lv))) * kAlpha;
    }
    // 足元の影
    const show = kaiju.root.visible && kAlpha > 0.02;
    const bx = kaiju.root.position.x + (kaiju.body ? kaiju.body.position.x : 0);
    contact[0].visible = show;
    if (show) {
      contact[0].position.set(bx + PATH_CENTER_X * ks / KAIJU_SCALE, 0.02, KAIJU_Z - 0.1 * ks);
      contact[0].scale.set(3.0 * ks, 1, 2.3 * ks);
      contact[0].material.opacity = L.contact * kAlpha;
    }
    for (let i = 0; i < 2; i++) {
      const bone = kaiju.real && kaiju.feet ? kaiju.feet[i] : null, m = contact[1 + i];
      m.visible = show && !!bone;
      if (!m.visible) continue;
      bone.getWorldPosition(tmpFoot);
      if (footY0[i] == null || tmpFoot.y / ks < footY0[i]) footY0[i] = tmpFoot.y / ks;
      const lift = clamp01((tmpFoot.y / ks - footY0[i]) / 0.11);
      m.position.set(tmpFoot.x, 0.025, tmpFoot.z + 0.1 * ks);
      m.scale.set(0.8 * ks * (1 + lift * 0.35), 1, 0.95 * ks * (1 + lift * 0.35));
      m.material.opacity = L.contact * 1.25 * (1 - lift * 0.75) * kAlpha;
    }
    // 足音の輪
    for (const r of rings) {
      if (r.age >= r.life) { r.m.visible = false; continue; }
      r.age += dt; r.m.position.z -= ds;
      const u = clamp01(r.age / r.life), e = 1 - Math.pow(1 - u, 2.4);
      r.m.visible = true;
      r.m.scale.setScalar((0.55 + 1.5 * e) * ks);
      r.m.material.opacity = 0.5 * (1 - u) * (1 - u);
    }
    atmos.update(now, scroll, chg, chestPos, ks, kAlpha);
    shakeAmp *= Math.exp(-dt * 7.5);
    if (shakeAmp < 0.002) shakeAmp = 0;
  }
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
      stageFx.footfall(tmpFoot.x, tmpFoot.z + 0.08 * kaiju.root.scale.z, KAIJU_SCALE);
      footImpact(tmpFoot.x, tmpFoot.z + 0.08 * kaiju.root.scale.z);
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
      // v365：火花・煙（森林）・画面の小さな揺れ
      atmos.burst(tmpBlast.x, tmpBlast.y, tmpBlast.z, info.peak, info.color);
      stageFx.smoke(tmpBlast.x, tmpBlast.y, tmpBlast.z, info.peak);
      addShake(info.peak >= 14 ? 0.05 : info.peak >= 9 ? 0.03 : 0.015);
    }
  }
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
    footY0 = [null, null];
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
  pickRing.scale.setScalar(KAIJU_SCALE);
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
  // v361：機体から地面へ下ろす細い光の線（上が明るく、下へ行くほど消える）。高い所を飛んでいるのが分かるように
  const tetherGeo = new THREE.BufferGeometry();
  tetherGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, -0.16, 0, 0, -FLY_Y * 0.55, 0, 0, -FLY_Y, 0], 3));
  tetherGeo.setAttribute('color', new THREE.Float32BufferAttribute([0.55, 0.95, 1, 0.16, 0.3, 0.34, 0, 0, 0], 3));
  const tetherMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false });
  cleanups.push(() => { tetherGeo.dispose(); tetherMat.dispose(); });

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
  // 怪獣の大きさ（kaiju.root の倍率）。v362：カメラに入れる怪獣の点は、この大きさに合わせる（背の高い怪獣でも頭が切れない）
  const kaijuRootScale = () => (bridge.kaijuHeightCells ? bridge.kaijuHeightCells() : 3) / 3 * KAIJU_SCALE;
  function poseTarget(pose, aspect, ks) {
    const key = pose.name + ':' + aspect.toFixed(3) + ':' + ks.toFixed(4);
    let t = poseFrames.get(key);
    if (t) return t;
    const fit = poseFit(pose, ks);
    t = pose.target.clone();
    for (let k = 0; k < 3; k++) {
      placeCamera(pose.elev, fitDistance(pose.elev, t, pose.fov, aspect, fit), t, pose.fov, aspect);
      let lo = Infinity, hi = -Infinity;
      for (const p of fit) { tmpV.copy(p).project(camera); lo = Math.min(lo, tmpV.y); hi = Math.max(hi, tmpV.y); }
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
    // v363：指の位置も渡す（タップで開いたポップアップに、同じタップのクリックが届かないようにするため）
    bridge.tap(target ? target.cell : { x: -1, y: -1 }, { x: e.clientX, y: e.clientY });
  }
  // v363：盤面のタッチが終わったときに、ブラウザがあとから出す「クリック」を止める（iPhone で、怪獣を押して開いた
  //       ポップアップの怪獣の絵にそのクリックが届き、特性の小窓まで開いていた）。盤面は pointer のイベントだけで動くので、クリックは要らない
  function onTouchEnd(e) { if (e.cancelable) e.preventDefault(); }
  function onCancel(e) { if (pressId !== e.pointerId) return; pressId = null; showPick(null); }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('touchend', onTouchEnd, { passive: false });

  // ---------------------------------------------------------------------------
  // カード演出の置き場所。index.html は2Dの演出を1つずつ、ここで求めた画面上の位置・大きさに合わせて
  // 画面に平行に描く（地面に寝かせない）。
  //   plane(x, y)    … 盤面の位置を「中列では機体の高さ、奥では怪獣の胸の前」を通る面に置いたときの画面の位置
  //   standing(x, y) … 怪獣の前に立てた面（研究の演出用）。盤面の y=0 が怪獣の頭の上、y=3 が足元
  // ---------------------------------------------------------------------------
  const EP = new THREE.Vector3();
  // v363：カード演出（爆発・目視観察の照準など）の大きさは、怪獣を大きくする前（v360）と同じ「1マス＝1」に戻す。
  //       置き場所は大きくなった怪獣に合わせたまま（怪獣の胸の前・体の真ん中）。怪獣に対しては相対的に小さく見える
  //   planeRef(x, y) … plane の点から右へ1（1マス）ずらした所。index.html はこれで演出の大きさを決める
  //   standing(x, y) … 研究の演出の面。大きさは v360 と同じで、体の真ん中（高さの55%）に合わせる
  const STAND_Z = KAIJU_Z + 1.0 * KAIJU_SCALE, STAND_H = 1.1, STAND_CY = 1.65 * KAIJU_SCALE;
  //   aim(dx, dy)    … v364：怪獣の顔（KAIJU_MODEL.fxAim）から、右へ dx・下へ dy（1マス＝1。縦は研究の面と同じ 1.1 倍）ずらした所。
  //                    index.html は、決まった所に出す演出（研究の照準・麻酔弾URの霧・誘導LRの爆発）をこれで顔に合わせる。顔の動きにも付いていく
  const AIM = new THREE.Vector3();
  const fxProject = {
    aim(dx, dy) {
      kaiju.aimNode.getWorldPosition(AIM);
      AIM.addScaledVector(kaiju.aimOffset, kaiju.root.scale.x);
      const s = toScreen(EP.set(AIM.x + dx, AIM.y - dy * STAND_H, AIM.z));
      return { x: s.x, y: s.y };
    },
    plane(bx, by) { const s = toScreen(effectPlanePoint(bx, by, EP)); return { x: s.x, y: s.y }; },
    planeRef(bx, by) { effectPlanePoint(bx, by, EP); EP.x += 1; const s = toScreen(EP); return { x: s.x, y: s.y }; },
    standing(bx, by) { const s = toScreen(EP.set(bx - 3.5, STAND_CY + (1.5 - by) * STAND_H, STAND_Z)); return { x: s.x, y: s.y }; },
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
    sun.position.fromArray(L.sunPos);
    renderer.toneMappingExposure = L.exposure;
    stageFx.setStage(stage);
    // v365
    atmos.setStage(stage);
    noahU.uNoahCloud.value = L.cloud; noahU.uNoahCaus.value = L.caustic; noahU.uNoahCausColor.value.set(L.causticColor); noahU.uNoahEdge.value = L.edge;
    rimBase.set(L.rim).multiplyScalar(L.rimI); rimHotC.set(L.rimHot).multiplyScalar(1.5);
    ringColor.set(FX_DUST[stage === 'seafloor' ? 'seafloor' : 'forest'].color);
    // 映り込みの空（ステージの色）
    try {
      const next = makeEnvironment(renderer, L);
      envTex = next.texture; envIntensity = L.env;
      applyEnv(scene);
      Object.values(templates).forEach(applyEnv);
      if (envRT) envRT.dispose();
      envRT = next;
    } catch (e) { console.warn('[N.O.A.H. 3D] 映り込みの空を作れませんでした', e); }
  }

  // ---------------------------------------------------------------------------
  // 機体・ミサイル・目印
  // ---------------------------------------------------------------------------
  function removeAircraft(a) {
    scene.remove(a.model.group);
    a.model.dispose();
    if (a.tether) scene.remove(a.tether);
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
  const hud = makeHud(host);   // v361 観測HUD（札より下に重ねる）
  host.insertBefore(host.lastChild, hpLayer);
  cleanups.push(() => hud.dispose());
  const hpPlates = new Map();   // unit → 札
  const HP_TONES = [[0.25, '#ff5b5b'], [0.5, '#ffd352'], [Infinity, '#57efbc']];   // 2D のHPバーと同じ色分け
  // v360：次の怪獣の攻撃で減る分のHPを赤く点滅（バーの右端）。大破しうるときは札の枠ごと赤く点滅（盤面の DMG の点滅と同じ速さ）
  const hpStyle = document.createElement('style');
  hpStyle.textContent =
    '@keyframes noahHpLossBlink{0%,100%{opacity:1}50%{opacity:.18}}' +
    '@keyframes noahHpBreakBlink{0%,100%{border-color:rgba(255,96,96,1);background-color:rgba(132,14,20,.93);box-shadow:0 0 12px rgba(255,50,50,.9),0 1px 5px rgba(0,0,0,.6)}' +
    '50%{border-color:rgba(255,96,96,.35);background-color:rgba(4,9,16,.84);box-shadow:0 1px 5px rgba(0,0,0,.6)}}';
  document.head.appendChild(hpStyle);
  cleanups.push(() => hpStyle.remove());
  let hpForecast = null, hpForecastAt = -1e9;
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
    const loss = document.createElement('i');   // 次の攻撃で減る分
    loss.style.cssText = 'position:absolute;top:0;bottom:0;left:0;width:0;display:none;background:#ff2f2f;box-shadow:0 0 4px rgba(255,60,60,.9);' +
      'animation:noahHpLossBlink .9s ease-in-out infinite;transition:left .4s ease,width .4s ease;';
    bar.append(fill, loss);
    el.append(label, num, bar);
    hpLayer.appendChild(el);
    return { el, num, fill, loss, hp: null, max: null, dmg: 0, brk: false, w: 0, h: 0, flashUntil: 0, flashing: false, shown: false, x: 0, y: 0, opacity: '' };
  }
  const hpA = new THREE.Vector3(), hpB = new THREE.Vector3();
  function updateHpPlates(g, now) {
    const entering = typeof g.aircraftEntryProgress === 'number' && g.aircraftEntryProgress < 1;
    let hideAll = !!g.introHideUnits || entering || !!g.gameOver;
    if (!hideAll && bridge.hpHidden) { try { hideAll = !!bridge.hpHidden(); } catch (e) {} }
    const seen = new Set();
    if (!hideAll && now - hpForecastAt > 120) {
      hpForecastAt = now;
      try { hpForecast = bridge.hpForecast ? bridge.hpForecast() : null; } catch (e) { hpForecast = null; }
    }
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
        p.dmg = -1;   // 減る分の位置も合わせ直す
      }
      // 次の攻撃で減る分（無ければ隠す）
      const f = hpForecast && hpForecast.get(u);
      const dmg = f ? Math.min(hp, Math.max(0, Math.round(f.damage))) : 0, brk = !!(f && f.breakRisk);
      if (dmg !== p.dmg) {
        p.dmg = dmg;
        p.loss.style.display = dmg > 0 ? 'block' : 'none';
        if (dmg > 0) { p.loss.style.left = ((hp - dmg) / max * 100).toFixed(1) + '%'; p.loss.style.width = (dmg / max * 100).toFixed(1) + '%'; }
      }
      if (brk !== p.brk) { p.brk = brk; p.el.style.animation = brk ? 'noahHpBreakBlink .9s ease-in-out infinite' : ''; }
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

  const hudV = new THREE.Vector3();
  const hudView = { H: 1, W: 1, oblique: 1, kaijuAlpha: 1, hidden: false, heightM: 0, altM: 0, yHead: 0, pointer: null, track: null, yOfMetres: null };
  let hudUnit = 1;   // 1m あたりの3Dの長さ
  hudView.yOfMetres = m => toScreen(hudV.set(0, m * hudUnit, KAIJU_Z)).y;
  function updateHud(g, now, kAlpha, attacking) {
    let info = null;
    try { info = bridge.hud ? bridge.hud() : null; } catch (e) { info = null; }
    hudView.W = W; hudView.H = H;
    hudView.kaijuAlpha = kAlpha;
    hudView.hidden = !!g.introHideUnits || !!g.gameOver;
    hudView.oblique = clamp01((72 - cam.elev) / 24);
    if (info) {
      const ks = kaiju.root.scale.y;
      const top = kaiju.localBox.max.y * ks;
      hudView.heightM = Number(info.heightM) || 0;
      hudUnit = hudView.heightM > 0 ? top / hudView.heightM : 1;
      hudView.altM = FLY_Y / hudUnit;
      hudView.yHead = toScreen(hudV.set(0, top, KAIJU_Z)).y;
      // 追跡の照準：頭の前後の位置で、体のいちばん上の高さ。左右は体の真ん中（攻撃の揺れに付いていく）
      kaiju.head.getWorldPosition(hudV);
      const headX = toScreen(hudV).x;
      const cx = kaiju.root.position.x + kaiju.body.position.x;
      const ts = toScreen(hudV.set(cx, top, hudV.z));
      hudView.track = ts.behind ? null : { x: ts.x, y: ts.y, drift: headX - ts.x };
      // 生体モニターの輪：怪獣ごとの場所（KAIJU_MODEL.hudPointer）
      kaiju.pointerNode.getWorldPosition(hudV);
      hudV.addScaledVector(kaiju.pointerOffset, ks);
      const ps = toScreen(hudV);
      hudView.pointer = ps.behind ? null : { x: ps.x, y: ps.y };
      info.hit = attacking;
    }
    hud.update(now, info, hudView);
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
      if (!a.tether) { a.tether = new THREE.Line(tetherGeo, tetherMat); a.tether.renderOrder = 2; a.tether.frustumCulled = false; scene.add(a.tether); }
      a.tether.position.copy(grp.position);
      const flick = 0.85 + Math.sin(now / 37 + type) * 0.1 + Math.random() * 0.08;
      a.model.engines.forEach(f => { const r = f.userData.r || 1; f.scale.set(r, flick * (f.userData.len || 1), r); });
      if (a.model.lights) {
        const Lg = a.model.lights, al = a.model.alpha, blink = (now / 1000 + type * 0.37) % 1.6;
        Lg.engines.forEach(sp => { sp.material.opacity = sp.userData.base * al * (0.75 + 0.3 * flick); });
        Lg.port.material.opacity = Lg.star.material.opacity = 0.95 * al * (0.8 + 0.2 * Math.sin(now / 300 + type));
        Lg.strobe.material.opacity = al * (blink < 0.07 || (blink > 0.2 && blink < 0.26) ? 1 : 0);
      }
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
        pr = { model, history: [], start: new THREE.Vector3(sx, FLY_Y + 0.02, sz), end, fire: bridge.cardCategory(ef.cardId) === 'fire', puff: null };
        projectiles.set(ef, pr);
      }
      const pos = flightPoint(pr, p, tmpA);
      pr.model.group.position.copy(pos);
      pr.model.group.lookAt(pr.end);
      pr.model.group.rotateY(Math.PI);           // 模型の機首は -Z。lookAt は +Z を向けるので反転
      // v365：航跡（一定の間隔で煙・泡を置いていく）
      if (!pr.puff) pr.puff = pos.clone();
      else if (pr.puff.distanceToSquared(pos) > (pr.fire ? 0.05 : 0.09)) { stageFx.trail(pos.x, pos.y, pos.z, pr.fire); pr.puff.copy(pos); }
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
        // 移動先の光の柱・押しているマスの枠・怪獣の足元の輪・行動中の輪・戦術パネル
        show(tacticalPlane); show(pickFrame); show(pickRing); show(activeRing);
        if (pillars[0]) show(pillars[0].g);
        // 砂ぼこり・泡（見えない粒を1つずつ）
        stageFx.warm(true);
        temps.push({ obj: null, dispose: () => stageFx.warm(false) });
        // v365：空気・足元の影・足音の輪・胸の光
        atmos.warm(true);
        temps.push({ obj: null, dispose: () => atmos.warm(false) });
        contact.forEach(show); show(rings[0].m); show(chestGlow);
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
      placeCamera(cam.elev, fitDistance(cam.elev, cam.target, cam.fov, aspect, poseFit(CAMERA_POSES.oblique, kaijuRootScale())), cam.target, cam.fov, aspect);
      kaiju.root.updateMatrixWorld(true);
      renderer.render(scene, camera);
      if (!transparent && bloomOn && quality === 0) bloom.apply(0.01, 0.99);   // にじむ光の絵の作り方も作っておく
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
  let walkAmp = 0, lastScroll = null, lunge = 0, charge = 0, aircraftMoving = false, motionSwing = 0;
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
    // いちばん軽い段では、砂ぼこり・泡を少なめに
    stageFx.setLite(quality >= 2);
    // v365：1段目でにじむ光を止め、鳥・魚を減らす。2段目で光の筋・鳥・魚・揺れを止め、霧と粒を減らす
    atmos.setLevel(quality);
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
      (g.kaijuMotion && now - g.kaijuMotion.start < g.kaijuMotion.duration + 100) ||
      (typeof g.aircraftEntryProgress === 'number' && g.aircraftEntryProgress < 1) || camSettling || shakeAmp > 0 || Math.abs(cam.elev - desiredPose(g).elev) > 0.3;
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
    renderer.info.reset();

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
      const tileW = TILE_W * GROUND_ZOOM;
      tileH = tileW * ih / Math.max(1, iw);
      groundTex.repeat.set(GROUND_W / tileW, GROUND_L / tileH);
      // 絵の道の中心（u = PATH_CENTER_U）が x = PATH_CENTER_X に来るように
      groundTex.offset.x = PATH_CENTER_U - (PATH_CENTER_X + GROUND_W / 2) / GROUND_W * groundTex.repeat.x;
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
    // v363：攻撃の動き（最接近攻撃・薙ぎ払い・必殺技）
    const km = g.kaijuMotion;
    const kmP = km && km.duration > 0 ? (now - km.start) / km.duration : -1;
    const motion = kmP >= 0 && kmP <= 1 ? { kind: km.kind, side: km.side || 1, p: kmP } : null;
    motionSwing = motion ? motionOffsets(motion).swing : 0;
    if (debugPose) kaiju.animate(debugPose.t != null ? debugPose.t : t, debugPose.scroll != null ? debugPose.scroll : scroll, debugPose.walk || 0, 0, debugPose.lunge || 0, debugPose.charge || 0, debugPose.motion || null);
    else kaiju.animate(t, scroll, walkAmp, (jitter.x || 0) / cellPx, lunge, charge, motion);
    kaiju.root.visible = kAlpha > 0.01;
    kaiju.setAlpha(kAlpha);
    kaiju.root.scale.setScalar(kaijuRootScale());
    kaiju.root.updateMatrixWorld(true);
    if (!debugPose) kaijuFootfalls(prevScroll, scroll, kAlpha);
    updateLook(g, now, dt, scroll, Math.abs(scroll - prevScroll) > 3 ? 0 : scroll - prevScroll, kAlpha);

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
    const ks = kaiju.root.scale.x;
    const poseT = poseTarget(pose, aspect, ks);
    cam.elev = smooth(cam.elev, pose.elev, rate, dt);
    cam.fov = smooth(cam.fov, pose.fov, rate, dt);
    cam.target.x = smooth(cam.target.x, poseT.x, rate, dt);
    cam.target.y = smooth(cam.target.y, poseT.y, rate, dt);
    cam.target.z = smooth(cam.target.z, poseT.z, rate, dt);
    // 距離：いまの角度で、この構えの点がすべて画面に入る距離へ、なめらかに寄せる（構えが変わったときに跳ばないように）
    const wantDist = fitDistance(cam.elev, cam.target, cam.fov, aspect, poseFit(pose, ks));
    cam.dist = cam.dist > 0 ? smooth(cam.dist, wantDist, rate, dt) : wantDist;
    camSettling = Math.abs(cam.dist - wantDist) > 0.01 || Math.abs(cam.elev - pose.elev) > 0.3 || Math.abs(cam.target.z - poseT.z) > 0.01;
    placeCamera(cam.elev, cam.dist, cam.target, cam.fov, aspect);
    // 機体のHPの札（カメラが決まってから位置を合わせる）
    updateHpPlates(g, now);
    // 観測HUD
    updateHud(g, now, kAlpha, attacking || motionSwing > 0.3);
    // 砂ぼこり・泡
    blastBubbles(g, now);
    stageFx.update(now, scroll, camera);

    // 戦術パネル（2Dで描いた絵を写す）。何も出ないときは写さない。動きのある表示は毎秒10回（重い端末では8回）、HPバーだけなら毎秒4回
    const level = bridge.tacticalLevel ? bridge.tacticalLevel() : 2;
    tacticalPlane.visible = level > 0;
    if (level > 0 && (level !== lastTacticalLevel || now - lastTacticalDraw > (level >= 2 ? tacticalInterval : 250))) {
      const t0 = performance.now();
      lastTacticalDraw = now;
      // 盤面の正方形をそのまま 512×512 に描いてもらう。斜めから見ると奥行きがつぶれるので、DMG の札はその分だけ縦に伸ばして描いてもらう
      bridge.drawTactical(tacticalCanvas, { stretch: Math.max(1, Math.min(2.1, 1 / Math.max(0.2, Math.sin(THREE.MathUtils.degToRad(cam.elev))))) });
      tacticalTex.needsUpdate = true;
      stats.tacticalMs += performance.now() - t0; stats.tacticalDraws++;
    }
    lastTacticalLevel = level;

    // v365：画面の揺れ（文字の位置を決めたあとで、景色だけ揺らす）
    if (shakeAmp > 0) {
      camera.position.y += Math.sin(t * 41) * shakeAmp;
      camera.position.x += Math.sin(t * 33 + 1.3) * shakeAmp * 0.45;
      camera.updateMatrixWorld();
    }
    const r0 = performance.now();
    renderer.render(scene, camera);
    // v365：にじむ光（いちばん上の画質の段だけ）
    bloomUsed = bloomOn && quality === 0 && bloom.apply(BLOOM_LOOK[lookStage === 'seafloor' ? 'seafloor' : 'forest'][0], BLOOM_LOOK[lookStage === 'seafloor' ? 'seafloor' : 'forest'][1]);
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
    canvas.removeEventListener('touchend', onTouchEnd);
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    for (const pr of projectiles.values()) disposeProjectile(pr);
    projectiles.clear();
    for (const a of aircraft.values()) removeAircraft(a);
    aircraft.clear();
    if (ghost) { scene.remove(ghost.model.group); ghost.model.dispose(); ghost = null; }
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
    // v363：本番の怪獣のモデルが出ているか（仮モデルの間は攻撃の動きができないので、index.html は今まで通り三日月弾を出す）
    kaijuReal() { return !!kaiju.real; },
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
        aircraft: aircraft.size, projectiles: projectiles.size, stage: lookStage,
        pillars: pillars.filter(p => p.g.visible).length,
        running, contextLost, errors, visible: bridge.boardVisible(), quality,
        models: {
          kaiju: kaiju.real ? 'real' : 'placeholder',
          kaijuWeightFix: kaiju.weightFix || null,
          aircraftReal: [...aircraft.values()].filter(a => a.model.real).length,
          scenery: 'none',   // v360〜 木・岩山は出さない
          loaded: Object.keys(templates).concat(kaiju.real ? [KAIJU_MODEL_NAME] : []),
          errors: Object.assign({}, modelErrors),
        },
        charge, warmMs: stats.warmMs == null ? null : stats.warmMs,
        fx: stageFx.count(),
        look: { atmos: atmos.count(), bloom: bloomUsed, bloomFailed: bloom.failed, shake: +shakeAmp.toFixed(3), rimHot: +rimHot.toFixed(2) },
        cameraPose: desiredPose(bridge.game) === CAMERA_POSES.top ? 'top' : 'oblique',
        hp: [...hpPlates.entries()].map(([u, p]) => ({ unit: bridge.game && bridge.game.units ? bridge.game.units.indexOf(u) : -1, hp: p.hp, max: p.max, dmg: p.dmg, breakRisk: p.brk, shown: p.shown, x: Math.round(p.x), y: Math.round(p.y), w: p.w, h: p.h })),
      };
    },
    // テスト用：砂ぼこり・泡をすぐに出す（{ foot: [x, z] } / { burst: [bx, by, peak] } / { ambient: true }）
    debugFx(o) {
      if (o && o.foot) stageFx.footfall(o.foot[0], o.foot[1]);
      if (o && o.burst) { const v = effectPlanePoint(o.burst[0], o.burst[1]); stageFx.burst(v.x, v.y, v.z, o.burst[2] || 14); }
      if (o && o.ambient) stageFx.debugAmbient(performance.now());
      return stageFx.count();
    },
    // テスト用：怪獣の姿勢を固定する（null で元に戻す）。motion: { kind, side, p } で攻撃の動きの途中も止められる
    debugKaijuPose(p) { debugPose = p || null; },
    // テスト用：生体モニターの輪の場所を変える（{ bone, offset }。KAIJU_MODEL.hudPointer と同じ書き方。null で元に戻す）
    debugHudPointer(p) {
      const cfg = p || KAIJU_MODEL.hudPointer || {};
      if (kaiju.real) kaiju.pointerNode = (cfg.bone && kaiju.bonesByName[cfg.bone]) || kaiju.root;
      kaiju.pointerOffset.fromArray(cfg.offset || [0, 2.2, 0.3]);
      return { real: !!kaiju.real, node: kaiju.pointerNode.name || '(root)' };
    },
    // テスト用：決まった所に出す演出が狙う所を変える（{ bone, offset }。KAIJU_MODEL.fxAim と同じ書き方。null で元に戻す）
    debugFxAim(p) {
      const cfg = p || KAIJU_MODEL.fxAim || {};
      if (kaiju.real) kaiju.aimNode = (cfg.bone && kaiju.bonesByName[cfg.bone]) || kaiju.head;
      kaiju.aimOffset.fromArray(cfg.offset || [0, 0, 0.3]);
      return { real: !!kaiju.real, node: kaiju.aimNode.name || '(head)' };
    },
    hudState() { const r = s => { const e = host.querySelector(s); if (!e || e.style.display === 'none' || getComputedStyle(e).display === 'none') return null; const b = e.getBoundingClientRect(), h = host.getBoundingClientRect(); return [Math.round(b.left - h.left), Math.round(b.top - h.top), Math.round(b.width), Math.round(b.height)]; };
      const ln = host.querySelector('.nhLine'); return { ptrOff: host.querySelector('.noahHud').classList.contains('ptrOff'), pointer: hudView.pointer, track: r('.nhTrack'), bio: r('.nhBio'), warn: r('.nhWarn'), line: ln && ln.style.display !== 'none' ? ln.getAttribute('points') : null, tone: host.querySelector('.noahHud').dataset.tone || '' }; },
    // テスト用：場面の中身（重さの内訳を調べるときに一部を隠す）
    // テスト用（v365）：にじむ光の入・切、鳥や魚の群れ・足音・揺れをすぐに出す
    debugLook(o) {
      if (o && 'bloom' in o) bloomOn = !!o.bloom;
      if (o && o.flock) atmos.debugFlock(o.flock, o.x, o.z);
      if (o && o.foot) footImpact(o.foot[0], o.foot[1]);
      if (o && o.shake) addShake(o.shake);
      return { bloomOn, bloomUsed, atmos: atmos.count() };
    },
    debugParts() { return { scene, kaiju: kaiju.root, ground, aircraft: [...aircraft.values()].map(a => a.model.group), sun }; },
    // テスト用：盤面の位置（x, y）が画面のどこに映っているか（host 内の CSS px）
    screenOfCell(bx, by, y) { return toScreen(new THREE.Vector3(bx - 3.5, y == null ? PANEL_Y : y, by - 3.5)); },
    screenOfKaiju() { return toScreen(new THREE.Vector3(0, 1.6 * KAIJU_SCALE, KAIJU_Z)); },
    screenOfEffectPoint(bx, by) { return toScreen(effectPlanePoint(bx, by)); },
    debugProjectiles() { return [...projectiles.values()].map(pr => { const p = pr.model.group.position; const s = toScreen(p); return { pos: [p.x, p.y, p.z].map(v => +v.toFixed(2)), screen: [Math.round(s.x), Math.round(s.y)], visible: pr.model.group.visible, inScene: !!pr.model.group.parent }; }); },
  };
  }
}

window.NOAH3D = { start, version: 'v365' };
})();
