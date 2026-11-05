import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildTerrain } from './terrainGeometry.js';
import { islandHeight } from './islandHeight.js';
import { fbm } from './noise.js';
import { CAUSTICS_GLSL } from '../water/Caustics.js';
import { FLOAT_SHADOW_GLSL } from './floaterShadow.js';
import { SHORE_GLSL, SWASH_GLSL } from '../water/OceanSurface.js';

// MeshStandardMaterial 上的岛屿 + 岸边礁石，打补丁加入：生物群系着色、
// 湿沙光泽、水下经折射与吸收的阳光、波浪驱动的焦散，以及
// 浮体阴影贴图。
const VERT_PARS = /* glsl */`
varying vec3 vWPos;
varying vec3 vWNrm;
`;

const FRAG_PARS = /* glsl */`
varying vec3 vWPos;
varying vec3 vWNrm;
uniform samplerCube uSkyCube;
uniform vec3 uAbsorption;
uniform vec3 uSunDirT;
uniform float uCausticStrength;
uniform float uFogDensity;
${CAUSTICS_GLSL}
${FLOAT_SHADOW_GLSL}
${SHORE_GLSL}
#define SWASH_ROCKS
uniform sampler2D uRockIdx;
uniform sampler2D uRockData;
${SWASH_GLSL}
float th(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float tn(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(th(i), th(i + vec2(1, 0)), u.x), mix(th(i + vec2(0, 1)), th(i + 1.0), u.x), u.y); }
// 波纹痕迹：沿 d 的相位（波数 w）被尺度 s、幅度 a（沿 d 的米数）的噪声扭曲，
// 于是波峰会在扭曲变陡处蜿蜒并分叉
float ripplePhase(vec2 p, vec2 d, float w, float s, float a) {
  return w * (dot(p, d) + (tn(p * s) - 0.5) * a + (tn(p * s * 0.27 + 4.0) - 0.5) * a * 3.0);
}
// h = amp (sin ph - 0.25 cos 2ph) 的斜率：波峰尖锐、波谷宽阔
vec2 rippleSlope(vec2 p, vec2 d, float w, float s, float a, float amp) {
  float ph = ripplePhase(p, d, w, s, a);
  vec2 grad = (vec2(ripplePhase(p + vec2(0.01, 0.0), d, w, s, a), ripplePhase(p + vec2(0.0, 0.01), d, w, s, a)) - ph) / 0.01;
  return grad * amp * (cos(ph) + 0.5 * sin(2.0 * ph));
}
uniform mat4 uSunShadowMatrix;
#ifdef ROCK
// 3D 值噪声：岩壁很陡，用世界坐标 xz 的 2D 图案会沿其垂向拉出条纹
float th3(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float tn3(vec3 p) { vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(th3(i), th3(i + vec3(1, 0, 0)), u.x), mix(th3(i + vec3(0, 1, 0)), th3(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(th3(i + vec3(0, 0, 1)), th3(i + vec3(1, 0, 1)), u.x), mix(th3(i + vec3(0, 1, 1)), th3(i + 1.0), u.x), u.y), u.z); }
#endif
`;

const ALBEDO = /* glsl */`
  float hgt = vWPos.y;
  float flat_ = clamp(vWNrm.y, 0.0, 1.0);
  float n1 = tn(vWPos.xz * 0.08), n2 = tn(vWPos.xz * 0.6), n3 = tn(vWPos.xz * 0.013);
  vec3 sand = mix(vec3(0.80, 0.71, 0.53), vec3(0.72, 0.62, 0.45), n1) * (0.92 + 0.16 * n2);
  vec3 seabed = mix(vec3(0.78, 0.72, 0.56), vec3(0.62, 0.58, 0.44), n1 * n3);
  vec3 grass = mix(vec3(0.20, 0.30, 0.10), vec3(0.33, 0.37, 0.15), n1) * (0.85 + 0.3 * n2);
  vec3 rock = mix(vec3(0.33, 0.31, 0.29), vec3(0.45, 0.41, 0.36), n2) * (0.8 + 0.4 * n3);
#ifdef ROCK
  // 条带状岩石（凹陷来自顶点色）、一条横穿潮位范围的深色海藻与藤壶带，
  // 以及干燥岩顶上被盐漂白的斑块
  float r1 = tn3(vWPos * 0.9), r2 = tn3(vWPos * 3.7 + 7.0);
  float strata = sin(vWPos.y * 2.2 + r1 * 3.0) * 0.5 + 0.5;
  vec3 albedo = mix(vec3(0.27, 0.25, 0.23), vec3(0.52, 0.47, 0.41), r1 * 0.6 + strata * 0.25 + r2 * 0.15);
  float tide = (1.0 - smoothstep(0.4, 1.3 + 0.6 * r1, hgt)) * smoothstep(-3.0, -0.8, hgt);
  albedo = mix(albedo, vec3(0.10, 0.11, 0.07) * (0.7 + 0.6 * r2), tide * 0.8);
  albedo = mix(albedo, vec3(0.80, 0.78, 0.72), smoothstep(0.7, 0.92, flat_) * smoothstep(1.0, 2.0, hgt) * smoothstep(0.55, 0.8, r2) * 0.55);
#else
  float sandLine = 2.4 + 1.6 * n3 + 0.8 * n1;
  vec3 albedo = mix(seabed, sand, smoothstep(-0.05, 0.05, hgt));
  albedo = mix(albedo, grass, smoothstep(sandLine, sandLine + 1.5, hgt) * smoothstep(0.62, 0.8, flat_));
  albedo = mix(albedo, rock, smoothstep(0.78, 0.62, flat_) * smoothstep(-6.0, 1.0, hgt));
  albedo = mix(albedo, rock * 1.1, smoothstep(38.0, 52.0, hgt + n1 * 8.0));
#endif
  // 水线以上的湿带，以及上冲流经过的地方（几秒内就会变干）
  vec3 sw = swash(vWPos.xz, hgt);
  float wet = max(1.0 - smoothstep(0.35, 1.3 + 0.5 * n1, hgt), sw.z);
  // 填满孔隙的水会让沙变暗、颜色更深（光要在沙粒内部多反弹几次才能逃出，
  // 于是每一层染色都叠加起来）：大致相当于反照率取平方，而不是平铺的灰色
  // 乘算——后者看起来像冰冷的混凝土。水线以下的海床则保持较平的变暗，否则
  // 一米深的水就会把它变成橄榄色。
  albedo *= mix(vec3(1.0), mix(0.8 * albedo + 0.06, vec3(0.6), smoothstep(0.0, -0.8, hgt)), wet);
  // 上冲流水膜本身：从第一毫米起就湿润发亮（因有波纹，所以是柔和光泽而非
  // 天空镜子），并且只带极淡的色调，因为几厘米的水几乎不吸收什么；海的
  // 颜色来自深度，而不是这层水膜
  float film = smoothstep(0.0, 0.004, sw.x) * smoothstep(-0.05, 0.05, hgt);
  albedo *= mix(vec3(1.0), vec3(0.9, 0.97, 0.97), smoothstep(0.0, 0.06, sw.x) * film);
  // 气泡：上冲边缘的蕾丝状泡沫，回流时被带下来的破碎残留。剩下的泡沫越少，
  // 阈值就越高，所以它破灭时是碎成越来越小的岛屿，而不是作为一层均匀的
  // 面纱淡化消失
  float fwP = max(fwidth(vWPos.x), fwidth(vWPos.z));
  if (sw.y > 0.0) {
    float lace = smoothstep(0.75 - 0.4 * sw.y, 0.92 - 0.3 * sw.y, tn(vWPos.xz * 3.1 + uTime * 0.15) * 0.6 + tn(vWPos.xz * 7.3) * 0.4);
    // 远处的蕾丝单元会缩到一个像素以下：在那里取平均值，而不是让它闪烁
    lace = mix(lace, 0.3, smoothstep(0.05, 0.3, fwP));
    // 湿沙上几厘米厚的气泡：颜色偏淡并带沙的色调，绝不是纸白色
    albedo = mix(albedo, albedo * 0.4 + vec3(0.42, 0.41, 0.38), min(sw.y * 1.4, 1.0) * lace * 0.7);
  }
  diffuseColor.rgb = albedo;
`;

// 世界空间中的沙纹 + 沙粒凹凸，在出现走样之前淡出
const RIPPLES = /* glsl */`
#ifndef ROCK
  {
    vec2 fw = fwidth(vWPos.xz);
    float px = max(fw.x, fw.y);
    if (px < 0.5) {   // 超过这个尺度，两条波纹带都已淡出
    float sandMask = (1.0 - smoothstep(sandLine - 0.5, sandLine + 0.5, hgt)) * smoothstep(0.85, 0.95, flat_);
    sandMask *= mix(1.0, 0.25, smoothstep(-0.3, 0.6, hgt)); // 干沙：只有淡淡的风成沙纹
    // 波浪形成长沙纹（约 1.6 m）与短沙纹（约 0.3 m），各自成片地淡入淡出
    vec2 p = vWPos.xz;
    vec2 d1 = normalize(vec2(0.8, 0.6) + (vec2(tn(p * 0.02), tn(p * 0.02 + 5.0)) - 0.5));
    float a1 = 0.02 * (0.3 + 0.7 * smoothstep(0.25, 0.75, tn(p * 0.06 + 11.0)));
    vec2 g = rippleSlope(p, d1, 3.9, 0.35, 0.8, a1) * (1.0 - smoothstep(0.15, 0.5, px));
    if (px < 0.09) {
      float a2 = 0.002 * (0.3 + 0.7 * smoothstep(0.25, 0.75, tn(p * 0.15 + 3.0)));
      g += rippleSlope(p, normalize(d1 + vec2(-d1.y, d1.x) * 0.3), 21.0, 2.2, 0.1, a2) * (1.0 - smoothstep(0.03, 0.09, px));
    }
    vec3 nW = normalize(vWNrm - vec3(g.x, 0.0, g.y) * sandMask);
    normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
    }
  }
#else
  {
    // 岩崖与颗粒感：用屏幕导数从 3D 噪声得到凹凸（不使用纹理），
    // 细节倍频在出现走样之前淡出
    float px = length(fwidth(vWPos));
    float bh = tn3(vWPos * 1.6) * 0.6 + r2 * 0.25 + tn3(vWPos * 9.0) * 0.15 * (1.0 - smoothstep(0.03, 0.12, px));
    vec3 dpx = dFdx(vWPos), dpy = dFdy(vWPos);
    vec3 R1 = cross(dpy, vWNrm), R2 = cross(vWNrm, dpx);
    float det = dot(dpx, R1);
    vec3 grad = sign(det) * (dFdx(bh) * R1 + dFdy(bh) * R2);
    vec3 nW = normalize(abs(det) * vWNrm - grad * 0.3);
    normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
  }
#endif
`;

const UNDERWATER = /* glsl */`
  float wdepth = max(-vWPos.y, 0.0);
  // 穿过水柱到达海床的阳光与天空光（太阳沿其折射后的路径）
  vec3 rsun = refract(-uSunDirT, vec3(0.0, 1.0, 0.0), 1.0 / 1.33);
  float sunPath = wdepth / max(-rsun.y, 0.1);
  diffuseColor.rgb *= exp(-uAbsorption * (sunPath * 0.6 + wdepth * 0.4));
`;

// 直射阳光（拼接进 three 的光照循环，一盏平行光）：处处都有浮体阴影；
// 水面以下，光以折射后的方向到达（比外面掠射的太阳陡得多），并被菲涅尔
// 透射衰减；两张阴影贴图都在光穿过水面处采样，因此海床不会被上游的
// 每一条沙洲沿着未折射的光线遮蔽。
const SUN = /* glsl */`
    getDirectionalLightInfo( directionalLight, directLight );
    float under = smoothstep(0.05, -0.25, vWPos.y);
    vec3 shadowAt = vWPos + vWNrm * 0.04;
    bool viaSurface = false;
    if (under > 0.0) {
      vec3 rsun = refract(-uSunDirT, vec3(0.0, 1.0, 0.0), 1.0 / 1.33);
      viaSurface = rsun.y < -0.05 && under > 0.5;
      if (viaSurface) shadowAt = vec3(vWPos.x - rsun.x / rsun.y * vWPos.y, 0.05, vWPos.z - rsun.z / rsun.y * vWPos.y);
      directLight.direction = normalize(mix(directLight.direction, (viewMatrix * vec4(-rsun, 0.0)).xyz, under));
      float Ft = 0.02 + 0.98 * pow(1.0 - max(uSunDirT.y, 0.0), 5.0);
      directLight.color *= 1.0 - Ft * under;
    }
    directLight.color *= floatShadow(shadowAt);
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    vec4 sunShadowCoord = viaSurface ? uSunShadowMatrix * vec4(shadowAt, 1.0) : vDirectionalShadowCoord[ 0 ];
#endif
`;
const LIGHTS_BEGIN = THREE.ShaderChunk.lights_fragment_begin
  .replace('getDirectionalLightInfo( directionalLight, directLight );', SUN)
  .replace('vDirectionalShadowCoord[ i ]', 'sunShadowCoord');

const ROUGH = /* glsl */`
  roughnessFactor = mix(mix(roughnessFactor, 0.32, wet * smoothstep(-0.05, 0.05, hgt)), 0.2, film);
`;

// 由真实波浪聚焦的焦散（Caustics.js）；均值为 1，因此它们只是重新分配
// 直射阳光
const CAUSTICS = /* glsl */`
  if (wdepth > 0.0 && rsun.y < -0.05) {
    vec2 entry = vWPos.xz + rsun.xz / rsun.y * wdepth;   // 这束光穿入水面处
    vec2 fwc = fwidth(entry);
    float c = waveCaustic(entry, wdepth, log2(max(max(fwc.x, fwc.y) * CAUSTIC_TEXELS_PER_M, 1.0)));
    // 头一两米对比度略高，那里网纹最锐利；在顶部几厘米内淡入，
    // 这样水线处不会出现一道生硬的焦散缝
    float cs = uCausticStrength * mix(1.35, 1.0, smoothstep(1.5, 3.0, wdepth)) * smoothstep(0.0, 0.3, wdepth);
    reflectedLight.directDiffuse *= max(mix(1.0, c, cs), 0.0);
  }
`;

const FOG = /* glsl */`
  vec3 fdir = normalize(vWPos - cameraPosition);
  float fogAmt = 1.0 - exp(-length(vWPos - cameraPosition) * uFogDensity);
  outgoingLight = mix(outgoingLight, textureLod(uSkyCube, vec3(fdir.x, max(fdir.y, 0.0), fdir.z), 3.0).rgb, fogAmt);
`;

// mode: 'terrain' | 'rock' | 'prop'（道具保留自己的颜色，只是额外获得
// 水下光衰减、焦散和雾）
function patch(material, uniforms, mode) {
  const ground = mode !== 'prop';
  if (mode === 'rock') material.defines = { ...material.defines, ROCK: '' };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_PARS)
      .replace('#include <project_vertex>', `#include <project_vertex>
  vec4 wp = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  wp = instanceMatrix * wp;
#endif
  vWPos = (modelMatrix * wp).xyz;
  vec3 wn = objectNormal;
#ifdef USE_INSTANCING
  wn = mat3(instanceMatrix) * wn;
#endif
  vWNrm = normalize(mat3(modelMatrix) * wn);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_PARS)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + (ground ? ALBEDO : '') + UNDERWATER)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + (ground ? ROUGH : ''))
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + (ground ? RIPPLES : ''))
      .replace('#include <lights_fragment_begin>', LIGHTS_BEGIN)
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + CAUSTICS)
      .replace('#include <opaque_fragment>', FOG + '#include <opaque_fragment>');
  };
  material.customProgramCacheKey = () => 'gelatin-' + mode;
}

function rockGeometry() {
  let g = new THREE.IcosahedronGeometry(1, 4);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position, v = new THREE.Vector3();
  const ao = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = fbm(v.x * 1.4 + 3, v.z * 1.4 + v.y * 0.7, 5, 21);
    const facet = Math.abs(fbm(v.x * 3.1, v.y * 3.1 + v.z, 3, 5));
    // 刻进表面的脊状裂缝
    const crack = Math.abs(fbm(v.x * 5.7 + v.z * 1.9, v.y * 5.7 - v.z * 1.3, 2, 9));
    const d = 1 + 0.38 * n - 0.12 * facet - 0.06 * Math.max(0.12 - crack, 0) / 0.12;
    v.multiplyScalar(d);
    // 一点点层理暗示：高度有小幅台阶，像层状岩石
    v.y -= 0.7 * Math.sin(v.y * 8 * Math.PI) / (8 * Math.PI);
    if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.4;   // 较平的底部
    p.setXYZ(i, v.x, v.y, v.z);
    // 烘焙进顶点色的凹陷遮蔽：凹坑和裂缝更暗
    const c = Math.min(Math.max(0.78 + 0.9 * (d - 1), 0.42), 1) * (0.65 + 0.35 * Math.min(crack / 0.12, 1));
    ao[i * 3] = ao[i * 3 + 1] = ao[i * 3 + 2] = c;
  }
  g.setAttribute('color', new THREE.BufferAttribute(ao, 3));
  g.computeVertexNormals();
  return g;
}

// 一块大礁石，位于受涌浪冲刷的海岸的拍岸浪里（默认涌浪来自方位角 -15 度），
// 处在约 2.5 m 深的水中，好让上冲流绕过它；'Surf rock' 镜头正对着它
export const heroRock = (() => {
  const a = THREE.MathUtils.degToRad(-15);
  let r = 100;
  while (r < 900 && islandHeight(Math.cos(a) * r, Math.sin(a) * r) > -2.5) r += 1;
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
})();

function placeRocks(count, rand) {
  const out = [];
  for (let i = 0; i < count * 6 && out.length < count; i++) {
    const a = rand() * Math.PI * 2;
    // 沿这个方位角向外走到海岸，再在其附近抖动
    let r = 150;
    while (r < 700 && islandHeight(Math.cos(a) * r, Math.sin(a) * r) > 0) r += 4;
    r += (rand() - 0.6) * 40;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = islandHeight(x, z);
    if (h < -5 || h > 6) continue;
    const s = 1.5 + Math.pow(rand(), 2.2) * 9;
    out.push({ x, z, y: h - s * 0.15, s });
    // 小块的伴生石
    for (let k = 0; k < 3 && out.length < count; k++) {
      const ox = x + (rand() - 0.5) * s * 4, oz = z + (rand() - 0.5) * s * 4;
      const ss = s * (0.25 + rand() * 0.35);
      out.push({ x: ox, z: oz, y: islandHeight(ox, oz) - ss * 0.2, s: ss });
    }
  }
  return out;
}

// 对海岸贴图的每个纹素，记录影响能到达它的两块礁石（uRockData 的下标，
// -1 表示没有），按以半径归一化的距离排序；uRockData 保存中心 xz 与半径
function rockMaps(rocks, extent, size = 512) {
  const data = new Float32Array(rocks.length * 4);
  rocks.forEach((r, i) => data.set([r.x, r.z, r.r, 0], i * 4));
  const idx = new Float32Array(size * size * 2).fill(-1);
  const texel = extent / size;
  rocks.forEach((r, i) => {
    const reach = 4.5 * r.r + 2 + texel;
    const i0 = Math.max(0, Math.floor((r.x - reach) / texel + size / 2)), i1 = Math.min(size - 1, Math.ceil((r.x + reach) / texel + size / 2));
    const j0 = Math.max(0, Math.floor((r.z - reach) / texel + size / 2)), j1 = Math.min(size - 1, Math.ceil((r.z + reach) / texel + size / 2));
    for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) {
      const x = (ii + 0.5 - size / 2) * texel, z = (j + 0.5 - size / 2) * texel;
      const d = Math.hypot(x - r.x, z - r.z);
      if (d > reach) continue;
      const k = (j * size + ii) * 2, q = d / r.r;
      const rank = (m) => (idx[k + m] < 0 ? Infinity : Math.hypot(x - rocks[idx[k + m]].x, z - rocks[idx[k + m]].z) / rocks[idx[k + m]].r);
      if (q < rank(0)) { idx[k + 1] = idx[k]; idx[k] = i; } else if (q < rank(1)) idx[k + 1] = i;
    }
  });
  const tex = (arr, w, h, fmt) => {
    const t = new THREE.DataTexture(arr, w, h, fmt, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    return t;
  };
  return {
    uRockIdx: { value: tex(idx, size, size, THREE.RGFormat) },
    uRockData: { value: tex(data, Math.max(rocks.length, 1), 1, THREE.RGBAFormat) },
  };
}

export function createTerrain({ sky, caustics, floatShadow, water, absorption, reflectionLayer = 1 }) {
  const uniforms = {
    ...floatShadow,
    // 海岸贴图 + 上冲流用的波浪设置（与水面的同一批对象）
    ...Object.fromEntries(['uShore', 'uTravel', 'uSurf', 'uShoreExtent', 'uTime', 'uShoreWave', 'uSwellDir'].map((k) => [k, water[k]])),
    ...caustics,
    uSkyCube: { value: sky.cube },
    uAbsorption: { value: absorption },
    uSunDirT: { value: sky.sunDir },
    uSunShadowMatrix: { value: new THREE.Matrix4() },   // 太阳光的 shadow.matrix（main.js）
    uCausticStrength: { value: 1.0 },
    uFogDensity: { value: 1 / 18000 },
  };

  const { geometry } = buildTerrain(384);
  const groundMat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, envMapIntensity: 0.9 });
  patch(groundMat, uniforms, 'terrain');
  const ground = new THREE.Mesh(geometry, groundMat);
  ground.castShadow = ground.receiveShadow = true;

  let seed = 7;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const spots = placeRocks(90, rand);
  spots.push({ ...heroRock, y: islandHeight(heroRock.x, heroRock.z) - 1.6, s: 0, hero: true });
  const rockMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, envMapIntensity: 0.9, vertexColors: true });
  patch(rockMat, uniforms, 'rock');
  const rocks = new THREE.InstancedMesh(rockGeometry(), rockMat, spots.length);
  const m = new THREE.Matrix4(), qt = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3();
  spots.forEach((s, i) => {
    e.set(rand() * 0.6, rand() * Math.PI * 2, rand() * 0.6);
    if (s.hero) sc.set(9, 6, 7.5);
    else sc.set(s.s * (0.8 + rand() * 0.6), s.s * (0.5 + rand() * 0.5), s.s * (0.8 + rand() * 0.6));
    m.compose(new THREE.Vector3(s.x, s.y, s.z), qt.setFromEuler(e), sc);
    rocks.setMatrixAt(i, m);
    // （变形后的单位球）礁石与沙面相交处的足迹半径
    s.r = 0.95 * (sc.x + sc.z) / 2;
  });
  // 波浪与上冲流会撞上的礁石（拍岸礁石在水中另有专门处理）
  const shoreRocks = spots.filter((s) => !s.hero && islandHeight(s.x, s.z) > -3 && islandHeight(s.x, s.z) < 2.5);
  Object.assign(uniforms, rockMaps(shoreRocks, water.uShoreExtent.value));
  rocks.computeBoundingSphere();
  rocks.castShadow = rocks.receiveShadow = true;

  const group = new THREE.Group();
  group.add(ground, rocks);
  for (const o of [ground, rocks]) o.layers.enable(reflectionLayer);
  return { group, uniforms, shoreRocks, patchProp: (m) => patch(m, uniforms, 'prop') };
}
