// Voice layer: text-to-speech (TTS) only — the app SPEAKS, it never listens.
//
// Speech recognition was removed in v27: on Jason's iPhone the recogniser kept
// wedging (sometimes silently, sometimes "live but deaf"), and every workaround
// added more buttons than it saved. Recall is now judged by tapping
// "Got it" / "Try again", which cannot fail.
//
// iPhone note: speechSynthesis on iOS only speaks after a user tap has
// "unlocked" audio, so we prime it on the first touch.

const Voice = {
  synth: window.speechSynthesis || null,
  primed: false,
  ukVoice: null,

  // Rank voices by naturalness: user's saved choice first, then Premium,
  // then Enhanced, then known-good UK names, then any UK, then any English.
  _rank(v) {
    if (Engine.settings.voiceName && v.name === Engine.settings.voiceName) return 0;
    const en = v.lang.startsWith("en");
    const uk = v.lang === "en-GB";
    if (uk && /premium/i.test(v.name)) return 1;
    if (uk && /enhanced/i.test(v.name)) return 2;
    if (en && /premium/i.test(v.name)) return 3;
    if (en && /enhanced/i.test(v.name)) return 4;
    if (uk && /Serena|Daniel|Kate|Stephanie|Jamie/i.test(v.name)) return 5;
    if (uk) return 6;
    if (en) return 7;
    return 9;
  },

  englishVoices() {
    if (!this.synth) return [];
    return this.synth.getVoices()
      .filter(v => v.lang.startsWith("en"))
      .sort((a, b) => this._rank(a) - this._rank(b));
  },

  init() {
    if (!this.synth) return;
    const pick = () => {
      const ranked = this.englishVoices();
      this.ukVoice = ranked[0] || null;
    };
    pick();
    if (this.synth.onvoiceschanged !== undefined) this.synth.onvoiceschanged = pick;
    // Unlock audio on the first user touch (required by iOS).
    const prime = () => {
      if (this.primed || !this.synth) return;
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      this.synth.speak(u);
      this.primed = true;
      document.removeEventListener("touchend", prime);
      document.removeEventListener("click", prime);
    };
    document.addEventListener("touchend", prime);
    document.addEventListener("click", prime);
  },

  // speak(text, onDone, clipKeys): if narrated clips exist for clipKeys,
  // play those (studio voice); otherwise fall back to device text-to-speech.
  speak(text, onDone, clipKeys) {
    if (!Engine.settings.voiceOn) { if (onDone) onDone(); return; }
    this.stopSpeaking();
    if (clipKeys && typeof AudioPlayer !== "undefined" && AudioPlayer.hasAll(clipKeys)) {
      AudioPlayer.playSeq(clipKeys, onDone);
      return;
    }
    if (!this.synth) { if (onDone) onDone(); return; }
    const u = new SpeechSynthesisUtterance(text);
    if (this.ukVoice) u.voice = this.ukVoice;
    u.lang = "en-GB";
    u.rate = Engine.settings.rate || 1.0;
    if (onDone) u.onend = onDone;
    this.synth.speak(u);
  },

  stopSpeaking() {
    if (this.synth) this.synth.cancel();
    if (typeof AudioPlayer !== "undefined") AudioPlayer.stop();
  },

  // Harmless leftovers: if a phone ever loads this new file alongside a
  // cached older screen that still calls the old mic functions, these do
  // nothing instead of crashing the page. Safe to delete later.
  stopListening() { return ""; },
  suspendListening() {},
  resumeListening() {},
  sttSupported() { return false; }
};

// Keep the phone screen awake during walk mode (supported on iOS 16.4+).
const WakeLock = {
  lock: null,
  async on() {
    try {
      if ("wakeLock" in navigator) this.lock = await navigator.wakeLock.request("screen");
    } catch (e) { /* not critical */ }
  },
  async off() {
    try { if (this.lock) { await this.lock.release(); this.lock = null; } } catch (e) {}
  }
};
