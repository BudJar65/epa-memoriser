# Verify: drive the EPA memoriser in a headless browser

No Node.js on this machine. Use Python + Playwright driving the installed
Edge browser (`channel="msedge"` — no browser download needed).

## Setup (once per session)

```powershell
python -m pip install --quiet --target <scratchpad>\pylibs playwright greenlet
# serve the app:
Start-Process python -ArgumentList "-m","http.server","8484" -WorkingDirectory "D:\Projects\EPAResitMemoryApp" -WindowStyle Hidden
```

In the script: `sys.path.insert(0, r"<scratchpad>\pylibs")` before importing
playwright. Quick syntax check for all JS: pip-install `quickjs` and
`Context().eval("(function(){\n" + src + "\n})")` — parse errors throw.

## Driving the app

- Unlock screen first: fill `#pass-input` with the passphrase (see memory /
  ask Jason), click `#pass-go`. `data.enc.json` is committed so this works
  from a plain checkout.
- Fresh profile → home CTA is `button:has-text('Learn next')` (answer #1).
- Mic paths, both reachable:
  - **Mic works**: launch with `--use-fake-device-for-media-stream
    --use-fake-ui-for-media-stream` and `context.grant_permissions(["microphone"])`
    → speech recognition engages (`onaudiostart` fires), echo screens stay up.
    You cannot inject speech, so "I've said it" always yields the empty-capture
    screen; you cannot pass a chunk this way.
  - **Mic blocked** (no flags, no permission) → app falls back to the
    hiddenself/self-grade path after the watchdog gives up (~5–8s). This is
    the only way to walk chunks through to the whole-answer stage:
    loop `Reveal to check` → `Got it`.
- Viewport 390×844 approximates Jason's iPhone.
- Capture `pageerror` + console errors. Expect one harmless 404: browsers
  auto-request `/favicon.ico`, which doesn't exist.
- Windows console is cp1252 — `.encode("ascii","replace")` before printing
  page text (data contains ▶, arrows, curly quotes).
- Playwright gotcha: don't mix `text=` and CSS selectors in one
  comma-separated wait; poll with `query_selector` instead.
- Kill the http.server process when done.

## What can't be verified here

Real speech scoring, iOS mic wedging/ducking, TTS/narration audibility —
Jason confirms those on his iPhone (home screen shows APP_VERSION; bump it
plus sw.js CACHE every release so he can tell).
