#!/usr/bin/env python3
"""Render an editing project to an MP4 with ffmpeg.

    python video-editor/tools/render.py video-editor/projects/clip.json -o out.mp4 [--scale 0.5]
"""

import argparse
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

import velib
from project import clip_len, validate


def atempo_chain(speed):
    """atempo only accepts 0.5-2.0 per instance, so chain it."""
    parts = []
    while speed > 2.0:
        parts.append("atempo=2.0")
        speed /= 2.0
    while speed < 0.5:
        parts.append("atempo=0.5")
        speed /= 0.5
    parts.append(f"atempo={speed:.6f}")
    return ",".join(parts)


def resolve_source(src, tmpdir):
    if src.get("path") and velib.repo_abs(src["path"]).exists():
        p = velib.ensure_local(src["path"])
        if velib.is_lfs_pointer(p):
            raise SystemExit(f"{src['path']} is a Git LFS pointer; run `git lfs pull` first")
        return str(p)
    if src.get("url"):
        dest = Path(tmpdir) / Path(src["url"].split("?")[0]).name
        if not dest.exists():
            print(f"downloading {src['url']}", flush=True)
            urllib.request.urlretrieve(src["url"], dest)
        return str(dest)
    raise SystemExit(f"source not found: {src.get('path') or src.get('url')}")


def build_command(project, out_path, scale, tmpdir, crf, preset):
    o = project["output"]
    W = int(o["width"] * scale) // 2 * 2
    H = int(o["height"] * scale) // 2 * 2
    fps = o["fps"]
    bg = o.get("background", "#000000").replace("#", "0x")
    inputs, chains, labels = [], [], []
    for k, c in enumerate(project["clips"]):
        src = project["sources"][c["source"]]
        path = resolve_source(src, tmpdir)
        speed = c.get("speed", 1)
        dur = clip_len(c)
        inputs += ["-ss", f"{c['in']:.3f}", "-t", f"{c['out'] - c['in']:.3f}", "-i", path]

        v = [f"[{k}:v]setpts=(PTS-STARTPTS)/{speed}"]
        cr = c.get("crop")
        if cr:
            v.append(f"crop=w=iw*{cr['w']}:h=ih*{cr['h']}:x=iw*{cr['x']}:y=ih*{cr['y']}")
        if c.get("fit", "cover") == "contain":
            v.append(f"scale={W}:{H}:force_original_aspect_ratio=decrease")
            v.append(f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color={bg}")
        else:
            v.append(f"scale={W}:{H}:force_original_aspect_ratio=increase")
            v.append(f"crop={W}:{H}")
        v.append(f"setsar=1,fps={fps},format=yuv420p,trim=duration={dur:.3f}[v{k}]")
        chains.append(",".join(v))

        if src.get("has_audio", True) and not c.get("muted"):
            a = (f"[{k}:a]asetpts=PTS-STARTPTS,{atempo_chain(speed)},volume={c.get('volume', 1)},"
                 f"aformat=sample_rates=48000:channel_layouts=stereo")
        else:
            a = "anullsrc=r=48000:cl=stereo"
        chains.append(f"{a},apad,atrim=duration={dur:.3f}[a{k}]")
        labels.append(f"[v{k}][a{k}]")

    chains.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=1[outv][outa]")
    return [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "warning", "-stats",
        *inputs,
        "-filter_complex", ";\n".join(chains),
        "-map", "[outv]", "-map", "[outa]",
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
        str(out_path),
    ]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project")
    ap.add_argument("-o", "--out", help="output file (default: video-editor/renders/<name>.mp4)")
    ap.add_argument("--scale", type=float, default=1.0, help="resolution multiplier, e.g. 0.5 for a quick preview")
    ap.add_argument("--crf", type=int, default=20)
    ap.add_argument("--preset", default="veryfast")
    ap.add_argument("--dry-run", action="store_true", help="print the ffmpeg command only")
    a = ap.parse_args(argv)

    project = velib.load_json(a.project)
    errs = validate(project)
    if errs:
        sys.exit("invalid project:\n  " + "\n  ".join(errs))
    if not project["clips"]:
        sys.exit("project has no clips")
    out = Path(a.out) if a.out else velib.VE_DIR / "renders" / f"{project['name']}.mp4"
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        cmd = build_command(project, out, a.scale, tmp, a.crf, a.preset)
        if a.dry_run:
            print(" ".join(f"'{x}'" if " " in x or ";" in x else x for x in cmd))
            return
        total = sum(clip_len(c) for c in project["clips"])
        print(f"rendering {len(project['clips'])} clips, {total:.2f}s -> {out}", flush=True)
        subprocess.run(cmd, check=True)
    print(f"done: {out}")


if __name__ == "__main__":
    main()
