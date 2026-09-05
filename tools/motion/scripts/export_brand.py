"""Export the user's modeled solid, without its image overlay or image textures."""

import bpy, json, os, hashlib
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[3]
source_path = os.environ.get("SOLLA_BRAND_SOURCE")
if not source_path:
    raise RuntimeError("Set SOLLA_BRAND_SOURCE to the original Solla logo .blend file.")
SOURCE = Path(source_path).expanduser().resolve(strict=True)
OUT = ROOT / "apps/marketing/public/brand"
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
solid = bpy.data.objects["SM_SollaCode_Logo_01"]
for obj in list(bpy.data.objects):
    if obj != solid:
        bpy.data.objects.remove(obj, do_unlink=True)
solid.animation_data_clear()
solid.rotation_mode = "XYZ"
solid.rotation_euler = (0, 0, 0)
solid.location = (0, 0, 0)
solid.scale = (1, 1, 1)
bpy.context.view_layer.update()
solid.hide_render = False
solid.hide_set(False)
for mat in solid.data.materials:
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Metallic"].default_value = 0.72
        bsdf.inputs["Roughness"].default_value = 0.25
    assert not any(
        n.type == "TEX_IMAGE" for n in mat.node_tree.nodes
    ), "Image texture in solid"
# Mirror the faceted front surface to the back and join its boundary edges.
# This changes the exported derivative only; the source .blend is never saved.
solid.data.calc_loop_triangles()
front = [t for t in solid.data.loop_triangles if t.normal.z > 0.001]
source_vertices = {
    i: solid.data.vertices[i].co.copy() for t in front for i in t.vertices
}
indices = {old: new for new, old in enumerate(source_vertices)}
front_vertices = [tuple(v) for v in source_vertices.values()]
count = len(front_vertices)
points = front_vertices + [(x, y, -z) for x, y, z in front_vertices]
faces, material_indices, boundaries = [], [], {}
for triangle in front:
    face = tuple(indices[i] for i in triangle.vertices)
    faces.extend([face, tuple(i + count for i in reversed(face))])
    material_indices.extend([triangle.material_index, triangle.material_index])
    for a, b in zip(face, face[1:] + face[:1]):
        key = tuple(sorted((a, b)))
        if key in boundaries:
            del boundaries[key]
        else:
            boundaries[key] = (a, b, triangle.material_index)
for a, b, material in boundaries.values():
    faces.append((b, a, a + count, b + count))
    material_indices.append(material)
mirrored = bpy.data.meshes.new("SollaCode_MirroredFacets")
mirrored.from_pydata(points, [], faces)
for material in solid.data.materials:
    mirrored.materials.append(material)
for polygon, material in zip(mirrored.polygons, material_indices):
    polygon.material_index = material
mirrored.update()
solid.data = mirrored
solid.data.calc_loop_triangles()
verts, normals, colors = [], [], []
for triangle in solid.data.loop_triangles:
    mat = solid.data.materials[triangle.material_index]
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    color = list(bsdf.inputs["Base Color"].default_value)[:3]
    for index in triangle.vertices:
        p = solid.matrix_world @ solid.data.vertices[index].co
        verts.extend(p)
        normals.extend(triangle.normal)
        colors.extend(color)
(OUT / "solla-bolt.mesh.json").write_text(
    json.dumps(
        {"positions": verts, "normals": normals, "colors": colors},
        separators=(",", ":"),
    )
)
bpy.ops.object.select_all(action="DESELECT")
solid.select_set(True)
bpy.context.view_layer.objects.active = solid
bpy.ops.export_scene.gltf(
    filepath=str(OUT / "solla-bolt.glb"), export_format="GLB", use_selection=True
)
# An SVG projected from those same mesh faces supplies the static and no-WebGL mark.
polys = []
for tri in sorted(solid.data.loop_triangles, key=lambda t: t.center.z):
    if tri.normal.z <= 0:
        continue
    mat = solid.data.materials[tri.material_index]
    color = mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value
    rgb = [
        round(255 * (12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055))
        for c in color[:3]
    ]
    points = " ".join(
        f"{(solid.data.vertices[i].co.x+.5)*1024:.2f},{(.5-solid.data.vertices[i].co.y)*1024:.2f}"
        for i in tri.vertices
    )
    polys.append(f'<polygon points="{points}" fill="rgb({rgb[0]} {rgb[1]} {rgb[2]})"/>')
(OUT / "solla-bolt.svg").write_text(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">'
    + "".join(polys)
    + "</svg>"
)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 64
scene.render.resolution_x = 1400
scene.render.resolution_y = 1400
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.world.color = (0.035, 0.035, 0.035)
scene.view_settings.view_transform = "AgX"


def point(obj, target=(0, 0, 0)):
    obj.rotation_euler = (
        (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    )


bpy.ops.object.camera_add(location=(0.24, 0.08, 2.4))
camera = bpy.context.object
camera.data.type = "ORTHO"
camera.data.ortho_scale = 1.18
point(camera)
scene.camera = camera
for name, location, energy, size, color in [
    ("Key", (-1.4, 1.7, 2.5), 250, 1.7, (1, 0.92, 0.77)),
    ("Rim", (1.3, 0.3, 1), 190, 1.0, (1, 0.76, 0.36)),
    ("Fill", (-0.2, -1.8, 2), 110, 1.4, (0.62, 0.71, 1)),
]:
    bpy.ops.object.light_add(type="AREA", location=location)
    light = bpy.context.object
    light.name = name
    light.data.energy = energy
    light.data.shape = "DISK"
    light.data.size = size
    light.data.color = color
    point(light)
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(OUT / "solla-bolt-studio.png")
bpy.ops.render.render(write_still=True)
(OUT / "provenance.json").write_text(
    json.dumps(
        {
            "source": SOURCE.name,
            "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
            "object": solid.name,
            "method": "Blender solid geometry, numeric materials, area lights; no image overlay or image textures",
            "triangles": len(solid.data.loop_triangles),
            "tools": {"Blender": bpy.app.version_string},
            "mlGeneratedArtwork": False,
            "backSurface": "Front geometry and materials mirrored across Z=0; boundary joined watertight",
        },
        indent=2,
    )
    + "\n"
)
