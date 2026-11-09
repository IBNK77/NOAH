// N.O.A.H. — オフライン用サービスワーカー（v351〜。怪獣群島 WILD PACT と同じ仕組み）
// index.html と同じ場所に置く。ネットにつながった状態で一度開くと、ゲーム本体・画像・フォント・BGMが
// 端末に保存され、それ以降はホーム画面から機内モードでも起動できる。
//  ・ゲーム本体（index.html）はネット優先。つながるときは毎回最新版を読み込んで保存し、
//    つながらない（または4秒応答がない）ときだけ保存した版を使う。
//  ・3D表示のプログラム noah3d.js（v352〜）もゲーム本体と同じくネット優先（本体と版がずれないように）。
//    v353 で three.js をモジュール版から普通のスクリプト版（vendor/three-r170.min.js）に替えたので、古い方は消す。
//  ・3Dの本番モデル（models/*.js。v354〜）は、ファイル名に版が入っていて中身が変わらないので、一度保存したら
//    確かめ直さない（数MBあるので、毎回の確認で通信しないように）。中身を変えるときはファイル名ごと変える。
//    models/ground-*.js（v355〜）は HTMLビューアー（file://）でだけ使う地面の画像なので、ここでは保存しない。
//  ・画像・CSS・フォント・three.js（vendor/。中身を変えるときはファイル名ごと変える）は保存した版を優先し、
//    裏で新しい版を確かめて入れ替える。タイトル画面の更新チェックが新しい版を見つけたときは、読み込み直す前に取り直す。
//  ・BGMは保存した版を優先する（音声の「〇〇バイト目から」という分割読み込みにも応える）。
//    同じ名前のmp3を差し替えたときは BGM_VERSION を1つ上げる。
//  ・更新チェック用の version.json は保存しない。
const BGM_VERSION = 1;
const PAGE_CACHE = 'noah-page-v1';
const ASSET_CACHE = 'noah-assets-v1';
const BGM_CACHE = `noah-bgm-v${BGM_VERSION}`;
const KEEP = [PAGE_CACHE, ASSET_CACHE, BGM_CACHE];
const SCOPE = new URL('./', self.location).href;
const PAGE_URL = new URL('./index.html', SCOPE).href;
const MANIFEST_URL = new URL('./img/asset-manifest.json', SCOPE).href;
// 最初に必ず保存するもの（数字は進み具合の目安に使う大きさ・バイト）
const CORE_FILES = {
  './visual.css': 11000,
  './font/noah-hud.woff': 72000,
  './img/brand/icon.png': 385000,
  './img/asset-manifest.json': 30000,
  './noah3d.js': 128000,                      // v352 3D表示（v356 で砂ぼこり・泡、v359 でHPの札、v360 で怪獣の重みの直しを足した）
  './vendor/three-r170.min.js': 691000,          // 3D表示（three.js r170。v353〜は普通のスクリプト版。中身を変えるときはファイル名ごと変える）
  './vendor/three-r170-gltfloader.min.js': 47100, // v354 3Dモデル（GLB）の読み込み
  './models/aa1-v358.js': 373845,
  './models/aa2-v358.js': 442789,
  './models/aa3-v358.js': 476373,
  './models/aa4-v358.js': 414629,
  './models/aa5-v358.js': 451573,   // v358 機体を新しいモデルに差し替え
  './models/celevarn-v354.js': 1511679,   // v354 3Dの本番モデル
  // v360：森林の木・海底の岩山（tree-v354.js・rock-v354.js）は使わなくなったので外した（端末に保存した分は、下の activate で消える）
};
const CORE = Object.keys(CORE_FILES).map(p => new URL(p, SCOPE).href);
const CORE_SIZE = new Map(Object.entries(CORE_FILES).map(([p, bytes]) => [new URL(p, SCOPE).href, bytes]));
// 曲の一覧はページから届くものを使う。届かなかったときはこの6曲。
const DEFAULT_BGM = ['bgmN1', 'bgmN2', 'bgmN3', 'bgmN4', 'bgmN5', 'bgmN6'].map(n => new URL(`./audio/${n}.mp3`, SCOPE).href);
// 進み具合の目安に使う大きさ（バイト）。BGMは1曲あたりの目安。
const PAGE_BYTES = 1700000, BGM_BYTES = 4500000;
// 電波が弱くて応答が来ないときは、この時間で保存した版に切り替える（最新版の受信は裏で続ける）。
const PAGE_TIMEOUT = 4000;

const plain = url => url.split(/[?#]/)[0];
const isPage = url => { const p = plain(url); return p === SCOPE || p === PAGE_URL; };
const isBgm = url => { const p = plain(url); return p.startsWith(SCOPE + 'audio/') && /\.(mp3|m4a|ogg|wav)$/i.test(p); };
const isAsset = url => {
  const p = plain(url);
  return p.startsWith(SCOPE) && /\.(css|woff2?|ttf|otf|webp|png|jpe?g|gif|svg|json|m?js)$/i.test(p)
    && !/\/version\.json$/i.test(p) && !/\/sw\.js$/i.test(p);
};
// ネット優先で読むプログラム（vendor/・models/ の外にある .js。sw.js 自身はブラウザが直接確かめるのでここには来ない）
const isAppScript = url => { const p = plain(url); return p.startsWith(SCOPE) && /\.m?js$/i.test(p) && !p.startsWith(SCOPE + 'vendor/') && !p.startsWith(SCOPE + 'models/'); };
// 中身の変わらない3Dモデル（ファイル名に版が入っている）
const isModel = url => { const p = plain(url); return p.startsWith(SCOPE + 'models/') && /\.js$/i.test(p); };
// 更新チェックが「最新を確かめて」と頼んできた読み込み
const wantsFresh = request => request.cache === 'no-cache' || request.cache === 'reload' || request.cache === 'no-store';
const okToStore = response => response && response.status === 200 && response.type === 'basic' && !response.redirected;

async function storeFull(cache, url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (okToStore(response)) await cache.put(plain(url), response);
  return response;
}

let bgmList = DEFAULT_BGM;
async function assetList() {
  const list = new Map(CORE.map(u => [u, CORE_SIZE.get(u) || 0]));
  let manifest = null;
  try {
    const res = await fetch(MANIFEST_URL, { cache: 'no-cache' });
    if (okToStore(res)) {
      await (await caches.open(ASSET_CACHE)).put(MANIFEST_URL, res.clone());
      manifest = await res.json();
    }
  } catch (e) {}
  if (!manifest) {
    try { const stored = await (await caches.open(ASSET_CACHE)).match(MANIFEST_URL); if (stored) manifest = await stored.json(); } catch (e) {}
  }
  Object.values(manifest || {}).forEach(v => {
    if (v && typeof v.path === 'string') list.set(plain(new URL(v.path, SCOPE).href), Number(v.bytes) || 60000);
  });
  return list;
}

// まだ保存していないものを1つずつ保存する（本体→CSS・フォント→画像→BGMの順）
let warming = null;
async function warm() {
  const page = await caches.open(PAGE_CACHE);
  if (!(await page.match(PAGE_URL))) { try { await storeFull(page, PAGE_URL); } catch (e) {} }
  const assets = await caches.open(ASSET_CACHE);
  for (const url of (await assetList()).keys()) {
    if (await assets.match(url)) continue;
    try { await storeFull(assets, url); } catch (e) {}
  }
  const bgm = await caches.open(BGM_CACHE);
  for (const url of bgmList) {
    if (await bgm.match(url)) continue;
    try { await storeFull(bgm, url); } catch (e) {}
  }
}

async function status() {
  const page = await caches.open(PAGE_CACHE), assets = await caches.open(ASSET_CACHE), bgm = await caches.open(BGM_CACHE);
  let total = PAGE_BYTES, have = (await page.match(PAGE_URL)) ? PAGE_BYTES : 0, missing = 0;
  const list = new Map(CORE.map(u => [u, CORE_SIZE.get(u) || 0]));
  try {
    const stored = await assets.match(MANIFEST_URL);
    if (stored) Object.values(await stored.json() || {}).forEach(v => {
      if (v && typeof v.path === 'string') list.set(plain(new URL(v.path, SCOPE).href), Number(v.bytes) || 60000);
    });
    else missing++;
  } catch (e) { missing++; }
  for (const [url, bytes] of list) {
    const size = bytes || 60000;
    total += size;
    if (await assets.match(url)) have += size; else missing++;
  }
  for (const url of bgmList) {
    total += BGM_BYTES;
    if (await bgm.match(url)) have += BGM_BYTES; else missing++;
  }
  return { done: missing === 0, percent: Math.min(100, Math.round(have / total * 100)), warming: !!warming };
}

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil((async () => {
    const page = await caches.open(PAGE_CACHE), assets = await caches.open(ASSET_CACHE);
    // 3Dモデルは中身が変わらないので、保存済みなら取り直さない（数MBあるため）
    await Promise.allSettled([storeFull(page, PAGE_URL), ...CORE.map(async u => {
      if (isModel(u) && await assets.match(u)) return;
      return storeFull(assets, u);
    })]);
  })());
});

const RETIRED = [
  './vendor/three-r170.module.min.js',
  // v358：機体の絵を新しい3Dモデルから撮った aa*-v358.webp に替えたので、前の絵は消す
  './img/aircraft/aa1.webp', './img/aircraft/aa2.webp', './img/aircraft/aa3.webp', './img/aircraft/aa4.webp', './img/aircraft/aa5.webp',
].map(p => new URL(p, SCOPE).href);   // もう使わないファイル
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('noah-') && !KEEP.includes(key)) await caches.delete(key);
    try {
      const assets = await caches.open(ASSET_CACHE);
      for (const url of RETIRED) await assets.delete(url);
      // 使わなくなった版の3Dモデル（いまの CORE_FILES に無い models/ のファイル）を消す
      for (const req of await assets.keys()) if (isModel(req.url) && !CORE.includes(plain(req.url))) await assets.delete(req);
    } catch (e) {}
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type === 'noah:warm') {
    if (Array.isArray(data.bgm) && data.bgm.length) {
      bgmList = [...new Set(data.bgm.map(u => plain(new URL(u, SCOPE).href)).filter(isBgm))];
    }
    if (!warming) warming = warm().catch(() => {}).finally(() => { warming = null; });
    event.waitUntil(warming);
  } else if (data.type === 'noah:status') {
    const port = event.ports && event.ports[0];
    event.waitUntil(status().then(st => { if (port) port.postMessage(st); }, () => { if (port) port.postMessage(null); }));
  }
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(SCOPE)) return;
  if (isPage(request.url)) { page(event); return; }
  if (request.mode === 'navigate') return;          // ほかのページ（SOUNDS.html など）はそのままネットへ
  if (isBgm(request.url)) { media(event); return; }
  if (isAppScript(request.url)) { script(event); return; }
  if (isModel(request.url)) { model(event); return; }
  if (isAsset(request.url)) { asset(event); }
});

function page(event) {
  const request = event.request;
  // 起動のたびに、ブラウザの一時保存（GitHub Pages では最大10分）を通さずサーバーへ確かめる。
  // 変わっていなければ「変更なし」の短い返事で済む。
  const ask = request.mode === 'navigate'
    ? new Request(request.url, { cache: 'no-cache', credentials: 'same-origin', redirect: 'manual' })
    : request;
  const network = fetch(ask).then(response => ({ response, copy: okToStore(response) ? response.clone() : null }));
  event.waitUntil(network.then(async ({ copy }) => {
    if (copy) await (await caches.open(PAGE_CACHE)).put(PAGE_URL, copy);
  }).catch(() => {}));
  // 更新チェックからの「最新を確かめる」問い合わせには保存版で答えない（つながらなければそのまま失敗させる）
  if (request.mode !== 'navigate' && wantsFresh(request)) {
    event.respondWith(network.then(({ response }) => response));
    return;
  }
  event.respondWith((async () => {
    const cached = () => caches.open(PAGE_CACHE).then(cache => cache.match(PAGE_URL, { ignoreVary: true }));
    try {
      const { response } = await Promise.race([
        network,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PAGE_TIMEOUT))
      ]);
      if (response.ok || response.type === 'opaqueredirect') return response;
      return (await cached()) || response;
    } catch (e) {
      const copy = await cached();
      if (copy) return copy;
      return (await network).response;
    }
  })());
}

// noah3d.js：ゲーム本体と同じくネット優先。つながらない（または4秒応答がない）ときだけ保存した版を使う。
function script(event) {
  const request = event.request, key = plain(request.url);
  const network = fetch(new Request(request, { cache: 'no-cache' }))
    .then(response => ({ response, copy: okToStore(response) ? response.clone() : null }));
  event.waitUntil(network.then(async ({ copy }) => {
    if (copy) await (await caches.open(ASSET_CACHE)).put(key, copy);
  }).catch(() => {}));
  event.respondWith((async () => {
    const cached = () => caches.open(ASSET_CACHE).then(cache => cache.match(key, { ignoreVary: true }));
    try {
      const { response } = await Promise.race([
        network,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PAGE_TIMEOUT))
      ]);
      if (response.ok) return response;
      return (await cached()) || response;
    } catch (e) {
      const copy = await cached();
      if (copy) return copy;
      return (await network).response;
    }
  })());
}

// 3Dモデル：保存した版があればそれだけを使う（裏で確かめ直さない）。無ければネットから読んで保存する
function model(event) {
  const request = event.request, key = plain(request.url);
  event.respondWith((async () => {
    const cache = await caches.open(ASSET_CACHE);
    const stored = await cache.match(key, { ignoreVary: true });
    if (stored) return stored;
    const response = await fetch(request);
    if (okToStore(response)) event.waitUntil(cache.put(key, response.clone()).catch(() => {}));
    return response;
  })());
}

function asset(event) {
  const request = event.request, key = plain(request.url);
  event.respondWith((async () => {
    const cache = await caches.open(ASSET_CACHE);
    const load = () => fetch(request).then(response => {
      if (okToStore(response)) return cache.put(key, response.clone()).then(() => response, () => response);
      return response;
    });
    if (wantsFresh(request)) {
      try { return await load(); }
      catch (e) { const stored = await cache.match(key, { ignoreVary: true }); if (stored) return stored; throw e; }
    }
    const stored = await cache.match(key, { ignoreVary: true });
    if (stored) { event.waitUntil(load().catch(() => {})); return stored; }
    return load();
  })());
}

// 音声は「〇〇バイト目から」と分けて読み込まれるので、保存した曲から必要な部分だけを切り出して返す。
function media(event) {
  const request = event.request, url = plain(request.url);
  event.respondWith((async () => {
    const cache = await caches.open(BGM_CACHE);
    const stored = await cache.match(url, { ignoreVary: true });
    if (stored) return partial(request, stored);
    // まだ保存していない曲は、今回はネットから流しつつ、裏で丸ごと保存しておく。
    event.waitUntil(storeFull(cache, url).catch(() => {}));
    return fetch(request);
  })());
}

async function partial(request, response) {
  const range = request.headers.get('range');
  if (!range) return response;
  const blob = await response.blob(), size = blob.size, type = response.headers.get('content-type') || 'audio/mpeg';
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  let start = NaN, end = NaN;
  if (match && match[1] !== '') { start = Number(match[1]); end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1); }
  else if (match && match[2] !== '') { start = Math.max(0, size - Number(match[2])); end = size - 1; }
  if (!(start >= 0 && start <= end && start < size)) {
    return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1, type), {
    status: 206, statusText: 'Partial Content',
    headers: { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' }
  });
}
