"""Spec 15 § 3.1: an Eevee test render of the factory scene at 16x16. Runs inside Blender:
  blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python eevee_probe.py -- <dir>
Writes <dir>/probe.png and prints "fornax-eevee: <GPU backend>" when the render worked. Exit codes: 0 done; 3 this
Blender has no Eevee; any other code (or a crash) means Eevee does not work here."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from render_lib import EEVEE_PROBE_LINE, eevee_engine_id  # noqa: E402


def main():
    out = sys.argv[sys.argv.index("--") + 1]
    ids = [item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    engine = eevee_engine_id(ids)
    if engine is None:
        print("eevee probe: this Blender has no Eevee", file=sys.stderr, flush=True)
        sys.stdout.flush()
        os._exit(3)
    scene = bpy.context.scene
    scene.render.engine = engine
    scene.render.resolution_x = 16
    scene.render.resolution_y = 16
    scene.render.resolution_percentage = 100
    scene.eevee.taa_render_samples = 1
    scene.render.filepath = os.path.join(out, "probe.png")
    bpy.ops.render.render(write_still=True)
    import gpu  # initialised by the render: before it, the gpu module refuses in background mode
    print(f"{EEVEE_PROBE_LINE}{gpu.platform.backend_type_get()}", flush=True)
    sys.stdout.flush()
    os._exit(0)


main()
