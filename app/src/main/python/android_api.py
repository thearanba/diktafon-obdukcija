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

CLAUDE_MODEL = "claude-sonnet-4-6"

# === Few-shot primjeri ===
EXAMPLES_BY_SECTION: dict = {}
if EXAMPLES_PATH.exists():
    try:
        _ex = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))
        EXAMPLES_BY_SECTION = _ex.get("by_section", {})
    except Exception as e:
        print(f"[android_api] Greška examples.json: {e}")


# Bazni (uvijek prisutni) termini — palatali i najčešće riječi koje Whisper iskrivi.
WHISPER_BASE_TERMS = (
    "Sudsko-medicinski obdukcioni zapisnik. Opšti termini: poglavina, moždanica, "
    "porebrica, poplućnica, potrbušnica, osrčje, usrčnica, srednjekrvna, malokrvna, "
    "mnogokrvna, bjeličasto sedefasta, sukrvičav, somotasta sluznica, oguljotina kože, "
    "razderotina, nagnječina, krvni podljev, krvlju podljeveno, truležno izmijenjeno, "
    "jasne građe i crteža, glatke sjajne."
)

# Termini specifični za pojedinu sekciju — dižu tačnost prepoznavanja u tom dijelu
# (kontekstualni initial_prompt). Whisper čuva zadnjih ~224 tokena, pa ovo ide na kraj.
WHISPER_SECTION_TERMS = {
    "s1_opsti": "muški ženski leš, dužine cm, dobi godina, uhranjenost, odjeća.",
    "s1_konstitucija": "kostur mišići razvijeni, mrtvačka ukočenost, mrtvačke mrlje slivene "
        "postranično ljubičasto crvene, koža blijedo sivo ružičasta.",
    "s2_glava_lice": "kosa, brada brkovi, očni kapci, veznice i bjeloočnice glatke sjajne, "
        "rožnjače, dužice, zjenice.",
    "s2_usta": "usta poluotvorena, sluznica usana glatka ružičasta.",
    "s2_zubi_vrat_grudi": "zubi, alveolni greben, vrat pokretljiv, grudni koš valjkast simetričan, "
        "trbuh, kosmatost polnog predjela, spolovilo, ekstremiteti simetrični.",
    "s3_povrede": "oguljotina kože, razderno-nagnječna rana, nagnječina kože, krvni podljev, "
        "podljev kože, ogoljene kožice, krvlju podljevene ivice, nepravilnog ovalnog oblika, "
        "tamno crvene ljubičaste boje, oblika i veličine, mjere centimetara.",
    "s4_otvori": "spoljašnji tjelesni otvori ušiju nosa usta polnog otvora i čmara, strani sadržaj.",
    "s5_mozak": "tkivo poglavine, krov lobanje kruškolik, kosti svoda lobanje očuvane, tvrda moždanica "
        "bjeličasto sedefasta, moždanični slivovi, meke moždanice krvlju podljevene, otok mozga, "
        "mozak vijuge i brazde, srednjekrvan, truležno izmijenjeno.",
    "s6_jezik": "jezik jasne građe i crteža, limfni čvorići korijena jezika, ždrijelo i jednjak, "
        "grkljan dušnik glavne dušnice, limfni čvorići ispod račve dušnika zrno graška, štitnjača.",
    "s7_pluca": "grudne šupljine, poplućnica i porebrica glatke sjajne, pluća, rezna ploha, "
        "najsitnije dušnice sluzav sadržaj, sitni krvni sudovi tečna krv.",
    "s8_srce": "srčana kesa, vanjski unutrašnji list osrčja, srce čvrsto, arterijska i venska ušća "
        "zalisci, osrčnica usrčnica, srčani mišić, desna lijeva komora, srčane arterije prohodne, "
        "grudna aorta intima, jajasta rupica između pretkomora, koronarne.",
    "s9_trbuh": "trbušna šupljina, potrbušnice glatke sjajne, slezena, žučna kesica žuč prebojena "
        "žučnim bojama, jetra providne čaure, gušterača sitnorežnjasta, nadbubrezi kora sredina, "
        "bubrezi lako skidljive čahure kora piramide, bubrežna korita mokraćovod, mokraćni mjehur, spolni organi.",
    "s10_git": "želudac sadržaj, sluznica želuca, dvanaestopalačno crijevo, tanko debelo srpasto "
        "završno crijevo, crijevni sadržaj, sluznica mnogokrvna.",
    "s11_kostur": "prelom kostiju, serijski prelomi rebara, pazušna i lopatična linija, koštani sistem, "
        "svod i baza lobanje, kralježnica, nadlaktica podlaktica, butna kost, potkoljenica, karlica, grudna kost.",
    "dodatne": "histološka pretraga, toksikološka analiza, alkohol i psihoaktivne supstance, DNA.",
    "misljenje": "smrt je nasilna, neposredno uzrokovana, uzrok smrti, mehanizam smrti, obdukcijom utvrđeno, "
        "krvarenje, otok mozga, krvni podljev, razderno-nagnječna rana, prelom, povreda regije, "
        "sa stepenom sigurnosti graničnim sa izvjesnošću, konzistentno sa.",
    "okolnosti": "mjesto i vrijeme pronalaska, položaj tijela, zatečeno stanje, lice mjesta, uviđaj.",
}


def whisper_prompt_for(section_id: str) -> str:
    terms = WHISPER_SECTION_TERMS.get(section_id or "", "")
    if terms:
        return f"{WHISPER_BASE_TERMS} Termini za ovaj dio: {terms}"
    return WHISPER_BASE_TERMS


# Whisper na tišini / vrlo kratkom snimku zna halucinirati fraze iz YouTube titlova
# ("Hvala što ste gledali", "Pretplatite se"...). Filtriramo SAMO kad je cijeli
# transkript jedna od poznatih fraza — usred stvarne diktacije se ne dira.
WHISPER_PHANTOM_PHRASES = (
    "hvala vam što ste gledali", "hvala što ste gledali", "hvala na gledanju",
    "hvala vam na gledanju", "hvala vam što ste gledali ovaj video",
    "hvala što ste gledali video", "hvala vam", "hvala",
    "pretplatite se", "pretplatite se na kanal", "pretplatite se na naš kanal",
    "lajkujte i pretplatite se", "do sljedećeg videa", "vidimo se u sljedećem videu",
    "uživajte", "titlovi by", "prijevod i titlovi", "prevod i obrada",
)


def _phantom_norm(t: str) -> str:
    t = (t or "").lower()
    t = (t.replace("š", "s").replace("đ", "dj").replace("č", "c")
          .replace("ć", "c").replace("ž", "z"))
    return re.sub(r"[^a-z0-9 ]+", " ", t).strip()


_PHANTOM_NORM_SET = {_phantom_norm(p) for p in WHISPER_PHANTOM_PHRASES}


def is_whisper_phantom(text: str) -> bool:
    n = re.sub(r"\s+", " ", _phantom_norm(text))
    return (not n) or (n in _PHANTOM_NORM_SET)


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
    "5. Ako poruka sadrži KONTEKST SLUČAJA (pol/dob), to su činjenice — uskladi rodne "
    "oblike i padeže s njima.\n"
    "6. Vrati SAMO sređeni tekst, bez objašnjenja, bez navodnika."
)

MERGE_SYSTEM_MULTI = (
    "Ti si asistent sudskom vještaku medicinske struke u BiH (prof. dr. Nermin Sarajlić). "
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
    "6. Ako poruka sadrži KONTEKST SLUČAJA (pol/dob), to su činjenice — uskladi rodne "
    "oblike i padeže s njima.\n"
    "7. Vrati SAMO sređeni tekst, bez objašnjenja, bez navodnika, bez '1.', '2.' "
    "(numeracija se dodaje automatski ako treba)."
)

MERGE_SYSTEM_SINGLE = (
    "Ti si asistent sudskom vještaku medicinske struke u BiH (prof. dr. Nermin Sarajlić). "
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
    "9. Ako poruka sadrži KONTEKST SLUČAJA (pol/dob), to su činjenice: 'muški/ženski' "
    "izbore u template-u razriješi prema polu, rodne oblike i padeže uskladi, a dob "
    "upiši gdje paragraf ima mjesto za nju ako nije diktirana.\n"
    "10. Vrati SAMO popunjen paragraf, bez objašnjenja, bez markdown-a, bez navodnika."
)

PROVJERA_SYSTEM = (
    "Ti si pažljivi kontrolor obdukcionih zapisnika sudske medicine u BiH. Dobijaš "
    "KOMPLETAN nalaz (sve sekcije) i kontekst slučaja. NIŠTA ne mijenjaš i ne prepravljaš — "
    "vraćaš SAMO listu konkretnih upozorenja, jedno po redu, format: 'SEKCIJA — problem'.\n"
    "Tražiš ISKLJUČIVO:\n"
    "1. Rodno nesklađene oblike u odnosu na pol iz konteksta (muški/ženski leš, "
    "pronađen/pronađena, kosmatost tipa...).\n"
    "2. Lijevo/desno nedosljednosti za ISTU povredu/nalaz između sekcija.\n"
    "3. Unutrašnje kontradikcije: 'kosti očuvane' uz prelom, 'bez stranog sadržaja' uz "
    "opis sadržaja, 'glatke sjajne / jasne građe' uz truležne promjene.\n"
    "4. Zaostale template praznine: 'oko  ml', 'oko cm', 'XX', 'dužine oko ,', dupli "
    "razmaci na mjestu vrijednosti, nedovršene rečenice.\n"
    "5. Mišljenje koje pominje povredu/nalaz kojeg NEMA u sekcijama nalaza, ili tešku "
    "povredu iz nalaza koja očito nedostaje u mišljenju.\n"
    "6. Nesklad dobi/datuma sa kontekstom.\n"
    "NE komentariši stil, NE predlaži formulacije, NE izmišljaj probleme. Ako je sve "
    "uredno, vrati tačno: 'Nema uočenih nedosljednosti.'"
)


def ep_provjera(payload):
    """Provjera konzistentnosti CIJELOG nalaza — vraća listu upozorenja, ništa ne mijenja."""
    if not ANTHROPIC_API_KEY:
        raise ApiError(400, "Anthropic API ključ nije postavljen.")
    sections = payload.get("sections") or {}
    if not sections:
        raise ApiError(400, "Nema sadržaja za provjeru.")
    titles = {s["id"]: s["title"] for s in DICTATION_SECTIONS}
    blocks = []
    for s in DICTATION_SECTIONS:  # redoslijed zapisnika, ne dict-a
        sid = s["id"]
        txt = (sections.get(sid) or "").strip()
        if txt:
            blocks.append(f"== {titles.get(sid, sid)} ==\n{txt}")
    ctx_block = _case_context_block(payload.get("case_context"))
    user_msg = f"{ctx_block}ZAPISNIK PO SEKCIJAMA:\n\n" + "\n\n".join(blocks)
    result = api_clients.claude_messages(
        ANTHROPIC_API_KEY, CLAUDE_MODEL, PROVJERA_SYSTEM,
        [{"role": "user", "content": user_msg}], max_tokens=1500,
    )
    u = result["usage"]
    return {"text": result["text"],
            "tokens_in": u["input_tokens"], "tokens_out": u["output_tokens"]}


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
  "spol": "muški ili ženski — ako se iz naredbe može utvrditi (formulacije poput 'leš ženske osobe', ili nedvosmisleno iz imena pokojnika). Ako nesigurno, prazan string.",
  "drzavljanin": "BiH (po default-u, ako nije eksplicitno drugačije navedeno)",
  "prebivaliste": "Grad/općina prebivališta (vidi adresu pronalaska ili prebivališta — NIJE rodno mjesto)",
  "adresa": "Ulica i broj iz mjesta prebivališta ili pronalaska",
  "rodjen": "DD.MM.YYYY. godine (formatiraj sa tačkama i sa 'godine' na kraju)",
  "pronadjen": "DD.MM.YYYY. godine (datum kad je tijelo pronađeno ili datum smrti)",
  "tuzilac": "Ime i prezime kantonalnog/okružnog tužioca koji je potpisao naredbu (npr. 'Zoran Ikonić')",
  "kt_broj": "PUN tužilački broj TAČNO kako piše u naredbi, uključujući oznaku tužilaštva i vrstu predmeta (npr. 'T09 0 KTA 0207907 26', 'T03 0 KT 0123456 25'). Oznaka tužilaštva (T01-T10, T20...) i vrsta (KTA/KT/KTN) se NE smiju mijenjati ni izostavljati.",
  "okolnosti": "Kratak opis okolnosti slučaja iz naredbe — gdje, kako, kada je tijelo pronađeno (jedna do dvije rečenice, na bosanskom)"
}

NE izmišljaj. Ako fali podatak, prazan string. NE dodavaj polja koja nisu u listi.
Vrati JSON OD-MAH, bez ikakvog uvodnog teksta."""


def _safe_draft_id(s: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_\-]", "", s or "")[:64]


def _case_context_block(ctx) -> str:
    """Blok 'KONTEKST SLUČAJA' za merge/cleanup — Claude inače ne zna pol ni dob
    (sekcije se spajaju izolovano, a ti podaci žive u zaglavlju). Ide u user poruku
    (mijenja se po slučaju — ne smije u keširani system prompt)."""
    if not isinstance(ctx, dict) or not ctx:
        return ""
    parts = []
    spol = (ctx.get("spol") or "").strip()
    if spol:
        parts.append(f"Pol: {spol}")
    dob = ctx.get("dob_godina")
    if isinstance(dob, (int, float)):
        extra = []
        if ctx.get("rodjen"):
            extra.append(f"rođen/a {ctx['rodjen']}")
        if ctx.get("pronadjen"):
            extra.append(f"pronađen/a {ctx['pronadjen']}")
        parts.append(f"Dob: {int(dob)} godina" + (f" ({', '.join(extra)})" if extra else ""))
    stanje = (ctx.get("stanje_lesa") or "").strip()
    if stanje:
        parts.append(f"Opšte stanje leša (iz sekcije Konstitucija): {stanje}")
    if not parts:
        return ""
    rules = [
        "- SVE rodno osjetljive oblike uskladi sa polom: 'muški/ženski leš' → odaberi tačan, "
        "pronađen/pronađena, kosmatost polnog predjela muškog/ženskog tipa, padeži i participi.",
        "- Ako paragraf ima mjesto za dob ('u dobi od __ godina') a diktacija je ne navodi, "
        "upiši dob iz konteksta.",
    ]
    if stanje:
        rules.append(
            "- Ako stanje leša navodi truležne/posmrtne promjene (trulež, mumifikacija, "
            "raskvašenost...), uskladi opise s tim (npr. 'truležno izmijenjeno tkivo' umjesto "
            "'jasne građe i crteža') — ali NE dodaji nalaze koji nisu diktirani.")
    rules.append("- Kontekst NE proširuj: ništa drugo iz njega ne izvodi niti dodaje.")
    return (
        "KONTEKST SLUČAJA (činjenice iz zaglavlja zapisnika — OBAVEZNO ih primijeni):\n- "
        + "\n- ".join(parts) + "\n"
        "Pravila konteksta:\n"
        + "\n".join(rules) + "\n\n"
    )


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
    section_id = payload.get("section_id", "")
    raw_text = api_clients.groq_transcribe(
        GROQ_API_KEY, audio_bytes, filename, audio_ct,
        model="whisper-large-v3", language="hr",
        prompt=whisper_prompt_for(section_id), temperature="0",
    )
    if is_whisper_phantom(raw_text):
        # Tišina/prekratak snimak — fantomski tekst ne smije ući u zapisnik
        return {"text": "", "raw_whisper": raw_text, "phantom": True}
    corrected = apply_corrections(raw_text)
    return {"text": corrected, "raw_whisper": raw_text}


def ep_cleanup(payload):
    if not ANTHROPIC_API_KEY:
        raise ApiError(400, "Anthropic API ključ nije postavljen.")
    text = (payload.get("text") or "").strip()
    if not text:
        return {"text": ""}
    ctx_block = _case_context_block(payload.get("case_context"))
    user_msg = f"{ctx_block}Sekcija: {payload.get('section_title', '')}\n\nSirovi tekst:\n{text}"
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

    ctx_block = _case_context_block(payload.get("case_context"))
    if is_multi:
        user_query = f"{ctx_block}Sekcija: {section_title}\n\nDiktacija:\n{raw}"
    else:
        hint_part = f"\n\nDodatni kontekst: {hint}" if hint else ""
        user_query = (
            f'{ctx_block}Sekcija: {section_title}{hint_part}\n\n'
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


def ep_export_drafts(_payload):
    """Spakuje sve drafte u ZIP (base64) — sigurnosna kopija u Download
    (jedini uređaj + allowBackup=false → ovo je jedina rezerva draftova)."""
    import io
    import zipfile
    from datetime import datetime
    buf = io.BytesIO()
    count = 0
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for fp in sorted(DRAFTS_DIR.glob("*.json")):
            z.write(fp, fp.name)
            count += 1
    if count == 0:
        raise ApiError(404, "Nema draftova za izvoz.")
    stamp = datetime.now().strftime("%Y-%m-%d %H-%M")
    return {
        "filename": f"Diktafon drafti {stamp}.zip",
        "zip_b64": base64.b64encode(buf.getvalue()).decode("ascii"),
        "count": count,
    }


def ep_import_drafts(payload):
    """Uveze drafte iz ZIP-a (rezultat „Izvezi drafte"). Spaja sa postojećima —
    NIKAD ne pregazi postojeći draft: ako id već postoji, uvozi pod novim id-om uz
    „(uvezeno)" u nazivu. Vraća broj uvezenih/preskočenih."""
    import io
    import zipfile
    b64 = payload.get("zip_b64", "")
    if not b64:
        raise ApiError(400, "Prazan fajl.")
    try:
        raw = base64.b64decode(b64)
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except Exception:
        raise ApiError(400, "Nevažeći ZIP fajl.")

    existing = {fp.stem for fp in DRAFTS_DIR.glob("*.json")}
    imported = 0
    skipped = 0
    for nm in zf.namelist():
        if not nm.lower().endswith(".json"):
            continue
        try:
            data = json.loads(zf.read(nm).decode("utf-8"))
        except Exception:
            skipped += 1
            continue
        if not isinstance(data, dict) or ("header" not in data and "sections" not in data):
            skipped += 1
            continue
        base_id = _safe_draft_id(str(data.get("id") or Path(nm).stem)) or "d_imp"
        name = data.get("name") or "Uvezeni draft"
        did = base_id
        if did in existing:
            n = 1
            while f"{base_id}_{n}" in existing:
                n += 1
            did = f"{base_id}_{n}"
            name = f"{name} (uvezeno)"
        out = {
            "id": did,
            "name": name,
            "header": data.get("header", {}) or {},
            "sections": data.get("sections", {}) or {},
            "updatedAt": data.get("updatedAt", 0),
        }
        (DRAFTS_DIR / f"{did}.json").write_text(
            json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
        existing.add(did)
        imported += 1

    if imported == 0:
        raise ApiError(400, "U ZIP-u nema validnih draftova.")
    return {"imported": imported, "skipped": skipped}


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
    "export_drafts": ep_export_drafts,
    "import_drafts": ep_import_drafts,
    "provjera": ep_provjera,
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
