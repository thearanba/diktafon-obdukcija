# Diktafon obdukcija — HANDOFF (nastavak u novoj sesiji)

> Samostalan pregled stanja projekta da se rad nastavi bez gubitka konteksta.
> Zadnji build: **#35** (audit fixevi). Datum: 2026-06-09.

## 1. Šta je ovo
Native Android aplikacija (Samsung Galaxy S25 Ultra) za diktiranje obdukcionog
zapisnika prof. dr. Adisa Salihbegovića. Port desktop alata `diktafon-obdukcija`
(FastAPI+PWA) u **samostalnu APK** — radi na uređaju, **bez servera**.

- **Projekat (kod):** `C:\Users\User\DiktafonObdukcija` (van OneDrive-a namjerno — Android `build/` bi pravio sync haos).
- **Repo:** `github.com/thearanba/diktafon-obdukcija` (**PUBLIC** od 09.06.2026, grana `master`).
  > Bio private; #32/#33 su zaglavili u `queued` jer su potrošene besplatne Actions minute na privatnom repou
  > (runner se ne dodjeljuje, run stoji u redu umjesto da padne). Prebačen na **public** → neograničene Actions
  > minute → build kreće odmah. **Ne vraćati na private** dok se oslanjamo na CI build (inače isti zastoj).
- **Desktop original (referenca):** `C:\Users\User\OneDrive\AI\Print Apk\diktafon-obdukcija`.
- **Trajna memorija:** `…\.claude\projects\C--Users-User-OneDrive-AI-Print-Apk\memory\project_diktafon_android_apk.md` (auto-učitava se).

## 2. Arhitektura (BEZ SERVERA)
- UI = postojeći HTML/JS u `assets/web/`, prikazan u **WebView** preko `WebViewAssetLoader`
  (`https://appassets.androidplatform.net/index.html` — lokalni origin; mikrofon + localStorage rade).
- JS → Kotlin → Python (**Chaquopy**) preko `AndroidBridge.call(reqId, endpoint, payloadJson)` →
  `android_api.dispatch()` → rezultat nazad preko `window.__nativeResolve`. **Nema HTTP/socket/port.**
- `.docx` izlaz → javni **Download** (MediaStore) + ACTION_VIEW (Word/OneDrive).
- API ključevi: ekran **Postavke** (SharedPreferences); čitaju se pri startu → promjena = restart app.
- Zavisnosti namjerno minimalne: **python-docx (+lxml), certifi**. Claude/Groq idu preko **stdlib urllib** (NE SDK-ovi).

### Ključni fajlovi
| Fajl | Uloga |
|---|---|
| `app/src/main/java/.../MainActivity.kt` | WebView + WebViewAssetLoader + AndroidBridge (call/saveDocx/openSettings) + file/camera chooser |
| `app/src/main/java/.../SettingsActivity.kt` | unos API ključeva |
| `app/src/main/python/android_api.py` | `dispatch(endpoint, payload_json)` → svi endpointi (config/transcribe/merge/cleanup/generate/drafts/extract_naredba) + `whisper_prompt_for()` |
| `app/src/main/python/api_clients.py` | Claude + Groq preko urllib + `_SSL_CTX` (certifi) + `USER_AGENT` (Cloudflare bypass) |
| `app/src/main/python/docx_generator.py` | generator .docx (index/ćelija-vezan za template) |
| `app/src/main/python/sections.py` | schema sekcija + HEADER_FIELDS |
| `app/src/main/python/corrections.py` | post-Whisper korekcije (builtin + naučene, piše u DIKTAFON_DATA_DIR) |
| `app/src/main/assets/web/{index.html,static/app.js,static/style.css}` | UI (sva logika fronta) |
| `app/src/main/assets/pydata/template/Zapisnik opste Obdukcija.docx` | template (kopira se na filesDir) |
| `app/src/main/assets/pydata/examples.json` | few-shot primjeri za Claude merge |

## 3. Build i distribucija
- **Nema Android SDK na ovoj mašini** → build SAMO preko GitHub Actions (`.github/workflows/build-apk.yml`).
- Tok: izmijeni fajl → commit → **push na `master`** → CI build → APK na **`github.com/thearanba/diktafon-obdukcija/releases/latest`** (direktan `Diktafon obdukcija.apk`) + artifact.
- **Stabilan debug potpis:** `keystore/debug.keystore` (CI ga generiše keytool-om, keširan `diktafon-debug-keystore-v2`) → instalacija **PREKO postojeće, bez deinstalacije** (od ~#12).
- CI: `gradle-version 8.7`; wrapper JAR NIJE u repo (AS bi ga generisao lokalno).
- Git commit identitet (lokalni): `git -c user.email="diktafon@local" -c user.name="Diktafon Build" commit`.

## 4. Šta je napravljeno (do #32)
- **Zaglavlje:** kompaktna dugmad → fokus-prozori. „📋 Okolnosti/Uviđaj" (switch bira mod — JEDNA ćelija u zapisniku; donja traka mic+Doradi). „🧪 Izuzeti uzorci" (fullscreen checklist, 3 grupe + ručni unos, 2 kolone bez checkbox-a/plavo=izabrano, „✨ Sažmi"=Claude cleanup; **prazno → „Nisu izuzeti uzorci za dodatne pretrage"**; default = 0 izabrano). „Auto-popuni iz naredbe" = 2 ikone (📷 kamera / 📁 fajl) direktno.
- **Sekcije:** klik → **fokus-kokpit preko cijelog ekrana** (akordeon). Tabovi **Diktat|Finalno** (i po stavci). **Auto-rastuće** textarea (čuva scrollTop — ne skače pri kucanju). Donja traka (mic/Spoji/Obriši; multi = ➕Nova). ←/→ navigacija među sekcijama. **Multi (povrede/kostur/mišljenje):** model „selektovana stavka" (tap selektuje → istaknuta plavo + skrol na vrh; donja traka radi nad njom).
- **Topbar:** prikazuje **ime otvorenog nalaza** (ne ime app); ⋮ meni = Generiši/Drafti/Novi/Reset/Postavke/Osvježi.
- **Whisper tačnost (#31):** prompt **PO SEKCIJI** (`WHISPER_SECTION_TERMS` + `whisper_prompt_for(section_id)`), termini izvučeni iz **`OneDrive\Sudska medicina\Baza slučajeva.xlsx`** list „Obdukcije" (kol. Spoljašnji/Unutrašnji pregled, Uzrok smrti). `corrections.py` proširen split-fixevima.
- **Bug fix (#32):** kucanje ne skače na vrh; uklonjen forsirani focus-skrol.
- **Vlastiti modali (#34):** `uiConfirm`/`uiPrompt` u stilu app-a umjesto nativnih `confirm`/`prompt` (nema više „The page at https://appassets…"); crveno „Obriši" za destruktivno.
- **Audit fixevi (#35):** (1) `bindSectionEvents(scope)` — rerenderMultiBody više NE duplira listenere na netaknute kartice (dupli Claude pozivi!); (2) zombi-mikrofon: guarded clear `STATE.recording` u svim `onstop` (poredi sa `rec`), okolnosti-mic zaustavlja sekcijsko snimanje; (3) toast z-index 500 + `body.has-fullscreen .toast{bottom:150px}` (bio prekriven fokus-trakom); (4) `setWebContentsDebuggingEnabled(false)` — privatnost (debug-potpisan APK, BuildConfig.DEBUG ne pomaže); (5) `draftHasContent()` — „novi draft?" pita samo uz stvaran sadržaj; (6) uklonjen 10s polling (baterija); (7) timer snimanja: crveni badge `#rec-timer` iznad fokus-trake + vrijeme u inline mic labelima; (8) vibracija (`buzz()`, VIBRATE permission): 80ms start, 40ms stop, [40,80,40] transkript stigao.

## 5. Gotchas (da se ne ponavljaju greške)
- **JS balans-check:** `parens diff +1` je **LAŽNI alarm** (string literal `"("` u `shortTitle`). Braces/brackets moraju biti OK; backtici parni. Provjeri deltu izmjena, ne apsolut.
- **Windows konzola cp1252:** svaki Python koji printa č/ž/š → `sys.stdout.reconfigure(encoding="utf-8")`.
- **LF→CRLF** git upozorenja su bezopasna.
- **Whisper prompt** ~224 tokena (čuva ZADNJIH) → sekcijski termini idu na kraj.
- **Python test bez Androida:** koristi desktop venv
  `"C:\Users\User\OneDrive\AI\Print Apk\diktafon-obdukcija\.venv\Scripts\python.exe"`
  uz env `DIKTAFON_APP_DIR=…\app\src\main\assets\pydata`, `DIKTAFON_DATA_DIR=<temp>` → `import android_api; android_api.dispatch(...)`.
- **`:has()` CSS** korišten (plavo=izabrano) — moderni WebView OK.
- Reinstalacija PREKO radi (isti potpis); ako ikad „signatures don't match" → deinstaliraj jednom.

## 6. Otvoreno / odgođeno
- **Vlastiti template za kolegu (ODGOĐENO — korisnik rekao „drugi put").** Plan = **placeholder sistem**:
  kolega u svoj `.docx` ubaci `{{ime_prezime}}`, `{{kt_broj}}`, `{{tuzilac}}`, `{{datum_obdukcije}}`,
  `{{okolnosti}}`, `{{izuzeti_uzorci}}`, `{{s1_opsti}}`…`{{misljenje}}`; generator radi find-replace
  (čuva formatiranje; multi-sekcije = više pasusa). + Postavke „Uvezi vlastiti template" (file picker → DATA_DIR).
  Treba dodati placeholder-mod u `docx_generator.py` (sad je index/ćelija-vezan).
- Predloženo a NIJE birano (ako zatreba): provjera potpunosti prije generisanja (QA gate); brze fraze/makroi;
  pregled cijelog nalaza u app; offline STT fallback / glasovne komande.

## 7. Kako nastaviti
1. Nova sesija u ovom projektu auto-učita memoriju (gore). Pročitaj i ovaj HANDOFF.
2. Promjena: uredi u `C:\Users\User\DiktafonObdukcija` → (JS balans-check) → commit → push `master` → korisnik skine `releases/latest`.
3. Korisnik (Samsung S25 Ultra): instalira preko postojeće; pri prvom pokretanju mikrofon + ključevi (Anthropic obavezan za Spoji/Doradi/Auto-popuni, Groq obavezan za diktiranje).
