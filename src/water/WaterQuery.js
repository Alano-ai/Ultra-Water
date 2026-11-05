import * as THREE from 'three';
import { FullscreenQuad, rawPass } from '../engine/fullscreen.js';
import { WATER_GLSL } from './OceanSurface.js';

// GPU -> CPU 水面查询。每帧调用方提交世界坐标 xz 点；一个
// 极小的渲染阶段精确求值水面网格所绘制的水面（FFT + 海岸波浪，
// 尖锐度位移已反解），结果通过 PBO 异步回读，
// 因此绝不会让 GPU 停顿。结果滞后 1-3 帧，对浮力而言足够。
const FRAG = /* glsl */`
precision highp float;
precision highp int;
${WATER_GLSL}
uniform highp sampler2D uQueries;
out vec4 outColor;
void main() {
  vec2 q = texelFetch(uQueries, ivec2(gl_FragCoord.xy), 0).xy;
  vec3 d = waterAt(q, vec3(0.0));
  outColor = vec4(d.y, d.x, d.z, 1.0);
}`;

export class WaterQuery {
  constructor(renderer, surface, capacity = 256) {
    this.renderer = renderer;
    this.capacity = capacity;
    this.input = new THREE.DataTexture(new Float32Array(capacity * 4), capacity, 1, THREE.RGBAFormat, THREE.FloatType);
    this.target = new THREE.WebGLRenderTarget(capacity, 1, {
      type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, generateMipmaps: false,
    });
    this.quad = new FullscreenQuad(rawPass(FRAG, { ...surface.uniforms, uQueries: { value: this.input } }));
    this.inFlight = 0;
    // 最近一次完成的回读：每个点的 (height, dispX, dispZ, 1)，以及当时请求的内容
    this.result = new Float32Array(capacity * 4);
    this.resultCount = 0;
    this.resultTag = -1;
    this.resultTime = 0;
  }

  // xz：x,z 对的 Float32Array。tag 标识点的排布（旧排布产生的
  // 被忽略的结果由调用方自行检测）。
  submit(xz, count, tag, time) {
    if (this.inFlight >= 2 || count === 0) return;
    count = Math.min(count, this.capacity);
    const d = this.input.image.data;
    for (let i = 0; i < count; i++) { d[i * 4] = xz[i * 2]; d[i * 4 + 1] = xz[i * 2 + 1]; }
    this.input.needsUpdate = true;
    this.quad.render(this.renderer, this.target);
    this.inFlight++;
    const buf = new Float32Array(count * 4);
    this.renderer.readRenderTargetPixelsAsync(this.target, 0, 0, count, 1, buf)
      .then(() => {
        this.result.set(buf);
        this.resultCount = count;
        this.resultTag = tag;
        this.resultTime = time;
      })
      .catch(() => {})
      .finally(() => { this.inFlight--; });
  }
}
