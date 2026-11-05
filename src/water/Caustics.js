import * as THREE from 'three';
import { N, CASCADE_LENGTHS } from './OceanSim.js';
import { rawPass } from '../engine/fullscreen.js';

// 用面积比泼溅实现的波浪驱动焦散（Evan Wallace 的 WebGL water）：一张覆盖
// 12 m 级联周期的网格经其斜率折射后投射到三个深度平面上，
// 每个落地的三角形向对应深度的通道累加（未扰动面积 / 落地面积）。
// 输出带 mipmap + repeat，每 12 m 平铺一次：各切片深度上相对于平静水面的
// 强度，按构造均值为 1（网格是水密的，因此泼溅的能量就是
// 平铺面积），所以它直接乘到直射阳光上。两个目标，尺寸按各深度处太阳圆盘的
// 模糊量（约为深度的 0.7%）确定：近处 R16F 512²（2.3 cm）配 1.5 m，深处
// RG16F 256² 配 4 m 与 10 m。
// 平静水面的落地偏移被减掉，从而把图案配准到水面
// 入射点：用 uv = entryXZ / 12 查找（见 CAUSTICS_GLSL）。

const L = CASCADE_LENGTHS[2];
const ETA = 1 / 1.33;
const MAX_RATIO = 16;  // 萤火虫钳制（标定旋钮；超过它的能量会被丢弃）
// 折叠狭条远细于一个 texel：点采样时它们只是偶尔命中 texel 中心，
// 线条会碎成点，因此两个目标都启用 MSAA（每条狭条按覆盖率
// 累加）。
const TARGETS = [
  { res: 512, format: THREE.RedFormat },
  { res: 256, format: THREE.RGFormat },
];
// 每个切片：目标 + 通道、每个平铺块的网格单元数，以及每个平铺块边缘外
// 必须覆盖最大落地偏移的单元数余量（做环绕，而不是绘制
// 3×3 个平铺块）。开销随 cells × 目标分辨率增长（狭条四边形过着色），而
// B-spline 斜率让粗网格保持平滑。更深的切片由更长波聚焦，
// 因此使用更粗的斜率 mip。
const SLICES = [
  { depth: 1.5, target: 0, channel: 0, cells: 128, margin: 6 },  // 0.38 m
  { depth: 4, target: 1, channel: 0, cells: 64, margin: 7 },     // 0.94 m
  { depth: 10, target: 1, channel: 1, cells: 32, margin: 8 },    // 2.25 m
];
const f = (x) => x.toPrecision(9);   // GLSL 浮点字面量
const [D0, D1, D2] = SLICES.map((s) => f(s.depth));

const VERT = /* glsl */`
precision highp float;
in vec3 position;               // PlaneGeometry 顶点：单元坐标 - uCells / 2
uniform highp sampler2D uSlope; // 级联 2（sx, sz, ...）
uniform vec3 uSun;              // 指向太阳
uniform float uDepth, uCells, uLod, uMargin, uRes;
out vec2 vOld;

// 4 次双线性采样得到的三次 B-spline（GPU Gems 2 第 20 章）。落地强度取决于
// 斜率的导数，而双线性使其分段常值：每个斜率 texel
// 都会沿焦散线落地成一颗独立的珠子。
vec2 slopeBSpline(vec2 uv, float lod) {
  vec2 size = vec2(textureSize(uSlope, int(lod)));
  vec2 st = uv * size - 0.5, i = floor(st), f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0, w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0, w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / size, h1 = (i + 1.5 + w3 / g1) / size;
  return g0.y * (g0.x * textureLod(uSlope, h0, lod).xy + g1.x * textureLod(uSlope, vec2(h1.x, h0.y), lod).xy)
       + g1.y * (g0.x * textureLod(uSlope, vec2(h0.x, h1.y), lod).xy + g1.x * textureLod(uSlope, h1, lod).xy);
}

void main() {
  vec2 t = (position.xy + 0.5 * uCells + 0.5) / uCells;   // 平铺 uv，位于 mip uLod 的某个 texel 中心
  vec2 s = slopeBSpline(t, uLod);
  vec3 r = refract(-uSun, normalize(vec3(-s.x, 1.0, -s.y)), ${f(ETA)});
  vec3 rf = refract(-uSun, vec3(0.0, 1.0, 0.0), ${f(ETA)});
  vec2 d = (r.xz / max(-r.y, 0.05) - rf.xz / -rf.y) * (uDepth / ${f(L)});
  // ponytail：超出余量的偏移（低太阳时的陡面）会被钳制，出现可见问题时加大余量
  d = clamp(d, -uMargin, uMargin);
  vOld = t * uRes;
  gl_Position = vec4((t + d) * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = /* glsl */`
precision highp float;
uniform vec3 uMask;
in vec2 vOld;
out vec4 outColor;

void main() {
  // 光栅空间就是每像素一个 texel 的落地空间，因此落地面积为 1，
  // 比值就是每像素对应的未扰动面积（以 texel 计）
  vec2 a = dFdx(vOld), b = dFdy(vOld);
  outColor = vec4(uMask * min(abs(a.x * b.y - a.y * b.x), ${f(MAX_RATIO)}), 0.0);
}`;

// waveCaustic(entryXZ, depth, lod) -> 直射阳光乘数，均值约 1（uniform 来自
// WaveCaustics.uniforms）。
// entryXZ：世界坐标 xz（m），即穿过着色点的平静水面折射太阳光线
//   与水面相交的位置：P.xz + rs.xz / rs.y * depth，rs = refract(-sunDir, up, 1/1.33)。
// depth：水面以下的米数（<= 0 时返回 1.0）。lod：近处 texel 上额外的 mip 模糊，
//   例如 log2(footprint (m) * CAUSTIC_TEXELS_PER_M)。
export const CAUSTICS_GLSL = /* glsl */`
uniform sampler2D uCaustics, uCausticsDeep;
const float CAUSTIC_TEXELS_PER_M = ${f(TARGETS[0].res / L)};
float waveCaustic(vec2 entryXZ, float depth, float lod) {
  vec2 uv = entryXZ * ${f(1 / L)};
  float v = textureLod(uCaustics, uv, lod).r;
  if (depth > ${D0}) {
    // 深处 texel 是近处的 2 倍；越过最深切片后沿用该值，深度每翻倍
    // 就多模糊一级 mip
    vec2 d = textureLod(uCausticsDeep, uv, max(lod - 1.0, 0.0) + log2(max(depth / ${D2}, 1.0))).rg;
    v = depth < ${D1} ? mix(v, d.r, (depth - ${D0}) / (${D1} - ${D0}))
                      : mix(d.r, d.g, clamp((depth - ${D1}) / (${D2} - ${D1}), 0.0, 1.0));
  }
  return mix(1.0, v, clamp(depth / ${D0}, 0.0, 1.0));   // 零深度处无焦散
}
`;

const _color = new THREE.Color();

export class WaveCaustics {
  constructor(renderer, sim) {
    this.renderer = renderer;
    this.sim = sim;
    this.targets = TARGETS.map(({ res, format }) => new THREE.WebGLRenderTarget(res, res, {
      type: THREE.HalfFloatType, format, samples: 4, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: true, depthBuffer: false,
    }));
    this.uniforms = { uCaustics: { value: this.targets[0].texture }, uCausticsDeep: { value: this.targets[1].texture } };
    this.slope = { value: null };
    this.sun = { value: new THREE.Vector3() };
    this.scenes = TARGETS.map(() => new THREE.Group());
    SLICES.forEach(({ depth, target, channel, cells, margin }) => {
      const mat = rawPass(FRAG, {
        uSlope: this.slope, uSun: this.sun, uRes: { value: TARGETS[target].res },
        uDepth: { value: depth }, uCells: { value: cells }, uLod: { value: Math.max(0, Math.log2(N / cells)) },
        uMargin: { value: (margin - 1) / cells }, uMask: { value: new THREE.Vector3().setComponent(channel, 1) },
      }, {
        vertexShader: VERT, side: THREE.DoubleSide,   // 越过焦点的折叠会翻转落地
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      });
      const span = cells + 2 * margin;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(span, span, span, span), mat);
      mesh.frustumCulled = false;
      this.scenes[target].add(mesh);
    });
    this.camera = new THREE.Camera();
    this.flat = false;
    this.update(new THREE.Vector3(0, -1, 0));   // 以平坦的 1.0 起始
  }

  // 每帧一次，在 sim.update() 之后；sunDir 指向太阳
  update(sunDir) {
    const up = sunDir.y > 0;
    if (!up && this.flat) return;
    this.flat = !up;
    const r = this.renderer;
    const prevRT = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();
    const prevAlpha = r.getClearAlpha();
    r.getClearColor(_color);
    this.sun.value.copy(sunDir).normalize();
    this.slope.value = this.sim.slope[2];
    r.setClearColor(up ? 0x000000 : 0xffffff, 1);
    this.targets.forEach((rt, i) => {
      this.scenes[i].visible = up;   // 隐藏时仍会渲染：render() 会重建清除值对应的 mip
      r.setRenderTarget(rt);
      r.clear(true, false, false);
      r.render(this.scenes[i], this.camera);
    });
    r.setRenderTarget(prevRT, face, mip);
    r.setClearColor(_color, prevAlpha);
  }
}
