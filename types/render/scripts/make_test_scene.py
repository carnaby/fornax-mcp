"""Make a test scene (never shipped as a file):
  blender -b --factory-startup --python make_test_scene.py -- <out.blend> [--motion]
Without --motion: a plane, a cube that turns over frames 1-3, a sun and a camera; 640x360, 32 samples.
With --motion: a logo intro for both engines: an emissive text that grows in and a camera that pushes in over a dark
backdrop; 1920x1080, frames 1-150 at 30 fps, 128 Cycles samples."""
import math
import sys

import bpy


def emission(name, color, strength):
    material = bpy.data.materials.new(name)
    if material.node_tree is None:
        material.use_nodes = True  # Blender 4.x; 5.x materials always have nodes
    nodes = material.node_tree.nodes
    nodes.clear()
    out = nodes.new("ShaderNodeOutputMaterial")
    light = nodes.new("ShaderNodeEmission")
    light.inputs["Color"].default_value = (*color, 1.0)
    light.inputs["Strength"].default_value = strength
    material.node_tree.links.new(light.outputs["Emission"], out.inputs["Surface"])
    return material


def cube_scene(scene):
    bpy.ops.mesh.primitive_plane_add(size=10)
    bpy.ops.mesh.primitive_cube_add(location=(0, 0, 1))
    cube = bpy.context.active_object
    cube.rotation_euler = (0, 0, 0)
    cube.keyframe_insert("rotation_euler", frame=1)
    cube.rotation_euler = (0, 0, math.radians(90))
    cube.keyframe_insert("rotation_euler", frame=3)
    bpy.ops.object.light_add(type="SUN", location=(4, -4, 8))
    bpy.ops.object.camera_add(location=(7, -7, 5), rotation=(math.radians(63), 0, math.radians(45)))
    scene.camera = bpy.context.active_object
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 640, 360, 100
    scene.frame_start, scene.frame_end = 1, 3
    scene.cycles.samples = 32


def motion_scene(scene):
    scene.world.color = (0.01, 0.01, 0.015)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 2, 0), rotation=(math.radians(90), 0, 0))
    bpy.context.active_object.data.materials.append(emission("Backdrop", (0.02, 0.03, 0.06), 1.0))
    bpy.ops.object.text_add(location=(0, 0, 0), rotation=(math.radians(90), 0, 0))
    text = bpy.context.active_object
    text.data.body = "FORNAX"
    text.data.align_x, text.data.align_y = "CENTER", "CENTER"
    text.data.extrude = 0.08
    text.data.materials.append(emission("Logo", (1.0, 0.45, 0.1), 6.0))
    text.scale = (0.2, 0.2, 0.2)
    text.keyframe_insert("scale", frame=1)
    text.scale = (1.0, 1.0, 1.0)
    text.keyframe_insert("scale", frame=45)
    bpy.ops.object.light_add(type="POINT", location=(0, -3, 2))
    bpy.context.active_object.data.energy = 300
    bpy.ops.object.camera_add(location=(0, -14, 0.6), rotation=(math.radians(90), 0, 0))
    camera = bpy.context.active_object
    camera.keyframe_insert("location", frame=1)
    camera.location = (0, -8, 0.2)
    camera.keyframe_insert("location", frame=150)
    scene.camera = camera
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 1920, 1080, 100
    scene.render.fps = 30
    scene.frame_start, scene.frame_end = 1, 150
    scene.cycles.samples = 128


args = sys.argv[sys.argv.index("--") + 1:]
out = args[0]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.world = bpy.data.worlds.new("World")
scene.render.engine = "CYCLES"
if "--motion" in args[1:]:
    motion_scene(scene)
else:
    cube_scene(scene)
bpy.ops.wm.save_as_mainfile(filepath=out)
print(f"saved {out}")
