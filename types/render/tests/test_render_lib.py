import contextlib
import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

from render_lib import MAX_FRAMES, InvalidParams, environment_line, first_file_strip, first_refused_node, frame_name, frames, gpu_settings, outputs_entry, preview_name, preview_size, progress_line, refused_node, script_args  # noqa: E402


class ScriptArgs(unittest.TestCase):
    def test_reads_the_arguments_after_the_double_dash(self):
        a = script_args(["blender", "-b", "scene.blend", "--python", "render.py", "--", "--params", "p.json", "--scene", "s.blend", "--out", "o"])
        self.assertEqual((a.params, a.scene, a.out), ("p.json", "s.blend", "o"))

    def test_refuses_missing_arguments(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            script_args(["blender", "--", "--params", "p.json"])


class Frames(unittest.TestCase):
    def test_one_frame_by_default(self):
        self.assertEqual(frames({"frame_start": 7}), [7])

    def test_a_range(self):
        self.assertEqual(frames({"frame_start": 1, "frame_end": 3}), [1, 2, 3])

    def test_an_end_before_the_start_is_invalid(self):
        with self.assertRaises(InvalidParams):
            frames({"frame_start": 5, "frame_end": 4})

    def test_too_many_frames_are_invalid(self):
        self.assertEqual(MAX_FRAMES, 500)  # the worker's 1000-file output limit, two files per frame
        with self.assertRaises(InvalidParams):
            frames({"frame_start": 0, "frame_end": MAX_FRAMES})
        self.assertEqual(len(frames({"frame_start": 0, "frame_end": MAX_FRAMES - 1})), MAX_FRAMES)


class Names(unittest.TestCase):
    def test_frame_and_preview_names(self):
        self.assertEqual(frame_name(1, "png"), "frame_0001.png")
        self.assertEqual(frame_name(12345, "jpg"), "frame_12345.jpg")
        self.assertEqual(preview_name(1), "previews/frame_0001.jpg")


class PreviewSize(unittest.TestCase):
    def test_the_longer_side_becomes_1024_and_nothing_is_enlarged(self):
        self.assertEqual(preview_size(1920, 1080), (1024, 576))
        self.assertEqual(preview_size(1080, 1920), (576, 1024))
        self.assertEqual(preview_size(800, 600), (800, 600))
        self.assertEqual(preview_size(4000, 1), (1024, 1))


class OutputsAndProgress(unittest.TestCase):
    def test_outputs_entry(self):
        self.assertEqual(
            outputs_entry(1920, 1080, 3, 128, "previews/frame_0003.jpg"),
            {"meta": {"frame": 3, "width": 1920, "height": 1080, "samples": 128}, "preview": "previews/frame_0003.jpg"},
        )

    def test_progress_line_is_the_workers_format(self):
        self.assertEqual(json.loads(progress_line(1, 4, 10)), {"progress": 0.25, "message": "frame 10 (1/4)"})


class RefusedNodes(unittest.TestCase):
    def test_osl_script_nodes_are_refused_in_any_mode(self):
        self.assertEqual(refused_node("ShaderNodeScript", "INTERNAL"), "OSL script node")
        self.assertEqual(refused_node("ShaderNodeScript", "EXTERNAL"), "OSL script node")

    def test_only_an_external_ies_texture_is_refused(self):
        self.assertEqual(refused_node("ShaderNodeTexIES", "EXTERNAL"), "external IES texture node")
        self.assertIsNone(refused_node("ShaderNodeTexIES", "INTERNAL"))

    def test_geometry_import_nodes_are_refused(self):
        for idname in ("GeometryNodeImportOBJ", "GeometryNodeImportPLY", "GeometryNodeImportSTL", "GeometryNodeImportCSV", "GeometryNodeImportText", "GeometryNodeImportVDB"):
            self.assertEqual(refused_node(idname, None), "geometry Import node")

    def test_ordinary_nodes_pass(self):
        for idname in ("ShaderNodeTexImage", "ShaderNodeBsdfPrincipled", "CompositorNodeOutputFile", "GeometryNodeMeshCube", "NodeGroupInput"):
            self.assertIsNone(refused_node(idname, None))

    def test_the_first_refused_node_of_a_tree(self):
        self.assertIsNone(first_refused_node([]))
        self.assertIsNone(first_refused_node([("ShaderNodeTexIES", "INTERNAL"), ("ShaderNodeOutputMaterial", None)]))
        self.assertEqual(
            first_refused_node([("ShaderNodeBsdfDiffuse", None), ("GeometryNodeImportOBJ", None), ("ShaderNodeScript", "INTERNAL")]),
            "geometry Import node",
        )


class FileStrips(unittest.TestCase):
    def test_image_movie_and_sound_strips_read_files(self):
        self.assertEqual(first_file_strip(["SCENE", "MOVIE", "IMAGE"]), "movie")
        self.assertEqual(first_file_strip(["IMAGE"]), "image")
        self.assertEqual(first_file_strip(["SOUND"]), "sound")

    def test_other_strips_pass(self):
        self.assertIsNone(first_file_strip([]))
        self.assertIsNone(first_file_strip(["SCENE", "COLOR", "TEXT", "META", "CROSS"]))


class EnvironmentLine(unittest.TestCase):
    def test_blender_version_device_and_gpus(self):
        self.assertEqual(environment_line("5.2.2 LTS", "OPTIX", ["Fake GPU", "Other GPU"]),
                         "fornax-environment: Blender 5.2.2 LTS, Cycles on OPTIX (Fake GPU, Other GPU)")


class GpuSettings(unittest.TestCase):
    def test_denoising_on_the_gpu_and_persistent_data(self):
        scene = SimpleNamespace(cycles=SimpleNamespace(denoising_use_gpu=False), render=SimpleNamespace(use_persistent_data=False))
        self.assertEqual(gpu_settings(scene), ["denoising on the GPU", "persistent data"])
        self.assertTrue(scene.cycles.denoising_use_gpu)
        self.assertTrue(scene.render.use_persistent_data)

    def test_a_blender_without_gpu_denoising_still_keeps_persistent_data(self):
        scene = SimpleNamespace(cycles=SimpleNamespace(), render=SimpleNamespace(use_persistent_data=False))
        self.assertEqual(gpu_settings(scene), ["persistent data"])
        self.assertFalse(hasattr(scene.cycles, "denoising_use_gpu"))
        self.assertTrue(scene.render.use_persistent_data)


if __name__ == "__main__":
    unittest.main()
