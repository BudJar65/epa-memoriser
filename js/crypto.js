// DataLock: the answer bank is stored encrypted (data.enc.json) so the public
// repo and website never contain the readable answers. On first open the user
// types a passphrase; we derive a key with PBKDF2 and decrypt with AES-GCM.
// The passphrase is remembered on this device only (localStorage).

const DataLock = {
  PASS_KEY: "epa-pass",

  async _decrypt(passphrase, encFile) {
    const salt = Uint8Array.from(atob(encFile.salt), c => c.charCodeAt(0));
    const iv = Uint8Array.from(atob(encFile.iv), c => c.charCodeAt(0));
    const data = Uint8Array.from(atob(encFile.data), c => c.charCodeAt(0));
    const baseKey = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: encFile.iterations, hash: "SHA-256" },
      baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return JSON.parse(new TextDecoder().decode(plain));
  },

  async _fetchEnc() {
    if (this._enc) return this._enc;
    const res = await fetch("data.enc.json");
    if (!res.ok) throw new Error("Could not load data.enc.json");
    this._enc = await res.json();
    return this._enc;
  },

  async unlock(passphrase) {
    const enc = await this._fetchEnc();
    const payload = await this._decrypt(passphrase, enc); // throws if wrong
    window.ANSWER_BANK = payload.bank;
    window.ANSWER_STRUCTURE = payload.structure;
    localStorage.setItem(this.PASS_KEY, passphrase);
    // Set up narrated audio (non-fatal if absent) and cache clips for offline.
    if (typeof AudioPlayer !== "undefined") {
      AudioPlayer.init(passphrase).then(ok => { if (ok) AudioPlayer.prefetch(); });
    }
    return true;
  },

  async tryAutoUnlock() {
    const saved = localStorage.getItem(this.PASS_KEY);
    if (!saved) return false;
    try { return await this.unlock(saved); }
    catch (e) { localStorage.removeItem(this.PASS_KEY); return false; }
  },

  forget() {
    localStorage.removeItem(this.PASS_KEY);
    location.reload();
  },

  renderUnlock(onSuccess) {
    document.querySelector("#app").innerHTML = `
      <header class="top"><h1>EPA Answer Memoriser</h1>
        <p class="sub">This content is encrypted</p></header>
      <div class="card" style="margin-top:30px">
        <p><b>🔒 Enter your passphrase</b></p>
        <p style="color:var(--muted);font-size:0.9rem">You only need to do this once per device.</p>
        <input id="pass-input" type="password" autocomplete="current-password"
          autocapitalize="off" autocorrect="off" spellcheck="false"
          style="width:100%;font-size:1.1rem;padding:12px;border-radius:10px;
                 border:1px solid var(--line);background:var(--bg);color:var(--text)">
        <p id="pass-error" style="color:var(--bad);min-height:1.2em;font-size:0.9rem"></p>
      </div>
      <button class="btn btn-primary btn-big" id="pass-go">Unlock</button>
    `;
    const go = async () => {
      const input = document.querySelector("#pass-input");
      const err = document.querySelector("#pass-error");
      err.textContent = "";
      try {
        await DataLock.unlock(input.value.trim());
        onSuccess();
      } catch (e) {
        err.textContent = "That passphrase didn't work — check it and try again.";
      }
    };
    document.querySelector("#pass-go").addEventListener("click", go);
    document.querySelector("#pass-input").addEventListener("keydown", e => {
      if (e.key === "Enter") go();
    });
    document.querySelector("#pass-input").focus();
  }
};
