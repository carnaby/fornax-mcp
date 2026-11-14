# render

Renders frames of a `.blend` scene with Blender Cycles on the GPU. Every frame is an output; the pack makes a JPEG
preview of each (at most 1024 px), which `get_output` and the result page show.

## What you need

- [Blender](https://www.blender.org/download/) 4.2 or newer, and a GPU Cycles can use (NVIDIA: OptiX or CUDA; AMD: HIP;
  Intel: oneAPI; Apple: Metal).
- Its path in `worker.yaml`. On Windows give `blender.exe` itself, not `blender-launcher.exe`: the launcher starts
  Blender and ends at once, so the worker could neither follow nor stop the render.

      tools:
        blender: C:\Program Files\Blender Foundation\Blender 4.5\blender.exe     # Linux: /usr/bin/blender

## Install

    fornax types install render
    fornax doctor render

There is no setup step: the pack only checks Blender's version and the GPU.

## Safety

Blender always runs with `--disable-autoexec` (scripts and drivers inside the scene never run) and
`--factory-startup` (no add-ons or startup files of this PC). `render.py` refuses to render anything but the input
file itself.

Scenes must be self-contained: pack external data (File > External Data > Pack Resources) before submitting. A scene
that still uses an unpacked external file (image, linked library, movie clip, sound, volume, cache file or font) is
refused as invalid input. File Output nodes of the compositor are muted, and Freestyle in Python scripting mode is
refused, so a scene cannot write outside the job's output folder or run its own code.

## Parameters

`frame_start` (required), `frame_end` (default `frame_start`), `samples` (default 128), `format` (`png` or `jpg`).
At most 500 frames per job; split a long animation into several jobs with the same `group`.

## Smoke test

    blender -b --factory-startup --python scripts/make_test_scene.py -- test.blend

makes a small three-frame scene to submit as a job.
