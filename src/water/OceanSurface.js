import * as THREE from 'three';
import { N } from './OceanSim.js';
import { FLOAT_SHADOW_GLSL } from '../scene/floaterShadow.js';

// 相机中心的极坐标网格。环半径按几何级数增长，使格子保持正方形、
// 屏幕密度基本恒定。位移被限制在局部顶点间距（textureLod）的频带内，
// 正是这一点消除了游动伪影——无需 clipmap 对齐。
const ANGULAR = 384;
const HIGH_CAMERA = 60;  // 米：高于此值使用半密度网格（那里的波浪已是亚像素级）
const INNER = 1;        // 米，随相机高度缩放
const OUTER = 3000;     // 米，之后是一圈平坦裙边
const SKIRT = 60000;

function buildGrid(ANGULAR) {
  const q = 1 + (2 * Math.PI) / ANGULAR;
  const radii = [];
  // 在 INNER 内侧放几圈更粗比例的环，使相机贴着水面时镜头正下方的水面
  // 不会只剩一整片平坦的扇形
  for (let r = INNER / 16; r < INNER * 0.99; r *= 1.12) radii.push(r);
  for (let r = INNER; r < OUTER; r *= q) radii.push(r);
  radii.push(SKIRT);
  const verts = new Float32Array((1 + radii.length * ANGULAR) * 3);
  let v = 3; // 顶点 0 为中心点
  for (const r of radii) {
    for (let a = 0; a < ANGULAR; a++) {
      const t = (a / ANGULAR) * Math.PI * 2;
      verts[v++] = Math.cos(t) * r; verts[v++] = 0; verts[v++] = Math.sin(t) * r;
    }
  }
  const idx = [];
  for (let a = 0; a < ANGULAR; a++) idx.push(0, 1 + ((a + 1) % ANGULAR), 1 + a);
  for (let ring = 0; ring < radii.length - 1; ring++) {
    const i0 = 1 + ring * ANGULAR, i1 = i0 + ANGULAR;
    for (let a = 0; a < ANGULAR; a++) {
      const b = (a + 1) % ANGULAR;
      idx.push(i0 + a, i0 + b, i1 + a, i0 + b, i1 + b, i1 + a);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  return geo;
}

// 海岸贴图、噪声以及逐位置的波浪相位/波群：由下方的碎浪和地形着色器中的
// 海滩上冲流共用，因此两者始终一致。
export const SHORE_GLSL = /* glsl */`
uniform sampler2D uShore;
uniform sampler2D uTravel;   // 波浪自海岸传播的时间（秒）、xz 传播方向、浅化系数
uniform float uShoreExtent;
uniform float uTime;
uniform vec4 uShoreWave;   // 振幅、波长、速度、陡度
uniform vec2 uSwellDir;    // 涌浪的传播方向（xz）

vec4 shoreSample(vec2 xz) {
  vec2 uv = xz / uShoreExtent + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(-60.0, 1e4, 0.0, 0.0);
  return textureLod(uShore, uv, 0.0);
}
// 遮蔽深度 S（米）：碎浪到达此处所越过的最浅沙洲/礁石。水面片元
// 着色器已达 16 个采样器上限，因此 S 改从顶点 varying 读取。
#ifdef SURF_VARYING
in float vSurf;
float surfSample(vec2 xz) { return vSurf; }
#else
uniform sampler2D uSurf;
float surfSample(vec2 xz) {
  vec2 uv = xz / uShoreExtent + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 6.0;
  return textureLod(uSurf, uv, 0.0).r;
}
#endif
vec4 travelSample(vec2 xz) {
  vec2 uv = xz / uShoreExtent + 0.5;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
  return textureLod(uTravel, uv, 0.0);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + 1.0), u.x), u.y);
}

// 沿海岸线的相位偏移、缓慢漂移的波群，以及某一朝向的海岸能接收到
// 多少涌浪
float shoreNoisePhase(vec2 xz) { return vnoise(xz * 0.0042) * 9.0 + vnoise(xz * 0.011 + 7.0) * 2.5; }
float shoreGroup(vec2 xz) { return 0.45 + 0.55 * vnoise(xz * 0.004 + vec2(uTime * 0.021, -uTime * 0.017)); }
float shoreExposure(vec2 dir) { return mix(0.25, 1.0, smoothstep(-0.3, 0.7, dot(dir, uSwellDir))); }
vec2 shoreDir(vec4 sh, vec4 tr) { return dot(tr.yz, tr.yz) > 0.25 ? normalize(tr.yz) : -sh.zw / max(length(sh.zw), 1e-3); }
`;

// 海滩上冲流（地形着色器）：每道到达水线的涌波沿沙滩爬高到高度 R，再退回。
// swashAt() 只负责计时（与 Spray.js 中的礁石溅水共用）；swash() 返回
// （水膜厚度（米）、边缘泡沫 0..1、湿润度 0..1）。
// 定义 SWASH_ROCKS（需先声明 uRockIdx/uRockData）后，岸礁会在其背浪侧
// 遮挡出一块干燥楔形区，使爬高沿其向海面涌起，
// 并对着礁石翻搅出泡沫。
export const SWASH_GLSL = /* glsl */`
// R：爬高（米，0 表示无），s：涌波到达水线后经过的周期比例，
// w：角频率，dir：行进方向（xz）
struct Swash { float R; float s; float w; vec2 dir; };
Swash swashAt(vec2 xz) {
  Swash o = Swash(0.0, 0.0, 1.0, vec2(0.0));
  vec4 sh = shoreSample(xz);
  if (sh.y > 60.0 || uShoreWave.x <= 0.0) return o;
  o.dir = shoreDir(sh, travelSample(xz));
  // 碎浪剩余部分的爬高：潟湖和背浪海滩只会轻轻拍打
  float A = min(uShoreWave.x * shoreExposure(o.dir) * shoreGroup(xz), 0.42 * surfSample(xz) + 0.02);
  o.R = 0.55 * A * smoothstep(0.35, 0.8, length(sh.zw));
  o.w = sqrt(9.81 * 6.2831853 / uShoreWave.y) * uShoreWave.z;
  o.s = fract((o.w * uTime + shoreNoisePhase(xz)) / 6.2831853);
  return o;
}
#ifdef SWASH_ROCKS
// 礁石 k 在 xz 处对上冲流的影响：x = 其背浪侧的遮蔽，y = 距其向海面的接近程度
vec2 rockSwash(vec2 xz, vec2 dir, float k) {
  if (k < 0.0) return vec2(0.0);
  vec4 rk = texelFetch(uRockData, ivec2(int(k), 0), 0);
  vec2 d = xz - rk.xy;
  float r = rk.z, l = length(d);
  float along = dot(d, dir), across = abs(dir.x * d.y - dir.y * d.x);
  // 波前从两侧绕弯，并在其后方几个半径处重新汇合
  float lee = smoothstep(r, 0.45 * r, across + 0.28 * along) * smoothstep(-0.3 * r, 0.4 * r, along);
  float face = smoothstep(-0.25, 0.55, -along / max(l, 1e-3)) * smoothstep(0.6 + 0.2 * r, 0.0, l - r);
  return vec2(lee, face);
}
#endif
vec3 swash(vec2 xz, float hgt) {
  if (hgt < -0.3 || hgt >= 1.74 * uShoreWave.x) return vec3(0.0);
  Swash S = swashAt(xz);
  vec2 rk = vec2(0.0);
#ifdef SWASH_ROCKS
  vec2 ids = textureLod(uRockIdx, xz / uShoreExtent + 0.5, 0.0).rg;
  rk = max(rockSwash(xz, S.dir, ids.x), rockSwash(xz, S.dir, ids.y));
#endif
  float R = S.R * (1.0 - 0.9 * rk.x);
  // 涌波撞上礁石，其动量把它推上岩面（约 u^2/2g），
  // 形成一股在其余回冲到来之前便再次退去的涌升水流
  float up = 1.0 + 1.1 * rk.y;
  if (R < 0.02) return vec3(0.0);
  if (hgt > R * up) return vec3(0.0, 0.0, 0.5 * smoothstep(1.5 * R * up, R * up, hgt));   // 更大的波群才会到达
  float s = S.s;
  float eta = R * (s < 0.3 ? sin(s / 0.3 * 1.5708) : cos((s - 0.3) / 0.7 * 1.5708));
  eta *= mix(up, 1.0, smoothstep(0.25, 0.45, s));
  float th = eta - hgt;
  // 爬高过程中前方充满气泡（尖端后方的一条带）；回冲时只剩稀疏残余，
  // 随排水逐渐变薄，于是水膜融入湿沙，
  // 而不会在整个爬高区留下苍白的薄片
  // （无论多远，前沿都保持几个像素宽，否则会像一条 1 像素的线一样爬行）
  float aa = 0.005 + 5e-5 * distance(xz, cameraPosition.xz);
  float edge = s < 0.35 ? smoothstep(-aa, aa, th) * (1.0 - smoothstep(0.0, 0.06 + aa, th))
                        : 0.3 * smoothstep(0.0, 0.03, th) * (1.0 - smoothstep(0.35, 0.6, s));
  // 水位上涨时堆在礁石旁被翻搅的泡沫，在回冲中被撕碎
  edge = max(edge, rk.y * smoothstep(0.0, 0.02, th) * (1.0 - smoothstep(0.15, 0.55, s)));
  // 自回冲退去、露出这一高度后开始的干燥过程
  float sPass = 0.3 + 0.7 * acos(clamp(hgt / R, 0.0, 1.0)) / 1.5708;
  float dry = (s > sPass ? s - sPass : s + 1.0 - sPass) * 6.2831853 / S.w;
  return vec3(max(th, 0.0), edge, th > 0.0 ? 1.0 : exp(-dry / 5.0));
}
`;

export const WATER_GLSL = /* glsl */`
#define N_TEX ${N.toFixed(1)}
#define PI 3.14159265359
uniform sampler2D uDisp0, uDisp1, uDisp2;           // 毛细波级联只含坡度
uniform sampler2D uSlope0, uSlope1, uSlope2, uSlope3;
uniform vec4 uLength;
uniform vec2 uWaveDamp;    // 长涌浪完全存在的深度、浅水区中的尖锐度强度
uniform vec4 uImpact[8];      // x、z、年龄（秒）、振幅（米）；振幅 0 = 空闲槽位
uniform float uImpactSize[8]; // 溅水半径（米）
${SHORE_GLSL}

// 物体落水产生的涟漪环（Cauchy-Poisson）：由稳相近似，一个点脉冲在
// 半径 r 处给出局部波数 k = g t^2 / (4 r^2) 及相位 k r，因此
// 长波冲在前方，短波拖在内部。半径 L 的溅水激发出
// ~ (kL)^2 exp(-(kL)^2)；kMax 将其频带限制在网格或像素能显示的范围。
// 返回（高度、dh/dx、dh/dz）。
vec3 impactWaves(vec2 xz, float kMax) {
  vec3 o = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    vec4 e = uImpact[i];
    if (e.w <= 0.0) continue;
    vec2 dv = xz - e.xy;
    float r = length(dv) + 1e-3, L = uImpactSize[i];
    float k = 9.81 * e.z * e.z / (4.0 * r * r);
    float kl2 = k * k * L * L;
    float amp = e.w * 2.72 * kl2 * exp(-kl2 - k * k / (kMax * kMax) - 0.12 * e.z) * L / (L + r);
    float ph = k * r;
    o.x += amp * cos(ph);
    o.yz += dv / r * (amp * k * sin(ph));
  }
  return o;
}

// 按水深加权 FFT 级联：浅水区中长涌浪被海岸波浪取代，
// 尖锐波则几乎一直存活到海滩。
vec3 cascadeDamp(float depth) {
  float swell = smoothstep(2.0, uWaveDamp.x, depth);
  float chop = smoothstep(-0.4, 2.0, depth) * mix(uWaveDamp.y, 1.0, smoothstep(0.0, 10.0, depth));
  return vec3(swell, chop, chop);
}

// 在程函旅行时场（shoreMap.js）上行进的碎浪：相位 = w (tau + t)，
// 局部波数为 w / sqrt(g depth)，因此波前在向岸推进时减速、拥挤并绕过
// 水深地形。Gerstner 沿传播方向推挤，Green 定律 + 射线管浅化，
// 破碎极限 A <= 0.42*depth。
// 破碎波峰向前倾出其基底（卷跃浪唇），薄处（浪唇）发光，并在碎浪区
// 后方留下蕾丝状残余（residual）。
// wave0 =（振幅、k、omega、相位）及主波列的破碎程度（0..1），供水花使用
struct Shore { vec3 disp; vec2 slope; float foam; vec4 wave0; float breaking0; vec2 dir; float lip; float residual; };
// cell：采样间隔（米）；只有几个格子长的波列会淡出而非产生锯齿
Shore shoreWaves(vec2 xz, vec4 sh, float cell) {
  Shore o = Shore(vec3(0.0), vec2(0.0), 0.0, vec4(0.0), 0.0, vec2(0.0), 0.0, 0.0);
  float depth = -sh.x, sdf = sh.y;
  float gl = length(sh.zw);
  float env = smoothstep(180.0, 70.0, sdf) * smoothstep(0.35, 0.8, gl) * smoothstep(-0.9, 0.5, depth);
  if (env <= 0.0 || uShoreWave.x <= 0.0) return o;
  vec4 tr = travelSample(xz);
  vec2 dir = shoreDir(sh, tr);
  o.dir = dir;
  // 迎向涌浪的海岸迎来大波群，背浪海岸只有小波群
  env *= shoreExposure(dir);
  float shoal = dot(tr.yz, tr.yz) > 0.25 ? tr.w : pow(clamp(max(depth, 0.6) / 14.0, 0.04, 1.0), -0.25);
  float cel = sqrt(9.81 * clamp(depth, 0.3, 14.0));
  // 耗散记忆：已在沙洲或礁石上破碎过的波浪（遮蔽深度 S）
  // 到达此处时高度至多为 0.42 S；一旦进入远深于 S 的水域，它会
  // 重新形成未破碎的涌浪，而不会在每道内沙洲和浅滩上反复破碎
  float S = surfSample(xz);
  float amax = 0.42 * min(max(depth, 0.0), S) + 0.14 * smoothstep(0.5, 2.0, S) + 0.02;
  float gate = smoothstep(1.4, 1.05, depth / max(S, 0.05));
  float noisePhase = shoreNoisePhase(xz);
  float group = shoreGroup(xz);
  float pinch = 0.85;   // 允许的总水平压缩量（雅可比行列式保持 > 0.15）
  for (int i = 0; i < 2; i++) {
    float lambda = uShoreWave.y * (i == 0 ? 1.0 : 0.61);
    float w = sqrt(9.81 * 2.0 * PI / lambda) * uShoreWave.z;
    float k = w / cel;
    float a = min(uShoreWave.x * (i == 0 ? 1.0 : 0.45) * env * shoal * group, amax * (i == 0 ? 1.0 : 0.5));
    float ph = w * (tr.x + uTime) + noisePhase * (i == 0 ? 1.0 : 1.37) + float(i) * 2.1;
    float c = 0.5 + 0.5 * cos(ph);
    float s = sin(ph);
    const float P = 1.6;           // 波峰更窄、波谷更平
    float cp = pow(max(c, 0.0), P - 1.0);
    float rel = a / max(depth, 0.05);
    // 每道波峰的各段破碎有早有晚（剥落式），每个波浪都换新布局
    float cycle = floor((ph + PI) / (2.0 * PI));
    float early = vnoise(xz * 0.03 + vec2(cycle * 7.3, cycle * 3.1 + float(i) * 31.0));
    // 剩余高度太小，无法使任何东西泛白（潟湖涟漪、礁石背浪侧）
    float energy = smoothstep(0.03, 0.2, a);
    float breaking = smoothstep(0.12 + 0.14 * early, 0.3 + 0.2 * early, rel) * gate * energy;
    // 卷跃只发生在破碎点附近；内侧碎浪区以涌波形式推进
    float pitch = i == 0 ? 2.0 * uShoreWave.w * a * smoothstep(0.16, 0.28, rel) * (1.0 - smoothstep(0.4, 0.6, rel)) * gate : 0.0;
    // 高度场无法悬垂：前倾（波峰正前方最多 1.08 pitch k 的压缩）
    // 与两条波列的 Gerstner 挤压共享同一预算，因此水面
    // 永远不会折叠成玻璃般的鳍状尖角
    pitch = min(pitch, 0.35 / (1.08 * k));
    // 前倾是约 0.1 个波长宽的 c^6 脉冲：在比这更粗的格子上，它只会
    // 把三角形（作为背面被丢弃）折叠成沿波峰闪烁的细条
    pitch *= 1.0 - smoothstep(0.03, 0.1, k * cell / (2.0 * PI));
    pinch -= 1.08 * pitch * k;
    float qak = min(pinch, uShoreWave.w * a * k * 8.0);
    pinch -= qak;
    float c5 = c * c * c * c * c;
    // 相机中心网格随视角移动而滑动：只有一两个格子长的波峰
    // 每帧都会被不同地重采样，水线随之扭曲并闪烁
    float bl = 1.0 - smoothstep(0.1, 0.3, k * cell / (2.0 * PI));
    o.disp.y += bl * a * (2.0 * cp * c - 0.78);
    o.disp.xz += bl * dir * ((qak / k) * s + pitch * c5 * c);
    o.slope += bl * dir * (a * k * P * cp * s / max(1.0 - qak * cos(ph) + 3.0 * pitch * k * c5 * s, 0.2));
    // 白浪：一旦波浪接近破碎，出现在波峰上并拖在波峰后方。已形成的
    // 涌波（rel > 0.4）还会在背面上拖出一长片溢流水膜，
    // 它越过被挤压的波峰，使泡沫带不会被压成细带；环绕小沙洲的
    // 弧形泡沫则保持纤细。
    float psi = mod(ph + PI, 2.0 * PI) - PI;
    // 溢过沙洲和潟湖中的小碎浪短而浅，因此那里一弧度宽的泡沫带
    // 只是一条细带：它们得到更宽、更淡的尾迹（一条被蕾丝泡沫侵蚀的
    // 柔和带，而不是沿每道波峰画出的亮线）。
    float big = smoothstep(0.2, 0.5, a);
    float tail = max(exp(-max(psi, 0.0) * mix(0.45, 1.0, big)), 0.65 * smoothstep(0.3, 0.55, rel) * smoothstep(2.4, 0.3, psi));
    float f = breaking * smoothstep(mix(-0.7, -0.35, big), 0.0, psi) * tail * mix(0.55, 1.0, big);
    o.foam += f;
    if (i == 0) {
      o.wave0 = vec4(a, k, w, ph);
      o.breaking0 = breaking;
      o.lip = breaking * c5 * smoothstep(0.6, -0.2, psi);
      // （蕾丝泡沫比单道波峰存活更久：不随剥落变化，否则会在波浪间跳变）
      o.residual = smoothstep(0.18, 0.4, rel) * (0.3 + 0.45 * exp(-mod(ph, 2.0 * PI) * 0.4)) * gate * energy;
    }
  }
  return o;
}

// 在未位移的 xz 处的完整水面位移；每级联的 lod（0 = 最精细）。
vec3 waterDisplacement(vec2 xz, vec3 lod) {
  vec4 sh = shoreSample(xz);
  vec3 damp = cascadeDamp(-sh.x);
  vec3 d = textureLod(uDisp0, xz / uLength.x, max(lod.x, 0.0)).xyz * damp.x
         + textureLod(uDisp1, xz / uLength.y, max(lod.y, 0.0)).xyz * damp.y
         + textureLod(uDisp2, xz / uLength.z, max(lod.z, 0.0)).xyz * damp.z;
  d += shoreWaves(xz, sh, exp2(lod.x - 1.0) * uLength.x / N_TEX).disp;
  // 涟漪环处于其世界位置；格子尺寸由最精细 lod 反推
  d.y += impactWaves(xz + d.xz, 2.0 * N_TEX / (exp2(lod.z - 1.0) * uLength.z)).x;
  return d;
}

// 世界坐标 xz 处的水面：用不动点迭代反解尖锐的水平位移，
// 再读取该处的高度。返回位移；.y 为高度。
vec3 waterAt(vec2 q, vec3 lod) {
  vec2 p = q;
  vec3 d = vec3(0.0);
  for (int i = 0; i < 4; i++) { d = waterDisplacement(p, lod); p = q - d.xz; }
  return waterDisplacement(p, lod);
}
`;

const VERT = WATER_GLSL + /* glsl */`
uniform float uGridScale;
uniform float uCellStep;
uniform float uWind;
out vec3 vWorld;
out vec2 vXZ;
out float vUnresolved;
out float vSurf;

void main() {
  vec2 local = position.xz;
  float r = length(local);
  float scale = r > ${(OUTER * 2).toFixed(1)} ? 1.0 : uGridScale;
  vec2 xz = cameraPosition.xz + local * scale;
  float cell = max(r, ${INNER.toFixed(1)}) * uCellStep * scale;

  // +1 LOD 偏移：盒式滤波的 mip 仍会稍微泄漏到 Nyquist 频率之外
  vec3 d = waterDisplacement(xz, log2(cell * N_TEX / uLength.xyz) + 1.0);
  // Cox–Munk 均方坡度减去各级联所携带的部分（每级的 1x1 mip 即其
  // 均方坡度）：余下部分为亚纹素粗糙度
  vec4 m0 = textureLod(uSlope0, vec2(0.5), 8.0), m1 = textureLod(uSlope1, vec2(0.5), 8.0);
  vec4 m2 = textureLod(uSlope2, vec2(0.5), 8.0), m3 = textureLod(uSlope3, vec2(0.5), 8.0);
  vUnresolved = max(0.003 + 0.00512 * uWind - (m0.z + m0.w + m1.z + m1.w + m2.z + m2.w + m3.z + m3.w), 0.0);

  vXZ = xz;
  vSurf = surfSample(xz);
  vWorld = vec3(xz.x + d.x, d.y, xz.y + d.z);
  // 水面不能降到海床之下：沙洲上方或刚好在海平面之下的浅滩处的波谷
  // 只会使水变薄。若没有这一点，远处的粗网格会以三角形陷入沙下，
  // 而地形仍将其按水下着色（海平面 0，焦散）。
  // （间隙随距离增大，因为深度缓冲的精度随之下降）
  if (vWorld.y < 0.0) {
    float dc = distance(vWorld.xz, cameraPosition.xz);
    vWorld.y = max(vWorld.y, min(shoreSample(vWorld.xz).x + 0.04 + 2e-7 * dc * dc, 0.0));
  }
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}`;

const FRAG = '#define SURF_VARYING\n' + WATER_GLSL + FLOAT_SHADOW_GLSL + /* glsl */`
precision highp sampler2DShadow;
uniform vec2 uResolution;
uniform vec2 uNearFar;
uniform sampler2D uSceneColor;
uniform sampler2D uSceneDepth;
uniform sampler2D uReflection;
uniform mat4 uReflMatrix;
uniform samplerCube uSkyCube;
uniform float uSkyMaxLod;
uniform sampler2D uFoamTex;
uniform sampler2DShadow uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowBias;  // 深度单位
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAbsorption;
uniform vec3 uScatterColor;
uniform vec3 uFoamTint;     // 薄泡沫：透过气泡显现的水色
uniform vec4 uSSS;          // 峰值强度、视角强度、阴影强度、-
uniform vec4 uFoam;         // 偏移、缩放、岸边泡沫带（米）、亮度
uniform vec4 uRock;         // 拍岸礁石：中心 xz、水线半径（米；0 = 无）、未使用
uniform vec4 uOptics;       // 基础粗糙度、折射强度、反射畸变、雾密度
uniform vec3 uCamForward;
uniform int uDebug;
uniform float uGlint;
uniform float uCamSide;     // -1 相机在水面之上，1 在下方，0 跨越水面
in vec3 vWorld;
in vec2 vXZ;
in float vUnresolved;
out vec4 fragColor;

float linearDepth(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNearFar.x * uNearFar.y / (uNearFar.y + uNearFar.x - z * (uNearFar.y - uNearFar.x));
}

float sunShadow(vec3 p) {
  float s = 1.0;
  vec4 sc = uShadowMatrix * vec4(p, 1.0);
  // 一次硬件 2x2 PCF 采样：纹素约 0.44 米，在运动水面上已足够柔和。水面
  // 不投射任何阴影，因此偏移只需覆盖深度精度。
  if (all(greaterThan(sc.xy, vec2(0.0))) && all(lessThan(sc.xyz, vec3(1.0)))) s = texture(uShadowMap, vec3(sc.xy, sc.z - uShadowBias));
  return min(s, floatShadow(p));
}

// 由一个均匀随机数得到均值为 lam 的泊松计数：反累积分布函数，
// 大均值时用正态（逻辑斯蒂）近似
float poisson(float lam, float u) {
  if (lam > 6.0) return max(0.0, lam + sqrt(lam) * log(u / (1.0 - u)) / 1.702);
  float p = exp(-lam), F = p, n = 0.0;
  for (int k = 0; k < 14; k++) { if (u <= F) break; n += 1.0; p *= lam / n; F += p; }
  return n;
}

vec3 skyLod(vec3 dir, float lod) {
  dir.y = max(dir.y, 0.0);
  return textureLod(uSkyCube, dir, lod).rgb;
}

void main() {
  // 折叠的波峰会翻转三角形；丢弃无法朝向相机所在侧的面
  if (gl_FrontFacing ? uCamSide > 0.5 : uCamSide < -0.5) discard;
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 uv = gl_FragCoord.xy / uResolution;

  // --- 水面：三个级联的坡度 + 坡度方差 -----------------
  vec4 sh = shoreSample(vXZ);
  float depthBelow = -sh.x;
  vec3 damp = cascadeDamp(depthBelow);
  vec4 s0 = texture(uSlope0, vXZ / uLength.x) * damp.x;
  vec4 s1 = texture(uSlope1, vXZ / uLength.y) * damp.y;
  vec4 s2 = texture(uSlope2, vXZ / uLength.z) * damp.z;
  vec4 s3 = texture(uSlope3, vXZ / uLength.w) * damp.z;
  s0.zw *= damp.x; s1.zw *= damp.y; s2.zw *= damp.z; s3.zw *= damp.z;   // 二阶矩按 damp^2 缩放
  // 风成油膜：表面活性剂斑块阻尼短波（毛细波最明显），因此远处
  // 海面分裂成平静与粗糙的条纹，而不是均匀的斑点
  float slick = smoothstep(0.3, 0.7, vnoise(vXZ * 0.006 + uTime * 0.01));
  float sl2 = mix(0.75, 1.0, slick), sl3 = mix(0.4, 1.0, slick);
  s2.xy *= sl2; s2.zw *= sl2 * sl2; s3.xy *= sl3; s3.zw *= sl3 * sl3;
  vec2 fwXZ = fwidth(vXZ);
  Shore shore = shoreWaves(vXZ, sh, max(fwXZ.x, fwXZ.y));
  vec3 imp = impactWaves(vWorld.xz, 2.0 / max(max(fwXZ.x, fwXZ.y), 1e-3));
  vec2 slope = s0.xy + s1.xy + s2.xy + s3.xy + shore.slope + imp.yz;
  vec2 variance = max(s0.zw - s0.xy * s0.xy, 0.0) + max(s1.zw - s1.xy * s1.xy, 0.0)
                + max(s2.zw - s2.xy * s2.xy, 0.0) + max(s3.zw - s3.xy * s3.xy, 0.0);
  vec3 Nrm = normalize(vec3(-slope.x, 1.0, -slope.y));
  // 法线倾角作为屏幕偏移：沿法线投影一小段世界空间步长
  vec3 vp = (viewMatrix * vec4(vWorld, 1.0)).xyz;
  vec3 dv = mat3(viewMatrix) * vec3(Nrm.x, 0.0, Nrm.z);
  vec2 nS = dv.xy - vp.xy / vp.z * dv.z;

  // 几何高光抗锯齿（Kaplanyan）：法线跨像素的变化增加方差
  vec3 dndx = dFdx(Nrm), dndy = dFdy(Nrm);
  float geoVar = min(0.25 * (dot(dndx, dndx) + dot(dndy, dndy)), 0.18);
  float alpha2 = uOptics.x * uOptics.x + vUnresolved * damp.z * damp.z * sl3 * sl3 + variance.x + variance.y + geoVar;
  float alpha = sqrt(alpha2);

  float NoV = max(dot(Nrm, V), 1e-4);
  float NoL = dot(Nrm, uSunDir);
  float shadow = sunShadow(vWorld);

  // --- 泡沫 -------------------------------------------------------------------
  float t0 = texture(uDisp0, vXZ / uLength.x).w, t1 = texture(uDisp1, vXZ / uLength.y).w, t2 = texture(uDisp2, vXZ / uLength.z).w;
  float jac = mix(1.0, t0, damp.x) + mix(1.0, t1, damp.y) + mix(1.0, t2, damp.z) - 2.0;
  float foam = clamp((uFoam.x - jac) * uFoam.y, 0.0, 1.0);

  // --- 自下方观察：斯涅尔窗口 + 全内反射 ---------------
  // （相机到水面的水柱稍后由水下阶段加雾）
  if (!gl_FrontFacing) {
    vec3 Nu = -Nrm;
    float cosI = dot(V, Nu);
    // 斯涅尔窗口之外，全内反射映出深层海水：与水下阶段
    // 对反射方向加雾趋向的颜色相同
    vec3 Rd = reflect(-V, Nu);
    vec3 ambientU = skyLod(vec3(0.0, 1.0, 0.0), uSkyMaxLod);
    vec3 deep = uScatterColor * (ambientU + uSunColor * max(uSunDir.y, 0.0)) * mix(0.55, 1.35, Rd.y * 0.5 + 0.5);
    vec3 colU = deep;
    // 窗口边缘（临界角）被亚像素粗糙度模糊，因此粗糙
    // 斑块在窗口与镜面之间渐变，而非突然切换
    const float COS_CRIT = 0.6614;   // sqrt(1 - 1/1.33^2)
    float edge = max(alpha * 1.5, 0.02);
    float win = smoothstep(COS_CRIT - edge, COS_CRIT + edge, cosI);
    if (win > 0.0) {
      vec3 Tdir = refract(-V, Nu, 1.33);
      if (dot(Tdir, Tdir) == 0.0) Tdir = normalize(-V - Nu * dot(-V, Nu));   // 掠射角，刚越过边缘
      float cosT = max(dot(Tdir, Nrm), 0.0);
      float Fu = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
      // 透过窗口看到的是折射方向的天空（180 度的天空被压进
      // 约 97 度的锥形内）；水面上方任何不透明物体都取自当前帧
      vec2 wuv = uv + nS * 0.04;
      vec3 above = textureLod(uSceneDepth, wuv, 0.0).r > 0.999999
        ? skyLod(Tdir, clamp(log2(alpha * 900.0), 0.0, uSkyMaxLod)) : textureLod(uSceneColor, wuv, 0.0).rgb;
      // 透过窗口的阳光：GGX 透射波瓣，被粗糙度加宽
      float aT = max(alpha * 1.4, 0.03), mu = max(dot(Tdir, uSunDir), 0.0);
      float dT = mu * mu * (aT * aT - 1.0) + 1.0;
      float sunLobe = aT * aT / (PI * dT * dT) * 0.25;
      colU = mix(deep, mix(above + uSunColor * sunLobe * shadow, deep, Fu), win);
    }
    colU *= 1.0 - 0.55 * max(foam, clamp(shore.foam, 0.0, 1.0));
    // alpha 标记该像素所见，供水下阶段使用：0 为底面，2 为顶面
    // （其他内容写入 1，使 MSAA 边缘平均值永远不会看起来像另一面）
    fragColor = vec4(colU, 0.0);
    return;
  }

  // --- 折射 + 吸收 -------------------------------------------------
  float waterDepth = linearDepth(gl_FragCoord.z);
  float sceneDepth = linearDepth(textureLod(uSceneDepth, uv, 0.0).r);
  float viewCos = max(dot(-V, uCamForward), 0.05);
  float thick = max(sceneDepth - waterDepth, 0.0) / viewCos;
  vec2 ruv = uv + nS * uOptics.y * clamp(thick * 0.25, 0.0, 1.0) / max(waterDepth * 0.02, 1.0);
  float rDepth = linearDepth(textureLod(uSceneDepth, ruv, 0.0).r);
  // 偏移落在了水面之前的某物上：平滑地回退到无偏移，
  // 使物体边缘不会出现生硬轮廓
  float keep = smoothstep(waterDepth - 0.3, waterDepth + 0.3, rDepth);
  ruv = mix(uv, ruv, keep);
  thick = mix(thick, max(rDepth - waterDepth, 0.0) / viewCos, keep);
  vec3 refracted = textureLod(uSceneColor, ruv, 0.0).rgb;
  vec3 T = exp(-uAbsorption * thick);

  // 水变薄处的岸边接触泡沫（仅在浅水区：在漂浮道具周围它会成为
  // 白色褶边）。使用垂直厚度，因此不随相机俯仰变化；下方用实心覆盖层封顶
  // 使其保持蕾丝状，且大多出现在涌波到达处（没有拍岸浪的背浪海岸或沙洲
  // 几乎得不到泡沫，而不是一条轮廓线）。
  float shoreFoam = clamp(shore.foam, 0.0, 1.0);
  float vth = thick * V.y;
  // 海床高度图所不知道的礁石（和道具）：水比海床上方水柱
  // （从位移后水面量起）薄得多。上冲流在其周围翻搅出更宽的环，
  // 随波浪对其涨落而呼吸起伏
  if (depthBelow < 6.0) {
    float obst = smoothstep(0.5, 1.5, depthBelow + vWorld.y - vth);
    float act = clamp(shore.residual * 1.5 + shoreFoam + 0.6 * obst, 0.0, 1.0);
    float contact = smoothstep(mix(uFoam.z, 1.0, obst), 0.0, vth) * smoothstep(6.0, 2.0, depthBelow) * mix(0.0, 0.5, act);
    // 打碎成漂移的斑块，使其永远不会沿水线描出一条连续的边
    contact *= smoothstep(0.3, 0.6, vnoise(vXZ * 0.7 + shore.dir * uTime * 0.4) * 0.65 + vnoise(vXZ * 2.3) * 0.35);
    // 并在网格边缘之前消失，否则那里会像一串白色珠子；
    // 远处斑块为亚像素级，只会闪烁
    contact *= smoothstep(0.03, 0.2, vth) * (1.0 - smoothstep(300.0, 600.0, dist));
    foam = max(foam, contact);
  }
  // 拍岸礁石：每道波峰撞上它并留下一圈翻搅的裙边，逐渐消退直到
  // 下一道波峰来临，并拖入背浪侧（上方的深度缓冲接触仅能到达
  // 陡峭岩面约 1 米外）。相位取自主波列，因此随波群一起脉动。
  vec2 rd = vWorld.xz - uRock.xy;
  float rl = length(rd);
  if (rl < uRock.z * 3.0 && uShoreWave.x > 0.0) {
    float lee = max(dot(rd, shore.dir) / max(rl, 1e-3), 0.0);
    float since = mod(shore.wave0.w, 2.0 * PI);            // 自波峰经过以来的弧度数
    float hit = exp(-since * 0.7);
    float reach = uRock.z * (1.15 + (0.3 + 0.9 * lee) * (0.3 + 0.7 * hit));
    float ring = smoothstep(reach, uRock.z * 0.95, rl);
    // 翻搅的斑块漂入背浪侧，从不形成实心环：用撞击的新鲜程度
    // 对噪声取阈值，因此猛烈的撞击是密集的迸发，随老化被撕成蕾丝状
    float n = vnoise(vXZ * 0.55 - shore.dir * uTime * 0.9) * 0.6 + vnoise(vXZ * 1.9 + uTime * 0.35) * 0.4;
    float skirt = ring * smoothstep(0.62 - 0.3 * hit * ring, 0.85 - 0.3 * hit * ring, n);
    foam = max(foam, skirt * mix(0.35, 0.75, hit) * smoothstep(0.0, 0.3, uShoreWave.x));
  }

  // --- 光照 ------------------------------------------------------------------
  vec3 ambient = skyLod(vec3(0.0, 1.0, 0.0), uSkyMaxLod);
  vec3 sun = uSunColor * shadow;
  // 水柱的内散射（太阳 + 天空），随后在波峰上应用 Atlas 风格 SSS
  vec3 inscatter = uScatterColor * (ambient + uSunColor * (0.3 + 0.7 * shadow) * max(uSunDir.y, 0.0));
  // 在明亮的浅沙上方，向上散射回来的光只穿过了很少的水：呈绿松石色
  inscatter *= 1.0 + 1.5 * exp(-0.3 * max(depthBelow, 0.0));
  float h = max(vWorld.y, 0.0);
  float k1 = uSSS.x * h * pow(clamp(dot(uSunDir, -V), 0.0, 1.0), 4.0) * pow(0.5 - 0.5 * NoL, 3.0);
  float k2 = uSSS.y * pow(NoV, 2.0);
  vec3 sss = (k1 + k2) * uScatterColor * sun + uSSS.z * max(NoL, 0.0) * uScatterColor * sun;
  // 薄的破碎浪唇：阳光穿过约一米深的水泛起绿松石色，
  // 迎着太阳看时最强
  sss += shore.lip * sun * exp(-uAbsorption * 2.0) * 0.06 * (0.3 + 2.5 * pow(clamp(dot(uSunDir, -V), 0.0, 1.0), 3.0));
  vec3 body = refracted * T + (inscatter + sss) * (1.0 - T);
  // 碎浪区浊度：涌波下方和后方的搅起泥沙使水体略微浑浊
  // （海床及其焦散变柔和，颜色转为沙绿色），但绝不是白色：
  // 气泡是泡沫层的职责。海滩上方的薄水层会再次澄清。
  float turb = clamp(shore.residual * 0.8 + shoreFoam * 0.6, 0.0, 1.0) * smoothstep(5.0, 1.0, depthBelow) * smoothstep(0.1, 0.8, vth);
  if (turb > 0.0) {
    turb *= 0.6 + 0.4 * vnoise(vXZ * 0.08 - shore.dir * uTime * 0.3);
    float ext = 0.7 * turb;
    vec3 Tt = T * exp(-ext * thick);
    float wm = min(ext / (ext + dot(uAbsorption, vec3(0.333))), 0.4);
    body = refracted * Tt + mix(inscatter + sss, inscatter * vec3(1.2, 1.1, 0.75), wm) * (1.0 - Tt);
  }

  // 使用随粗糙度变化的 F90（Lagarde）的菲涅尔，使粗糙的远处海面不会变白
  const float F0 = 0.02;
  float F90 = max(1.0 - 0.7 * sqrt(alpha), F0);
  float F = F0 + (F90 - F0) * pow(1.0 - NoV, 5.0);

  // --- 反射：天空立方体之上的半分辨率平面反射（地形） -----------------------
  vec3 R = reflect(-V, Nrm);
  R.y = abs(R.y);
  float lod = clamp(log2(alpha * 650.0), 0.0, uSkyMaxLod);
  vec3 refl = skyLod(R, lod);
  // （预乘：目标清除为 0，因此模糊的 mip 淡向天空而非黑色）
  vec4 pc = uReflMatrix * vec4(vWorld.x, 0.0, vWorld.z, 1.0);
  vec2 puv = pc.xy / pc.w + nS * uOptics.z / max(1.0, waterDepth * 0.01);
  vec4 planar = textureLod(uReflection, puv, clamp(log2(alpha * 300.0), 0.0, 6.0));
  refl = refl * (1.0 - planar.a) + planar.rgb;

  // --- 太阳高光：GGX，alpha 设下限使太阳如同小面积光源 ---------
  float aS = max(alpha, 0.015);
  float aS2 = aS * aS;
  vec3 H = normalize(uSunDir + V);
  float NoH = max(dot(Nrm, H), 0.0);
  float nl = max(NoL, 0.0);
  float dd = NoH * NoH * (aS2 - 1.0) + 1.0;
  float D = aS2 / (PI * dd * dd);
  float vis = 0.5 / (nl * sqrt(NoV * NoV * (1.0 - aS2) + aS2) + NoV * sqrt(nl * nl * (1.0 - aS2) + aS2) + 1e-5);
  float Fs = F0 + (1.0 - F0) * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  vec3 spec = sun * (PI * D * vis * Fs * nl);

  // 闪光：将波瓣视为有限数量的亚像素小面。在约一个像素足迹大小的
  // 每个格子里，镜像太阳的期望计数为 lam = 小面密度 * 面积 *
  // D *（太阳立体角 / 4 VoH）；用泊松抽样 / lam 缩放平滑波瓣（均值 1，
  // 能量守恒）。密集格子（靠近波瓣核心、远处）保持平滑，稀疏
  // 格子则碎裂成点；每个格子在抽样之间交叉淡化，从而闪烁。
  if (uGlint > 0.0 && dot(spec, vec3(1.0)) > 0.02) {
    const float FACETS = 2e4;   // 每平方米（校准旋钮）
    float lf = log2(max(max(fwXZ.x, fwXZ.y), 1e-3)) + 1.0;
    float l0 = floor(lf);
    float per = FACETS * D * NoH * 6.8e-5 / (4.0 * max(dot(V, H), 0.05));
    float m = 0.0;
    for (int j = 0; j < 2; j++) {
      float l = l0 + float(j), sz = exp2(l);
      vec2 cell = floor(vXZ / sz);
      float lam = per * sz * sz;
      float tt = uTime * 3.0 + hash12(cell + l * 17.17) * 64.0, it = floor(tt);
      float n0 = poisson(lam, clamp(hash12(cell * 1.31 + it * 3.7), 1e-4, 0.9999));
      float n1 = poisson(lam, clamp(hash12(cell * 1.31 + (it + 1.0) * 3.7), 1e-4, 0.9999));
      m += (j == 0 ? 1.0 - (lf - l0) : lf - l0) * min(mix(n0, n1, smoothstep(0.0, 1.0, tt - it)) / max(lam, 1e-4), 30.0);
    }
    spec *= mix(1.0, m, uGlint * smoothstep(4.0, 30.0, dist) * smoothstep(0.05, 0.3, vth));
  }

  // 薄水层被翻搅并充气，因此只映出暗淡、破碎的天空：在
  // 一掌深的沙子上方，完整的天空反射会把它冲成灰白色
  vec3 col = mix(body, refl, F * mix(0.45, 1.0, smoothstep(0.08, 0.8, vth))) + spec;
  // 水线处的消隐水膜：网格切入沙子的地方没有反射/高光接缝
  // （宽几厘米并覆盖上冲流带，因此边缘融入沙上移动的水膜，
  // 而不是沿静态网格水线画出一条玻璃般的唇线）
  col = mix(refracted, col, smoothstep(0.0, 0.12 + dist * 5e-4, vth));

  // --- 泡沫表面：通过图案阈值随老化被侵蚀，去除高光 ----------
  // 侵蚀：致密泡沫近乎实心，老化的泡沫变薄成蕾丝网络
  // （纹理只在有泡沫处采样；大部分海面没有泡沫）。每个来源
  // 还提供浪涌高度 + 梯度（世界空间）以及用于着色的密度。
  float cover = 0.0, pat = 0.0, fh = 0.5, dens = 0.0;
  vec2 fg = vec2(0.0);
  if (foam > 0.0) {
    vec4 t0 = texture(uFoamTex, vXZ * 0.11);
    pat = t0.r * 0.65 + texture(uFoamTex, vXZ * 0.031 + 0.37).r * 0.35;
    cover = smoothstep(1.05 - foam, 1.3 - foam, pat) * sqrt(foam);
    fh = t0.g; fg = (t0.ba - 0.5) * 64.0 * 0.11; dens = foam;
  }
  if (shoreFoam > 0.0) {
    // 白浪随涌波向岸推进：以相速度移动的世界空间流图，
    // 每半个周期交叉淡化两个相位（这也使其翻搅）。采样在
    // 位移后的水面上进行，因此波峰挤压不会把它压成条纹；若坐标
    // 绑定波前方向，则会在波前弯曲处产生剪切。
    const float FLOW_T = 2.5;   // 秒
    vec2 vel = shore.dir * shore.wave0.z / max(shore.wave0.y, 1e-3);
    float f0 = fract(uTime / FLOW_T), f1 = fract(uTime / FLOW_T + 0.5), wb = abs(2.0 * f0 - 1.0);
    vec4 b0 = texture(uFoamTex, (vWorld.xz - vel * (f0 * FLOW_T)) * 0.15);
    vec4 b1 = texture(uFoamTex, (vWorld.xz - vel * (f1 * FLOW_T)) * 0.15 + 0.43);
    float sh_ = mix(b0.g, b1.g, wb);
    float sPattern = mix(b0.r, b1.r, wb) * 0.3 + sh_ * 0.45 + texture(uFoamTex, vWorld.xz * 0.023 + 0.5).r * 0.25;
    // 蕾丝泡沫只覆盖在新涌波上的一层薄而斑驳的薄纱上（整个内侧
    // 碎浪区均匀的半透明薄片会显得像冰）；在薄水层中它全部碎裂成蕾丝
    float sCover = smoothstep(1.0 - shoreFoam * 1.1, 1.45 - shoreFoam * 1.1, sPattern) * sqrt(shoreFoam);
    sCover = max(sCover, 0.3 * smoothstep(0.45, 0.9, shoreFoam) * smoothstep(0.35, 0.7, sPattern) * smoothstep(0.1, 0.5, vth));
    sCover *= mix(0.55, 1.0, smoothstep(0.05, 0.4, vth));
    if (sCover >= cover) {
      pat = sPattern; fh = sh_; dens = shoreFoam;
      fg = mix(b0.ba, b1.ba, wb) * (64.0 * 0.15) - 32.0 * 0.15;
    }
    cover = max(cover, sCover);
  }
  if (shore.residual > 0.0) {
    // 碎浪区中留下的蕾丝泡沫，向岸漂移（双相位流图）
    float fp = fract(uTime / 8.0);
    vec2 drift = shore.dir * 2.8;
    float r0 = texture(uFoamTex, (vWorld.xz - drift * fp) * 0.06).r;
    float r1 = texture(uFoamTex, (vWorld.xz - drift * fract(fp + 0.5)) * 0.06 + 0.5).r;
    float rp = mix(r0, r1, abs(2.0 * fp - 1.0));
    float rCover = smoothstep(1.2 - shore.residual, 1.35 - shore.residual, rp) * shore.residual;
    if (rCover >= cover) { pat = rp; fh = 0.5; fg = vec2(0.0); dens = shore.residual * 0.5; }
    cover = max(cover, rCover);
  }
  // 水线处的消隐水膜上没有泡沫，其厚度随远处网格
  // 滑动而闪烁；泡沫带随距离变宽，如同上面的水膜淡出
  cover *= smoothstep(0.0, 0.05 + dist * 3e-4, vth);
  if (cover > 0.0) {
    // 浪涌扰动法线（白浪凹凸不平，薄蕾丝平贴）并为其
    // 褶皱着色；薄泡沫是受其下方水体着色的气泡膜，致密泡沫
    // 则是明亮的漫反射白色，气泡顶部带一点光泽
    vec3 fN = normalize(Nrm - vec3(fg.x, 0.0, fg.y) * (0.03 + 0.12 * dens));
    float fl = dot(fN, uSunDir);
    float ao = mix(0.45, 1.0, smoothstep(0.15, 0.75, fh));
    float solid = smoothstep(0.2, 0.9, dens * (0.55 + 0.7 * fh));
    vec3 foamAlbedo = mix(uFoamTint, vec3(0.93, 0.92, 0.88), max(solid, smoothstep(0.3, 0.9, pat) * 0.6));
    vec3 lit = sun * (0.15 + 0.85 * clamp(fl * 0.8 + 0.2, 0.0, 1.0)) * mix(ao, 1.0, 0.4) + ambient * 1.1 * ao;
    // 波峰后方的太阳透过顶部的薄泡沫照射出来
    lit += sun * pow(clamp(dot(uSunDir, -V), 0.0, 1.0), 4.0) * 0.4 * (1.0 - solid);
    vec3 foamCol = uFoam.w * foamAlbedo * lit;
    foamCol += sun * pow(max(dot(fN, H), 0.0), 90.0) * 0.5 * smoothstep(0.55, 0.85, fh) * solid;
    col = mix(col, foamCol, cover * mix(0.8, 1.0, solid));
  }

  // --- 朝地平线天空的大气透视 ---------------------------------------
  float fog = 1.0 - exp(-dist * uOptics.w);
  col = mix(col, skyLod(-V, 3.0), fog);

  if (uDebug == 1) col = Nrm * 0.5 + 0.5;
  else if (uDebug == 2) col = spec;
  else if (uDebug == 3) col = vec3(foam, cover, shoreFoam);
  else if (uDebug == 4) col = vec3(alpha * 5.0, sqrt(geoVar) * 5.0, sqrt(variance.x + variance.y) * 5.0);
  else if (uDebug == 5) col = vec3(F);
  else if (uDebug == 6) col = body;
  else if (uDebug == 7) col = refl;
  fragColor = vec4(col, 2.0);
}`;

export class OceanSurface {
  constructor(sim, shore, sky, floatShadow) {
    this.sim = sim;
    this.uniforms = {
      uDisp0: { value: null }, uDisp1: { value: null }, uDisp2: { value: null },
      uSlope0: { value: null }, uSlope1: { value: null }, uSlope2: { value: null }, uSlope3: { value: null },
      uLength: { value: new THREE.Vector4(...sim.lengths) },
      uWind: { value: 0 },
      uImpact: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
      uImpactSize: { value: new Array(8).fill(1) },
      uShore: { value: shore.texture }, uTravel: { value: shore.travel }, uSurf: { value: shore.surf }, uShoreExtent: { value: shore.extent },
      uTime: { value: 0 },
      uShoreWave: { value: new THREE.Vector4(0.55, 30, 1.0, 1.0) },
      uWaveDamp: { value: new THREE.Vector2(26, 0.55) },
      uSwellDir: { value: new THREE.Vector2(1, 0) },
      uGridScale: { value: 1 },
      uCellStep: { value: (2 * Math.PI) / ANGULAR },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNearFar: { value: new THREE.Vector2(0.5, 80000) },
      uSceneColor: { value: null },
      uSceneDepth: { value: null },
      uReflection: { value: null },
      uReflMatrix: { value: new THREE.Matrix4() },
      uSkyCube: { value: sky.cube },
      uSkyMaxLod: { value: Math.log2(sky.cubeSize) },
      uFoamTex: { value: null },
      uShadowMap: { value: null },
      uShadowMatrix: { value: new THREE.Matrix4() },
      uShadowBias: { value: 1e-5 },
      ...floatShadow,
      uSunDir: { value: sky.sunDir },
      uSunColor: { value: sky.sunColor },
      uAbsorption: { value: new THREE.Vector3(0.40, 0.062, 0.032) },
      uScatterColor: { value: new THREE.Color(0.0, 0.05, 0.08) },
      uFoamTint: { value: new THREE.Color(0.62, 0.78, 0.82) },
      uSSS: { value: new THREE.Vector4(1.6, 0.06, 0.05, 0) },
      uFoam: { value: new THREE.Vector4(0.05, 1.3, 0.2, 0.72) },
      uRock: { value: new THREE.Vector4() },
      uOptics: { value: new THREE.Vector4(0.02, 0.06, 0.04, 1 / 18000) },
      uCamForward: { value: new THREE.Vector3() },
      uDebug: { value: 0 },
      uGlint: { value: 0.6 },
      uCamSide: { value: -1 },
    };
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.DoubleSide,
    });
    this.grids = [buildGrid(ANGULAR), buildGrid(ANGULAR / 2)];
    this.mesh = new THREE.Mesh(this.grids[0], this.material);
    this.mesh.frustumCulled = false;
  }

  update(camera, time) {
    const u = this.uniforms, s = this.sim;
    u.uDisp0.value = s.displacement[0]; u.uDisp1.value = s.displacement[1]; u.uDisp2.value = s.displacement[2];
    u.uSlope0.value = s.slope[0]; u.uSlope1.value = s.slope[1]; u.uSlope2.value = s.slope[2]; u.uSlope3.value = s.slope[3];
    u.uWind.value = s.params.windSpeed;
    u.uTime.value = time;
    const a = THREE.MathUtils.degToRad(s.params.swellDirection);
    u.uSwellDir.value.set(-Math.cos(a), -Math.sin(a));
    u.uGridScale.value = Math.max(1, Math.abs(camera.position.y) / 2);
    // 加入滞后，使悬停在阈值附近时不会来回切换网格
    const coarse = +(Math.abs(camera.position.y) > HIGH_CAMERA * (this.mesh.geometry === this.grids[1] ? 0.85 : 1.15));
    this.mesh.geometry = this.grids[coarse];
    u.uCellStep.value = (2 * Math.PI) / (ANGULAR >> coarse);
    u.uNearFar.value.set(camera.near, camera.far);
    camera.getWorldDirection(u.uCamForward.value);
  }
}
