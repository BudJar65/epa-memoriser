// Voice layer: text-to-speech (TTS) and speech recognition (STT).
//
// iPhone notes (why this file is careful):
// - speechSynthesis on iOS only speaks after a user tap has "unlocked" audio,
//   so we prime it on the first touch.
// - webkitSpeechRecognition on iOS Safari needs "Siri & Dictation" enabled in
//   Settings, and it often stops itself after a pause — so we auto-restart
//   while a listening session is active and stitch the transcript together.

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

  speak(text, onDone) {
    if (!this.synth || !Engine.settings.voiceOn) { if (onDone) onDone(); return; }
    this.stopSpeaking();
    const u = new SpeechSynthesisUtterance(text);
    if (this.ukVoice) u.voice = this.ukVoice;
    u.lang = "en-GB";
    u.rate = Engine.settings.rate || 1.0;
    if (onDone) u.onend = onDone;
    this.synth.speak(u);
  },

  stopSpeaking() {
    if (this.synth) this.synth.cancel();
  },

  // ---- Speech recognition ----
  sttSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  },

  _rec: null,
  _active: false,
  _finalText: "",
  _interim: "",
  onUpdate: null, // callback(fullTranscriptSoFar)

  startListening(onUpdate) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return false;
    this.stopSpeaking();
    this._finalText = "";
    this._interim = "";
    this._active = true;
    this.onUpdate = onUpdate || null;

    const rec = new SR();
    this._rec = rec;
    rec.lang = "en-GB";
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) this._finalText += " " + r[0].transcript;
        else interim += " " + r[0].transcript;
      }
      this._interim = interim;
      if (this.onUpdate) this.onUpdate((this._finalText + " " + this._interim).trim());
    };

    // iOS Safari loves to stop early; restart while the session is active.
    rec.onend = () => {
      if (this._active) {
        try { rec.start(); } catch (e) { /* already restarting */ }
      }
    };
    rec.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        this._active = false;
        if (this.onUpdate) this.onUpdate(null); // signals "mic blocked"
      }
    };

    try { rec.start(); } catch (e) { return false; }
    return true;
  },

  stopListening() {
    this._active = false;
    if (this._rec) { try { this._rec.stop(); } catch (e) {} }
    return (this._finalText + " " + this._interim).trim();
  }
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
