import * as THREE from 'three';
import { islandHeight, ISLAND_SIZE } from './islandHeight.js';

// 岛屿的网格面，外加同覆盖范围的浮点高度图，
// 水面用它取得岸边水深（波浪阻尼、浅水颜色、泡沫）。
export function buildTerrain(segments = 384, mapSize = 256) {
  const geo = new THREE.PlaneGeometry(ISLAND_SIZE, ISLAND_SIZE, segments, segments);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, islandHeight(pos.getX(i), pos.getZ(i)));
  // 丢弃深海海床：约 34 m 以下透过水面只能看到不足 5%，所以在广角镜头里
  // 它只是在白白遮蔽大半个屏幕
  const idx = geo.index.array, keep = [];
  for (let t = 0; t < idx.length; t += 3) {
    if (Math.max(pos.getY(idx[t]), pos.getY(idx[t + 1]), pos.getY(idx[t + 2])) > -34) keep.push(idx[t], idx[t + 1], idx[t + 2]);
  }
  geo.setIndex(keep);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const data = new Float32Array(mapSize * mapSize);
  for (let j = 0; j < mapSize; j++) {
    for (let i = 0; i < mapSize; i++) {
      const x = ((i + 0.5) / mapSize - 0.5) * ISLAND_SIZE;
      const z = ((j + 0.5) / mapSize - 0.5) * ISLAND_SIZE;
      data[j * mapSize + i] = islandHeight(x, z);
    }
  }
  const heightMap = new THREE.DataTexture(data, mapSize, mapSize, THREE.RedFormat, THREE.FloatType);
  heightMap.minFilter = heightMap.magFilter = THREE.LinearFilter;
  heightMap.wrapS = heightMap.wrapT = THREE.ClampToEdgeWrapping;
  heightMap.needsUpdate = true;

  return { geometry: geo, heightMap };
}
