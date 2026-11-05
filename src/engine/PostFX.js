import * as THREE from 'three';

const LEVELS = 6;
const METER = 32; // 自动曝光的测光目标是 METER x METER

const VERT = /* glsl */`
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const HEAD = /* glsl */`
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
`;

// 13 抽头的双滤波降采样（CoD AW）。启用 PREFILTER 时：逐抽头做钳制 + 软拐点，并做 Karis 加权分组。
const DOWN = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel; // 源纹素尺寸
#ifdef PREFILTER
uniform vec4 uCurve; // 阈值-拐点、2*knee、0.25/knee、阈值
uniform float uClamp;
#endif

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 tap(vec2 o) {
  vec3 c = texture(tSrc, vUv + o * uTexel).rgb;
#ifdef PREFILTER
  c = max(c, 0.0); // 负值（以及多数 GPU 上的 NaN）-> 0
  float l = max(luma(c), 1e-4);
  c *= min(1.0, uClamp / l);
  l = min(l, uClamp);
  float q = clamp(l - uCurve.x, 0.0, uCurve.y);
  c *= max(uCurve.z * q * q, l - uCurve.w) / l;
#endif
  return c;
}

void main() {
  vec3 a = tap(vec2(-2.0, 2.0)), b = tap(vec2(0.0, 2.0)), c = tap(vec2(2.0, 2.0));
  vec3 d = tap(vec2(-2.0, 0.0)), e = tap(vec2(0.0, 0.0)), f = tap(vec2(2.0, 0.0));
  vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0, 1.0)), k = tap(vec2(1.0, 1.0)), l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));
  vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25;
  vec3 g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25;
  vec3 g4 = (j + k + l + m) * 0.25;
#ifdef PREFILTER
  float w0 = 0.125 / (1.0 + luma(g0)), w1 = 0.125 / (1.0 + luma(g1));
  float w2 = 0.125 / (1.0 + luma(g2)), w3 = 0.125 / (1.0 + luma(g3));
  float w4 = 0.5 / (1.0 + luma(g4));
  vec3 r = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
#else
  vec3 r = g4 * 0.5 + (g0 + g1 + g2 + g3) * 0.125;
#endif
  fragColor = vec4(r, 1.0);
}`;

// 9 抽头的帐篷滤波上采样；以加法混合叠加到更细的一级上。
const UP = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uTexel; // 源（更粗的一级）纹素尺寸
void main() {
  vec4 d = uTexel.xyxy * vec4(1.0, 1.0, -1.0, 0.0);
  vec3 s = texture(tSrc, vUv - d.xy).rgb + texture(tSrc, vUv - d.wy).rgb * 2.0 + texture(tSrc, vUv - d.zy).rgb
    + texture(tSrc, vUv + d.zw).rgb * 2.0 + texture(tSrc, vUv).rgb * 4.0 + texture(tSrc, vUv + d.xw).rgb * 2.0
    + texture(tSrc, vUv + d.zy).rgb + texture(tSrc, vUv + d.wy).rgb * 2.0 + texture(tSrc, vUv + d.xy).rgb;
  fragColor = vec4(s * (1.0 / 16.0), 1.0);
}`;

// 自动曝光 1/2：HDR -> METERxMETER 的 log2(亮度)。每个纹素在其覆盖范围内做 4x4 次双线性采样，
// 网格逐帧抖动（由时域滤波平均掉）。在取对数之前把亮度钳制到 [1e-4, 64]，
// 这样太阳圆盘 / 闪光就不会让曝光来回波动；而均值本来就是在 log 空间里求的。
const METER_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uJitter; // [0,1)^2
void main() {
  float s = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 o = (vec2(float(i), float(j)) + uJitter) * 0.25 - 0.5;
    vec3 c = max(texture(tSrc, vUv + o * ${(1 / METER).toFixed(8)}).rgb, 0.0);
    s += log2(clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4, 64.0));
  }
  fragColor = vec4(s * (1.0 / 16.0), 0.0, 0.0, 1.0);
}`;

// 自动曝光 2/2：METERxMETER -> 1x1 均值（16x16 次双线性采样，每次覆盖 2x2 个纹素），
// 然后在 log2 空间做时域自适应，与上一帧的 1x1 状态乒乓交替。r = 自适应后的 log2(平均亮度)。
const ADAPT_FRAG = /* glsl */`
uniform sampler2D tSrc;  // 测光目标，线性过滤
uniform sampler2D tPrev; // 上一帧的 1x1 状态
uniform vec2 uK;         // 场景变亮（x）/ 变暗（y）时的混合系数；1 = 直接贴合
uniform vec2 uRange;     // 允许的 log2 亮度范围（由最小 / 最大曝光得出）
void main() {
  float sum = 0.0;
  for (int j = 0; j < 16; j++) for (int i = 0; i < 16; i++)
    sum += texture(tSrc, (vec2(float(i), float(j)) + 0.5) * (1.0 / 16.0)).r;
  float t = clamp(sum * (1.0 / 256.0), uRange.x, uRange.y);
  float prev = texelFetch(tPrev, ivec2(0), 0).r;
  float k = t > prev ? uK.x : uK.y;
  float s = k >= 1.0 ? t : prev + (t - prev) * k;
  if (isnan(s)) s = t;
  fragColor = vec4(s, 0.0, 0.0, 1.0);
}`;

// 与 three.js 的 AgXToneMapping chunk 数学一致（Filament/Blender AgX，iolite 的对比度近似）。
const COMP = /* glsl */`
uniform sampler2D tHdr;
uniform sampler2D tBloom;
uniform sampler2D tExp;   // 1x1 的自适应 log2 平均亮度
uniform float uExposure;  // 曝光补偿（自动曝光时）或绝对曝光
uniform float uAuto;      // 1 = 自动曝光
uniform vec3 uExpo;       // keyValue、minExposure、maxExposure
uniform float uBloom;
uniform vec2 uLook;       // AgX 观感：幂次（对比度）、饱和度
uniform float uFrame;     // 0..255，抖动种子
uniform float uDroplets;  // 0..1
uniform float uTime;      // 秒，到 4096 后回绕
uniform float uAspect;    // 宽 / 高
uniform float uResY;      // 高度（像素）

const mat3 SRGB_TO_REC2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const mat3 REC2020_TO_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const mat3 AGX_INSET = mat3(
  vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const mat3 AGX_OUTSET = mat3(
  vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
const float AGX_MIN_EV = -12.47393;
const float AGX_MAX_EV = 4.026069;

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 agx(vec3 c) {
  c = AGX_INSET * (SRGB_TO_REC2020 * c);
  c = clamp((log2(max(c, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
  c = agxContrast(c);
  // 在编码域中模拟 AgX 的“punchy”风格观感
  c = pow(max(c, 0.0), vec3(uLook.x));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = l + uLook.y * (c - l);
  c = AGX_OUTSET * c;
  return clamp(REC2020_TO_SRGB * pow(max(c, 0.0), vec3(2.2)), 0.0, 1.0);
}

// Dave Hoskins 的无正弦哈希
vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

// ---- 镜头水珠（仅在 uDroplets > 0 时求值） -----------------------------------------
// 所有长度都以屏幕高度为单位（p = vUv * vec2(aspect, 1)）。每颗水珠都是一枚小透镜：
// 其下方的图像从它中心的镜像一侧采样，sample = centre - (K-1) * d，因此看起来是倒像并略微放大，
// 并带有一圈很淡的暗边。
const float DROP_K = 1.8;

// d：像素 - 水珠中心，r：半径。返回（uv 偏移，变暗量）。
vec3 lensDrop(vec2 d, float r) {
  float dist = length(d);
  float cov = clamp((r - dist) * uResY + 0.5, 0.0, 1.0); // 1px 抗锯齿
  if (cov <= 0.0) return vec3(0.0);
  return vec3(-d * DROP_K * cov, 0.22 * smoothstep(0.6, 1.0, dist / r) * cov);
}

// 每个网格单元最多一颗水珠，且保持在本单元内，因此只需检测自身单元。
vec3 dropLayer(vec2 p, float scale, float density, float seed) {
  vec2 q = p * scale + seed * 17.31;
  vec2 id = floor(q);
  vec3 h = hash33(vec3(id, seed)), g = hash33(vec3(id + 57.0, seed));
  if (h.x > density) return vec3(0.0);
  float fade = clamp((uDroplets - g.x * 0.8) * 6.0, 0.0, 1.0); // 水珠逐个变干（顺序 = g.x）
  float rf = mix(0.10, 0.24, h.y * h.y);                          // 半径，以单元为单位
  vec2 c = rf + vec2(h.z, g.y) * (1.0 - 2.0 * rf);
  return lensDrop((fract(q) - c) / scale, rf * fade / scale);
}

// 一颗沿镜头下滑的水珠，在其上方留下一条细细的湿痕。speed 的单位是周期 / 秒。
// 珠体从屏幕上方进入、从下方离开，此时拖痕已完全移出屏幕，因此循环回绕时不会跳变。
vec3 streak(vec2 p, float id, float speed, float amp) {
  const float R = 0.016, L = 0.45, W = 0.0035;
  float u = uTime * speed + id * 0.37;
  float cyc = mod(floor(u), 128.0), f = fract(u);
  f += 0.012 * sin(f * 47.0); // 黏滑（stick-slip）
  vec3 h = hash33(vec3(id, cyc, 5.1));
  float x0 = (0.08 + 0.84 * h.x) * uAspect;
  float hy = mix(1.0 + R, -R - L, f);
  float hx = x0 + 0.006 * sin(hy * 14.0 + h.y * 6.28);
  vec3 o = lensDrop(p - vec2(hx, hy), R * amp);
  float ty = p.y - hy;
  if (ty > 0.0 && ty < L) {
    float a = smoothstep(0.0, 0.03, ty) * (1.0 - ty / L) * amp;
    float tx = (p.x - x0 - 0.006 * sin(p.y * 14.0 + h.y * 6.28)) / W;
    float cov = clamp((1.0 - abs(tx)) * W * uResY + 0.5, 0.0, 1.0) * a;
    o += vec3(-tx * W * DROP_K * cov, 0.0, 0.12 * smoothstep(0.5, 1.0, abs(tx)) * cov);
  }
  return o;
}

// 返回（uv 偏移，变暗量）。
vec3 droplets() {
  vec2 p = vUv * vec2(uAspect, 1.0);
  float sa = smoothstep(0.0, 0.4, uDroplets);
  vec3 a = dropLayer(p, 6.0, 0.30, 0.0) + dropLayer(p, 10.0, 0.20, 1.0) + dropLayer(p, 17.0, 0.06, 2.0)
    + streak(p, 0.0, 0.0625, sa) + streak(p, 1.0, 0.03125, sa);
  return vec3(a.xy / vec2(uAspect, 1.0), min(a.z, 0.5));
}

void main() {
  float ex = uExposure;
  if (uAuto > 0.5) ex *= clamp(uExpo.x * exp2(-texelFetch(tExp, ivec2(0), 0).r), uExpo.y, uExpo.z);

  vec2 uv = vUv;
  float dark = 0.0;
  if (uDroplets > 0.001) {
    vec3 dr = droplets();
    uv += dr.xy;
    dark = dr.z;
  }

  vec3 c = (texture(tHdr, uv).rgb + texture(tBloom, uv).rgb * uBloom) * (ex * (1.0 - dark));
  vec2 d = (vUv - 0.5) * 1.41421356; // 四角处 |d|^2 = 1
  c = agx(c) * (1.0 - 0.08 * dot(d, d));
  vec3 o = mix(pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));

  // TPDF 抖动，+-1/255，在 sRGB 编码之后、写入 8 位之前
  vec3 n = hash33(vec3(gl_FragCoord.xy, uFrame)) + hash33(vec3(gl_FragCoord.xy, uFrame + 17.0));
  fragColor = vec4(o + (n - 1.0) * (1.0 / 255.0), 1.0);
}`;

const mk = (frag, uniforms, defines = {}, extra = {}) => new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: HEAD + frag,
  uniforms, defines, depthTest: false, depthWrite: false, ...extra,
});

export class PostFX {
  params = {
    // 曝光。autoExposure 为真时：`exposure` 是对测光曝光的乘数（曝光补偿，1 = 中性）。
    // !autoExposure 时：`exposure` 就是绝对曝光，与之前相同。
    exposure: 1.0,
    autoExposure: true,
    // 测光曝光 = keyValue /（场景亮度的对数平均）。0.18 把场景的几何均值放在
    // 中灰处，经这套 AgX 观感映射到约 0.46 sRGB。调参：约 0.12 更压抑 / 更暗，约 0.3 更通透 / 更亮。
    keyValue: 0.18,
    adaptUp: 2.5,    // 场景变亮（曝光下降）时的自适应速率（1/s）；时间常数约 0.4 s
    adaptDown: 1.0,  // 场景变暗（曝光上升）时的速率（1/s）；时间常数约 1 s
    minExposure: 0.05, // 测光曝光的钳制范围（线性乘数，相对 1 约为 -4.3 .. +4.3 EV）
    maxExposure: 20.0,
    bloomStrength: 0.06, bloomThreshold: 1.0, bloomClamp: 64.0, contrast: 1.12, saturation: 1.3,
    droplets: 0.0, // 0..1 的镜头水珠；为 0 时没有额外开销
  };

  constructor(renderer) {
    this.renderer = renderer;

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.mesh = new THREE.Mesh(this.geometry);
    this.mesh.frustumCulled = false;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const src = () => ({ tSrc: { value: null }, uTexel: { value: null } });
    this.matPre = mk(DOWN, { ...src(), uCurve: { value: new THREE.Vector4() }, uClamp: { value: 64 } }, { PREFILTER: 1 });
    this.matDown = mk(DOWN, src());
    this.matUp = mk(UP, src(), {}, {
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    this.matMeter = mk(METER_FRAG, { tSrc: { value: null }, uJitter: { value: new THREE.Vector2() } });
    this.matAdapt = mk(ADAPT_FRAG, {
      tSrc: { value: null }, tPrev: { value: null }, uK: { value: new THREE.Vector2(1, 1) }, uRange: { value: new THREE.Vector2(-8, 4) },
    });
    this.matComp = mk(COMP, {
      tHdr: { value: null }, tBloom: { value: null }, tExp: { value: null }, uExposure: { value: 1 }, uAuto: { value: 1 },
      uExpo: { value: new THREE.Vector3(0.18, 0.05, 20) }, uBloom: { value: 0 }, uLook: { value: new THREE.Vector2(1, 1) },
      uFrame: { value: 0 }, uDroplets: { value: 0 }, uTime: { value: 0 }, uAspect: { value: 1 }, uResY: { value: 1 },
    });

    // levels[i] 是输入的 1/2^(i+1)；texel[0] 是 HDR 输入，texel[i+1] 对应 levels[i]
    this.levels = [];
    this.texel = [new THREE.Vector2()];
    for (let i = 0; i < LEVELS; i++) {
      this.levels.push(new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType, format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
        depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      }));
      this.texel.push(new THREE.Vector2());
    }

    // 自动曝光：METERxMETER 的 log 亮度目标，再用 1x1 浮点乒乓纹理保存自适应后的值
    this.meterRT = new THREE.WebGLRenderTarget(METER, METER, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    const f32 = renderer.extensions.has('EXT_color_buffer_float');
    this.adapt = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, {
      type: f32 ? THREE.FloatType : THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    }));
    this._cur = 0;      // adapt[_cur] 保存最新状态
    this._snap = true;  // 下一次测光时直接替换状态，而不是缓动过去
    this._frame = 0;
    this._time = 0;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.setSize(size.x, size.y);
  }

  setSize(width, height) {
    let w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height));
    this.matComp.uniforms.uAspect.value = w / h;
    this.matComp.uniforms.uResY.value = h;
    this._snap = true; // 新建帧缓冲：立即重新测光
    this.texel[0].set(1 / w, 1 / h);
    for (let i = 0; i < LEVELS; i++) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      this.levels[i].setSize(w, h);
      this.texel[i + 1].set(1 / w, 1 / h);
    }
  }

  _pass(mat, target) {
    this.mesh.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.mesh, this.camera);
  }

  _blit(mat, src, texel, target) {
    mat.uniforms.tSrc.value = src;
    mat.uniforms.uTexel.value = texel;
    this._pass(mat, target);
  }

  // 两个很小的渲染阶段：HDR -> 32x32 的 log2 亮度 -> 1x1 均值 + 时域自适应（全部在 GPU 上完成）。
  _meterExposure(hdr, dt) {
    const p = this.params, m = this.matMeter.uniforms, a = this.matAdapt.uniforms, f = this._frame;
    m.tSrc.value = hdr;
    m.uJitter.value.set((f * 0.7548776662466927) % 1, (f * 0.5698402909980532) % 1); // R2 序列
    this._pass(this.matMeter, this.meterRT);

    // 把状态保持在曝光钳制真正能呈现的范围内，避免它“越积越偏”
    const key = Math.max(p.keyValue, 1e-4), lo = Math.max(Math.min(p.minExposure, p.maxExposure), 1e-4), hi = Math.max(p.minExposure, p.maxExposure, 1e-4);
    a.tSrc.value = this.meterRT.texture;
    a.tPrev.value = this.adapt[this._cur].texture;
    a.uK.value.set(this._snap ? 1 : 1 - Math.exp(-dt * p.adaptUp), this._snap ? 1 : 1 - Math.exp(-dt * p.adaptDown));
    a.uRange.value.set(Math.log2(key / hi), Math.log2(key / lo));
    this._cur ^= 1;
    this._pass(this.matAdapt, this.adapt[this._cur]);
    this._snap = false;
  }

  render(hdrTexture, dt = 1 / 60) {
    const r = this.renderer, p = this.params, L = this.levels, T = this.texel;
    dt = dt > 0 ? Math.min(dt, 1) : 0; // 同时也能挡掉 NaN
    this._frame = (this._frame + 1) & 255;
    this._time = (this._time + dt) % 4096;

    const prevTarget = r.getRenderTarget(), prevClear = r.autoClear, prevReset = r.info.autoReset;
    r.autoClear = false;
    r.info.autoReset = false; // 保留场景统计；否则我们的渲染阶段会把它们清掉

    if (p.autoExposure) this._meterExposure(hdrTexture, dt);
    else this._snap = true; // 关闭期间状态会过期：重新开启时直接贴合

    const th = p.bloomThreshold, knee = Math.max(th * 0.5, 1e-4);
    const pre = this.matPre.uniforms;
    pre.uCurve.value.set(th - knee, 2 * knee, 0.25 / knee, th);
    pre.uClamp.value = p.bloomClamp;

    if (p.bloomStrength > 0) {   // 关闭时，合成阶段会把这条陈旧的链按 0 缩放
      this._blit(this.matPre, hdrTexture, T[0], L[0]);
      for (let i = 1; i < LEVELS; i++) this._blit(this.matDown, L[i - 1].texture, T[i], L[i]);
      for (let i = LEVELS - 2; i >= 0; i--) this._blit(this.matUp, L[i + 1].texture, T[i + 2], L[i]);
    }

    const u = this.matComp.uniforms;
    u.tHdr.value = hdrTexture;
    u.tBloom.value = L[0].texture;
    u.tExp.value = this.adapt[this._cur].texture;
    u.uExposure.value = p.exposure;
    u.uAuto.value = p.autoExposure ? 1 : 0;
    u.uExpo.value.set(p.keyValue, Math.min(p.minExposure, p.maxExposure), Math.max(p.minExposure, p.maxExposure));
    u.uLook.value.set(p.contrast, p.saturation);
    u.uBloom.value = p.bloomStrength;
    u.uFrame.value = this._frame;
    u.uDroplets.value = Math.min(Math.max(p.droplets, 0), 1);
    u.uTime.value = this._time;
    this._pass(this.matComp, null);

    r.setRenderTarget(prevTarget);
    r.autoClear = prevClear;
    r.info.autoReset = prevReset;
  }

  dispose() {
    for (const rt of this.levels) rt.dispose();
    this.meterRT.dispose();
    for (const rt of this.adapt) rt.dispose();
    for (const m of [this.matPre, this.matDown, this.matUp, this.matMeter, this.matAdapt, this.matComp]) m.dispose();
    this.geometry.dispose();
  }
}
