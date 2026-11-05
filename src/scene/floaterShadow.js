import * as THREE from 'three';

// 只为漂浮道具生成的锐利太阳阴影：每帧根据刚体范围拟合的正交太阳相机
// 渲染出的深度贴图，这样大而静态的太阳阴影贴图（地形 + 岩石）就不必为它们
// 重新渲染。水面、地形、道具和水下光束都通过 floatShadow() 取用它。
export const FLOAT_SHADOW_GLSL = /* glsl */`
uniform highp sampler2DShadow uFloatShadow;
uniform mat4 uFloatShadowMatrix;
uniform float uFloatShadowBias;   // depth units; 0 = no casters this frame
float floatShadow(vec3 p) {
  if (uFloatShadowBias <= 0.0) return 1.0;
  vec3 sc = (uFloatShadowMatrix * vec4(p, 1.0)).xyz;
  if (any(lessThan(sc, vec3(0.0))) || any(greaterThan(sc, vec3(1.0)))) return 1.0;
  return texture(uFloatShadow, vec3(sc.xy, sc.z - uFloatShadowBias));
}`;

const _c = new THREE.Vector3();

export class FloaterShadow {
  constructor(size = 1024) {
    const depth = new THREE.DepthTexture(size, size, THREE.FloatType);
    depth.compareFunction = THREE.LessEqualCompare;   // 硬件 2x2 PCF
    depth.minFilter = depth.magFilter = THREE.LinearFilter;
    this.target = new THREE.WebGLRenderTarget(size, size, { format: THREE.RedFormat, depthTexture: depth, generateMipmaps: false });
    this.camera = new THREE.OrthographicCamera();
    this.material = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
    this.uniforms = {
      uFloatShadow: { value: depth },
      uFloatShadowMatrix: { value: new THREE.Matrix4() },
      uFloatShadowBias: { value: 0 },
    };
  }

  // root：只包含浮体的 Scene；bodies：[{ pos, radius }]；sunDir：指向太阳的方向
  update(renderer, root, bodies, sunDir) {
    const u = this.uniforms;
    // 深度纹理在首次渲染时才获得比较模式；在此之前，任何绑定到它的
    // 阴影采样器都会使绘制失败
    if (!this.ready) { this.clear(renderer); this.ready = true; }
    if (!bodies.length || sunDir.y <= 0.01) { u.uFloatShadowBias.value = 0; return; }
    _c.set(0, 0, 0);
    for (const b of bodies) _c.add(b.pos);
    _c.divideScalar(bodies.length);
    let r = 1;
    for (const b of bodies) r = Math.max(r, b.pos.distanceTo(_c) + b.radius);
    // 接收者位于投射者背后沿光线的方向上，因此 xy 覆盖范围就是投射者的
    // 范围；深度范围远超它们，以便低太阳角度下覆盖到海底
    const cam = this.camera;
    cam.left = cam.bottom = -r;
    cam.right = cam.top = r;
    cam.near = 1;
    cam.far = r + 3000;
    cam.position.copy(_c).addScaledVector(sunDir, r + 20);
    cam.lookAt(_c);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    u.uFloatShadowMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    u.uFloatShadowBias.value = 0.03 / (cam.far - cam.near);

    const prev = renderer.getRenderTarget();
    root.overrideMaterial = this.material;
    renderer.setRenderTarget(this.target);
    renderer.clear(false, true, false);
    renderer.render(root, cam);
    root.overrideMaterial = null;
    renderer.setRenderTarget(prev);
  }

  clear(renderer) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.clear(false, true, false);
    renderer.setRenderTarget(prev);
  }
}
