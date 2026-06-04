"""
Android API — DIREKTAN most (bez servera, bez socketa, bez HTTP-a).

Kotlin (preko Chaquopy) zove `dispatch(endpoint, payload_json)` i dobije JSON string
nazad. Sva logika je ista kao desktop verzija (docx_generator, sections, corrections),
samo bez FastAPI/uvicorn/pydantic — pozivi na Claude/Groq idu preko stdlib urllib
(api_clients). Jedina ne-stdlib zavisnost je python-docx (+lxml), koju Chaquopy ima
prebuilt.

Konfiguracija dolazi iz environmenta (postavlja ga MainActivity prije import-a):
  DIKTAFON_APP_DIR   — folder sa template/ i examples.json (kopirano iz assets)
  DIKTAFON_DATA_DIR  — upisivi folder: drafts/, output/, learned/log json
  ANTHROPIC_API_KEY, GROQ_API_KEY
"""
import os
import re
import json
import base64
from pathlib import Path

from sections import HEADER_FIELDS, DICTATION_SECTIONS, sections_with_template
from docx_generator import generate_report
from corrections import (
    apply_corrections, log_correction, list_all_corrections,
    save_learned_correction, remove_learned_correction,
)
import api_clients
from api_clients import ApiError


# === Konfiguracija ===
APP_DIR = Path(os.environ.get("DIKTAFON_APP_DIR", ".")).resolve()
DATA_DIR = Path(os.environ.get("DIKTAFON_DATA_DIR", "./data")).resolve()
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "").strip()

TEMPLATE_PATH = APP_DIR / "template" / "Zapisnik opste Obdukcija.docx"
EXAMPLES_PATH = APP_DIR / "examples.json"
OUTPUT_DIR = DATA_DIR / "output"
DRAFTS_DIR = DATA_DIR / "drafts"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
DRAFTS_DIR.mkdir(parents=True, exist_ok=True)

CLAUDE_MODEL = "claude-sonnet-4-5-20250929"

# === Few-shot primjeri ===
EXAMPLES_BY_SECTION: dict = {}
if EXAMPLES_PATH.exists():
    try:
        _ex = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))
        EXAMPLES_BY_SECTION = _ex.get("by_section", {})
    except Exception as e:
        print(f"[android_api] Greška examples.json: {e}")


def build_whisper_bias_prompt() -> str:
    return (
        "Sudsko-medicinski obdukcioni zapisnik. Termini: poglavina, lobanja, moždanica, "
        "tvrda moždanica bjeličasto sedefasta, srednjekrvna, malokrvna, mnogokrvna, "
        "porebrica, poplućnica, potrbušnica, osrčje, usrčnica, ždrijelo, jednjak, "
        "gušterača, nadbubrezi, bubrežna korita, mokraćovod, štitnjača, limfni čvorići, "
        "oguljotina, razderotina, nagnječina, krvni podljev, mrtvačke mrlje, ožiljak, "
        "sasušina kože, somotasta sluznica, sukrvičav sadržaj, modrikast, smeđkast, "
        "žućkast, bjeloočnice, sedefasta, kruškolik, jasne građe i crteža, "
        "glatke sjajne, prebojen žučnim bojama."
    )


WHISPER_BIAS_PROMPT = build_whisper_bias_prompt()


def select_examples(section_id: str, count: int = 4) -> list:
    pool = EXAMPLES_BY_SECTION.get(section_id, [])
    if not pool:
        return []
    if len(pool) <= count:
        return list(pool)
    sorted_pool = sorted(
        pool, key=lambda e: (len(e["text"]), e.get("case_initials", ""), e.get("year", ""))
    )
    n = len(sorted_pool)
    indices = [int(i * (n - 1) / max(1, count - 1)) for i in range(count)]
    seen, result = set(), []
    for idx in indices:
        if idx in seen:
            continue
        seen.add(idx)
        result.append(sorted_pool[idx])
    return result[:count]


# === Prompt tekstovi (verbatim iz desktop verzije) ===

CLEANUP_SYSTEM = (
    "Ti si asistent sudskom vještaku medicinske struke u Bosni i Hercegovini. "
    "Sređuješ sirovi diktirani tekst za obdukcioni zapisnik. NE mijenjaš značenje.\n"
    "1. Pretvori brojeve riječima u cifre sa jedinicama: '12 × 7 cm', '150 ml', 'oko 30'.\n"
    "2. Ispravi padeže i interpunkciju.\n"
    "3. Ispravi medicinske termine ako su iskrivljeni.\n"
    "4. NE dodaješ informacije. NE proširuješ opise.\n"
    "5. Vrati SAMO sređeni tekst, bez objašnjenja, bez navodnika."
)

MERGE_SYSTEM_MULTI = (
    "Ti si asistent sudskom vještaku medicinske struke u BiH (prof. dr. Adis Salihbegović). "
    "Diktirana je lista (povrede, prelomi, ili tačke mišljenja). "
    "Sredi tekst i podijeli u zasebne paragrafe (svaka stavka = nova linija).\n"
    "1. Pretvori brojeve riječima u cifre: '12 × 7 cm', '150 ml'.\n"
    "2. Ispravi padeže, interpunkciju, medicinske termine.\n"
    "3. Svaku stavku u novi red (jedan paragraf po stavci).\n"
    "4. KRITIČNO: NE izmišljaj DETALJE koje doktor nije diktirao:\n"
    "   - Ako nije rekao stranu (lijevo/desno, gornji/donji), NE dodavaj je\n"
    "   - Ako nije rekao boju, NE dodavaj 'tamno crvene boje' — koristi samo ako je rekao\n"
    "   - Ako nije rekao oblik (ovalan, izdužen), NE dodavaj\n"
    "   - SAMO standardne fraze (\"ogoljene kožice\", \"krvlju podlivene\") možeš dodati JEDNOM\n"
    "     ako su uobičajene za taj tip povrede u primjerima\n"
    "5. Stil — OPONAŠAJ primjere u redoslijedu opisa: tip povrede → lokacija → mjere → kvalitet ivica.\n"
    "6. Vrati SAMO sređeni tekst, bez objašnjenja, bez navodnika, bez '1.', '2.' "
    "(numeracija se dodaje automatski ako treba)."
)

MERGE_SYSTEM_SINGLE = (
    "Ti si asistent sudskom vještaku medicinske struke u BiH (prof. dr. Adis Salihbegović). "
    "Sastavljaš obdukcioni zapisnik tako što kratke diktirane fraze ubaciš u template paragraf, "
    "PRATEĆI stil pisanja iz primjera vlastitih ranijih obdukcija.\n\n"
    "🚨 NAJVAŽNIJE PRAVILO — DIKTACIJA IMA APSOLUTNI PRIORITET:\n"
    "Ako diktacija KONTRADIKTIRA bilo kojem dijelu template-a, taj dio template-a "
    "MORAŠ IZMIJENITI ili UKLONITI — NIKADA ne smiješ ostaviti kontradiktorne tvrdnje.\n\n"
    "PRIMJERI LOŠEG VS DOBROG SPAJANJA:\n"
    "  Template: 'Krov lobanje kruškolik, kosti svoda lobanje očuvane.'\n"
    "  Diktacija: 'prelom svoda lobanje desno'\n"
    "  ❌ LOŠE: 'Krov lobanje kruškolik, kosti svoda lobanje očuvane. Prelom svoda lobanje desno.' "
    "(KONTRADIKCIJA — očuvane I sa prelomom)\n"
    "  ✅ DOBRO: 'Krov lobanje kruškolik, sa prelomom svoda lobanje desno.' "
    "(template MODIFIKOVAN da se uklopi)\n\n"
    "  Template: 'Mozak nešto manji, jasne građe.'\n"
    "  Diktacija: 'mozak izrazito otečen 1500g'\n"
    "  ❌ LOŠE: 'Mozak nešto manji, jasne građe. Mozak izrazito otečen 1500g.'\n"
    "  ✅ DOBRO: 'Mozak izrazito otečen, mase 1500 g, jasne građe.'\n\n"
    "Ostala pravila:\n"
    "1. Sačuvaj statičku strukturu template-a SAMO tamo gdje diktacija ne traži drugačije.\n"
    "2. Brojeve sa jedinicama: 25 cm, 150 ml, 12 × 7 cm, 1,5 cm.\n"
    "3. Padeži moraju odgovarati kontekstu rečenice ('Dužice zelene', ne 'Dužice zelena').\n"
    "4. Ako za neku prazninu nema diktirano, ostavi prazan razmak ili izostavi tu pomenu — "
    "NE izmišljaj specifične vrijednosti (boja, mjere, broj).\n"
    "5. Diktacija je neformalna; rastumači šta ide gdje koristeći redoslijed pominjanja, "
    "kontekst i primjere.\n"
    "6. Ispravi greške u prepoznavanju medicinskih termina (npr. 'poreb rica' → 'porebrica').\n"
    "7. KLJUČNO: koristi standardne formulacije iz primjera (npr. 'glatke, sjajne, srednjekrvne', "
    "'jasne građe i crteža', 'lako skidljive čahure'). To je tvoj prepoznatljivi stil.\n"
    "8. PROVJERI prije nego vratiš: nema kontradikcija (npr. 'očuvane' uz 'prelom', "
    "'bez stranog sadržaja' uz opis sadržaja, 'glatka' uz 'erozija').\n"
    "9. Vrati SAMO popunjen paragraf, bez objašnjenja, bez markdown-a, bez navodnika."
)

EXTRACT_NAREDBA_SYSTEM = (
    "Ti si asistent sudskom vještaku medicinske struke u BiH. "
    "Iz naredbe tužilaštva o obdukciji izvlačiš strukturisane podatke. "
    "VRATI SAMO čist JSON objekat, BEZ markdown code fence (bez ```), "
    "BEZ objašnjenja, BEZ dodatnog teksta — samo JSON koji počinje sa { i završava sa }."
)

EXTRACT_NAREDBA_PROMPT = """Pažljivo pročitaj priloženu naredbu tužilaštva i izvuci sljedeće podatke.
Vrati ČIST JSON objekat sa ovim ključevima (svi su stringovi; ako podatak fali, vrati prazan string ""):

{
  "ime_prezime": "Prezime Ime u TITLE CASE (npr. 'Džindo Ćamil', NE 'DŽINDO (ALIJA) ĆAMIL'). Bez očevog imena u zagradi.",
  "drzavljanin": "BiH (po default-u, ako nije eksplicitno drugačije navedeno)",
  "prebivaliste": "Grad/općina prebivališta (vidi adresu pronalaska ili prebivališta — NIJE rodno mjesto)",
  "adresa": "Ulica i broj iz mjesta prebivališta ili pronalaska",
  "rodjen": "DD.MM.YYYY. godine (formatiraj sa tačkama i sa 'godine' na kraju)",
  "pronadjen": "DD.MM.YYYY. godine (datum kad je tijelo pronađeno ili datum smrti)",
  "tuzilac": "Ime i prezime kantonalnog/okružnog tužioca koji je potpisao naredbu (npr. 'Zoran Ikonić')",
  "kt_broj": "Tužilački broj BEZ prefiksa 'T09 0 KTA' (npr. 'T09 0 KTA 0207907 26' → '0207907 26')",
  "okolnosti": "Kratak opis okolnosti slučaja iz naredbe — gdje, kako, kada je tijelo pronađeno (jedna do dvije rečenice, na bosanskom)"
}

NE izmišljaj. Ako fali podatak, prazan string. NE dodavaj polja koja nisu u listi.
Vrati JSON OD-MAH, bez ikakvog uvodnog teksta."""


def _safe_draft_id(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_\-]", "", s or "")[:64]


# === Endpoint implementacije (čiste funkcije) ===

def ep_config(_payload):
    stt_options = ["browser"]
    if GROQ_API_KEY:
        stt_options.insert(0, "groq")
    try:
        sections = sections_with_template(str(TEMPLATE_PATH))
    except Exception:
        sections = DICTATION_SECTIONS
    return {
        "header_fields": HEADER_FIELDS,
        "sections": sections,
        "stt_options": stt_options,
        "default_stt": stt_options[0],
        "claude_available": bool(ANTHROPIC_API_KEY),
        "template_path": str(TEMPLATE_PATH),
    }


def ep_transcribe(payload):
    if not GROQ_API_KEY:
        raise ApiError(400, "Groq API ključ nije postavljen (Postavke).")
    audio_b64 = payload.get("audio_b64", "")
    if not audio_b64:
        raise ApiError(400, "Prazan audio.")
    audio_bytes = base64.b64decode(audio_b64)
    audio_ct = (payload.get("content_type") or "audio/webm").lower()
    if "mp4" in audio_ct or "m4a" in audio_ct:
        filename = "audio.m4a"
    elif "ogg" in audio_ct:
        filename = "audio.ogg"
    elif "wav" in audio_ct:
        filename = "audio.wav"
    elif "mpeg" in audio_ct or "mp3" in audio_ct:
        filename = "audio.mp3"
    else:
        filename = "audio.webm"
    raw_text = api_clients.groq_transcribe(
        GROQ_API_KEY, audio_bytes, filename, audio_ct,
        model="whisper-large-v3", language="hr",
        prompt=WHISPER_BIAS_PROMPT, temperature="0",
    )
    corrected = apply_corrections(raw_text)
    return {"text": corrected, "raw_whisper": raw_text}


def ep_cleanup(payload):
    if not ANTHROPIC_API_KEY:
        raise ApiError(400, "Anthropic API ključ nije postavljen.")
    text = (payload.get("text") or "").strip()
    if not text:
        return {"text": ""}
    user_msg = f"Sekcija: {payload.get('section_title', '')}\n\nSirovi tekst:\n{text}"
    result = api_clients.claude_messages(
        ANTHROPIC_API_KEY, CLAUDE_MODEL, CLEANUP_SYSTEM,
        [{"role": "user", "content": user_msg}], max_tokens=2000,
    )
    cleaned = result["text"]
    if cleaned.startswith('"') and cleaned.endswith('"'):
        cleaned = cleaned[1:-1].strip()
    return {"text": cleaned}


def ep_merge(payload):
    if not ANTHROPIC_API_KEY:
        raise ApiError(400, "Anthropic API ključ nije postavljen.")
    raw = (payload.get("raw_dictation") or "").strip()
    if not raw:
        return {"text": ""}
    section_id = payload.get("section_id", "")
    section_title = payload.get("section_title", "")
    is_multi = bool(payload.get("is_multi", False))
    template_text = payload.get("template_text", "")
    hint = payload.get("hint", "")

    static_system = MERGE_SYSTEM_MULTI if is_multi else MERGE_SYSTEM_SINGLE

    examples = select_examples(section_id, count=4)
    examples_block = ""
    if examples:
        parts = [f"PRIMJERI iz vlastitih ranijih obdukcija za sekciju '{section_id}' — "
                 "prati OVAJ STIL pisanja (formulacije, redoslijed, dužinu rečenica, padeže):\n"]
        for i, ex in enumerate(examples, 1):
            parts.append(f'\n--- PRIMJER {i} ---\n{ex["text"]}\n')
        parts.append("\n--- KRAJ PRIMJERA ---")
        examples_block = "".join(parts)

    if is_multi:
        user_query = f"Sekcija: {section_title}\n\nDiktacija:\n{raw}"
    else:
        hint_part = f"\n\nDodatni kontekst: {hint}" if hint else ""
        user_query = (
            f'Sekcija: {section_title}{hint_part}\n\n'
            f'Template paragraf (ima praznine — prepoznaješ ih po višestrukim razmacima):\n'
            f'"""{template_text}"""\n\n'
            f'Diktirane fraze (kratke, neformalne):\n"""{raw}"""\n\n'
            f'Spoji u kompletan paragraf u tvom prepoznatljivom stilu.'
        )

    system_blocks = [{
        "type": "text", "text": static_system,
        "cache_control": {"type": "ephemeral"},
    }]
    user_content = []
    if examples_block:
        user_content.append({
            "type": "text", "text": examples_block,
            "cache_control": {"type": "ephemeral"},
        })
    user_content.append({"type": "text", "text": user_query})

    result = api_clients.claude_messages(
        ANTHROPIC_API_KEY, CLAUDE_MODEL, system_blocks,
        [{"role": "user", "content": user_content}], max_tokens=2000,
    )
    merged = result["text"]
    if merged.startswith('"') and merged.endswith('"'):
        merged = merged[1:-1].strip()
    u = result["usage"]
    return {
        "text": merged,
        "tokens_in": u["input_tokens"], "tokens_out": u["output_tokens"],
        "cache_read": u["cache_read"], "cache_create": u["cache_create"],
    }


def ep_log_correction(payload):
    learned = log_correction(payload.get("original", ""), payload.get("edited", ""))
    return {"learned": learned}


def ep_corrections_list(_payload):
    return list_all_corrections()


def ep_corrections_manage(payload):
    pattern = payload.get("pattern", "")
    replacement = payload.get("replacement")
    if not replacement:
        remove_learned_correction(pattern)
        return {"action": "removed", "pattern": pattern}
    save_learned_correction(pattern, replacement)
    return {"action": "saved", "pattern": pattern, "replacement": replacement}


def ep_extract_naredba(payload):
    if not ANTHROPIC_API_KEY:
        raise ApiError(400, "Anthropic API ključ nije postavljen.")
    file_b64 = payload.get("file_b64", "")
    if not file_b64:
        raise ApiError(400, "Prazan fajl.")
    file_bytes = base64.b64decode(file_b64)
    media_type = (payload.get("content_type") or "").lower()
    filename = (payload.get("filename") or "").lower()

    if "pdf" in media_type or filename.endswith(".pdf"):
        content_block = {
            "type": "document",
            "source": {"type": "base64", "media_type": "application/pdf",
                       "data": base64.b64encode(file_bytes).decode("ascii")},
        }
    elif "image" in media_type or filename.endswith((".jpg", ".jpeg", ".png", ".webp", ".heic")):
        if "jpeg" in media_type or filename.endswith((".jpg", ".jpeg")):
            mt = "image/jpeg"
        elif "png" in media_type:
            mt = "image/png"
        elif "webp" in media_type:
            mt = "image/webp"
        else:
            mt = media_type or "image/jpeg"
        content_block = {
            "type": "image",
            "source": {"type": "base64", "media_type": mt,
                       "data": base64.b64encode(file_bytes).decode("ascii")},
        }
    else:
        raise ApiError(400, f"Nepodržan format: {media_type}. Šalji PDF ili sliku.")

    result = api_clients.claude_messages(
        ANTHROPIC_API_KEY, CLAUDE_MODEL, EXTRACT_NAREDBA_SYSTEM,
        [{"role": "user", "content": [content_block, {"type": "text", "text": EXTRACT_NAREDBA_PROMPT}]}],
        max_tokens=2000,
    )
    text = result["text"]
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text
        if text.endswith("```"):
            text = text.rsplit("```", 1)[0]
        text = text.strip()
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        raise ApiError(502, f"Claude vratio nevažeći JSON: {text[:200]}")
    return {
        "data": data,
        "tokens_in": result["usage"]["input_tokens"],
        "tokens_out": result["usage"]["output_tokens"],
    }


def ep_generate(payload):
    if not TEMPLATE_PATH.exists():
        raise ApiError(500, f"Template ne postoji: {TEMPLATE_PATH}")
    header = payload.get("header", {}) or {}
    sections = payload.get("sections", {}) or {}
    output_path = generate_report(
        template_path=str(TEMPLATE_PATH),
        output_dir=str(OUTPUT_DIR),
        header_data=header,
        sections_data=sections,
    )
    data = Path(output_path).read_bytes()
    return {
        "filename": Path(output_path).name,
        "docx_b64": base64.b64encode(data).decode("ascii"),
    }


def ep_drafts_list(_payload):
    drafts = []
    for fp in DRAFTS_DIR.glob("*.json"):
        try:
            d = json.loads(fp.read_text(encoding="utf-8"))
            drafts.append({"id": fp.stem, "name": d.get("name", "Bez naziva"),
                           "updatedAt": d.get("updatedAt", 0)})
        except Exception:
            pass
    drafts.sort(key=lambda d: d["updatedAt"], reverse=True)
    return drafts


def ep_draft_get(payload):
    safe = _safe_draft_id(payload.get("id", ""))
    fp = DRAFTS_DIR / f"{safe}.json"
    if not fp.exists():
        raise ApiError(404, "Draft ne postoji")
    return json.loads(fp.read_text(encoding="utf-8"))


def ep_draft_put(payload):
    safe = _safe_draft_id(payload.get("id", ""))
    if not safe:
        raise ApiError(400, "Nevalidan draft_id")
    out = {
        "id": safe,
        "name": payload.get("name", "Bez naziva"),
        "header": payload.get("header", {}),
        "sections": payload.get("sections", {}),
        "updatedAt": payload.get("updatedAt", 0),
    }
    (DRAFTS_DIR / f"{safe}.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return {"ok": True, "id": safe, "updatedAt": out["updatedAt"]}


def ep_draft_delete(payload):
    safe = _safe_draft_id(payload.get("id", ""))
    fp = DRAFTS_DIR / f"{safe}.json"
    if fp.exists():
        fp.unlink()
    return {"ok": True}


_ROUTES = {
    "config": ep_config,
    "transcribe": ep_transcribe,
    "cleanup": ep_cleanup,
    "merge": ep_merge,
    "log_correction": ep_log_correction,
    "corrections_list": ep_corrections_list,
    "corrections_manage": ep_corrections_manage,
    "extract_naredba": ep_extract_naredba,
    "generate": ep_generate,
    "drafts_list": ep_drafts_list,
    "draft_get": ep_draft_get,
    "draft_put": ep_draft_put,
    "draft_delete": ep_draft_delete,
}


def dispatch(endpoint: str, payload_json: str) -> str:
    """Glavni ulaz koji Kotlin zove. Vraća JSON string (uvijek — i pri grešci)."""
    try:
        payload = json.loads(payload_json) if payload_json else {}
    except Exception as e:
        return json.dumps({"__error": True, "status": 400,
                           "detail": f"Neispravan JSON ulaz: {e}"}, ensure_ascii=False)
    fn = _ROUTES.get(endpoint)
    if not fn:
        return json.dumps({"__error": True, "status": 404,
                           "detail": f"Nepoznat endpoint: {endpoint}"}, ensure_ascii=False)
    try:
        result = fn(payload)
        return json.dumps(result, ensure_ascii=False)
    except ApiError as e:
        return json.dumps({"__error": True, "status": e.status, "detail": e.message},
                          ensure_ascii=False)
    except Exception as e:
        return json.dumps({"__error": True, "status": 500,
                           "detail": f"{type(e).__name__}: {e}"}, ensure_ascii=False)
