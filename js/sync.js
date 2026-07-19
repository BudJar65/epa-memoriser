// Sync: share progress + study diary between devices via a private GitHub Gist.
//
// How it works, in plain English:
// - A "gist" is a tiny private note on the user's own GitHub account. We keep
//   one gist holding the whole save file (learning state + diary).
// - The save is AES-GCM encrypted with a key derived from the same passphrase
//   that unlocks the app, so GitHub only ever stores unreadable ciphertext.
// - Each device needs a GitHub token (classic, "gist" scope ONLY) pasted once
//   in Settings. The token is remembered on that device, like the passphrase.
// - On startup we pull + merge; after any saved change we push a few seconds
//   later. Merging: per answer the newer record wins; diaries are unioned.

const Sync = {
  CFG_KEY: "epa-memoriser-sync-v1", // { token, gistId }
  DESC: "epa-memoriser-sync",       // gist description — how we find ours again
  FILE: "epa-progress.enc.txt",
  cfg: null,
  status: "off",                    // off | syncing | ok | error
  lastError: "",
  lastSynced: 0,
  _timer: null,
  _key: null,
  _busy: false,

  load() {
    try { this.cfg = JSON.parse(localStorage.getItem(this.CFG_KEY)); }
    catch (e) { this.cfg = null; }
    if (this.enabled()) this.status = "ok";
  },

  enabled() { return !!(this.cfg && this.cfg.token && this.cfg.gistId); },

  // Key for the cloud save, derived from the unlock passphrase (fixed salt is
  // fine here: the payload is per-user and the passphrase is the secret).
  async _deriveKey() {
    if (this._key) return this._key;
    const pass = localStorage.getItem("epa-pass") || "";
    const baseKey = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    this._key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: new TextEncoder().encode("epa-sync-salt-v1"),
        iterations: 200000, hash: "SHA-256" },
      baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return this._key;
  },

  async _encrypt(obj) {
    const key = await this._deriveKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(obj));
    const enc = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
    const buf = new Uint8Array(iv.length + enc.length);
    buf.set(iv); buf.set(enc, iv.length);
    let s = "";
    for (let i = 0; i < buf.length; i += 8192) {
      s += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    }
    return btoa(s);
  },

  async _decrypt(b64) {
    const raw = Uint8Array.from(atob(b64.trim()), c => c.charCodeAt(0));
    const key = await this._deriveKey();
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  },

  _api(path, opts = {}) {
    return fetch("https://api.github.com" + path, {
      ...opts,
      headers: {
        "Authorization": "Bearer " + this.cfg.token,
        "Accept": "application/vnd.github+json",
        ...(opts.body ? { "Content-Type": "application/json" } : {})
      }
    });
  },

  // Turn sync on: check the token works, find our gist (or create it), then
  // do a first full sync. Throws a readable message if anything fails.
  async enable(token) {
    this.cfg = { token: token.trim(), gistId: "" };
    let res;
    try { res = await this._api("/gists?per_page=100"); }
    catch (e) { this.cfg = null; throw new Error("Couldn't reach GitHub — are you online?"); }
    if (res.status === 401) { this.cfg = null; throw new Error("GitHub rejected the token — check you copied all of it."); }
    if (res.status === 403) { this.cfg = null; throw new Error("Token works but can't touch gists — it needs the 'gist' permission."); }
    if (!res.ok) { this.cfg = null; throw new Error("GitHub error " + res.status + " — try again in a minute."); }
    const mine = (await res.json()).find(g => g.description === this.DESC);
    if (mine) {
      this.cfg.gistId = mine.id;
    } else {
      const created = await this._api("/gists", {
        method: "POST",
        body: JSON.stringify({
          description: this.DESC, public: false,
          files: { [this.FILE]: { content: "new" } }
        })
      });
      if (!created.ok) {
        this.cfg = null;
        throw new Error(created.status === 403
          ? "Token can't create gists — it needs the 'gist' permission."
          : "Could not create the storage gist (GitHub error " + created.status + ").");
      }
      this.cfg.gistId = (await created.json()).id;
    }
    localStorage.setItem(this.CFG_KEY, JSON.stringify(this.cfg));
    await this.syncNow();
    if (this.status === "error") throw new Error("Connected, but the first sync failed: " + this.lastError);
  },

  // Forget the token on this device. The gist and other devices are untouched.
  disable() {
    localStorage.removeItem(this.CFG_KEY);
    this.cfg = null;
    this.status = "off";
    clearTimeout(this._timer);
  },

  // Called after every local save; waits a moment so rapid changes batch up.
  pushSoon() {
    if (!this.enabled()) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.syncNow(), 4000);
  },

  // Pull the cloud save, fold it into ours, push the merged result back.
  // onMerged is called only if the pull changed anything on this device.
  async syncNow(onMerged) {
    if (!this.enabled() || this._busy) return;
    this._busy = true;
    this.status = "syncing";
    try {
      const res = await this._api("/gists/" + this.cfg.gistId);
      if (res.status === 404) throw new Error("The storage gist is gone — turn sync off and on again.");
      if (!res.ok) throw new Error("GitHub error " + res.status);
      const gist = await res.json();
      const file = gist.files[this.FILE];
      let content = file && file.content;
      if (file && file.truncated) content = await (await fetch(file.raw_url)).text();
      let changed = false;
      if (content && content.length > 20) {
        // Undecryptable content (e.g. changed passphrase) is treated as absent:
        // we overwrite it with this device's save rather than failing forever.
        try { changed = Engine.mergeRemote(await this._decrypt(content)); }
        catch (e) { changed = false; }
      }
      const blob = await this._encrypt({
        v: 1, savedAt: Date.now(),
        state: Engine.state, history: Engine.history
      });
      const patch = await this._api("/gists/" + this.cfg.gistId, {
        method: "PATCH",
        body: JSON.stringify({ files: { [this.FILE]: { content: blob } } })
      });
      if (!patch.ok) throw new Error("GitHub error " + patch.status + " while saving");
      this.status = "ok";
      this.lastSynced = Date.now();
      this.lastError = "";
      if (changed && typeof onMerged === "function") onMerged();
    } catch (e) {
      this.status = "error";
      this.lastError = e && e.message ? e.message : String(e);
    }
    this._busy = false;
  }
};
