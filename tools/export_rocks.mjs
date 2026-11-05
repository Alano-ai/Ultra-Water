// Read the actual scene generator, including its seeded instance matrices.
// Usage: node tools/export_rocks.mjs [output-directory]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as THREE from 'three';
import { createTerrain } from '../src/scene/terrain.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || path.join(root, 'exports/rocks'));
fs.mkdirSync(output, { recursive: true });
const terrain = createTerrain({ sky: {}, water: { uShoreExtent: { value: 1800 } } });
const rocks = terrain.group.children.find(o => o.isInstancedMesh);
const ground = terrain.group.children.find(o => !o.isInstancedMesh);
const serialize = geometry => ({
  positions: Array.from(geometry.attributes.position.array),
  normals: Array.from(geometry.attributes.normal.array),
  indices: Array.from(geometry.index.array),
  colors: geometry.attributes.color ? Array.from(geometry.attributes.color.array) : null,
});
const matrix = new THREE.Matrix4();
const payload = {
  source: 'src/scene/terrain.js:createTerrain (unmodified)',
  units: 'meters',
  basis: 'Three.js X/Y/Z -> Blender X/-Z/Y',
  geometry: serialize(rocks.geometry),
  instances: Array.from({ length: rocks.count }, (_, i) => {
    rocks.getMatrixAt(i, matrix);
    return {
      name: i === rocks.count - 1 ? 'SM_Rock_Hero' : `SM_Rock_${String(i + 1).padStart(3, '0')}`,
      hero: i === rocks.count - 1,
      matrix: matrix.toArray(),
    };
  }),
  // Includes the integrated rocky mountain ridges, which are not separate rocks.
  terrain: serialize(ground.geometry),
};
const sourcePath = path.join(output, '_source_geometry.json');
fs.writeFileSync(sourcePath, JSON.stringify(payload));
console.log(`Extracted ${rocks.count} rocks, ${rocks.geometry.attributes.position.count} vertices / ${rocks.geometry.index.count / 3} triangles each.`);
const run = spawnSync('blender', ['-b', '--factory-startup', '--python-exit-code', '1', '--python', path.join(root, 'tools/export_rocks_blender.py'), '--', output], { stdio: 'inherit' });
if (run.status !== 0) process.exit(run.status || 1);
for (const [source, destination] of [
  ['tools/import_rocks_ue.py', 'Import_Into_UE.py'],
  ['docs/rock-assets/使用说明.txt', '使用说明.txt'],
  ['LICENSE', 'LICENSE'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ['node_modules/three/LICENSE', 'THREE-LICENSE.txt'],
]) fs.copyFileSync(path.join(root, source), path.join(output, destination));
