"""Generate studio-quality narration for the answer bank.

Reads js/data.js, creates one MP3 per spoken item (questions, answer chunks,
evidence lines, probes, mnemonics) using Microsoft's neural voices via
edge-tts, then encrypts every clip with AES-256-GCM (same passphrase scheme
as data.enc.json). Output: audio/<key>.enc files + audio/manifest.json.

Usage:  python tools/build_audio.py "your passphrase here"
Re-run whenever js/data.js changes (only regenerates changed/missing clips
unless --force is given).
"""
import asyncio
import base64
import hashlib
import json
import os
import re
import sys

import edge_tts
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

from encrypt_data import js_to_payload

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(ROOT, "audio")
VOICE = "en-GB-SoniaNeural"
ITERATIONS = 200_000
CONCURRENCY = 4


def sentence_chunks(beats):
    """Sentence-sized chunks — MUST mirror chunkify() in js/app.js."""
    out = []
    for b in beats:
        for s in re.split(r"(?<=[.!?])\s+", b):
            s = s.strip()
            if s:
                out.append(s)
    return out


def build_clip_list(bank):
    """Map clip-key -> text to speak."""
    clips = {
        "g-whichksb": "Which K S B is this?",
        "g-whereev": "Where do you evidence that?",
        "g-clean": "Clean recall!",
        "g-notclean": "Not clean yet. It will come back soon.",
        "g-speed": "This is my speaking speed.",
    }
    # Every possible session/drill score line, so results aren't robotic.
    for n in range(1, 11):
        for c in range(0, n + 1):
            clips[f"g-sess-{c}-{n}"] = f"Session done. {c} out of {n} clean recalls."
    for n in range(1, 19):
        for r in range(0, n + 1):
            clips[f"g-drill-{r}-{n}"] = f"{r} out of {n} evidence locations nailed."
    for e in bank:
        i = e["id"]
        clips[f"e{i}-intro"] = f"{e['ksb']}. {e['topic']}. Memory hook: {e['mnemonic']}"
        for b, beat in enumerate(e["beats"]):
            clips[f"e{i}-beat{b}"] = beat
        for k, s in enumerate(sentence_chunks(e["beats"])):
            clips[f"e{i}-c{k}"] = s
        for q, question in enumerate(e["questions"]):
            clips[f"e{i}-q{q}"] = question
        clips[f"e{i}-sayfirst"] = e["sayFirst"]
        clips[f"e{i}-probe"] = "If probed, add: " + e["probe"]
        clips[f"e{i}-drill"] = f"Where do you evidence {e['ksb']}, {e['topic']}?"
    return clips


async def synth_all(clips, todo):
    sem = asyncio.Semaphore(CONCURRENCY)
    results = {}

    async def one(key, text):
        async with sem:
            for attempt in range(3):
                try:
                    buf = b""
                    async for chunk in edge_tts.Communicate(text, VOICE).stream():
                        if chunk["type"] == "audio":
                            buf += chunk["data"]
                    if buf:
                        results[key] = buf
                        return
                except Exception as ex:
                    if attempt == 2:
                        print(f"  FAILED {key}: {ex}")
                    await asyncio.sleep(2 * (attempt + 1))

    await asyncio.gather(*(one(k, clips[k]) for k in todo))
    return results


def main():
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        sys.exit('Usage: python tools/build_audio.py "passphrase" [--force]')
    passphrase = sys.argv[1].strip()
    force = "--force" in sys.argv

    payload = js_to_payload(os.path.join(ROOT, "js", "data.js"))
    clips = build_clip_list(payload["bank"])
    os.makedirs(AUDIO_DIR, exist_ok=True)

    # Track text hashes so unchanged clips aren't regenerated.
    hash_path = os.path.join(AUDIO_DIR, ".hashes.json")
    old_hashes = {}
    if os.path.exists(hash_path) and not force:
        old_hashes = json.load(open(hash_path, encoding="utf-8"))
    new_hashes = {k: hashlib.sha256((VOICE + t).encode()).hexdigest()[:16]
                  for k, t in clips.items()}
    todo = [k for k in clips
            if old_hashes.get(k) != new_hashes[k]
            or not os.path.exists(os.path.join(AUDIO_DIR, f"{k}.enc"))]
    print(f"{len(clips)} clips total, generating {len(todo)}")

    # Reuse the previous salt when possible so unchanged clips keep their
    # existing .enc files — phones then only re-download what actually changed.
    manifest_path = os.path.join(AUDIO_DIR, "manifest.json")
    salt = None
    salt_reused = False
    if os.path.exists(manifest_path) and not force:
        try:
            old_m = json.load(open(manifest_path, encoding="utf-8"))
            if old_m.get("iterations") == ITERATIONS:
                salt = base64.b64decode(old_m["salt"])
                salt_reused = True
        except Exception:
            pass
    if salt is None:
        salt = os.urandom(16)
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt,
                     iterations=ITERATIONS)
    key = kdf.derive(passphrase.encode("utf-8"))
    aes = AESGCM(key)

    raw_dir = os.path.join(AUDIO_DIR, ".raw")
    os.makedirs(raw_dir, exist_ok=True)
    missing_raw = [k for k in clips
                   if k in todo or not os.path.exists(os.path.join(raw_dir, f"{k}.mp3"))]

    if missing_raw:
        results = asyncio.run(synth_all(clips, missing_raw))
        for k, buf in results.items():
            with open(os.path.join(raw_dir, f"{k}.mp3"), "wb") as f:
                f.write(buf)
        print(f"Synthesised {len(results)} clips")

    ok = []
    encrypted = 0
    for k in clips:
        raw_path = os.path.join(raw_dir, f"{k}.mp3")
        enc_path = os.path.join(AUDIO_DIR, f"{k}.enc")
        if not os.path.exists(raw_path):
            print(f"  MISSING {k} — will fall back to device voice")
            continue
        # Skip re-encryption when the salt is unchanged, the clip text is
        # unchanged and the .enc already exists.
        if (salt_reused and k not in todo and os.path.exists(enc_path)
                and old_hashes.get(k) == new_hashes[k]):
            ok.append(k)
            continue
        data = open(raw_path, "rb").read()
        iv = os.urandom(12)
        enc = iv + aes.encrypt(iv, data, None)
        with open(enc_path, "wb") as f:
            f.write(enc)
        encrypted += 1
        ok.append(k)

    manifest = {
        "iterations": ITERATIONS,
        "salt": base64.b64encode(salt).decode(),
        "voice": VOICE,
        "clips": sorted(ok),
    }
    with open(os.path.join(AUDIO_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f)
    with open(hash_path, "w", encoding="utf-8") as f:
        json.dump(new_hashes, f)
    print(f"{len(ok)} clips in manifest, {encrypted} newly encrypted -> audio/")


if __name__ == "__main__":
    main()
