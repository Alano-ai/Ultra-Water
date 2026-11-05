"""Optional UE5 editor importer. Run with Tools > Execute Python Script.

Imports 91 separate static meshes and binds the three PBR textures. It creates
a fresh content folder and leaves the current level unchanged. Requires the
Python Editor Script Plugin and Editor Scripting Utilities. Not executable
in regular Python or Blender.
"""
from pathlib import Path
import json
import unreal

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
assets = unreal.AssetToolsHelpers.get_asset_tools()
directory = '/Game/UltraWater_Rocks'
number = 1
while unreal.EditorAssetLibrary.does_directory_exist(directory):
    directory = '/Game/UltraWater_Rocks_%02d' % number
    number += 1


def import_asset(filename, target_folder, options=None, factory=None):
    task = unreal.AssetImportTask()
    task.set_editor_property('filename', str(ROOT / filename))
    task.set_editor_property('destination_path', target_folder)
    task.set_editor_property('automated', True)
    task.set_editor_property('replace_existing', False)
    task.set_editor_property('save', True)
    if options is not None:
        task.set_editor_property('options', options)
    if factory is not None:
        task.set_editor_property('factory', factory)
    assets.import_asset_tasks([task])
    objects = [unreal.load_asset(path) for path in task.imported_object_paths]
    if not objects:
        raise RuntimeError('Import failed: ' + filename)
    return objects


textures = {}
for suffix, srgb, compression in (
    ('BaseColor', True, unreal.TextureCompressionSettings.TC_DEFAULT),
    ('Roughness', False, unreal.TextureCompressionSettings.TC_MASKS),
    ('Normal_DirectX', False, unreal.TextureCompressionSettings.TC_NORMALMAP),
):
    texture = import_asset('textures/T_Rock_' + suffix + '.png', directory + '/Textures')[0]
    texture.set_editor_property('srgb', srgb)
    texture.set_editor_property('compression_settings', compression)
    if suffix == 'Normal_DirectX':
        texture.set_editor_property('flip_green_channel', False)
    unreal.EditorAssetLibrary.save_loaded_asset(texture)
    textures[suffix] = texture

material = assets.create_asset('M_Rock_Baked', directory, unreal.Material, unreal.MaterialFactoryNew())
for row, (suffix, prop, sampler, output) in enumerate((
    ('BaseColor', unreal.MaterialProperty.MP_BASE_COLOR, unreal.MaterialSamplerType.SAMPLERTYPE_COLOR, 'RGB'),
    ('Roughness', unreal.MaterialProperty.MP_ROUGHNESS, unreal.MaterialSamplerType.SAMPLERTYPE_MASKS, 'R'),
    ('Normal_DirectX', unreal.MaterialProperty.MP_NORMAL, unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL, 'RGB'),
)):
    node = unreal.MaterialEditingLibrary.create_material_expression(material, unreal.MaterialExpressionTextureSample, -500, row * 220)
    node.set_editor_property('texture', textures[suffix])
    node.set_editor_property('sampler_type', sampler)
    unreal.MaterialEditingLibrary.connect_material_property(node, output, prop)
unreal.MaterialEditingLibrary.recompile_material(material)
unreal.EditorAssetLibrary.save_loaded_asset(material)

for index, entry in enumerate(MANIFEST['instances']):
    options = unreal.FbxImportUI()
    options.set_editor_property('import_mesh', True)
    options.set_editor_property('import_as_skeletal', False)
    options.set_editor_property('import_materials', False)
    options.set_editor_property('import_textures', False)
    options.set_editor_property('automated_import_should_detect_type', False)
    options.set_editor_property('mesh_type_to_import', unreal.FBXImportType.FBXIT_STATIC_MESH)
    mesh_options = options.static_mesh_import_data
    for key, value in {
        'combine_meshes': False,
        'auto_generate_collision': True,
        'convert_scene': True,
        'convert_scene_unit': True,
        'force_front_x_axis': False,
        'import_uniform_scale': 1.0,
        'generate_lightmap_u_vs': False,
        'normal_import_method': unreal.FBXNormalImportMethod.FBXNIM_IMPORT_NORMALS_AND_TANGENTS,
    }.items():
        mesh_options.set_editor_property(key, value)
    imported = import_asset(entry['fbx'], directory + '/Meshes', options, unreal.FbxFactory())
    meshes = [obj for obj in imported if isinstance(obj, unreal.StaticMesh)]
    if len(meshes) != 1:
        raise RuntimeError('Expected one static mesh: ' + entry['name'])
    mesh = meshes[0]
    mesh.set_material(0, material)
    mesh.set_editor_property('light_map_coordinate_index', 1)
    mesh.set_editor_property('light_map_resolution', 64)
    unreal.EditorAssetLibrary.save_loaded_asset(mesh)
    unreal.log('UltraWater rocks: %d/%d' % (index + 1, len(MANIFEST['instances'])))

unreal.log('Imported 91 rock meshes and the PBR material into ' + directory)
