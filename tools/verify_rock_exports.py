"""Round-trip asset checks; run with blender -b --factory-startup --python ... -- OUTPUT."""
import bpy
import bmesh
import json
import sys
import numpy as np
from pathlib import Path
from mathutils import Vector
from io_scene_fbx import parse_fbx

out = Path(sys.argv[sys.argv.index('--') + 1]).resolve()
source = json.loads((out / '_source_geometry.json').read_text())
manifest = json.loads((out / 'manifest.json').read_text())
conversion = np.array([[1., 0., 0.], [0., 0., -1.], [0., 1., 0.]])
verts = np.asarray(source['geometry']['positions']).reshape(-1, 3)
expected = {}
for entry in source['instances']:
    m = np.array(entry['matrix']).reshape(4, 4).T
    expected[entry['name']] = (verts @ m[:3, :3].T + m[:3, 3]) @ conversion.T

def mesh_world(obj):
    co = np.array([v.co[:] for v in obj.data.vertices])
    m = np.array(obj.matrix_world)
    return co @ m[:3, :3].T + m[:3, 3]

def bounds_error(actual, reference):
    return float(max(np.max(np.abs(actual.min(axis=0) - reference.min(axis=0))),
                     np.max(np.abs(actual.max(axis=0) - reference.max(axis=0)))))

def check(condition, message):
    if not condition:
        raise AssertionError(message)

report = {'blender_version': bpy.app.version_string, 'ue_editor_tested': False}
bpy.ops.wm.open_mainfile(filepath=str(out / 'UltraWater_Rocks.blend'))
layout = bpy.data.scenes['Original_Layout']
bpy.context.window.scene = layout
bpy.context.view_layer.update()
meshes = [obj for obj in layout.objects if obj.type == 'MESH']
check(len(meshes) == 91, 'Blend must contain all 91 source rocks')
max_error, nonmanifold = 0., 0
for obj in meshes:
    actual = mesh_world(obj)
    max_error = max(max_error, float(np.abs(actual - expected[obj.name]).max()))
    check(len(obj.data.vertices) == 252 and len(obj.data.polygons) == 500, obj.name + ': source topology changed')
    check(len(obj.data.uv_layers) == 2, obj.name + ': UV sets missing')
    check('Source_Crevice_AO' in obj.data.color_attributes, obj.name + ': source vertex colors missing')
    for layer in obj.data.uv_layers:
        uv = np.array([item.uv[:] for item in layer.data])
        check(np.isfinite(uv).all() and uv.min() >= 0 and uv.max() <= 1, obj.name + ': UV outside 0..1')
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    nonmanifold += sum(not edge.is_manifold for edge in bm.edges)
    bm.free()
check(max_error < .0001, 'Blend world geometry differs from source: ' + str(max_error))
check(nonmanifold == 0, 'Rocks have non-manifold edges')
packed = [image for image in bpy.data.images if image.name.startswith('T_Rock_')]
check(len(packed) == 3 and all(image.packed_file for image in packed), 'Blend textures not packed')
report['blend'] = {'rocks': 91, 'unique_editable_meshes': len({obj.data.as_pointer() for obj in meshes}),
                   'vertices_per_rock': 252, 'triangles_per_rock': 500,
                   'max_source_world_vertex_error_m': max_error, 'nonmanifold_edges': nonmanifold,
                   'uv_sets_per_mesh': 2, 'packed_textures': len(packed), 'source_vertex_colors': True}

# Refresh the complete catalogue framing, and render an inspectable hero closeup.
catalog = bpy.data.scenes['Asset_Catalog']
catalog.camera.data.ortho_scale = 360
bpy.context.window.scene = catalog
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(out / 'UltraWater_Rocks.blend'))
catalog.render.filepath = str(out / 'Rocks_Preview.png')
bpy.ops.render.render(write_still=True)
hero = next(obj for obj in catalog.objects if obj.get('hero'))
for obj in catalog.objects:
    if obj.type == 'MESH' and obj != hero and obj.name != 'Preview_Floor':
        obj.hide_render = True
catalog.camera.location = hero.location + Vector((24, -30, 21))
target = hero.location + Vector((0, 0, hero.dimensions.z * .45))
catalog.camera.rotation_euler = (target - catalog.camera.location).to_track_quat('-Z', 'Y').to_euler()
catalog.camera.data.ortho_scale = max(hero.dimensions) * 1.6
catalog.render.resolution_x = 1200
catalog.render.resolution_y = 1000
catalog.render.filepath = str(out / 'Rock_Hero_Preview.png')
bpy.ops.render.render(write_still=True)

# Texture paths inside each FBX must be relative and resolve within the package.
def walk(element):
    yield element
    for child in element.elems:
        yield from walk(child)

fbx_paths = [out / 'Rocks_OriginalLayout.fbx'] + sorted((out / 'fbx_individual').glob('*.fbx'))
relative_references = 0
for filepath in fbx_paths:
    tree, version = parse_fbx.parse(str(filepath))
    refs = [node.props[0].decode('utf8').replace('\\', '/') for node in walk(tree) if node.id == b'RelativeFilename']
    check(refs, str(filepath) + ': no external texture references')
    for ref in refs:
        check(not Path(ref).is_absolute(), 'Absolute relative texture path')
        check((filepath.parent / ref).is_file(), str(filepath) + ': unresolved ' + ref)
        relative_references += 1
report['fbx_texture_references'] = {'files': len(fbx_paths), 'resolved_relative_references': relative_references}

# Clear scene/datablocks between imports to avoid false success from existing assets.
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.unit_settings.system = 'METRIC'
bpy.context.scene.unit_settings.scale_length = 1
bpy.ops.import_scene.fbx(filepath=str(out / 'Rocks_OriginalLayout.fbx'), use_image_search=False)
meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
check(len(meshes) == 91, 'FBX missing meshes')
error = 0.
for obj in meshes:
    check(obj.name in expected, 'Unexpected FBX object ' + obj.name)
    error = max(error, bounds_error(mesh_world(obj), expected[obj.name]))
    check(len(obj.data.vertices) == 252 and len(obj.data.polygons) == 500, obj.name + ': FBX topology')
    check(len(obj.data.uv_layers) == 2, obj.name + ': FBX UVs missing')
    check(len(obj.data.color_attributes) > 0, obj.name + ': FBX vertex colors missing')
check(error < .0002, 'FBX world bounds/units differ from source')
report['fbx_layout'] = {'rocks': len(meshes), 'max_source_bounds_error_m': error, 'units_preserved': True}

individual_error = 0.
for entry in manifest['instances']:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1
    bpy.ops.import_scene.fbx(filepath=str(out / entry['fbx']), use_image_search=False)
    objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    check(len(objects) == 1, entry['name'] + ': individual FBX count')
    obj = objects[0]
    check(len(obj.data.polygons) == 500, entry['name'] + ': individual triangles')
    check(obj.location.length < 1e-6, entry['name'] + ': standalone origin')
    reference = expected[entry['name']] - np.array(entry['blender_location_m'])
    individual_error = max(individual_error, bounds_error(mesh_world(obj), reference))
check(individual_error < .0001, 'Individual FBX units or local geometry mismatch')
report['individual_fbx'] = {'files_imported': 91, 'bottom_center_pivots': True,
                             'max_source_bounds_error_m': individual_error}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=str(out / 'Rocks_OriginalLayout.glb'))
meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
check(len(meshes) == 91, 'GLB missing meshes')
error = max(bounds_error(mesh_world(obj), expected[obj.name]) for obj in meshes)
check(error < .0002, 'GLB positions or units differ from source')
check(sum(len(obj.data.polygons) for obj in meshes) == 45500, 'GLB triangles differ')
report['glb'] = {'rocks': 91, 'triangles': 45500, 'max_source_bounds_error_m': error}

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.scene.unit_settings.system = 'METRIC'
bpy.context.scene.unit_settings.scale_length = 1
bpy.ops.import_scene.fbx(filepath=str(out / 'reference/Island_Terrain_Reference.fbx'))
terrain = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
check(len(terrain) == 1, 'Terrain reference missing')
check(len(terrain[0].data.polygons) == len(source['terrain']['indices']) // 3, 'Terrain reference faces mismatch')
report['terrain_reference'] = {'meshes': 1, 'triangles': len(terrain[0].data.polygons)}
report['status'] = 'passed'
(out / 'validation.json').write_text(json.dumps(report, indent=2))
print('VALIDATION PASSED', json.dumps(report), flush=True)
