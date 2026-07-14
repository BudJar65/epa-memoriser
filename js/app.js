// EPA Answer Memoriser — UI and flows.
// Screens: home, learn, quiz, drill (evidence), walk, browse, detail, progress, settings.

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
      <p class="sub">18 answers &middot; Level 4 BA resit</p>
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
// Guided flow: intro -> beats (build up) -> first-letter cue -> done.
let learn = null;

function startLearn(id) {
  const entry = ANSWER_BANK.find(e => e.id === id);
  learn = { entry, step: 0 }; // step 0 = intro, 1..beats = build, last = cue
  renderLearn();
}

function renderLearn() {
  const { entry, step } = learn;
  const nBeats = entry.beats.length;
  const totalSteps = nBeats + 2; // intro + beats + cue

  let body, controls;
  if (step === 0) {
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
    controls = `<button class="btn btn-primary btn-big" onclick="learnNext()">Start learning the answer</button>`;
    Voice.speak(`${entry.ksb}. ${entry.topic}. Memory hook: ${entry.mnemonic}`);
  } else if (step <= nBeats) {
    // Cumulative beats: show all beats up to `step`, newest highlighted.
    const shown = entry.beats.slice(0, step);
    body = `
      <p class="step-label">Chunk ${step} of ${nBeats} — read it, say it out loud, then continue.</p>
      ${shown.map((b, i) => `<div class="card beat ${i === step - 1 ? "beat-new" : "beat-old"}">${esc(b)}</div>`).join("")}
    `;
    controls = `
      <button class="btn" onclick="Voice.speak(learn.entry.beats[${step - 1}])">🔊 Read chunk aloud</button>
      <button class="btn btn-primary btn-big" onclick="learnNext()">${step === nBeats ? "Now try with hints only" : "Got it — next chunk"}</button>`;
    Voice.speak(entry.beats[step - 1]);
  } else {
    // First-letter cue stage
    const full = entry.beats.join(" ");
    body = `
      <p class="step-label">Say the whole answer out loud using only these first-letter hints:</p>
      <div class="card cue">${esc(firstLetterCue(full))}</div>
      <details class="peek"><summary>Peek at the full answer</summary><p>${esc(full)}</p></details>
      <div class="card hook"><b>🪝</b> ${esc(entry.mnemonic)}</div>`;
    controls = `
      <button class="btn" onclick="Voice.speak(learn.entry.beats.join(' '))">🔊 Hear it once more</button>
      <button class="btn btn-primary btn-big" onclick="finishLearn()">Done — quiz me on it</button>`;
  }

  app().innerHTML = `
    <header class="top slim">
      <button class="btn-back" onclick="renderHome()">‹ Home</button>
      <span>Learn #${entry.id} &middot; step ${step + 1}/${totalSteps}</span>
    </header>
    ${body}
    <div class="controls">${controls}</div>
  `;
}

function learnNext() { learn.step += 1; renderLearn(); }

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
  const entry = quizEntry();
  const s = Engine.entry(entry.id);
  const mode = Engine.settings.quizMode;
  const q = quiz.question || (quiz.question = entry.questions[Math.floor(Math.random() * entry.questions.length)]);
  let body = "", controls = "";

  if (quiz.phase === "question") {
    body = `
      <div class="card question-card">
        <p class="q-label">Assessor asks:</p>
        <p class="q-text">${esc(q)}</p>
      </div>
      <p class="hint">Answer out loud in 30–45 seconds. Remember: evidence location first.</p>`;
    if (mode === "listen" && Voice.sttSupported()) {
      controls = `
        <button class="btn" onclick="Voice.speak(quiz.question)">🔊 Repeat question</button>
        <button class="btn btn-primary btn-big" onclick="quizListen()">🎤 I'm answering — listen</button>
        <button class="btn btn-ghost" onclick="quizReveal()">Skip mic — self-grade instead</button>`;
    } else {
      controls = `
        <button class="btn" onclick="Voice.speak(quiz.question)">🔊 Repeat question</button>
        <button class="btn btn-primary btn-big" onclick="quizReveal()">I've answered — show me the answer</button>`;
    }
    Voice.speak(q);
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
      <button class="btn" onclick="Voice.speak(quizEntry().beats.join(' '))">🔊 Read answer</button>
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
    if (quiz.walk) Voice.speak("Which K S B is this?");
  }

  else if (quiz.phase === "evidence") {
    if (!quiz.evOptions) {
      const others = shuffle(ANSWER_BANK.filter(e => e.id !== entry.id)).slice(0, 2).map(e => e.sayFirst);
      quiz.evOptions = shuffle([entry.sayFirst, ...others]);
    }
    body = `
      <div class="card question-card"><p class="q-label">Assessor: “Where do you evidence that?”</p></div>
      <div class="mc">${quiz.evOptions.map((o, i) =>
        `<button class="btn mc-opt mc-long" onclick="quizPickEv(${i})">${esc(o)}</button>`).join("")}</div>`;
    controls = "";
    if (quiz.walk) Voice.speak("Where do you evidence that?");
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
    controls = `<button class="btn btn-primary btn-big" onclick="quizNext()">${more ? "Next answer →" : "Finish session"}</button>`;
    if (quiz.walk) {
      Voice.speak(
        (r.clean ? "Clean recall. " : "Not clean yet. ") + "If probed, add: " + entry.probe,
        Engine.settings.autoAdvance ? () => setTimeout(() => { if (quiz && quiz.phase === "result") quizNext(); }, 1500) : null
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

function quizPickEv(i) {
  quiz.evOk = quiz.evOptions[i] === quizEntry().sayFirst;
  const entry = quizEntry();
  const { clean } = Engine.recordResult(entry.id, quiz.scoreInfo.score, quiz.ksbOk, quiz.evOk);
  quiz.results.push({ id: entry.id, score: quiz.scoreInfo.score, ksbOk: quiz.ksbOk, evOk: quiz.evOk, clean });
  quiz.phase = "result";
  renderQuiz();
}

function quizNext() {
  if (quiz.idx < quiz.queue.length - 1) {
    quiz.idx += 1;
    quiz.phase = "question";
    quiz.question = null;
    quiz.ksbOptions = null;
    quiz.evOptions = null;
    quiz.transcript = "";
    quiz.scoreInfo = null;
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
    Voice.speak(`Session done. ${clean} out of ${n} clean recalls.`);
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
    Voice.speak(`Where do you evidence ${entry.ksb}, ${entry.topic}?`);
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
    Voice.speak(entry.sayFirst);
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
    Voice.speak(msg);
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
      <button class="btn" onclick="Voice.speak(ANSWER_BANK.find(x=>x.id===${e.id}).beats.join(' '))">🔊 Read answer aloud</button>
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
      <label class="setting"><span>Speech speed</span>
        <input type="range" min="0.7" max="1.4" step="0.1" value="${st.rate}"
          onchange="Engine.settings.rate=parseFloat(this.value);Engine.saveSettings();Voice.speak('This is my speaking speed.')"></label>
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
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // Decrypt the answer bank: automatically if this device knows the
  // passphrase, otherwise show the unlock screen.
  const unlocked = await DataLock.tryAutoUnlock().catch(() => false);
  if (unlocked) bootApp();
  else DataLock.renderUnlock(bootApp);
});
