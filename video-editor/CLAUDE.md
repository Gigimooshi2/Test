# Notes for Claude: working on video-editor projects

- Projects in `projects/*.json` are shared live with the user's editor app, which polls the file and
  autosaves the user's edits as commits ending in `[app]`. Pull right before editing, edit, then push quickly.
- Edit with `tools/project.py` where you can (it validates and sets `updated_by: claude`). If you edit by hand,
  set `"updated_by": "claude"` and `"updated_at"`, then run `tools/project.py validate`.
- End commit messages for project edits with `[claude]` so the app's Activity tab labels them.
- Read the `notes` array for the user's requests. Add your own note (`"who": "claude"`) saying what you
  changed, and set `"done": true` on the requests you handled.
- Times: clip `in`/`out` are **source** seconds; `project.py split` takes **timeline** seconds.
- Re-run detection: dispatch `ve-detect.yml` (input `video`). Render: dispatch `ve-render.yml` (input `project`).
