// =============================================================================
// noah3d.js — N.O.A.H. 盤面の3D表示（テスト版・v352〜）
// -----------------------------------------------------------------------------
// index.html から import('./noah3d.js') で読み込み、start(bridge) を呼ぶ。
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
//   ⑤ カード演出：2Dの演出を描いたキャンバスを、手前は機体の高さ・奥は怪獣の胸の前を通る斜めの面に
//      重ねて表示（CSS の matrix3d で遠近をつける）
//
// いまは Meshy のモデルの代わりに、簡単な形を組み合わせた仮モデル。
// 本番のモデル（GLB）に差し替えるときは makeKaiju / makeAircraft を置き換える（README の v352 の項を参照）。
// =============================================================================
import * as THREE from './vendor/three-r170.module.min.js';

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

// カメラの構え。elev は見下ろす角度（度）。
const CAMERA_POSES = {
  oblique: { elev: 41, fov: 38, target: new THREE.Vector3(0, 1.0, 0.25) },
  focus:   { elev: 62, fov: 38, target: new THREE.Vector3(0, 0.75, 0.75) },  // 移動先・出撃先を選ぶあいだ
  top:     { elev: 88, fov: 34, target: new THREE.Vector3(0, 0.3, 0.0) },
};

const STAGE_LOOK = {
  forest:   { fog: 0x9db3a6, fogNear: 18, fogFar: 48, sky: 0xe2f0ff, ground: 0x34402a, hemi: 1.25, sun: 0xfff0d2, sunI: 2.4, exposure: 1.02 },
  seafloor: { fog: 0x0f4b57, fogNear: 12, fogFar: 36, sky: 0xa6ecff, ground: 0x0a2a30, hemi: 1.1,  sun: 0xc8f2ff, sunI: 1.6, exposure: 1.1 },
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

// 2次元の射影変換（4点→4点）。返り値は [h0..h7]（h8=1）
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
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
// 仮モデル：機体（2Dの5機の形と色をなぞった簡単な形。機首は奥＝-Z）
// -----------------------------------------------------------------------------
const AIRCRAFT_LOOKS = [
  { body: 0xc9ced6, accent: 0x2f7377, glow: 0xffb35a },   // AA1 デルタ翼
  { body: 0xe9ebe1, accent: 0x84b98f, glow: 0xa8ffd8 },   // AA2 針の胴と三日月の翼
  { body: 0x5a606a, accent: 0xbb7446, glow: 0xffa24c },   // AA3 重ガンシップ
  { body: 0xf0f0f0, accent: 0xc6363c, glow: 0xffd28c },   // AA4 矢じりの翼
  { body: 0x7a3452, accent: 0xebe6dc, glow: 0xffe3a4 },   // AA5 円盤
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
  return { group: g, engines, mats: [mats.body, mats.accent, mats.canopy], glowMat, type };
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

// -----------------------------------------------------------------------------
// 左右の景色（森林：木／海底：岩山）。地形と一緒にスクロールする
// -----------------------------------------------------------------------------
const SCENERY_ZMIN = -24, SCENERY_PERIOD = 34;

function buildScenery(stage) {
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
  return { group, update, dispose };
}

// =============================================================================
// 本体
// =============================================================================
export function start(bridge) {
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
  Object.assign(board2d.style, { position: 'absolute', left: '0', top: '0', transformOrigin: '0 0', pointerEvents: 'none', zIndex: '2', willChange: 'transform' });

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
  const groundMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, map: groundTex });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND_W, GROUND_L), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, 0, GROUND_ZC);
  ground.receiveShadow = true;
  scene.add(ground);
  let groundImg = null, tileH = TILE_W;

  let scenery = null;

  // 怪獣
  const kaiju = makeKaiju();
  kaiju.root.position.set(0, 0, KAIJU_Z);
  scene.add(kaiju.root);
  const glowTex = glowTexture();
  const warnSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: warnTexture(), depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
  warnSprite.renderOrder = 9;
  warnSprite.visible = false;
  scene.add(warnSprite);
  const tmpHead = new THREE.Vector3();

  // 戦術パネル（2Dの絵を機体の高度に浮かべる）
  const tacticalCanvas = document.createElement('canvas');
  tacticalCanvas.width = tacticalCanvas.height = TACTICAL_TEX;
  const tacticalCtx = tacticalCanvas.getContext('2d');
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
  let camMode = 'oblique';
  const cam = { elev: CAMERA_POSES.oblique.elev, fov: CAMERA_POSES.oblique.fov, target: CAMERA_POSES.oblique.target.clone(), dist: 14 };
  const fitPts = [
    [-3.5, 0, -3.5], [3.5, 0, -3.5], [-3.5, 0, 3.5], [3.5, 0, 3.5],
    [-3.1, FLY_Y, 3.6], [3.1, FLY_Y, 3.6], [-1.6, 3.3, KAIJU_Z], [1.6, 3.3, KAIJU_Z], [0, 3.5, KAIJU_Z - 0.6],
  ].map(p => new THREE.Vector3(...p));
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
  function fitDistance(elevDeg, target, fov, aspect) {
    let lo = 4, hi = 90;
    for (let i = 0; i < 22; i++) {
      const d = (lo + hi) / 2;
      placeCamera(elevDeg, d, target, fov, aspect);
      let ok = true;
      for (const p of fitPts) {
        tmpV.copy(p).project(camera);
        if (Math.abs(tmpV.x) > 0.95 || Math.abs(tmpV.y) > 0.93 || tmpV.z > 1) { ok = false; break; }
      }
      if (ok) hi = d; else lo = d;
    }
    return hi;
  }
  function choosingCell(g) { return !!(g && !g.gameOver && !g.introHideUnits && (g.mode === 'move' || g.mode === 'sortie')); }
  function desiredPose(g) {
    if (camMode === 'top') return CAMERA_POSES.top;
    return choosingCell(g) ? CAMERA_POSES.focus : CAMERA_POSES.oblique;
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
      if (!ghost || ghost.type !== type) {
        if (ghost) { scene.remove(ghost.model.group); ghost.model.group.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } }); }
        const model = makeAircraft(type);
        setOpacity(model.mats, 0.42);
        model.glowMat.opacity = 0.35;
        model.group.traverse(o => { if (o.isMesh) { o.castShadow = false; o.renderOrder = 5; } });
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
  // 演出の面（CSS matrix3d で2Dの演出キャンバスを斜めの面に重ねる）
  // ---------------------------------------------------------------------------
  let lastTransform = '';
  const EP = new THREE.Vector3();
  function updateEffectTransform(geom) {
    const { offsetX, offsetY, size } = geom;
    const src = [[offsetX, offsetY], [offsetX + size, offsetY], [offsetX + size, offsetY + size], [offsetX, offsetY + size]];
    const dst = [[0, 0], [7, 0], [7, 7], [0, 7]].map(([bx, by]) => { const s = toScreen(effectPlanePoint(bx, by, EP)); return [s.x, s.y]; });
    const h = homography(src, dst);
    const m = [h[0], h[3], 0, h[6], h[1], h[4], 0, h[7], 0, 0, 1, 0, h[2], h[5], 0, 1];
    const css = `matrix3d(${m.map(v => (Math.abs(v) < 1e-9 ? 0 : +v.toPrecision(9))).join(',')})`;
    if (css !== lastTransform) { board2d.style.transform = css; lastTransform = css; }
  }

  // ---------------------------------------------------------------------------
  // ステージ
  // ---------------------------------------------------------------------------
  let lookStage = '';
  function applyStage(stage) {
    if (stage === lookStage) return;
    lookStage = stage;
    const L = STAGE_LOOK[stage] || STAGE_LOOK.forest;
    scene.fog = new THREE.Fog(L.fog, L.fogNear, L.fogFar);
    scene.background = new THREE.Color(L.fog);
    hemi.color.set(L.sky); hemi.groundColor.set(L.ground); hemi.intensity = L.hemi;
    sun.color.set(L.sun); sun.intensity = L.sunI;
    renderer.toneMappingExposure = L.exposure;
    if (scenery) { scene.remove(scenery.group); scenery.dispose(); }
    scenery = buildScenery(stage === 'seafloor' ? 'seafloor' : 'forest');
    scene.add(scenery.group);
  }

  // ---------------------------------------------------------------------------
  // 機体・ミサイル・目印
  // ---------------------------------------------------------------------------
  function removeAircraft(a) {
    scene.remove(a.model.group);
    a.model.group.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    a.drones.forEach(m => { scene.remove(m); m.material.dispose(); });
  }
  function syncAircraft(g, now, dt) {
    const seen = new Set();
    const hide = !!g.introHideUnits;
    g.units.forEach((u, i) => {
      if (hide || !bridge.unitOccupiesBoard(u)) return;
      seen.add(u);
      let a = aircraft.get(u);
      const type = bridge.aircraftIndex(u);
      if (!a || a.type !== type) {
        if (a) removeAircraft(a);
        const model = makeAircraft(type);
        scene.add(model.group);
        a = { model, type, pos: null, drones: [] };
        aircraft.set(u, a);
      }
      const target = new THREE.Vector3(bridge.boardX(u) + 0.5 - 3.5, FLY_Y, u.row + 0.5 - 3.5);
      if (typeof g.aircraftEntryProgress === 'number' && g.aircraftEntryProgress < 1) {
        const p = easeInOutSine(g.aircraftEntryProgress);
        target.z += (1 - p) * (7 - (u.row + 0.5) + 1.05 + i * 0.12 + 2.5);
        target.y += (1 - p) * 0.4;
      }
      if (!a.pos) a.pos = target.clone();
      const dx = target.x - a.pos.x;
      a.pos.lerp(target, 1 - Math.exp(-dt * 9));
      const phase = now / 330 + type * 1.45, phase2 = now / 520 + type * 0.9;
      const bob = Math.sin(phase) * (type === 0 ? 0.038 : type === 1 ? 0.034 : 0.03);
      const grp = a.model.group;
      grp.position.set(a.pos.x + Math.cos(phase2) * 0.012, a.pos.y + bob, a.pos.z);
      grp.rotation.set(Math.sin(phase * 0.7) * 0.03, 0, THREE.MathUtils.clamp(-dx * 0.9, -0.5, 0.5) + Math.sin(phase2) * 0.03);
      setOpacity(a.model.mats, u.state === 'returning' ? 0.58 : 1);
      const flick = 0.85 + Math.sin(now / 37 + type) * 0.1 + Math.random() * 0.08;
      a.model.engines.forEach(f => f.scale.set(1, flick, 1));
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

  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  function arcPoint(pr, p, out) {
    const e = 1 - Math.pow(1 - p, 1.6);
    out.lerpVectors(pr.start, pr.end, e);
    out.y += Math.sin(p * Math.PI) * 0.6;
    out.x += Math.sin(p * Math.PI) * 0.28 * pr.side;
    return out;
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
        const side = sx < -0.5 ? -1 : sx > 0.5 ? 1 : (Math.random() < 0.5 ? -1 : 1);
        const end = effectPlanePoint(3.5 + (Math.random() - 0.5) * 0.3, FX_HIT_ROW, new THREE.Vector3());
        end.y += (Math.random() - 0.5) * 0.2;
        pr = { model, history: [], start: new THREE.Vector3(sx, FLY_Y + 0.02, sz), end, side };
        projectiles.set(ef, pr);
      }
      const pos = arcPoint(pr, p, tmpA);
      const ahead = arcPoint(pr, Math.min(1, p + 0.04), tmpB);
      pr.model.group.position.copy(pos);
      pr.model.group.lookAt(ahead);
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
  // 毎フレーム
  // ---------------------------------------------------------------------------
  let raf = 0, last = performance.now(), running = true, lastRender = 0, errors = 0;
  let walkPhase = 0, walkAmp = 0, lastScroll = null, lunge = 0;
  const stats = { frames: 0, renderMs: 0, frameMs: 0, tacticalMs: 0, tacticalDraws: 0, effectsMs: 0 };
  // 端末が追いつかない（4秒間、画面の更新が毎秒38回を下回る）ときは、解像度などを1段ずつ下げる
  let quality = 0, qualityLocked = false, tacticalInterval = 66, lastRaf = 0, windowStart = 0, startedAt = performance.now();
  const intervals = [];
  function applyQuality() {
    if (quality >= 1) renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    if (quality >= 2) {
      renderer.setPixelRatio(1);
      tacticalInterval = 125;
      sun.shadow.mapSize.set(512, 512);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    resize();
  }
  function watchSpeed(now) {
    if (lastRaf && now - lastRaf < 1000) intervals.push(now - lastRaf);
    lastRaf = now;
    if (!windowStart) windowStart = now;
    if (now - windowStart < 4000) return;
    if (!qualityLocked && now - startedAt > 5000 && intervals.length > 30 && quality < 2) {
      const sorted = intervals.slice().sort((a, b) => a - b);
      if (sorted[sorted.length >> 1] > 26) { quality++; applyQuality(); }
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
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (contextLost || !bridge.boardVisible()) { lastRaf = 0; windowStart = 0; intervals.length = 0; return; }
    const g = bridge.game;
    if (!g) return;
    watchSpeed(now);
    // 動きの少ないときは毎秒30回ほどに抑えて電池を節約する
    const busy = g.effects.length > 0 || walkAmp > 0.02 || pressId !== null || lunge > 0.02 ||
      (typeof g.aircraftEntryProgress === 'number' && g.aircraftEntryProgress < 1) || Math.abs(cam.elev - desiredPose(g).elev) > 0.3;
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
    const img = bridge.groundImage();
    if (img && img !== groundImg && (img.naturalWidth || img.width)) {
      groundImg = img;
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
    if (scenery) scenery.update(scroll);

    // 怪獣：地形が流れている間は歩く
    if (lastScroll === null) lastScroll = scroll;
    const speed = Math.abs(scroll - lastScroll) / Math.max(dt, 1e-3);
    lastScroll = scroll;
    walkAmp = smooth(walkAmp, speed > 0.05 ? 1 : 0, speed > 0.05 ? 8 : 3, dt);
    walkPhase = scroll * Math.PI * 3;
    const jitter = bridge.kaijuJitter() || { x: 0 };
    const cellPx = geom.cell || 50;
    const attacking = now < (g.kaijuAttackJitterUntil || 0) && (g.kaijuAttackJitterScale == null || g.kaijuAttackJitterScale > 0.5);
    lunge = smooth(lunge, attacking ? 1 : 0, attacking ? 10 : 4, dt);
    animateKaiju(kaiju, t, walkPhase, walkAmp, (jitter.x || 0) / cellPx, lunge);
    const kAlpha = Math.max(0, 1 - clamp01(Number(g.kaijuFadeProgress) || 0));
    kaiju.root.visible = kAlpha > 0.01;
    setOpacity(kaiju.mats, kAlpha);
    kaiju.root.scale.setScalar(bridge.kaijuHeightCells() / 3);
    kaiju.root.updateMatrixWorld(true);
    warnSprite.visible = kAlpha > 0.16 && bridge.kaijuCharging();
    if (warnSprite.visible) {
      kaiju.head.getWorldPosition(tmpHead);
      const pulse = 0.5 + 0.5 * Math.sin(now / 180);
      warnSprite.position.set(tmpHead.x, tmpHead.y + 0.95, tmpHead.z);
      warnSprite.scale.setScalar(0.82 + pulse * 0.1);
    }

    // 機体・ミサイル・目印
    activeRing.visible = false;
    syncAircraft(g, now, dt);
    syncProjectiles(g, now);
    updatePillars(g, now);
    updatePickVisuals(g);

    // カメラ
    const pose = desiredPose(g);
    const rate = 4.5;
    cam.elev = smooth(cam.elev, pose.elev, rate, dt);
    cam.fov = smooth(cam.fov, pose.fov, rate, dt);
    cam.target.x = smooth(cam.target.x, pose.target.x, rate, dt);
    cam.target.y = smooth(cam.target.y, pose.target.y, rate, dt);
    cam.target.z = smooth(cam.target.z, pose.target.z, rate, dt);
    const aspect = W / H;
    cam.dist = fitDistance(cam.elev, cam.target, cam.fov, aspect);
    placeCamera(cam.elev, cam.dist, cam.target, cam.fov, aspect);

    // 戦術パネル（2Dで描いた絵を写す）。何も出ないときは写さない。動きのある表示は毎秒15回（重い端末では8回）、HPバーだけなら毎秒4回
    const level = bridge.tacticalLevel ? bridge.tacticalLevel() : 2;
    tacticalPlane.visible = level > 0;
    if (level > 0 && (level !== lastTacticalLevel || now - lastTacticalDraw > (level >= 2 ? tacticalInterval : 250))) {
      const t0 = performance.now();
      lastTacticalDraw = now;
      const drawn = bridge.drawTactical(TACTICAL_TEX);
      tacticalCtx.clearRect(0, 0, TACTICAL_TEX, TACTICAL_TEX);
      if (typeof drawn === 'number' && drawn > 0) {
        // 2Dのキャンバスの左上に、パネルの大きさ（最大512px）で描いてもらったものをそのまま写す
        tacticalCtx.drawImage(board2d, 0, 0, drawn, drawn, 0, 0, TACTICAL_TEX, TACTICAL_TEX);
      } else {
        const sx = board2d.width / Math.max(1, geom.canvasW), sy = board2d.height / Math.max(1, geom.canvasH);
        tacticalCtx.drawImage(board2d, geom.offsetX * sx, geom.offsetY * sy, geom.size * sx, geom.size * sy, 0, 0, TACTICAL_TEX, TACTICAL_TEX);
      }
      tacticalTex.needsUpdate = true;
      stats.tacticalMs += performance.now() - t0; stats.tacticalDraws++;
    }
    lastTacticalLevel = level;

    const r0 = performance.now();
    renderer.render(scene, camera);
    stats.renderMs += performance.now() - r0;
    stats.frames++;

    // カード演出（2Dのまま、斜めの面に重ねる）
    const e0 = performance.now();
    bridge.drawEffects();
    updateEffectTransform(geom);
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
    if (scenery) { scene.remove(scenery.group); scenery.dispose(); scenery = null; }
    scene.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
      mats.forEach(m => { if (m.map) m.map.dispose(); if (m.emissiveMap) m.emissiveMap.dispose(); m.dispose(); });
    });
    groundTex.dispose(); tacticalTex.dispose(); glowTex.dispose();
    cleanups.forEach(fn => { try { fn(); } catch (e) {} });
    renderer.dispose();
    try { renderer.forceContextLoss(); } catch (e) {}
    board2d.style.transform = '';
    Object.assign(board2d.style, saved2dStyle);
  }

  return {
    stop,
    setCameraMode(mode) { camMode = mode === 'top' ? 'top' : 'oblique'; },
    setQuality(q, lock) { qualityLocked = !!lock; quality = Math.max(0, Math.min(2, q | 0)); if (quality === 0) { renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); tacticalInterval = 66; } applyQuality(); },
    get cameraMode() { return camMode; },
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
      };
    },
    // テスト用：盤面の位置（x, y）が画面のどこに映っているか（host 内の CSS px）
    screenOfCell(bx, by, y) { return toScreen(new THREE.Vector3(bx - 3.5, y == null ? PANEL_Y : y, by - 3.5)); },
    screenOfKaiju() { return toScreen(new THREE.Vector3(0, 1.6, KAIJU_Z)); },
    screenOfEffectPoint(bx, by) { return toScreen(effectPlanePoint(bx, by)); },
    debugProjectiles() { return [...projectiles.values()].map(pr => { const p = pr.model.group.position; const s = toScreen(p); return { pos: [p.x, p.y, p.z].map(v => +v.toFixed(2)), screen: [Math.round(s.x), Math.round(s.y)], visible: pr.model.group.visible, inScene: !!pr.model.group.parent }; }); },
  };
  }
}
