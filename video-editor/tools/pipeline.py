#!/usr/bin/env python3
"""Upload-to-project pipeline: detect yourself in new videos and start a project for each.

    pipeline.py video-editor/inbox/a.mp4 ...   # these videos
    pipeline.py --since <git sha>              # videos added/changed since a commit
    pipeline.py --missing                      # videos that have no detections yet
    pipeline.py --all                          # every video in the inbox

Detections always get (re)written. A project is only created when none exists
for the video, so edits made in the app are never overwritten (unless --force-project).
Detector flags (--sample-fps, --threshold, --body, ...) are passed on to detect.py.
"""

import argparse
import os
import subprocess
from pathlib import Path

import detect
import project
import velib

INBOX = velib.VE_DIR / "inbox"


def inbox_videos():
    return sorted(p for p in INBOX.rglob("*") if p.is_file() and p.suffix.lower() in velib.VIDEO_EXTS)


def changed_since(sha):
    out = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=AMR", sha, "HEAD", "--",
         velib.repo_rel(INBOX), velib.repo_rel(velib.VE_DIR / "reference")],
        cwd=velib.REPO_ROOT, check=True, capture_output=True, text=True,
    ).stdout.split()
    if any(p.startswith(velib.repo_rel(velib.VE_DIR / "reference")) for p in out):
        print("reference photos changed: re-detecting every video")
        return inbox_videos()
    return [velib.repo_abs(p) for p in out if Path(p).suffix.lower() in velib.VIDEO_EXTS and velib.repo_abs(p).exists()]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("videos", nargs="*")
    ap.add_argument("--since")
    ap.add_argument("--missing", action="store_true")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--aspect", default="9:16")
    ap.add_argument("--force-project", action="store_true")
    for flag in ("--sample-fps", "--threshold", "--gap", "--min-len", "--pad", "--reference", "--models-dir"):
        ap.add_argument(flag)
    ap.add_argument("--body", action="store_true")
    ap.add_argument("--any-face", action="store_true")
    a = ap.parse_args()
    detect_args = []
    for flag in ("sample_fps", "threshold", "gap", "min_len", "pad", "reference", "models_dir"):
        if getattr(a, flag) is not None:
            detect_args += [f"--{flag.replace('_', '-')}", getattr(a, flag)]
    detect_args += ["--body"] * a.body + ["--any-face"] * a.any_face

    if a.videos:
        videos = [velib.repo_abs(v) for v in a.videos]
    elif a.since and set(a.since) != {"0"}:
        videos = changed_since(a.since)
    elif a.all:
        videos = inbox_videos()
    else:
        videos = [v for v in inbox_videos() if not (velib.VE_DIR / "detections" / f"{v.stem}.json").exists()]

    summary = ["| video | segments | time with you | project |", "|---|---|---|---|"]
    if not videos:
        print("no videos to process")
    for v in videos:
        print(f"\n=== {velib.repo_rel(v)}")
        velib.ensure_local(v)
        det_path = detect.main([str(v), "--aspect", a.aspect, *detect_args])
        det = velib.load_json(det_path)
        proj_path = velib.VE_DIR / "projects" / f"{v.stem}.json"
        if proj_path.exists() and not a.force_project:
            status = "kept existing"
        else:
            project.save(proj_path, project.from_detections(det, v.stem, a.aspect, det_path=det_path), "claude")
            status = "created"
        print(f"project {velib.repo_rel(proj_path)}: {status}")
        summary.append(f"| `{velib.repo_rel(v)}` | {len(det['segments'])} | {det['total_in_frame']:.1f}s of "
                       f"{det['source']['duration']:.1f}s | `{velib.repo_rel(proj_path)}` ({status}) |")

    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write("## Detection results\n\n" + ("\n".join(summary) if videos else "No videos to process.") + "\n")


if __name__ == "__main__":
    main()
