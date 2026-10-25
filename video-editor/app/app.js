// Clip Editor: a small timeline editor whose state is a JSON file in a GitHub repo.
// The app polls that file, so edits made elsewhere (by Claude, a script or another
// browser) show up live, and it commits your own edits back.
"use strict";

const DEFAULTS = { owner: "Gigimooshi2", repo: "Test", branch: "master", poll: 5 };
const PROJECTS_DIR = "video-editor/projects";
const INBOX_DIR = "video-editor/inbox";
const DETECTIONS_DIR = "video-editor/detections";
const RENDER_WORKFLOW = "ve-render.yml";
const DETECT_WORKFLOW = "ve-detect.yml";
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;
const MIN_CLIP = 0.1;
const TL_PAD = 12;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 10000) / 10000;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");

function fmt(t, cs = true) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, "0")}:${cs ? s.toFixed(2).padStart(5, "0") : String(Math.floor(s)).padStart(2, "0")}`;
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

// ------------------------------------------------------------------ state

const S = {
  cfg: loadCfg(),
  gh: null,
  local: false,          // project came from a file on disk, not GitHub
  path: null,            // repo path of the project file
  sha: null,
  etag: null,
  project: null,
  dirty: false,
  editSeq: 0,
  pendingLabels: [],
  saving: false,
  saveTimer: null,
  pollTimer: null,
  sel: null,
  playhead: 0,
  playing: false,
  active: null,
  zoom: 60,
  cropMode: false,
  lockAspect: true,
  scrub: null,           // {source, time} frame shown while trimming
  undo: [],
  redo: [],
  videos: {},            // source id -> {el, status, msg, key}
  dets: {},              // source id -> detections JSON
  runs: [],
};

function loadCfg() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("ve.cfg") || "{}"); } catch (_) { /* storage blocked */ }
  const cfg = { ...DEFAULTS, token: "", ...saved };
  if (!saved.owner && location.hostname.endsWith(".github.io")) {
    cfg.owner = location.hostname.split(".")[0];
    cfg.repo = location.pathname.split("/").filter(Boolean)[0] || cfg.repo;
  }
  return cfg;
}

function saveCfg() {
  try { localStorage.setItem("ve.cfg", JSON.stringify(S.cfg)); } catch (_) { /* storage blocked */ }
}

// ------------------------------------------------------------------ project model

function normalize(p) {
  p.version = 1;
  p.name = p.name || "untitled";
  p.output = { width: 1080, height: 1920, fps: 30, background: "#000000", ...(p.output || {}) };
  p.sources = p.sources || {};
  p.clips = (p.clips || []).map((c) => ({
    crop: null, fit: "cover", speed: 1, volume: 1, muted: false, label: "", ...c,
  }));
  p.notes = p.notes || [];
  return p;
}

const clipLen = (c) => (c.out - c.in) / (c.speed || 1);
const totalLen = () => (S.project ? S.project.clips.reduce((a, c) => a + clipLen(c), 0) : 0);

function clipStart(idx) {
  let t = 0;
  for (let i = 0; i < idx; i++) t += clipLen(S.project.clips[i]);
  return t;
}

/** Clip under timeline time t -> {idx, clip, start, src} (src = source time). */
function clipAt(t) {
  if (!S.project) return null;
  let start = 0;
  const clips = S.project.clips;
  for (let i = 0; i < clips.length; i++) {
    const d = clipLen(clips[i]);
    if (t < start + d || i === clips.length - 1) {
      const off = clamp(t - start, 0, d);
      return { idx: i, clip: clips[i], start, src: clips[i].in + off * (clips[i].speed || 1) };
    }
    start += d;
  }
  return null;
}

const selClip = () => S.project?.clips.find((c) => c.id === S.sel) || null;
const selIdx = () => S.project ? S.project.clips.findIndex((c) => c.id === S.sel) : -1;

function newClipId() {
  const used = new Set(S.project.clips.map((c) => c.id));
  let n = 1;
  while (used.has(`c${n}`)) n++;
  return `c${n}`;
}

/** Port of velib.suggest_crop: largest crop of `aspect` (w/h) framed around a face box. */
function suggestCrop(face, srcW, srcH, aspect) {
  const srcAspect = srcW / srcH;
  if (Math.abs(srcAspect - aspect) < 0.01) return null;
  let cw, ch;
  if (aspect < srcAspect) { ch = srcH; cw = srcH * aspect; } else { cw = srcW; ch = srcW / aspect; }
  const fcx = face ? (face.x + face.w / 2) * srcW : srcW / 2;
  const fcy = face ? (face.y + face.h / 2) * srcH : srcH / 2;
  const x = clamp(fcx - cw / 2, 0, srcW - cw);
  const y = clamp(fcy - ch * 0.4, 0, srcH - ch);
  return { x: r4(x / srcW), y: r4(y / srcH), w: r4(cw / srcW), h: r4(ch / srcH) };
}

function srcDims(sourceId) {
  const src = S.project.sources[sourceId] || {};
  const el = S.videos[sourceId]?.el;
  const w = el?.videoWidth || src.width || 1920;
  const h = el?.videoHeight || src.height || 1080;
  return { w, h };
}

function srcDuration(sourceId) {
  const el = S.videos[sourceId]?.el;
  return S.project.sources[sourceId]?.duration || (el && isFinite(el.duration) ? el.duration : Infinity);
}

function faceFor(sourceId, tIn, tOut) {
  const segs = S.dets[sourceId]?.segments || [];
  if (!segs.length) return null;
  const mid = (tIn + tOut) / 2;
  const dist = (s) => (s.start <= mid && mid <= s.end ? 0 : Math.min(Math.abs(s.start - mid), Math.abs(s.end - mid)));
  return segs.reduce((a, b) => (dist(b) < dist(a) ? b : a)).face_box || null;
}

function autoCrop(clip) {
  const { w, h } = srcDims(clip.source);
  const o = S.project.output;
  return suggestCrop(faceFor(clip.source, clip.in, clip.out), w, h, o.width / o.height);
}

// ------------------------------------------------------------------ editing + undo

const snapshot = () => JSON.stringify(S.project);

function edit(label, fn) {
  if (!S.project) return;
  S.undo.push(snapshot());
  if (S.undo.length > 200) S.undo.shift();
  S.redo = [];
  fn(S.project);
  changed(label);
}

function changed(label) {
  S.editSeq++;
  S.dirty = true;
  if (label && !S.pendingLabels.includes(label)) S.pendingLabels.push(label);
  if (S.sel && !selClip()) S.sel = null;
  S.playhead = clamp(S.playhead, 0, totalLen());
  renderAll();
  if (S.playing) startAt(S.playhead);
  scheduleSave();
}

function undo() {
  if (!S.undo.length) return;
  S.redo.push(snapshot());
  S.project = normalize(JSON.parse(S.undo.pop()));
  changed("undo");
}

function redo() {
  if (!S.redo.length) return;
  S.undo.push(snapshot());
  S.project = normalize(JSON.parse(S.redo.pop()));
  changed("redo");
}

function splitAtPlayhead() {
  const hit = clipAt(S.playhead);
  if (!hit) return;
  const { clip, src } = hit;
  if (src - clip.in < MIN_CLIP || clip.out - src < MIN_CLIP) return toast("Too close to a clip edge to split");
  edit(`split ${clip.id}`, (p) => {
    const cut = r3(src);
    const right = { ...clip, id: newClipId(), in: cut, crop: clip.crop && { ...clip.crop } };
    p.clips[hit.idx].out = cut;
    p.clips.splice(hit.idx + 1, 0, right);
    S.sel = right.id;
  });
}

function deleteSelected() {
  const i = selIdx();
  if (i < 0) return;
  edit(`delete ${S.sel}`, (p) => {
    p.clips.splice(i, 1);
    S.sel = p.clips[Math.min(i, p.clips.length - 1)]?.id || null;
  });
}

function trimToPlayhead(side) {
  const c = selClip();
  const hit = clipAt(S.playhead);
  if (!c || !hit || hit.clip !== c) return toast("Put the playhead inside the selected clip");
  edit(`trim ${c.id}`, () => {
    if (side === "in" && c.out - hit.src >= MIN_CLIP) c.in = r3(hit.src);
    if (side === "out" && hit.src - c.in >= MIN_CLIP) c.out = r3(hit.src);
  });
  if (side === "in") S.playhead = clipStart(selIdx());
}

function addClip(sourceId, tIn, tOut, label, at) {
  edit(`add ${sourceId}`, (p) => {
    const c = { id: newClipId(), source: sourceId, in: r3(tIn), out: r3(tOut), crop: null, fit: "cover",
      speed: 1, volume: 1, muted: false, label: label || "" };
    c.crop = autoCrop(c);
    p.clips.splice(at ?? p.clips.length, 0, c);
    S.sel = c.id;
  });
}

function moveClip(from, to) {
  if (from === to || from + 1 === to) return;
  edit("reorder", (p) => {
    const [c] = p.clips.splice(from, 1);
    p.clips.splice(to > from ? to - 1 : to, 0, c);
  });
}

// ------------------------------------------------------------------ GitHub sync

function setPill(text, cls) {
  const el = $("#syncPill");
  el.textContent = text;
  el.className = `pill ${cls || ""}`;
}

function updatePill() {
  if (!S.project) return setPill("no project");
  if (S.local) return setPill(S.dirty ? "local · unsaved" : "local file", S.dirty ? "dirty" : "");
  if (!S.gh?.canWrite) return setPill("read-only · add token to save", S.dirty ? "dirty" : "");
  if (S.saving) return setPill("saving…", "busy");
  if (S.dirty) return setPill($("#chkAutosave").checked ? "unsaved…" : "unsaved", "dirty");
  setPill("synced", "ok");
}

function connect() {
  const { owner, repo, branch, token } = S.cfg;
  S.gh = owner && repo ? new GitHub({ owner, repo, branch, token }) : null;
  clearInterval(S.pollTimer);
  if (S.gh) {
    const every = Math.max(3, +S.cfg.poll || 5) * 1000 * (token ? 1 : 12);  // unauthenticated: 60 req/h
    S.pollTimer = setInterval(poll, every);
  }
}

async function listProjects() {
  const sel = $("#projectSelect");
  if (!S.gh) { sel.innerHTML = "<option>(not connected)</option>"; return []; }
  let files = [];
  try {
    files = (await S.gh.listDir(PROJECTS_DIR)).filter((f) => f.type === "file" && f.name.endsWith(".json"));
  } catch (e) {
    toast(`Could not list projects: ${e.message}`, "err");
  }
  const current = S.local ? null : S.path;
  sel.innerHTML = files.length
    ? files.map((f) => `<option value="${esc(f.path)}" ${f.path === current ? "selected" : ""}>${esc(f.name.replace(/\.json$/, ""))}</option>`).join("")
    : "<option value=''>(no projects yet)</option>";
  if (S.local) sel.insertAdjacentHTML("afterbegin", "<option selected>(local file)</option>");
  return files;
}

async function openProject(path) {
  if (!path || !S.gh) return;
  if (S.dirty && !confirm("You have unsaved edits. Switch project anyway?")) return;
  try {
    const r = await S.gh.readFile(path);
    S.local = false;
    S.path = path;
    S.sha = r.sha;
    S.etag = r.etag;
    S.undo = [];
    S.redo = [];
    S.sel = null;
    S.playhead = 0;
    setProject(JSON.parse(r.text));
    history.replaceState(null, "", `#project=${encodeURIComponent(path.split("/").pop().replace(/\.json$/, ""))}`);
    refreshActivity();
  } catch (e) {
    toast(`Could not open ${path}: ${e.message}`, "err");
  }
}

function setProject(p) {
  stop();
  S.project = normalize(p);
  S.dirty = false;
  S.pendingLabels = [];
  if (S.sel && !selClip()) S.sel = null;
  S.playhead = clamp(S.playhead, 0, totalLen());
  syncSources();
  renderAll();
}

async function poll() {
  if (!S.gh || !S.path || S.local || S.saving || document.hidden) return;
  try {
    const r = await S.gh.readFile(S.path, S.etag);
    if (r.status === 304) return;
    S.etag = r.etag;
    if (r.sha === S.sha) return;
    const remote = JSON.parse(r.text);
    if (!S.dirty) {
      applyRemote(remote, r.sha);
    } else {
      conflict(remote, r.sha);
    }
  } catch (e) {
    if (e.status !== 404) console.warn("poll failed", e);
  }
}

function applyRemote(remote, sha) {
  S.undo.push(snapshot());  // so a remote change can be undone too
  S.sha = sha;
  const wasPlaying = S.playing;
  setProject(remote);
  if (wasPlaying) play();
  const who = remote.updated_by || "someone";
  toast(`Project updated by ${who}`, who === "claude" ? "claude" : "");
  refreshActivity();
}

async function conflict(remote, sha) {
  const dlg = $("#dlgConflict");
  if (dlg.open) return;
  $("#conflictText").textContent =
    `${remote.updated_by || "Someone"} changed this project (${remote.updated_at || "just now"}) while you had unsaved edits.`;
  dlg.showModal();
  dlg.onclose = () => {
    if (dlg.returnValue === "theirs") {
      applyRemote(remote, sha);
    } else {
      S.sha = sha;  // overwrite on next save
      save();
    }
  };
}

function scheduleSave() {
  updatePill();
  clearTimeout(S.saveTimer);
  if ($("#chkAutosave").checked && !S.local && S.gh?.canWrite) S.saveTimer = setTimeout(save, 2500);
}

async function save() {
  clearTimeout(S.saveTimer);
  if (S.local) return downloadJson();
  if (!S.project || !S.dirty || S.saving) return;
  if (!S.gh?.canWrite) return toast("Add a GitHub token in settings to save", "err");
  if (!S.path) S.path = `${PROJECTS_DIR}/${slug(S.project.name)}.json`;
  S.saving = true;
  updatePill();
  const seq = S.editSeq;
  const labels = S.pendingLabels.splice(0);
  const p = JSON.parse(snapshot());
  p.updated_at = nowIso();
  p.updated_by = "app";
  const text = JSON.stringify(p, null, 2) + "\n";
  const summary = labels.slice(0, 4).join(", ") + (labels.length > 4 ? ` +${labels.length - 4} more` : "");
  try {
    const r = await S.gh.writeFile(S.path, text, S.sha, `edit(${p.name}): ${summary || "update"} [app]`);
    S.sha = r.sha;
    S.project.updated_at = p.updated_at;
    S.project.updated_by = "app";
    if (S.editSeq === seq) S.dirty = false;
    else scheduleSave();
    setTimeout(refreshActivity, 1500);
  } catch (e) {
    S.pendingLabels.unshift(...labels);
    if (e.status === 409 || e.status === 422) {
      try {
        const r = await S.gh.readFile(S.path);
        S.etag = r.etag;
        conflict(JSON.parse(r.text), r.sha);
      } catch (e2) { toast(`Save failed: ${e2.message}`, "err"); }
    } else {
      toast(`Save failed: ${e.message}`, "err");
      setPill("save failed", "err");
    }
  } finally {
    S.saving = false;
    if (!$("#syncPill").classList.contains("err")) updatePill();
  }
}

const slug = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";

function downloadJson() {
  if (!S.project) return;
  const blob = new Blob([JSON.stringify(S.project, null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${slug(S.project.name)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  if (S.local) { S.dirty = false; updatePill(); }
}

// ------------------------------------------------------------------ sources / video

function syncSources() {
  const ids = Object.keys(S.project.sources);
  for (const id of Object.keys(S.videos)) {
    if (!ids.includes(id)) { S.videos[id].el.removeAttribute("src"); delete S.videos[id]; }
  }
  for (const id of ids) {
    const src = S.project.sources[id];
    const key = src.url || src.path || "";
    const v = S.videos[id];
    if (v && (v.key === key || v.localFile)) continue;
    makeVideo(id, key);
    if (src.url) setVideoSrc(id, src.url);
    else if (src.path && S.gh) loadFromGitHub(id);
    else setVideoStatus(id, "idle", "pick a local file");
    loadDetections(id);
  }
}

function makeVideo(id, key) {
  const el = document.createElement("video");
  el.preload = "auto";
  el.playsInline = true;
  el.addEventListener("loadedmetadata", () => {
    setVideoStatus(id, "ready", `${el.videoWidth}×${el.videoHeight} · ${fmt(el.duration)}`);
    fillSourceMeta(id, el);
    layoutCanvas();
    if (!S.playing) showFrameAt(S.playhead);
  });
  el.addEventListener("error", () => setVideoStatus(id, "err", "could not play this file here"));
  S.videos[id] = { el, status: "idle", msg: "", key };
}

function fillSourceMeta(id, el) {
  const src = S.project?.sources[id];
  if (!src) return;
  if (!src.duration || !src.width || !src.height) {
    // Metadata the detector normally provides; fill it in for hand-added sources.
    edit(`probe ${id}`, () => {
      src.duration = src.duration || r3(el.duration);
      src.width = src.width || el.videoWidth;
      src.height = src.height || el.videoHeight;
    });
  }
}

function setVideoSrc(id, url) {
  const v = S.videos[id];
  setVideoStatus(id, "loading", "loading…");
  v.el.src = url;
  v.el.load();
}

function setVideoStatus(id, status, msg) {
  const v = S.videos[id];
  if (!v) return;
  v.status = status;
  v.msg = msg;
  renderSources();
}

async function loadFromGitHub(id) {
  const src = S.project.sources[id];
  if (!src?.path || !S.gh) return;
  setVideoStatus(id, "loading", "locating video…");
  try {
    const url = await S.gh.videoUrl(src.path, (f) => setVideoStatus(id, "loading", `downloading ${Math.round(f * 100)}%`));
    setVideoSrc(id, url);
  } catch (e) {
    setVideoStatus(id, "err", `${e.message} — pick a local file`);
  }
}

function pickLocalFile(id) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "video/*";
  input.onchange = () => {
    const f = input.files[0];
    if (!f) return;
    S.videos[id].localFile = f.name;
    setVideoSrc(id, URL.createObjectURL(f));
  };
  input.click();
}

async function loadDetections(id) {
  const src = S.project.sources[id];
  const stem = (src.path || src.url || id).split("/").pop().replace(/\.[^.]+$/, "");
  const path = src.detections || `${DETECTIONS_DIR}/${stem}.json`;
  if (!S.gh) return;
  try {
    const r = await S.gh.readFile(path);
    S.dets[id] = JSON.parse(r.text);
    renderSources();
  } catch (_) { /* no detections for this source */ }
}

async function addSourceFromInbox() {
  if (!S.project) return toast("Open or create a project first");
  if (!S.gh) return toast("Connect to GitHub first", "err");
  const files = (await S.gh.listDir(INBOX_DIR)).filter((f) => f.type === "file" && VIDEO_EXT.test(f.name));
  const choice = await pick("Add a video from video-editor/inbox", files.map((f) => ({ value: f.path, label: f.name, meta: `${(f.size / 1e6).toFixed(1)} MB` })));
  if (!choice) return;
  const stem = choice.split("/").pop().replace(/\.[^.]+$/, "");
  let id = stem;
  for (let n = 2; S.project.sources[id]; n++) id = `${stem}-${n}`;
  edit(`add source ${id}`, (p) => {
    p.sources[id] = { path: choice, detections: `${DETECTIONS_DIR}/${stem}.json` };
  });
}

// ------------------------------------------------------------------ preview + playback

const canvas = $("#preview");
const ctx = canvas.getContext("2d");

function layoutCanvas() {
  const stage = $("#stage").getBoundingClientRect();
  let aw, ah;
  const c = selClip();
  if (S.cropMode && c) {
    const d = srcDims(c.source);
    aw = d.w; ah = d.h;
  } else if (S.project) {
    aw = S.project.output.width; ah = S.project.output.height;
  } else { aw = 16; ah = 9; }
  const scale = Math.min((stage.width - 24) / aw, (stage.height - 24) / ah);
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.max(16, Math.floor(aw * scale));
  const ch = Math.max(16, Math.floor(ah * scale));
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  canvas.classList.toggle("crop", S.cropMode);
}

/** Draw `clip`'s current frame from `el` into the canvas, applying crop + fit. */
function drawClipFrame(el, clip, W, H) {
  const vw = el.videoWidth, vh = el.videoHeight;
  const cr = clip.crop || { x: 0, y: 0, w: 1, h: 1 };
  const sx = cr.x * vw, sy = cr.y * vh, sw = cr.w * vw, sh = cr.h * vh;
  const k = clip.fit === "contain" ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh);
  const dw = sw * k, dh = sh * k;
  ctx.drawImage(el, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function videoReady(id) {
  const v = S.videos[id];
  return v && v.el.readyState >= 2 ? v.el : null;
}

function draw() {
  const W = canvas.width, H = canvas.height;
  if (S.project && !S.cropMode) {
    // Mid-seek the video has no frame to give; keep the previous one on screen.
    const hit = S.scrub ? null : clipAt(S.playhead);
    const v = hit && S.videos[hit.clip.source];
    if (v && v.status === "ready" && v.el.readyState < 2) return;
  }
  ctx.fillStyle = S.project?.output.background || "#000";
  ctx.fillRect(0, 0, W, H);
  let msg = "";
  if (!S.project) msg = "Open a project from the menu at the top";
  else if (!S.project.clips.length) msg = "Empty timeline: add segments from Sources";
  else if (S.cropMode && selClip()) return drawCropMode();
  else {
    let clip, el;
    if (S.scrub) {
      clip = S.project.clips.find((c) => c.id === S.scrub.clip);
      el = clip && videoReady(clip.source);
    } else {
      const hit = clipAt(S.playhead);
      clip = hit?.clip;
      el = clip && videoReady(clip.source);
    }
    if (clip && el) drawClipFrame(el, clip, W, H);
    else if (clip) msg = `Source “${clip.source}”: ${S.videos[clip.source]?.msg || "not loaded"}`;
  }
  const box = $("#stageMsg");
  if (box.textContent !== msg) box.textContent = msg;
}

function tick() {
  if (S.playing && S.active) {
    const { idx, el } = S.active;
    const clip = S.project.clips[idx];
    if (!clip) { stop(); } else {
      const start = clipStart(idx);
      let t;
      if (el) {
        t = start + (el.currentTime - clip.in) / (clip.speed || 1);
        if (el.currentTime >= clip.out - 0.01 || el.ended) t = start + clipLen(clip);
      } else {
        t = S.active.t0 + (performance.now() - S.active.wall) / 1000;
      }
      if (t >= start + clipLen(clip) - 1e-3) {
        if (idx + 1 < S.project.clips.length) startAt(start + clipLen(clip) + 1e-4);
        else { S.playhead = totalLen(); stop(); }
      } else {
        S.playhead = Math.max(start, t);
      }
    }
    updatePlayhead(true);
  }
  draw();
  requestAnimationFrame(tick);
}

function pauseAll() {
  for (const v of Object.values(S.videos)) if (!v.el.paused) v.el.pause();
}

function startAt(t) {
  const hit = clipAt(t);
  if (!hit) return stop();
  const { idx, clip, src } = hit;
  const el = videoReady(clip.source);
  pauseAll();
  S.playhead = t;
  if (!el) {
    S.active = { idx, el: null, t0: t, wall: performance.now() };
    return;
  }
  el.currentTime = src;
  el.playbackRate = clip.speed || 1;
  el.volume = clamp(clip.volume ?? 1, 0, 1);
  el.muted = !!clip.muted;
  el.play().catch(() => {});
  S.active = { idx, el };
}

function play() {
  if (!S.project?.clips.length) return;
  if (S.cropMode) toggleCropMode(false);
  if (S.playhead >= totalLen() - 0.02) S.playhead = 0;
  S.playing = true;
  startAt(S.playhead);
  $("#btnPlay").textContent = "❚❚";
}

function stop() {
  S.playing = false;
  S.active = null;
  pauseAll();
  $("#btnPlay").textContent = "▶";
  showFrameAt(S.playhead);
}

const togglePlay = () => (S.playing ? stop() : play());

/** Paused: seek the right source video so the preview shows timeline time t. */
function showFrameAt(t) {
  const hit = clipAt(t);
  if (!hit) return;
  const el = S.videos[hit.clip.source]?.el;
  if (el && el.readyState >= 1 && Math.abs(el.currentTime - hit.src) > 0.02) el.currentTime = hit.src;
}

function seek(t) {
  S.playhead = clamp(t, 0, totalLen());
  if (S.playing) startAt(S.playhead);
  else showFrameAt(S.playhead);
  updatePlayhead();
  if (S.cropMode) renderInspector();
}

function step(dt) {
  if (S.playing) stop();
  seek(S.playhead + dt);
}

// ------------------------------------------------------------------ crop editing

let cropDrag = null;

function cropGeom() {
  const c = selClip();
  const W = canvas.width, H = canvas.height;
  const cr = c.crop || { x: 0, y: 0, w: 1, h: 1 };
  return { c, W, H, cr, px: { x: cr.x * W, y: cr.y * H, w: cr.w * W, h: cr.h * H } };
}

function drawCropMode() {
  const { c, W, H, px } = cropGeom();
  const el = videoReady(c.source);
  if (el) {
    const hit = clipAt(S.playhead);
    const t = hit && hit.clip === c ? hit.src : c.in;
    if (!S.playing && Math.abs(el.currentTime - t) > 0.05 && !el.seeking) el.currentTime = t;
    ctx.drawImage(el, 0, 0, W, H);
  }
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.rect(px.x, px.y, px.w, px.h);
  ctx.fill("evenodd");
  const dpr = window.devicePixelRatio || 1;
  ctx.strokeStyle = "#4f8cff";
  ctx.lineWidth = 2 * dpr;
  ctx.strokeRect(px.x, px.y, px.w, px.h);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = dpr;
  for (const f of [1 / 3, 2 / 3]) {
    ctx.beginPath();
    ctx.moveTo(px.x + px.w * f, px.y); ctx.lineTo(px.x + px.w * f, px.y + px.h);
    ctx.moveTo(px.x, px.y + px.h * f); ctx.lineTo(px.x + px.w, px.y + px.h * f);
    ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  const hs = 10 * dpr;
  for (const [x, y] of corners(px)) ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
  const box = $("#stageMsg");
  const msg = el ? "Drag to move the crop, drag a corner to resize" : `Source “${c.source}” not loaded`;
  if (box.textContent !== msg) box.textContent = msg;
}

const corners = (p) => [[p.x, p.y], [p.x + p.w, p.y], [p.x, p.y + p.h], [p.x + p.w, p.y + p.h]];

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
}

canvas.addEventListener("pointerdown", (e) => {
  if (!S.cropMode || !selClip()) return;
  const { c, px, cr } = cropGeom();
  const p = canvasPoint(e);
  const tol = 16 * (window.devicePixelRatio || 1);
  const ci = corners(px).findIndex(([x, y]) => Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol);
  const inside = p.x >= px.x && p.x <= px.x + px.w && p.y >= px.y && p.y <= px.y + px.h;
  if (ci < 0 && !inside) return;
  canvas.setPointerCapture(e.pointerId);
  S.undo.push(snapshot());
  S.redo = [];
  if (!c.crop) c.crop = { ...cr };
  const opp = corners(px)[3 - ci];
  cropDrag = { mode: ci >= 0 ? "resize" : "move", start: p, orig: { ...c.crop }, fixed: opp };
});

canvas.addEventListener("pointermove", (e) => {
  if (!cropDrag) {
    if (S.cropMode && selClip()) {
      const { px } = cropGeom();
      const p = canvasPoint(e);
      const tol = 16 * (window.devicePixelRatio || 1);
      const onCorner = corners(px).some(([x, y]) => Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol);
      canvas.style.cursor = onCorner ? "nwse-resize" : "move";
    }
    return;
  }
  const c = selClip();
  const W = canvas.width, H = canvas.height;
  const p = canvasPoint(e);
  if (cropDrag.mode === "move") {
    const o = cropDrag.orig;
    c.crop.x = r4(clamp(o.x + (p.x - cropDrag.start.x) / W, 0, 1 - o.w));
    c.crop.y = r4(clamp(o.y + (p.y - cropDrag.start.y) / H, 0, 1 - o.h));
  } else {
    const [fx, fy] = cropDrag.fixed;
    const dirX = p.x >= fx ? 1 : -1, dirY = p.y >= fy ? 1 : -1;
    let w = Math.abs(p.x - fx), h = Math.abs(p.y - fy);
    const maxW = dirX > 0 ? W - fx : fx, maxH = dirY > 0 ? H - fy : fy;
    if (S.lockAspect) {
      const a = S.project.output.width / S.project.output.height;  // in canvas pixels (canvas = source aspect)
      w = Math.max(w, h * a);
      h = w / a;
      const k = Math.min(1, maxW / w, maxH / h);
      w *= k; h *= k;
    } else {
      w = Math.min(w, maxW); h = Math.min(h, maxH);
    }
    w = Math.max(w, W * 0.05); h = Math.max(h, H * 0.05);
    const x = dirX > 0 ? fx : fx - w, y = dirY > 0 ? fy : fy - h;
    c.crop = { x: r4(clamp(x / W, 0, 1)), y: r4(clamp(y / H, 0, 1)), w: r4(Math.min(w / W, 1)), h: r4(Math.min(h / H, 1)) };
  }
  renderInspector();
});

function endCropDrag() {
  if (!cropDrag) return;
  cropDrag = null;
  S.redo = [];
  changed(`crop ${S.sel}`);
}
canvas.addEventListener("pointerup", endCropDrag);
canvas.addEventListener("pointercancel", endCropDrag);

function toggleCropMode(on = !S.cropMode) {
  if (on && !selClip()) {
    const hit = clipAt(S.playhead);
    if (!hit) return toast("Select a clip first");
    S.sel = hit.clip.id;
  }
  if (on && S.playing) stop();
  S.cropMode = on;
  $("#btnCropMode").classList.toggle("primary", on);
  layoutCanvas();
  renderAll();
}

// ------------------------------------------------------------------ timeline

const tl = $("#timeline");
const track = $("#track");

function renderTimeline() {
  const clips = S.project?.clips || [];
  const total = totalLen();
  const width = Math.max(total * S.zoom + 200, tl.clientWidth - TL_PAD * 2);
  track.style.width = `${width}px`;
  $("#ruler").style.width = `${width}px`;
  let t = 0;
  track.innerHTML = clips.map((c, i) => {
    const d = clipLen(c);
    const html = `<div class="clip ${c.id === S.sel ? "sel" : ""}" data-idx="${i}" style="left:${t * S.zoom}px;width:${Math.max(d * S.zoom, 6)}px"
      title="${esc(c.id)} · ${esc(c.source)} ${c.in.toFixed(2)}–${c.out.toFixed(2)}s">
      <div class="h l" data-h="l"></div>
      <div class="t">${i + 1}. ${esc(c.label || c.source)}</div>
      <div class="d">${d.toFixed(2)}s${c.speed !== 1 ? ` · ×${c.speed}` : ""}${c.muted ? " · 🔇" : ""}${c.crop ? " · ⛶" : ""}</div>
      <div class="d">${esc(c.source)} ${fmt(c.in)}</div>
      <div class="h r" data-h="r"></div>
    </div>`;
    t += d;
    return html;
  }).join("");
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const every = steps.find((s) => s * S.zoom >= 70) || 600;
  let ticks = "";
  for (let x = 0; x <= width / S.zoom; x += every) ticks += `<div class="tick" style="left:${x * S.zoom}px">${fmt(x, every < 1)}</div>`;
  $("#ruler").innerHTML = ticks;
  $("#tlInfo").textContent = clips.length ? `${clips.length} clips · ${fmt(total)}` : "";
  updatePlayhead();
}

function updatePlayhead(follow) {
  const x = TL_PAD + S.playhead * S.zoom;
  $("#playhead").style.left = `${x}px`;
  $("#timecode").textContent = `${fmt(S.playhead)} / ${fmt(totalLen())}`;
  if (follow && (x > tl.scrollLeft + tl.clientWidth - 40 || x < tl.scrollLeft)) tl.scrollLeft = x - 60;
}

const tlTime = (e) => (e.clientX - track.getBoundingClientRect().left) / S.zoom;

let drag = null;

tl.addEventListener("pointerdown", (e) => {
  if (!S.project || e.button !== 0) return;
  const handle = e.target.closest(".h");
  const clipEl = e.target.closest(".clip");
  tl.setPointerCapture(e.pointerId);
  if (handle && clipEl) {
    const idx = +clipEl.dataset.idx;
    const c = S.project.clips[idx];
    S.sel = c.id;
    S.undo.push(snapshot());
    S.redo = [];
    drag = { kind: "trim", side: handle.dataset.h, c, idx, x0: e.clientX, in0: c.in, out0: c.out };
    if (S.playing) stop();
  } else if (clipEl) {
    drag = { kind: "clip", idx: +clipEl.dataset.idx, x0: e.clientX, moved: false, el: clipEl };
  } else {
    drag = { kind: "scrub" };
    seek(tlTime(e));
  }
});

tl.addEventListener("pointermove", (e) => {
  if (!drag) return;
  if (drag.kind === "scrub") return seek(tlTime(e));
  if (drag.kind === "trim") {
    const { c } = drag;
    const d = ((e.clientX - drag.x0) / S.zoom) * (c.speed || 1);
    if (drag.side === "l") {
      c.in = r3(clamp(drag.in0 + d, 0, c.out - MIN_CLIP));
      S.scrub = { clip: c.id };
      seekSource(c.source, c.in);
    } else {
      c.out = r3(clamp(drag.out0 + d, c.in + MIN_CLIP, srcDuration(c.source)));
      S.scrub = { clip: c.id };
      seekSource(c.source, c.out);
    }
    renderTimeline();
    renderInspector();
    return;
  }
  if (drag.kind === "clip") {
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 5) return;
    drag.moved = true;
    drag.el.classList.add("dragging");
    drag.el.style.transform = `translateX(${e.clientX - drag.x0}px)`;
    drag.to = dropIndex(e);
    let m = track.querySelector(".drop-marker");
    if (!m) { m = document.createElement("div"); m.className = "drop-marker"; track.appendChild(m); }
    m.style.left = `${clipStart(drag.to) * S.zoom - 2}px`;
  }
});

function dropIndex(e) {
  const t = tlTime(e);
  let start = 0;
  const clips = S.project.clips;
  for (let i = 0; i < clips.length; i++) {
    const d = clipLen(clips[i]);
    if (t < start + d / 2) return i;
    start += d;
  }
  return clips.length;
}

function seekSource(id, time) {
  const el = S.videos[id]?.el;
  if (el && el.readyState >= 1) el.currentTime = time;
}

function endDrag(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (d.kind === "trim") {
    S.scrub = null;
    if (d.c.in !== d.in0 || d.c.out !== d.out0) changed(`trim ${d.c.id}`);
    else S.undo.pop();
    seek(d.side === "l" ? clipStart(d.idx) : clipStart(d.idx) + clipLen(d.c) - 0.01);
  } else if (d.kind === "clip") {
    if (d.moved && e.type === "pointerup") moveClip(d.idx, d.to);
    else if (!d.moved) {
      S.sel = S.project.clips[d.idx].id;
      seek(tlTime(e));
      renderAll();
    } else renderTimeline();
  }
}
tl.addEventListener("pointerup", endDrag);
tl.addEventListener("pointercancel", endDrag);

// ------------------------------------------------------------------ panels

function renderAll() {
  renderTimeline();
  renderInspector();
  renderSources();
  renderOutput();
  renderNotes();
  updatePill();
  $("#btnUndo").disabled = !S.undo.length;
  $("#btnRedo").disabled = !S.redo.length;
  $("#btnRender").disabled = !S.project || !S.gh?.canWrite || S.local;
  if (S.cropMode && !selClip()) toggleCropMode(false);
  else layoutCanvas();
}

function renderInspector() {
  const box = $("#tab-inspector");
  box.classList.add("inspector");
  const c = selClip();
  if (!c) {
    box.innerHTML = `<div class="empty">Click a clip on the timeline to edit it.</div>`;
    return;
  }
  const i = selIdx();
  const next = S.project.clips[i + 1];
  const canJoin = next && next.source === c.source && Math.abs(next.in - c.out) < 0.05;
  const hit = clipAt(S.playhead);
  const inClip = hit && hit.clip === c;
  const cr = c.crop || { x: 0, y: 0, w: 1, h: 1 };
  const srcOpts = Object.keys(S.project.sources).map((s) => `<option ${s === c.source ? "selected" : ""}>${esc(s)}</option>`).join("");
  box.innerHTML = `
    <div class="field"><label>Label <input data-k="label" value="${esc(c.label)}" style="width:100%"></label></div>
    <div class="grid2 field">
      <label>Clip <input value="${esc(c.id)} · #${i + 1}" disabled></label>
      <label>Source <select data-k="source">${srcOpts}</select></label>
    </div>
    <h3>Cut</h3>
    <div class="grid2 field">
      <label>In (s) <input type="number" step="0.01" min="0" data-k="in" value="${c.in}"></label>
      <label>Out (s) <input type="number" step="0.01" min="0" data-k="out" value="${c.out}"></label>
    </div>
    <div class="btnrow">
      <button class="small" data-a="setin" ${inClip ? "" : "disabled"} title="[">In ⟵ playhead</button>
      <button class="small" data-a="setout" ${inClip ? "" : "disabled"} title="]">Out ⟵ playhead</button>
      <button class="small" data-a="split" ${inClip ? "" : "disabled"} title="S">✂ Split</button>
    </div>
    <h3>Splice</h3>
    <div class="btnrow">
      <button class="small" data-a="left" ${i > 0 ? "" : "disabled"}>◀ Move</button>
      <button class="small" data-a="right" ${next ? "" : "disabled"}>Move ▶</button>
      <button class="small" data-a="dup">Duplicate</button>
      <button class="small" data-a="join" ${canJoin ? "" : "disabled"} title="Merge with the next clip (same source, back-to-back)">Join next</button>
      <button class="small danger" data-a="del" title="Delete">Delete</button>
    </div>
    <h3>Size &amp; crop</h3>
    <div class="field"><label>Fit into output
      <select data-k="fit" style="width:100%">
        <option value="cover" ${c.fit === "cover" ? "selected" : ""}>Fill (crop to output)</option>
        <option value="contain" ${c.fit === "contain" ? "selected" : ""}>Fit (letterbox)</option>
      </select></label></div>
    <div class="grid4 field">
      <label>x <input type="number" step="0.01" min="0" max="1" data-crop="x" value="${cr.x}"></label>
      <label>y <input type="number" step="0.01" min="0" max="1" data-crop="y" value="${cr.y}"></label>
      <label>w <input type="number" step="0.01" min="0.01" max="1" data-crop="w" value="${cr.w}"></label>
      <label>h <input type="number" step="0.01" min="0.01" max="1" data-crop="h" value="${cr.h}"></label>
    </div>
    <div class="btnrow">
      <button class="small ${S.cropMode ? "primary" : ""}" data-a="cropmode">⛶ ${S.cropMode ? "Done" : "Edit crop"}</button>
      <button class="small" data-a="autocrop" title="Frame the detected face for the output aspect">Auto-frame me</button>
      <button class="small" data-a="fullframe">Full frame</button>
    </div>
    <label class="toggle"><input type="checkbox" data-a="lock" ${S.lockAspect ? "checked" : ""}> lock crop to output aspect</label>
    <h3>Speed &amp; audio</h3>
    <div class="grid2 field">
      <label>Speed × <input type="number" step="0.05" min="0.1" max="10" data-k="speed" value="${c.speed}"></label>
      <label>Volume <input type="number" step="0.05" min="0" max="4" data-k="volume" value="${c.volume}"></label>
    </div>
    <label class="toggle"><input type="checkbox" data-k="muted" ${c.muted ? "checked" : ""}> mute</label>
    <p class="hint">Length ${clipLen(c).toFixed(2)}s · source ${esc(S.project.sources[c.source]?.path || "")}</p>`;
}

$("#tab-inspector").addEventListener("change", (e) => {
  const c = selClip();
  if (!c) return;
  const k = e.target.dataset.k;
  const ck = e.target.dataset.crop;
  if (e.target.dataset.a === "lock") { S.lockAspect = e.target.checked; return; }
  if (k) {
    edit(`${k} ${c.id}`, () => {
      const v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
      if (k === "in") c.in = r3(clamp(+v, 0, c.out - MIN_CLIP));
      else if (k === "out") c.out = r3(clamp(+v, c.in + MIN_CLIP, srcDuration(c.source)));
      else if (k === "speed") c.speed = clamp(+v || 1, 0.1, 10);
      else if (k === "volume") c.volume = clamp(+v, 0, 4);
      else c[k] = v;
    });
  } else if (ck) {
    edit(`crop ${c.id}`, () => {
      const cr = { ...(c.crop || { x: 0, y: 0, w: 1, h: 1 }) };
      cr[ck] = clamp(+e.target.value, 0, 1);
      cr.w = clamp(cr.w, 0.01, 1 - cr.x);
      cr.h = clamp(cr.h, 0.01, 1 - cr.y);
      c.crop = { x: r4(cr.x), y: r4(cr.y), w: r4(cr.w), h: r4(cr.h) };
    });
  }
});

$("#tab-inspector").addEventListener("click", (e) => {
  const a = e.target.closest("button")?.dataset.a;
  const c = selClip();
  if (!a || !c) return;
  const i = selIdx();
  if (a === "setin") trimToPlayhead("in");
  else if (a === "setout") trimToPlayhead("out");
  else if (a === "split") splitAtPlayhead();
  else if (a === "del") deleteSelected();
  else if (a === "left") moveClip(i, i - 1);
  else if (a === "right") moveClip(i, i + 2);
  else if (a === "dup") edit(`duplicate ${c.id}`, (p) => {
    const d = { ...c, id: newClipId(), crop: c.crop && { ...c.crop } };
    p.clips.splice(i + 1, 0, d);
    S.sel = d.id;
  });
  else if (a === "join") edit(`join ${c.id}`, (p) => {
    c.out = p.clips[i + 1].out;
    p.clips.splice(i + 1, 1);
  });
  else if (a === "cropmode") toggleCropMode();
  else if (a === "autocrop") {
    if (!S.dets[c.source]) toast("No detections for this source; centering instead");
    edit(`auto-frame ${c.id}`, () => { c.crop = autoCrop(c); });
  } else if (a === "fullframe") edit(`full frame ${c.id}`, () => { c.crop = null; });
});

function renderSources() {
  const box = $("#sources");
  if (!S.project) { box.innerHTML = `<p class="hint">No project open.</p>`; return; }
  const ids = Object.keys(S.project.sources);
  if (!ids.length) { box.innerHTML = `<p class="hint">No sources yet.</p>`; return; }
  box.innerHTML = ids.map((id) => {
    const src = S.project.sources[id];
    const v = S.videos[id] || {};
    const det = S.dets[id];
    const dur = srcDuration(id);
    const segs = det?.segments || [];
    const bar = isFinite(dur) && segs.length
      ? `<div class="segbar" title="green = you are in frame">${segs.map((s) =>
          `<span style="left:${(s.start / dur) * 100}%;width:${((s.end - s.start) / dur) * 100}%"></span>`).join("")}</div>`
      : "";
    const list = segs.length ? `<div class="seglist">${segs.map((s, k) => `
        <div><span>${fmt(s.start)}–${fmt(s.end)}</span><span class="hint">${(s.end - s.start).toFixed(1)}s</span>
        <button class="small" data-a="addseg" data-id="${esc(id)}" data-k="${k}" title="Add to timeline">+</button></div>`).join("")}</div>` : "";
    return `<div class="source">
      <div class="name">${esc(id)}</div>
      <div class="status ${v.status === "ready" ? "ok" : v.status === "err" ? "err" : ""}">${esc(v.msg || "")}</div>
      ${det ? `<div class="hint">${segs.length} segments with you · ${det.identity === "reference" ? "matched to your photos" : "any face"}</div>` : `<div class="hint">no detections</div>`}
      ${bar}${list}
      <div class="btns">
        ${segs.length ? `<button class="small" data-a="addall" data-id="${esc(id)}">+ all segments</button>` : ""}
        <button class="small" data-a="addwhole" data-id="${esc(id)}">+ whole video</button>
        <button class="small" data-a="local" data-id="${esc(id)}" title="Use a copy of this video from your computer">Local file…</button>
        ${src.path && S.gh ? `<button class="small" data-a="reload" data-id="${esc(id)}">Reload</button>` : ""}
        ${src.path && S.gh?.canWrite ? `<button class="small" data-a="detect" data-id="${esc(id)}" title="Run the detection Action again">Re-detect</button>` : ""}
      </div>
    </div>`;
  }).join("");
}

$("#sources").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const id = b.dataset.id;
  const a = b.dataset.a;
  const segs = S.dets[id]?.segments || [];
  const at = selIdx() >= 0 ? selIdx() + 1 : undefined;
  if (a === "addseg") {
    const s = segs[+b.dataset.k];
    addClip(id, s.start, s.end, s.id, at);
  } else if (a === "addall") {
    edit(`add segments ${id}`, (p) => {
      for (const s of segs) {
        const c = { id: newClipId(), source: id, in: s.start, out: s.end, crop: null, fit: "cover",
          speed: 1, volume: 1, muted: false, label: s.id };
        const { w, h } = srcDims(id);
        c.crop = suggestCrop(s.face_box, w, h, p.output.width / p.output.height);
        p.clips.push(c);
      }
    });
  } else if (a === "addwhole") {
    const d = srcDuration(id);
    if (!isFinite(d)) return toast("Load the video first so its length is known");
    addClip(id, 0, d, "", at);
  } else if (a === "local") pickLocalFile(id);
  else if (a === "reload") { delete S.videos[id].localFile; loadFromGitHub(id); loadDetections(id); }
  else if (a === "detect") {
    try {
      await S.gh.dispatch(DETECT_WORKFLOW, { video: S.project.sources[id].path });
      toast("Detection started on GitHub Actions", "ok");
      watchRuns();
    } catch (err) { toast(`Could not start detection: ${err.message}`, "err"); }
  }
});

function renderOutput() {
  const o = S.project?.output;
  for (const el of ["#outPreset", "#outW", "#outH", "#outFps", "#outBg"]) $(el).disabled = !o;
  if (!o) return;
  const key = `${o.width}x${o.height}`;
  const preset = [...$("#outPreset").options].some((op) => op.value === key) ? key : "custom";
  $("#outPreset").value = preset;
  $("#outW").value = o.width;
  $("#outH").value = o.height;
  $("#outFps").value = o.fps;
  $("#outBg").value = o.background || "#000000";
}

function setOutput(fn, label) {
  edit(label, (p) => {
    const oldA = p.output.width / p.output.height;
    fn(p.output);
    const newA = p.output.width / p.output.height;
    if (Math.abs(newA - oldA) < 0.01) return;
    // Crops that were framed for the old aspect get re-framed for the new one,
    // around the detected face or, failing that, the current crop's center.
    let n = 0;
    for (const c of p.clips) {
      if (!c.crop) continue;
      const { w, h } = srcDims(c.source);
      if (Math.abs((c.crop.w * w) / (c.crop.h * h) - oldA) > 0.02) continue;
      const center = { x: c.crop.x + c.crop.w / 2, y: c.crop.y + c.crop.h * 0.4, w: 0, h: 0 };
      c.crop = suggestCrop(faceFor(c.source, c.in, c.out) || center, w, h, newA);
      n++;
    }
    if (n) toast(`Re-framed ${n} crop${n > 1 ? "s" : ""} for the new size`);
  });
}

$("#outPreset").addEventListener("change", (e) => {
  if (e.target.value === "custom") return;
  const [w, h] = e.target.value.split("x").map(Number);
  setOutput((o) => { o.width = w; o.height = h; }, `output ${w}x${h}`);
});
$("#outW").addEventListener("change", (e) => setOutput((o) => { o.width = Math.max(16, Math.round(+e.target.value / 2) * 2); }, "output size"));
$("#outH").addEventListener("change", (e) => setOutput((o) => { o.height = Math.max(16, Math.round(+e.target.value / 2) * 2); }, "output size"));
$("#outFps").addEventListener("change", (e) => setOutput((o) => { o.fps = clamp(+e.target.value || 30, 1, 120); }, "output fps"));
$("#outBg").addEventListener("change", (e) => setOutput((o) => { o.background = e.target.value; }, "background"));

function renderNotes() {
  const notes = S.project?.notes || [];
  $("#notes").innerHTML = notes.length ? notes.map((n, i) => `<li>
      <span class="who">${esc(n.who)}</span><span class="badge ${n.who === "claude" ? "claude" : "app"}">${esc(n.who === "claude" ? "Claude" : "you")}</span>
      <span class="meta"> · ${n.at ? ago(n.at) : ""}</span>
      ${n.done ? '<span class="badge ok">done</span>' : ""}
      <div>${esc(n.text)}</div>
      <button class="small" data-i="${i}" data-a="${n.done ? "reopen" : "done"}">${n.done ? "Reopen" : "Mark done"}</button>
    </li>`).join("") : `<li class="hint">No notes yet.</li>`;
}

$("#btnAddNote").addEventListener("click", () => {
  const text = $("#noteText").value.trim();
  if (!text || !S.project) return;
  edit("note", (p) => p.notes.push({ who: "you", text, at: nowIso(), done: false }));
  $("#noteText").value = "";
});

$("#notes").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  edit("note status", (p) => { p.notes[+b.dataset.i].done = b.dataset.a === "done"; });
});

// ------------------------------------------------------------------ activity + actions

async function refreshActivity() {
  if (!S.gh || !S.path || S.local) return;
  try {
    const commits = await S.gh.commits(S.path, 12);
    $("#commits").innerHTML = commits.map((c) => {
      const msg = c.commit.message.split("\n")[0];
      const who = /\[claude\]/i.test(msg) || /claude/i.test(c.commit.author.name) ? "claude"
        : /\[app\]/.test(msg) ? "app" : /\[bot\]/.test(msg) ? "bot" : "";
      return `<li><a href="${esc(c.html_url)}" target="_blank" rel="noopener">${esc(msg.replace(/\s*\[(app|claude|bot)\]/i, ""))}</a>
        ${who ? `<span class="badge ${who}">${who === "app" ? "you (app)" : who}</span>` : ""}
        <div class="meta">${esc(c.commit.author.name)} · ${ago(c.commit.author.date)}</div></li>`;
    }).join("") || `<li class="hint">No commits yet.</li>`;
  } catch (e) {
    $("#commits").innerHTML = `<li class="hint">${esc(e.message)}</li>`;
  }
  refreshRuns();
}

async function refreshRuns() {
  if (!S.gh) return [];
  try {
    const [render, detect] = await Promise.all([S.gh.runs(RENDER_WORKFLOW, 5), S.gh.runs(DETECT_WORKFLOW, 5)]);
    const runs = [...render, ...detect].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8);
    $("#runs").innerHTML = runs.map((r) => {
      const st = r.status === "completed" ? r.conclusion : r.status;
      const cls = st === "success" ? "ok" : st === "failure" || st === "cancelled" ? "err" : "busy";
      return `<li><a href="${esc(r.html_url)}" target="_blank" rel="noopener">${esc(r.name)}</a>
        <span class="badge ${cls}">${esc(st)}</span>
        <div class="meta">${esc(r.display_title || "")} · ${ago(r.created_at)}${st === "success" && r.name.toLowerCase().includes("render") ? " · video under Artifacts" : ""}</div></li>`;
    }).join("") || `<li class="hint">No runs yet.</li>`;
    S.runs = runs;
    return runs;
  } catch (e) {
    $("#runs").innerHTML = `<li class="hint">${esc(e.message)}</li>`;
    return [];
  }
}

let runsTimer = null;
function watchRuns() {
  showTab("activity");
  clearInterval(runsTimer);
  let n = 0;
  const known = new Map(S.runs.map((r) => [r.id, r.status]));
  runsTimer = setInterval(async () => {
    const runs = await refreshRuns();
    for (const r of runs) {
      if (known.get(r.id) && known.get(r.id) !== "completed" && r.status === "completed") {
        toast(`${r.name}: ${r.conclusion}`, r.conclusion === "success" ? "ok" : "err");
      }
      known.set(r.id, r.status);
    }
    if (++n > 120 || (n > 3 && runs.every((r) => r.status === "completed"))) clearInterval(runsTimer);
  }, 8000);
  setTimeout(refreshRuns, 2500);
}

async function render() {
  if (!S.project || !S.gh?.canWrite) return;
  if (S.dirty) await save();
  if (S.dirty) return toast("Save the project first", "err");
  try {
    await S.gh.dispatch(RENDER_WORKFLOW, { project: S.path });
    toast("Render started on GitHub Actions. The MP4 appears under the run's Artifacts.", "ok");
    watchRuns();
  } catch (e) {
    toast(`Could not start the render: ${e.message}`, "err");
  }
}

// ------------------------------------------------------------------ dialogs, toasts, wiring

function toast(text, cls = "") {
  const el = document.createElement("div");
  el.className = `toast ${cls}`;
  el.textContent = text;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), cls === "err" ? 8000 : 4500);
}

function pick(title, items) {
  return new Promise((resolve) => {
    const dlg = $("#dlgPick");
    $("#pickTitle").textContent = title;
    $("#pickList").innerHTML = items.length
      ? items.map((it, i) => `<li data-i="${i}">${esc(it.label)} <span class="meta">${esc(it.meta || "")}</span></li>`).join("")
      : `<li class="hint">Nothing here yet.</li>`;
    let chosen = null;
    $("#pickList").onclick = (e) => {
      const li = e.target.closest("li[data-i]");
      if (!li) return;
      chosen = items[+li.dataset.i].value;
      dlg.close();
    };
    dlg.onclose = () => resolve(chosen);
    dlg.showModal();
  });
}

function openSettings() {
  const dlg = $("#dlgSettings");
  $("#cfgOwner").value = S.cfg.owner;
  $("#cfgRepo").value = S.cfg.repo;
  $("#cfgBranch").value = S.cfg.branch;
  $("#cfgToken").value = S.cfg.token;
  $("#cfgPoll").value = S.cfg.poll;
  dlg.onclose = async () => {
    if (dlg.returnValue !== "ok") return;
    S.cfg = {
      owner: $("#cfgOwner").value.trim(), repo: $("#cfgRepo").value.trim(), branch: $("#cfgBranch").value.trim(),
      token: $("#cfgToken").value.trim(), poll: +$("#cfgPoll").value || 5,
    };
    saveCfg();
    connect();
    const files = await listProjects();
    if (!S.project && files.length) openProject(files[0].path);
    for (const id of Object.keys(S.videos)) if (S.videos[id].status === "err") loadFromGitHub(id);
    renderAll();
  };
  dlg.showModal();
}

function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  if (name === "activity") refreshActivity();
}

document.querySelector(".tabs").addEventListener("click", (e) => {
  const t = e.target.closest("button")?.dataset.tab;
  if (t) showTab(t);
});

$("#btnMenu").addEventListener("click", (e) => { e.stopPropagation(); $("#menuItems").hidden = !$("#menuItems").hidden; });
document.addEventListener("click", () => { $("#menuItems").hidden = true; });
$("#btnSettings").addEventListener("click", openSettings);
$("#btnHelp").addEventListener("click", () => $("#dlgHelp").showModal());
$("#btnDownloadJson").addEventListener("click", downloadJson);
$("#btnOpenJson").addEventListener("click", () => $("#fileJson").click());
$("#fileJson").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    S.local = true;
    S.path = null;
    S.sha = null;
    S.undo = [];
    S.redo = [];
    setProject(JSON.parse(await f.text()));
    listProjects();
  } catch (err) { toast(`Not a valid project: ${err.message}`, "err"); }
  e.target.value = "";
});
$("#btnNewProject").addEventListener("click", () => {
  const name = prompt("Project name");
  if (!name) return;
  if (S.dirty && !confirm("Discard unsaved edits?")) return;
  S.local = !S.gh;
  S.path = S.gh ? `${PROJECTS_DIR}/${slug(name)}.json` : null;
  S.sha = null;
  S.undo = [];
  S.redo = [];
  setProject({ version: 1, name: slug(name), sources: {}, clips: [] });
  changed("create project");
});
$("#projectSelect").addEventListener("change", (e) => openProject(e.target.value));
$("#btnRefreshProjects").addEventListener("click", listProjects);
$("#btnUndo").addEventListener("click", undo);
$("#btnRedo").addEventListener("click", redo);
$("#btnSave").addEventListener("click", () => (S.dirty || S.local ? save() : toast("Nothing to save")));
$("#chkAutosave").addEventListener("change", scheduleSave);
$("#btnRender").addEventListener("click", render);
$("#btnAddSource").addEventListener("click", addSourceFromInbox);
$("#btnPlay").addEventListener("click", togglePlay);
$("#btnStart").addEventListener("click", () => seek(0));
$("#btnEnd").addEventListener("click", () => seek(totalLen()));
$("#btnPrevFrame").addEventListener("click", () => step(-1 / (S.project?.output.fps || 30)));
$("#btnNextFrame").addEventListener("click", () => step(1 / (S.project?.output.fps || 30)));
$("#btnSplit").addEventListener("click", splitAtPlayhead);
$("#btnCropMode").addEventListener("click", () => toggleCropMode());
$("#zoom").addEventListener("input", (e) => { S.zoom = +e.target.value; renderTimeline(); });
window.addEventListener("resize", () => { layoutCanvas(); renderTimeline(); });
window.addEventListener("beforeunload", (e) => { if (S.dirty) e.preventDefault(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select") || document.querySelector("dialog[open]")) return;
  const mod = e.ctrlKey || e.metaKey;
  const fps = S.project?.output.fps || 30;
  if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
  else if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
  else if (mod) return;
  else if (e.key === " ") { e.preventDefault(); togglePlay(); }
  else if (e.key === "s" || e.key === "S") splitAtPlayhead();
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); deleteSelected(); }
  else if (e.key === "[") trimToPlayhead("in");
  else if (e.key === "]") trimToPlayhead("out");
  else if (e.key === "c" || e.key === "C") toggleCropMode();
  else if (e.key === "ArrowLeft") { e.preventDefault(); step(e.shiftKey ? -1 : -1 / fps); }
  else if (e.key === "ArrowRight") { e.preventDefault(); step(e.shiftKey ? 1 : 1 / fps); }
  else if (e.key === "Home") seek(0);
  else if (e.key === "End") seek(totalLen());
  else if (e.key === "Escape" && S.cropMode) toggleCropMode(false);
});

// ------------------------------------------------------------------ boot

(async function boot() {
  $("#zoom").value = S.zoom;
  connect();
  renderAll();
  requestAnimationFrame(tick);
  const files = await listProjects();
  const want = new URLSearchParams(location.hash.slice(1)).get("project");
  const match = files.find((f) => f.name.replace(/\.json$/, "") === want) || files[0];
  if (match) openProject(match.path);
  if (!S.cfg.token) toast("Read-only: add a GitHub token (⋯ → GitHub settings) to save edits and render.");
})();
