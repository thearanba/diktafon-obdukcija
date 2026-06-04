# Diktafon obdukcija — Android (samostalna aplikacija)

Native Android aplikacija (APK) koja radi **potpuno samostalno na telefonu** — bez PC-a,
bez servera. Isti UI kao desktop verzija; sva logika (Whisper transkripcija, Claude
sređivanje, generisanje `.docx`) izvršava se na uređaju (Python preko Chaquopy),
osim poziva na Groq/Anthropic koji idu preko interneta (kao i do sada).

## Arhitektura (ukratko)

- **UI**: postojeći HTML/JS (`assets/web/`), prikazan u `WebView`-u preko `WebViewAssetLoader`
  (lokalni `https://appassets.androidhost` origin — bez mreže; mikrofon i `localStorage` rade).
- **Logika**: Python (`assets../python/`) preko **Chaquopy**. UI zove Python **direktno**
  preko `AndroidBridge.call(...)` mosta — **nema HTTP servera, porta ni socketa**.
- **`.docx` izlaz**: snima se u javni `Download` folder (MediaStore) + ponudi otvaranje (Word/OneDrive).
- **API ključevi**: unose se u aplikaciji (Postavke), čuvaju lokalno (`SharedPreferences`).

```
app/src/main/
├── java/ba/forenzika/diktafon/
│   ├── MainActivity.kt      # WebView + most prema Python-u + snimanje .docx
│   └── SettingsActivity.kt  # unos API ključeva
├── python/                  # Chaquopy — sva logika
│   ├── android_api.py       # dispatcher (config/transcribe/merge/generate/...)
│   ├── api_clients.py       # Claude + Groq preko stdlib urllib + certifi
│   ├── docx_generator.py    # generator zapisnika (iz desktop verzije)
│   ├── sections.py          # schema sekcija
│   └── corrections.py       # post-Whisper korekcije
└── assets/
    ├── web/                 # UI (index.html, static/app.js, ...)
    └── pydata/              # template .docx + examples.json (kopira se na uređaj)
```

## Šta ti treba prije builda

- **API ključevi** (unose se u aplikaciji, ne u kodu):
  - `ANTHROPIC_API_KEY` — za sređivanje teksta i čitanje naredbe (console.anthropic.com)
  - `GROQ_API_KEY` — za diktiranje/Whisper (besplatan: console.groq.com → API Keys)
  - Napomena: browser Web Speech NE radi u WebView-u, pa je **Groq ključ obavezan za diktiranje**.

## Build — opcija 1: GitHub Actions (preporučeno, bez instaliranja Android Studija)

1. Napravi privatni GitHub repo i push-uj ovaj folder.
2. Actions se pokrene automatski (ili ručno: tab **Actions → Build APK → Run workflow**).
3. Kad završi, skini **`diktafon-obdukcija-debug`** artifact → unutra je `app-debug.apk`.
4. Prebaci `.apk` na telefon i instaliraj (vidi „Sideload" niže).

> CI pravi *debug* APK — savršen za ličnu upotrebu i sideload, ne treba potpisivanje za Play Store.

## Build — opcija 2: Android Studio (lokalno)

1. Instaliraj Android Studio (uključuje JDK i Android SDK).
2. **File → Open** → izaberi ovaj folder `DiktafonObdukcija`.
3. Android Studio sam generiše Gradle wrapper i skine zavisnosti (prvi put traje).
4. **Build → Build App Bundle(s) / APK(s) → Build APK(s)**.
5. APK je u `app/build/outputs/apk/debug/app-debug.apk`.

> Prvi build skida Chaquopy Python runtime + lxml/certifi prebuilt — treba internet.

## Sideload (instalacija na Samsung S25 Ultra)

1. Prebaci `app-debug.apk` na telefon (USB, OneDrive, email…).
2. Otvori fajl u **My Files** → tapni za instalaciju.
3. Android će tražiti dozvolu „Instaliraj nepoznate aplikacije" za tu app (My Files/Chrome) — odobri.
4. Pri prvom pokretanju:
   - Dozvoli **mikrofon**.
   - Otvore se **Postavke** — unesi API ključeve → Sačuvaj (app se zatvori, otvori je ponovo).
5. Diktiraj kao i do sada. Generisani `.docx` ide u **Download**.

## Napomene / ograničenja

- Prvi build je najrizičniji dio (Chaquopy + zavisnosti). Ako pukne, greška je obično u
  rezoluciji `python-docx`/`lxml`/`certifi` ili SDK komponenti — javi log pa popravimo.
- Ključevi se mijenjaju u Postavkama; pošto se čitaju pri startu, app se zatvori i otvori ponovo.
- Template i `examples.json` su ugrađeni u APK; promjena template-a = novi build.
- ABI: `arm64-v8a` (S25 Ultra) + `x86_64` (emulator).
