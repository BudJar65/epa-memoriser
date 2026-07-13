"""Encrypt the answer bank for publishing.

Reads js/data.js (the readable answers — kept OUT of git), converts it to JSON,
encrypts it with AES-256-GCM using a key derived from a passphrase (PBKDF2,
200,000 iterations), and writes data.enc.json — the only data file that gets
committed and published.

Usage:  python tools/encrypt_data.py "your passphrase here"
Run it again any time js/data.js changes.
"""
import base64
import json
import os
import re
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ITERATIONS = 200_000


def js_to_payload(path):
    """Extract ANSWER_BANK and ANSWER_STRUCTURE from data.js as Python objects."""
    src = open(path, encoding="utf-8").read()

    def extract(name, open_ch, close_ch):
        start = src.index(f"const {name} = {open_ch}")
        i = src.index(open_ch, start)
        depth = 0
        in_str = None
        j = i
        while j < len(src):
            c = src[j]
            if in_str:
                if c == "\\":
                    j += 2
                    continue
                if c == in_str:
                    in_str = None
            elif c in "\"'`":
                in_str = c
            elif c == open_ch:
                depth += 1
            elif c == close_ch:
                depth -= 1
                if depth == 0:
                    return src[i:j + 1]
            j += 1
        raise ValueError(f"Could not find end of {name}")

    def jsonify(js_literal):
        # Quote bare keys ({ id: 1 } -> { "id": 1 }) and strip comments.
        out = re.sub(r"//[^\n\"“”]*\n", "\n", js_literal)
        out = re.sub(r"([{\[,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', out)
        return json.loads(out)

    bank = jsonify(extract("ANSWER_BANK", "[", "]"))
    structure = jsonify(extract("ANSWER_STRUCTURE", "[", "]"))
    return {"bank": bank, "structure": structure}


def main():
    if len(sys.argv) < 2 or not sys.argv[1].strip():
        sys.exit('Usage: python tools/encrypt_data.py "passphrase"')
    passphrase = sys.argv[1].strip()

    payload = js_to_payload(os.path.join(ROOT, "js", "data.js"))
    print(f"Parsed {len(payload['bank'])} answers from js/data.js")

    salt = os.urandom(16)
    iv = os.urandom(12)
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt,
                     iterations=ITERATIONS)
    key = kdf.derive(passphrase.encode("utf-8"))
    plaintext = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    ciphertext = AESGCM(key).encrypt(iv, plaintext, None)

    enc = {
        "iterations": ITERATIONS,
        "salt": base64.b64encode(salt).decode(),
        "iv": base64.b64encode(iv).decode(),
        "data": base64.b64encode(ciphertext).decode(),
    }
    out = os.path.join(ROOT, "data.enc.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(enc, f)
    print(f"Wrote {out} ({len(ciphertext)} bytes encrypted)")


if __name__ == "__main__":
    main()
