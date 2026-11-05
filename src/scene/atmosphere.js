import * as THREE from 'three';
import { FullscreenQuad, rawPass } from '../engine/fullscreen.js';

// 基于物理的大气，实现参照 Hillaire 2020 论文 “A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique"（sebh/UnrealEngineSkyAtmosphere）：透射率 LUT、
// 多重散射 LUT，以及供海平面观测者使用的天空视图 LUT。所有内容都在 update() 中
// 重建（远低于 1 毫秒）；每帧不运行任何逻辑。
// 距离单位为 km。辐射亮度相对于太阳照度 uSunIllum（见 sky.js）。

const RB = 6360, RT = 6460, OBS_H = 0.01;   // 地面、大气层顶、观测者高度（km）
const TRANS_W = 256, TRANS_H = 64, MS_RES = 32, SKY_W = 192, SKY_H = 108;

// 来自 sebh / Bruneton 2017 的地球默认值（海平面处，每 km）。turbidity 以
// turbidity^2 缩放气溶胶密度：1 = sebh/Bruneton（非常洁净，气溶胶光学厚度 0.005），
// 2 = 清澈海面（默认值，约 0.02），5 = 约 0.13，10 = 重度雾霾（约 0.5）。
// rayleigh 缩放分子密度。
export function atmosphereCoefficients(p) {
  const m = p.turbidity * p.turbidity;
  return {
    rayleigh: [5.802e-3, 13.558e-3, 33.1e-3].map((v) => v * p.rayleigh),
    mieScattering: 3.996e-3 * m,
    mieExtinction: 4.44e-3 * m,
    ozone: [0.65e-3, 1.881e-3, 0.085e-3],
  };
}

// --- 透射率 LUT 积分的 CPU 镜像（用于太阳颜色） ------------------
function altitudeAt(h, mu, t) {
  const q = h * (2 * RB + h) + t * (2 * (RB + h) * mu + t);
  return q / (Math.sqrt(RB * RB + q) + RB);
}

// 从高度 h（km）、沿天顶余弦 mu 到太空的透射率，求积方式与 LUT 相同
export function transmittance(c, h, mu, out = [0, 0, 0]) {
  const r = RB + h;
  const d = Math.max(-r * mu + Math.sqrt(Math.max(r * r * (mu * mu - 1) + RT * RT, 0)), 0);
  const od = [0, 0, 0];
  for (let i = 0; i < 40; i++) {
    const a = Math.max(altitudeAt(h, mu, d * ((i + 0.5) / 40) ** 2), 0);
    const w = (2 * i + 1) * d / 1600;
    const dR = Math.exp(-a / 8) * w, dM = Math.exp(-a / 1.2) * w, dO = Math.max(0, 1 - Math.abs(a - 25) / 15) * w;
    for (let k = 0; k < 3; k++) od[k] += c.rayleigh[k] * dR + c.mieExtinction * dM + c.ozone[k] * dO;
  }
  for (let k = 0; k < 3; k++) out[k] = Math.exp(-od[k]);
  return out;
}
export const OBSERVER_ALTITUDE = OBS_H;

// --- GLSL ---------------------------------------------------------------------------------
// 由各 LUT 渲染阶段与立方体贴图烘焙共享：uniform、介质、LUT 参数化。
export const ATMOSPHERE_GLSL = /* glsl */`
precision highp float;
precision highp sampler2D;
#define PI 3.14159265359
const float RB = ${RB.toFixed(1)}, RT = ${RT.toFixed(1)}, OBS_H = ${OBS_H};
const float H_TOP = ${Math.sqrt(RT * RT - RB * RB).toFixed(4)};  // sqrt(RT^2 - RB^2)
const float MIE_G = 0.8;
const float GROUND_ALBEDO = 0.1;
const vec2 SKY_RES = vec2(${SKY_W}.0, ${SKY_H}.0);
uniform vec3 uRayleigh;     // 海平面处的 Rayleigh 散射（1/km）
uniform vec2 uMie;          // 海平面处的气溶胶散射、消光（1/km）
uniform vec3 uOzone;        // 臭氧层峰值处的臭氧吸收（1/km）
uniform float uSunIllum;    // 大气层外的太阳照度
uniform sampler2D uTransLut;
uniform sampler2D uMsLut;
uniform sampler2D uSkyView;

vec2 toSub(vec2 u, vec2 n) { return u * (n - 1.0) / n + 0.5 / n; }
vec2 fromSub(vec2 u, vec2 n) { return (u - 0.5 / n) * n / (n - 1.0); }

// 从高度 h、天顶余弦 mu 出发的光线行进 t 之后的高度；r 为半径
float altAt(float h, float mu, float t, out float r) {
  float q = h * (2.0 * RB + h) + t * (2.0 * (RB + h) * mu + t);  // 以无相消方式计算 r^2 - RB^2
  r = sqrt(RB * RB + q);
  return q / (r + RB);
}

struct Medium { vec3 ray; float mie; vec3 scat; vec3 ext; };
Medium medium(float h) {
  h = max(h, 0.0);
  float dM = exp(-h / 1.2);
  Medium m;
  m.ray = uRayleigh * exp(-h / 8.0);
  m.mie = uMie.x * dM;
  m.scat = m.ray + m.mie;
  m.ext = m.ray + uMie.y * dM + uOzone * max(0.0, 1.0 - abs(h - 25.0) / 15.0);  // 臭氧：10..40 km 的三角形分布
  return m;
}

float distTop(float r, float mu) { return max(-r * mu + sqrt(max(r * r * (mu * mu - 1.0) + RT * RT, 0.0)), 0.0); }

// Bruneton 的透射率参数化（覆盖打不到地面的光线）
vec2 transUv(float h, float mu) {
  float r = RB + h, rho = sqrt(max(h, 0.0) * (2.0 * RB + h));
  float dMin = RT - r, dMax = rho + H_TOP;
  return vec2((distTop(r, mu) - dMin) / (dMax - dMin), rho / H_TOP);
}
vec3 transmittance(float h, float mu) { return textureLod(uTransLut, transUv(h, mu), 0.0).rgb; }

// 高度 h（半径 r）处行星挡住太阳时为 0
float sunVisible(float h, float r, float muS) { return step(-sqrt(max(h, 0.0) * (2.0 * RB + h)) / r, muS); }

// 天空视图 LUT，仅上半球（观测者位于海平面）：u = sqrt(相对太阳的方位角余弦)，
// v = sqrt(仰角 / 90 度)，因此纹素在地平线附近更密集
vec3 skyView(vec3 d, vec3 sunDir) {
  float v = sqrt(asin(clamp(d.y, 0.0, 1.0)) / (0.5 * PI));
  float cosPhi = dot(d.xz, sunDir.xz) * inversesqrt(max(dot(d.xz, d.xz) * dot(sunDir.xz, sunDir.xz), 1e-12));
  float u = sqrt(clamp(0.5 - 0.5 * cosPhi, 0.0, 1.0));
  return textureLod(uSkyView, toSub(vec2(u, v), SKY_RES), 0.0).rgb;
}
`;

const PASS_IO = /* glsl */`
in vec2 vUv;
out vec4 fragColor;
`;

// 从高度 h、天顶余弦 mu、太阳天顶余弦 muS、view.sun = nu 出发的光线求内散射
// 辐射亮度（单位太阳照度）；n 个样本按二次方间隔分布，每段解析积分（Frostbite
// 2015 的能量守恒步进）。MS_PASS：各向同性相位函数、不含多重散射输入，并额外
// 计入被照亮的地面；fms 返回式 7 的传递积分。
const INTEGRATE = /* glsl */`
float rayleighPhase(float c) { return 0.0596831 * (1.0 + c * c); }
float miePhase(float c) {
  float k = 1.0 + MIE_G * MIE_G - 2.0 * MIE_G * c;
  return (1.0 - MIE_G * MIE_G) / (4.0 * PI * k * sqrt(k));
}
vec3 multiScatter(float h, float muS) {
  vec2 uv = clamp(vec2(muS * 0.5 + 0.5, h / (RT - RB)), 0.0, 1.0);
  return textureLod(uMsLut, toSub(uv, vec2(${MS_RES}.0)), 0.0).rgb;
}
vec3 integrate(float h, float mu, float muS, float nu, int n, out vec3 fms) {
  float r0 = RB + h;
  float gd = r0 * r0 * (mu * mu - 1.0) + RB * RB;
  bool ground = mu < 0.0 && gd >= 0.0;
  float tMax = ground ? max(-r0 * mu - sqrt(gd), 0.0) : distTop(r0, mu);
#ifdef MS_PASS
  float pR = 1.0 / (4.0 * PI), pM = pR;
#else
  float pR = rayleighPhase(nu), pM = miePhase(nu);
#endif
  vec3 L = vec3(0.0), T = vec3(1.0);
  fms = vec3(0.0);
  float k = tMax / float(n * n);
  for (int i = 0; i < n; i++) {
    float fi = float(i);
    float t = k * (fi + 0.5) * (fi + 0.5), dt = k * (2.0 * fi + 1.0);
    float r;
    float ht = altAt(h, mu, t, r);
    float muSt = clamp((r0 * muS + t * nu) / r, -1.0, 1.0);
    Medium m = medium(ht);
    vec3 S = transmittance(ht, muSt) * sunVisible(ht, r, muSt) * (m.ray * pR + m.mie * pM);
#ifndef MS_PASS
    S += m.scat * multiScatter(ht, muSt);
#endif
    vec3 Ts = exp(-m.ext * dt);
    vec3 seg = (1.0 - Ts) / max(m.ext, vec3(1e-7));
    L += T * S * seg;
    fms += T * m.scat * seg;
    T *= Ts;
  }
#ifdef MS_PASS
  if (ground) {
    float muSg = clamp((r0 * muS + tMax * nu) / RB, -1.0, 1.0);
    L += T * transmittance(0.0, muSg) * max(muSg, 0.0) * (GROUND_ALBEDO / PI);
  }
#endif
  return L;
}
`;

const TRANS_FRAG = ATMOSPHERE_GLSL + PASS_IO + /* glsl */`
void main() {
  float rho = H_TOP * vUv.y;
  float r = sqrt(rho * rho + RB * RB), h = rho * rho / (r + RB);
  float dMin = RT - r, d = mix(dMin, rho + H_TOP, vUv.x);
  float mu = d <= 0.0 ? 1.0 : clamp((H_TOP * H_TOP - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  vec3 od = vec3(0.0);
  for (int i = 0; i < 40; i++) {
    float fi = float(i), rr;
    od += medium(altAt(h, mu, d * (fi + 0.5) * (fi + 0.5) / 1600.0, rr)).ext * (2.0 * fi + 1.0);
  }
  fragColor = vec4(exp(-od * (d / 1600.0)), 1.0);
}`;

// 单位照度下的 Psi_ms（Hillaire 式 10）：对 64 个方向平均的二次辐射亮度与传递因子，
// 按几何级数 L2 / (1 - f_ms) 求和
const MS_FRAG = '#define MS_PASS\n' + ATMOSPHERE_GLSL + PASS_IO + INTEGRATE + /* glsl */`
void main() {
  vec2 uv = fromSub(vUv, vec2(${MS_RES}.0));
  float muS = uv.x * 2.0 - 1.0, h = max(uv.y * (RT - RB), OBS_H);
  float sinS = sqrt(max(1.0 - muS * muS, 0.0));
  vec3 L = vec3(0.0), F = vec3(0.0), fms;
  for (int j = 0; j < 8; j++) {
    float mu = 1.0 - 2.0 * (float(j) + 0.5) / 8.0, sinV = sqrt(1.0 - mu * mu);
    for (int i = 0; i < 8; i++) {
      float nu = cos(2.0 * PI * (float(i) + 0.5) / 8.0) * sinV * sinS + mu * muS;
      L += integrate(h, mu, muS, nu, 20, fms);
      F += fms;
    }
  }
  fragColor = vec4((L / 64.0) / (1.0 - F / 64.0), 1.0);
}`;

const SKY_FRAG = ATMOSPHERE_GLSL + PASS_IO + INTEGRATE + /* glsl */`
uniform float uSunMu;
void main() {
  vec2 uv = fromSub(vUv, SKY_RES);
  float cosPhi = 1.0 - 2.0 * uv.x * uv.x, elev = 0.5 * PI * uv.y * uv.y;
  float mu = sin(elev), cosE = cos(elev);
  vec3 v = vec3(cosE * cosPhi, mu, cosE * sqrt(max(1.0 - cosPhi * cosPhi, 0.0)));
  vec3 s = vec3(sqrt(max(1.0 - uSunMu * uSunMu, 0.0)), uSunMu, 0.0);
  vec3 fms;
  fragColor = vec4(integrate(OBS_H, mu, uSunMu, dot(v, s), 32, fms) * uSunIllum, 1.0);
}`;

const lutTarget = (w, h) => new THREE.WebGLRenderTarget(w, h, {
  type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false,
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
});

export class Atmosphere {
  constructor() {
    this.transRT = lutTarget(TRANS_W, TRANS_H);
    this.msRT = lutTarget(MS_RES, MS_RES);
    this.skyRT = lutTarget(SKY_W, SKY_H);
    // 与每个包含 ATMOSPHERE_GLSL 的渲染阶段按引用共享
    this.uniforms = {
      uRayleigh: { value: new THREE.Vector3() },
      uMie: { value: new THREE.Vector2() },
      uOzone: { value: new THREE.Vector3() },
      uSunIllum: { value: 1 },
      uTransLut: { value: this.transRT.texture },
      uMsLut: { value: this.msRT.texture },
      uSkyView: { value: this.skyRT.texture },
    };
    // 每个渲染阶段只拿到自己读取的 LUT，绝不包含自己正在渲染写入的那一个
    const { uTransLut, uMsLut, uSkyView, ...medium } = this.uniforms;
    this.transPass = new FullscreenQuad(rawPass(TRANS_FRAG, medium));
    this.msPass = new FullscreenQuad(rawPass(MS_FRAG, { ...medium, uTransLut }));
    this.skyPass = new FullscreenQuad(rawPass(SKY_FRAG, { ...medium, uTransLut, uMsLut, uSunMu: { value: 0 } }));
  }

  // c: atmosphereCoefficients()；sunMu: 太阳天顶余弦；sunIllum: 大气层顶的照度
  update(renderer, c, sunMu, sunIllum) {
    const u = this.uniforms;
    u.uRayleigh.value.fromArray(c.rayleigh);
    u.uMie.value.set(c.mieScattering, c.mieExtinction);
    u.uOzone.value.fromArray(c.ozone);
    u.uSunIllum.value = sunIllum;
    this.skyPass.material.uniforms.uSunMu.value = sunMu;
    this.transPass.render(renderer, this.transRT);
    this.msPass.render(renderer, this.msRT);
    this.skyPass.render(renderer, this.skyRT);
  }
}
