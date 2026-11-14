"""Make the smoke-test scene (never shipped as a file):
  blender -b --factory-startup --python make_test_scene.py -- <out.blend>
A plane, a cube that turns over frames 1-3, a sun and a camera; 640x360, 32 samples."""
import math
import sys

import bpy

out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.world = bpy.data.worlds.new("World")
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
scene.render.engine = "CYCLES"
scene.cycles.samples = 32
bpy.ops.wm.save_as_mainfile(filepath=out)
print(f"saved {out}")
