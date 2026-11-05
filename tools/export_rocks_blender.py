"""Build editable meshes and portable material atlases from the original scene.

Run through export_rocks.mjs. No live Blender session is modified.
"""
import bpy
import bmesh
import json
import math
import sys
from pathlib import Path
import numpy as np
from mathutils import Matrix, Vector

OUT = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
DATA = json.loads((OUT / '_source_geometry.json').read_text())
for folder in ('fbx_individual', 'textures', 'reference'):
    (OUT / folder).mkdir(exist_ok=True)
SIZE, GRID, TILE = 4096, 10, 409
PAD = 6
C = np.array([[1., 0., 0.], [0., 0., -1.], [0., 1., 0.]])
vertices = np.asarray(DATA['geometry']['positions']).reshape(-1, 3)
faces = np.asarray(DATA['geometry']['indices']).reshape(-1, 3)
source_ao = np.asarray(DATA['geometry']['colors']).reshape(-1, 3)

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
layout = bpy.context.scene
layout.name = 'Original_Layout'
layout.unit_settings.system = 'METRIC'
layout.unit_settings.scale_length = 1.0
layout['source_units'] = 'meters; sea level is Z=0'

template = bpy.data.meshes.new('Rock_Source_Editable')
template.from_pydata((vertices @ C.T).tolist(), [], faces.tolist())
template.update()
temp = bpy.data.objects.new('_UV_Template', template)
layout.collection.objects.link(temp)
bpy.context.view_layer.objects.active = temp
temp.select_set(True)
for poly in template.polygons:
    poly.use_smooth = True
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.025)
bpy.ops.object.mode_set(mode='OBJECT')
template.uv_layers.active.name = 'UV0_MaterialAtlas'
uv_template = np.array([item.uv[:] for item in template.uv_layers.active.data]).reshape(-1, 3, 2)
lightmap = template.uv_layers.new(name='UV1_Lightmap')
for dst, src in zip(lightmap.data, template.uv_layers[0].data):
    dst.uv = src.uv
template.uv_layers.active_index = 0
ao = template.color_attributes.new(name='Source_Crevice_AO', type='FLOAT_COLOR', domain='POINT')
ao.data.foreach_set('color', np.column_stack((source_ao, np.ones(len(vertices)))).ravel())
bpy.data.objects.remove(temp, do_unlink=True)

def fract(x):
    return x - np.floor(x)

def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)

def hash3(p):
    p = fract(p * .1031)
    p = p + np.sum(p * (p[:, [2, 1, 0]] + 31.32), axis=1)[:, None]
    return fract((p[:, 0] + p[:, 1]) * p[:, 2])

def noise3(p):
    i, f = np.floor(p), fract(p)
    u = f * f * (3 - 2 * f)
    result = np.zeros(len(p))
    for x in (0, 1):
        for y in (0, 1):
            for z in (0, 1):
                w = (u[:, 0] if x else 1 - u[:, 0]) * (u[:, 1] if y else 1 - u[:, 1]) * (u[:, 2] if z else 1 - u[:, 2])
                result += w * hash3(i + [x, y, z])
    return result

def noise2(p):
    def h(q):
        p3 = fract(q[:, [0, 1, 0]] * .1031)
        p3 += np.sum(p3 * (p3[:, [1, 2, 0]] + 33.33), axis=1)[:, None]
        return fract((p3[:, 0] + p3[:, 1]) * p3[:, 2])
    i, f = np.floor(p), fract(p)
    u = f * f * (3 - 2 * f)
    return ((1 - u[:, 1]) * ((1 - u[:, 0]) * h(i) + u[:, 0] * h(i + [1, 0]))
            + u[:, 1] * ((1 - u[:, 0]) * h(i + [0, 1]) + u[:, 0] * h(i + [1, 1])))

def shade(p, n):
    # Same static rock albedo and equilibrium wetness formulas as terrain.js.
    r1, r2 = noise3(p * .9), noise3(p * 3.7 + 7)
    strata = np.sin(p[:, 1] * 2.2 + r1 * 3) * .5 + .5
    blend = r1 * .6 + strata * .25 + r2 * .15
    albedo = np.array([.27, .25, .23]) + blend[:, None] * np.array([.25, .22, .18])
    tide = (1 - smooth(.4, 1.3 + .6 * r1, p[:, 1])) * smooth(-3, -.8, p[:, 1])
    algae = np.array([.10, .11, .07]) * (.7 + .6 * r2[:, None])
    albedo = albedo * (1 - tide[:, None] * .8) + algae * tide[:, None] * .8
    salt = smooth(.7, .92, np.clip(n[:, 1], 0, 1)) * smooth(1, 2, p[:, 1]) * smooth(.55, .8, r2) * .55
    albedo = albedo * (1 - salt[:, None]) + np.array([.80, .78, .72]) * salt[:, None]
    n1 = noise2(p[:, [0, 2]] * .08)
    wet = 1 - smooth(.35, 1.3 + .5 * n1, p[:, 1])
    under = smooth(0, -.8, p[:, 1])
    multiplier = (.8 * albedo + .06) * (1 - under[:, None]) + .6 * under[:, None]
    albedo *= (1 - wet[:, None]) + multiplier * wet[:, None]
    rough = .85 + (.32 - .85) * wet * smooth(-.05, .05, p[:, 1])
    return albedo, rough

def bump_height(p):
    return .6 * noise3(p * 1.6) + .25 * noise3(p * 3.7 + 7) + .15 * noise3(p * 9)

def normalize(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)

# Rasterize the template UV just once. Every instance has identical topology.
pixel_tri = np.full((TILE, TILE), -1, dtype=np.int32)
pixel_bary = np.zeros((TILE, TILE, 3), dtype=np.float32)
uv_pixels = PAD + uv_template * (TILE - 2 * PAD)
for index, triangle in enumerate(uv_pixels):
    lo = np.maximum(np.floor(triangle.min(axis=0)).astype(int), 0)
    hi = np.minimum(np.ceil(triangle.max(axis=0)).astype(int), TILE - 1)
    yy, xx = np.mgrid[lo[1]:hi[1] + 1, lo[0]:hi[0] + 1]
    points = np.stack((xx + .5, yy + .5), axis=-1)
    a, b, c = triangle
    ab, ac = b - a, c - a
    det = ab[0] * ac[1] - ac[0] * ab[1]
    if abs(det) < 1e-10:
        continue
    d = points - a
    v = (d[..., 0] * ac[1] - d[..., 1] * ac[0]) / det
    w = (ab[0] * d[..., 1] - ab[1] * d[..., 0]) / det
    bary = np.stack((1 - v - w, v, w), axis=-1)
    mask = np.min(bary, axis=-1) >= -1e-6
    pixel_tri[yy[mask], xx[mask]] = index
    pixel_bary[yy[mask], xx[mask]] = bary[mask]
py, px = np.where(pixel_tri >= 0)
tri_ids = pixel_tri[py, px]
barys = pixel_bary[py, px]
tri_verts = faces[tri_ids]

# Build a nearest-neighbour dilation map for UV island gutters (tile-local).
nearest_y, nearest_x = np.indices((TILE, TILE))
covered = pixel_tri >= 0
for _ in range(PAD):
    previous = covered.copy()
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        shifted = np.roll(previous, (dy, dx), axis=(0, 1))
        shifted[:dy if dy > 0 else 0, :] = False
        if dy < 0:
            shifted[dy:, :] = False
        shifted[:, :dx if dx > 0 else 0] = False
        if dx < 0:
            shifted[:, dx:] = False
        add = shifted & ~covered
        nearest_y[add] = np.roll(nearest_y, (dy, dx), axis=(0, 1))[add]
        nearest_x[add] = np.roll(nearest_x, (dy, dx), axis=(0, 1))[add]
        covered |= add

atlases = {
    'BaseColor': np.full((SIZE, SIZE, 4), [.3, .28, .25, 1], dtype=np.float32),
    'Roughness': np.ones((SIZE, SIZE, 4), dtype=np.float32),
    'Normal_OpenGL': np.full((SIZE, SIZE, 4), [.5, .5, 1, 1], dtype=np.float32),
}
rocks, manifest = [], []
for i, entry in enumerate(DATA['instances']):
    m = np.asarray(entry['matrix']).reshape(4, 4).T
    world_three = vertices @ m[:3, :3].T + m[:3, 3]
    world_blender = world_three @ C.T
    # Pivot at the centre of the bottom bounding face; baked rotation and scale.
    lo, hi = world_blender.min(axis=0), world_blender.max(axis=0)
    pivot = np.array([(lo[0] + hi[0]) * .5, (lo[1] + hi[1]) * .5, lo[2]])
    mesh = template.copy()
    mesh.name = entry['name'] + '_Mesh'
    mesh.vertices.foreach_set('co', (world_blender - pivot).ravel())
    mesh.update()
    obj = bpy.data.objects.new(entry['name'], mesh)
    layout.collection.objects.link(obj)
    obj.location = pivot
    obj['source_instance_index'] = i
    obj['source_three_matrix'] = entry['matrix']
    obj['hero'] = entry['hero']
    obj['pivot'] = 'bottom-center; rotation and scale baked into vertices'
    rocks.append(obj)
    tx, ty = (i % GRID) * TILE, (i // GRID) * TILE
    for item, uv in zip(mesh.uv_layers[0].data, uv_template.reshape(-1, 2)):
        item.uv = ((tx + PAD + uv[0] * (TILE - 2 * PAD)) / SIZE,
                   (ty + PAD + uv[1] * (TILE - 2 * PAD)) / SIZE)
    # Blender smooth normals are used for both the rasterizer and exported tangents.
    vertex_normals = np.array([v.normal[:] for v in mesh.vertices])
    positions = np.sum(world_blender[tri_verts] * barys[..., None], axis=1)
    normals = normalize(np.sum(vertex_normals[tri_verts] * barys[..., None], axis=1))
    p3, n3 = positions @ C, normals @ C
    albedo, rough = shade(p3, n3)
    gradient = np.column_stack([(bump_height(p3 + np.eye(3)[axis] * .005) - bump_height(p3 - np.eye(3)[axis] * .005)) / .01 for axis in range(3)]) @ C.T
    gradient -= np.sum(gradient * normals, axis=1)[:, None] * normals
    bumped = normalize(normals - .3 * gradient)
    # Reconstruct tangent frames with the same UV chart orientation as the mesh.
    wp = world_blender[faces]
    e1, e2 = wp[:, 1] - wp[:, 0], wp[:, 2] - wp[:, 0]
    du1, du2 = uv_template[:, 1] - uv_template[:, 0], uv_template[:, 2] - uv_template[:, 0]
    det = du1[:, 0] * du2[:, 1] - du1[:, 1] * du2[:, 0]
    tangent = (e1 * du2[:, 1, None] - e2 * du1[:, 1, None]) / det[:, None]
    bitangent = (-e1 * du2[:, 0, None] + e2 * du1[:, 0, None]) / det[:, None]
    t = tangent[tri_ids]
    t = normalize(t - np.sum(t * normals, axis=1)[:, None] * normals)
    b = np.cross(normals, t)
    b *= np.sign(np.sum(b * bitangent[tri_ids], axis=1))[:, None]
    normal_rgb = np.stack((np.sum(bumped * t, axis=1), np.sum(bumped * b, axis=1), np.sum(bumped * normals, axis=1)), axis=1) * .5 + .5
    for key, values in (('BaseColor', albedo), ('Roughness', np.repeat(rough[:, None], 3, axis=1)), ('Normal_OpenGL', normal_rgb)):
        tile = atlases[key][ty:ty + TILE, tx:tx + TILE]
        tile[py, px, :3] = values
        tile[covered, :3] = tile[nearest_y[covered], nearest_x[covered], :3]
    manifest.append({
        'name': obj.name, 'hero': entry['hero'], 'vertices': len(mesh.vertices), 'triangles': len(mesh.polygons),
        'blender_location_m': pivot.tolist(),
        'ue_location_cm': [float(pivot[0] * 100), float(-pivot[1] * 100), float(pivot[2] * 100)],
        'dimensions_m': (hi - lo).tolist(), 'fbx': f'fbx_individual/{obj.name}.fbx',
    })
    if (i + 1) % 10 == 0 or entry['hero']:
        print(f'BAKED {i + 1}/{len(DATA["instances"])}', flush=True)

images = {}
for key, pixels in atlases.items():
    image = bpy.data.images.new('T_Rock_' + key, width=SIZE, height=SIZE, alpha=False, float_buffer=False)
    # Byte-buffer images expose encoded values through pixels; encode explicitly.
    # Setting the color-space tag alone does not encode generated byte pixels.
    if key == 'BaseColor':
        rgb = pixels[:, :, :3]
        pixels[:, :, :3] = np.where(rgb <= .0031308, rgb * 12.92, 1.055 * np.maximum(rgb, 0) ** (1 / 2.4) - .055)
    image.colorspace_settings.name = 'sRGB' if key == 'BaseColor' else 'Non-Color'
    image.pixels.foreach_set(pixels.ravel())
    image.filepath_raw = str(OUT / 'textures' / (image.name + '.png'))
    image.file_format = 'PNG'
    image.save()
    image.filepath = str(OUT / 'textures' / (image.name + '.png'))
    image.pack()
    images[key] = image
    print('SAVED texture', key, flush=True)
dx = atlases['Normal_OpenGL'].copy()
dx[:, :, 1] = 1 - dx[:, :, 1]
image_dx = bpy.data.images.new('T_Rock_Normal_DirectX', width=SIZE, height=SIZE, alpha=False)
image_dx.colorspace_settings.name = 'Non-Color'
image_dx.pixels.foreach_set(dx.ravel())
image_dx.filepath_raw = str(OUT / 'textures' / 'T_Rock_Normal_DirectX.png')
image_dx.file_format = 'PNG'
image_dx.save()
bpy.data.images.remove(image_dx)
del atlases, dx

mat = bpy.data.materials.new('M_Rock_Baked')
mat.use_nodes = True
bsdf = next(node for node in mat.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
bsdf.inputs['Metallic'].default_value = 0
bsdf.location = (100, 40)
for row, (key, socket) in enumerate((('BaseColor', 'Base Color'), ('Roughness', 'Roughness'), ('Normal_OpenGL', 'Normal'))):
    tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image = images[key]
    tex.label = key
    tex.location = (-600, 250 - row * 280)
    tex.interpolation = 'Linear'
    if key == 'Normal_OpenGL':
        normal = mat.node_tree.nodes.new('ShaderNodeNormalMap')
        normal.location = (-230, -300)
        normal.uv_map = 'UV0_MaterialAtlas'
        mat.node_tree.links.new(tex.outputs['Color'], normal.inputs['Color'])
        mat.node_tree.links.new(normal.outputs['Normal'], bsdf.inputs[socket])
    else:
        mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs[socket])
for obj in rocks:
    obj.data.materials.append(mat)

def select(objects):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]

def fbx(filepath, objects):
    select(objects)
    bpy.ops.export_scene.fbx(
        filepath=str(filepath), use_selection=True, object_types={'MESH'},
        global_scale=1.0, apply_unit_scale=True, apply_scale_options='FBX_SCALE_UNITS',
        axis_forward='-Y', axis_up='Z', use_space_transform=True, bake_space_transform=False,
        mesh_smooth_type='FACE', use_tspace=True, use_mesh_modifiers=True,
        add_leaf_bones=False, bake_anim=False, path_mode='RELATIVE', embed_textures=False,
    )

fbx(OUT / 'Rocks_OriginalLayout.fbx', rocks)
for obj in rocks:
    location = obj.location.copy()
    obj.location = (0, 0, 0)
    fbx(OUT / 'fbx_individual' / (obj.name + '.fbx'), [obj])
    obj.location = location
select(rocks)
bpy.ops.export_scene.gltf(filepath=str(OUT / 'Rocks_OriginalLayout.glb'), export_format='GLB',
                          use_selection=True, export_texcoords=True, export_normals=True,
                          export_tangents=True, export_attributes=True, export_cameras=False,
                          export_lights=False, export_extras=True)

# A second scene provides a practical, well-lit catalogue. Meshes stay editable,
# with one mesh datablock per source rock (shared only between the two scenes).
catalog = bpy.data.scenes.new('Asset_Catalog')
catalog.unit_settings.system = 'METRIC'
catalog.unit_settings.scale_length = 1.0
for i, obj in enumerate(rocks):
    clone = obj.copy()
    clone.name = obj.name + '_Catalog'
    clone.location = ((i % 10) * 24, -(i // 10) * 24, 0)
    catalog.collection.objects.link(clone)

world = bpy.data.worlds.new('Studio_World')
world.use_nodes = True
background = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
background.inputs['Color'].default_value = (.16, .19, .23, 1)
background.inputs['Strength'].default_value = .7
catalog.world = world
camera_data = bpy.data.cameras.new('Catalog_Camera')
camera = bpy.data.objects.new('Catalog_Camera', camera_data)
catalog.collection.objects.link(camera)
camera.location = (235, -335, 290)
target = Vector((108, -100, 0))
camera.rotation_euler = (target - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera_data.type = 'ORTHO'
camera_data.ortho_scale = 360
catalog.camera = camera
sun_data = bpy.data.lights.new('Studio_Key', type='SUN')
sun_data.energy = 3
sun = bpy.data.objects.new('Studio_Key', sun_data)
sun.rotation_euler = (math.radians(20), math.radians(-30), math.radians(-25))
catalog.collection.objects.link(sun)
floor_mesh = bpy.data.meshes.new('Preview_Floor')
floor_mesh.from_pydata([(-30, -250, -.05), (260, -250, -.05), (260, 40, -.05), (-30, 40, -.05)], [], [(0, 1, 2, 3)])
floor = bpy.data.objects.new('Preview_Floor', floor_mesh)
catalog.collection.objects.link(floor)
floor_mat = bpy.data.materials.new('Preview_Floor_Material')
floor_mat.use_nodes = True
floor_bsdf = next(n for n in floor_mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
floor_bsdf.inputs['Base Color'].default_value = (.13, .16, .18, 1)
floor_bsdf.inputs['Roughness'].default_value = .9
floor.data.materials.append(floor_mat)

# Include the integrated rocky ridges in an optional reference scene, since the
# island is one continuous mesh and has no separate mountain-rock objects.
reference = bpy.data.scenes.new('Terrain_Reference')
reference.unit_settings.system = 'METRIC'
reference.unit_settings.scale_length = 1
g = DATA['terrain']
ground_mesh = bpy.data.meshes.new('Island_Terrain_Reference')
ground_verts = np.asarray(g['positions']).reshape(-1, 3)
ground_mesh.from_pydata((ground_verts @ C.T).tolist(), [], np.asarray(g['indices']).reshape(-1, 3).tolist())
ground_mesh.update()
ground_obj = bpy.data.objects.new('SM_Island_Terrain_Reference', ground_mesh)
reference.collection.objects.link(ground_obj)
for poly in ground_mesh.polygons:
    poly.use_smooth = True
ground_mat = bpy.data.materials.new('M_Terrain_Reference_Clay')
ground_mat.use_nodes = True
ground_bsdf = next(n for n in ground_mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
ground_bsdf.inputs['Base Color'].default_value = (.3, .27, .22, 1)
ground_bsdf.inputs['Roughness'].default_value = .95
ground_obj.data.materials.append(ground_mat)
bpy.context.window.scene = reference
fbx(OUT / 'reference' / 'Island_Terrain_Reference.fbx', [ground_obj])

report = {
    'source': DATA['source'], 'source_units': 'meters', 'rock_count': len(rocks),
    'source_unique_geometry_count': 1, 'triangles_per_rock': len(faces),
    'total_rock_triangles': len(rocks) * len(faces), 'texture_atlas_resolution': SIZE,
    'uv0': '4096px shared material atlas; unique tile per source instance',
    'uv1': 'non-overlapping per-mesh lightmap unwrap',
    'blender_basis': '[three.x, -three.z, three.y]',
    'ue_basis': '[three.x, three.z, three.y] * 100 (centimeters)',
    'fbx_axes': 'forward -Y, up Z; 1 meter = 100 UE centimeters',
    'normal_maps': {'Blender': 'OpenGL (+Y)', 'UE': 'DirectX (-Y)'},
    'instances': manifest,
    'terrain_reference': {'vertices': len(ground_mesh.vertices), 'triangles': len(ground_mesh.polygons), 'material': 'reference clay only'},
}
(OUT / 'manifest.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
bpy.context.window.scene = catalog
catalog.render.resolution_x = 1500
catalog.render.resolution_y = 1300
catalog.render.resolution_percentage = 100
catalog.render.image_settings.file_format = 'PNG'
catalog.render.filepath = str(OUT / 'Rocks_Preview.png')
# Use the installed engine identifier rather than assuming one across versions.
try:
    catalog.render.engine = 'CYCLES'
    catalog.cycles.samples = 24
except TypeError:
    pass
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.region_3d.view_perspective = 'CAMERA'
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'UltraWater_Rocks.blend'))
bpy.ops.render.render(write_still=True)
print('EXPORT COMPLETE', json.dumps({'rocks': len(rocks), 'output': str(OUT)}), flush=True)
