// AudioPlayer: plays the pre-generated narrated clips (audio/<key>.enc).
// Each clip is AES-GCM encrypted: first 12 bytes are the IV, the rest is
// ciphertext. The key is derived from the same passphrase as the text data.
// If a clip is missing or narration is switched off, callers fall back to
// the device's text-to-speech voice.

const AudioPlayer = {
  manifest: null,
  key: null,
  el: null,          // single reusable <audio> element (iOS-friendly)
  urls: new Map(),   // clip key -> decrypted blob URL
  seq: 0,            // increments to cancel an in-flight sequence
  prefetching: false,

  async init(passphrase) {
    try {
      const res = await fetch("audio/manifest.json");
      if (!res.ok) return false;
      this.manifest = await res.json();
      const salt = Uint8Array.from(atob(this.manifest.salt), c => c.charCodeAt(0));
      const baseKey = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
      this.key = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: this.manifest.iterations, hash: "SHA-256" },
        baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
      this.el = new Audio();
      return true;
    } catch (e) {
      this.manifest = null;
      return false;
    }
  },

  ready() {
    return !!(this.key && this.manifest) && Engine.settings.narration !== false;
  },

  hasAll(keys) {
    return this.ready() && keys.every(k => this.manifest.clips.includes(k));
  },

  async _url(k) {
    if (this.urls.has(k)) return this.urls.get(k);
    const res = await fetch(`audio/${k}.enc`);
    if (!res.ok) throw new Error("clip fetch failed");
    const buf = new Uint8Array(await res.arrayBuffer());
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf.slice(0, 12) }, this.key, buf.slice(12));
    const url = URL.createObjectURL(new Blob([plain], { type: "audio/mpeg" }));
    this.urls.set(k, url);
    return url;
  },

  stop() {
    this.seq++;
    if (this.el) { try { this.el.pause(); } catch (e) {} }
  },

  // Play clips one after another; onDone fires only if not interrupted.
  async playSeq(keys, onDone) {
    const token = ++this.seq;
    try {
      for (const k of keys) {
        if (token !== this.seq) return;
        const url = await this._url(k);
        if (token !== this.seq) return;
        await new Promise(resolve => {
          this.el.src = url;
          this.el.playbackRate = Engine.settings.rate || 1.0;
          this.el.onended = resolve;
          this.el.onerror = resolve;
          this.el.play().catch(resolve);
        });
      }
      if (token === this.seq && onDone) onDone();
    } catch (e) {
      // Clip unavailable mid-sequence: fail silently, caller already spoke or
      // the next interaction will use the TTS fallback.
      if (token === this.seq && onDone) onDone();
    }
  },

  // Fetch every clip once so the service worker caches them for offline walks.
  async prefetch() {
    if (!this.manifest || this.prefetching) return;
    this.prefetching = true;
    for (const k of this.manifest.clips) {
      try { await fetch(`audio/${k}.enc`); } catch (e) { break; } // offline: stop quietly
    }
    this.prefetching = false;
  }
};
