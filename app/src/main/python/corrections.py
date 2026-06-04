"""
Post-Whisper text korekcije.

Tri sloja:
  1. BUILTIN_CORRECTIONS — fiksne korekcije (regex-based, ručno definisane)
  2. LEARNED_CORRECTIONS  — auto-naučene iz korisničkih ispravki (3+ ponavljanja)
  3. CORRECTION_LOG       — historija "original → edited" parova za auto-učenje

Sve se primjenjuje u /api/transcribe nakon Whisper transkripta, prije vraćanja klijentu.
"""
import json
import re
import sys
from pathlib import Path
from collections import Counter
from typing import Tuple

try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, Exception):
    pass

# Na Androidu je folder Python izvora read-only — upisive JSON fajlove (learned/log)
# držimo u DIKTAFON_DATA_DIR (postavlja ga Kotlin na app filesDir). Fallback na __file__
# folder zadržava ponašanje na desktopu.
import os as _os
_DATA_DIR = _os.environ.get("DIKTAFON_DATA_DIR", "").strip()
BASE_DIR = Path(_DATA_DIR) if _DATA_DIR else Path(__file__).parent
BASE_DIR.mkdir(parents=True, exist_ok=True)
LEARNED_PATH = BASE_DIR / "learned_corrections.json"
LOG_PATH = BASE_DIR / "correction_log.json"

# Prag — koliko puta korisnik mora ispraviti isti par da se automatski "nauči"
LEARN_THRESHOLD = 3

# === SLOJ 1: Built-in korekcije ===
# Ključ je regex pattern (case-insensitive), vrijednost je zamjena.
# Word boundary (\b) na početku da ne mijenjamo dijelove riječi.
# Sufiksi se obrađuju zajedno gdje je moguće (npr. bjeličast + i/a/o/e/im/...).
BUILTIN_CORRECTIONS = {
    # Bjeličast (palatal "bj" Whisper često ispusti → "b")
    r"\bbiličast": "bjeličast",
    r"\bbe ličast": "bjeličast",
    r"\bbi ličast": "bjeličast",
    r"\bbiljičast": "bjeličast",

    # Sasušina / sasušen — Whisper razdvaja "su sušina"
    r"\bsu sušin": "sasušin",
    r"\bsu sušen": "sasušen",

    # Somotast (Whisper čuje "som otast" ili "samotast")
    r"\bsom otast": "somotast",
    r"\bsamotast": "somotast",
    r"\bsom otasta": "somotasta",

    # Sukrvičav — često "su krvičav" ili "sukrvičan"
    r"\bsu krvičav": "sukrvičav",
    r"\bsu krviča": "sukrviča",

    # Modrikast — često "modri kast"
    r"\bmodri kast": "modrikast",

    # Smeđkast — često "smeđ kast"
    r"\bsmeđ kast": "smeđkast",

    # Žućkast — često "žuć kast"
    r"\bžuć kast": "žućkast",

    # Mnogokrvan / malokrvan / srednjekrvan razdvajanja
    r"\bmnogo krvan": "mnogokrvan",
    r"\bmalo krvan": "malokrvan",
    r"\bsrednje krvan": "srednjekrvan",
    r"\bsrednjo krvan": "srednjekrvan",

    # Bjeloočnica
    r"\bbe loočnic": "bjeloočnic",
    r"\bbiloočnic": "bjeloočnic",

    # Ožiljak (Whisper često čuje "ožilj ak" ili "obiljeg")
    r"\bobiljeg": "ožiljk",
    r"\bobiljek": "ožiljak",

    # Poplućnica / porebrica (rijetki termini)
    r"\bpoplić nica": "poplućnica",
    r"\bpore brica": "porebrica",
    r"\bporeb rica": "porebrica",

    # Potrbušnica
    r"\bpotr bušnic": "potrbušnic",
    r"\bpotrbušni ca": "potrbušnica",

    # Moždanica / moždani slivovi
    r"\bmosdanic": "moždanic",
    r"\bmoždanič": "moždanič",  # noop ali za potvrdu
    r"\bmosdani slivo": "moždani slivo",

    # Gušterača
    r"\bgušter ača": "gušterača",

    # Nadbubreg
    r"\bnad bubrez": "nadbubrez",
    r"\bnad bubreg": "nadbubreg",

    # Štitnjača
    r"\bštit njača": "štitnjača",

    # Limfni čvorići
    r"\blimfni čvor": "limfni čvor",
    r"\blim fni čvor": "limfni čvor",

    # Sjedefasta / sedefasta
    r"\bsjede fast": "sedefast",
    r"\bsje defast": "sedefast",

    # Kruškolik
    r"\bkruško lik": "kruškolik",

    # Numerička formatiranja koja Whisper ponekad propušta (cm, ml, mm)
    # Ovo radi i Claude pri merge-u, pa ne forsiramo ovdje

    # Standardne fraze
    r"\bjasne građe i crteža": "jasne građe i crteža",  # noop za potvrdu
    r"\bglatke sjajne": "glatke, sjajne",
    r"\botvr da moždanica": "tvrda moždanica",
    r"\bmrtva čka": "mrtvačka",
}


def _load_json(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[corrections] Greška učitavanja {path.name}: {e}")
        return {}


def _save_json(path: Path, data: dict):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_learned_corrections() -> dict:
    """Vraća dict {pattern: replacement} naučenih korekcija."""
    return _load_json(LEARNED_PATH)


def save_learned_correction(pattern: str, replacement: str):
    """Doda novu naučenu korekciju u trajni fajl."""
    learned = load_learned_corrections()
    learned[pattern] = replacement
    _save_json(LEARNED_PATH, learned)


def remove_learned_correction(pattern: str):
    """Ukloni naučenu korekciju iz fajla."""
    learned = load_learned_corrections()
    if pattern in learned:
        del learned[pattern]
        _save_json(LEARNED_PATH, learned)


def apply_corrections(text: str) -> str:
    """Primijeni sve korekcije (builtin + learned) na transkript."""
    if not text:
        return text
    learned = load_learned_corrections()
    # Builtin prvo, onda learned (learned može override builtin)
    for pattern, replacement in {**BUILTIN_CORRECTIONS, **learned}.items():
        try:
            text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
        except re.error as e:
            print(f"[corrections] Loš regex {pattern!r}: {e}")
    return text


def diff_words(original: str, edited: str) -> list[Tuple[str, str]]:
    """Pronađi 'word-level' razlike između original i edited transkripta.
    Vraća listu (before, after) parova koji su različiti.

    Heuristika: tokenizuj na riječi, poravnaj sa istom dužinom (best-effort).
    Vraća samo razlike koje izgledaju kao tipfeleri (slična dužina, slični slovari)."""
    if not original or not edited or original.strip() == edited.strip():
        return []

    # Tokenizacija — riječi + interpunkcija
    def tokenize(s):
        return re.findall(r"\b[\wÀ-ſ]+\b", s.lower())

    orig_words = tokenize(original)
    edit_words = tokenize(edited)

    # Ako su dužine veoma različite, ne pokušavamo da deducujemo — vrijedi ručno provjeriti
    if abs(len(orig_words) - len(edit_words)) > max(2, len(orig_words) // 3):
        return []

    # Jednostavno poravnanje: prođi obje liste paralelno, pronađi razlike
    diffs = []
    i = j = 0
    while i < len(orig_words) and j < len(edit_words):
        if orig_words[i] == edit_words[j]:
            i += 1
            j += 1
        else:
            # Pokušaj 1: 1-to-1 zamjena (najčešća greška)
            if i + 1 < len(orig_words) and j + 1 < len(edit_words):
                if orig_words[i + 1] == edit_words[j + 1]:
                    diffs.append((orig_words[i], edit_words[j]))
                    i += 1
                    j += 1
                    continue
            # Pokušaj 2: dvije orig → jedna edit (Whisper razdvaja, korisnik spaja)
            if i + 1 < len(orig_words):
                combined = orig_words[i] + " " + orig_words[i + 1]
                if combined.replace(" ", "") == edit_words[j]:
                    diffs.append((combined, edit_words[j]))
                    i += 2
                    j += 1
                    continue
            # Pokušaj 3: skip jednu (umetnuto/izbačeno)
            if i + 1 < len(orig_words) and orig_words[i + 1] == edit_words[j]:
                i += 1
                continue
            if j + 1 < len(edit_words) and orig_words[i] == edit_words[j + 1]:
                j += 1
                continue
            # Inače 1-to-1 zamjena
            diffs.append((orig_words[i], edit_words[j]))
            i += 1
            j += 1
    return diffs


def log_correction(original: str, edited: str) -> list[dict]:
    """Loguj razlike između original i edited transkripta.
    Vraća listu novonaučenih korekcija (ako je par sad dostigao prag)."""
    if not original or not edited:
        return []
    if original.strip() == edited.strip():
        return []

    diffs = diff_words(original, edited)
    if not diffs:
        return []

    log = _load_json(LOG_PATH) or {}
    # Struktura: { "before|after": {"count": N, "examples": [...] } }
    newly_learned = []

    for before, after in diffs:
        # Filtriraj očigledne ne-greške
        if before == after:
            continue
        if len(before) < 3 or len(after) < 2:
            continue
        # Preskoči ako je razlika prevelika (vjerovatno nije tipfeler)
        if abs(len(before) - len(after)) > max(3, len(before) // 2):
            continue

        key = f"{before}|{after}"
        entry = log.get(key, {"count": 0, "examples": []})
        entry["count"] += 1
        if len(entry["examples"]) < 3:
            entry["examples"].append({"orig": original[:100], "edit": edited[:100]})
        log[key] = entry

        # Ako je dosegao prag, automatski uči
        if entry["count"] >= LEARN_THRESHOLD:
            learned = load_learned_corrections()
            pattern = r"\b" + re.escape(before)
            if pattern not in learned:
                save_learned_correction(pattern, after)
                newly_learned.append({
                    "before": before,
                    "after": after,
                    "count": entry["count"],
                })
                # Resetuj counter da ne učimo ponovo
                entry["count"] = 0

    _save_json(LOG_PATH, log)
    return newly_learned


def list_all_corrections() -> dict:
    """Vraća sve korekcije (builtin + learned + log statistika) za UI prikaz."""
    return {
        "builtin": dict(BUILTIN_CORRECTIONS),
        "learned": load_learned_corrections(),
        "log_summary": _load_json(LOG_PATH),
        "learn_threshold": LEARN_THRESHOLD,
    }
