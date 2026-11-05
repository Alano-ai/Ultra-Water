import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { OceanSim, defaultOceanParams } from './water/OceanSim.js';
import { OceanSurface } from './water/OceanSurface.js';
import { bakeShoreMap } from './water/shoreMap.js';
import { bakeWaterTextures } from './water/bakeTextures.js';
import { SkySystem } from './scene/sky.js';
import { createTerrain, heroRock } from './scene/terrain.js';
import { islandHeight } from './scene/islandHeight.js';
import { PlanarReflection } from './engine/PlanarReflection.js';
import { PostFX } from './engine/PostFX.js';
import { GpuTimer } from './engine/gpuTimer.js';
import { FullscreenQuad, rawPass } from './engine/fullscreen.js';
import { WaterQuery } from './water/WaterQuery.js';
import { UnderwaterPass } from './water/UnderwaterPass.js';
import { Spray } from './water/Spray.js';
import { MarineSnow } from './water/MarineSnow.js';
import { Floaters } from './scene/floaters.js';
import { FLOATER_KINDS } from './scene/floaterMeshes.js';
import { FloaterShadow } from './scene/floaterShadow.js';
import { WaveCaustics } from './water/Caustics.js';

const REFLECT_LAYER = 1;

const renderer = new THREE.WebGLRenderer({
  antialias: false, depth: false, stencil: false, alpha: false, powerPreference: 'high-performance',
});
renderer.autoClear = false;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;
// three 将纹理单元数限制在单阶段上限（16），但水体的顶点 + 片元
// 采样器合计为 17（片元阶段为 16）；单元只需满足合计上限
renderer.capabilities.maxTextures = renderer.getContext().getParameter(WebGL2RenderingContext.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
document.body.appendChild(renderer.domElement);

// 单一构建：手机和平板（以手指为主要指针）从更轻量的配置档开始，
// 在 Adreno 732 上实测可保持 60 fps；`?mobile` / `?desktop` 强制指定其一
const args = new URLSearchParams(location.search);
const mobile = args.has('mobile') || (!args.has('desktop') && matchMedia('(pointer: coarse)').matches);
const quality = mobile
  ? { resolution: 0.6, msaa: 2, reflections: true, reflectionScale: 0.35, autoResolution: true }
  : { resolution: 1, msaa: 4, reflections: true, reflectionScale: 0.5 };
document.body.classList.toggle('mobile', mobile);
const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 80000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxDistance = 6000;

// --- 世界 ------------------------------------------------------------------------
const sky = new SkySystem(renderer);
// 烘焙中的拍岸礁石作为一个圆顶：浪头绕过它、在其正面破碎，
// 并留下一片遮蔽的背风区
const shore = bakeShoreMap(islandHeight, 1800, 512, (x, z) => {
  const q = ((x - heroRock.x) ** 2 + (z - heroRock.z) ** 2) / (8.5 * 8.5);
  return q < 1 ? 4 * (1 - q) : -Infinity;
});
const tex = bakeWaterTextures(renderer);
const ocean = new OceanSim(renderer, defaultOceanParams());
const caustics = new WaveCaustics(renderer, ocean);
const floatShadow = new FloaterShadow();
const surface = new OceanSurface(ocean, shore, sky, floatShadow.uniforms);
surface.uniforms.uFoamTex.value = tex.foam;

const scene = new THREE.Scene();
scene.environment = sky.cube;
scene.add(sky.background);
const terrain = createTerrain({
  sky, caustics: caustics.uniforms, floatShadow: floatShadow.uniforms, water: surface.uniforms,
  absorption: surface.uniforms.uAbsorption.value, reflectionLayer: REFLECT_LAYER,
});
scene.add(terrain.group);
surface.uniforms.uRock.value.set(heroRock.x, heroRock.z, 8.5, 0);

const sunLight = new THREE.DirectionalLight(0xffffff, Math.PI);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(4096, 4096);
Object.assign(sunLight.shadow.camera, { left: -900, right: 900, top: 900, bottom: -900, near: 10, far: 5000 });
sunLight.shadow.bias = -0.0004;
sunLight.shadow.normalBias = 0.6;
scene.add(sunLight, sunLight.target);
surface.uniforms.uShadowMatrix.value = terrain.uniforms.uSunShadowMatrix.value = sunLight.shadow.matrix;
surface.uniforms.uShadowBias.value = 0.05 / (sunLight.shadow.camera.far - sunLight.shadow.camera.near);

// 浮力：每次水面查询的槽位 0 是相机（水下测试），随后是浮体
const query = new WaterQuery(renderer, surface, 512);
const floaters = new Floaters({ scene, heightAt: islandHeight, patchMaterial: terrain.patchProp });
const underwater = new UnderwaterPass(surface, camera, caustics.uniforms);
let camWater = 0, wasSubmerged = false, uwComp = 1;
const look = { underwater: 0.55 };   // 水下的曝光补偿（否则自动曝光会把它提亮成奶白色）

const reflection = new PlanarReflection(REFLECT_LAYER);
surface.uniforms.uReflMatrix.value = reflection.textureMatrix;
const emptyReflection = new THREE.DataTexture(new Uint8Array(4), 1, 1);
emptyReflection.needsUpdate = true;

// 水面阶段：绘制到同一个 MSAA 缓冲区，采样已解析的不透明颜色与
// 深度。three 在解析后保留 MSAA 颜色，但 Oculus 浏览器除外，
// 那里会使其失效；只有该环境需要先把颜色拷回（在 3.3 MP 下约花费 0.5 ms）。
const waterScene = new THREE.Scene();
const restore = new FullscreenQuad(rawPass(/* glsl */`
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv); }`, { uTex: { value: null } }));
restore.mesh.renderOrder = -1;
if (/OculusBrowser/.test(navigator.userAgent)) waterScene.add(restore.mesh);
const spray = new Spray(surface, shore, [...terrain.shoreRocks, { x: heroRock.x, z: heroRock.z, r: 8.5 }]);
const snow = new MarineSnow(surface);
waterScene.add(surface.mesh, spray.mesh, spray.splash, spray.rockSplash, snow.mesh);

const post = new PostFX(renderer);
post.params.bloomStrength = 0.05;
post.params.bloomThreshold = 1.5;
if (mobile) post.params.bloomStrength = 0;   // 它的 12 个阶段在手机上的开销高于这层微光的价值

let hdrRT = null;
function makeTargets() {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  hdrRT?.dispose();
  hdrRT = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType, samples: quality.msaa, generateMipmaps: false,
    depthTexture: new THREE.DepthTexture(size.x, size.y, THREE.FloatType),
  });
  restore.material.uniforms.uTex.value = hdrRT.texture;
  surface.uniforms.uSceneColor.value = hdrRT.texture;
  surface.uniforms.uSceneDepth.value = hdrRT.depthTexture;
  surface.uniforms.uResolution.value.copy(size);
  reflection.scale = quality.reflectionScale;
  reflection.setSize(size.x, size.y);
  post.setSize(size.x, size.y);
  underwater.setSize(size.x, size.y);
}

function resize() {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * quality.resolution);
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  makeTargets();
}
window.addEventListener('resize', resize);

let sunDirty = true;
function applySun() {
  sky.update();
  sunLight.position.copy(sky.sunDir).multiplyScalar(2000);
  sunLight.color.setRGB(sky.sunColor.x, sky.sunColor.y, sky.sunColor.z).multiplyScalar(1 / Math.max(sky.sunColor.x, 1e-4));
  sunLight.intensity = Math.PI * Math.max(sky.sunColor.x, 1e-4);
  renderer.shadowMap.needsUpdate = true;
  sunDirty = false;
}

// --- 镜头预设 -----------------------------------------------------------------
function coast(bearingDeg) {
  const a = THREE.MathUtils.degToRad(bearingDeg);
  let r = 100;
  while (r < 800 && islandHeight(Math.cos(a) * r, Math.sin(a) * r) > 0) r += 2;
  return new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
}
function sunBearing() { return Math.atan2(sky.sunDir.z, sky.sunDir.x); }
function setSun(elevation, azimuth) {
  Object.assign(sky.params, { elevation, azimuth });
  fSun?.controllers.forEach((c) => c.updateDisplay());
  applySun();
}
const views = {
  'Golden hour': () => {
    setSun(3.5, 205);
    const b = sunBearing(), c = coast(THREE.MathUtils.radToDeg(b) + 18);
    camera.position.set(c.x + Math.cos(b) * 120, 5, c.y + Math.sin(b) * 120);
    controls.target.set(c.x + Math.cos(b) * 400, 0, c.y + Math.sin(b) * 400);
  },
  'Breakers': () => {
    setSun(38, 205);
    // 从清澈外海浅滩上方 10 米处，越过碎浪线向下望向海滩
    const b = sunBearing() + 1.9, c = coast(THREE.MathUtils.radToDeg(b));
    const out = new THREE.Vector2(Math.cos(b), Math.sin(b)), side = new THREE.Vector2(-out.y, out.x);
    camera.position.set(c.x + out.x * 48 - side.x * 35, 10, c.y + out.y * 48 - side.y * 35);
    controls.target.set(c.x + out.x * 20 - side.x * 10, 0, c.y + out.y * 20 - side.y * 10);
  },
  'Lagoon': () => {
    setSun(50, 205);
    // 岛屿西南侧宽阔平坦的浅滩：1-2 米深的绿松石色浅水区、沙洲和柔和的上冲流
    const b = sunBearing() - 1.48, c = coast(THREE.MathUtils.radToDeg(b));
    const out = new THREE.Vector2(Math.cos(b), Math.sin(b)), side = new THREE.Vector2(-out.y, out.x);
    camera.position.set(c.x - out.x * 2 + side.x * 25, 16, c.y - out.y * 2 + side.y * 25);
    controls.target.set(c.x + out.x * 34 - side.x * 10, 0, c.y + out.y * 34 - side.y * 10);
  },
  'Surf rock': () => {
    setSun(40, 205);
    // 拍岸浪中的大礁石，从略高处、偏向海滩一侧观看
    const out = new THREE.Vector2(heroRock.x, heroRock.z).normalize(), side = new THREE.Vector2(-out.y, out.x);
    camera.position.set(heroRock.x - out.x * 28 + side.x * 22, 14, heroRock.z - out.y * 28 + side.y * 22);
    controls.target.set(heroRock.x, 0, heroRock.z);
  },
  'Open ocean': () => {
    setSun(14, 205);
    const b = sunBearing() + 0.5;
    camera.position.set(Math.cos(b) * 1500, 9, Math.sin(b) * 1500);
    controls.target.set(Math.cos(b) * 2400, 0, Math.sin(b) * 2400 + 600);
  },
  'Aerial': () => {
    setSun(30, 205);
    camera.position.set(900, 420, 900);
    controls.target.set(0, 0, 0);
  },
  'Flotsam': () => {
    setSun(40, 205);
    const b = sunBearing() + 1.2, c = coast(THREE.MathUtils.radToDeg(b));
    const out = new THREE.Vector2(Math.cos(b), Math.sin(b)), side = new THREE.Vector2(-out.y, out.x);
    camera.position.set(c.x + out.x * 75 + side.x * 10, 9, c.y + out.y * 75 + side.y * 10);
    controls.target.set(c.x + out.x * 53.5 - side.x * 8, 0, c.y + out.y * 53.5 - side.y * 8);
    floaters.spawn(camera.position, controls.target.clone().sub(camera.position));
  },
  'Underwater': () => {
    setSun(48, 205);
    // 在岛屿背风面，沿礁石坡面回头望向太阳（光束）
    const a = sunBearing() + Math.PI + 0.3;
    let r = 200;
    while (r < 1000 && islandHeight(Math.cos(a) * r, Math.sin(a) * r) > -9) r += 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    camera.position.set(x, -3.2, z);
    controls.target.set(x - Math.cos(a) * 25, -1.8, z - Math.sin(a) * 25);
    floaters.spawn(camera.position, controls.target.clone().sub(camera.position));
  },
};

let fSun = null;
// --- GUI -----------------------------------------------------------------------
const gui = new GUI({ title: 'Gelatin Water' });
if (mobile) gui.close();   // 手机上打开的面板会遮住大部分屏幕
const ui = { view: 'Lagoon', benchmark: () => benchButton.click(), exposure: 1 };
const VIEW_LABELS = { 'Golden hour': '黄金时刻', 'Breakers': '碎浪', 'Lagoon': '潟湖', 'Surf rock': '拍岸礁石', 'Open ocean': '开阔外海', 'Aerial': '俯瞰', 'Flotsam': '漂浮物', 'Underwater': '水下' };
gui.add(ui, 'view', Object.fromEntries(Object.keys(views).map(k => [VIEW_LABELS[k], k]))).name('镜头').onChange((v) => views[v]());
gui.add(ui, 'benchmark').name('基准测试（不限帧）');

fSun = gui.addFolder('太阳与天空');
fSun.add(sky.params, 'elevation', -2, 70, 0.1).name('太阳仰角').onChange(() => (sunDirty = true));
fSun.add(sky.params, 'azimuth', 0, 360, 0.5).name('方位角').onChange(() => (sunDirty = true));
fSun.add(sky.params, 'sunIntensity', 0, 20, 0.1).name('太阳强度').onChange(() => (sunDirty = true));
fSun.add(sky.params, 'cloudCoverage', 0, 1, 0.01).name('云量').onChange(() => (sunDirty = true));
fSun.add(sky.params, 'turbidity', 1, 10, 0.1).name('浊度').onChange(() => (sunDirty = true));

const op = ocean.params, dirty = () => (ocean.dirty = true);
const fWave = gui.addFolder('海浪');
fWave.add(op, 'windSpeed', 1, 25, 0.1).name('风速').onChange(dirty);
fWave.add(op, 'windDirection', -180, 180, 1).name('风向').onChange(dirty);
fWave.add(op, 'fetchKm', 5, 1000, 1).name('风区长度（km）').onChange(dirty);
fWave.add(op, 'waveScale', 0, 3, 0.01).name('波浪幅度').onChange(dirty);
fWave.add(op, 'spreadBlend', 0, 1, 0.01).name('扩散混合').onChange(dirty);
fWave.add(op, 'swellScale', 0, 3, 0.01).name('涌浪幅度').onChange(dirty);
fWave.add(op, 'swellDirection', -180, 180, 1).name('涌浪方向').onChange(dirty);
fWave.add(op, 'choppiness', 0, 2, 0.01).name('尖锐度');
fWave.add(op, 'timeScale', 0, 3, 0.01).name('时间缩放');

const su = surface.uniforms;
const shoreUi = { amplitude: su.uShoreWave.value.x, wavelength: su.uShoreWave.value.y, speed: su.uShoreWave.value.z, steepness: su.uShoreWave.value.w };
const setShore = () => su.uShoreWave.value.set(shoreUi.amplitude, shoreUi.wavelength, shoreUi.speed, shoreUi.steepness);
const fShore = gui.addFolder('岸边波浪');
fShore.add(shoreUi, 'amplitude', 0, 1.5, 0.01).name('幅度').onChange(setShore);
fShore.add(shoreUi, 'wavelength', 8, 60, 0.5).name('波长').onChange(setShore);
fShore.add(shoreUi, 'speed', 0.3, 2, 0.01).name('速度').onChange(setShore);
fShore.add(shoreUi, 'steepness', 0, 1.5, 0.01).name('陡度').onChange(setShore);
fShore.add(spray.params, 'amount', 0, 3, 0.01).name('水花');
fShore.add(spray.params, 'size', 0.2, 3, 0.01).name('水花大小');

// 水体配色预设（线性 RGB）。观感来自逐通道吸收系数
// （1/m：被吸收最少的通道就是透过浅水看到的颜色）、
// 内散射颜色（深水、底面、水下雾）、薄泡沫的色调以及
// 水下散射（浊度）。'clear' 是默认外观。
const WATER_PRESETS = {
  clear: { absorption: [0.40, 0.062, 0.032], scatter: [0.0, 0.05, 0.08], foam: [0.62, 0.78, 0.82], turbidity: 0.03 },
  tropical: { absorption: [0.36, 0.045, 0.06], scatter: [0.0, 0.085, 0.085], foam: [0.66, 0.86, 0.84], turbidity: 0.02 },
  'toxic green': { absorption: [0.45, 0.1, 1.1], scatter: [0.05, 0.1, 0.004], foam: [0.74, 0.84, 0.42], turbidity: 0.08 },
  purple: { absorption: [0.22, 0.85, 0.1], scatter: [0.05, 0.0, 0.09], foam: [0.8, 0.66, 0.88], turbidity: 0.04 },
  'rust orange': { absorption: [0.1, 0.34, 1.2], scatter: [0.11, 0.035, 0.004], foam: [0.9, 0.72, 0.55], turbidity: 0.1 },
  'murky brown': { absorption: [0.55, 0.62, 0.9], scatter: [0.045, 0.045, 0.022], foam: [0.78, 0.74, 0.6], turbidity: 0.25 },
};

const fWater = gui.addFolder('水体');
const w = {
  preset: 'clear',
  roughness: su.uOptics.value.x, refraction: su.uOptics.value.y, reflectionDistort: su.uOptics.value.z,
  sssPeak: su.uSSS.value.x, sssView: su.uSSS.value.y,
  foamBias: su.uFoam.value.x, foamScale: su.uFoam.value.y, shoreFoamBand: su.uFoam.value.z,
  foamRecovery: op.foamRecovery, caustics: terrain.uniforms.uCausticStrength.value,
  scatter: '#' + su.uScatterColor.value.getHexString(),
  clarity: 1,
};
const absorptionBase = su.uAbsorption.value.clone();
const setWater = () => {
  su.uOptics.value.x = w.roughness; su.uOptics.value.y = w.refraction; su.uOptics.value.z = w.reflectionDistort;
  su.uSSS.value.x = w.sssPeak; su.uSSS.value.y = w.sssView;
  su.uFoam.value.x = w.foamBias; su.uFoam.value.y = w.foamScale; su.uFoam.value.z = w.shoreFoamBand;
  op.foamRecovery = w.foamRecovery;
  terrain.uniforms.uCausticStrength.value = w.caustics;
  su.uScatterColor.value.set(w.scatter);
  su.uAbsorption.value.copy(absorptionBase).multiplyScalar(1 / w.clarity);
};
const applyPreset = () => {
  const p = WATER_PRESETS[w.preset];
  absorptionBase.fromArray(p.absorption);
  w.scatter = '#' + new THREE.Color().fromArray(p.scatter).getHexString();
  su.uFoamTint.value.fromArray(p.foam);
  underwater.params.scattering = p.turbidity;
  setWater();
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
};
const WATER_LABELS = { clear: '清澈', tropical: '热带', 'toxic green': '毒绿', purple: '紫罗兰', 'rust orange': '锈橙', 'murky brown': '浑浊棕' };
fWater.add(w, 'preset', Object.fromEntries(Object.keys(WATER_PRESETS).map(k => [WATER_LABELS[k], k]))).name('配色预设').onChange(applyPreset);
fWater.add(w, 'clarity', 0.2, 4, 0.01).name('清澈度').onChange(setWater);
fWater.addColor(w, 'scatter').name('内散射').onChange(setWater);
fWater.add(w, 'roughness', 0.005, 0.2, 0.001).name('粗糙度').onChange(setWater);
fWater.add(w, 'refraction', 0, 0.2, 0.001).name('折射').onChange(setWater);
fWater.add(w, 'reflectionDistort', 0, 0.2, 0.001).name('反射扭曲').onChange(setWater);
fWater.add(w, 'sssPeak', 0, 6, 0.01).name('SSS 峰值').onChange(setWater);
fWater.add(w, 'sssView', 0, 0.5, 0.001).name('SSS 视角').onChange(setWater);
fWater.add(w, 'foamBias', -0.5, 1.5, 0.01).name('泡沫偏移').onChange(setWater);
fWater.add(w, 'foamScale', 0, 6, 0.01).name('泡沫尺度').onChange(setWater);
fWater.add(w, 'foamRecovery', 0.05, 3, 0.01).name('泡沫恢复').onChange(setWater);
fWater.add(w, 'shoreFoamBand', 0, 2, 0.01).name('岸边泡沫带').onChange(setWater);
fWater.add(w, 'caustics', 0, 2, 0.01).name('焦散').onChange(setWater);
fWater.add(su.uGlint, 'value', 0, 1, 0.01).name('闪光');

const fFloat = gui.addFolder('漂浮物与水下');
const ahead = (d) => {
  const f = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
  return camera.position.clone().addScaledVector(f, d);
};
const floatUi = {
  spawn: () => floaters.spawn(camera.position, camera.getWorldDirection(new THREE.Vector3())),
  drop: () => floaters.add(FLOATER_KINDS[Math.floor(Math.random() * FLOATER_KINDS.length)], ahead(14).setY(Math.max(camWater, 0) + 4)),
  clear: () => floaters.clear(),
};
fFloat.add(floatUi, 'spawn').name('前方生成漂浮物');
fFloat.add(floatUi, 'drop').name('随机投放道具');
fFloat.add(floatUi, 'clear').name('清除');
fFloat.add(floaters.params, 'drag', 0, 6, 0.01).name('阻力');
fFloat.add(floaters.params, 'angularDrag', 0, 4, 0.01).name('角阻力');
fFloat.add(floaters.params, 'buoyancy', 0, 2, 0.01).name('浮力');
fFloat.add(underwater.params, 'scattering', 0, 0.5, 0.001).name('水下散射');
fFloat.add(underwater.params, 'shafts', 0, 4, 0.01).name('光束');
fFloat.add(underwater.params, 'shaftRange', 5, 120, 1).name('光束范围');
fFloat.add(underwater.params, 'meniscus', 0, 1, 0.01).name('弯月面');
fFloat.add(look, 'underwater', 0.2, 2, 0.01).name('水下曝光');

const fPost = gui.addFolder('后期');
fPost.add(ui, 'exposure', 0.25, 4, 0.01).name('曝光补偿');
fPost.add(post.params, 'autoExposure').name('自动曝光');
fPost.add(post.params, 'keyValue', 0.05, 0.6, 0.01).name('曝光关键值');
fPost.add(post.params, 'bloomStrength', 0, 0.5, 0.001).name('泛光强度');
fPost.add(post.params, 'bloomThreshold', 0, 10, 0.01).name('泛光阈值');
fPost.add(post.params, 'contrast', 0.7, 1.6, 0.01).name('对比度');
fPost.add(post.params, 'saturation', 0, 2, 0.01).name('饱和度');

const fQ = gui.addFolder('画质');
const resController = fQ.add(quality, 'resolution', 0.25, 1, 0.05).name('分辨率').onFinishChange(resize);
if (mobile) fQ.add(quality, 'autoResolution').name('自动分辨率');
fQ.add(quality, 'msaa', [2, 4, 8]).name('MSAA').onChange(makeTargets);   // 水面采样解析结果，因此必须启用 MSAA
fQ.add(quality, 'reflections').name('反射');
fQ.add(quality, 'reflectionScale', 0.25, 1, 0.05).name('反射尺度').onFinishChange(makeTargets);
[fWave, fShore, fWater, fFloat, fPost].forEach((f) => f.close());

// --- 帧 ---------------------------------------------------------------------
const gl = renderer.getContext();
const timer = new GpuTimer(gl);
let elapsed = 0;
// 渲染阶段显示名（内部键保持英文）
const PASS_LABELS = { floatShadow: '浮体阴影', caustics: '焦散', query: '高度查询', reflection: '反射', opaque: '不透明', water: '水面', underwater: '水下', post: '后期' };

function renderFrame(dt) {
  elapsed += dt;
  if (sunDirty) applySun();
  timer.beginFrame();

  // 最新的水面高度（滞后 1-3 帧）驱动相机测试与浮体
  if (query.resultCount > 0) camWater = query.result[0];
  floaters.ingest(query, 1);
  floaters.step(dt);
  timer.begin('floatShadow');
  floatShadow.update(renderer, floaters.scene, floaters.bodies, sky.sunDir);
  // 入水条目 -> 涟漪环 + 溅水（按浮体的时钟计时老化）
  for (let i = 0; i < 8; i++) {
    const e = floaters.impacts[i], age = e ? floaters.time - e.t : 1e9;
    su.uImpact.value[i].set(e?.x ?? 0, e?.z ?? 0, age, age < 30 ? e.amp : 0);
    su.uImpactSize.value[i] = e?.size ?? 1;
  }

  ocean.update(dt, timer);
  timer.begin('caustics');
  caustics.update(sky.sunDir);
  surface.update(camera, elapsed % 3600);
  spray.update();
  timer.begin('query');
  const pts = floaters.collectPoints([camera.position]);
  query.submit(pts, floaters.count, floaters.layout, elapsed);

  const camY = camera.position.y;
  const submerged = camY < camWater - 0.3, nearSurface = camY < camWater + 1.2;
  su.uCamSide.value = camY > camWater + 0.5 ? -1 : camY < camWater - 0.5 ? 1 : 0;
  snow.update(camera, hdrRT.height, nearSurface);
  uwComp += ((submerged ? look.underwater : 1) - uwComp) * Math.min(1, dt * 3);
  post.params.exposure = ui.exposure * uwComp;
  // 出水后镜头上的水持续几秒
  post.params.droplets = wasSubmerged && !submerged ? 1 : submerged ? 0 : Math.max(0, post.params.droplets - dt / 5);
  wasSubmerged = submerged;

  timer.begin('reflection');
  if (quality.reflections && !submerged) {
    reflection.render(renderer, scene, camera);
    su.uReflection.value = reflection.target.texture;
  } else su.uReflection.value = emptyReflection;

  timer.begin('opaque');
  renderer.setRenderTarget(hdrRT);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, false);
  renderer.render(scene, camera);

  timer.begin('water');
  su.uShadowMap.value = sunLight.shadow.map.depthTexture;
  hdrRT.resolveDepthBuffer = nearSurface;   // 只有水下阶段需要带水面的深度
  renderer.render(waterScene, camera);
  hdrRT.resolveDepthBuffer = true;

  let frame = hdrRT.texture;
  if (nearSurface) {
    timer.begin('underwater');
    frame = underwater.render(renderer, hdrRT, camY < camWater - 0.8);
  }

  timer.begin('post');
  post.render(frame, dt);
  timer.endFrame();
}

function clampCamera() {
  // 可自由下潜；只是不要进入地面
  const floor = islandHeight(camera.position.x, camera.position.z) + 0.8;
  if (camera.position.y < floor) camera.position.y = floor;
}

// Chrome/ANGLE 的 `readPixels` 和 `finish` 不会等待 GPU，因此用同步围栏来同步。
async function gpuFence() {
  const s = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  while (gl.clientWaitSync(s, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((r) => setTimeout(r, 1));
  gl.deleteSync(s);
}

// 背靠背渲染帧（渲染循环暂停），计时到 GPU 完成；同时返回在满频率下
// 测得的逐阶段 GPU 时间
let benchmarking = false;
async function runBenchmark(frames = 300) {
  if (benchmarking) return null;
  benchmarking = true;
  timer.drain();
  for (let i = 0; i < 20; i++) renderFrame(1 / 200);
  await gpuFence();
  timer.drain();
  timer.keep = true;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) renderFrame(1 / 200);
  await gpuFence();
  const ms = (performance.now() - t0) / frames;
  const passes = timer.drain();
  timer.keep = false;
  benchmarking = false;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const gpu = Object.values(passes).reduce((a, b) => a + b, 0);
  bench = `基准测试 ${ms.toFixed(2)} 毫秒/帧 = ${(1000 / ms).toFixed(0)} 帧每秒${timer.available ? `（GPU ${gpu.toFixed(2)} 毫秒）` : ''}`
    + Object.entries(passes).map(([k, v]) => `
  ${(PASS_LABELS[k] ?? k).padEnd(12)} ${v.toFixed(3)} 毫秒`).join('');
  console.log(`${size.x}×${size.y} ${bench}`);
  return { ms, gpu, passes };
}
window.runBenchmark = runBenchmark;
window.app = {
  camera, controls, sky, post, surface, ocean, terrain, timer, views, quality, renderer, floaters, query, underwater, spray, snow, caustics, floatShadow,
  camWater: () => camWater, markSun: () => (sunDirty = true),
};

// --- HUD + 循环 ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const hud = $('hud'), graph = $('pGraph').getContext('2d'), uncapButton = $('pUncap'), fpsHistory = [];
let bench = '', frames = 0, lastHud = performance.now(), last = performance.now(), uncapped = false;
$('pGpu').textContent = (() => {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const raw = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '未知 GPU';
  return raw.split(', ')[1]?.replace(/ \(0x.*$/, '') || raw;   // "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x2504) ...)"
})();
uncapButton.onclick = () => {
  uncapped = !uncapped;
  uncapButton.textContent = uncapped ? '跟随刷新率' : '解除限帧';
  uncapButton.classList.toggle('on', uncapped);
  fpsHistory.length = 0;
};
// 仅在请求时运行：它的 320 帧会冻结屏幕，加载时直接运行会显得卡顿
const benchButton = $('pBench');
benchButton.onclick = async () => {
  if (benchButton.disabled) return;
  benchButton.disabled = true;
  benchButton.textContent = '基准测试中…';
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));   // 让标签先绘制出来
  await runBenchmark();
  benchButton.disabled = false;
  benchButton.textContent = '运行基准测试';
};

function updateHud(now) {
  const fps = (frames * 1000) / (now - lastHud);
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  $('pSpec').textContent = `${size.x}×${size.y} · ${quality.msaa}× MSAA · ${mobile ? '移动端' : '桌面端'} 配置档`;
  $('pFps').textContent = fps.toFixed(0);
  $('pMode').textContent = uncapped ? '不限帧' : '垂直同步';
  $('pMs').textContent = `${(1000 / fps).toFixed(2)} 毫秒/帧`;
  fpsHistory.push(fps);
  if (fpsHistory.length > 40) fpsHistory.shift();
  const { width: w, height: h } = graph.canvas, lo = Math.min(...fpsHistory) * 0.9, hi = Math.max(...fpsHistory) * 1.05;
  graph.clearRect(0, 0, w, h);
  graph.beginPath();
  fpsHistory.forEach((v, i) => graph.lineTo((w * i) / Math.max(1, fpsHistory.length - 1), h - (h * (v - lo)) / (hi - lo || 1)));
  graph.strokeStyle = '#2cc9ff';
  graph.lineWidth = 3;
  graph.stroke();
  let text = '';
  if (timer.available && timer.total > 0) {
    // 垂直同步时 GPU 会降频，因此这些读数偏高；不限帧或基准测试会在满频率下测量
    text += `GPU 计时 ${timer.total.toFixed(2)} 毫秒${uncapped ? '' : '（垂直同步待机频率）'}`;
    for (const [k, v] of Object.entries(timer.ms)) text += `\n  ${(PASS_LABELS[k] ?? k).padEnd(10)} ${v.toFixed(3)} 毫秒`;
  }
  if (bench) text += `${text ? '\n' : ''}${bench}`;
  hud.textContent = text;
  frames = 0;
  lastHud = now;
}

// 移动端：从配置档的分辨率逐步下调以保持 60 fps，按 2 秒窗口判断
// （一帧超过 20 ms 即视为错过一次垂直同步），帧时间恢复干净后再回升。
// 降到下限仍掉帧时，每隔一个垂直同步渲染一次以稳定在 30 帧。
const auto = { n: -240, missed: 0, clean: 0, top: quality.resolution, cap30: false, odd: false };   // 跳过启动阶段
function autoResolution(ms) {
  if (ms > 250) return;   // 标签页切换或基准测试，不是加载
  if (++auto.n <= 0) return;
  if (ms > (auto.cap30 ? 40 : 20)) auto.missed++;
  if (auto.n < 120 || auto.cap30) return;
  const r = quality.resolution, miss = auto.missed / auto.n;
  auto.n = auto.missed = 0;
  if (miss > 0.04) {
    auto.clean = 0;
    if (r > 0.5) setResolution(r - 0.05);
    else if (miss > 0.25) auto.cap30 = true;
  } else if (miss <= 0.01 && ++auto.clean >= 3 && r < auto.top) {
    auto.clean = 0;
    setResolution(r + 0.05);
  }
}
function setResolution(r) {
  quality.resolution = Math.round(r * 20) / 20;
  resController.updateDisplay();
  resize();
  auto.n = -60;   // 调整分辨率会造成卡顿；让它稳定下来
}

function tick(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  controls.update();
  clampCamera();
  renderFrame(dt);
  frames++;
  if (now - lastHud > 500) updateHud(now);
}

function loop(now) {
  if (uncapped) { spin(); return; }
  if (auto.cap30 && (auto.odd = !auto.odd)) { requestAnimationFrame(loop); return; }
  if (benchmarking) last = now;
  else {
    if (quality.autoResolution) autoResolution(now - last);
    tick(now);
  }
  requestAnimationFrame(loop);
}

// 不限帧：帧背靠背渲染、脱离显示器的时钟（每次刷新仍显示最新一帧），
// 最多三个在途，这样计数器读取的是 GPU 已完成的帧
const fences = [], chan = new MessageChannel();
chan.port1.onmessage = spin;
function spin() {
  if (!uncapped || document.hidden) {   // 隐藏：回到 `rAF`，它在可见前会暂停
    fences.splice(0).forEach((s) => gl.deleteSync(s));
    requestAnimationFrame(loop);
    return;
  }
  while (fences.length && gl.clientWaitSync(fences[0], 0, 0) !== gl.TIMEOUT_EXPIRED) gl.deleteSync(fences.shift());
  if (fences.length < 3 && !benchmarking) {
    tick(performance.now());
    fences.push(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0));
    gl.flush();
  }
  chan.port2.postMessage(0);
}

resize();
applySun();
views[ui.view]();
controls.update();
requestAnimationFrame(loop);
