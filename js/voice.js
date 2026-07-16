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

  // ---- Speech recognition ----
  sttSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  },

  _rec: null,
  _active: false,
  _suspended: false,
  _finalText: "",
  _interim: "",
  lastMicStop: 0, // used to wait out iOS audio "ducking" after mic use
  onUpdate: null, // callback(fullTranscriptSoFar)
  onAudioLive: null, // callback fired the moment the mic truly engages

  startListening(onUpdate, _isRetry) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return false;
    this.stopSpeaking();
    if (!_isRetry) {
      this._finalText = "";
      this._retries = 0;
      this.onUpdate = onUpdate || null;
    }
    this._interim = "";
    this._active = true;
    this._suspended = false;
    this._audioStarted = false;

    const rec = new SR();
    this._rec = rec;
    let recDead = false; // set when the watchdog replaces this instance
    rec.lang = "en-GB";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onaudiostart = () => {
      this._audioStarted = true;
      if (this.onAudioLive) this.onAudioLive(); // UI flips to "Listening"
    };

    // Watchdog: iOS speech recognition sometimes wedges silently — no audio,
    // no error. If the mic hasn't engaged within 2.5s, rebuild the session;
    // after two failed rebuilds, give up loudly (callers show a fallback).
    clearTimeout(this._watch);
    this._watch = setTimeout(() => {
      if (!this._active || this._suspended || this._audioStarted) return;
      this._retries = (this._retries || 0) + 1;
      recDead = true;
      try { rec.abort(); } catch (e) {}
      if (this._retries <= 2) {
        this.startListening(null, true);
      } else {
        this._active = false;
        this.lastMicStop = Date.now();
        if (this.onUpdate) this.onUpdate(null); // signals "mic unavailable"
      }
    }, 2500);

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

    // iOS Safari loves to stop early; restart while the session is active
    // (but not while deliberately paused). Crucially, keep any provisional
    // ("interim") words captured before the stop — otherwise words the user
    // saw in the live transcript vanish from the final one.
    rec.onend = () => {
      if (recDead) return; // replaced by the watchdog — don't resurrect
      if (this._interim.trim()) {
        this._finalText += " " + this._interim;
        this._interim = "";
      }
      if (this._active && !this._suspended) {
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
    clearTimeout(this._watch);
    // Use the graceful stop(): abort() can wedge iOS speech recognition so
    // the NEXT session silently hears nothing. Ducking is handled by the
    // playback cooldowns instead.
    if (this._rec) { try { this._rec.stop(); } catch (e) {} }
    this.lastMicStop = Date.now();
    return (this._finalText + " " + this._interim).trim();
  },

  // Pause/resume the mic without losing the transcript gathered so far.
  suspendListening() {
    if (this._active && !this._suspended) {
      this._suspended = true;
      if (this._rec) { try { this._rec.stop(); } catch (e) {} }
      this.lastMicStop = Date.now();
    }
  },

  resumeListening() {
    if (this._active && this._suspended) {
      this._suspended = false;
      if (this._rec) { try { this._rec.start(); } catch (e) {} }
    }
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
