// EPA Answer Memoriser — UI and flows.
// Screens: home, learn, quiz, drill (evidence), walk, browse, detail, progress, settings.

const APP_VERSION = "v18"; // shown on the home screen; bumped every release

const $ = sel => document.querySelector(sel);
const app = () => $("#app");

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Turn a sentence into a first-letter cue: "I planned the BA work" -> "I p t B w"
function firstLetterCue(text) {
  return text.split(/\s+/).map(w => {
    const m = w.match(/[A-Za-z0-9]/);
    return m ? m[0] : w;
  }).join(" ");
}

// ---- Global pause: freezes narration, mic and auto-advance in place ----
const Pause = {
  paused: false,
  toggle() { this.paused ? this.resume() : this.pause(); },
  pause() {
    this.paused = true;
    if (Voice.synth) { try { Voice.synth.pause(); } catch (e) {} }
    AudioPlayer.pauseClip();
    Voice.suspendListening();
    document.getElementById("pause-overlay").classList.add("show");
  },
  resume() {
    this.paused = false;
    document.getElementById("pause-overlay").classList.remove("show");
    if (Voice.synth) { try { Voice.synth.resume(); } catch (e) {} }
    AudioPlayer.resumeClip();
    Voice.resumeListening();
  },
  setVisible(on) {
    document.getElementById("pause-btn").classList.toggle("show", !!on);
    if (!on && this.paused) this.resume();
  }
};

// Run fn now, or as soon as the app is unpaused.
function afterUnpaused(fn) {
  if (!Pause.paused) return fn();
  const iv = setInterval(() => {
    if (!Pause.paused) { clearInterval(iv); fn(); }
  }, 250);
}

// ---- Narration helpers: map spoken content to its pre-generated clip keys ----
function beatKeys(entry) { return entry.beats.map((_, i) => `e${entry.id}-beat${i}`); }
function speakLearnFull() { Voice.speak(learn.entry.beats.join(" "), null, beatKeys(learn.entry)); }
function speakQuizQuestion() { Voice.speak(quiz.question, null, [`e${quizEntry().id}-q${quiz.qIndex}`]); }
function speakQuizAnswer() { const e = quizEntry(); Voice.speak(e.beats.join(" "), null, beatKeys(e)); }
function speakEntryAnswer(id) { const e = ANSWER_BANK.find(x => x.id === id); Voice.speak(e.beats.join(" "), null, beatKeys(e)); }

function stageBadge(s) {
  const map = {
    new: ["New", "badge-new"],
    learning: ["Learning", "badge-learning"],
    review: ["Reviewing", "badge-review"],
    mastered: ["Mastered", "badge-mastered"]
  };
  const [label, cls] = map[s.stage];
  return `<span class="badge ${cls}">${label}</span>`;
}

function recallDots(s) {
  let dots = "";
  for (let i = 0; i < 3; i++) {
    dots += `<span class="dot ${i < s.cleanRecalls ? "dot-on" : ""}"></span>`;
  }
  return `<span class="dots">${dots}</span>`;
}

// ---------------------------------------------------------------- HOME
function renderHome() {
  WakeLock.off();
  Voice.stopSpeaking();
  Pause.setVisible(false);
  const sum = Engine.summary();
  const due = Engine.dueNow();
  const next = Engine.nextNew();

  let cta;
  if (due.length > 0) {
    cta = `<button class="btn btn-primary btn-big" onclick="startQuiz()">Test me — ${due.length} answer${due.length > 1 ? "s" : ""} due</button>`;
  } else if (next) {
    cta = `<button class="btn btn-primary btn-big" onclick="startLearn(${next.id})">Learn next: #${next.id} ${esc(next.ksb)}</button>`;
  } else {
    cta = `<button class="btn btn-primary btn-big" onclick="startWalk()">All caught up — free practice</button>`;
  }

  app().innerHTML = `
    <header class="top">
      <h1>EPA Answer Memoriser</h1>
      <p class="sub">18 answers &middot; Level 4 BA resit &middot; ${APP_VERSION}</p>
    </header>

    <div class="card progress-card">
      <div class="progress-ring">
        <div class="pct">${sum.pct}%</div>
      </div>
      <div class="progress-bar"><div class="progress-fill" style="width:${sum.pct}%"></div></div>
      <div class="stats">
        <div><b>${sum.mastered}</b><span>Mastered</span></div>
        <div><b>${sum.review}</b><span>Reviewing</span></div>
        <div><b>${sum.learning}</b><span>Learning</span></div>
        <div><b>${sum.fresh}</b><span>Not started</span></div>
      </div>
    </div>

    ${cta}

    <div class="grid2">
      <button class="btn" onclick="startWalk()">🚶 Walk mode</button>
      <button class="btn" onclick="startDrill()">📄 Evidence drill</button>
      <button class="btn" onclick="renderBrowse()">📚 All answers</button>
      <button class="btn" onclick="renderProgress()">📈 Progress</button>
    </div>

    <div class="card tip">
      <b>Answer structure under pressure</b>
      <ol>${ANSWER_STRUCTURE.map(s => `<li>${esc(s)}</li>`).join("")}</ol>
    </div>

    <button class="btn btn-ghost" onclick="renderSettings()">⚙️ Settings</button>
  `;
}

// ---------------------------------------------------------------- LEARN
// Echo method: see one sentence-sized chunk -> it's hidden -> you say it
// back from memory -> the mic transcript is checked word by word. Then
// the whole answer from first-letter hints only.
let learn = null;

// Split the answer into sentence-sized chunks (mirrors tools/build_audio.py
// so each chunk has a matching narrated clip e{id}-c{n}).
function chunkify(entry) {
  const out = [];
  entry.beats.forEach(b => {
    b.split(/(?<=[.!?])\s+/).forEach(s => { s = s.trim(); if (s) out.push(s); });
  });
  return out;
}

// Small filler words don't count towards the echo score.
const STOPWORDS = new Set("a an the and or of to in on by for with as at is are was were it its this that these those i my me so then than be been which into from their they them we our you your also had has have not but".split(" "));

// Spoken number words -> digits, so "three" matches "3" in page references.
const NUMWORDS = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20", thirty: "30", forty: "40",
  fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90"
};

function normWords(s) {
  return (s || "").toLowerCase().replace(/[’']/g, "")
    .replace(/[^a-z0-9\s-]/g, " ").replace(/-/g, " ")
    .split(/\s+/).filter(Boolean)
    .map(w => NUMWORDS[w] || w);
}

// Crude stem so "scheduled"/"schedule" and "interviews"/"interview" match.
function stem(w) {
  return w.length > 4 ? w.replace(/(ing|ed|es|s|d)$/, "") : w;
}

// Everything the user said, as exact words, stems, and joined number pairs
// ("sixty" "seven" -> "67") so matching is forgiving of transcription quirks.
function spokenSetOf(spoken) {
  const words = normWords(spoken);
  const set = new Set();
  for (let i = 0; i < words.length; i++) {
    set.add(words[i]);
    set.add(stem(words[i]));
    const a = words[i], b = words[i + 1];
    if (b && /^\d+0$/.test(a) && /^\d$/.test(b)) set.add(String(+a + +b));
  }
  return set;
}

function wordHeard(w, spokenSet) {
  return spokenSet.has(w) || spokenSet.has(stem(w));
}

// Fraction of the chunk's content words that appeared in the transcript.
function echoScore(target, spoken) {
  const spokenSet = spokenSetOf(spoken);
  let content = 0, hit = 0;
  for (const w of normWords(target)) {
    if (STOPWORDS.has(w)) continue;
    content++;
    if (wordHeard(w, spokenSet)) hit++;
  }
  return content ? hit / content : 1;
}

// The chunk text with each word coloured by whether it was heard.
function echoDiffHtml(target, spoken) {
  const spokenSet = spokenSetOf(spoken);
  return target.split(/\s+/).map(tok => {
    const words = normWords(tok);
    if (!words.length || words.every(w => STOPWORDS.has(w))) return esc(tok);
    const ok = words.every(w => STOPWORDS.has(w) || wordHeard(w, spokenSet));
    return `<span class="${ok ? "kp-hit" : "kp-miss"}">${esc(tok)}</span>`;
  }).join(" ");
}

function startLearn(id) {
  const entry = ANSWER_BANK.find(e => e.id === id);
  learn = { entry, chunks: chunkify(entry), stage: "intro", idx: 0,
            phase: "show", transcript: "", result: null };
  renderLearn();
}

function chunkClipKey() { return `e${learn.entry.id}-c${learn.idx}`; }
function speakChunk() { Voice.speak(learn.chunks[learn.idx], null, [chunkClipKey()]); }

function chunkDots() {
  return `<p class="chunk-dots">${learn.chunks.map((_, i) =>
    `<span class="dot ${i < learn.idx ? "dot-on" : i === learn.idx ? "dot-now" : ""}"></span>`).join("")}</p>`;
}

function learnEcho() {
  Voice.stopSpeaking();
  learn.transcript = "";
  learn.micDead = false;
  const ok = Voice.startListening(t => {
    if (t === null) { Voice.stopListening(); learn.micDead = true; learn.phase = "hiddenself"; renderLearn(); return; }
    learn.transcript = t;
    const el = $("#live-transcript");
    if (el) el.textContent = t || "…";
  });
  learn.phase = ok ? "echo" : "hiddenself";
  renderLearn();
}

function learnEchoDone() {
  learn.transcript = Voice.stopListening();
  learn.result = echoScore(learn.chunks[learn.idx], learn.transcript);
  learn.phase = "check";
  renderLearn();
}

function learnNextChunk() {
  Voice.stopSpeaking();
  if (learn.idx < learn.chunks.length - 1) {
    learn.idx += 1; learn.phase = "show"; learn.transcript = ""; learn.result = null;
  } else {
    learn.stage = "cue";
  }
  renderLearn();
}

function learnBackChunk() {
  Voice.stopSpeaking(); Voice.stopListening();
  if (learn.idx > 0) learn.idx -= 1;
  learn.phase = "show"; learn.transcript = ""; learn.result = null;
  renderLearn();
}

function learnRestartChunks() {
  Voice.stopSpeaking(); Voice.stopListening();
  learn.stage = "chunk"; learn.idx = 0; learn.phase = "show";
  learn.transcript = ""; learn.result = null;
  renderLearn();
}

// Whole-answer checkpoint: recite the full answer, get it word-scored.
function learnFullEcho() {
  Voice.stopSpeaking();
  learn.transcript = "";
  const ok = Voice.startListening(t => {
    if (t === null) { Voice.stopListening(); learn.stage = "fullself"; renderLearn(); return; }
    learn.transcript = t;
    const el = $("#live-transcript");
    if (el) el.textContent = t || "…";
  });
  learn.stage = ok ? "fullecho" : "fullself";
  renderLearn();
}

function learnFullDone() {
  learn.transcript = Voice.stopListening();
  learn.result = echoScore(learn.entry.beats.join(" "), learn.transcript);
  learn.stage = "fullcheck";
  renderLearn();
}

function renderLearn() {
  Pause.setVisible(true);
  const { entry, chunks, stage, idx, phase } = learn;
  let body = "", controls = "", label = "";

  if (stage === "intro") {
    label = "intro";
    body = `
      <div class="learn-intro">
        <p class="ksb-line"><b>${esc(entry.ksb)}</b> — ${esc(entry.topic)}</p>
        <p class="prio ${entry.priority === "Critical Pass" ? "prio-crit" : ""}">${esc(entry.priority)} &middot; ${esc(entry.route)}</p>
        <div class="card">
          <b>They might ask:</b>
          <ul>${entry.questions.slice(0, 3).map(q => `<li>${esc(q)}</li>`).join("")}</ul>
        </div>
        <div class="card hook"><b>🪝 Memory hook</b><p>${esc(entry.mnemonic)}</p></div>
        <div class="card"><b>📄 Say first (evidence)</b><p>“${esc(entry.sayFirst)}”</p></div>
      </div>`;
    controls = `<button class="btn btn-primary btn-big" onclick="learn.stage='chunk';renderLearn()">Start learning the answer</button>`;
    Voice.speak(`${entry.ksb}. ${entry.topic}. Memory hook: ${entry.mnemonic}`, null, [`e${entry.id}-intro`]);
  }

  else if (stage === "chunk") {
    label = `chunk ${idx + 1} of ${chunks.length}`;
    const chunk = chunks[idx];

    const cue = (entry.cues || [])[idx] || "";
    const hook = (entry.hooks || [])[idx] || "";
    if (phase === "show") {
      body = `${chunkDots()}
        ${cue ? `<p class="chunk-cue">🪝 ${esc(cue)}</p>` : ""}
        <p class="step-label">Read it and listen — then say it back with the text hidden:</p>
        <div class="card beat beat-new">${esc(chunk)}</div>
        ${hook ? `<div class="card hook chunk-hook-card">🧠 ${esc(hook)}</div>` : ""}`;
      controls = `
        <button class="btn" onclick="speakChunk()">🔊 Hear it again</button>
        <button class="btn btn-primary btn-big" onclick="learnEcho()">Hide it — I'll say it back</button>
        ${idx > 0 ? `<button class="btn btn-ghost" onclick="learnBackChunk()">‹ Back a chunk</button>` : ""}`;
      speakChunk();
    }

    else if (phase === "echo") {
      body = `${chunkDots()}
        <div class="card listening">
          <p class="mic-live">🎤 Say it from memory…</p>
          ${hook ? `<p class="chunk-hook-line">🧠 ${esc(hook)}</p>` : (cue ? `<p class="chunk-cue">🪝 ${esc(cue)}</p>` : "")}
          <details class="peek"><summary>First letters</summary><p class="cue">${esc(firstLetterCue(chunk))}</p></details>
          <p class="transcript" id="live-transcript">${esc(learn.transcript || "…")}</p>
        </div>`;
      controls = `
        <button class="btn btn-primary btn-big" onclick="learnEchoDone()">⏹ I've said it</button>
        <button class="btn btn-ghost" onclick="Voice.stopListening();learn.phase='show';renderLearn()">Show it again</button>`;
    }

    else if (phase === "check" && !learn.transcript.trim()) {
      // The mic captured nothing — that's a hiccup, not a failure.
      body = `${chunkDots()}
        <div class="card result result-bad">
          <p class="result-title">🎤 I didn't hear anything</p>
          <p>Probably a mic hiccup, not you. Try saying it again.</p>
        </div>`;
      controls = `
        <button class="btn btn-primary btn-big" onclick="learnEcho()">🎤 Try again</button>
        <button class="btn btn-ghost" onclick="learn.phase='show';renderLearn()">See the chunk again</button>`;
    }

    else if (phase === "check") {
      const pct = Math.round(learn.result * 100);
      const pass = learn.result >= 0.7;
      body = `${chunkDots()}
        <div class="card result ${pass ? "result-good" : "result-bad"}">
          <p class="result-title">${pass ? "✅" : "🔁"} You echoed ${pct}% of the key words</p>
        </div>
        <div class="card beat">${echoDiffHtml(chunk, learn.transcript)}</div>
        <details class="peek"><summary>What I heard</summary><p>${esc(learn.transcript || "(nothing)")}</p></details>`;
      controls = pass ? `
        <button class="btn btn-primary btn-big" onclick="learnNextChunk()">${idx === chunks.length - 1 ? "Now the whole answer" : "Next chunk →"}</button>
        <button class="btn btn-ghost" onclick="learnEcho()">Say it again anyway</button>` : `
        <button class="btn btn-primary btn-big" onclick="learn.phase='show';renderLearn()">See it again</button>
        <button class="btn" onclick="learnEcho()">Try again from memory</button>
        <button class="btn btn-ghost" onclick="learnNextChunk()">Move on anyway</button>`;
    }

    else if (phase === "hiddenself") {
      // No microphone available: hide, speak, reveal, honest self-check.
      body = `${chunkDots()}
        ${learn.micDead ? `<div class="card result result-bad"><p>🎤 The mic stopped responding — an iPhone quirk. Carrying on without it; fully closing and reopening the app usually brings it back.</p></div>` : ""}
        <div class="card">
          <p class="step-label">Chunk hidden — say it out loud, then reveal:</p>
          ${cue ? `<p class="chunk-cue">🪝 ${esc(cue)}</p>` : ""}
          <p class="cue">${esc(firstLetterCue(chunk))}</p>
        </div>`;
      controls = `<button class="btn btn-primary btn-big" onclick="learn.phase='revealself';renderLearn()">Reveal to check</button>`;
    }

    else { // revealself
      body = `${chunkDots()}
        <div class="card beat beat-new">${esc(chunk)}</div>`;
      controls = `
        <div class="grade-row">
          <button class="btn grade-bad" onclick="learn.phase='show';renderLearn()">Show me again</button>
          <button class="btn grade-good" onclick="learnNextChunk()">Got it</button>
        </div>`;
    }
  }

  else if (stage === "cue") {
    // Whole-answer checkpoint: loop here as long as you like.
    label = "whole answer";
    const full = entry.beats.join(" ");
    body = `
      <p class="step-label">Say the whole answer out loud using only your signposts:</p>
      <div class="card"><b>🪝 Your signposts</b>
        <ol class="cue-chain">${(entry.cues || []).map((c, i) =>
          `<li>${esc(c)}${(entry.hooks || [])[i] ? `<br><small>🧠 ${esc(entry.hooks[i])}</small>` : ""}</li>`).join("")}</ol>
      </div>
      <details class="peek"><summary>First-letter hints</summary><p class="cue">${esc(firstLetterCue(full))}</p></details>
      <details class="peek"><summary>Peek at the full answer</summary><p>${esc(full)}</p></details>
      <div class="card hook"><b>🪝</b> ${esc(entry.mnemonic)}</div>`;
    controls = `
      <button class="btn btn-primary btn-big" onclick="learnFullEcho()">🎤 Say the whole answer — check me</button>
      <button class="btn" onclick="speakLearnFull()">🔊 Hear it once more</button>
      <button class="btn" onclick="learnRestartChunks()">↩ Practise the chunks again</button>
      <button class="btn btn-ghost" onclick="finishLearn()">Skip the check — quiz me</button>`;
  }

  else if (stage === "fullecho") {
    label = "whole answer";
    body = `
      <div class="card listening">
        <p class="mic-live">🎤 Say the whole answer…</p>
        <p class="chunk-cue">${(entry.cues || []).map(esc).join(" → ")}</p>
        <p class="transcript" id="live-transcript">${esc(learn.transcript || "…")}</p>
      </div>`;
    controls = `
      <button class="btn btn-primary btn-big" onclick="learnFullDone()">⏹ I've said it</button>
      <button class="btn btn-ghost" onclick="Voice.stopListening();learn.stage='cue';renderLearn()">Cancel</button>`;
  }

  else if (stage === "fullcheck") {
    label = "whole answer";
    const full = entry.beats.join(" ");
    const pct = Math.round(learn.result * 100);
    const pass = learn.result >= 0.7;
    body = `
      <div class="card result ${pass ? "result-good" : "result-bad"}">
        <p class="result-title">${pass ? `✅ ${pct}% — you've got it` : `🔁 ${pct}% — not quite yet`}</p>
      </div>
      <div class="card beat">${echoDiffHtml(full, learn.transcript)}</div>
      <details class="peek"><summary>What I heard</summary><p>${esc(learn.transcript || "(nothing)")}</p></details>`;
    controls = pass ? `
      <button class="btn btn-primary btn-big" onclick="finishLearn()">Done — quiz me on it</button>
      <button class="btn" onclick="learnFullEcho()">🎤 Say it again</button>
      <button class="btn btn-ghost" onclick="learnRestartChunks()">↩ Practise the chunks again</button>` : `
      <button class="btn btn-primary btn-big" onclick="learnRestartChunks()">↩ Practise the chunks again</button>
      <button class="btn" onclick="learnFullEcho()">🎤 Say it again</button>
      <button class="btn btn-ghost" onclick="finishLearn()">Quiz me anyway</button>`;
  }

  else { // fullself: no microphone — reveal and judge honestly
    label = "whole answer";
    const full = entry.beats.join(" ");
    body = `
      <p class="step-label">No mic available — say it out loud, then compare:</p>
      <div class="card beat">${esc(full)}</div>`;
    controls = `
      <div class="grade-row">
        <button class="btn grade-bad" onclick="learnRestartChunks()">↩ Chunks again</button>
        <button class="btn grade-good" onclick="finishLearn()">Got it — quiz me</button>
      </div>`;
  }

  app().innerHTML = `
    <header class="top slim">
      <button class="btn-back" onclick="Voice.stopSpeaking();Voice.stopListening();renderHome()">‹ Home</button>
      <span>Learn #${entry.id} &middot; ${label}</span>
    </header>
    ${body}
    <div class="controls">${controls}</div>
  `;
}

function finishLearn() {
  Engine.markLearned(learn.entry.id);
  startQuiz([learn.entry.id]); // test straight away
}

// ---------------------------------------------------------------- QUIZ
// One full test of an entry: question -> answer (listen or self-grade)
// -> KSB check -> evidence check -> result.
let quiz = null;

function buildQueue(ids) {
  if (ids && ids.length) return ids.slice();
  const due = Engine.dueNow().map(e => e.id);
  if (due.length) return due;
  // Nothing due: practise weakest started entries
  const started = Engine.started();
  return shuffle(started).slice(0, 5).map(e => e.id);
}

function startQuiz(ids, walkMode) {
  const queue = buildQueue(ids);
  if (!queue.length) {
    const next = Engine.nextNew();
    if (next) return startLearn(next.id);
    return renderHome();
  }
  quiz = {
    queue, idx: 0, walk: !!walkMode,
    phase: "question", transcript: "", scoreInfo: null,
    ksbOk: null, evOk: null, selfGrade: null,
    results: []
  };
  if (walkMode) WakeLock.on();
  renderQuiz();
}

function quizEntry() {
  return ANSWER_BANK.find(e => e.id === quiz.queue[quiz.idx]);
}

function renderQuiz() {
  Pause.setVisible(true);
  const entry = quizEntry();
  const s = Engine.entry(entry.id);
  const mode = Engine.settings.quizMode;
  if (!quiz.question) {
    quiz.qIndex = Math.floor(Math.random() * entry.questions.length);
    quiz.question = entry.questions[quiz.qIndex];
  }
  const q = quiz.question;
  let body = "", controls = "";

  if (quiz.phase === "question") {
    body = `
      <div class="card question-card">
        <p class="q-label">Assessor asks:</p>
        <p class="q-text">${esc(q)}</p>
      </div>
      ${quiz.micFailed ? `<p class="hint" style="color:var(--bad)">🎤 The mic didn't catch anything that time — give it another go.</p>` : ""}
      <p class="hint">Different wordings, same model answer. Sentence one answers this exact question, then evidence location, then the full structure.</p>`;
    if (mode === "listen" && Voice.sttSupported()) {
      controls = `
        <button class="btn" onclick="speakQuizQuestion()">🔊 Repeat question</button>
        <button class="btn btn-primary btn-big" onclick="quizListen()">🎤 I'm answering — listen</button>
        <button class="btn btn-ghost" onclick="quizReveal()">Skip mic — self-grade instead</button>`;
    } else {
      controls = `
        <button class="btn" onclick="speakQuizQuestion()">🔊 Repeat question</button>
        <button class="btn btn-primary btn-big" onclick="quizReveal()">I've answered — show me the answer</button>`;
    }
    speakQuizQuestion();
  }

  else if (quiz.phase === "listening") {
    body = `
      <div class="card question-card"><p class="q-text">${esc(q)}</p></div>
      <div class="card listening">
        <p class="mic-live">🎤 Listening…</p>
        <p class="transcript" id="live-transcript">${esc(quiz.transcript || "…")}</p>
      </div>`;
    controls = `<button class="btn btn-primary btn-big" onclick="quizStopListen()">⏹ Finished answering</button>`;
  }

  else if (quiz.phase === "score") {
    const { score, hits } = quiz.scoreInfo;
    body = `
      <div class="card">
        <p class="score-line">You hit <b>${hits.filter(Boolean).length} of ${hits.length}</b> key points (${Math.round(score * 100)}%)</p>
        <ul class="kp-list">
          ${entry.keypoints.map((kp, i) =>
            `<li class="${hits[i] ? "kp-hit" : "kp-miss"}">${hits[i] ? "✅" : "❌"} ${esc(kp.t)}</li>`).join("")}
        </ul>
        <details class="peek"><summary>Model answer</summary><p>${esc(entry.beats.join(" "))}</p></details>
      </div>`;
    controls = `<button class="btn btn-primary btn-big" onclick="quizToKsb()">Next: which KSB is this?</button>`;
  }

  else if (quiz.phase === "self") {
    body = `
      <div class="card">
        <p class="q-label">Model answer:</p>
        <p>${esc(entry.beats.join(" "))}</p>
        <p class="q-label" style="margin-top:0.8em">Key points you needed:</p>
        <ul class="kp-list">${entry.keypoints.map(kp => `<li>• ${esc(kp.t)}</li>`).join("")}</ul>
      </div>
      <p class="hint">Be honest — the schedule only works if the grading is true.</p>`;
    controls = `
      <button class="btn" onclick="speakQuizAnswer()">🔊 Read answer</button>
      <div class="grade-row">
        <button class="btn grade-bad" onclick="quizSelfGrade(0)">Missed it</button>
        <button class="btn grade-mid" onclick="quizSelfGrade(0.6)">Partly</button>
        <button class="btn grade-good" onclick="quizSelfGrade(1)">Got it</button>
      </div>`;
  }

  else if (quiz.phase === "ksb") {
    if (!quiz.ksbOptions) {
      const others = shuffle(ANSWER_BANK.filter(e => e.id !== entry.id)).slice(0, 3).map(e => e.ksb);
      quiz.ksbOptions = shuffle([entry.ksb, ...others]);
    }
    body = `
      <div class="card question-card"><p class="q-label">Which KSB does this answer evidence?</p>
      <p>${esc(entry.topic)}</p></div>
      <div class="mc">${quiz.ksbOptions.map(o =>
        `<button class="btn mc-opt" onclick="quizPickKsb('${esc(o)}')">${esc(o)}</button>`).join("")}</div>`;
    controls = "";
    if (quiz.walk) Voice.speak("Which K S B is this?", null, ["g-whichksb"]);
  }

  else if (quiz.phase === "evidence") {
    const spokenEv = mode === "listen" && Voice.sttSupported() && !quiz.forceEvMc;
    if (spokenEv) {
      body = `
        <div class="card question-card"><p class="q-label">Assessor: “Where do you evidence that?”</p></div>
        <p class="hint">Say it out loud: document, pages, heading.</p>`;
      controls = `
        <button class="btn btn-primary btn-big" onclick="quizEvListen()">🎤 I'll say it — listen</button>
        <button class="btn btn-ghost" onclick="quiz.forceEvMc=true;renderQuiz()">Show me choices instead</button>`;
    } else {
      if (!quiz.evOptions) {
        const others = shuffle(ANSWER_BANK.filter(e => e.id !== entry.id)).slice(0, 2).map(e => e.sayFirst);
        quiz.evOptions = shuffle([entry.sayFirst, ...others]);
      }
      body = `
        <div class="card question-card"><p class="q-label">Assessor: “Where do you evidence that?”</p>
        <p class="hint" style="text-align:left">Only ONE of these is the evidence line for <b>this</b> answer — the other two belong to different answers. Pick yours.</p></div>
        <div class="mc">${quiz.evOptions.map((o, i) =>
          `<button class="btn mc-opt mc-long" onclick="quizPickEv(${i})">${esc(o)}</button>`).join("")}</div>`;
      controls = "";
    }
    if (quiz.walk || spokenEv) Voice.speak("Where do you evidence that?", null, ["g-whereev"]);
  }

  else if (quiz.phase === "evlisten") {
    body = `
      <div class="card listening">
        <p class="mic-live">🎤 Say the evidence location…</p>
        <p class="transcript" id="live-transcript">${esc(quiz.transcriptEv || "…")}</p>
      </div>`;
    controls = `<button class="btn btn-primary btn-big" onclick="quizEvDone()">⏹ I've said it</button>`;
  }

  else if (quiz.phase === "evcheck") {
    const pass = quiz.evScore >= 0.5;
    body = `
      <div class="card result ${pass ? "result-good" : "result-bad"}">
        <p class="result-title">${pass ? "✅ Evidence location right" : "🔁 Evidence location shaky"} (${Math.round(quiz.evScore * 100)}%)</p>
      </div>
      <div class="card"><p class="q-label">You should say:</p>
        <p>${echoDiffHtml(entry.sayFirst, quiz.transcriptEv)}</p></div>
      <details class="peek"><summary>What I heard</summary><p>${esc(quiz.transcriptEv || "(nothing)")}</p></details>`;
    controls = `
      <button class="btn btn-primary btn-big" onclick="recordEv(${pass})">Continue</button>
      <button class="btn btn-ghost" onclick="recordEv(${!pass})">${pass ? "Actually, I got it wrong" : "It was right, the mic misheard"}</button>`;
    Voice.speak(entry.sayFirst, null, [`e${entry.id}-sayfirst`]);
  }

  else if (quiz.phase === "result") {
    const r = quiz.results[quiz.results.length - 1];
    const st = Engine.entry(entry.id);
    body = `
      <div class="card result ${r.clean ? "result-good" : "result-bad"}">
        <p class="result-title">${r.clean ? "✅ Clean recall!" : "🔁 Not clean yet — it'll come back soon"}</p>
        <p>Answer score ${Math.round(r.score * 100)}% &middot; KSB ${r.ksbOk ? "✓" : "✗"} &middot; Evidence ${r.evOk ? "✓" : "✗"}</p>
        <p>Clean recalls: ${recallDots(st)} ${st.stage === "mastered" ? "— <b>MASTERED</b> 🎉" : `(${st.cleanRecalls}/3 to master)`}</p>
      </div>
      <div class="card hook"><b>If probed, add:</b><p>${esc(entry.probe)}</p></div>
      <div class="card"><b>📄 Evidence:</b><p>${esc(entry.evidence.primary)}</p></div>`;
    const more = quiz.idx < quiz.queue.length - 1;
    const nextLabel = more ? "Next answer →" : "Finish session";
    controls = r.clean
      ? `<button class="btn btn-primary btn-big" onclick="quizNext()">${nextLabel}</button>
         <button class="btn btn-ghost" onclick="quizRedo()">🔁 Redo it anyway</button>`
      : `<button class="btn btn-primary btn-big" onclick="quizRedo()">🔁 Redo this answer now</button>
         <button class="btn" onclick="quizNext()">${nextLabel}</button>`;
    if (quiz.walk) {
      Voice.speak(
        (r.clean ? "Clean recall. " : "Not clean yet. ") + "If probed, add: " + entry.probe,
        Engine.settings.autoAdvance ? () => setTimeout(() => afterUnpaused(() => { if (quiz && quiz.phase === "result") quizNext(); }), 1500) : null,
        [r.clean ? "g-clean" : "g-notclean", `e${entry.id}-probe`]
      );
    }
  }

  app().innerHTML = `
    <header class="top slim">
      <button class="btn-back" onclick="endQuiz()">‹ End</button>
      <span>${quiz.walk ? "🚶 " : ""}#${entry.id} ${esc(entry.ksb)} &middot; ${quiz.idx + 1}/${quiz.queue.length} ${stageBadge(s)}</span>
    </header>
    ${body}
    <div class="controls">${controls}</div>
  `;
}

function quizListen() {
  quiz.phase = "listening";
  quiz.transcript = "";
  const ok = Voice.startListening(t => {
    if (t === null) { // mic blocked
      quiz.phase = "self";
      renderQuiz();
      return;
    }
    quiz.transcript = t;
    const el = $("#live-transcript");
    if (el) el.textContent = t || "…";
  });
  if (!ok) { quiz.phase = "self"; }
  renderQuiz();
}

function quizStopListen() {
  const transcript = Voice.stopListening();
  quiz.transcript = transcript;
  if (!transcript.trim()) {
    // Mic hiccup: don't score an empty capture — offer the question again.
    quiz.micFailed = true;
    quiz.phase = "question";
    renderQuiz();
    return;
  }
  quiz.micFailed = false;
  quiz.scoreInfo = Engine.scoreTranscript(quizEntry(), transcript);
  quiz.phase = "score";
  renderQuiz();
}

function quizReveal() { quiz.phase = "self"; renderQuiz(); }

function quizSelfGrade(v) {
  quiz.scoreInfo = { score: v, hits: [] };
  quiz.phase = "ksb";
  renderQuiz();
}

function quizToKsb() { quiz.phase = "ksb"; renderQuiz(); }

function quizPickKsb(pick) {
  quiz.ksbOk = pick === quizEntry().ksb;
  quiz.phase = "evidence";
  renderQuiz();
}

function quizPickEv(i) { recordEv(quiz.evOptions[i] === quizEntry().sayFirst); }

function quizEvListen() {
  quiz.transcriptEv = "";
  const ok = Voice.startListening(t => {
    if (t === null) { quiz.forceEvMc = true; quiz.phase = "evidence"; renderQuiz(); return; }
    quiz.transcriptEv = t;
    const el = $("#live-transcript");
    if (el) el.textContent = t || "…";
  });
  if (!ok) { quiz.forceEvMc = true; quiz.phase = "evidence"; renderQuiz(); return; }
  quiz.phase = "evlisten";
  renderQuiz();
}

function quizEvDone() {
  quiz.transcriptEv = Voice.stopListening();
  if (!quiz.transcriptEv.trim()) {
    quiz.phase = "evidence"; // mic hiccup: ask again rather than score zero
    renderQuiz();
    return;
  }
  quiz.evScore = echoScore(quizEntry().sayFirst, quiz.transcriptEv);
  quiz.phase = "evcheck";
  renderQuiz();
}

function recordEv(ok) {
  quiz.evOk = ok;
  const entry = quizEntry();
  const { clean } = Engine.recordResult(entry.id, quiz.scoreInfo.score, quiz.ksbOk, ok);
  quiz.results.push({ id: entry.id, score: quiz.scoreInfo.score, ksbOk: quiz.ksbOk, evOk: ok, clean });
  // Not clean: put this answer back at the end of the session queue so it
  // comes around again before the session finishes.
  if (!clean && quiz.queue.length < 15 && !quiz.queue.slice(quiz.idx + 1).includes(entry.id)) {
    quiz.queue.push(entry.id);
  }
  quiz.phase = "result";
  renderQuiz();
}

function resetQuizItem() {
  quiz.phase = "question";
  quiz.question = null;
  quiz.ksbOptions = null;
  quiz.evOptions = null;
  quiz.forceEvMc = false;
  quiz.transcript = "";
  quiz.transcriptEv = "";
  quiz.evScore = null;
  quiz.scoreInfo = null;
}

// Immediately re-test the same answer (fresh question) without moving on.
function quizRedo() {
  Voice.stopSpeaking();
  resetQuizItem();
  renderQuiz();
}

function quizNext() {
  if (quiz.idx < quiz.queue.length - 1) {
    quiz.idx += 1;
    resetQuizItem();
    renderQuiz();
  } else {
    endQuiz(true);
  }
}

function endQuiz(finished) {
  Voice.stopSpeaking();
  Voice.stopListening();
  WakeLock.off();
  if (finished && quiz && quiz.results.length) {
    const clean = quiz.results.filter(r => r.clean).length;
    const wasWalk = quiz.walk;
    const n = quiz.results.length;
    quiz = null;
    app().innerHTML = `
      <header class="top"><h1>Session done</h1></header>
      <div class="card result result-good">
        <p class="result-title">${clean}/${n} clean recalls this session</p>
      </div>
      <button class="btn btn-primary btn-big" onclick="${wasWalk ? "startWalk()" : "renderHome()"}">${wasWalk ? "Keep walking — more practice" : "Back to home"}</button>
      <button class="btn btn-ghost" onclick="renderHome()">Home</button>`;
    Voice.speak(`Session done. ${clean} out of ${n} clean recalls.`, null, [`g-sess-${clean}-${n}`]);
  } else {
    quiz = null;
    renderHome();
  }
}

// ---------------------------------------------------------------- WALK MODE
function startWalk() {
  // Due first, then weakest; endless-ish queue of up to 10.
  const due = Engine.dueNow().map(e => e.id);
  const started = Engine.started().map(e => e.id).filter(id => !due.includes(id));
  const queue = [...due, ...shuffle(started)].slice(0, 10);
  if (!queue.length) {
    const next = Engine.nextNew();
    if (next) { Engine.markLearned(next.id); queue.push(next.id); } // learn-by-testing fallback
  }
  startQuiz(queue, true);
}

// ---------------------------------------------------------------- EVIDENCE DRILL
// Rapid-fire: "Where do you evidence X?" -> recall out loud -> reveal -> self-grade.
let drill = null;

function startDrill() {
  const pool = Engine.started().length >= 3 ? Engine.started() : Engine.learningOrder();
  drill = { queue: shuffle(pool).map(e => e.id), idx: 0, revealed: false, right: 0 };
  renderDrill();
}

function renderDrill() {
  Pause.setVisible(true);
  const entry = ANSWER_BANK.find(e => e.id === drill.queue[drill.idx]);
  let body, controls;
  if (!drill.revealed) {
    body = `
      <div class="card question-card">
        <p class="q-label">Assessor: “Where do you evidence…”</p>
        <p class="q-text">${esc(entry.ksb)} — ${esc(entry.topic)}?</p>
      </div>
      <p class="hint">Say the location out loud, fast. Document, page, heading.</p>`;
    controls = `<button class="btn btn-primary btn-big" onclick="drill.revealed=true;renderDrill()">Reveal location</button>`;
    Voice.speak(`Where do you evidence ${entry.ksb}, ${entry.topic}?`, null, [`e${entry.id}-drill`]);
  } else {
    body = `
      <div class="card">
        <p class="q-label">You should say:</p>
        <p><b>“${esc(entry.sayFirst)}”</b></p>
        <p class="q-label" style="margin-top:0.8em">Strongest location:</p>
        <p>${esc(entry.evidence.primary)}</p>
        ${entry.evidence.visual || entry.evidence.backup ? `
        <details class="peek"><summary>Backup locations (only if asked for a second example)</summary>
          ${entry.evidence.visual ? `<p>QUICK VISUAL: ${esc(entry.evidence.visual)}</p>` : ""}
          ${entry.evidence.backup ? `<p>BACKUP: ${esc(entry.evidence.backup)}</p>` : ""}
        </details>` : ""}
      </div>`;
    controls = `
      <div class="grade-row">
        <button class="btn grade-bad" onclick="drillGrade(false)">Missed it</button>
        <button class="btn grade-good" onclick="drillGrade(true)">Nailed it</button>
      </div>`;
    Voice.speak(entry.sayFirst, null, [`e${entry.id}-sayfirst`]);
  }
  app().innerHTML = `
    <header class="top slim">
      <button class="btn-back" onclick="Voice.stopSpeaking();renderHome()">‹ End</button>
      <span>📄 Evidence drill &middot; ${drill.idx + 1}/${drill.queue.length}</span>
    </header>
    ${body}
    <div class="controls">${controls}</div>`;
}

function drillGrade(ok) {
  Engine.recordEvidenceDrill(drill.queue[drill.idx], ok);
  if (ok) drill.right += 1;
  if (drill.idx < drill.queue.length - 1) {
    drill.idx += 1;
    drill.revealed = false;
    renderDrill();
  } else {
    const msg = `${drill.right} out of ${drill.queue.length} evidence locations nailed.`;
    Voice.speak(msg, null, [`g-drill-${drill.right}-${drill.queue.length}`]);
    app().innerHTML = `
      <header class="top"><h1>Drill done</h1></header>
      <div class="card result ${drill.right === drill.queue.length ? "result-good" : ""}">
        <p class="result-title">${msg}</p>
      </div>
      <button class="btn btn-primary btn-big" onclick="startDrill()">Again — repetition is the point</button>
      <button class="btn btn-ghost" onclick="renderHome()">Home</button>`;
    drill = null;
  }
}

// ---------------------------------------------------------------- BROWSE + DETAIL
function renderBrowse() {
  const groups = [
    ["Project Presentation / Q&A", ANSWER_BANK.filter(e => e.route.startsWith("Project"))],
    ["Professional Discussion with Portfolio", ANSWER_BANK.filter(e => e.route.startsWith("Professional"))]
  ];
  app().innerHTML = `
    <header class="top slim">
      <button class="btn-back" onclick="renderHome()">‹ Home</button>
      <span>All 18 answers</span>
    </header>
    ${groups.map(([name, list]) => `
      <p class="group-label">${esc(name)}</p>
      ${list.map(e => {
        const s = Engine.entry(e.id);
        return `<button class="row" onclick="renderDetail(${e.id})">
          <span class="row-id">${e.id}</span>
          <span class="row-main"><b>${esc(e.ksb)}</b> ${esc(e.topic)}
            ${e.priority === "Critical Pass" ? `<span class="crit-flag">CRITICAL</span>` : ""}</span>
          <span class="row-side">${stageBadge(s)}${recallDots(s)}</span>
        </button>`;
      }).join("")}`).join("")}
  `;
}

function renderDetail(id) {
  const e = ANSWER_BANK.find(x => x.id === id);
  const s = Engine.entry(id);
  app().innerHTML = `
    <header class="top slim">
      <button class="btn-back" onclick="renderBrowse()">‹ Back</button>
      <span>#${e.id} ${esc(e.ksb)} ${stageBadge(s)}</span>
    </header>
    <p class="ksb-line"><b>${esc(e.ksb)}</b> — ${esc(e.topic)}</p>
    <p class="prio ${e.priority === "Critical Pass" ? "prio-crit" : ""}">${esc(e.priority)} &middot; ${esc(e.route)}</p>
    <div class="card hook"><b>🪝 Memory hook</b><p>${esc(e.mnemonic)}</p></div>
    ${e.cues && e.cues.length ? `<div class="card"><b>🪝 Signposts &amp; hooks</b><ol class="cue-chain">${e.cues.map((c, i) =>
      `<li>${esc(c)}${(e.hooks || [])[i] ? `<br><small>🧠 ${esc(e.hooks[i])}</small>` : ""}</li>`).join("")}</ol></div>` : ""}
    <div class="card"><b>They might ask</b><ul>${e.questions.map(q => `<li>${esc(q)}</li>`).join("")}</ul></div>
    <div class="card"><b>Say first</b><p>“${esc(e.sayFirst)}”</p></div>
    <div class="card"><b>The 30–45s answer</b>${e.beats.map(b => `<p>${esc(b)}</p>`).join("")}</div>
    <div class="card"><b>If probed, add</b><p>${esc(e.probe)}</p></div>
    <div class="card"><b>📄 Evidence — strongest location</b>
      <p>${esc(e.evidence.primary)}</p>
      ${e.evidence.visual || e.evidence.backup ? `
      <details class="peek"><summary>Backup locations</summary>
        ${e.evidence.visual ? `<p>QUICK VISUAL: ${esc(e.evidence.visual)}</p>` : ""}
        ${e.evidence.backup ? `<p>BACKUP: ${esc(e.evidence.backup)}</p>` : ""}
      </details>` : ""}
    </div>
    <div class="controls">
      <button class="btn" onclick="speakEntryAnswer(${e.id})">🔊 Read answer aloud</button>
      <button class="btn btn-primary" onclick="startLearn(${e.id})">Learn / relearn this</button>
      <button class="btn" onclick="Engine.markLearned(${e.id});startQuiz([${e.id}])">Test me on this now</button>
    </div>
  `;
}

// ---------------------------------------------------------------- PROGRESS
function renderProgress() {
  const sum = Engine.summary();
  app().innerHTML = `
    <header class="top slim">
      <button class="btn-back" onclick="renderHome()">‹ Home</button>
      <span>Progress — ${sum.pct}% overall</span>
    </header>
    <div class="progress-bar"><div class="progress-fill" style="width:${sum.pct}%"></div></div>
    ${Engine.learningOrder().map(e => {
      const s = Engine.entry(e.id);
      const evTotal = s.evRight + s.evWrong;
      const evPct = evTotal ? Math.round((s.evRight / evTotal) * 100) : null;
      return `<button class="row" onclick="renderDetail(${e.id})">
        <span class="row-id">${e.id}</span>
        <span class="row-main"><b>${esc(e.ksb)}</b> ${esc(e.topic)}<br>
          <small>${s.attempts} test${s.attempts === 1 ? "" : "s"}${s.lastScore !== null ? ` · last ${Math.round(s.lastScore * 100)}%` : ""}${evPct !== null ? ` · evidence ${evPct}%` : ""}</small>
        </span>
        <span class="row-side">${stageBadge(s)}${recallDots(s)}</span>
      </button>`;
    }).join("")}
  `;
}

// ---------------------------------------------------------------- SETTINGS
function renderSettings() {
  const st = Engine.settings;
  app().innerHTML = `
    <header class="top slim">
      <button class="btn-back" onclick="renderHome()">‹ Home</button>
      <span>Settings</span>
    </header>
    <div class="card">
      <label class="setting"><span>Voice (read aloud)</span>
        <input type="checkbox" ${st.voiceOn ? "checked" : ""} onchange="Engine.settings.voiceOn=this.checked;Engine.saveSettings()"></label>
      <label class="setting"><span>Narrated audio (studio voice)</span>
        <input type="checkbox" ${st.narration !== false ? "checked" : ""} onchange="Engine.settings.narration=this.checked;Engine.saveSettings()"></label>
      <label class="setting"><span>Speech speed</span>
        <input type="range" min="0.7" max="1.4" step="0.1" value="${st.rate}"
          onchange="Engine.settings.rate=parseFloat(this.value);Engine.saveSettings();Voice.speak('This is my speaking speed.', null, ['g-speed'])"></label>
      <label class="setting"><span>Voice</span>
        <select onchange="Engine.settings.voiceName=this.value;Engine.saveSettings();Voice.init();Voice.speak('Hello Jason, I will read your answers in this voice.')">
          <option value="">Best available</option>
          ${Voice.englishVoices().map(v =>
            `<option value="${esc(v.name)}" ${st.voiceName === v.name ? "selected" : ""}>${esc(v.name)} (${esc(v.lang)})</option>`).join("")}
        </select></label>
      <label class="setting"><span>Quiz mode</span>
        <select onchange="Engine.settings.quizMode=this.value;Engine.saveSettings()">
          <option value="self" ${st.quizMode === "self" ? "selected" : ""}>Self-grade (reliable)</option>
          <option value="listen" ${st.quizMode === "listen" ? "selected" : ""}>Listen & score me (mic)</option>
        </select></label>
      <label class="setting"><span>Walk mode auto-advance</span>
        <input type="checkbox" ${st.autoAdvance ? "checked" : ""} onchange="Engine.settings.autoAdvance=this.checked;Engine.saveSettings()"></label>
    </div>
    <div class="card">
      <p><b>Mic on iPhone:</b> listen mode needs Settings → Siri &amp; Search → “Siri &amp; Dictation” enabled, and Safari mic permission. If it misbehaves outdoors, switch to self-grade.</p>
      <p><b>Nicer voice on iPhone:</b> download a Premium voice once in Settings → Accessibility → Spoken Content → Voices → English (UK) — e.g. “Serena (Premium)” — then pick it in the Voice list above.</p>
    </div>
    <button class="btn btn-ghost" onclick="if(confirm('Forget the passphrase on this device? You will need to type it again next time.')){DataLock.forget()}">🔒 Forget passphrase on this device</button>
    <button class="btn btn-ghost danger" onclick="if(confirm('Reset ALL progress? This cannot be undone.')){Engine.resetAll();renderHome()}">Reset all progress</button>
  `;
}

// ---------------------------------------------------------------- BOOT
function bootApp() {
  Engine.load();
  renderHome();
}

window.addEventListener("DOMContentLoaded", async () => {
  Voice.init();
  document.getElementById("pause-btn").addEventListener("click", () => Pause.toggle());
  document.getElementById("pause-resume").addEventListener("click", () => Pause.resume());
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // Decrypt the answer bank: automatically if this device knows the
  // passphrase, otherwise show the unlock screen.
  const unlocked = await DataLock.tryAutoUnlock().catch(() => false);
  if (unlocked) bootApp();
  else DataLock.renderUnlock(bootApp);
});
