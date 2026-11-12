#!/usr/bin/env python3
"""N.O.A.H. — 機体（AA）の Meshy モデルを、ゲーム用の軽いモデル（models/aaN-<版>.js）に作り直す（v376〜）。

  python3 noah_aa_convert.py <入力.glb> <名前 AA1〜AA5> <上にする面 +Z|-Z> <版 v376> <出力フォルダ>
  （v376 は 5機とも +Z。AA1 はコクピットが分厚い面＝+Z を上に、と指定があった。必要なもの：Python 3・numpy・Pillow）

 ・Meshy が「立った状態」（機首が +Y、上下の面が ±Z）で出したモデルを寝かせる：
     上にする面（+Z か -Z）を上（+Y）へ、機首を前（-Z）へ向ける（ゲームの機体の向き：機首 -Z・上 +Y）
 ・大きさは前の機体と同じ決まり：全幅 1・全長 0.92 を超えない最大の大きさ、中心を原点に
 ・画像：色 1024px・金属/粗さ 512px・凹凸 512px の WebP（EXT_texture_webp）
 ・頂点：位置 float32、法線 int8、UV uint16（KHR_mesh_quantization）。片面表示（doubleSided:false）
 ・出力：<名前小文字>-<版>.glb（確かめ用）と <名前小文字>-<版>.js（GLB を base64 にして
   window.NOAH3D_MODEL_DATA[名前] に入れるスクリプト。noah3d.js が <script> で読む）
"""
import sys, io, os, json, struct, base64
import numpy as np
from PIL import Image


# --- GLB の読み込み（numpy だけで読む） ---
CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    b = open(path, 'rb').read()
    magic, ver, length = struct.unpack('<4sII', b[:12])
    assert magic == b'glTF'
    off = 12
    j = None; bin_ = b''
    while off < len(b):
        clen, ctype = struct.unpack('<I4s', b[off:off + 8])
        chunk = b[off + 8: off + 8 + clen]
        if ctype == b'JSON':
            j = json.loads(chunk)
        elif ctype == b'BIN\x00':
            bin_ = chunk
        off += 8 + clen
    return j, bin_


def accessor(j, bin_, idx):
    a = j['accessors'][idx]
    bv = j['bufferViews'][a['bufferView']]
    dt = np.dtype(CT[a['componentType']])
    n = NC[a['type']]
    start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride', 0)
    cnt = a['count']
    if stride and stride != dt.itemsize * n:
        raw = np.frombuffer(bin_, dtype=np.uint8, count=stride * (cnt - 1) + dt.itemsize * n, offset=start)
        out = np.empty((cnt, n), dtype=dt)
        for i in range(cnt):
            out[i] = np.frombuffer(raw[i * stride: i * stride + dt.itemsize * n].tobytes(), dtype=dt)
    else:
        out = np.frombuffer(bin_, dtype=dt, count=cnt * n, offset=start).reshape(cnt, n).copy()
    if a.get('normalized'):
        if dt == np.int8: out = np.maximum(out.astype(np.float32) / 127.0, -1)
        elif dt == np.uint8: out = out.astype(np.float32) / 255.0
        elif dt == np.int16: out = np.maximum(out.astype(np.float32) / 32767.0, -1)
        elif dt == np.uint16: out = out.astype(np.float32) / 65535.0
    return out if n > 1 else out[:, 0]


def image_bytes(j, bin_, img_idx):
    im = j['images'][img_idx]
    bv = j['bufferViews'][im['bufferView']]
    s = bv.get('byteOffset', 0)
    return bin_[s: s + bv['byteLength']], im.get('mimeType')


def load_mesh(path):
    j, bin_ = read_glb(path)
    prim = j['meshes'][0]['primitives'][0]
    at = prim['attributes']
    m = {
        'pos': accessor(j, bin_, at['POSITION']).astype(np.float64),
        'nor': accessor(j, bin_, at['NORMAL']).astype(np.float64) if 'NORMAL' in at else None,
        'uv': accessor(j, bin_, at['TEXCOORD_0']).astype(np.float64) if 'TEXCOORD_0' in at else None,
        'idx': accessor(j, bin_, prim['indices']).astype(np.int64),
        'json': j, 'bin': bin_, 'prim': prim,
    }
    # node transform (Meshy exports have none, but check)
    node = j['nodes'][0]
    m['node'] = {k: node[k] for k in ('matrix', 'rotation', 'scale', 'translation') if k in node}
    mat = j['materials'][prim.get('material', 0)]
    m['material'] = mat
    texs = {}
    pbr = mat.get('pbrMetallicRoughness', {})
    def tex_img(ti):
        t = j['textures'][ti]
        src = t.get('source')
        if src is None:
            src = t.get('extensions', {}).get('EXT_texture_webp', {}).get('source')
        return src
    if 'baseColorTexture' in pbr: texs['base'] = tex_img(pbr['baseColorTexture']['index'])
    if 'metallicRoughnessTexture' in pbr: texs['mr'] = tex_img(pbr['metallicRoughnessTexture']['index'])
    if 'normalTexture' in mat: texs['normal'] = tex_img(mat['normalTexture']['index'])
    if 'emissiveTexture' in mat: texs['emissive'] = tex_img(mat['emissiveTexture']['index'])
    m['tex'] = {k: image_bytes(j, bin_, v) for k, v in texs.items()}
    return m

# --- 変換 ---

BASE_PX, MR_PX, NORMAL_PX = 1024, 512, 512
MAX_W, MAX_L = 1.0, 0.92


def rot_matrix(top):
    if top == '+Z':   # (x, y, z) → (x, z, -y)：+Z の面が上、+Y（機首）が -Z
        return np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=np.float64)
    if top == '-Z':   # (x, y, z) → (-x, -z, -y)：-Z の面が上、+Y（機首）が -Z（Y軸まわりに半回転してから寝かせる）
        return np.array([[-1, 0, 0], [0, 0, -1], [0, -1, 0]], dtype=np.float64)
    raise ValueError(top)


def webp(img, quality):
    b = io.BytesIO()
    img.save(b, 'WEBP', quality=quality, method=6)
    return b.getvalue()


def resize_normal_map(img, px):
    a = np.asarray(img.convert('RGB')).astype(np.float32) / 255.0 * 2 - 1
    small = []
    for c in range(3):
        ch = Image.fromarray(a[:, :, c].astype(np.float32), mode='F').resize((px, px), Image.LANCZOS)
        small.append(np.asarray(ch))
    n = np.stack(small, axis=2)
    n /= np.maximum(np.linalg.norm(n, axis=2, keepdims=True), 1e-6)
    out = np.clip((n + 1) * 0.5 * 255 + 0.5, 0, 255).astype(np.uint8)
    return Image.fromarray(out, 'RGB')


def pad4(b):
    return b + b'\x00' * ((4 - len(b) % 4) % 4)


def convert(src, name, top, version, outdir):
    m = load_mesh(src)
    if m['node']:
        raise SystemExit(f'node transform not supported: {m["node"]}')
    R = rot_matrix(top)
    P = m['pos'] @ R.T
    N = m['nor'] @ R.T
    UV = m['uv']
    I = m['idx'].reshape(-1, 3)

    # 同じ頂点（位置・法線・UV が同じ）をまとめる
    key = np.concatenate([np.round(P * 1e6), np.round(N * 1e4), np.round(UV * 1e6)], axis=1).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    order = np.argsort(first)            # 元の順番をなるべく保つ
    remap = np.empty_like(order); remap[order] = np.arange(len(order))
    P, N, UV = P[first[order]], N[first[order]], UV[first[order]]
    I = remap[inv[I]]
    # 面積ゼロの三角形を除く
    ok = (I[:, 0] != I[:, 1]) & (I[:, 1] != I[:, 2]) & (I[:, 2] != I[:, 0])
    I = I[ok]

    mn, mx = P.min(0), P.max(0)
    size = mx - mn
    s = min(MAX_W / size[0], MAX_L / size[2])
    P = (P - (mn + mx) / 2) * s
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)

    # 画像
    base = Image.open(io.BytesIO(m['tex']['base'][0])).convert('RGB').resize((BASE_PX, BASE_PX), Image.LANCZOS)
    mr = Image.open(io.BytesIO(m['tex']['mr'][0])).convert('RGB').resize((MR_PX, MR_PX), Image.LANCZOS)
    nm = resize_normal_map(Image.open(io.BytesIO(m['tex']['normal'][0])), NORMAL_PX)
    imgs = [webp(base, 80), webp(mr, 80), webp(nm, 84)]

    # 頂点データ
    pos_b = P.astype(np.float32).tobytes()
    n8 = np.clip(np.round(N * 127), -127, 127).astype(np.int8)
    nor_b = np.concatenate([n8, np.zeros((len(n8), 1), np.int8)], axis=1).tobytes()   # 1頂点4バイト（byteStride 4）
    uv_b = np.clip(np.round(UV * 65535), 0, 65535).astype(np.uint16).tobytes()
    if len(P) > 65535:
        raise SystemExit('too many vertices for uint16 indices')
    idx_b = I.astype(np.uint16).reshape(-1).tobytes()

    chunks, views = [], []
    off = 0
    def add(b, target=None, stride=None):
        nonlocal off
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(b)}
        if target: v['target'] = target
        if stride: v['byteStride'] = stride
        views.append(v)
        pb = pad4(b); chunks.append(pb); off += len(pb)
        return len(views) - 1
    for b in imgs: add(b)
    bv_pos = add(pos_b, 34962)
    bv_nor = add(nor_b, 34962, 4)
    bv_uv = add(uv_b, 34962)
    bv_idx = add(idx_b, 34963)
    nv = len(P)
    gltf = {
        'asset': {'version': '2.0', 'generator': f'noah_aa_convert.py ({version})'},
        'extensionsUsed': ['EXT_texture_webp', 'KHR_mesh_quantization'],
        'extensionsRequired': ['EXT_texture_webp', 'KHR_mesh_quantization'],
        'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33071, 'wrapT': 33071}],
        'materials': [{'name': name, 'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicRoughnessTexture': {'index': 1}},
                       'doubleSided': False, 'normalTexture': {'index': 2}}],
        'meshes': [{'name': name, 'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 1, 'TEXCOORD_0': 2}, 'indices': 3, 'material': 0, 'mode': 4}]}],
        'nodes': [{'name': name, 'mesh': 0}],
        'scenes': [{'nodes': [0]}], 'scene': 0,
        'images': [{'bufferView': i, 'mimeType': 'image/webp'} for i in range(3)],
        'textures': [{'sampler': 0, 'extensions': {'EXT_texture_webp': {'source': i}}} for i in range(3)],
        'buffers': [{'byteLength': off}],
        'bufferViews': views,
        'accessors': [
            {'bufferView': bv_pos, 'componentType': 5126, 'count': nv, 'type': 'VEC3',
             'min': P.min(0).astype(np.float32).tolist(), 'max': P.max(0).astype(np.float32).tolist()},
            {'bufferView': bv_nor, 'componentType': 5120, 'count': nv, 'type': 'VEC3', 'normalized': True},
            {'bufferView': bv_uv, 'componentType': 5123, 'count': nv, 'type': 'VEC2', 'normalized': True},
            {'bufferView': bv_idx, 'componentType': 5123, 'count': int(I.size), 'type': 'SCALAR'},
        ],
    }
    js = json.dumps(gltf, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((4 - len(js) % 4) % 4)
    binb = b''.join(chunks)
    total = 12 + 8 + len(js) + 8 + len(binb)
    glb = struct.pack('<4sII', b'glTF', 2, total) + struct.pack('<I4s', len(js), b'JSON') + js + struct.pack('<I4s', len(binb), b'BIN\x00') + binb
    os.makedirs(outdir, exist_ok=True)
    stem = f'{name.lower()}-{version}'
    open(os.path.join(outdir, stem + '.glb'), 'wb').write(glb)
    b64 = base64.b64encode(glb).decode('ascii')
    script = (f'/* N.O.A.H. 3D model "{name}" ({version}): GLB (glTF 2.0) as base64, read by noah3d.js */\n'
              f'(window.NOAH3D_MODEL_DATA=window.NOAH3D_MODEL_DATA||{{}})["{name}"]="{b64}";\n')
    open(os.path.join(outdir, stem + '.js'), 'w').write(script)
    print(json.dumps({'name': name, 'top': top, 'verts': nv, 'tris': int(len(I)), 'scale': round(float(s), 5),
                      'size': [round(float(x), 4) for x in (P.max(0) - P.min(0))],
                      'img_bytes': [len(b) for b in imgs], 'glb': len(glb), 'js': len(script)}))


if __name__ == '__main__':
    convert(*sys.argv[1:6])
