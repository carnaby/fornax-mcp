"""Render a frame range of the input .blend with Cycles on the GPU (spec 6.5). Runs inside Blender:
  blender -b --factory-startup --disable-autoexec --python-exit-code 1 --python render.py --
          --params <params.json> --scene <scene> --out <dir>
Writes <out>/frame_NNNN.<png|jpg>, a JPEG preview of each in <out>/previews/, and <out>/outputs.json; prints one
progress line per frame. Exit codes: 0 done; 1 failed (an exception); 2 the scene or the params are invalid;
3 Cycles finds no GPU.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from blender_gpu import enable_gpu  # noqa: E402
from render_lib import FILE_FORMATS, InvalidParams, first_file_strip, first_refused_node, frame_name, frames, gpu_settings, outputs_entry, preview_name, preview_size, progress_line, script_args  # noqa: E402


def leave(code, message):
    print(f"render: {message}", file=sys.stderr, flush=True)
    sys.stdout.flush()
    # Not sys.exit: Blender would go on with the rest of its command line.
    os._exit(code)


def same_file(a, b):
    try:
        return os.path.samefile(a, b)
    except OSError:
        return False


def node_trees():
    """(owner, tree) for every node tree of the scene file: materials, worlds, lights, compositor trees (scene.node_tree
    in 4.x, scene.compositing_node_group in 5.x), line styles, legacy textures and every node group (nested groups are
    node groups too). The owner names the tree in messages. A tree reached twice is yielded once."""
    seen = set()

    def owned(kind, items, attribute="node_tree"):
        for item in items:
            tree = getattr(item, attribute, None)
            if tree is not None and tree.as_pointer() not in seen:
                seen.add(tree.as_pointer())
                yield f"{kind} {item.name}", tree

    data = bpy.data
    yield from owned("material", data.materials)
    yield from owned("world", data.worlds)
    yield from owned("light", data.lights)
    yield from owned("the compositor of scene", data.scenes)
    yield from owned("the compositor of scene", data.scenes, "compositing_node_group")
    yield from owned("line style", getattr(data, "linestyles", ()))
    yield from owned("texture", getattr(data, "textures", ()))
    for group in data.node_groups:
        if group.as_pointer() not in seen:
            seen.add(group.as_pointer())
            yield f"node group {group.name}", group


def refuse_nodes():
    """Nodes that run code or read a file of this PC by path: OSL script nodes, external IES textures, geometry
    Import nodes. Names the node kind and its tree, never a path."""
    for owner, tree in node_trees():
        kind = first_refused_node((node.bl_idname, getattr(node, "mode", None)) for node in tree.nodes)
        if kind is not None:
            leave(2, f"the scene uses a refused node ({kind}) in {owner}; remove it (nodes may not run code or read files of this PC)")


def scene_strips(scene):
    """Every strip of the scene's video sequencer, inside meta strips too (strips_all in 5.x, sequences_all before)."""
    editor = getattr(scene, "sequence_editor", None)
    if editor is None:
        return ()
    strips = getattr(editor, "strips_all", None)
    if strips is None:
        strips = getattr(editor, "sequences_all", ())
    return strips


def refuse_sequencer_files():
    """Image, movie and sound strips read files by path. The sequencer is switched off before rendering anyway."""
    for scene in bpy.data.scenes:
        kind = first_file_strip(strip.type for strip in scene_strips(scene))
        if kind is not None:
            leave(2, f"scene {scene.name} has a {kind} strip in its video sequencer; remove the sequencer strips that use files")


def mute_file_outputs():
    """File Output nodes write wherever the scene says; mute them all. Returns how many were muted."""
    muted = 0
    for _, tree in node_trees():
        for node in tree.nodes:
            if node.bl_idname == "CompositorNodeOutputFile":
                node.mute = True
                muted += 1
    return muted


def refuse_freestyle_scripts():
    for scene in bpy.data.scenes:
        if not scene.render.use_freestyle:
            continue
        for view_layer in scene.view_layers:
            if getattr(view_layer, "use_freestyle", True) and view_layer.freestyle_settings.mode == "SCRIPT":
                leave(2, "Freestyle in Python scripting mode runs scripts from the scene; use the parameter editor mode")


def is_packed(item):
    return getattr(item, "packed_file", None) is not None or bool(getattr(item, "packed_files", None))


def refuse_external_files():
    """The scene must be self-contained. open_mainfile has already read linked libraries; refusing here means that
    nothing of another file of this PC is rendered into the outputs. Messages name the data, never a path."""
    def refuse(kind, item):
        leave(2, f"the scene uses an external {kind} ({item.name}); pack resources first (File > External Data > Pack Resources)")

    for image in bpy.data.images:
        if image.source in ("FILE", "SEQUENCE", "MOVIE", "TILED") and not is_packed(image) and image.filepath:
            refuse("image", image)
    for library in bpy.data.libraries:
        if not is_packed(library):
            refuse("linked library", library)
    for clip in bpy.data.movieclips:
        if getattr(clip, "filepath", ""):
            refuse("movie clip", clip)
    for sound in bpy.data.sounds:
        if not is_packed(sound):
            refuse("sound", sound)
    for volume in bpy.data.volumes:
        if getattr(volume, "filepath", "") and not is_packed(volume):
            refuse("volume", volume)
    for cache in bpy.data.cache_files:
        refuse("cache file", cache)
    for font in bpy.data.fonts:
        if font.filepath != "<builtin>" and not is_packed(font):
            refuse("font", font)


def save_preview(source, target):
    """A JPEG of at most 1024 px on the longer side; returns the frame's own (width, height)."""
    image = bpy.data.images.load(source, check_existing=False)
    try:
        width, height = image.size
        w, h = preview_size(width, height)
        if (w, h) != (width, height):
            image.scale(w, h)
        image.filepath_raw = target
        image.file_format = "JPEG"
        image.save()
        return width, height
    finally:
        bpy.data.images.remove(image)


def main():
    args = script_args(sys.argv)
    # Blender with -b exits before --python when a positional file fails to load, so the scene is opened here.
    try:
        bpy.ops.wm.open_mainfile(filepath=args.scene, load_ui=False, use_scripts=False)
    except RuntimeError:
        leave(2, "the input could not be opened as a Blender scene")
    # Guards against having opened (or kept) anything other than the input itself.
    if not bpy.data.filepath or not same_file(bpy.data.filepath, args.scene):
        leave(2, "the input could not be opened as a Blender scene")
    with open(args.params, encoding="utf-8") as f:
        params = json.load(f)
    try:
        todo = frames(params)
    except InvalidParams as e:
        leave(2, str(e))
    # Every refusal comes before mute_file_outputs: a File Output node of a linked library cannot be muted (the
    # assignment raises, exit 1), and the library itself is refused here as invalid input.
    refuse_external_files()
    refuse_nodes()
    refuse_sequencer_files()
    refuse_freestyle_scripts()
    kind, names = enable_gpu()
    if kind is None:
        leave(3, "Cycles finds no GPU (OptiX, CUDA, HIP, oneAPI or Metal); check the driver, then fornax doctor render")

    muted = mute_file_outputs()
    print(f"render: muted {muted} File Output node(s)", file=sys.stderr, flush=True)
    # Every scene, not only the active one: a compositor Render Layers node can render another scene.
    for each in bpy.data.scenes:
        each.render.use_sequencer = False
        cycles = getattr(each, "cycles", None)
        if cycles is not None:
            cycles.shading_system = False  # no OSL

    scene = bpy.context.scene
    if scene.camera is None:
        leave(2, "the scene has no camera")
    scene.render.use_multiview = False
    scene.render.engine = "CYCLES"
    scene.cycles.device = "GPU"
    on_card = gpu_settings(scene)
    print(f"render: Cycles on {kind} ({', '.join(names)}); {'; '.join(on_card)}", file=sys.stderr, flush=True)
    samples = params.get("samples", 128)
    scene.cycles.samples = samples
    fmt = params.get("format", "png")
    settings = scene.render.image_settings
    if hasattr(settings, "media_type"):
        settings.media_type = "IMAGE"  # Blender 5.x: a scene saved with video output would reject PNG/JPEG
    settings.file_format = FILE_FORMATS[fmt]
    settings.color_mode = "RGBA" if fmt == "png" else "RGB"
    if fmt == "jpg":
        settings.quality = 90
    scene.render.use_file_extension = False

    out = os.path.abspath(args.out)
    os.makedirs(os.path.join(out, "previews"), exist_ok=True)
    entries = {}
    for done, frame in enumerate(todo, 1):
        scene.frame_set(frame)
        name = frame_name(frame, fmt)
        scene.render.filepath = os.path.join(out, name)
        bpy.ops.render.render(write_still=True)
        width, height = save_preview(os.path.join(out, name), os.path.join(out, preview_name(frame)))
        entries[name] = outputs_entry(width, height, frame, samples, preview_name(frame))
        print(progress_line(done, len(todo), frame), flush=True)
    with open(os.path.join(out, "outputs.json"), "w", encoding="utf-8") as f:
        json.dump(entries, f)


main()
