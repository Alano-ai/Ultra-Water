import * as THREE from 'three';

// 把（高度、带符号海岸距离、∇sdf.x、∇sdf.z）烘焙进一张浮点纹理。
// sdf > 0 为外海，< 0 为陆地，单位为米。先用精确 EDT（Felzenszwalb），再做轻微模糊，
// 以免梯度在湾内的中轴线上硬翻转。
// 另外还有 `travel`：（tau, dir.x, dir.z, shoal），尺寸/范围映射相同，见 bakeTravel()：
//   tau   s    从海岸线算起的浅水传播时间（> 0 在外海，< 0 在陆地）
//   dir   指向岸边的单位传播方向，-grad(tau)/|grad(tau)|（未定义处为 0）
//   shoal      振幅因子：Green 定律 * 射线管汇聚，钳制到 [0.3, 2.5]
// 海岸波：phase = omega * (tau + t)，局部 k = omega / sqrt(g * clamp(depth, 0.3, 14))。

const INF = 1e20;

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// 每个 texel 到最近的 mask 为真的 texel 的平方距离（单位：texel）
function edt2d(mask, size) {
  const out = new Float64Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = mask[i] ? 0 : INF;
  const f = new Float64Array(size), d = new Float64Array(size), v = new Int32Array(size), z = new Float64Array(size + 1);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) f[y] = out[y * size + x];
    edt1d(f, size, d, v, z);
    for (let y = 0; y < size; y++) out[y * size + x] = d[y];
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) f[x] = out[y * size + x];
    edt1d(f, size, d, v, z);
    for (let x = 0; x < size; x++) out[y * size + x] = d[x];
  }
  return out;
}

// 模块级定义（而非每次调用内联），使被优化的调用方保持稳定的调用目标
const clampi = (x, hi) => (x < 0 ? 0 : x > hi ? hi : x);

// 可分离盒式模糊，边缘钳制，滑动求和
function boxBlur(src, size, r) {
  const tmp = new Float32Array(src.length), dst = new Float32Array(src.length), w = 2 * r + 1, hi = size - 1;
  for (let y = 0; y < size; y++) {
    const o = y * size;
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[o + clampi(i, hi)];
    for (let x = 0; x < size; x++) { tmp[o + x] = s / w; s += src[o + clampi(x + r + 1, hi)] - src[o + clampi(x - r, hi)]; }
  }
  for (let x = 0; x < size; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[clampi(i, hi) * size + x];
    for (let y = 0; y < size; y++) { dst[y * size + x] = s / w; s += tmp[clampi(y + r + 1, hi) * size + x] - tmp[clampi(y - r, hi) * size + x]; }
  }
  return dst;
}

function floatTex(data, size) {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// --- 波浪传播时间场 -------------------------------------------------------------
// tau = 浅水锋面从海岸线到此处所需的秒数：程函方程
// |grad tau| = 1/c，c = sqrt(g * clamp(depth, DMIN, DMAX))，在海岸两侧以无符号方式
// 用快速扫描法求解（一阶 Godunov，4 个顺序的 Gauss-Seidel），并在陆地上取负，
// 使 tau 跨过水线时保持平滑。种子取自双线性高度在相邻 texel 之间穿过 0 的位置，
// 精度达到亚 texel。
// ponytail：一阶迎风，锋面圆化约 1 texel（3.5 m），水线处的 1/sqrt(depth)
// 奇点分辨不足（该处 tau 偏早零点几秒，且大致均匀）；若日后显现，
// 再改用二阶扫描或更细的近岸网格。
// 每趟扫描用一个独立的小函数：V8 会为各自的热循环做 OSR 编译，否则大函数
// 每次进入尚未运行过的循环都会去优化。
const GRAV = 9.81, DMIN = 0.3, DMAX = 14;
const ISLET = 64;              // 小于此值（texel）的陆地块不会播种锋面
const RAY_L = 50, RAY_STEP = 3, RAY_BAND = 300; // 射线管窗口（m）、步进长度（texel）、外海带（m）
const KAPPA_MAX = 1 / 25;      // 锋面曲率钳制，1/m

// 把小岛淹没后的海洋掩码：在小岛上播种会在其周围形成一圈同心圆状
// 波峰；作为（被钳制为浅水、速度慢的）水体，它们反而会折射经过的锋面
function wetMask(sea, size) {
  const n = size * size, wet = sea.slice(), seen = new Uint8Array(n), stack = new Int32Array(n), comp = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (sea[s] || seen[s]) continue;
    let top = 0, cnt = 0;
    stack[top++] = s; seen[s] = 1;
    while (top > 0) {
      const k = stack[--top], i = k % size;
      comp[cnt++] = k;
      if (i > 0 && !sea[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack[top++] = k - 1; }
      if (i < size - 1 && !sea[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack[top++] = k + 1; }
      if (k >= size && !sea[k - size] && !seen[k - size]) { seen[k - size] = 1; stack[top++] = k - size; }
      if (k < n - size && !sea[k + size] && !seen[k + size]) { seen[k + size] = 1; stack[top++] = k + size; }
    }
    if (cnt < ISLET) for (let q = 0; q < cnt; q++) wet[comp[q]] = 1;
  }
  return wet;
}

function speeds(height, c, slow, texel) {
  for (let k = 0; k < c.length; k++) { c[k] = Math.sqrt(GRAV * Math.min(DMAX, Math.max(DMIN, -height[k]))); slow[k] = texel / c[k]; }
}

// T 与 open 外扩一圈 1 texel 的边界（(size+2)^2，索引 k + 2j + size + 3；
// 该处 T = Infinity，open = 2），这样扫描模板无需做边界判断。种子：存在跨越
// 水线的 4 邻居的 texel，用逐轴交点 dx、dy（texel）求出到穿越线的距离：
// d = dx*dy / hypot(dx, dy)。种子固定不变（open = 2）；open = 1 标记待重算的
// 单元，0 表示已收敛的单元。
function seed(T, open, height, wet, slow, size) {
  const W = size + 2;
  open.fill(2);
  for (let j = 0; j < size; j++) open.fill(1, (j + 1) * W + 1, (j + 1) * W + 1 + size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const k = j * size + i, w = wet[k], h = height[k];
    let dx = Infinity, dy = Infinity;
    if (i > 0 && wet[k - 1] !== w) dx = h / (h - height[k - 1]);
    if (i < size - 1 && wet[k + 1] !== w) dx = Math.min(dx, h / (h - height[k + 1]));
    if (j > 0 && wet[k - size] !== w) dy = h / (h - height[k - size]);
    if (j < size - 1 && wet[k + size] !== w) dy = Math.min(dy, h / (h - height[k + size]));
    if (dx === Infinity && dy === Infinity) continue;
    const d = dx === Infinity ? dy : dy === Infinity ? dx : dx * dy / (Math.sqrt(dx * dx + dy * dy) || 1);
    const p = k + 2 * j + W + 1;
    T[p] = d * slow[k]; open[p] = 2;
  }
}

// 按扫描顺序（di, dj）做一趟 Gauss-Seidel。加锁：只重算 open 单元
// （自上次访问后邻居发生了变化）；一旦有变化就重新打开其 4 邻居。
function pass(T, open, slow, size, di, dj) {
  const W = size + 2;
  let changed = 0;
  for (let jj = 0, j = dj > 0 ? 0 : size - 1; jj < size; jj++, j += dj) {
    for (let ii = 0, i = di > 0 ? 0 : size - 1; ii < size; ii++, i += di) {
      const k = j * size + i, p = k + 2 * j + W + 1;
      if (open[p] !== 1) continue;
      open[p] = 0;
      const l = T[p - 1], r = T[p + 1], u = T[p - W], v = T[p + W];
      const a = l < r ? l : r, b = u < v ? u : v, f = slow[k], d = a > b ? a - b : b - a;
      // Infinity - Infinity = NaN 会让下面两个判断都不成立，因此未到达的单元保持原值
      const t = d >= f ? (a < b ? a : b) + f : 0.5 * (a + b + Math.sqrt(2 * f * f - d * d));
      if (t < T[p] - 1e-4) {
        T[p] = t; changed++;
        if (open[p - 1] === 0) open[p - 1] = 1;
        if (open[p + 1] === 0) open[p + 1] = 1;
        if (open[p - W] === 0) open[p - W] = 1;
        if (open[p + W] === 0) open[p + W] = 1;
      }
    }
  }
  return changed;
}

const sweep = (T, open, slow, size) =>
  pass(T, open, slow, size, 1, 1) + pass(T, open, slow, size, -1, 1) + pass(T, open, slow, size, 1, -1) + pass(T, open, slow, size, -1, -1);

function signedTau(T, wet, size) {
  const tau = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const k = j * size + i, t = T[k + 2 * j + size + 3];
    tau[k] = t === Infinity ? 0 : wet[k] ? t : -t;
  }
  return tau;
}

// dir = -grad tau / |grad tau|；相干度 |grad tau|*c 在干净锋面上 ~ 1，在激波处
// 塌陷（两段海岸来的锋面在此相遇，模糊把 V 形抹平）
function frontDir(tau, c, dirX, dirZ, coh, size, texel) {
  for (let j = 0; j < size; j++) {
    const jm = j > 0 ? -size : 0, jp = j < size - 1 ? size : 0;
    for (let i = 0; i < size; i++) {
      const k = j * size + i, im = i > 0 ? -1 : 0, ip = i < size - 1 ? 1 : 0;
      const gx = tau[k + ip] - tau[k + im], gz = tau[k + jp] - tau[k + jm];
      const g = Math.sqrt(gx * gx + gz * gz);
      if (g > 1e-9) { dirX[k] = -gx / g; dirZ[k] = -gz / g; }
      const q = Math.min(1, Math.max(0, (g / (2 * texel) * c[k] - 0.7) / 0.25));
      coh[k] = q * q * (3 - 2 * q);
    }
  }
}

// 锋面曲率 kappa = div(grad tau / |grad tau|) = -div(dir)，单位 1/m（岬角外 > 0），
// 做钳制并在激波处置零，使射线管项保持平滑
function curvature(dirX, dirZ, coh, size, texel) {
  const kappa = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const jm = j > 0 ? -size : 0, jp = j < size - 1 ? size : 0;
    for (let i = 0; i < size; i++) {
      const k = j * size + i, im = i > 0 ? -1 : 0, ip = i < size - 1 ? 1 : 0;
      const kp = -(dirX[k + ip] - dirX[k + im] + dirZ[k + jp] - dirZ[k + jm]) / (2 * texel);
      kappa[k] = Math.min(KAPPA_MAX, Math.max(-KAPPA_MAX, kp)) * coh[k];
    }
  }
  return kappa;
}

// 射线管：G = int kappa e^(-s/L) ds，沿射线（-dir）向海侧步进，振幅
// ~ 管宽^-1/2 = exp(G/2)；笔直海岸为 1，岬角 > 1，海湾 < 1。超出 RAY_BAND
// 的外海侧淡出。G 是平滑的，所以每隔一个 texel 步进一次
// （h x h 网格，h = size >> 1，粗网格 (I, J) 对应细网格 (2I, 2J)），在 pack() 中上采样；
// 也从略偏内陆处起算，以免上采样在水线处把它淡掉。
function rayTube(kappa, dirX, dirZ, sdf, size, texel) {
  const h = size >> 1, G = new Float32Array(h * h);
  const ds = RAY_STEP * texel, steps = Math.ceil(2.5 * RAY_L / ds);
  const wts = new Float32Array(steps);
  for (let s = 0; s < steps; s++) wts[s] = Math.exp(-s * ds / RAY_L) * ds;
  for (let J = 0; J < h; J++) for (let I = 0; I < h; I++) {
    const i = 2 * I, j = 2 * J, k = j * size + i, band = Math.min(1, Math.max(0, (RAY_BAND - sdf[k]) / 80));
    if (sdf[k] < -3 * texel || band === 0) continue;
    let x = i, y = j, g = 0;
    for (let s = 0; s < steps; s++) {
      const ii = Math.min(size - 2, x | 0), jj = Math.min(size - 2, y | 0), m = jj * size + ii;
      const fx = x - ii, fy = y - jj;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      g += wts[s] * (kappa[m] * w00 + kappa[m + 1] * w10 + kappa[m + size] * w01 + kappa[m + size + 1] * w11);
      x -= RAY_STEP * (dirX[m] * w00 + dirX[m + 1] * w10 + dirX[m + size] * w01 + dirX[m + size + 1] * w11);
      y -= RAY_STEP * (dirZ[m] * w00 + dirZ[m + 1] * w10 + dirZ[m + size] * w01 + dirZ[m + size + 1] * w11);
      if (x < 0 || y < 0 || x > size - 1 || y > size - 1) break;
    }
    G[J * h + I] = g * band;
  }
  return G;
}

// (tau, dir.x, dir.z, shoal)；shoal = Green 定律 (depth/DMAX)^-1/4，水深钳制与
// shoreWaves() 相同，乘以射线管因子 exp(G/2)（G 由 h x h 双线性插值），
// 再乘以（模糊后的）锋面相干度：激波处方向会汇聚，Gerstner 波峰
// 会叠成竖直的片状，因此该处的波淡出
function pack(tau, dirX, dirZ, G, height, fade, size) {
  const h = size >> 1, data = new Float32Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    const y = Math.min(h - 1, j * 0.5), J = Math.min(h - 2, y | 0), fy = y - J;
    for (let i = 0; i < size; i++) {
      const x = Math.min(h - 1, i * 0.5), I = Math.min(h - 2, x | 0), fx = x - I, m = J * h + I;
      const g = (G[m] * (1 - fx) + G[m + 1] * fx) * (1 - fy) + (G[m + h] * (1 - fx) + G[m + h + 1] * fx) * fy;
      const k = j * size + i;
      const green = 1 / Math.sqrt(Math.sqrt(Math.min(1, Math.max(0.04, Math.max(-height[k], 0.6) / DMAX))));
      data[k * 4] = tau[k];
      data[k * 4 + 1] = dirX[k];
      data[k * 4 + 2] = dirZ[k];
      data[k * 4 + 3] = Math.min(2.5, Math.max(0.3, g === 0 ? green : green * Math.exp(0.5 * g))) * fade[k];
    }
  }
  return data;
}

function bakeTravel(height, sea, sdf, size, texel) {
  const n = size * size, wet = wetMask(sea, size);
  const c = new Float32Array(n), slow = new Float64Array(n);
  speeds(height, c, slow, texel);
  const T = new Float64Array((size + 2) * (size + 2)).fill(Infinity), open = new Uint8Array((size + 2) * (size + 2));
  seed(T, open, height, wet, slow, size);
  for (let it = 0; it < 12 && sweep(T, open, slow, size) > 0; it++);
  const tau = boxBlur(boxBlur(signedTau(T, wet, size), size, 2), size, 2);
  const dirX = new Float32Array(n), dirZ = new Float32Array(n), coh = new Float32Array(n);
  frontDir(tau, c, dirX, dirZ, coh, size, texel);
  const kappa = boxBlur(boxBlur(curvature(dirX, dirZ, coh, size, texel), size, 2), size, 2);
  const fade = boxBlur(boxBlur(coh, size, 2), size, 2);
  const data = pack(tau, dirX, dirZ, rayTube(kappa, dirX, dirZ, sdf, size, texel), height, fade, size);
  return { travel: floatTex(data, size), travelData: data, surf: surfShelter(height, dirX, dirZ, sdf, size, texel) };
}

// --- 拍岸浪遮蔽：碎浪有多少能存活到这里 ------------------------------------------
// 在沙洲或礁石上破碎过的波，只保留其越过的最浅水深约 0.42 倍。
// 沿射线（-dir）向海侧步进，S = 越过一段更深水域后找到的最浅水深
// （波谷后的沙洲、潟湖后的礁脊）；到此处为止单调变浅的爬升不计入，
// 局部水深本身已经封顶。波谷之后遇到陆地表示完全遮蔽（S = 0）。
// 开阔沙滩保持 S = SMAX。开头尚未入水的一段会被跳过，
// 这样沙滩上方的点也能得到上冲流遮蔽。
const SMAX = 6, HYST = 0.3, S_STEP = 1.5, S_DEEP = 12;
function surfShelter(height, dirX, dirZ, sdf, size, texel) {
  const S = new Float32Array(size * size).fill(SMAX), steps = Math.ceil(1500 / (S_STEP * texel));
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const k = j * size + i;
    if (sdf[k] > 400 || sdf[k] < -60) continue;
    let x = i, y = j, wet = false, runMax = -Infinity, s = SMAX;
    for (let n = 0; n < steps; n++) {
      const ii = Math.min(size - 2, x | 0), jj = Math.min(size - 2, y | 0), m = jj * size + ii;
      const fx = x - ii, fy = y - jj;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const d = -(height[m] * w00 + height[m + 1] * w10 + height[m + size] * w01 + height[m + size + 1] * w11);
      if (d > 0) wet = true;
      if (wet) {
        if (d <= 0 && runMax > HYST) { s = 0; break; }
        if (d > S_DEEP) break;
        if (d < runMax - HYST && d < s) s = d;
        if (d > runMax) runMax = d;
      }
      x -= S_STEP * (dirX[m] * w00 + dirX[m + 1] * w10 + dirX[m + size] * w01 + dirX[m + size + 1] * w11);
      y -= S_STEP * (dirZ[m] * w00 + dirZ[m + 1] * w10 + dirZ[m + size] * w01 + dirZ[m + size + 1] * w11);
      if (x < 0 || y < 0 || x > size - 1 || y > size - 1) break;
    }
    S[k] = Math.max(0, s);
  }
  // 模糊：能量会稍微绕射进背风侧，而且闸门不应显出 texel
  const out = boxBlur(boxBlur(S, size, 2), size, 2);
  const tex = new THREE.DataTexture(out, size, size, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// obstacle(x, z)：可选的附加高度（例如一块礁石），叠加到锋面行经的水深之上，
// 使锋面绕它折射、背风侧得到遮蔽。存储的海床高度与海岸线 sdf 都不含它：
// 礁石周围的水保持真实水深（完整尖锐度，不会有碎浪面糊在穹顶上），
// 也不会朝沙滩张开一条无波的空隙
export function bakeShoreMap(heightFn, extent, size = 512, obstacle = null) {
  const texel = extent / size;
  const bed = new Float32Array(size * size), height = new Float32Array(size * size);
  const land = new Uint8Array(size * size), sea = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = ((i + 0.5) / size - 0.5) * extent, z = ((j + 0.5) / size - 0.5) * extent;
    const h = heightFn(x, z);
    const k = j * size + i;
    land[k] = h > 0; sea[k] = h <= 0;
    bed[k] = h;
    height[k] = obstacle ? Math.max(h, obstacle(x, z)) : h;
  }
  const toLand = edt2d(land, size), toSea = edt2d(sea, size);
  let sdf = new Float32Array(size * size);
  for (let k = 0; k < sdf.length; k++) {
    // 半 texel 偏移把零点穿越放在陆地与海洋 texel 之间
    sdf[k] = sea[k] ? (Math.sqrt(toLand[k]) - 0.5) * texel : -(Math.sqrt(toSea[k]) - 0.5) * texel;
  }
  sdf = boxBlur(boxBlur(sdf, size, 2), size, 2);

  const data = new Float32Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const k = j * size + i;
    const s = (x, y) => sdf[Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))];
    data[k * 4] = bed[k];
    data[k * 4 + 1] = sdf[k];
    data[k * 4 + 2] = (s(i + 1, j) - s(i - 1, j)) / (2 * texel);
    data[k * 4 + 3] = (s(i, j + 1) - s(i, j - 1)) / (2 * texel);
  }
  return { texture: floatTex(data, size), extent, data, size, ...bakeTravel(height, sea, sdf, size, texel) };
}
