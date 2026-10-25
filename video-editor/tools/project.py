#!/usr/bin/env python3
"""Create, inspect and edit editing projects (video-editor/projects/*.json).

A project is the shared state between the web app and Claude: whoever edits it
commits the JSON, and the app picks up the new version automatically.

    project.py new <detections.json> [--aspect 9:16] [--name NAME]
    project.py info <project.json>
    project.py validate <project.json>...
    project.py split <project.json> <timeline-seconds>
    project.py trim <project.json> <clip-id> [--in S] [--out S]
    project.py delete <project.json> <clip-id>
    project.py move <project.json> <clip-id> <new-index>
    project.py crop <project.json> <clip-id> (x y w h | --auto | --clear)
    project.py set <project.json> <clip-id> key=value...   (speed, volume, muted, fit, label)
    project.py output <project.json> WIDTHxHEIGHT [--fps N]
    project.py add <project.json> <source-id> <in> <out> [--at INDEX]
"""

import argparse
import sys
from pathlib import Path

import velib

FITS = ("cover", "contain")


# ---------------------------------------------------------------- model helpers

def clip_len(c):
    return (c["out"] - c["in"]) / c.get("speed", 1)


def new_id(project, prefix="c"):
    used = {c["id"] for c in project["clips"]}
    n = 1
    while f"{prefix}{n}" in used:
        n += 1
    return f"{prefix}{n}"


def find(project, clip_id):
    for i, c in enumerate(project["clips"]):
        if c["id"] == clip_id:
            return i, c
    raise SystemExit(f"no clip {clip_id!r}; clips: {', '.join(c['id'] for c in project['clips'])}")


def validate(p):
    errs = []
    if p.get("version") != 1:
        errs.append("version must be 1")
    out = p.get("output", {})
    for k in ("width", "height", "fps"):
        if not isinstance(out.get(k), (int, float)) or out.get(k) <= 0:
            errs.append(f"output.{k} must be a positive number")
    sources = p.get("sources", {})
    ids = set()
    for c in p.get("clips", []):
        cid = c.get("id", "?")
        if cid in ids:
            errs.append(f"duplicate clip id {cid}")
        ids.add(cid)
        src = sources.get(c.get("source"))
        if src is None:
            errs.append(f"{cid}: unknown source {c.get('source')!r}")
            continue
        if not (0 <= c.get("in", -1) < c.get("out", -1)):
            errs.append(f"{cid}: need 0 <= in < out")
        if src.get("duration") and c.get("out", 0) > src["duration"] + 0.05:
            errs.append(f"{cid}: out {c['out']} is past the source end {src['duration']}")
        if not 0.1 <= c.get("speed", 1) <= 10:
            errs.append(f"{cid}: speed must be between 0.1 and 10")
        if not 0 <= c.get("volume", 1) <= 4:
            errs.append(f"{cid}: volume must be between 0 and 4")
        if c.get("fit", "cover") not in FITS:
            errs.append(f"{cid}: fit must be one of {FITS}")
        cr = c.get("crop")
        if cr is not None:
            if any(not isinstance(cr.get(k), (int, float)) for k in "xywh"):
                errs.append(f"{cid}: crop needs numeric x, y, w, h")
            elif cr["w"] <= 0 or cr["h"] <= 0 or cr["x"] < -1e-3 or cr["y"] < -1e-3 \
                    or cr["x"] + cr["w"] > 1.001 or cr["y"] + cr["h"] > 1.001:
                errs.append(f"{cid}: crop must lie inside the frame (normalized 0-1)")
    return errs


def touch(p, who):
    p["updated_at"] = velib.now_iso()
    p["updated_by"] = who


def save(path, p, who):
    errs = validate(p)
    if errs:
        raise SystemExit("refusing to save an invalid project:\n  " + "\n  ".join(errs))
    touch(p, who)
    velib.save_json(path, p)


def from_detections(det, name, aspect, out_w=None, det_path=None):
    src = det["source"]
    a = velib.parse_aspect(aspect)
    if out_w is None:
        out_w, out_h = (1080, round(1080 / a)) if a < 1 else (round(1080 * a), 1080)
    else:
        out_h = round(out_w / a)
    out_w, out_h = out_w // 2 * 2, out_h // 2 * 2
    sid = Path(src["name"]).stem
    project = {
        "version": 1,
        "name": name,
        "updated_at": velib.now_iso(),
        "updated_by": "claude",
        "output": {"width": out_w, "height": out_h, "fps": round(src.get("fps") or 30) or 30, "background": "#000000"},
        "sources": {
            sid: {
                "path": src["path"],
                "duration": src["duration"],
                "width": src["width"],
                "height": src["height"],
                "has_audio": src.get("has_audio", True),
                "detections": velib.repo_rel(det_path) if det_path else None,
            }
        },
        "clips": [],
    }
    for i, s in enumerate(det["segments"], 1):
        project["clips"].append({
            "id": f"c{i}",
            "source": sid,
            "in": s["start"],
            "out": s["end"],
            "crop": velib.suggest_crop(s.get("face_box"), src["width"], src["height"], a),
            "fit": "cover",
            "speed": 1,
            "volume": 1,
            "muted": False,
            "label": s["id"],
        })
    return project


# ---------------------------------------------------------------- commands

def cmd_new(a):
    det = velib.load_json(a.detections)
    name = a.name or Path(det["source"]["name"]).stem
    out = Path(a.out) if a.out else velib.VE_DIR / "projects" / f"{name}.json"
    if out.exists() and not a.force:
        print(f"{velib.repo_rel(out)} already exists (use --force to overwrite)")
        return
    save(out, from_detections(det, name, a.aspect, a.width, a.detections), a.who)
    print(f"wrote {velib.repo_rel(out)}")


def cmd_info(a):
    p = velib.load_json(a.project)
    o = p["output"]
    print(f"{p['name']}  {o['width']}x{o['height']}@{o['fps']}  updated {p.get('updated_at')} by {p.get('updated_by')}")
    t = 0.0
    for i, c in enumerate(p["clips"]):
        d = clip_len(c)
        crop = c.get("crop")
        crop_s = "full" if not crop else "crop {x:.3f},{y:.3f} {w:.3f}x{h:.3f}".format(**crop)
        flags = []
        if c.get("speed", 1) != 1:
            flags.append(f"x{c['speed']}")
        if c.get("muted"):
            flags.append("muted")
        elif c.get("volume", 1) != 1:
            flags.append(f"vol {c['volume']}")
        print(f"  [{i}] {c['id']:<5} {t:7.2f}-{t + d:7.2f}  {c['source']} {c['in']:.2f}-{c['out']:.2f}  "
              f"{c.get('fit', 'cover')} {crop_s} {' '.join(flags)} {c.get('label', '')}")
        t += d
    print(f"  total {t:.2f}s")


def cmd_validate(a):
    bad = False
    for path in a.projects:
        errs = validate(velib.load_json(path))
        print(f"{path}: {'ok' if not errs else 'INVALID'}")
        for e in errs:
            print(f"  - {e}")
        bad |= bool(errs)
    sys.exit(1 if bad else 0)


def cmd_split(a):
    p = velib.load_json(a.project)
    t = 0.0
    for i, c in enumerate(p["clips"]):
        d = clip_len(c)
        if t < a.time < t + d:
            cut = round(c["in"] + (a.time - t) * c.get("speed", 1), 3)
            right = dict(c, id=new_id(p), **{"in": cut})
            c["out"] = cut
            p["clips"].insert(i + 1, right)
            save(a.project, p, a.who)
            print(f"split {c['id']} at source {cut}s -> {c['id']}, {right['id']}")
            return
        t += d
    raise SystemExit(f"timeline time {a.time} is not inside any clip (or is on a boundary)")


def cmd_trim(a):
    p = velib.load_json(a.project)
    _, c = find(p, a.clip)
    if a.in_ is not None:
        c["in"] = a.in_
    if a.out is not None:
        c["out"] = a.out
    save(a.project, p, a.who)


def cmd_delete(a):
    p = velib.load_json(a.project)
    i, _ = find(p, a.clip)
    p["clips"].pop(i)
    save(a.project, p, a.who)


def cmd_move(a):
    p = velib.load_json(a.project)
    i, c = find(p, a.clip)
    p["clips"].pop(i)
    p["clips"].insert(max(0, min(a.index, len(p["clips"]))), c)
    save(a.project, p, a.who)


def cmd_crop(a):
    p = velib.load_json(a.project)
    _, c = find(p, a.clip)
    if a.clear:
        c["crop"] = None
    elif a.auto:
        src = p["sources"][c["source"]]
        box = None
        det_path = src.get("detections")
        if det_path and velib.repo_abs(det_path).exists():
            det = velib.load_json(velib.repo_abs(det_path))
            mid = (c["in"] + c["out"]) / 2
            seg = min(det["segments"], key=lambda s: 0 if s["start"] <= mid <= s["end"] else
                      min(abs(s["start"] - mid), abs(s["end"] - mid)), default=None)
            box = seg and seg.get("face_box")
        aspect = p["output"]["width"] / p["output"]["height"]
        c["crop"] = velib.suggest_crop(box, src["width"], src["height"], aspect)
    elif a.rect and len(a.rect) == 4:
        c["crop"] = dict(zip("xywh", (round(v, 4) for v in a.rect)))
    else:
        raise SystemExit("give x y w h, --auto or --clear")
    save(a.project, p, a.who)


def cmd_set(a):
    p = velib.load_json(a.project)
    _, c = find(p, a.clip)
    for kv in a.pairs:
        k, _, v = kv.partition("=")
        if k in ("speed", "volume"):
            c[k] = float(v)
        elif k == "muted":
            c[k] = v.lower() in ("1", "true", "yes", "on")
        elif k in ("fit", "label"):
            c[k] = v
        else:
            raise SystemExit(f"unknown key {k}")
    save(a.project, p, a.who)


def cmd_output(a):
    p = velib.load_json(a.project)
    w, _, h = a.size.lower().partition("x")
    p["output"]["width"], p["output"]["height"] = int(w), int(h)
    if a.fps:
        p["output"]["fps"] = a.fps
    save(a.project, p, a.who)


def cmd_add(a):
    p = velib.load_json(a.project)
    if a.source not in p["sources"]:
        raise SystemExit(f"no source {a.source!r}")
    clip = {"id": new_id(p), "source": a.source, "in": a.in_, "out": a.out, "crop": None, "fit": "cover",
            "speed": 1, "volume": 1, "muted": False, "label": ""}
    p["clips"].insert(len(p["clips"]) if a.at is None else a.at, clip)
    save(a.project, p, a.who)
    print(f"added {clip['id']}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--who", default="claude", help="recorded in updated_by (default: claude)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("new")
    s.add_argument("detections")
    s.add_argument("--name")
    s.add_argument("--aspect", default="9:16")
    s.add_argument("--width", type=int, help="output width (height follows the aspect)")
    s.add_argument("-o", "--out")
    s.add_argument("--force", action="store_true")
    s.set_defaults(fn=cmd_new)

    s = sub.add_parser("info")
    s.add_argument("project")
    s.set_defaults(fn=cmd_info)

    s = sub.add_parser("validate")
    s.add_argument("projects", nargs="+")
    s.set_defaults(fn=cmd_validate)

    s = sub.add_parser("split")
    s.add_argument("project")
    s.add_argument("time", type=float, help="timeline position in seconds")
    s.set_defaults(fn=cmd_split)

    s = sub.add_parser("trim")
    s.add_argument("project")
    s.add_argument("clip")
    s.add_argument("--in", dest="in_", type=float)
    s.add_argument("--out", type=float)
    s.set_defaults(fn=cmd_trim)

    s = sub.add_parser("delete")
    s.add_argument("project")
    s.add_argument("clip")
    s.set_defaults(fn=cmd_delete)

    s = sub.add_parser("move")
    s.add_argument("project")
    s.add_argument("clip")
    s.add_argument("index", type=int)
    s.set_defaults(fn=cmd_move)

    s = sub.add_parser("crop")
    s.add_argument("project")
    s.add_argument("clip")
    s.add_argument("rect", nargs="*", type=float)
    s.add_argument("--auto", action="store_true", help="frame the detected face for the output aspect")
    s.add_argument("--clear", action="store_true", help="use the full frame")
    s.set_defaults(fn=cmd_crop)

    s = sub.add_parser("set")
    s.add_argument("project")
    s.add_argument("clip")
    s.add_argument("pairs", nargs="+")
    s.set_defaults(fn=cmd_set)

    s = sub.add_parser("output")
    s.add_argument("project")
    s.add_argument("size", help="e.g. 1080x1920")
    s.add_argument("--fps", type=float)
    s.set_defaults(fn=cmd_output)

    s = sub.add_parser("add")
    s.add_argument("project")
    s.add_argument("source")
    s.add_argument("in_", type=float, metavar="in")
    s.add_argument("out", type=float)
    s.add_argument("--at", type=int, help="insert position (default: end)")
    s.set_defaults(fn=cmd_add)

    a = ap.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
