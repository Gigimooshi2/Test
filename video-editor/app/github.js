// Minimal GitHub REST client used by the editor (contents, commits, Actions).
"use strict";

class GitHub {
  constructor({ owner, repo, branch, token }) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.token = token || "";
  }

  get canWrite() { return !!this.token; }

  async api(path, { method = "GET", body, etag, accept } = {}) {
    const headers = {
      Accept: accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (etag) headers["If-None-Match"] = etag;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
    const res = await fetch(url, {
      method, headers, cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 304) return { status: 304, etag };
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).message || msg; } catch (_) { /* not JSON */ }
      const err = new Error(`GitHub ${res.status}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    const type = res.headers.get("content-type") || "";
    const data = res.status === 204 ? null : type.includes("json") ? await res.json() : await res.text();
    return { status: res.status, etag: res.headers.get("etag"), data };
  }

  repoPath(p) { return `/repos/${this.owner}/${this.repo}${p}`; }

  contentsUrl(path) {
    return this.repoPath(`/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(this.branch)}`);
  }

  /** Text file with its blob sha. Returns {status: 304} when etag still matches. */
  async readFile(path, etag) {
    const r = await this.api(this.contentsUrl(path), { etag });
    if (r.status === 304) return r;
    let text;
    if (r.data.encoding === "base64" && r.data.content) {
      text = b64decode(r.data.content);
    } else {  // > 1 MB: fetch raw
      text = (await this.api(this.contentsUrl(path), { accept: "application/vnd.github.raw+json" })).data;
      if (typeof text !== "string") text = JSON.stringify(text);
    }
    return { status: 200, etag: r.etag, sha: r.data.sha, text };
  }

  async writeFile(path, text, sha, message) {
    const body = { message, content: b64encode(text), branch: this.branch };
    if (sha) body.sha = sha;
    const r = await this.api(this.contentsUrl(path).split("?")[0], { method: "PUT", body });
    return { sha: r.data.content.sha, commit: r.data.commit };
  }

  async listDir(path) {
    try {
      const r = await this.api(this.contentsUrl(path));
      return Array.isArray(r.data) ? r.data : [];
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  async commits(path, n = 10) {
    const q = `?sha=${encodeURIComponent(this.branch)}&path=${encodeURIComponent(path)}&per_page=${n}`;
    return (await this.api(this.repoPath(`/commits${q}`))).data;
  }

  async dispatch(workflow, inputs) {
    await this.api(this.repoPath(`/actions/workflows/${workflow}/dispatches`), {
      method: "POST", body: { ref: this.branch, inputs },
    });
  }

  async runs(workflow, n = 5) {
    const q = `?branch=${encodeURIComponent(this.branch)}&per_page=${n}`;
    try {
      return (await this.api(this.repoPath(`/actions/workflows/${workflow}/runs${q}`))).data.workflow_runs;
    } catch (e) {
      if (e.status === 404) return [];
      throw e;
    }
  }

  rawUrl(path) {
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${encodeURIComponent(this.branch)}/${path}`;
  }

  mediaUrl(path) {
    return `https://media.githubusercontent.com/media/${this.owner}/${this.repo}/${encodeURIComponent(this.branch)}/${path}`;
  }

  /**
   * A URL the <video> element can play for a repo file. Videos stored with Git LFS
   * are served from media.githubusercontent.com; plain files from raw.githubusercontent.com.
   * Private repos fall back to downloading through the API into a blob URL.
   */
  async videoUrl(path, onProgress) {
    try {
      const head = await fetch(this.rawUrl(path), { headers: { Range: "bytes=0-199" }, cache: "no-store" });
      if (head.ok) {
        const start = await head.text();
        return start.startsWith("version https://git-lfs") ? this.mediaUrl(path) : this.rawUrl(path);
      }
    } catch (_) { /* fall through to API download */ }
    if (!this.token) throw new Error("not reachable without a token (private repo?)");
    const res = await fetch(`https://api.github.com${this.contentsUrl(path)}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github.raw+json" },
    });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const total = +res.headers.get("content-length") || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (onProgress && total) onProgress(got / total);
    }
    const head = new TextDecoder().decode(chunks[0].slice(0, 40));
    if (head.startsWith("version https://git-lfs")) {
      throw new Error("Git LFS file in a private repo: use 'Pick local file'");
    }
    return URL.createObjectURL(new Blob(chunks, { type: "video/mp4" }));
  }
}

function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
