"""Shared helpers for the video-editor tools (detect, project, render)."""

import json
import os
import shutil
import subprocess
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# video-editor/ folder and the repository root (paths in JSON files are repo-relative).
VE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = VE_DIR.parent

VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi"}

MODELS = {
    "yunet": (
        "face_detection_yunet_2023mar.onnx",
        "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/"
        "face_detection_yunet/face_detection_yunet_2023mar.onnx",
    ),
    "sface": (
        "face_recognition_sface_2021dec.onnx",
        "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/"
        "face_recognition_sface/face_recognition_sface_2021dec.onnx",
    ),
}


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def repo_rel(path):
    """Repo-relative POSIX path for storing in JSON."""
    p = Path(path).resolve()
    try:
        return p.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return p.as_posix()


def repo_abs(path):
    p = Path(path)
    return p if p.is_absolute() else REPO_ROOT / p


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    tmp = str(path) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def is_lfs_pointer(path):
    with open(path, "rb") as f:
        return f.read(40).startswith(b"version https://git-lfs")


def ensure_local(path):
    """Fetch a Git LFS file's real content if only its pointer is checked out."""
    path = repo_abs(path)
    if path.exists() and is_lfs_pointer(path):
        print(f"git lfs pull {repo_rel(path)}", flush=True)
        subprocess.run(["git", "lfs", "pull", "--include", repo_rel(path), "--exclude", ""],
                       cwd=REPO_ROOT, check=True)
    return path


def model_path(name, models_dir=None):
    """Return a local path for a model, downloading it on first use."""
    filename, url = MODELS[name]
    d = Path(models_dir or os.environ.get("VE_MODELS_DIR") or VE_DIR / ".models")
    d.mkdir(parents=True, exist_ok=True)
    p = d / filename
    if not p.exists() or p.stat().st_size < 1024:
        print(f"Downloading {filename} ...", flush=True)
        tmp = p.with_suffix(".part")
        with urllib.request.urlopen(url) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        os.replace(tmp, p)
    return str(p)


def probe(path):
    """ffprobe a media file -> dict(duration, width, height, fps, has_audio, rotation)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    info = json.loads(out)
    v = next((s for s in info["streams"] if s.get("codec_type") == "video"), None)
    if v is None:
        raise ValueError(f"{path}: no video stream")
    rotation = 0
    for sd in v.get("side_data_list", []):
        if "rotation" in sd:
            rotation = int(sd["rotation"])
    rotation = int(v.get("tags", {}).get("rotate", rotation))
    w, h = int(v["width"]), int(v["height"])
    if rotation % 180 != 0:
        w, h = h, w  # report display orientation
    num, _, den = v.get("avg_frame_rate", "0/1").partition("/")
    fps = float(num) / float(den or 1) if float(den or 1) else 0.0
    duration = float(info["format"].get("duration") or v.get("duration") or 0)
    return {
        "duration": round(duration, 3),
        "width": w,
        "height": h,
        "fps": round(fps, 3),
        "has_audio": any(s.get("codec_type") == "audio" for s in info["streams"]),
    }


def parse_aspect(s):
    """'9:16' -> 0.5625 ; '1.777' -> 1.777"""
    if ":" in str(s):
        a, b = str(s).split(":")
        return float(a) / float(b)
    return float(s)


def suggest_crop(face_box, src_w, src_h, aspect):
    """Largest crop of the given aspect (w/h) that fits the frame, framed around a face.

    face_box and the result are normalized {x, y, w, h} in [0, 1].
    Returns None when the source already has (almost) the requested aspect.
    """
    src_aspect = src_w / src_h
    if abs(src_aspect - aspect) < 0.01:
        return None
    if aspect < src_aspect:  # narrower than source: full height
        ch, cw = src_h, src_h * aspect
    else:  # wider than source: full width
        cw, ch = src_w, src_w / aspect
    if face_box:
        fcx = (face_box["x"] + face_box["w"] / 2) * src_w
        fcy = (face_box["y"] + face_box["h"] / 2) * src_h
    else:
        fcx, fcy = src_w / 2, src_h / 2
    # Keep the face slightly above center (rule of thirds-ish headroom).
    x = min(max(fcx - cw / 2, 0), src_w - cw)
    y = min(max(fcy - ch * 0.4, 0), src_h - ch)
    return {
        "x": round(x / src_w, 4),
        "y": round(y / src_h, 4),
        "w": round(cw / src_w, 4),
        "h": round(ch / src_h, 4),
    }
