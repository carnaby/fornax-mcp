"""Cycles on a GPU, inside Blender: the first device type that has devices wins."""
import bpy

GPU_TYPES = ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL")


def enable_gpu():
    """(device type, device names) with only that type's devices enabled; (None, []) when Cycles finds no GPU."""
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in GPU_TYPES:
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue  # not built into this Blender for this platform
        prefs.refresh_devices()
        gpus = [d for d in prefs.devices if d.type == kind]
        if gpus:
            for d in prefs.devices:
                d.use = d.type == kind
            return kind, [d.name for d in gpus]
    return None, []
