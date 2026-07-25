# Verify: drive the EPA memoriser in a headless browser

No Node.js on this machine. Use Python + Playwright driving the installed
Edge browser (`channel="msedge"` — no browser download needed).

## Setup (once per session)

```powershell
python -m pip install --quiet --target <scratchpad>\pylibs playwright greenlet quickjs
# serve the app:
Start-Process python -ArgumentList "-m","http.server","8484" -WorkingDirectory "D:\Projects\EPAResitMemoryApp" -WindowStyle Hidden
```

In the script: `sys.path.insert(0, r"<scratchpad>\pylibs")` before importing
playwright. Syntax-check all JS first — it's instant and catches most breakage:
`quickjs.Context().eval("(function(){\n" + src + "\n})")` throws on parse errors.
Run it over `js/*.js` **and** `sw.js`.

## Driving the app

- **Unlock screen first**: fill `#pass-input` with the passphrase (see memory /
  ask Jason), click `#pass-go`. `data.enc.json` is committed so this works from
  a plain checkout.
  Gotcha: don't wait on `text=EPA Answer Memoriser` — that heading is on the
  unlock screen too, so the wait passes instantly and you test the wrong screen.
  Wait for something only Home has: `#app button[onclick="renderProgress()"]`.
  Allow up to 30s — decryption is deliberately slow (PBKDF2, 200k iterations).
- Fresh profile → home CTA is `button:has-text('Learn next')` (answer #1).
- **There is no microphone as of v27** — every recall step is a tap, so a full
  session can be driven end to end. No media flags or permissions needed; if
  the app ever asks for mic access, that's a bug.
- Learn: `Practise the openings` → loop (`Reveal the opening` → `Got it`) →
  chunks loop (`Hide it` → `Reveal to check` → `Got it`) → whole answer
  (`show me the answer` → `Got it`) → drops straight into the quiz.
- Quiz: `show me the answer` → self-grade (`Got it`) → KSB (click a `.mc-opt`)
  → `Reveal the evidence line` → `Got it` → result screen.
- Viewport 390×844 approximates Jason's iPhone.
- Capture `pageerror` and console errors. **Expect exactly two harmless 404s**
  for `/favicon.ico`, which doesn't exist. A page-level `response` listener
  won't see them — check the http.server log if you need to confirm what a 404
  actually was (`-RedirectStandardError` to a file when starting the server).
- Windows console is cp1252 — `.encode("ascii","replace")` before printing page
  text (data contains ▶, arrows, curly quotes).
- Playwright gotcha: don't mix `text=` and CSS selectors in one comma-separated
  wait; poll with `query_selector` instead.
- Kill the http.server process when done (`Get-Process python | Stop-Process`).

## Useful assertions

- No mic left anywhere: page text contains none of "Listening", "mic",
  "microphone", "transcript"; and
  `[typeof Voice.startListening, typeof window.armMicStatus, typeof window.echoScore]`
  is all `"undefined"`. (`Voice.stopListening` etc. survive on purpose as
  no-op stubs, so don't assert on those.)
- Home screen shows the current `APP_VERSION`.

## What can't be verified here

TTS/narration audibility, and how the flow feels one-handed on a dog walk.
Jason confirms those on his iPhone — the home screen shows APP_VERSION, so
bump it plus the sw.js CACHE version every release and he can tell what he's
running.
