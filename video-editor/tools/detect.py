#!/usr/bin/env python3
"""Find the time ranges where *you* are in frame, plus a suggested crop for each.

    python video-editor/tools/detect.py video-editor/inbox/clip.mp4

Faces are found with YuNet. If photos of you are in video-editor/reference/,
each face is compared to them with SFace, so only you count. With no reference
photos, any clearly visible face counts.

Writes video-editor/detections/<video name>.json (see the README for the format).
"""

import argparse
import sys
from pathlib import Path

import cv2
import numpy as np

import velib

DET_SIZE = 640  # longest side the frame is resized to for detection


def load_models(models_dir):
    detector = cv2.FaceDetectorYN.create(velib.model_path("yunet", models_dir), "", (320, 320), 0.6, 0.3, 5000)
    recognizer = cv2.FaceRecognizerSF.create(velib.model_path("sface", models_dir), "")
    return detector, recognizer


def detect_faces(detector, frame):
    """Faces in full-resolution coordinates, as YuNet rows (x, y, w, h, 5 landmarks, score)."""
    h, w = frame.shape[:2]
    scale = min(1.0, DET_SIZE / max(h, w))
    small = cv2.resize(frame, (round(w * scale), round(h * scale))) if scale < 1 else frame
    detector.setInputSize((small.shape[1], small.shape[0]))
    _, faces = detector.detect(small)
    if faces is None:
        return []
    faces = faces.copy()
    faces[:, :14] /= scale
    return list(faces)


def embed(recognizer, frame, face):
    return recognizer.feature(recognizer.alignCrop(frame, face)).copy()


def load_references(ref_dir, detector, recognizer):
    feats = []
    for p in sorted(Path(ref_dir).glob("*")):
        if p.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".bmp"}:
            continue
        img = cv2.imread(str(p))
        if img is None:
            print(f"  ! could not read {p.name}", file=sys.stderr)
            continue
        faces = detect_faces(detector, img)
        if not faces:
            print(f"  ! no face found in {p.name}", file=sys.stderr)
            continue
        biggest = max(faces, key=lambda f: f[2] * f[3])
        feats.append(embed(recognizer, img, biggest))
        print(f"  reference: {p.name}")
    return feats


def iter_samples(path, sample_fps):
    """Yield (t, frame) at roughly sample_fps, decoding sequentially (faster than seeking)."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise SystemExit(f"cannot open {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1.0, fps / sample_fps)
    idx, next_idx = 0, 0.0
    while cap.grab():
        if idx >= next_idx:
            ok, frame = cap.retrieve()
            if ok:
                yield idx / fps, frame
            next_idx += step
        idx += 1
    cap.release()


def make_body_detector():
    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
    return hog


def has_body(hog, frame):
    h, w = frame.shape[:2]
    scale = min(1.0, DET_SIZE / max(h, w))
    small = cv2.resize(frame, (round(w * scale), round(h * scale))) if scale < 1 else frame
    rects, weights = hog.detectMultiScale(small, winStride=(8, 8), padding=(8, 8), scale=1.05)
    return any(float(wt) > 0.5 for wt in np.ravel(weights)) if len(rects) else False


def analyze(path, refs, detector, recognizer, args):
    """Per-sample observations: {t, hit, weak, sim, box}."""
    hog = make_body_detector() if args.body else None
    samples = []
    for t, frame in iter_samples(path, args.sample_fps):
        fh, fw = frame.shape[:2]
        faces = detect_faces(detector, frame)
        best, best_sim = None, None
        if refs:
            for f in faces:
                feat = embed(recognizer, frame, f)
                sim = max(recognizer.match(feat, r, cv2.FaceRecognizerSF_FR_COSINE) for r in refs)
                if sim >= args.threshold and (best_sim is None or sim > best_sim):
                    best, best_sim = f, sim
        elif faces:
            best = max(faces, key=lambda f: f[2] * f[3])
        s = {"t": round(t, 3), "hit": best is not None, "weak": False, "sim": None, "box": None}
        if best is not None:
            x, y, w, h = (float(v) for v in best[:4])
            x, y = max(x, 0.0), max(y, 0.0)
            s["box"] = {"x": x / fw, "y": y / fh, "w": min(w, fw - x) / fw, "h": min(h, fh - y) / fh}
            s["sim"] = None if best_sim is None else round(float(best_sim), 3)
        elif hog is not None and has_body(hog, frame):
            s["weak"] = True
        samples.append(s)
        if len(samples) % 50 == 0:
            print(f"  {t:7.1f}s  {sum(x['hit'] for x in samples)}/{len(samples)} samples with you", flush=True)
    return samples


def build_segments(samples, duration, args):
    if not samples:
        return []
    dt = 1.0 / args.sample_fps
    runs = []  # [first_idx, last_idx] of hit samples
    for i, s in enumerate(samples):
        if s["hit"]:
            if runs and samples[i - 1]["hit"]:
                runs[-1][1] = i
            else:
                runs.append([i, i])
    # Weak (body-only) samples extend a run while they stay contiguous with it.
    for r in runs:
        while r[0] > 0 and samples[r[0] - 1]["weak"]:
            r[0] -= 1
        while r[1] < len(samples) - 1 and samples[r[1] + 1]["weak"]:
            r[1] += 1
    ranges = [[samples[a]["t"], samples[b]["t"] + dt, a, b] for a, b in runs]
    merged = []
    for r in ranges:
        if merged and r[0] - merged[-1][1] <= args.gap:
            merged[-1][1], merged[-1][3] = r[1], r[3]
        else:
            merged.append(r)
    merged = [r for r in merged if r[1] - r[0] >= args.min_len]
    segs = []
    for start, end, a, b in merged:
        start, end = max(0.0, start - args.pad), min(duration, end + args.pad)
        if segs and start <= segs[-1]["_end"]:
            segs[-1]["_end"], segs[-1]["_b"] = end, b
            continue
        segs.append({"_start": start, "_end": end, "_a": a, "_b": b})
    return segs


def median_box(boxes):
    return {k: round(float(np.median([b[k] for b in boxes])), 4) for k in ("x", "y", "w", "h")}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video")
    ap.add_argument("-o", "--out", help="output JSON (default: video-editor/detections/<name>.json)")
    ap.add_argument("--reference", default=str(velib.VE_DIR / "reference"), help="folder with photos of you")
    ap.add_argument("--any-face", action="store_true", help="ignore reference photos; any face counts")
    ap.add_argument("--sample-fps", type=float, default=4.0, help="frames analysed per second (default 4)")
    ap.add_argument("--threshold", type=float, default=0.363, help="face-match cosine similarity (default 0.363)")
    ap.add_argument("--gap", type=float, default=1.0, help="merge segments closer than this many seconds")
    ap.add_argument("--min-len", type=float, default=1.0, help="drop segments shorter than this (seconds)")
    ap.add_argument("--pad", type=float, default=0.25, help="pad each segment by this many seconds")
    ap.add_argument("--aspect", default="9:16", help="aspect of the suggested crops, e.g. 9:16, 1:1, 16:9")
    ap.add_argument("--body", action="store_true", help="also use a body detector to bridge moments your face is hidden")
    ap.add_argument("--models-dir", help="where the ONNX models are cached")
    args = ap.parse_args(argv)

    video = Path(args.video).resolve()
    meta = velib.probe(video)
    print(f"{video.name}: {meta['width']}x{meta['height']} {meta['duration']}s @ {meta['fps']}fps")

    detector, recognizer = load_models(args.models_dir)
    refs = [] if args.any_face else load_references(args.reference, detector, recognizer)
    mode = "reference" if refs else "any-face"
    print(f"identity mode: {mode}" + (f" ({len(refs)} reference photos)" if refs else ""))

    samples = analyze(video, refs, detector, recognizer, args)
    segs = build_segments(samples, meta["duration"], args)
    aspect = velib.parse_aspect(args.aspect)

    segments = []
    for i, s in enumerate(segs, 1):
        inside = samples[s["_a"]: s["_b"] + 1]
        hits = [x for x in inside if x["hit"]]
        box = median_box([x["box"] for x in hits])
        sims = [x["sim"] for x in hits if x["sim"] is not None]
        segments.append({
            "id": f"seg{i}",
            "start": round(s["_start"], 3),
            "end": round(s["_end"], 3),
            "duration": round(s["_end"] - s["_start"], 3),
            "confidence": round(len(hits) / len(inside), 3),
            "similarity": round(float(np.mean(sims)), 3) if sims else None,
            "face_box": box,
            "crop": velib.suggest_crop(box, meta["width"], meta["height"], aspect),
            "track": [
                [x["t"], round(x["box"]["x"] + x["box"]["w"] / 2, 4), round(x["box"]["y"] + x["box"]["h"] / 2, 4),
                 round(x["box"]["w"], 4)]
                for x in hits
            ],
        })

    result = {
        "version": 1,
        "generated_at": velib.now_iso(),
        "generator": "video-editor/tools/detect.py",
        "source": {"path": velib.repo_rel(video), "name": video.name, **meta},
        "identity": mode,
        "params": {
            "sample_fps": args.sample_fps, "threshold": args.threshold, "gap": args.gap,
            "min_len": args.min_len, "pad": args.pad, "aspect": args.aspect, "body": args.body,
            "reference_photos": len(refs),
        },
        "coords": "normalized (0-1) relative to the displayed frame; x,y = top-left",
        "track_format": "[t, face_center_x, face_center_y, face_width]",
        "total_in_frame": round(sum(s["duration"] for s in segments), 3),
        "segments": segments,
    }
    out = Path(args.out) if args.out else velib.VE_DIR / "detections" / f"{video.stem}.json"
    velib.save_json(out, result)
    print(f"{len(segments)} segments, {result['total_in_frame']}s of {meta['duration']}s -> {velib.repo_rel(out)}")
    for s in segments:
        print(f"  {s['id']}: {s['start']:8.2f} - {s['end']:8.2f}  ({s['duration']:.1f}s, conf {s['confidence']})")
    return out


if __name__ == "__main__":
    main()
