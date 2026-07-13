// Learning engine: spaced repetition (simplified Leitner boxes) + mastery tracking.
//
// How it works, in plain English:
// - Every answer sits in a "box" 0..4. Higher box = you know it better = longer
//   gap before it comes back for review.
// - A "clean recall" = you hit enough key points AND got the KSB AND the evidence
//   location right in one test. Three clean recalls (on separate occasions) with
//   box 3+ = Mastered. A miss drops the box down, so it comes back sooner.
// - Critical Pass entries are always learnt before High Pass Support entries.

const STORE_KEY = "epa-memoriser-v1";
const SETTINGS_KEY = "epa-memoriser-settings-v1";

// Gap (in hours) before an item in each box is due for review again.
const BOX_INTERVALS_HOURS = [0, 4, 24, 72, 168]; // now, 4h, 1d, 3d, 7d

const CLEAN_SCORE_THRESHOLD = 0.8; // 80% of key points = counts as clean
const RECALLS_TO_MASTER = 3;

const DEFAULT_SETTINGS = {
  voiceOn: true,
  rate: 1.0,          // speech speed
  quizMode: "self",   // "self" = reveal & self-grade, "listen" = mic scoring
  autoAdvance: true   // walk mode: move on automatically after grading
};

function defaultEntryState() {
  return {
    stage: "new",        // new -> learning -> review -> mastered
    box: 0,
    cleanRecalls: 0,
    due: 0,              // timestamp ms; 0 = due whenever reached
    attempts: 0,
    lastScore: null,
    ksbRight: 0, ksbWrong: 0,
    evRight: 0, evWrong: 0,
    lastSeen: 0
  };
}

const Engine = {
  state: {},
  settings: { ...DEFAULT_SETTINGS },

  load() {
    try { this.state = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch (e) { this.state = {}; }
    try { this.settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) }; }
    catch (e) { this.settings = { ...DEFAULT_SETTINGS }; }
    for (const e of ANSWER_BANK) {
      if (!this.state[e.id]) this.state[e.id] = defaultEntryState();
    }
  },

  save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(this.state));
  },

  saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
  },

  entry(id) { return this.state[id]; },

  // Learning order: Critical Pass first (document order), then the rest.
  learningOrder() {
    const critical = ANSWER_BANK.filter(e => e.priority === "Critical Pass");
    const support = ANSWER_BANK.filter(e => e.priority !== "Critical Pass");
    return [...critical, ...support];
  },

  // Next brand-new entry to learn (Critical Pass first).
  nextNew() {
    return this.learningOrder().find(e => this.state[e.id].stage === "new") || null;
  },

  // Entries due for testing right now (learning/review, due date passed).
  dueNow() {
    const now = Date.now();
    return this.learningOrder().filter(e => {
      const s = this.state[e.id];
      return s.stage !== "new" && s.due <= now;
    });
  },

  // Everything that has been started (for review-anyway sessions).
  started() {
    return this.learningOrder().filter(e => this.state[e.id].stage !== "new");
  },

  // Called when the user finishes the guided Learn flow for an entry.
  markLearned(id) {
    const s = this.state[id];
    if (s.stage === "new") {
      s.stage = "learning";
      s.box = 0;
      s.due = Date.now(); // test it immediately in the next quiz
    }
    s.lastSeen = Date.now();
    this.save();
  },

  // Record one full quiz result for an entry.
  // score: 0..1 fraction of key points hit (or 1/0.5/0 from self-grading)
  // ksbOk / evOk: booleans from the KSB and evidence checks
  recordResult(id, score, ksbOk, evOk) {
    const s = this.state[id];
    s.attempts += 1;
    s.lastScore = score;
    s.lastSeen = Date.now();
    if (ksbOk) s.ksbRight += 1; else s.ksbWrong += 1;
    if (evOk) s.evRight += 1; else s.evWrong += 1;

    const clean = score >= CLEAN_SCORE_THRESHOLD && ksbOk && evOk;

    if (clean) {
      s.box = Math.min(s.box + 1, BOX_INTERVALS_HOURS.length - 1);
      s.cleanRecalls += 1;
    } else if (score >= 0.5) {
      // partial: stay in place, come back soon
      s.box = Math.max(s.box - 0, 0);
      s.cleanRecalls = Math.max(s.cleanRecalls - 0, 0);
    } else {
      // miss: drop a box and lose a clean recall
      s.box = Math.max(s.box - 1, 0);
      s.cleanRecalls = Math.max(s.cleanRecalls - 1, 0);
    }

    if (s.cleanRecalls >= RECALLS_TO_MASTER && s.box >= 3) {
      s.stage = "mastered";
    } else if (s.stage !== "new") {
      s.stage = s.cleanRecalls > 0 ? "review" : "learning";
    }

    const hours = BOX_INTERVALS_HOURS[s.box];
    s.due = Date.now() + (clean ? hours : 0.5) * 3600 * 1000; // misses: back in 30 min
    this.save();
    return { clean };
  },

  // Record an evidence-drill-only result (doesn't move boxes as much).
  recordEvidenceDrill(id, ok) {
    const s = this.state[id];
    if (ok) s.evRight += 1; else { s.evWrong += 1; s.due = Math.min(s.due, Date.now()); }
    s.lastSeen = Date.now();
    this.save();
  },

  // Score a spoken/typed transcript against an entry's key points.
  // Returns { score, hits:[bool per keypoint] }
  scoreTranscript(entry, transcript) {
    const text = (transcript || "").toLowerCase();
    const hits = entry.keypoints.map(kp => kp.p.some(pat => text.includes(pat)));
    const score = hits.filter(Boolean).length / entry.keypoints.length;
    return { score, hits };
  },

  // Overall progress numbers for the dashboard.
  summary() {
    let mastered = 0, review = 0, learning = 0, fresh = 0, dueCount = 0;
    const now = Date.now();
    for (const e of ANSWER_BANK) {
      const s = this.state[e.id];
      if (s.stage === "mastered") mastered++;
      else if (s.stage === "review") review++;
      else if (s.stage === "learning") learning++;
      else fresh++;
      if (s.stage !== "new" && s.due <= now) dueCount++;
    }
    // overall % = weighted: mastered=1, each clean recall = 1/3, capped
    let pts = 0;
    for (const e of ANSWER_BANK) {
      const s = this.state[e.id];
      if (s.stage === "mastered") pts += 1;
      else if (s.stage !== "new") pts += Math.min(Math.max(s.cleanRecalls / RECALLS_TO_MASTER, 0.15), 0.9);
    }
    const pct = Math.round((pts / ANSWER_BANK.length) * 100);
    return { mastered, review, learning, fresh, dueCount, pct };
  },

  resetAll() {
    this.state = {};
    for (const e of ANSWER_BANK) this.state[e.id] = defaultEntryState();
    this.save();
  }
};
