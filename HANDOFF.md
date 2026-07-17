# Diktafon obdukcija — HANDOFF (nastavak u novoj sesiji)

> Samostalan pregled stanja projekta da se rad nastavi bez gubitka konteksta.
> **AKTIVNO STANJE: v2 + nermin (obje aktivne). Datum zadnjeg rada: 15.07.2026.**
> Istorijski dio (sekcije 1–7, v1) ostaje netaknut kao referenca ispod ovog bloka.

---

# 📌 SESIJA 15.07.2026 — čitati PRVO (najsvježije)

**Grane sinhronizovane s remote-om.** v2 vrh `16abd3d`, nermin vrh `c07d2bb` (isti sadržaj,
razlika = samo Nerminov template/identitet + zasebni workflow). Oba builda ✅ success.
**SVAKA izmjena ide na OBJE grane:** commit na v2 → push → `git checkout -B nermin refs/heads/nermin` →
`cherry-pick <hash>` → push nermin → `git checkout -B v2 refs/heads/v2`.
⚠ Cherry-pick NE prenosi izmjene `build-v2.yml` na `build-nermin.yml` — to su različiti
fajlovi, pa izmjenu CI-ja treba ponoviti ručno (jednom već propušteno).

## ⚠ TRAJNA DIVERGENCIJA GRANA — nermin NEMA bravu aplikacije (od `8ac57c7`)
Odluka korisnika (17.07.2026): Nerminu lozinka/otisak smetaju. **Na v2 sve OSTAJE.**
Na nermin grani su UKLONJENI: `LoginActivity.kt`, `AppLock.kt`, `BioCrypto.kt`,
`BioSetup.kt`, `res/layout/activity_login.xml`, svi `login_*` stringovi,
`settings_bio_toggle`, prekidač za otisak u Postavkama, `androidx.biometric` zavisnost,
i redirect u `MainActivity.onCreate`.
- **NE dirati `SecurePrefs`/`security-crypto` ni na jednoj grani** — na njima stoje API
  ključevi (EncryptedSharedPreferences), nemaju veze s bravom.
- Ovi fajlovi se od sada RAZLIKUJU među granama: `MainActivity.kt`, `SettingsActivity.kt`,
  `AndroidManifest.xml`, `strings.xml`, `app/build.gradle`. Cherry-pick sa v2 koji ih
  dira → **konflikt**; rješavati zadržavajući nermin stranu (bez brave) i uzimajući samo
  stvarnu izmjenu.
- Ako se ikad zatraži vraćanje brave na nermin: `git checkout refs/heads/v2 -- <fajlovi>`
  je najbrži put (fajlovi su na v2 netaknuti).

## ⚠ APK je sada RELEASE (od `b689edb`) — bitno za sljedeću sesiju
Oba workflow-a grade `assembleRelease` (ne više `assembleDebug`) → **debuggable=false**.
Potpisuje se ISTIM `keystore/debug.keystore`, pa se nova verzija i dalje instalira PREKO
postojeće (bez deinstalacije, drafti ostaju). CI ima tvrdu kapiju: `apksigner verify` +
`aapt2 dump badging | grep application-debuggable` → build pada ako APK nije potpisan ili
jeste debuggable. **Ne vraćati na assembleDebug** — to bi vratilo `adb run-as` pristup
draftovima i API ključevima.

## Šta je urađeno ove sesije (sve na v2 + cherry-pick nermin)
1. **Redizajn — Forensic Medicine DS (tamna varijanta):** amber→brend-orange `#F58634`;
   charcoal topbar band + narandžasti val; logo Katedre orange obrub; sva Tailwind-plava
   selekcija→orange; `theme-color`/manifest charcoal. (`370d097`)
2. **Kartice na home + fullscreen:** Zaglavlje, Okolnosti/Uviđaj, Izuzeti uzorci su sad
   kartice na home (ispod grupnih razdjelnika) koje se OTVARAJU u fullscreen kao sekcije.
   Redni brojevi sekcija narandžasti lijevo; naslov-u-zagradi ide u novi red (`.ct-sub`);
   status pill (finalno/diktat/prazno); meta-snippet u novom redu ispod naslova.
3. **Jedinstvena donja traka + navigacija:** `#focus-nav` (sekcije) i `#card-fs-nav`
   (kartice) — ISTI raspored. Lanac `focusOrder()`=[header,okolnosti,izuzeti,...sekcije];
   `navGo()`/`setNavArrows()` dijele obje trake; `enterAny()` bira karticu vs sekciju.
   Diktiranje u sve tri kartice: `toggleHeaderMic` (u fokusirano polje), `toggleOkolnostiMic`,
   `toggleIzuzetiMic` (u ručno polje). Zaglavlje traka: `[📷 Slikaj][🎤][📋 Naredba]`, BEZ pauze.
4. **Android back:** `window.onAndroidBack` (MainActivity.onBackPressed → evaluateJavascript);
   zatvara dlg-overlay/modal/fokus/karticu/akordeon; UVIJEK vraća true (back NIKAD ne obara app).
5. **Preimenovanja (sections.py):** `s3_povrede`="3. Povrede", `s6_jezik`="6. Vrat",
   `s8_srce`="8. Srce i aorta". (id-ovi NEPROMIJENJENI — drafti ih čuvaju.)
6. **AUDIT fixevi (`91a6b86`):** snimanje (stop pri izlasku/prelasku, guard dupli tap,
   dlg-overlay back, generateReport fullscreen, truncation toast); naučene korekcije
   (crna lista strane/pozicije/brojeva `_SENSITIVE_WORDS`, kapitalizacija `_case_preserving_repl`);
   robusnost (drafts_list string updatedAt, `_atomic_write_json`, stop_reason truncated flag,
   ne-JSON poruka, max_tokens 4000); WebView sigurnost (`shouldOverrideUrlLoading` samo
   appassets host, mic/GPS origin provjere).

## AUDIT BACKLOG — ✅ ZATVOREN (sve odrađeno 15.07.2026, commiti `1bb48cc`/`b689edb`/`16abd3d`)
7. **Sitnice (`1bb48cc`):** Izuzeti checkbox više ne pregazi Claude-dorađen tekst
   (`composeIzuzetiText` je sad ČISTA funkcija; otisak `STATE.header.izuzeti_auto` razlikuje
   vlastiti tekst od auto-generisanog; dugme „↻ Osvježi iz selekcije"; stari drafti bez
   `izuzeti_auto` se tretiraju kao vlastiti = sigurniji default). „📅 Danas" računa datum na
   klik (`data-fill-today`), ne pri renderu. HEIC → nativna konverzija u JPEG
   (`AndroidBridge.imageToJpeg`, BitmapFactory dekodira HEIF od API 29, downscale 1568px) +
   Python `_is_heic` po magic bytes uz jasnu uputu. Retry-After se poštuje (sekunde i HTTP
   datum) uz cap `MAX_RETRY_WAIT_S=8s`.
8. **Srednje (`1bb48cc`):** `_fill_header_table` ima SIDRA (`_HEADER_ANCHORS`) — pozicije se
   razriješe PRIJE ijednog upisa i potvrde tekstom iz template-a; izmijenjen template više ne
   može tiho razbacati podatke → `ValueError` koja imenuje polje. `ep_provjera` sada prima i
   `header` (zaglavlje, okolnosti/uviđaj, izuzeti) + 2 nove tačke u promptu.
   Generator skida postojeću numeraciju prije svoje (`_STRIP_NUM_RE`).
9. **Sigurnost (`b689edb`):** rate-limit lozinke (`AppLock.lockoutMsFor`, brojač PERZISTIRA);
   otisak vezan za AndroidKeyStore ključ (`BioCrypto` + `BioSetup`, `setUserAuthenticationRequired`);
   release APK (vidi blok gore).
10. **Mrtvi kod (`16abd3d`):** -244 lin JS (12 funkcija), -200 lin CSS (24 klase).

### ⚠ Pouke za sljedeće čišćenje mrtvog koda
- **Brojanje referenci NE VALJA** — klaster `openOkolnostiOverlay → bindOkolnostiOverlay →
  openOkolnostiOverlay` je CIKLIČAN i tako izgleda živ. Koristiti **dosežljivost (BFS) od
  korijena** preko esprima AST-a; skripta: `scratchpad/dead_code3.py` (korijeni = pomen u
  index.html, `window.X =`, referenca iz top-level koda).
- Regex-parser za granice funkcija puca (regex literali, komentari) — koristiti AST `range`.
  Transformacije za esprima (`catch {`, `?.`, `??`) ne smiju mijenjati broj redova.
- `.fs-overlay` je sada POTPUNO uklonjen (CSS+JS) — nijedan element ga više ne pravi;
  `onAndroidBack` korak 1 obrisan jer je bio mrtav (Okolnosti/Izuzeti hvataju `fsCardId`).
- Vizuelna provjera: render prije/poslije Edge headless + PIL `ImageChops` → traži
  PIKSEL-IDENTIČAN rezultat (postignuto).

## Preostalo (nisko, NIJE hitno)
- `STATE.lastKnownServerTs` + `hideConflictBanner()` su ostaci konflikt-mehanizma koji nema
  smisla bez servera. Tehnički su ŽIVI (pozivaju se), pa ih čišćenje traži diranje logike
  učitavanja draftova — ostavljeno namjerno.
- ElevenLabs Scribe kao opcioni STT provider (tačniji od Groq Whispera za BHS, ali plaćen) —
  čeka odluku korisnika.

## Alati/render u OVOJ sesiji (Browser pane MCP je bio ZAGLAVLJEN)
- **Render app-a bez uređaja:** Edge headless preko PowerShell —
  `msedge --headless=new --disable-gpu --window-size=412,H --force-device-scale-factor=2
  --virtual-time-budget=7000 --run-all-compositor-stages-before-draw --screenshot=out.png URL`.
  Harness (`apppreviewN/`) = kopija `assets/web/` + `harness.js` koji stub-uje `AndroidBridge`
  (config iz `android_api.ep_config`) i seed-uje STATE; `<script src=harness.js>` PRIJE app.js.
  PIL za crop screenshotova. Server: `python -m http.server PORT` u harness folderu.
- **Validacija:** JS `esprima` (scratchpad `check_js.py`, neutralizuje `catch{`/`?.`); CSS
  brace-count; Python import + funkcijski testovi u venv-u.
- **JIT gotcha:** `git log v2` je DVOSMISLEN (tag `v2` + grana `v2`) → koristi
  `git log refs/heads/v2`; push `HEAD:refs/heads/v2`.

---

# ⭐ v2 — TRENUTNO AKTIVNO STANJE (čitati PRVO)

## Dvije zasebne aplikacije (v1 zamrznuta, v2 aktivna)
| | v1 (stara, ZAMRZNUTA) | **v2 (redizajn, AKTIVNA)** |
|---|---|---|
| Grana | `master` | **`v2`** ← sav rad ide ovdje |
| Release tag | `latest` | **`v2`** (prerelease=true) |
| applicationId | `ba.forenzika.diktafon` | `ba.forenzika.diktafon.v2` |
| Ime app | „Diktafon obdukcija" | „Diktafon v2" |
| Workflow | `build-apk.yml` | **`build-v2.yml`** |
| Skidanje | `releases/latest` | `releases/tag/v2` → „Diktafon v2.apk" |

- **Instaliraju se JEDNA PORED DRUGE** (drugi applicationId, odvojeni podaci). v1 se NE dira.
- `prerelease=true` na v2 → `releases/latest` i dalje pokazuje v1. Ako mijenjaš `build-v2.yml`, **zadrži `prerelease: true`** (inače v2 „ukrade" latest jer je najnoviji po datumu).

## Git rad na v2 (VAŽNO — postoje i TAG `v2` i GRANA `v2`, isto ime!)
- **Push:** `git push origin HEAD:refs/heads/v2` (obično `git push origin v2` je dvosmisleno).
- **Sinhronizacija** (CI zna dodati keystore commit): `git fetch origin refs/heads/v2:refs/remotes/origin/v2 --force` pa `git reset --hard origin/v2` (lokalno je uvijek predak; radi se i `git tag -d v2` za lokalni tag).
- **Potpis TRAJAN na v2:** `keystore/debug.keystore` je UPISAN u repo (`build-v2.yml` ga jednokratno generiše + commit „[skip ci]"). Zato se v2 uvijek instalira PREKO postojeće v2. (v1 keystore je i dalje samo u CI kešu → v1 zna tražiti deinstalaciju; nije popravljano jer je zamrznuta.)
- **[skip ci]** u commit poruci preskače v2 build (koristiti za doc-only izmjene poput ovog HANDOFF-a).

## v2 dizajn (dfm identitet Katedre)
- Boje u `assets/web/static/style.css` `:root`: `--bg #211D1E` (ugljena), `--text #EFE9E1`, `--primary #E08A1E` (amber, SUZDRŽAN — prsten/okvir/podvlaka, NE pune ispune), `--success #1d9e75`, `--record/danger #cf3a3a`.
- **Logo:** pravi vektor iz `OneDrive\...\vizitka f.pdf` (PyMuPDF, crteži 5–8 = 4 pločice d/o/f/m). Web: `assets/web/static/dfm-logo.svg` (varijanta C: BIJELA slova, ploče `currentColor`, amber obrub). Native: `res/drawable/dfm_logo.xml` (VectorDrawable). fitz rasterizer IGNORIŠE fill-rule (lažno izgleda krivo) → provjeravati cairosvg ili WebView.
- Login (nativni): `res/layout/activity_login.xml` + `themes.xml` + `res/values/colors.xml` (dfm_charcoal/amber/text/text_dim). dfm logo + serif „Department of Forensic Medicine" + amber nit + outline dugmad.

## Šta je NOVO u v2 (ova sesija, sve na grani v2)
1. **Traka:** Groq/Claude status u ⋮ meni (ne u vrhu); ime slučaja PUNO u jednom redu; mini dfm logo lijevo.
2. **Uvoz draftova** (par za Izvoz): ⋮ „📥 Uvezi drafte (ZIP)" → `import_drafts` endpoint; nikad ne pregazi (konflikt = nov id + „(uvezeno)").
3. **Živi prsten nivoa zvuka** oko mikrofona (WebAudio `--mic-amp`) + **PAUZA/NASTAVAK** (`MediaRecorder.pause/resume`; lijevo kokpit-dugme postaje Pauza/Nastavi dok snima; timer staje). Animacije suzdržane: toast slide-in, fs-overlay fade.
4. **Mjerenje prompt-keša:** „Spojeno ✓" toast pokazuje `cache_read`/`cache_create` (keš✓/upisan/ne). **`ep_merge` VEĆ kešira** system+examples; `ep_cleanup`/`ep_extract_naredba` NE (moguće proširenje „B"). Sonnet 4.6 min prefiks 2048 tok — ako toast stalno kaže „keš: ne", prefiks je premali.
5. **Fix skakanja teksta:** CSS `field-sizing: content` (`@supports`), JS `autoGrow` je no-op na modernom WebView (`NATIVE_AUTOGROW`), fallback ostaje za stare.
6. **Uviđaj — „📍 Početak uviđaja":** ubaci na VRH rečenicu „Uviđaj dana <dan u sedmici>, DD.MM.YYYY. godine u HH:MM sati na adresi <adresa>." Adresa preko NATIVNOG Android Geocoder-a (`AndroidBridge.reverseGeocode` most). Fallback: koordinate uz upozorenje. Dozvole: FINE/COARSE_LOCATION + `setGeolocationEnabled(true)` + `onGeolocationPermissionsShowPrompt`.
7. **„📤 Generiši i podijeli (OneDrive…)":** share sheet (`AndroidBridge.shareDocx`, cache/share FileProvider) — **jedini pouzdan put do OneDrive-a** (OneDrive NE podržava SAF „Create document", zato se u SAF biraču vidi samo Drive; SAF varijanta UKLONJENA). „Generiši (.docx)" = direktno u Download.
8. **Povrede (multi sekcije):** ↑/↓ strelice za redoslijed stavki (`moveItem`); „➕ Nova" ubacuje ISPOD selektovane (`addItem(sid, afterIdx)`); uklonjeno duplo inline „+ Dodaj" dugme (samo „➕ Nova" u donjoj traci).
9. **Pregled je default:** stavka/sekcija sa finalnim tekstom otvara tab „Finalno" (`showFinal`/`itemShowFinal`); „Diktat" samo kad finalnog nema; mikrofon auto-prebaci na „Diktat" pri snimanju.

## OTVORENO / sljedeći koraci (nije rađeno)
- **STT:** za BESPLATNO + BHS Groq Whisper large-v3 je već najbolje; **ElevenLabs Scribe** je tačniji (WER ~3,1% hr) i ima „keyterm prompting" ali PLAĆENO (~$0,22/h). Ponuđeno: dodati Scribe kao OPCIONI provider (Groq default/fallback) — čeka odluku.
- **Prompt caching „B":** dodati `cache_control` i na `ep_cleanup`/`ep_extract_naredba` (ako mjerenje pokaže da se isplati).
- Iz ranijeg istraživanja (nije birano): brze fraze/makroi, UI za rječnik korekcija, **dijagram tijela za povrede**, pregled cijelog nalaza.
- **v1 keystore** popraviti trajno (uz jednu deinstalaciju) — samo ako zatreba updatovati v1.

## Alati/validacija (BEZ Android SDK/keytool/java lokalno → build SAMO na CI)
- **JS sintaksa:** esprima nad kopijom uz `catch {`→`catch(e){` i `?.`→`.` (desktop venv `C:\Users\User\OneDrive\AI\Print Apk\diktafon-obdukcija\.venv\Scripts\python.exe`, `pip install esprima`).
- **SVG:** cairosvg (fitz vara fill-rule). **CSS:** brojanje `{`/`}`. **XML:** `xml.dom.minidom`.
- **Python test:** venv + env `DIKTAFON_APP_DIR=...\assets\pydata`, `DIKTAFON_DATA_DIR=<temp>` → `import android_api; android_api.dispatch(...)`.
- **Commit identitet:** `git -c user.email="diktafon@local" -c user.name="Diktafon Build"`.
- **Build poll:** token iz `git credential fill` (host github.com) → GitHub Actions API `runs?branch=v2`.
- `CLAUDE_MODEL = "claude-sonnet-4-6"`.

---

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
- **Kontekst v2 (#43):** (A) **stanje leša** — finalni tekst Konstitucije (skraćen na 240) ide u `case_context`
  SAMO ako odstupa od template defaulta (običan leš = 0 dodatnih tokena) i ne pri spajanju te iste sekcije
  (`caseContext(excludeSid)`); pravilo o truležnoj terminologiji se dodaje uslovno. (D) **„🔎 Provjeri zapisnik"**
  u ⋮ meniju — `ep_provjera` šalje SVE flat sekcije + kontekst Claude-u (PROVJERA_SYSTEM: rod, L/D, kontradikcije,
  template praznine, mišljenje↔nalaz, dob) → lista upozorenja u `showTextModal`, NIŠTA ne mijenja (~$0.02-0.03/klik).
  Refaktor: `collectFlatSections()` dijele generate i provjera. ODBIJENO pri izboru: B (nalazi za mišljenje kontekst)
  — korisnik nije izabrao; C (okolnosti kao kontekst) — rizik fabrikacije nalaza, preskočeno uz moju preporuku.
- **Kontekst slučaja (#42) — pol i dob u merge:** sekcije se spajaju IZOLOVANO pa Claude nije znao pol
  (template default „muški" pobjeđivao i za žene) ni dob (iako zaglavlje ima datum rođenja). Sada: novo polje
  **„Pol"** u zaglavlju (quick dugmad muški/ženski; extract_naredba ga čita iz naredbe), **dob se računa** u JS
  (`computeAge`: rodjen → pronadjen ili danas), i oboje ide kao `case_context` uz SVAKI merge/cleanup poziv →
  `_case_context_block()` u android_api gradi „KONTEKST SLUČAJA" blok u user poruci (NE u keširani system!)
  s pravilima: uskladi rod svuda, upiši dob u „u dobi od __ godina" ako nije diktirana, ništa ne izmišljaj.
  System promptovi (CLEANUP/MULTI/SINGLE) dobili po jedno pravilo da kontekst tretiraju kao činjenice.
- **Tužilaštva (#41):** pun tužilački broj sa oznakom (T01–T10 kantoni FBiH po broju kantona, T20 = BiH);
  `_tuzilastvo_genitiv()` izvodi naziv u tabeli zapisnika iz oznake (nije više hardkodovano Sarajevo);
  nepoznata T-oznaka → „Nadležnog tužilaštva"; goli/KTA broj (stari drafti) → default KS. RS okružna NISU mapirana.
- **Audit 2 (#40) — tačnost:** (1) upozorenje „Nespojen diktat" pri generisanju (raw bez final → sirovi govor
  bi ušao u zapisnik; RAZLIČITO od odbijenog QA dijaloga za prazne sekcije); (2) KT prefiks: `_full_kt()` u
  generatoru — polje sad prima „KTA/KT/KTN broj" (UI prefiks „T09 0 "), extract prompt čuva oznaku vrste predmeta
  (ubistva = KT, ne KTA!), goli broj = istorijski KTA (stari drafti rade); (3) template verifikacija: `expect`
  sidra u DICTATION_SECTIONS + KORAK 0 u generate_report — izmijenjen template OBUSTAVLJA generisanje (sadržaj
  ne smije tiho u pogrešne sekcije); (4) naučene korekcije: obavezna ZAVRŠNA granica `\b` (staro „krv→krvi" je
  kvarilo „krvni"→„krvini"; normalizacija u load_learned_corrections pokriva i postojeće fajlove).
- **Audit 2 (#40) — privatnost/podaci:** allowBackup=false (drafti ne idu u Google backup);
  `setRecentsScreenshotEnabled(false)` (Main+Settings; ručni screenshotovi RADE); čišćenje `cache/camera` pri
  startu (foto naredbi); **„💾 Izvezi drafte (ZIP)"** u ⋮ meniju (endpoint `export_drafts` + `AndroidBridge.saveFile`
  → Download; jedina rezerva uz isključen backup — import NE postoji još); `flushAutoSave()` prije switch/new/delete
  drafta (debounce je gutao zadnjih 500ms / pravio ghost draft); `whisperOriginals` se čisti pri promjeni drafta.
- **Brava aplikacije (#38):** lokalni app-lock (nema servera → nema naloga). `LoginActivity` (nije launcher;
  `MainActivity.onCreate` guard preusmjeri ako `AppLock.unlocked==false`). Prvi ulazak = postavljanje lozinke
  (min 6, PBKDF2-HmacSHA256 120k iteracija + so, konstantno poređenje); poslije = lozinka ILI otisak
  (`BiometricPrompt`, BIOMETRIC_STRONG, ponudi se jednom poslije uspješne lozinke; prekidač u Postavkama).
  Politika (odluka korisnika): otključavanje SAMO pri hladnom startu (flag u procesu — pozadina ga ne briše).
  „Zaboravio sam lozinku" = dvostruka potvrda → briše SVE (drafte, ključeve, localStorage; Download .docx ostaje).
  `SecurePrefs` = EncryptedSharedPreferences (Keystore AES-256) za API ključeve (auto-migracija iz starih prefs)
  + hash brave. Deps: androidx.biometric 1.1.0, security-crypto 1.1.0-alpha06. NIJE sef: drafti na disku nešifrovani.
- **Robusnost (#36):** (1) `CLAUDE_MODEL = "claude-sonnet-4-6"` (bio 4.5; ID bez datumskog sufiksa!); (2) retry: `api_clients._urlopen_retry` — JEDAN ponovni pokušaj (1.5s backoff) za 429/5xx/529/timeout/mrežu, Claude i Groq; (3) Whisper fantom-filter: `android_api.is_whisper_phantom` (cijeli transkript == poznata YT fraza tipa „Hvala što ste gledali" → `{"text":"", "phantom":true}`, fraza usred diktata se NE dira) + JS `MIN_AUDIO_BYTES=4096` (kraći snimak se ne šalje) + prazan transkript → toast „Nije prepoznat govor", NE upisuje se i NE uči korekcije. **QA dijalog praznih sekcija ODBIJEN** (korisnik: spoljašnji pregled namjerno ostavlja većinu sekcija na template tekstu) — ne predlagati ponovo.

## 5. Gotchas (da se ne ponavljaju greške)
- **JS balans-check:** `parens diff +1` je **LAŽNI alarm** (string literal `"("` u `shortTitle`). Braces/brackets moraju biti OK; backtici parni. Provjeri deltu izmjena, ne apsolut.
- **JS sintaksa — NAJBOLJA provjera:** esprima (pip, u temp) nad kopijom uz dvije neutralizacije:
  `catch {` → `catch (e) {` (ES2019) i `?.` → `.` (ES2020). Ručni balans-brojač zna pogrešno
  brojati (regex-state guta blokove) — paran rezultat ≠ dokaz, esprima parse = dokaz.
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
