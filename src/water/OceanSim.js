import * as THREE from 'three';
import { FullscreenQuad, rawPass } from '../engine/fullscreen.js';

// Tessendorf FFT 海洋：4 个 256² 级联堆叠在一张 256×1024 图集里，因此每个
// IFFT 阶段都只需一次绘制。每个级联的输出（RGBA16F，带 mipmap，repeat）：
//   displacement = (λDx, Dy, λDz, turbulence)   slope = (sx, sz, sx², sz²)
// 斜率在全分辨率下就完成除法归一，因此其 mip 给出均值 + 二阶矩
// （斜率方差 -> 粗糙度，LEAN 风格）。

export const N = 256;
const LOG_N = 8;
// 最后一个级联是重力-毛细波细节层；12/2.1 不是整数，因此平铺块不会对齐
export const CASCADE_LENGTHS = [600, 85, 12, 2.1];
const G = 9.81;
// 表面张力 / 密度（m³/s²）：ω² = g·k + (σ/ρ)·k³
const SIGMA_RHO = 7.4e-5;
// ω 被量化为 2π/LOOP 的整数倍，时间在 LOOP 处回绕，因此模拟可无缝
// 循环，且 fp32 相位永不退化。
const LOOP = 300;

const COMMON = /* glsl */`
precision highp float;
precision highp int;
#define N ${N}
#define PI 3.14159265359
#define G ${G.toFixed(2)}
#define ST ${SIGMA_RHO.toExponential()}
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
float omega(float k) { return sqrt(G * k + ST * k * k * k); }
`;

const INIT_FRAG = COMMON + /* glsl */`
uniform vec4 uSpecA[2]; // 缩放、角度、spreadBlend、涌浪
uniform vec4 uSpecB[2]; // alpha、peakOmega、gamma、shortWavesFade
uniform vec4 uLength;
uniform vec4 uCut;      // c0 上限、c1 上限、c2 上限、-
uniform float uCapFade; // 级联 3 的短波淡出（级联 0-2 使用 uSpecB.w）
uniform uint uSeed;
out vec4 outColor;

uvec2 pcg2d(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u; v.y += v.x * 1664525u;
  v ^= v >> 16u;
  return v;
}

vec2 gauss(ivec2 id, int c) {
  uvec2 h = pcg2d(uvec2(id) + uvec2(uint(c) * 7919u, uint(c) * 104729u) + uSeed);
  float u1 = (float(h.x) + 1.0) / 4294967296.0;
  float u2 = float(h.y) / 4294967296.0;
  float r = sqrt(-2.0 * log(u1));
  return r * vec2(cos(2.0 * PI * u2), sin(2.0 * PI * u2));
}

float jonswap(float w, vec4 a, vec4 b) {
  float wp = b.y;
  float sigma = w <= wp ? 0.07 : 0.09;
  float r = exp(-(w - wp) * (w - wp) / (2.0 * sigma * sigma * wp * wp));
  float iw = 1.0 / w;
  float q = wp * iw;
  return a.x * b.x * G * G * iw * iw * iw * iw * iw * exp(-1.25 * q * q * q * q) * pow(b.z, r);
}

float normalisation(float s) {
  float s2 = s * s, s3 = s2 * s, s4 = s3 * s;
  if (s < 5.0) return -0.000564 * s4 + 0.00776 * s3 - 0.044 * s2 + 0.192 * s + 0.163;
  return -4.80e-08 * s4 + 1.07e-05 * s3 - 9.53e-04 * s2 + 5.90e-02 * s + 3.93e-01;
}

float directional(float theta, float w, vec4 a, vec4 b) {
  float x = w / b.y;
  float s = x > 1.0 ? 9.77 * pow(x, -2.5) : 6.97 * pow(x, 5.0);
  s += 16.0 * tanh(min(x, 20.0)) * a.w * a.w;
  float t = theta - a.y;
  float cosine2s = normalisation(s) * pow(abs(cos(0.5 * t)), 2.0 * s);
  return mix(2.0 / PI * cos(t) * cos(t), cosine2s, a.z);
}

vec2 h0(ivec2 id, int c) {
  float L = uLength[c];
  float dk = 2.0 * PI / L;
  vec2 k = vec2(id - N / 2) * dk;
  float kl = length(k);
  float lo = c == 0 ? 1e-4 : uCut[c - 1];
  float hi = c == 3 ? 1e4 : uCut[c];
  if (kl < lo || kl > hi) return vec2(0.0);
  float w = omega(kl);
  float dwdk = (G + 3.0 * ST * kl * kl) / (2.0 * w);
  float theta = atan(k.y, k.x);
  float S = 0.0;
  for (int i = 0; i < 2; i++) {
    if (uSpecA[i].x <= 0.0) continue;
    float fade = c == 3 ? uCapFade : uSpecB[i].w;
    S += jonswap(w, uSpecA[i], uSpecB[i]) * directional(theta, w, uSpecA[i], uSpecB[i])
       * exp(-fade * fade * kl * kl);
  }
  return gauss(id, c) * sqrt(2.0 * S * dwdk / kl * dk * dk);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int c = p.y / N;
  ivec2 id = ivec2(p.x, p.y - c * N);
  vec2 a = h0(id, c);
  vec2 b = h0((N - id) % N, c);
  outColor = vec4(a, b.x, -b.y); // h0(k), conj(h0(-k))
}`;

const EVOLVE_FRAG = COMMON + /* glsl */`
uniform highp sampler2D uH0;
uniform vec4 uLength;
uniform float uTime;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;

// 两个实场打包为一个复频谱：IFFT(A + iB) = a + ib
vec2 pack2(vec2 a, vec2 b) { return vec2(a.x - b.y, a.y + b.x); }

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int c = p.y / N;
  vec2 k = vec2(ivec2(p.x, p.y - c * N) - N / 2) * (2.0 * PI / uLength[c]);
  float kl = length(k);
  float ik = kl > 1e-6 ? 1.0 / kl : 0.0;
  const float W0 = 2.0 * PI / ${LOOP.toFixed(1)};
  // ω = n·W0；相位在 sin/cos 之前先归约到 [0, 2π)（毛细波级联的 ω 可达约 130）
  float ph = 2.0 * PI * fract(floor(omega(kl) / W0) * (uTime / ${LOOP.toFixed(1)}));
  vec2 e = vec2(cos(ph), sin(ph));
  vec4 h0 = texelFetch(uH0, p, 0);
  vec2 h = cmul(h0.xy, e) + cmul(h0.zw, vec2(e.x, -e.y));
  vec2 ih = vec2(-h.y, h.x);

  vec2 dx = ih * k.x * ik, dz = ih * k.y * ik;
  vec2 dxdx = -h * k.x * k.x * ik, dzdz = -h * k.y * k.y * ik, dxdz = -h * k.x * k.y * ik;
  vec2 dydx = ih * k.x, dydz = ih * k.y;

  out0 = vec4(pack2(dx, dz), pack2(h, dxdz));
  out1 = vec4(pack2(dydx, dydz), pack2(dxdx, dzdz));
}`;

// Stockham 基 2 逆 FFT 阶段（e^{+i}）；已对照朴素 DFT 验证。
const FFT_FRAG = COMMON + /* glsl */`
uniform highp sampler2D uIn0;
uniform highp sampler2D uIn1;
uniform int uSub;      // 子变换长度 2..N
uniform int uVertical;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int i = uVertical == 1 ? p.y % N : p.x;
  int hs = uSub >> 1;
  int e = (i / uSub) * hs + (i & (hs - 1));
  ivec2 pe, po;
  if (uVertical == 1) { int base = p.y - i; pe = ivec2(p.x, base + e); po = ivec2(p.x, base + e + N / 2); }
  else { pe = ivec2(e, p.y); po = ivec2(e + N / 2, p.y); }
  float a = 2.0 * PI * float(i & (uSub - 1)) / float(uSub);
  vec2 tw = vec2(cos(a), sin(a));
  vec4 e0 = texelFetch(uIn0, pe, 0), o0 = texelFetch(uIn0, po, 0);
  vec4 e1 = texelFetch(uIn1, pe, 0), o1 = texelFetch(uIn1, po, 0);
  out0 = vec4(e0.xy + cmul(tw, o0.xy), e0.zw + cmul(tw, o0.zw));
  out1 = vec4(e1.xy + cmul(tw, o1.xy), e1.zw + cmul(tw, o1.zw));
}`;

const ASSEMBLE_FRAG = COMMON + /* glsl */`
uniform highp sampler2D uIn0;
uniform highp sampler2D uIn1;
uniform sampler2D uPrev;
uniform int uCascade;
uniform float uLambda;
uniform float uDt;
uniform float uFoamRecovery;
layout(location = 0) out vec4 outDisp;
layout(location = 1) out vec4 outSlope;

void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  ivec2 p = id + ivec2(0, uCascade * N);
  // 撤销以 k 为中心的频率移位
  float s = ((id.x + id.y) & 1) == 0 ? 1.0 : -1.0;
  vec4 a = texelFetch(uIn0, p, 0) * s; // Dx, Dz, Dy, Dxz
  vec4 b = texelFetch(uIn1, p, 0) * s; // Dyx, Dyz, Dxx, Dzz
  float dxx = uLambda * b.z, dzz = uLambda * b.w, dxz = uLambda * a.w;
  float jac = (1.0 + dxx) * (1.0 + dzz) - dxz * dxz;
  vec2 slope = b.xy / max(vec2(1.0 + dxx, 1.0 + dzz), vec2(0.2));
  float prev = texelFetch(uPrev, id, 0).w;
  // 泡沫随雅可比行列式瞬间下降，并按基于 dt 的速率恢复
  float turb = min(jac, prev + uDt * uFoamRecovery / max(jac, 0.5));
  outDisp = vec4(uLambda * a.x, a.z, uLambda * a.y, turb);
  outSlope = vec4(slope, slope * slope);
}`;

function jonswapParams(windSpeed, fetchKm) {
  const fetch = fetchKm * 1000;
  return {
    alpha: 0.076 * Math.pow((G * fetch) / (windSpeed * windSpeed), -0.22),
    peakOmega: 22 * Math.pow((windSpeed * fetch) / (G * G), -0.33),
  };
}

export const defaultOceanParams = () => ({
  windSpeed: 9,
  windDirection: 20,
  fetchKm: 120,
  spreadBlend: 0.85,
  windSwell: 0.25,
  gamma: 3.3,
  shortWavesFade: 0.04,
  // 仅级联 3（标定旋钮）：0.004 是纯毛细波谱，但其
  // 均方斜率（0.145）对整个海面而言是 Cox-Munk 的 3 倍，会把水面变成
  // 拉丝金属；0.08 让近处的细涟漪保留下来，水面保持光泽
  capillaryFade: 0.08,
  waveScale: 1,
  swellScale: 0.7,
  swellWindSpeed: 7,
  swellDirection: -15,
  swellFetchKm: 900,
  swellSwell: 1,
  choppiness: 0.85,
  foamRecovery: 0.7,
  timeScale: 1,
});

export class OceanSim {
  constructor(renderer, params = defaultOceanParams()) {
    this.renderer = renderer;
    this.params = params;
    this.time = 0;
    this.dirty = true;
    this.parity = 0;

    const fft = {
      type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, generateMipmaps: false,
    };
    const H = N * CASCADE_LENGTHS.length;
    this.h0RT = new THREE.WebGLRenderTarget(N, H, fft);
    // 16 个 IFFT 阶段受带宽限制；fp16 将其减半，其约 1e-3 的相对
    // 误差在最大级联上约相当于一毫米的位移
    const half = { ...fft, type: THREE.HalfFloatType, count: 2 };
    this.ping = new THREE.WebGLRenderTarget(N, H, half);
    this.pong = new THREE.WebGLRenderTarget(N, H, half);

    const out = {
      type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: true,
      anisotropy: renderer.capabilities.getMaxAnisotropy(), depthBuffer: false, count: 2,
    };
    this.out = CASCADE_LENGTHS.map(() => [new THREE.WebGLRenderTarget(N, N, out), new THREE.WebGLRenderTarget(N, N, out)]);

    // turbulence 初值为 1（无泡沫）
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 1);
    for (const pair of this.out) for (const rt of pair) { renderer.setRenderTarget(rt); renderer.clear(true, false, false); }
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setRenderTarget(null);

    const lengths = new THREE.Vector4(...CASCADE_LENGTHS);
    this.initMat = rawPass(INIT_FRAG, {
      uSpecA: { value: [new THREE.Vector4(), new THREE.Vector4()] },
      uSpecB: { value: [new THREE.Vector4(), new THREE.Vector4()] },
      uLength: { value: lengths },
      // 级联 c 拥有区间 [cut[c-1], cut[c])；每个 cut 位于下一级联的 6 个基频处
      uCut: { value: new THREE.Vector4(...CASCADE_LENGTHS.slice(1).map((L) => (2 * Math.PI / L) * 6), 0) },
      uCapFade: { value: 0 },
      uSeed: { value: 1337 },
    });
    this.evolveMat = rawPass(EVOLVE_FRAG, {
      uH0: { value: this.h0RT.texture }, uLength: { value: lengths }, uTime: { value: 0 },
    });
    this.fftMat = rawPass(FFT_FRAG, {
      uIn0: { value: null }, uIn1: { value: null }, uSub: { value: 2 }, uVertical: { value: 0 },
    });
    this.assembleMat = rawPass(ASSEMBLE_FRAG, {
      uIn0: { value: null }, uIn1: { value: null }, uPrev: { value: null },
      uCascade: { value: 0 }, uLambda: { value: 1 }, uDt: { value: 0 }, uFoamRecovery: { value: 0.45 },
    });
    this.quad = new FullscreenQuad(this.initMat);

    this.lengths = CASCADE_LENGTHS;
    this.displacement = this.out.map((p) => p[0].textures[0]);
    this.slope = this.out.map((p) => p[0].textures[1]);
  }

  updateSpectrum() {
    const p = this.params, u = this.initMat.uniforms;
    const wind = jonswapParams(p.windSpeed, p.fetchKm);
    const swell = jonswapParams(p.swellWindSpeed, p.swellFetchKm);
    const rad = THREE.MathUtils.degToRad;
    u.uSpecA.value[0].set(p.waveScale, rad(p.windDirection), p.spreadBlend, p.windSwell);
    u.uSpecB.value[0].set(wind.alpha, wind.peakOmega, p.gamma, p.shortWavesFade);
    u.uSpecA.value[1].set(p.swellScale * p.waveScale, rad(p.swellDirection), 1, p.swellSwell);
    u.uSpecB.value[1].set(swell.alpha, swell.peakOmega, p.gamma, p.shortWavesFade);
    u.uCapFade.value = p.capillaryFade;
    this.quad.material = this.initMat;
    this.quad.render(this.renderer, this.h0RT);
    this.dirty = false;
  }

  update(dt, timer) {
    const p = this.params;
    timer?.begin('sim.evolve');
    if (this.dirty) this.updateSpectrum();
    dt *= p.timeScale;
    this.time = (this.time + dt) % LOOP;
    const r = this.renderer, q = this.quad;

    this.evolveMat.uniforms.uTime.value = this.time;
    q.material = this.evolveMat;
    q.render(r, this.ping);

    timer?.begin('sim.fft');
    let src = this.ping, dst = this.pong;
    const fu = this.fftMat.uniforms;
    q.material = this.fftMat;
    for (let dir = 0; dir < 2; dir++) {
      fu.uVertical.value = dir;
      for (let s = 1; s <= LOG_N; s++) {
        fu.uSub.value = 1 << s;
        fu.uIn0.value = src.textures[0];
        fu.uIn1.value = src.textures[1];
        q.render(r, dst);
        [src, dst] = [dst, src];
      }
    }

    timer?.begin('sim.assemble');
    const au = this.assembleMat.uniforms;
    au.uIn0.value = src.textures[0];
    au.uIn1.value = src.textures[1];
    au.uLambda.value = p.choppiness;
    au.uDt.value = dt;
    au.uFoamRecovery.value = p.foamRecovery;
    q.material = this.assembleMat;
    const next = this.parity ^ 1;
    for (let c = 0; c < this.out.length; c++) {
      au.uCascade.value = c;
      au.uPrev.value = this.out[c][this.parity].textures[0];
      q.render(r, this.out[c][next]);
      this.displacement[c] = this.out[c][next].textures[0];
      this.slope[c] = this.out[c][next].textures[1];
    }
    this.parity = next;
  }
}
