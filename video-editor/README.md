# Video editor

Upload a video and the parts where you're in frame get cut out for you
automatically. Then you, and Claude, edit them in a browser app whose state
lives in this repo, so each side sees the other's edits live.

```
 you upload            GitHub Action               editor app (GitHub Pages)
 inbox/clip.mp4  ──▶  detect.py + pipeline.py  ──▶  projects/clip.json  ◀──▶  Claude
                      detections/clip.json          (polls + commits)        (commits)
                                                         │
                                                         ▼  Render button
                                                    ve-render Action ──▶ MP4 artifact
```

## Folders

| path | what goes there |
|---|---|
| `inbox/` | **Upload your raw videos here.** |
| `reference/` | 2–5 clear photos of your face. Detection then counts only *you*, not other people. |
| `detections/` | `<video>.json`: the time ranges where you're in frame, plus suggested crops (written by the Action). |
| `projects/` | `<name>.json`: edit configs. The app and Claude both read and write these. |
| `app/` | The web editor (static HTML/JS, no build step). |
| `tools/` | Python CLI: `detect.py`, `pipeline.py`, `project.py`, `render.py`. |

## Setup (once)

1. **Merge this into `master`.** GitHub only runs manually started (`workflow_dispatch`) workflows from the default branch.
2. **Turn on Pages:** Settings → Pages → Source: **GitHub Actions**. The editor is then live at
   `https://gigimooshi2.github.io/Test/`. You can also open `app/index.html` straight from disk.
3. **Create a token for the app:** a [fine-grained token](https://github.com/settings/personal-access-tokens/new)
   for this repo with **Contents: read & write** and **Actions: read & write**. Paste it in the app under
   ⋯ → GitHub settings. It is stored only in your browser.
4. Optional: put a few photos of your face in `reference/`.

> ⚠️ This repo is **public**, so anything in `inbox/` can be seen by anyone. If the footage is
> private, make the repo private. The app and the Actions still work, but Pages on a private
> repo needs a paid plan, so you'd open `app/index.html` locally instead.

## Uploading videos

- **≤ 25 MB:** on github.com, open `video-editor/inbox/`, choose **Add file → Upload files**, then commit to `master`.
- **Bigger files:** use git. Files in `inbox/` are stored with Git LFS automatically (see `/.gitattributes`):
  ```sh
  git lfs install
  cp ~/Movies/clip.mp4 video-editor/inbox/
  git add video-editor/inbox/clip.mp4 && git commit -m "add clip" && git push
  ```
  GitHub's free LFS quota is limited, so the Actions download only the videos they need.

Each push to `inbox/` runs **Video editor · detect me** (`ve-detect.yml`). It writes
`detections/clip.json` and, if none exists yet, `projects/clip.json`: a first rough cut that
contains only the segments with you, each pre-cropped to 9:16 around your face. To re-run with
other settings (more samples, a looser face match, body detection, another aspect ratio), go to
Actions → *detect me* → Run workflow, or press **Re-detect** in the app.

## The editor

- **Cut:** drag a clip's edges to trim it, or use `[` / `]` to trim to the playhead. `S` splits at the playhead.
- **Splice:** drag clips to reorder them. Duplicate, delete, *Join next*, and add segments from any source (`+`).
- **Size:** set the output size (9:16, 16:9, 1:1, 4:5 or custom) and a per-clip crop (press `C`, then drag the
  box), choose fill or letterbox, or use *Auto-frame me* to frame the detected face.
- Speed, volume and mute per clip. Undo and redo cover everything, including edits that came in from Claude.
- **Sync:** edits autosave as commits (`… [app]`). The app checks the project file every few seconds and loads
  changes made elsewhere, e.g. by Claude (`… [claude]`). If both sides changed it, you choose which version to keep.
- **Notes:** a tab for leaving instructions for Claude. They're saved in the project file.
- **Render:** starts **Video editor · render** (`ve-render.yml`). The MP4 shows up under the run's *Artifacts*.

## Detection JSON (`detections/<video>.json`)

```jsonc
{
  "source": { "path": "video-editor/inbox/clip.mp4", "duration": 93.4, "width": 1080, "height": 1920, "fps": 30 },
  "identity": "reference",          // "reference" = matched to your photos, "any-face" = no photos given
  "total_in_frame": 61.2,
  "segments": [
    {
      "id": "seg1", "start": 3.25, "end": 17.5, "duration": 14.25,
      "confidence": 0.93,            // share of sampled frames in the segment where you were found
      "similarity": 0.71,            // mean face-match score (reference mode)
      "face_box": { "x": 0.41, "y": 0.22, "w": 0.18, "h": 0.14 },   // median, normalized 0–1
      "crop":     { "x": 0.18, "y": 0.0,  "w": 0.63, "h": 1.0 },    // suggested crop for --aspect (default 9:16)
      "track": [[3.5, 0.50, 0.29, 0.18], ...]  // [t, face_cx, face_cy, face_w] per sample, for follow-cam later
    }
  ]
}
```

## Project JSON (`projects/<name>.json`)

```jsonc
{
  "version": 1,
  "name": "clip",
  "updated_at": "2026-10-25T15:00:00Z", "updated_by": "app",   // "app" | "claude"
  "output": { "width": 1080, "height": 1920, "fps": 30, "background": "#000000" },
  "sources": {
    "clip": { "path": "video-editor/inbox/clip.mp4", "duration": 93.4, "width": 1080, "height": 1920,
              "has_audio": true, "detections": "video-editor/detections/clip.json" }
  },
  "clips": [   // played back to back, in this order
    { "id": "c1", "source": "clip", "in": 3.25, "out": 17.5,   // source seconds
      "crop": { "x": 0.18, "y": 0, "w": 0.63, "h": 1 },        // normalized; null = full frame
      "fit": "cover",                                          // "cover" fills the output, "contain" letterboxes
      "speed": 1, "volume": 1, "muted": false, "label": "seg1" }
  ],
  "notes": [ { "who": "you", "text": "make the intro shorter", "at": "…", "done": false } ]
}
```

## CLI

```sh
pip install -r video-editor/tools/requirements.txt   # + ffmpeg
python video-editor/tools/detect.py video-editor/inbox/clip.mp4 [--sample-fps 8] [--body] [--aspect 1:1]
python video-editor/tools/pipeline.py --missing           # what the Action runs
python video-editor/tools/project.py info video-editor/projects/clip.json
python video-editor/tools/project.py split video-editor/projects/clip.json 12.5
python video-editor/tools/project.py crop  video-editor/projects/clip.json c2 --auto
python video-editor/tools/render.py video-editor/projects/clip.json --scale 0.5
```
