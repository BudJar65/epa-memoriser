// EPA Answer Memoriser — UI and flows.
// Screens: home, learn, quiz, drill (evidence), walk, browse, detail, progress, settings.

const APP_VERSION = "v30"; // shown on the home screen; bumped every release

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

// Jason recalls a chunk from how it STARTS: given the opening, the rest
// follows. So cue with the first few words, not invented mnemonics.
function openingWords(text, n = 4) {
  const words = text.trim().split(/\s+/);
  return words.slice(0, n).join(" ") + (words.length > n ? " …" : "");
}

// Render a chunk with its opening words in bold, to anchor the eye on them.
function chunkHtml(chunk) {
  const words = chunk.trim().split(/\s+/);
  const n = Math.min(4, words.length);
  return `<b>${esc(words.slice(0, n).join(" "))}</b> ${esc(words.slice(n).join(" "))}`;
}

// Turn a sentence into a first-letter cue: "I planned the BA work" -> "I p t B w"
function firstLetterCue(text) {
  return text.split(/\s+/).map(w => {
    const m = w.match(/[A-Za-z0-9]/);
    return m ? m[0] : w;
  }).join(" ");
}

// ---- Global pause: freezes narration and auto-advance in place ----
const Pause = {
  paused: false,
  toggle() { this.paused ? this.resume() : this.pause(); },
  pause() {
    this.paused = true;
    if (Voice.synth) { try { Voice.synth.pause(); } catch (e) {} }
    AudioPlayer.pauseClip();
    document.getElementById("pause-overlay").classList.add("show");
  },
  resume() {
    this.paused = false;
    document.getElementById("pause-overlay").classList.remove("show");
    if (Voice.synth) { try { Voice.synth.resume(); } catch (e) {} }
    AudioPlayer.resumeClip();
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
// back out loud from memory -> reveal it and judge yourself honestly.
// Then the whole answer from first-letter hints only.
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

function startLearn(id) {
  const entry = ANSWER_BANK.find(e => e.id === id);
  learn = { entry, chunks: chunkify(entry), stage: "intro", idx: 0, phase: "show" };
  renderLearn();
}

function chunkClipKey() { return `e${learn.entry.id}-c${learn.idx}`; }
function speakChunk() { Voice.speak(learn.chunks[learn.idx], null, [chunkClipKey()]); }

function chunkDots() {
  return `<p class="chunk-dots">${learn.chunks.map((_, i) =>
    `<span class="dot ${i < learn.idx ? "dot-on" : i === learn.idx ? "dot-now" : ""}"></span>`).join("")}</p>`;
}

// Hide the chunk: say it out loud from the first-letter cue, then reveal.
function learnHide() {
  Voice.stopSpeaking();
  learn.phase = "hidden";
  renderLearn();
}

// "Try again" after a miss. This lands back on the chunk screen, which looks
// almost identical to the reveal screen it came from — so flag it, or the tap
// feels like it did nothing.
function learnTryAgain() {
  learn.retry = true;
  learn.phase = "show";
  renderLearn();
}

function learnNextChunk() {
  Voice.stopSpeaking();
  if (learn.idx < learn.chunks.length - 1) {
    learn.idx += 1; learn.phase = "show";
  } else {
    learn.stage = "cue";
  }
  renderLearn();
}

function learnBackChunk() {
  Voice.stopSpeaking();
  if (learn.idx > 0) learn.idx -= 1;
  learn.phase = "show";
  renderLearn();
}

function learnRestartChunks() {
  Voice.stopSpeaking();
  learn.stage = "chunk"; learn.idx = 0; learn.phase = "show";
  renderLearn();
}

// Openings drill: recall how each chunk STARTS (Jason's key to the rest).
// Self-graded tap-to-reveal — no microphone involved. "Not yet" chunks come
// back around until every opening is recalled cleanly.
function startOpenings() {
  Voice.stopSpeaking();
  learn.stage = "openings";
  learn.opQueue = learn.chunks.map((_, i) => i);
  learn.opRetry = [];
  learn.opRevealed = false;
  renderLearn();
}

function openingsGrade(ok) {
  const i = learn.opQueue.shift();
  if (!ok) learn.opRetry.push(i);
  if (learn.opQueue.length === 0 && learn.opRetry.length > 0) {
    learn.opQueue = learn.opRetry;
    learn.opRetry = [];
  }
  learn.opRevealed = false;
  if (learn.opQueue.length === 0) {
    learn.opDone = true; // one-off "nailed it" note on the first chunk screen
    learn.stage = "chunk"; learn.idx = 0; learn.phase = "show";
  }
  renderLearn();
}

// Whole-answer checkpoint: say it all from the signposts, then compare.
function learnFullReveal() {
  Voice.stopSpeaking();
  learn.stage = "full";
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
        <div class="card"><b>🔑 How each chunk starts</b>
          <ol class="cue-chain">${chunks.map(c => `<li>“${esc(openingWords(c))}”</li>`).join("")}</ol>
        </div>
        <div class="card"><b>📄 Say first (evidence)</b><p>“${esc(entry.sayFirst)}”</p></div>
      </div>`;
    controls = `
      <button class="btn btn-primary btn-big" onclick="startOpenings()">Practise the openings</button>
      <button class="btn btn-ghost" onclick="learn.stage='chunk';renderLearn()">Straight to the chunks</button>`;
    Voice.speak(`${entry.ksb}. ${entry.topic}. How each chunk starts. ` +
      chunks.map((c, i) => `${i + 1}. ${openingWords(c).replace(" …", "")}.`).join(" "),
      null, [`e${entry.id}-intro`]);
  }

  else if (stage === "openings") {
    const i = learn.opQueue[0];
    const chunk = chunks[i];
    const cue = (entry.cues || [])[i] || "";
    const opening = openingWords(chunk);
    label = "openings drill";
    if (!learn.opRevealed) {
      body = `
        <p class="step-label">Chunk ${i + 1} of ${chunks.length} — how does it start?</p>
        <div class="card">
          ${cue ? `<p class="chunk-cue">🪝 ${esc(cue)}</p>` : ""}
          <p class="cue">${esc(firstLetterCue(opening.replace(" …", "")))}</p>
        </div>`;
      controls = `
        <button class="btn btn-primary btn-big" onclick="learn.opRevealed=true;renderLearn()">Reveal the opening</button>
        <button class="btn btn-ghost" onclick="learn.stage='chunk';renderLearn()">Skip to the chunks</button>`;
    } else {
      body = `
        <p class="step-label">Chunk ${i + 1} of ${chunks.length} starts:</p>
        <div class="card beat beat-new">“${esc(opening)}”</div>`;
      controls = `
        <div class="grade-row">
          <button class="btn grade-bad" onclick="openingsGrade(false)">Not yet</button>
          <button class="btn grade-good" onclick="openingsGrade(true)">Got it</button>
        </div>`;
    }
  }

  else if (stage === "chunk") {
    label = `chunk ${idx + 1} of ${chunks.length}`;
    const chunk = chunks[idx];

    const cue = (entry.cues || [])[idx] || "";
    if (phase === "show") {
      const opDone = learn.opDone; learn.opDone = false;
      const retry = learn.retry; learn.retry = false;
      body = `${chunkDots()}
        ${opDone ? `<div class="card result result-good"><p>✅ Openings nailed — now the full chunks.</p></div>` : ""}
        ${retry ? `<div class="card result result-bad"><p class="result-title">🔁 Here it is again</p><p>Read it through, listen to it, then hide it and have another go.</p></div>` : ""}
        ${cue ? `<p class="chunk-cue">🪝 ${esc(cue)}</p>` : ""}
        <p class="step-label">${retry ? "The <b>bold opening</b> is your way in — get that and the rest follows:" : "Read it and listen — the <b>bold opening</b> is your way in. Then say it back with the text hidden:"}</p>
        <div class="card beat beat-new">${chunkHtml(chunk)}</div>`;
      controls = `
        <button class="btn" onclick="speakChunk()">🔊 Hear it again</button>
        <button class="btn btn-primary btn-big" onclick="learnHide()">Hide it — I'll say it back</button>
        ${idx > 0 ? `<button class="btn btn-ghost" onclick="learnBackChunk()">‹ Back a chunk</button>` : ""}`;
      speakChunk();
    }

    else if (phase === "hidden") {
      body = `${chunkDots()}
        <div class="card">
          <p class="step-label">Chunk hidden — say it out loud, then reveal:</p>
          ${cue ? `<p class="chunk-cue">🪝 ${esc(cue)}</p>` : ""}
          <p class="cue">${esc(firstLetterCue(chunk))}</p>
          <details class="peek"><summary>Show me the chunk</summary><p>“${chunkHtml(chunk)}”</p></details>
        </div>`;
      controls = `
        <button class="btn btn-primary btn-big" onclick="learn.phase='reveal';renderLearn()">Reveal to check</button>
        <button class="btn btn-ghost" onclick="learn.phase='show';renderLearn()">Show it again</button>`;
    }

    else { // reveal — how did you do?
      body = `${chunkDots()}
        <p class="step-label">How did you do?</p>
        <div class="card beat beat-new">${chunkHtml(chunk)}</div>`;
      controls = `
        <div class="grade-row">
          <button class="btn grade-bad" onclick="learnTryAgain()">Show me again</button>
          <button class="btn grade-good" onclick="learnNextChunk()">${idx === chunks.length - 1 ? "Got it — whole answer" : "Got it"}</button>
        </div>`;
    }
  }

  else if (stage === "cue") {
    // Whole-answer checkpoint: loop here as long as you like.
    label = "whole answer";
    const full = entry.beats.join(" ");
    body = `
      <p class="step-label">Say the whole answer out loud using only your signposts:</p>
      <div class="card"><b>🪝 Your signposts — and how each chunk starts</b>
        <ol class="cue-chain">${(entry.cues || []).map((c, i) =>
          `<li>${esc(c)}${chunks[i] ? `<br><small>▶ “${esc(openingWords(chunks[i]))}”</small>` : ""}</li>`).join("")}</ol>
      </div>
      <details class="peek"><summary>First-letter hints</summary><p class="cue">${esc(firstLetterCue(full))}</p></details>
      <details class="peek"><summary>Peek at the full answer</summary><p>${esc(full)}</p></details>`;
    controls = `
      <button class="btn btn-primary btn-big" onclick="learnFullReveal()">I've said it — show me the answer</button>
      <button class="btn" onclick="speakLearnFull()">🔊 Hear it once more</button>
      <button class="btn" onclick="learnRestartChunks()">↩ Practise the chunks again</button>
      <button class="btn btn-ghost" onclick="finishLearn()">Skip the check — quiz me</button>`;
  }

  else { // full — the whole answer revealed; judge yourself honestly
    label = "whole answer";
    const full = entry.beats.join(" ");
    body = `
      <p class="step-label">How close was it?</p>
      <div class="card beat">${esc(full)}</div>`;
    controls = `
      <div class="grade-row">
        <button class="btn grade-bad" onclick="learnRestartChunks()">↩ Chunks again</button>
        <button class="btn grade-good" onclick="finishLearn()">Got it — quiz me</button>
      </div>`;
  }

  app().innerHTML = `
    <header class="top slim">
      <button class="btn-back" onclick="Voice.stopSpeaking();renderHome()">‹ Home</button>
      <span>Learn #${entry.id} &middot; ${label}</span>
    </header>
    ${body}
    <div class="controls">${controls}</div>
  `;
}

function finishLearn() {
  Engine.markLearned(learn.entry.id);
  Engine.logEvent("learn", { id: learn.entry.id });
  startQuiz([learn.entry.id]); // test straight away
}

// ---------------------------------------------------------------- QUIZ
// One full test of an entry: question -> say it out loud -> reveal and
// self-grade -> KSB check -> evidence check -> result.
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
    phase: "question", scoreInfo: null,
    ksbOk: null, evOk: null,
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
      <p class="hint">Different wordings, same model answer. Sentence one answers this exact question, then evidence location, then the full structure.</p>`;
    controls = `
      <button class="btn" onclick="speakQuizQuestion()">🔊 Repeat question</button>
      <button class="btn btn-primary btn-big" onclick="quizReveal()">I've answered — show me the answer</button>`;
    speakQuizQuestion();
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

  else if (quiz.phase === "restudy") {
    const missed = quiz.scoreInfo.score < 0.6;
    body = `
      <div class="card">
        <p class="q-label">What you should have said:</p>
        <p>${esc(entry.beats.join(" "))}</p>
        <p class="q-label" style="margin-top:0.8em">Key points you needed:</p>
        <ul class="kp-list">${entry.keypoints.map(kp => `<li>• ${esc(kp.t)}</li>`).join("")}</ul>
      </div>
      <p class="hint">Marked <b>${missed ? "Missed it" : "Partly"}</b> — that's what counts towards your
        review schedule, so this is free practice. Go round as many times as you like.</p>`;
    controls = `
      <button class="btn" onclick="speakQuizAnswer()">🔊 Read it to me</button>
      <button class="btn btn-primary btn-big" onclick="quiz.phase='retry';renderQuiz()">🔁 Hide it — I'll say it again</button>
      <button class="btn btn-ghost" onclick="quizToKsb()">Carry on — which KSB is this?</button>`;
  }

  else if (quiz.phase === "retry") {
    body = `
      <div class="card question-card">
        <p class="q-label">Assessor asks:</p>
        <p class="q-text">${esc(q)}</p>
      </div>
      <p class="hint">Free practice — say the whole answer out loud again, then check it.</p>`;
    controls = `
      <button class="btn btn-primary btn-big" onclick="quiz.phase='restudy';renderQuiz()">Show me the answer again</button>
      <button class="btn btn-ghost" onclick="quizToKsb()">Carry on — which KSB is this?</button>`;
    speakQuizQuestion();
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
    body = `
      <div class="card question-card"><p class="q-label">Assessor: “Where do you evidence that?”</p></div>
      <p class="hint">Say it out loud — document, pages, heading — then reveal and mark yourself.</p>`;
    controls = `<button class="btn btn-primary btn-big" onclick="quiz.phase='evreveal';renderQuiz()">Reveal the evidence line</button>`;
    Voice.speak("Where do you evidence that?", null, ["g-whereev"]);
  }

  else if (quiz.phase === "evreveal") {
    body = `
      <div class="card">
        <p class="q-label">You should say:</p>
        <p><b>“${esc(entry.sayFirst)}”</b></p>
        <p class="q-label" style="margin-top:0.8em">Strongest location:</p>
        <p>${esc(entry.evidence.primary)}</p>
      </div>`;
    controls = `
      <div class="grade-row">
        <button class="btn grade-bad" onclick="recordEv(false)">Missed it</button>
        <button class="btn grade-good" onclick="recordEv(true)">Got it</button>
      </div>`;
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

function quizReveal() { quiz.phase = "self"; renderQuiz(); }

function quizSelfGrade(v) {
  quiz.scoreInfo = { score: v, hits: [] };
  // Graded yourself short? Go and re-read it, and say it again as many times
  // as you like. The grade above is the one that counts towards the review
  // schedule — the retry is free practice, so the schedule stays honest.
  quiz.phase = v >= 1 ? "ksb" : "restudy";
  renderQuiz();
}

function quizToKsb() { quiz.phase = "ksb"; renderQuiz(); }

function quizPickKsb(pick) {
  quiz.ksbOk = pick === quizEntry().ksb;
  quiz.phase = "evidence";
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
  WakeLock.off();
  if (finished && quiz && quiz.results.length) {
    const clean = quiz.results.filter(r => r.clean).length;
    const wasWalk = quiz.walk;
    const n = quiz.results.length;
    Engine.logEvent("quiz", { clean, n, walk: wasWalk });
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
    Engine.logEvent("drill", { right: drill.right, n: drill.queue.length });
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
  const chs = chunkify(e);
  app().innerHTML = `
    <header class="top slim">
      <button class="btn-back" onclick="renderBrowse()">‹ Back</button>
      <span>#${e.id} ${esc(e.ksb)} ${stageBadge(s)}</span>
    </header>
    <p class="ksb-line"><b>${esc(e.ksb)}</b> — ${esc(e.topic)}</p>
    <p class="prio ${e.priority === "Critical Pass" ? "prio-crit" : ""}">${esc(e.priority)} &middot; ${esc(e.route)}</p>
    ${e.cues && e.cues.length ? `<div class="card"><b>🪝 Signposts &amp; openings</b><ol class="cue-chain">${e.cues.map((c, i) =>
      `<li>${esc(c)}${chs[i] ? `<br><small>▶ “${esc(openingWords(chs[i]))}”</small>` : ""}</li>`).join("")}</ol></div>` : ""}
    <div class="card"><b>They might ask</b><ul>${e.questions.map(q => `<li>${esc(q)}</li>`).join("")}</ul></div>
    <div class="card"><b>Say first</b><p>“${esc(e.sayFirst)}”</p></div>
    <div class="card"><b>The 20–30s answer</b>${e.beats.map(b => `<p>${esc(b)}</p>`).join("")}</div>
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
// One line of the study diary, e.g. "14:32  🎤 Quiz session — 3/5 clean".
function historyLine(ev) {
  const time = new Date(ev.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  let what;
  if (ev.kind === "learn") {
    const e = ANSWER_BANK.find(a => a.id === ev.id);
    what = e ? `📖 Learned #${e.id} ${esc(e.ksb)} — ${esc(e.topic)}` : `📖 Learned #${ev.id}`;
  } else if (ev.kind === "quiz") {
    what = `${ev.walk ? "🚶 Walk" : "📝 Quiz"} session — ${ev.clean}/${ev.n} clean`;
  } else if (ev.kind === "drill") {
    what = `📄 Evidence drill — ${ev.right}/${ev.n} nailed`;
  } else {
    what = esc(ev.kind);
  }
  return `<p class="hist-line"><span class="hist-time">${time}</span>${what}</p>`;
}

// Diary entries grouped under day headings (Today / Yesterday / Sat 19 Jul).
function historyHtml(events) {
  const days = [];
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 864e5).toDateString();
  for (const ev of events) {
    const d = new Date(ev.t);
    const key = d.toDateString();
    if (!days.length || days[days.length - 1].key !== key) {
      const label = key === today ? "Today" : key === yesterday ? "Yesterday"
        : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
      days.push({ key, label, lines: [] });
    }
    days[days.length - 1].lines.push(historyLine(ev));
  }
  return days.map(d => `<p class="hist-day">${d.label}</p>${d.lines.join("")}`).join("");
}

function renderProgress() {
  const sum = Engine.summary();
  const hist = Engine.history;
  const RECENT = 8;
  app().innerHTML = `
    <header class="top slim">
      <button class="btn-back" onclick="renderHome()">‹ Home</button>
      <span>Progress — ${sum.pct}% overall</span>
    </header>
    <div class="progress-bar"><div class="progress-fill" style="width:${sum.pct}%"></div></div>
    <div class="card">
      <p class="q-label">📜 What you've done</p>
      ${hist.length ? historyHtml(hist.slice(0, RECENT)) : `
        <p class="hist-line">Nothing logged yet — your study diary starts at v23.
        Finish a learn, quiz or evidence drill and it will show up here.</p>`}
      ${hist.length > RECENT ? `
        <details class="peek"><summary>Earlier (${hist.length - RECENT} more)</summary>
          ${historyHtml(hist.slice(RECENT))}
        </details>` : ""}
    </div>
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
function syncStatusLine() {
  if (Sync.status === "error") return "⚠️ Last sync failed: " + Sync.lastError;
  if (Sync.status === "syncing") return "Syncing…";
  if (Sync.lastSynced) {
    return "Last synced " + new Date(Sync.lastSynced)
      .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return "Connected — waiting for first sync.";
}

async function syncEnableClicked() {
  const input = $("#sync-token");
  const err = $("#sync-error");
  const token = (input && input.value || "").trim();
  if (!token) { err.textContent = "Paste the token in first."; return; }
  err.style.color = "var(--muted)";
  err.textContent = "Connecting to GitHub…";
  try {
    await Sync.enable(token);
    renderSettings();
  } catch (e) {
    err.style.color = "var(--bad)";
    err.textContent = e.message;
  }
}

async function syncNowClicked() {
  const el = $("#sync-status");
  if (el) el.textContent = "Syncing…";
  await Sync.syncNow();
  renderSettings();
}

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
      <label class="setting"><span>Walk mode auto-advance</span>
        <input type="checkbox" ${st.autoAdvance ? "checked" : ""} onchange="Engine.settings.autoAdvance=this.checked;Engine.saveSettings()"></label>
    </div>
    <div class="card">
      <p><b>Nicer voice on iPhone:</b> download a Premium voice once in Settings → Accessibility → Spoken Content → Voices → English (UK) — e.g. “Serena (Premium)” — then pick it in the Voice list above.</p>
    </div>
    <div class="card">
      <p><b>☁️ Sync between phone and PC</b></p>
      ${Sync.enabled() ? `
        <p style="font-size:0.9rem">ON — progress and diary are shared through a private,
          encrypted note on your GitHub account.</p>
        <p id="sync-status" style="font-size:0.85rem;color:var(--muted)">${esc(syncStatusLine())}</p>
        <button class="btn" onclick="syncNowClicked()">Sync now</button>
        <button class="btn btn-ghost" onclick="if(confirm('Turn off sync on this device? Nothing is deleted — other devices keep syncing.')){Sync.disable();renderSettings()}">Turn off on this device</button>
      ` : `
        <p style="font-size:0.9rem">Share your progress and study diary between devices.
          Paste a GitHub token here (classic token with only the <b>gist</b> permission) —
          same token on every device.</p>
        <input id="sync-token" type="password" placeholder="GitHub token (ghp_…)"
          autocapitalize="off" autocorrect="off" spellcheck="false"
          style="width:100%;font-size:1rem;padding:10px;border-radius:10px;
                 border:1px solid var(--line);background:var(--bg);color:var(--text)">
        <p id="sync-error" style="color:var(--bad);font-size:0.85rem;min-height:1.1em"></p>
        <button class="btn btn-primary" onclick="syncEnableClicked()">Turn on sync</button>
      `}
    </div>
    <button class="btn btn-ghost" onclick="if(confirm('Forget the passphrase on this device? You will need to type it again next time.')){DataLock.forget()}">🔒 Forget passphrase on this device</button>
    <button class="btn btn-ghost danger" onclick="if(confirm('Reset ALL progress? This cannot be undone.')){Engine.resetAll();renderHome()}">Reset all progress</button>
  `;
}

// ---------------------------------------------------------------- BOOT
function bootApp() {
  Engine.load();
  Sync.load();
  renderHome();
  if (Sync.enabled()) {
    // Pull the other device's progress; refresh the screen only if we're
    // still sitting on Home when it lands (never yank a live session away).
    Sync.syncNow(() => {
      if (document.querySelector('#app button[onclick="renderProgress()"]')) renderHome();
    });
  }
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
