// === Diktafon obdukcija — frontend ===

const STATE = {
  config: null,
  header: {},
  sections: {},          // section_id -> { raw, final }
  recording: null,       // {section_id, target ('raw'|'final'), mediaRecorder, chunks}
  webSpeechRecog: null,
  currentDraftId: null,
  lastKnownServerTs: 0,
  // Pamti original Whisper output po (section_id, item_idx) — za auto-učenje korekcija
  // Key format: "single:s5_mozak:raw" ili "item:s3_povrede:0:raw"
  whisperOriginals: {},
};

// Helper: vrati definiciju sekcije iz config-a
function getSectionDef(sid) {
  return STATE.config && STATE.config.sections.find(s => s.id === sid);
}

// Helper: ensure section state object postoji u pravom formatu
// Single section: { raw: "", final: "" }
// Multi section:  { items: [{ raw: "", final: "" }, ...] }
function getSection(sid) {
  const def = getSectionDef(sid);
  const isMulti = def && def.multi;
  if (!STATE.sections[sid]) {
    STATE.sections[sid] = isMulti
      ? { items: [{ raw: "", final: "" }] }
      : { raw: "", final: "" };
  }
  // Pretvori između formata ako je promijenjen
  if (isMulti && !Array.isArray(STATE.sections[sid].items)) {
    const old = STATE.sections[sid];
    const text = (old.final || old.raw || "").trim();
    STATE.sections[sid] = {
      items: text
        ? text.split(/\n+/).filter(Boolean).map(t => ({ raw: "", final: t }))
        : [{ raw: "", final: "" }],
    };
  }
  if (!isMulti && Array.isArray(STATE.sections[sid].items)) {
    const items = STATE.sections[sid].items;
    STATE.sections[sid] = {
      raw: items.map(it => it.raw).filter(Boolean).join("\n"),
      final: items.map(it => it.final).filter(Boolean).join("\n"),
    };
  }
  return STATE.sections[sid];
}

// Backward compat — stari format mogao biti string ili {raw, final} čak i za multi
function migrateSectionState() {
  for (const sid in STATE.sections) {
    const v = STATE.sections[sid];
    if (typeof v === "string") {
      STATE.sections[sid] = { raw: "", final: v };
    }
  }
  // getSection će se dalje pobrinuti za single ↔ multi konverziju
}

// Multi-helpers
function addItem(sid) {
  const sec = getSection(sid);
  if (!sec.items) return;
  sec.items.push({ raw: "", final: "" });
  autoSave();
}
function removeItem(sid, idx) {
  const sec = getSection(sid);
  if (!sec.items || sec.items.length === 0) return;
  sec.items.splice(idx, 1);
  if (sec.items.length === 0) sec.items.push({ raw: "", final: "" });
  autoSave();
}
function getItem(sid, idx) {
  const sec = getSection(sid);
  if (!sec.items || idx < 0 || idx >= sec.items.length) return null;
  return sec.items[idx];
}

// Multi-draft storage
const STORAGE_INDEX_KEY = "diktafon_drafts_index_v2";
const STORAGE_DRAFT_PREFIX = "diktafon_draft_v2_";
const STORAGE_CURRENT_KEY = "diktafon_current_draft_v2";

// Legacy keys (za migraciju)
const LEGACY_DRAFT_KEY = "diktafon_obdukcija_draft_v1";
const LEGACY_AUTOSAVE_KEY = "diktafon_obdukcija_autosave_v1";

// === Draft storage layer ===
// Strategija: server je primarni izvor istine, localStorage je offline cache.
// - listDrafts() vraća iz cache-a (sinhrono); refreshDraftsFromServer() ažurira cache async
// - persistDraft() radi paralelno: localStorage cache + PUT na server
// - loadDraftById() pokušaj servera prvo, fallback na cache
// - sve UI funkcije koje su sinhrone (renderiraju iz cache-a) i dalje rade kao prije

const SERVER_DRAFTS_AVAILABLE = true;  // Postavi false ako server endpointi padnu

function listDrafts() {
  // Vraća cache iz localStorage (sinhrono za UI)
  try {
    const raw = localStorage.getItem(STORAGE_INDEX_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) : [];
  } catch { return []; }
}

function saveDraftsIndex(list) {
  localStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(list));
}

async function refreshDraftsFromServer() {
  // Povuci sa servera, ažuriraj localStorage cache
  try {
    const serverList = await api("/api/drafts");
    if (!Array.isArray(serverList)) return null;
    const localList = listDrafts();
    // Spoji: ako lokalni nema neki server draft, dodaj
    // Ako server ima noviju verziju, ažuriraj entry u indexu (ali sadržaj se učita on-demand)
    const merged = [];
    const serverIds = new Set();
    for (const sd of serverList) {
      serverIds.add(sd.id);
      merged.push({ id: sd.id, name: sd.name, updatedAt: sd.updatedAt, syncedAt: sd.updatedAt });
    }
    // Drafti koji su SAMO u localStorage (još uplodovani na server) — zadrži ih
    for (const ld of localList) {
      if (!serverIds.has(ld.id)) {
        merged.push({ ...ld, localOnly: true });
      }
    }
    saveDraftsIndex(merged);
    return merged;
  } catch (err) {
    console.warn("refreshDraftsFromServer:", err.message);
    return null;
  }
}

function getCurrentDraftId() {
  return localStorage.getItem(STORAGE_CURRENT_KEY) || null;
}

function setCurrentDraftId(id) {
  if (id) localStorage.setItem(STORAGE_CURRENT_KEY, id);
  else localStorage.removeItem(STORAGE_CURRENT_KEY);
}

function generateDraftId() {
  return "d_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function autoDraftName(header) {
  // Konvencija foldera predmeta: "Ime Prezime - T09 0 KTA broj"
  // (isti format kao folder u OneDrive/Sudska medicina/Vještačenja/...)
  const ime = (header.ime_prezime || "").trim();
  const kt = (header.kt_broj || "").trim();
  // Vrijednost polja može biti: pun broj ("T09 0 KT ..."), broj sa oznakom
  // ("KTA 0207907 26" / "KT ..."), ili goli broj (stari drafti → istorijski KTA)
  const ktU = kt.toUpperCase();
  const ktFull = !kt ? ""
    : ktU.startsWith("T") ? kt
    : ktU.startsWith("KT") ? `T09 0 ${kt}`
    : `T09 0 KTA ${kt}`;
  if (ime && ktFull) return `${ime} - ${ktFull}`;
  if (ime) return ime;
  if (ktFull) return ktFull;
  const d = new Date();
  return `Draft ${d.toLocaleDateString("bs-BA")} ${d.toTimeString().slice(0, 5)}`;
}

function loadDraftLocal(id) {
  try {
    const raw = localStorage.getItem(STORAGE_DRAFT_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function loadDraftById(id) {
  // Pokušaj server prvi, fallback na localStorage
  try {
    const data = await api(`/api/drafts/${encodeURIComponent(id)}`);
    if (data && data.id) {
      // Ažuriraj cache
      localStorage.setItem(STORAGE_DRAFT_PREFIX + id, JSON.stringify(data));
      return data;
    }
  } catch (err) {
    console.warn("loadDraftById server fail, fallback na localStorage:", err.message);
  }
  return loadDraftLocal(id);
}

function persistDraft(id, name, header, sections) {
  const data = { id, name, header, sections, updatedAt: Date.now() };
  // Lokalni cache (uvijek)
  localStorage.setItem(STORAGE_DRAFT_PREFIX + id, JSON.stringify(data));
  // Ažuriraj index
  const idx = listDrafts();
  const existing = idx.find(d => d.id === id);
  if (existing) {
    existing.name = name;
    existing.updatedAt = data.updatedAt;
    delete existing.localOnly;
  } else {
    idx.push({ id, name, updatedAt: data.updatedAt });
  }
  saveDraftsIndex(idx);
  // Server upload (async, fire-and-forget — ne blokira UI)
  if (SERVER_DRAFTS_AVAILABLE) {
    pushDraftToServer(id, data).catch(err => {
      console.warn("Upload na server pao:", err.message);
      // Ostani local-only — pokušaj ponovo kasnije
      const idx2 = listDrafts();
      const e = idx2.find(d => d.id === id);
      if (e) { e.localOnly = true; saveDraftsIndex(idx2); }
    });
  }
}

async function pushDraftToServer(id, data) {
  return api(`/api/drafts/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: data.name,
      header: data.header,
      sections: data.sections,
      updatedAt: data.updatedAt,
    }),
  });
}

function deleteDraft(id) {
  localStorage.removeItem(STORAGE_DRAFT_PREFIX + id);
  saveDraftsIndex(listDrafts().filter(d => d.id !== id));
  if (getCurrentDraftId() === id) setCurrentDraftId(null);
  // Brisanje na serveru (async)
  if (SERVER_DRAFTS_AVAILABLE) {
    api(`/api/drafts/${encodeURIComponent(id)}`, { method: "DELETE" })
      .catch(err => console.warn("Brisanje na serveru palo:", err.message));
  }
}

function createNewDraft(name) {
  const id = generateDraftId();
  const now = Date.now();
  persistDraft(id, name || autoDraftName({}), {}, {});
  setCurrentDraftId(id);
  return id;
}

const LEGACY_MIGRATION_FLAG = "diktafon_legacy_migrated_v2";

function migrateLegacyDraft() {
  // Izvrši migraciju samo JEDNOM (flag u localStorage), pa očisti legacy ključeve
  // da se ne ponove pri svakom otvaranju stranice
  if (localStorage.getItem(LEGACY_MIGRATION_FLAG) === "done") return;

  for (const key of [LEGACY_AUTOSAVE_KEY, LEGACY_DRAFT_KEY]) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      if (data && (data.header || data.sections)) {
        const id = generateDraftId();
        const name = autoDraftName(data.header || {}) + " (importovan)";
        persistDraft(id, name, data.header || {}, data.sections || {});
        if (key === LEGACY_AUTOSAVE_KEY) setCurrentDraftId(id);
        console.log("Migracija: importovan legacy draft kao", name);
      }
    } catch {}
    // Obriši legacy ključ da se ne migrira ponovo
    localStorage.removeItem(key);
  }
  // Postavi flag da migracija ne ponavlja
  localStorage.setItem(LEGACY_MIGRATION_FLAG, "done");
}

// === API helpers (Android: bez servera — sve ide kroz native most na Python) ===
async function api(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const { endpoint, payload } = await mapPathToCall(path, method, options.body);
  const res = await nativeCall(endpoint, payload);
  if (res && res.__error) {
    throw new Error(`${res.status}: ${res.detail}`);
  }
  return res;
}

// Mapira stari fetch path/method/body na (endpoint, payload) za Python dispatch.
async function mapPathToCall(path, method, body) {
  // /api/drafts/{id}
  const draftMatch = path.match(/^\/api\/drafts\/(.+)$/);
  if (draftMatch) {
    const id = decodeURIComponent(draftMatch[1]);
    if (method === "GET") return { endpoint: "draft_get", payload: { id } };
    if (method === "DELETE") return { endpoint: "draft_delete", payload: { id } };
    if (method === "PUT") {
      const data = body ? JSON.parse(body) : {};
      return { endpoint: "draft_put", payload: { id, ...data } };
    }
  }
  switch (path) {
    case "/api/config":
      return { endpoint: "config", payload: {} };
    case "/api/drafts":
      return { endpoint: "drafts_list", payload: {} };
    case "/api/corrections":
      return { endpoint: "corrections_list", payload: {} };
    case "/api/corrections/manage":
      return { endpoint: "corrections_manage", payload: JSON.parse(body || "{}") };
    case "/api/cleanup":
      return { endpoint: "cleanup", payload: JSON.parse(body || "{}") };
    case "/api/merge":
      return { endpoint: "merge", payload: JSON.parse(body || "{}") };
    case "/api/log_correction":
      return { endpoint: "log_correction", payload: JSON.parse(body || "{}") };
    case "/api/transcribe": {
      // body je FormData: "audio" (blob) + "section_id"
      const audio = body.get("audio");
      const section_id = body.get("section_id") || "";
      const audio_b64 = await blobToBase64(audio);
      const content_type = (audio && audio.type) || "audio/webm";
      return { endpoint: "transcribe", payload: { audio_b64, content_type, section_id } };
    }
    case "/api/extract_naredba": {
      // body je FormData: "file"
      const file = body.get("file");
      const file_b64 = await blobToBase64(file);
      return {
        endpoint: "extract_naredba",
        payload: {
          file_b64,
          content_type: (file && file.type) || "",
          filename: (file && file.name) || "",
        },
      };
    }
  }
  throw new Error("Nepoznata ruta za most: " + method + " " + path);
}

// === Native most: JS → Kotlin → Python (asinhrono preko __nativeResolve callback-a) ===
window.__nativePending = window.__nativePending || {};
window.__nativeSeq = window.__nativeSeq || 0;
window.__nativeResolve = function (reqId, b64) {
  const p = window.__nativePending[reqId];
  if (!p) return;
  delete window.__nativePending[reqId];
  try {
    // b64 (UTF-8 JSON) → string
    const json = decodeURIComponent(escape(atob(b64)));
    p.resolve(JSON.parse(json));
  } catch (e) {
    p.reject(e);
  }
};
function nativeCall(endpoint, payload) {
  return new Promise((resolve, reject) => {
    if (!window.AndroidBridge || typeof window.AndroidBridge.call !== "function") {
      reject(new Error("Native most nije dostupan (AndroidBridge)."));
      return;
    }
    const reqId = "r" + (++window.__nativeSeq) + "_" + Math.floor(performance.now());
    window.__nativePending[reqId] = { resolve, reject };
    try {
      window.AndroidBridge.call(reqId, endpoint, JSON.stringify(payload || {}));
    } catch (e) {
      delete window.__nativePending[reqId];
      reject(e);
    }
  });
}

// Blob/File → base64 (bez data: prefiksa)
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result || "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// === UI helpers ===
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

let toastTimer = null;
function toast(msg, type = "info") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast";
  if (type === "error") t.classList.add("error");
  if (type === "success") t.classList.add("success");
  t.classList.remove("hidden");
  // Restart slide-in animacije pri svakom toastu (promjena klase je ne retriggeruje)
  t.style.animation = "none"; void t.offsetWidth; t.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3500);
}

// === Vlastiti dijalog (zamjena za nativni confirm/prompt) ===
// Nativni WebView confirm/prompt iznad poruke ispisuje "The page at https://appassets..."
// — to je Androidova zaštita za web-stranice, kod nas samo smeta. Ovaj modal je u stilu
// aplikacije (tamna tema, bosanski, naša dugmad) i taj prefiks se ne pojavljuje.
function uiConfirm(message, opts = {}) {
  const {
    title = "Potvrda",
    okText = "U redu",
    cancelText = "Otkaži",
    danger = false,
  } = opts;
  return new Promise(resolve => {
    const ov = document.createElement("div");
    ov.className = "dlg-overlay";
    ov.innerHTML = `
      <div class="dlg-box" role="dialog" aria-modal="true">
        <div class="dlg-title">${escapeHtml(title)}</div>
        <div class="dlg-msg">${escapeHtml(message)}</div>
        <div class="dlg-actions">
          <button class="btn-secondary" data-dlg-cancel>${escapeHtml(cancelText)}</button>
          <button class="${danger ? "btn-danger-solid" : "btn-primary"}" data-dlg-ok>${escapeHtml(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const done = (val) => { if (ov.parentElement) ov.parentElement.removeChild(ov); resolve(val); };
    ov.querySelector("[data-dlg-ok]").addEventListener("click", () => done(true));
    ov.querySelector("[data-dlg-cancel]").addEventListener("click", () => done(false));
    ov.addEventListener("click", e => { if (e.target === ov) done(false); });
    setTimeout(() => { const b = ov.querySelector("[data-dlg-ok]"); if (b) b.focus(); }, 30);
  });
}

function uiPrompt(message, defaultValue = "", opts = {}) {
  const { title = "Unos", okText = "Sačuvaj", cancelText = "Otkaži" } = opts;
  return new Promise(resolve => {
    const ov = document.createElement("div");
    ov.className = "dlg-overlay";
    ov.innerHTML = `
      <div class="dlg-box" role="dialog" aria-modal="true">
        <div class="dlg-title">${escapeHtml(title)}</div>
        <div class="dlg-msg">${escapeHtml(message)}</div>
        <input class="dlg-input" type="text" />
        <div class="dlg-actions">
          <button class="btn-secondary" data-dlg-cancel>${escapeHtml(cancelText)}</button>
          <button class="btn-primary" data-dlg-ok>${escapeHtml(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const input = ov.querySelector(".dlg-input");
    input.value = defaultValue;
    const done = (val) => { if (ov.parentElement) ov.parentElement.removeChild(ov); resolve(val); };
    ov.querySelector("[data-dlg-ok]").addEventListener("click", () => done(input.value));
    ov.querySelector("[data-dlg-cancel]").addEventListener("click", () => done(null));
    ov.addEventListener("click", e => { if (e.target === ov) done(null); });
    input.addEventListener("keydown", e => { if (e.key === "Enter") done(input.value); });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

function setStatus(text, level = "") {
  const b = $("#status-badge");
  b.textContent = text;
  b.className = "status " + level;
}

// === Izuzeti uzorci — check-lista (3 grupe) + ručni unos + Claude sažimanje ===
const IZUZETI_GROUPS = [
  { id: "g0", title: "Daktiloskopija / mikrotragovi / dlake / nokti", manual: true,
    items: ["papilarne linije", "uzorak krvi za DNA", "mikro tragovi lica", "mikro tragovi odjeće",
            "mikro tragovi obje šake", "kose tjemenog dijela", "kose čeone regije",
            "dlake stidne regije", "nokti sa obje šake"] },
  { id: "g1", title: "Toksikologija", manual: false,
    items: ["krv", "urin", "očna vodica", "žuč", "želučani sadržaj"] },
  { id: "g2", title: "Patohistološka analiza", manual: true,
    items: ["mozak", "pluća", "srce", "jetra", "bubrezi", "gušterača", "slezena"] },
];
const DEFAULT_IZUZETI_SENTENCE = "Tokom obdukcije izuzeti uzorci: papilarnih linija, " +
  "uzorak krvi za DNA te uzorci krvi, očne vodice, urina, žući i želučanog sadržaja za " +
  "analizu na alkohol i psihoaktivne supstance. Svi uzorci predani krim-tehničaru na dalje postupanje.";

function izuzetiInitState() {
  // Novi/prazan nalaz → NIJEDAN uzorak nije selektovan (korisnik bira šta je izuzeto)
  if (!STATE.header.izuzeti_checked) STATE.header.izuzeti_checked = {};
  if (!STATE.header.izuzeti_manual) STATE.header.izuzeti_manual = {};
}
// Eksplicitan reset — ništa nije selektovano (0)
function izuzetiResetDefaults() {
  STATE.header.izuzeti_checked = {};
  STATE.header.izuzeti_manual = {};
  STATE.header.izuzeti_uzorci = "";
}

function izuzetiCollect(g) {
  const items = g.items.filter(it => STATE.header.izuzeti_checked[it]);
  const man = ((STATE.header.izuzeti_manual || {})[g.id] || "").trim();
  if (man) man.split(",").forEach(m => { if (m.trim()) items.push(m.trim()); });
  return items;
}

// Deterministički sastavi tekst iz selekcije (osnova; Claude ga može doraditi)
function composeIzuzeti() {
  const g0 = izuzetiCollect(IZUZETI_GROUPS[0]);
  const g1 = izuzetiCollect(IZUZETI_GROUPS[1]);
  const g2 = izuzetiCollect(IZUZETI_GROUPS[2]);
  const segs = [];
  if (g0.length) segs.push("Tokom obdukcije izuzeti uzorci: " + g0.join(", "));
  if (g1.length) segs.push((segs.length ? "za toksikološku analizu izuzeti: " : "Za toksikološku analizu izuzeti: ") + g1.join(", "));
  if (g2.length) segs.push((segs.length ? "za patohistološku analizu izuzeti: " : "Za patohistološku analizu izuzeti: ") + g2.join(", "));
  let s;
  if (segs.length) s = segs.join("; ") + ". Svi uzorci predani krim-tehničaru na dalje postupanje.";
  else s = "Nisu izuzeti uzorci za dodatne pretrage.";
  STATE.header.izuzeti_uzorci = s;
  return s;
}

function izuzetiSelectedText() {
  const parts = [];
  for (const g of IZUZETI_GROUPS) {
    const items = izuzetiCollect(g);
    if (items.length) parts.push(g.title + ": " + items.join(", "));
  }
  return parts.join(". ");
}

function buildIzuzetiChecklist(f) {
  izuzetiInitState();
  const wrap = document.createElement("div");
  wrap.className = "field izuzeti-checklist";
  let html = `<label>${escapeHtml(f.label)}</label>`;
  for (const g of IZUZETI_GROUPS) {
    html += `<div class="izuzeti-group"><div class="izuzeti-gtitle">${escapeHtml(g.title)}</div><div class="izuzeti-items">`;
    for (const it of g.items) {
      const ck = STATE.header.izuzeti_checked[it] ? "checked" : "";
      html += `<label class="izuzeti-chk"><input type="checkbox" data-izuzeti-item="${escapeAttr(it)}" ${ck}><span>${escapeHtml(it)}</span></label>`;
    }
    html += `</div>`;
    if (g.manual) {
      const mv = (STATE.header.izuzeti_manual[g.id]) || "";
      html += `<input type="text" class="izuzeti-manual" data-izuzeti-manual="${g.id}" placeholder="+ ručno (odvoji zarezom)" value="${escapeAttr(mv)}">`;
    }
    html += `</div>`;
  }
  html += `<button type="button" class="btn-cleanup" id="btn-izuzeti-sazmi">✨ Sažmi (Claude)</button>`;
  html += `<label class="field-label" style="margin-top:10px;">Tekst (ide u zapisnik):</label>`;
  const composed = STATE.header.izuzeti_uzorci || composeIzuzeti();
  html += `<textarea class="dict-textarea" id="izuzeti-preview" data-header-id="izuzeti_uzorci">${escapeHtml(composed)}</textarea>`;
  wrap.innerHTML = html;
  return wrap;
}

function refreshIzuzetiPreview() {
  composeIzuzeti();
  const pv = $("#izuzeti-preview");
  if (pv) { pv.value = STATE.header.izuzeti_uzorci; autoGrow(pv); }
  updateHeaderSummary();
  autoSave();
}

async function sazmiIzuzeti(btn) {
  if (!STATE.config.claude_available) { toast("Claude nije konfigurisan", "error"); return; }
  // SAMO izabrano (deterministički), pa Claude SREDI (ne dodaje ništa — npr. ne dodaje DNA sam)
  const composed = composeIzuzeti();
  if (!composed.trim()) { toast("Nijedan uzorak nije izabran"); return; }
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ Sažimam...";
  try {
    const res = await api("/api/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: composed, section_title: "Izuzeti uzorci" }),
    });
    STATE.header.izuzeti_uzorci = (res.text || "").trim();
    const pv = $("#izuzeti-preview");
    if (pv) { pv.value = STATE.header.izuzeti_uzorci; autoGrow(pv); }
    updateHeaderSummary();
    autoSave();
    toast("Sažeto ✓", "success");
  } catch (err) {
    toast("Greška: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

function countIzuzetiSelected() {
  let n = 0;
  for (const g of IZUZETI_GROUPS) n += izuzetiCollect(g).length;
  return n;
}

// Kompaktno dugme u zaglavlju — otvara check-listu u fokus-prozoru
function buildIzuzetiOpener() {
  izuzetiInitState();
  const wrap = document.createElement("div");
  wrap.className = "field izuzeti-opener-field";
  const n = countIzuzetiSelected();
  wrap.innerHTML = `
    <button type="button" class="btn-izuzeti-open" id="btn-izuzeti-open">
      <span>🧪 Izuzeti uzorci</span>
      <span class="izuzeti-count">${n} izabrano ›</span>
    </button>`;
  return wrap;
}

function bindIzuzetiEvents(scope) {
  scope.querySelectorAll("[data-izuzeti-item]").forEach(cb => {
    cb.addEventListener("change", () => {
      STATE.header.izuzeti_checked[cb.dataset.izuzetiItem] = cb.checked;
      refreshIzuzetiPreview();
    });
  });
  scope.querySelectorAll("[data-izuzeti-manual]").forEach(inp => {
    inp.addEventListener("input", () => {
      STATE.header.izuzeti_manual[inp.dataset.izuzetiManual] = inp.value;
      refreshIzuzetiPreview();
    });
  });
  const sazmiBtn = scope.querySelector("#btn-izuzeti-sazmi");
  if (sazmiBtn) sazmiBtn.addEventListener("click", () => sazmiIzuzeti(sazmiBtn));
  const pv = scope.querySelector("#izuzeti-preview");
  if (pv) {
    pv.addEventListener("input", () => {
      STATE.header.izuzeti_uzorci = pv.value;
      autoGrow(pv);
      autoSave();
    });
    autoGrow(pv);
  }
}

function openIzuzetiOverlay() {
  closeIzuzetiOverlay();
  const ov = document.createElement("div");
  ov.className = "fs-overlay";
  ov.id = "izuzeti-overlay";
  ov.innerHTML = `
    <div class="fs-overlay-header">
      <span class="fs-overlay-title">🧪 Izuzeti uzorci</span>
      <button class="fs-overlay-close" id="izuzeti-close">✕</button>
    </div>`;
  const obody = document.createElement("div");
  obody.className = "fs-overlay-body";
  obody.appendChild(buildIzuzetiChecklist({ label: "" }));
  ov.appendChild(obody);
  document.body.appendChild(ov);
  document.body.classList.add("has-fullscreen");
  bindIzuzetiEvents(ov);
  const closeBtn = ov.querySelector("#izuzeti-close");
  if (closeBtn) closeBtn.addEventListener("click", closeIzuzetiOverlay);
}

function closeIzuzetiOverlay() {
  const ov = document.getElementById("izuzeti-overlay");
  if (ov) ov.remove();
  document.body.classList.remove("has-fullscreen");
  const cnt = document.querySelector("#btn-izuzeti-open .izuzeti-count");
  if (cnt) cnt.textContent = countIzuzetiSelected() + " izabrano ›";
}

// Switch "Uviđaj": ručni prelaz između (a) okolnosti iz naredbe (Claude popunjava) i
// (b) ličnog uviđaja (ti diktiraš/upisuješ — Auto-popuni NE smije prebrisati).
function buildUvidjajSwitch() {
  const on = !!STATE.header.uvidjaj_lock;
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.innerHTML = `
    <button type="button" id="uvidjaj-switch" class="uvidjaj-switch ${on ? 'active' : ''}" aria-pressed="${on}">
      <span class="uvidjaj-knob"></span>
      <span class="uvidjaj-text">${on
        ? '📍 UVIĐAJ — lično prisustvo (Claude ne dira)'
        : '📄 Okolnosti iz naredbe (Claude popunjava)'}</span>
    </button>
    <div class="extract-hint">${on
      ? 'Ti upisuješ/diktiraš uviđaj — Auto-popuni ga neće prebrisati.'
      : 'Auto-popuni iz naredbe puni ovo polje. Uključi za lični uviđaj.'}</div>`;
  return wrap;
}

// Dugmad ispod polja okolnosti/uviđaja: 🎤 diktiranje (Groq) + ✨ Doradi (Claude cleanup).
// === Okolnosti / Uviđaj — kompaktno dugme + fokus-prozor (jedna ćelija u zapisniku) ===
function okolnostiSnippet() {
  const txt = (STATE.header.okolnosti || "").trim();
  return txt ? (txt.length > 42 ? txt.slice(0, 42) + "…" : txt) : "(prazno)";
}
function buildOkolnostiOpener() {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const label = STATE.header.okolnosti_label || "Okolnosti slučaja";
  wrap.innerHTML = `
    <button type="button" class="btn-izuzeti-open" id="btn-okolnosti-open">
      <span>📋 ${escapeHtml(label)}</span>
      <span class="izuzeti-count">${escapeHtml(okolnostiSnippet())} ›</span>
    </button>`;
  return wrap;
}
function updateOkolnostiOpener() {
  const btn = document.getElementById("btn-okolnosti-open");
  if (!btn) return;
  const label = STATE.header.okolnosti_label || "Okolnosti slučaja";
  btn.innerHTML = `<span>📋 ${escapeHtml(label)}</span>` +
    `<span class="izuzeti-count">${escapeHtml(okolnostiSnippet())} ›</span>`;
}
function openOkolnostiOverlay() {
  closeOkolnostiOverlay();
  const label = STATE.header.okolnosti_label || "Okolnosti slučaja";
  const ov = document.createElement("div");
  ov.className = "fs-overlay";
  ov.id = "okolnosti-overlay";
  ov.innerHTML = `
    <div class="fs-overlay-header">
      <span class="fs-overlay-title" id="okolnosti-ov-title">${escapeHtml(label)}</span>
      <button class="fs-overlay-close" id="okolnosti-close">✕</button>
    </div>`;
  const obody = document.createElement("div");
  obody.className = "fs-overlay-body";
  obody.appendChild(buildUvidjajSwitch());
  const taWrap = document.createElement("div");
  taWrap.className = "field";
  taWrap.innerHTML = `<textarea class="dict-textarea" id="okolnosti-fs-ta" data-header-id="okolnosti" placeholder="Opiši okolnosti / uviđaj…">${escapeHtml(STATE.header.okolnosti || "")}</textarea>`;
  obody.appendChild(taWrap);
  ov.appendChild(obody);
  // Donja traka kao kod sekcija: mikrofon + Doradi
  const bar = document.createElement("div");
  bar.className = "okolnosti-actionbar";
  bar.innerHTML = `
    <button type="button" id="okolnosti-mic" class="btn-mic">🎤 Diktiraj</button>
    <button type="button" id="okolnosti-cleanup" class="btn-cleanup">✨ Doradi (Claude)</button>`;
  ov.appendChild(bar);
  document.body.appendChild(ov);
  document.body.classList.add("has-fullscreen");
  bindOkolnostiOverlay(ov);
}
function closeOkolnostiOverlay() {
  const ov = document.getElementById("okolnosti-overlay");
  if (ov) ov.remove();
  document.body.classList.remove("has-fullscreen");
  updateOkolnostiOpener();
}
function bindOkolnostiOverlay(ov) {
  const close = ov.querySelector("#okolnosti-close");
  if (close) close.addEventListener("click", closeOkolnostiOverlay);
  const ta = ov.querySelector("#okolnosti-fs-ta");
  if (ta) {
    ta.addEventListener("input", () => {
      STATE.header.okolnosti = ta.value;
      autoGrow(ta);
      updateHeaderSummary();
      autoSave();
    });
    autoGrow(ta);
  }
  const sw = ov.querySelector("#uvidjaj-switch");
  if (sw) sw.addEventListener("click", () => {
    const now = !STATE.header.uvidjaj_lock;
    STATE.header.uvidjaj_lock = now;
    STATE.header.okolnosti_label = now ? "Uviđaj" : "Okolnosti slučaja";
    autoSave();
    openOkolnostiOverlay();  // ponovo izgradi sa novim modom (tekst ostaje)
    toast(now
      ? "Uviđaj UKLJUČEN — Auto-popuni neće dirati okolnosti"
      : "Okolnosti se popunjavaju iz naredbe", "success");
  });
  const mic = ov.querySelector("#okolnosti-mic");
  if (mic) mic.addEventListener("click", () => toggleOkolnostiMic(mic));
  const dor = ov.querySelector("#okolnosti-cleanup");
  if (dor) dor.addEventListener("click", () => cleanupOkolnosti(dor));
}

function setOkolnostiMicState(btn, state) {
  if (!btn) return;
  btn.classList.remove("recording", "processing");
  if (state === "recording") { btn.classList.add("recording"); btn.textContent = "⏹ Zaustavi"; }
  else if (state === "processing") { btn.classList.add("processing"); btn.textContent = "⏳ Obrađujem..."; }
  else { btn.textContent = "🎤 Diktiraj"; }
}

function appendToOkolnosti(text) {
  if (!text) return;
  const ta = document.querySelector('textarea[data-header-id="okolnosti"]');
  const cur = (STATE.header.okolnosti || "").trim();
  STATE.header.okolnosti = cur ? cur + " " + text.trim() : text.trim();
  if (ta) { ta.value = STATE.header.okolnosti; autoGrow(ta); ta.scrollTop = ta.scrollHeight; }
  updateHeaderSummary();
  autoSave();
}

async function toggleOkolnostiMic(btn) {
  // Ako već snima — zaustavi
  if (STATE.recording && STATE.recording.okolnosti) {
    if (STATE.recording.mediaRecorder) STATE.recording.mediaRecorder.stop();
    return;
  }
  if (!STATE.config.stt_options.includes("groq")) {
    toast("Groq nije konfigurisan (Postavke).", "error");
    return;
  }
  // Ako snima neka sekcija, zaustavi je prije pokretanja okolnosti
  // (inače bi dva recorder-a radila paralelno, a referenca na prvi bi se izgubila)
  if (STATE.recording) stopRecording();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream, { mimeType: pickMimeType() });
    const chunks = [];
    const rec = { okolnosti: true, mediaRecorder: mr, chunks };
    mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      // Guarded clear — vidi komentar u startGroqRecording (zombi mikrofon)
      if (STATE.recording === rec) { STATE.recording = null; stopRecTimer(); }
      setOkolnostiMicState(btn, "processing");
      try {
        const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
        if (blob.size < MIN_AUDIO_BYTES) {
          toast("Snimak prekratak (slučajan klik?) — ništa nije poslano", "error");
          return;  // finally ispod vraća dugme na idle
        }
        const fd = new FormData();
        fd.append("audio", blob, "audio.webm");
        fd.append("section_id", "okolnosti");
        const res = await api("/api/transcribe", { method: "POST", body: fd });
        if (!(res.text || "").trim()) {
          toast("Nije prepoznat govor (tišina/prekratko) — pokušaj ponovo", "error");
        } else {
          appendToOkolnosti(res.text);
          buzz([40, 80, 40]);  // dvostruki impuls: transkript je stigao
          toast("Transkripcija ✓", "success");
        }
      } catch (err) {
        toast("Transkripcija greška: " + err.message, "error");
      } finally {
        setOkolnostiMicState(btn, "idle");
      }
    };
    mr.start();
    STATE.recording = rec;
    startRecTimer(stream);
    setOkolnostiMicState(btn, "recording");
  } catch (err) {
    toast("Greška mikrofona [" + (err.name || "?") + "]: " + err.message, "error");
    console.error(err);
  }
}

async function cleanupOkolnosti(btn) {
  if (!STATE.config.claude_available) { toast("Claude nije konfigurisan", "error"); return; }
  const text = (STATE.header.okolnosti || "").trim();
  if (!text) { toast("Nema teksta za doradu"); return; }
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ Dorađujem...";
  try {
    const label = STATE.header.okolnosti_label || "Okolnosti slučaja";
    const res = await api("/api/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, section_title: label, case_context: caseContext("okolnosti") }),
    });
    STATE.header.okolnosti = (res.text || "").trim();
    const ta = document.querySelector('textarea[data-header-id="okolnosti"]');
    if (ta) { ta.value = STATE.header.okolnosti; autoGrow(ta); }
    updateHeaderSummary();
    autoSave();
    toast("Dorađeno ✓", "success");
  } catch (err) {
    toast("Greška: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// === Render: header form ===
function renderHeaderForm() {
  const body = $("#header-body");
  body.innerHTML = "";

  // Auto-popuni dugme — uvuci podatke iz naredbe (PDF/foto)
  const extractDiv = document.createElement("div");
  extractDiv.className = "extract-naredba-box";
  extractDiv.innerHTML = `
    <div class="extract-label">📋 Auto-popuni iz naredbe</div>
    <div class="extract-buttons">
      <button class="btn-extract-icon" id="btn-naredba-camera" title="Slikaj naredbu">📷 Slikaj</button>
      <button class="btn-extract-icon" id="btn-naredba-file" title="Izaberi fajl">📁 Fajl</button>
    </div>
    <div class="extract-hint">Claude pročita naredbu (foto/PDF) i popuni polja</div>
    <input type="file" id="file-naredba-cam" accept="image/*" capture="environment" style="display:none">
    <input type="file" id="file-naredba-doc" accept="image/*,application/pdf" style="display:none">
  `;
  body.appendChild(extractDiv);

  for (const f of STATE.config.header_fields) {
    // Izuzeti uzorci → kompaktno dugme koje otvara check-listu u fokus-prozoru
    if (f.id === "izuzeti_uzorci") {
      body.appendChild(buildIzuzetiOpener());
      continue;
    }
    // Naziv polja okolnosti → unutar okolnosti fokus-prozora (postavlja ga switch)
    if (f.id === "okolnosti_label") continue;
    // Okolnosti/Uviđaj → kompaktno dugme koje otvara fokus-prozor
    if (f.id === "okolnosti") {
      body.appendChild(buildOkolnostiOpener());
      continue;
    }
    const wrap = document.createElement("div");
    wrap.className = "field";
    const label = document.createElement("label");
    label.textContent = f.label;
    wrap.appendChild(label);

    let inputHtml;
    if (f.multiline) {
      const val = STATE.header[f.id] !== undefined ? STATE.header[f.id] : (f.default || '');
      inputHtml = `<textarea data-header-id="${f.id}" placeholder="${escapeAttr(f.placeholder || '')}">${escapeHtml(val)}</textarea>`;
    } else if (f.prefix) {
      inputHtml = `
        <div class="prefix-input">
          <span>${escapeHtml(f.prefix)}</span>
          <input type="text" data-header-id="${f.id}" placeholder="${escapeAttr(f.placeholder || '')}" value="${escapeAttr(STATE.header[f.id] || '')}">
        </div>`;
    } else {
      const val = STATE.header[f.id] !== undefined ? STATE.header[f.id] : (f.default || '');
      inputHtml = `<input type="text" data-header-id="${f.id}" placeholder="${escapeAttr(f.placeholder || '')}" value="${escapeAttr(val)}">`;
    }
    const div = document.createElement("div");
    div.innerHTML = inputHtml;
    wrap.appendChild(div.firstElementChild);

    // Quick action dugmad ispod polja (today, quick_options)
    if (f.today_button || (f.quick_options && f.quick_options.length)) {
      const quickWrap = document.createElement("div");
      quickWrap.className = "field-quick-actions";
      if (f.today_button) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-quick";
        btn.textContent = "📅 Danas";
        btn.dataset.fillField = f.id;
        btn.dataset.fillValue = formatDateToday();
        quickWrap.appendChild(btn);
      }
      if (f.quick_options) {
        for (const opt of f.quick_options) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn-quick";
          btn.textContent = opt;
          btn.dataset.fillField = f.id;
          btn.dataset.fillValue = opt;
          quickWrap.appendChild(btn);
        }
      }
      wrap.appendChild(quickWrap);
    }
    body.appendChild(wrap);
  }

  // Bind input events
  body.querySelectorAll("[data-header-id]").forEach(el => {
    el.addEventListener("input", e => {
      STATE.header[e.target.dataset.headerId] = e.target.value;
      if (e.target.tagName === "TEXTAREA") autoGrow(e.target);
      updateHeaderSummary();
      autoSave();
    });
  });

  // Quick fill dugmad (Danas, predefinisani pomoćnici, ...)
  body.querySelectorAll("[data-fill-field]").forEach(btn => {
    btn.addEventListener("click", e => {
      const fid = btn.dataset.fillField;
      const value = btn.dataset.fillValue;
      STATE.header[fid] = value;
      const inp = body.querySelector(`[data-header-id="${fid}"]`);
      if (inp) inp.value = value;
      updateHeaderSummary();
      autoSave();
    });
  });

  // Switch "Uviđaj" — ručni prelaz: naredba (Claude) ↔ lični uviđaj (zaključan)
  // Okolnosti/Uviđaj — dugme koje otvara fokus-prozor
  const okOpen = body.querySelector("#btn-okolnosti-open");
  if (okOpen) okOpen.addEventListener("click", openOkolnostiOverlay);

  // Izuzeti uzorci — dugme koje otvara fokus-prozor sa check-listom
  const izOpen = body.querySelector("#btn-izuzeti-open");
  if (izOpen) izOpen.addEventListener("click", openIzuzetiOverlay);

  // Extract naredba — dvije direktne ikone (kamera / fajl), bez među-izbornika
  const camBtn = $("#btn-naredba-camera");
  const fileBtn = $("#btn-naredba-file");
  const camInput = $("#file-naredba-cam");
  const docInput = $("#file-naredba-doc");
  if (camBtn && camInput) camBtn.addEventListener("click", () => camInput.click());
  if (fileBtn && docInput) fileBtn.addEventListener("click", () => docInput.click());
  const bindNaredbaInput = (input, btn) => {
    if (!input) return;
    input.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await extractNaredba(file, btn);
      e.target.value = "";
    });
  };
  bindNaredbaInput(camInput, camBtn);
  bindNaredbaInput(docInput, fileBtn);

  updateHeaderSummary();
}

async function extractNaredba(file, btn) {
  if (!STATE.config.claude_available) {
    toast("Claude API nije konfigurisan", "error");
    return;
  }
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "⏳ Šaljem Claude-u...";
  try {
    const fd = new FormData();
    fd.append("file", file);
    const res = await api("/api/extract_naredba", { method: "POST", body: fd });
    const data = res.data || {};
    // Uviđaj mod: NE diraj okolnosti ni naziv polja — to je tvoj lični unos.
    const locked = STATE.header.uvidjaj_lock
      ? new Set(["okolnosti", "okolnosti_label"]) : new Set();
    let count = 0, skipped = 0;
    for (const key in data) {
      if (locked.has(key)) { skipped++; continue; }
      if (data[key] !== undefined && data[key] !== "") {
        STATE.header[key] = data[key];
        count++;
      }
    }
    renderHeaderForm();  // re-render sa novim vrijednostima
    autoSave();
    const lockNote = skipped ? ` (uviđaj zaključan — okolnosti netaknute)` : "";
    toast(`Popunjeno ${count} polja iz naredbe ✓${lockNote}`, "success");
  } catch (err) {
    toast("Greška: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

function updateHeaderSummary() {
  const ime = STATE.header.ime_prezime || "";
  const kt = STATE.header.kt_broj || "";
  const parts = [];
  if (ime) parts.push(ime);
  if (kt) parts.push(`KT ${kt}`);
  $("#header-summary").textContent = parts.join(" · ");
  // Pri promjeni headera, ažuriraj i naziv drafta u topbar-u
  updateDraftIndicator();
}

// === Render: dictation sections (Opcija B - kratka diktacija + Claude merge) ===
// Textarea raste sa sadržajem (visina = scrollHeight). Radi samo kad je vidljiva.
function autoGrow(ta) {
  if (!ta) return;
  // Sačuvaj poziciju skrola kontejnera — da kucanje (reset height:auto) ne "skoči" na vrh
  const sc = ta.closest(".card.fullscreen, .fs-overlay");
  const top = sc ? sc.scrollTop : 0;
  ta.style.height = "auto";
  ta.style.height = (ta.scrollHeight + 2) + "px";
  if (sc) sc.scrollTop = top;
}
function autoGrowIn(el) {
  if (!el) return;
  el.querySelectorAll("textarea").forEach(autoGrow);
}

function renderSections() {
  if (typeof exitFocus === "function") exitFocus();  // resetuj fokus pri punom renderu
  const container = $("#sections-container");
  container.innerHTML = "";
  for (const s of STATE.config.sections) {
    const card = document.createElement("section");
    card.className = "card collapsible";
    card.dataset.sectionId = s.id;

    const headerHtml = `
      <div class="card-header-row">
        <button class="card-header" data-toggle>
          <span class="caret">▸</span>
          <span class="section-status"></span>
          <span class="card-title">${escapeHtml(s.title)}</span>
        </button>
        <button class="btn-focus" data-focus title="Cijeli ekran" aria-label="Cijeli ekran">⛶</button>
      </div>
    `;
    if (s.multi) {
      card.innerHTML = headerHtml + renderMultiBody(s);
    } else {
      card.innerHTML = headerHtml + renderSingleBody(s);
    }
    container.appendChild(card);
    updateSectionStatus(s.id);
  }
  bindSectionEvents();
}

function renderSingleBody(s) {
  const sec = getSection(s.id);
  const templateText = s.template_text || s.default || "";
  // Placeholder = template tekst (skraćen ako je predug) — daje korisniku uvid šta sve sadrži ovaj dio
  const placeholderText = templateText
    ? templateText.length > 280 ? templateText.slice(0, 280) + "..." : templateText
    : (s.hint || "Diktiraj samo razlike od template-a, kratko.");

  return `
    <div class="card-body">
      <div class="seg-tabs">
        <button class="seg-tab active" data-tab="raw">Diktat</button>
        <button class="seg-tab" data-tab="final">Finalno</button>
      </div>

      <div class="tab-pane" data-pane="raw">
        ${s.hint ? `<div class="dict-hint">${escapeHtml(s.hint)}</div>` : ''}
        ${templateText ? `
          <button class="dict-default-toggle" data-show-default>📋 Prikaži pun template paragraf</button>
          <div class="dict-default" data-default-text style="display:none;">${escapeHtml(templateText)}</div>
        ` : ''}
        <textarea class="dict-textarea raw" data-section-id="${s.id}" data-target="raw"
          placeholder="${escapeAttr(placeholderText)}">${escapeHtml(sec.raw || '')}</textarea>
        <div class="dict-controls">
          <button class="btn-mic" data-mic="${s.id}" data-target="raw">
            🎤 <span class="mic-label">Diktiraj</span>
          </button>
          <button class="btn-merge" data-merge="${s.id}">🪄 Spoji</button>
          <button class="btn-clear-section" data-clear-raw="${s.id}">✕ Obriši</button>
        </div>
      </div>

      <div class="tab-pane" data-pane="final" style="display:none;">
        <textarea class="dict-textarea final" data-section-id="${s.id}" data-target="final"
          placeholder="Ovdje će se pojaviti spojen tekst nakon klika na 🪄 Spoji.">${escapeHtml(sec.final || '')}</textarea>
        <div class="dict-controls final-controls">
          <button class="btn-cleanup" data-cleanup="${s.id}">✨ Doradi</button>
          ${templateText ? `<button class="btn-use-default" data-use-default="${s.id}">↺ Vrati template</button>` : ''}
          <button class="btn-clear-section" data-clear-final="${s.id}">✕ Obriši finalni</button>
        </div>
      </div>
    </div>
  `;
}

function renderMultiBody(s) {
  const sec = getSection(s.id);
  const items = sec.items || [{ raw: "", final: "" }];
  const itemsHtml = items.map((item, idx) => renderItem(s, idx, item)).join("");
  const itemNoun = s.id === "s11_kostur" ? "prelom" :
                   s.id === "misljenje" ? "tačku mišljenja" :
                   s.id === "dodatne" ? "stavku" : "povredu";
  return `
    <div class="card-body">
      ${s.hint ? `<div class="dict-hint">${escapeHtml(s.hint)}</div>` : ''}
      <div class="items-container" data-items-for="${s.id}">${itemsHtml}</div>
      <button class="btn-add-item" data-add-item="${s.id}">+ Dodaj ${itemNoun}</button>
    </div>
  `;
}

function renderItem(s, idx, item) {
  const itemNoun = s.id === "s11_kostur" ? "Prelom" :
                   s.id === "misljenje" ? "Tačka" :
                   s.id === "dodatne" ? "Stavka" : "Povreda";
  const placeholderRaw = s.id === "s3_povrede"
    ? "Npr: oguljotina obraza 2x1 tamnocrvena"
    : s.id === "s11_kostur"
    ? "Npr: prelom desne nadlaktice"
    : s.id === "misljenje"
    ? "Npr: smrt nasilna utapanjem"
    : "Diktiraj jednu stavku...";

  return `
    <div class="item-card" data-item-idx="${idx}" data-item-section="${s.id}">
      <div class="item-header">
        <span class="item-num">${itemNoun} #${idx + 1}</span>
        <button class="btn-item-remove" data-remove-item="${s.id}" data-remove-idx="${idx}"
          title="Obriši stavku">✕</button>
      </div>

      <div class="seg-tabs">
        <button class="seg-tab active" data-tab="raw">Diktat</button>
        <button class="seg-tab" data-tab="final">Finalno</button>
      </div>

      <div class="tab-pane" data-pane="raw">
        <textarea class="dict-textarea raw item-raw" data-item-target="raw"
          data-item-section="${s.id}" data-item-idx="${idx}"
          placeholder="${escapeAttr(placeholderRaw)}">${escapeHtml(item.raw || '')}</textarea>
      </div>

      <div class="tab-pane" data-pane="final" style="display:none;">
        <textarea class="dict-textarea final item-final" data-item-target="final"
          data-item-section="${s.id}" data-item-idx="${idx}"
          placeholder="Spojen tekst stavke se pojavi ovdje.">${escapeHtml(item.final || '')}</textarea>
      </div>
    </div>
  `;
}

function bindSectionEvents(scope) {
  // scope = jedna kartica (rerenderMultiBody) ili izostavljeno = cijeli kontejner
  // (renderSections). Bez scope-a bi se pri svakom rerenderu jedne kartice listeneri
  // PONOVO dodavali i na netaknute kartice → dupli merge/transcribe pozivi (dupli trošak).
  const container = scope || $("#sections-container");

  // Tab switcher (Diktat | Finalno) — scope: stavka (item-card) ili cijela sekcija (card)
  container.querySelectorAll(".seg-tab").forEach(tab => {
    tab.addEventListener("click", () =>
      switchTab(tab.closest(".item-card") || tab.closest(".card"), tab.dataset.tab));
  });

  // Selekcija stavke (multi) — klik na stavku je čini aktivnom; donja traka radi nad njom
  container.querySelectorAll(".item-card").forEach(ic => {
    ic.addEventListener("click", (e) => {
      if (e.target.closest("[data-remove-item]")) return;  // ✕ ne selektuje
      selectFocusItem(parseInt(ic.dataset.itemIdx, 10));
    });
  });

  // (Uklonjen forsirani skrol-na-vrh pri fokusu textarea — smetao uređivanju dužih
  //  tekstova; Android adjustResize sam drži kursor iznad tastature.)

  // Single section events
  container.querySelectorAll("[data-show-default]").forEach(btn => {
    btn.addEventListener("click", e => {
      const def = e.target.parentElement.querySelector("[data-default-text]");
      const visible = def.style.display !== "none";
      def.style.display = visible ? "none" : "block";
      e.target.textContent = visible
        ? "📋 Prikaži pun template paragraf"
        : "📋 Sakrij template paragraf";
    });
  });

  // Single textareas
  container.querySelectorAll(".dict-textarea[data-target]").forEach(ta => {
    ta.addEventListener("input", e => {
      const sid = e.target.dataset.sectionId;
      const target = e.target.dataset.target;
      const sec = getSection(sid);
      sec[target] = e.target.value;
      autoGrow(e.target);
      updateSectionStatus(sid);
      autoSave();
    });
  });

  // Multi item textareas
  container.querySelectorAll(".dict-textarea[data-item-target]").forEach(ta => {
    ta.addEventListener("input", e => {
      const sid = e.target.dataset.itemSection;
      const idx = parseInt(e.target.dataset.itemIdx, 10);
      const target = e.target.dataset.itemTarget;
      const item = getItem(sid, idx);
      if (item) {
        item[target] = e.target.value;
        autoGrow(e.target);
        updateSectionStatus(sid);
        autoSave();
      }
    });
  });

  container.querySelectorAll("[data-mic]").forEach(btn => {
    btn.addEventListener("click", () => toggleRecording(btn.dataset.mic, btn.dataset.target || "raw"));
  });
  container.querySelectorAll("[data-item-mic]").forEach(btn => {
    btn.addEventListener("click", () => {
      const sid = btn.dataset.itemMic;
      const idx = parseInt(btn.dataset.itemIdx, 10);
      toggleItemRecording(sid, idx);
    });
  });

  container.querySelectorAll("[data-merge]").forEach(btn => {
    btn.addEventListener("click", () => mergeSection(btn.dataset.merge));
  });
  container.querySelectorAll("[data-item-merge]").forEach(btn => {
    btn.addEventListener("click", () => {
      const sid = btn.dataset.itemMerge;
      const idx = parseInt(btn.dataset.itemIdx, 10);
      mergeItem(sid, idx);
    });
  });

  container.querySelectorAll("[data-cleanup]").forEach(btn => {
    btn.addEventListener("click", () => cleanupSection(btn.dataset.cleanup));
  });

  container.querySelectorAll("[data-use-default]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const sid = btn.dataset.useDefault;
      const s = getSectionDef(sid);
      const tpl = s ? (s.template_text || s.default || "") : "";
      if (!tpl) return;
      if (await uiConfirm("Trenutni finalni tekst ove sekcije biće zamijenjen sadržajem iz template-a.",
          { title: "Zamijeniti finalni tekst?", okText: "Zamijeni" })) {
        const sec = getSection(sid);
        sec.final = tpl;
        const ta = document.querySelector(`textarea[data-section-id="${sid}"][data-target="final"]`);
        if (ta) ta.value = tpl;
        updateSectionStatus(sid);
        autoSave();
      }
    });
  });

  container.querySelectorAll("[data-clear-raw]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const sid = btn.dataset.clearRaw;
      if (await uiConfirm("Sirova (diktirana) verzija ove sekcije biće obrisana.",
          { title: "Obrisati sirovu diktaciju?", okText: "Obriši", danger: true })) {
        getSection(sid).raw = "";
        const ta = document.querySelector(`textarea[data-section-id="${sid}"][data-target="raw"]`);
        if (ta) ta.value = "";
        updateSectionStatus(sid);
        autoSave();
      }
    });
  });
  container.querySelectorAll("[data-clear-final]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const sid = btn.dataset.clearFinal;
      if (await uiConfirm("Finalni (dorađeni) tekst ove sekcije biće obrisan.",
          { title: "Obrisati finalni tekst?", okText: "Obriši", danger: true })) {
        getSection(sid).final = "";
        const ta = document.querySelector(`textarea[data-section-id="${sid}"][data-target="final"]`);
        if (ta) ta.value = "";
        updateSectionStatus(sid);
        autoSave();
      }
    });
  });

  // Add / remove items
  container.querySelectorAll("[data-add-item]").forEach(btn => {
    btn.addEventListener("click", () => {
      const sid = btn.dataset.addItem;
      addItem(sid);
      rerenderMultiBody(sid);
      selectFocusItem(getSection(sid).items.length - 1);  // selektuj novu stavku
      // Skroluj na novi item i fokusiraj
      setTimeout(() => {
        const sec = getSection(sid);
        const lastIdx = sec.items.length - 1;
        const ta = document.querySelector(
          `textarea[data-item-section="${sid}"][data-item-idx="${lastIdx}"][data-item-target="raw"]`
        );
        if (ta) {
          ta.scrollIntoView({ behavior: "smooth", block: "center" });
          ta.focus();
        }
      }, 50);
    });
  });
  container.querySelectorAll("[data-remove-item]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const sid = btn.dataset.removeItem;
      const idx = parseInt(btn.dataset.removeIdx, 10);
      const item = getItem(sid, idx);
      const hasContent = item && (item.raw || item.final).trim().length > 0;
      if (hasContent && !(await uiConfirm("Ova stavka ima sadržaj koji će biti obrisan.",
          { title: "Obrisati stavku?", okText: "Obriši", danger: true }))) return;
      removeItem(sid, idx);
      rerenderMultiBody(sid);
    });
  });
}

function rerenderMultiBody(sid) {
  const card = document.querySelector(`section.card[data-section-id="${sid}"]`);
  if (!card) return;
  const isOpen = card.classList.contains("open");
  const isFs = card.classList.contains("fullscreen");
  const def = getSectionDef(sid);
  const headerHtml = card.querySelector(".card-header-row").outerHTML;
  card.innerHTML = headerHtml + renderMultiBody(def);
  if (isOpen) card.classList.add("open");
  if (isFs) {
    card.classList.add("fullscreen");
    const fb = card.querySelector("[data-focus]");
    if (fb) fb.textContent = "✕";
  }
  bindSectionEvents(card);
  updateSectionStatus(sid);
  // Zadrži vizuelnu selekciju aktivne stavke (ako je ova sekcija u fokusu)
  if (STATE.focusSectionId === sid && STATE.focusItemIdx != null) {
    selectFocusItem(STATE.focusItemIdx);
  }
}

function updateSectionStatus(sectionId) {
  const card = document.querySelector(`section.card[data-section-id="${sectionId}"]`);
  if (!card) return;
  const dot = card.querySelector(".section-status");
  if (!dot) return;
  const def = getSectionDef(sectionId);
  const sec = getSection(sectionId);
  let hasRaw = false, hasFinal = false;
  if (def && def.multi && sec.items) {
    hasRaw = sec.items.some(it => (it.raw || "").trim());
    hasFinal = sec.items.some(it => (it.final || "").trim());
  } else {
    hasRaw = (sec.raw || "").trim().length > 0;
    hasFinal = (sec.final || "").trim().length > 0;
  }
  dot.classList.toggle("dictated", hasRaw && !hasFinal);
  dot.classList.toggle("cleaned", hasFinal);
}

// === Kontekst slučaja (pol, dob) za Claude merge/cleanup ===
// Sekcije se spajaju IZOLOVANO — bez ovoga Claude ne zna pol (pa template default
// "muški" pobjeđuje i kad je osoba žensko) ni dob (iako zaglavlje ima datum rođenja).
function parseDateDMY(s) {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s || "");
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  return isNaN(d.getTime()) ? null : d;
}

// Puna godina starosti na referentni datum (pronađen/preminuo; bez njega — danas)
function computeAge(rodjenStr, refStr) {
  const born = parseDateDMY(rodjenStr);
  if (!born) return null;
  const ref = parseDateDMY(refStr) || new Date();
  let age = ref.getFullYear() - born.getFullYear();
  if (ref.getMonth() < born.getMonth() ||
      (ref.getMonth() === born.getMonth() && ref.getDate() < born.getDate())) age--;
  return (age >= 0 && age <= 120) ? age : null;
}

function caseContext(excludeSid) {
  const ctx = {};
  const s = (STATE.header.spol || "").trim().toLowerCase();
  if (s.startsWith("m")) ctx.spol = "muški";
  else if (s.startsWith("ž") || s.startsWith("z") || s.startsWith("f")) ctx.spol = "ženski";
  const dob = computeAge(STATE.header.rodjen, STATE.header.pronadjen);
  if (dob != null) {
    ctx.dob_godina = dob;
    if ((STATE.header.rodjen || "").trim()) ctx.rodjen = STATE.header.rodjen.trim();
    if ((STATE.header.pronadjen || "").trim()) ctx.pronadjen = STATE.header.pronadjen.trim();
  }
  // Stanje leša (trulež, mumifikacija...) iz finalnog teksta Konstitucije — šalje se
  // SAMO ako odstupa od standardnog template teksta (običan leš = 0 dodatnih tokena)
  // i ne pri spajanju same te sekcije.
  if (excludeSid !== "s1_konstitucija") {
    const konDef = getSectionDef("s1_konstitucija");
    const kon = getSection("s1_konstitucija");
    const txt = (kon.final || "").trim();
    const tpl = konDef ? (konDef.template_text || konDef.default || "").trim() : "";
    if (txt && txt !== tpl) {
      ctx.stanje_lesa = txt.length > 240 ? txt.slice(0, 240) + "…" : txt;
    }
  }
  return ctx;
}

// Mjerenje prompt-keša: pokazuje da li Claude stvarno kešira (čita) ili samo upisuje,
// ili uopšte ne kešira (prefiks ispod min. 2048 tok na Sonnet 4.6 → tiho ništa).
function cacheTag(res) {
  if (res.cache_read) return `keš✓ ${res.cache_read} čit`;
  if (res.cache_create) return `keš upisan ${res.cache_create}`;
  return "keš: ne";
}

// === Merge (Opcija B) ===
async function mergeSection(sectionId) {
  if (!STATE.config.claude_available) {
    toast("Claude API nije konfigurisan u .env fajlu", "error");
    return;
  }
  const sec = getSection(sectionId);
  if (!sec.raw.trim()) {
    toast("Nema sirove diktacije za spajanje");
    return;
  }
  const sectionDef = STATE.config.sections.find(s => s.id === sectionId);
  if (!sectionDef) return;

  // Loguj korekciju ako je korisnik editovao Whisper output prije Spoji
  maybeLogCorrection(`single:${sectionId}:raw`, sec.raw);

  const btn = document.querySelector(`[data-merge="${sectionId}"]`);
  const oldLabel = btn.textContent;
  btn.textContent = "⏳ Spajam...";
  btn.disabled = true;
  setFocusMergeWorking(true);  // vizuelni feedback i na kokpit dugmetu
  try {
    const res = await api("/api/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw_dictation: sec.raw,
        section_id: sectionId,
        section_title: sectionDef.title || "",
        template_text: sectionDef.template_text || sectionDef.default || "",
        is_multi: !!sectionDef.multi,
        is_numbered: !!sectionDef.numbered,
        hint: sectionDef.hint || "",
        case_context: caseContext(sectionId),
      }),
    });
    sec.final = res.text;
    const finalTa = document.querySelector(`textarea[data-section-id="${sectionId}"][data-target="final"]`);
    if (finalTa) { finalTa.value = res.text; autoGrow(finalTa); }
    // Nakon spajanja prebaci na "Finalno" tab (vidiš rezultat)
    const _card = document.querySelector(`section.card[data-section-id="${sectionId}"]`);
    if (_card) switchTab(_card, "final");
    updateSectionStatus(sectionId);
    autoSave();
    toast(`Spojeno ✓ (${res.tokens_in}+${res.tokens_out} tok · ${cacheTag(res)})`, "success");
  } catch (err) {
    toast("Greška: " + err.message, "error");
  } finally {
    btn.textContent = oldLabel;
    btn.disabled = false;
    setFocusMergeWorking(false);
  }
}

// === Collapsible cards (AKORDEON — samo jedna otvorena) ===
document.addEventListener("click", e => {
  const header = e.target.closest("[data-toggle]");
  if (!header) return;
  const card = header.closest(".collapsible");
  if (!card) return;
  if (card.classList.contains("fullscreen")) return;  // u fokusu klik na naslov ne radi ništa
  const sid = card.dataset.sectionId;
  if (sid) {
    // Sekcija za diktiranje → klik DIREKTNO otvara fokus (cijeli ekran)
    enterFocus(sid);
    return;
  }
  // Zaglavlje (nema section-id) → akordeon u listi
  const willOpen = !card.classList.contains("open");
  if (willOpen) {
    document.querySelectorAll(".card.collapsible.open").forEach(c => {
      if (c !== card) c.classList.remove("open");
    });
    card.classList.add("open");
    autoGrowIn(card);
    setTimeout(() => card.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  } else {
    card.classList.remove("open");
  }
});

// === Fokus-kokpit (sekcija preko cijelog ekrana + ← → + mikrofon dole) ===
document.addEventListener("click", e => {
  const fb = e.target.closest("[data-focus]");
  if (!fb) return;
  const card = fb.closest(".card");
  if (!card) return;
  if (card.classList.contains("fullscreen")) exitFocus();
  else enterFocus(card.dataset.sectionId);
});

function shortTitle(t) {
  if (!t) return "";
  const cut = t.indexOf("(");
  let s = (cut > 0 ? t.slice(0, cut) : t).trim();
  if (s.length > 16) s = s.slice(0, 15) + "…";
  return s;
}

function enterFocus(sid) {
  // zatvori sve, otvori+fokusiraj ovu
  document.querySelectorAll(".card.collapsible.open").forEach(c => c.classList.remove("open"));
  document.querySelectorAll(".card.fullscreen").forEach(c => {
    c.classList.remove("fullscreen");
    const b = c.querySelector("[data-focus]");
    if (b) b.textContent = "⛶";
  });
  const card = document.querySelector(`section.card[data-section-id="${sid}"]`);
  if (!card) return;
  card.classList.add("open", "fullscreen");
  const fb = card.querySelector("[data-focus]");
  if (fb) fb.textContent = "✕";
  STATE.focusSectionId = sid;
  document.body.classList.add("has-fullscreen");
  const fnav = document.getElementById("focus-nav");
  if (fnav) fnav.classList.add("show");
  // Donja traka: Spoji za oba (single=sekcija, multi=selektovana stavka).
  // Lijevo dugme: single → „✕ Obriši" (raw), multi → „➕ Nova" (nova stavka).
  const sdef = (STATE.config.sections || []).find(s => s.id === sid);
  const isMulti = !!(sdef && sdef.multi);
  const fMerge = document.getElementById("focus-merge");
  const fClear = document.getElementById("focus-clear");
  if (fMerge) fMerge.style.display = "";
  if (fClear) {
    fClear.style.display = "";
    if (isMulti) { fClear.textContent = "➕ Nova"; fClear.classList.remove("danger"); }
    else { fClear.textContent = "✕ Obriši"; fClear.classList.add("danger"); }
  }
  if (isMulti) {
    const items = (getSection(sid).items || []);
    selectFocusItem(items.length > 0 ? items.length - 1 : 0);
  } else {
    STATE.focusItemIdx = null;
  }
  updateFocusNav();
  updateFocusMic();
  autoGrowIn(card);
  card.scrollTop = 0;
}

function exitFocus() {
  document.querySelectorAll(".card.fullscreen").forEach(c => {
    c.classList.remove("fullscreen", "open");  // izlaz iz fokusa → sekcija skupljena u listi
    const b = c.querySelector("[data-focus]");
    if (b) b.textContent = "⛶";
  });
  STATE.focusSectionId = null;
  document.body.classList.remove("has-fullscreen");
  const fnav = document.getElementById("focus-nav");
  if (fnav) fnav.classList.remove("show");
}

function focusGo(dir) {
  const ids = (STATE.config.sections || []).map(s => s.id);
  const i = ids.indexOf(STATE.focusSectionId);
  if (i < 0) return;
  const ni = i + dir;
  if (ni < 0 || ni >= ids.length) return;
  enterFocus(ids[ni]);
}

function updateFocusNav() {
  const secs = STATE.config.sections || [];
  const i = secs.findIndex(s => s.id === STATE.focusSectionId);
  const prev = document.getElementById("focus-prev");
  const next = document.getElementById("focus-next");
  if (prev) {
    const has = i > 0;
    prev.disabled = !has;
    prev.textContent = has ? "← " + shortTitle(secs[i - 1].title) : "←";
  }
  if (next) {
    const has = i >= 0 && i < secs.length - 1;
    next.disabled = !has;
    next.textContent = has ? shortTitle(secs[i + 1].title) + " →" : "→";
  }
}

function updateFocusMic() {
  const fm = document.getElementById("focus-mic");
  if (!fm) return;
  const rec = !!STATE.recording;
  fm.classList.toggle("recording", rec);
  if (!rec) fm.classList.remove("paused");
  fm.textContent = rec ? "⏹" : "🎤";
  updateFocusClearLabel();  // lijevo dugme: Pauza/Nastavi dok snima, inače Nova/Obriši
}

// Vizuelni feedback na kokpit "Spoji" dok Claude radi (promjena boje + tekst)
function setFocusMergeWorking(working) {
  const b = document.getElementById("focus-merge");
  if (!b) return;
  b.classList.toggle("working", working);
  b.disabled = working;
  b.textContent = working ? "⏳ Spajam..." : "🪄 Spoji";
}

// Selektuj stavku (povredu) u multi sekciji — donja traka radi nad njom; vizuelno se istakne.
function selectFocusItem(idx) {
  STATE.focusItemIdx = idx;
  const sid = STATE.focusSectionId;
  if (!sid) return;
  const card = document.querySelector(`section.card[data-section-id="${sid}"]`);
  if (!card) return;
  let target = null;
  card.querySelectorAll(".item-card").forEach(ic => {
    const sel = parseInt(ic.dataset.itemIdx, 10) === idx;
    ic.classList.toggle("selected", sel);
    if (sel) target = ic;
  });
  // Izabrana stavka ide na vrh vidljivog dijela
  if (target) setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "start" }), 20);
}

function focusMic() {
  const sid = STATE.focusSectionId;
  if (!sid) return;
  const sdef = (STATE.config.sections || []).find(s => s.id === sid);
  if (sdef && sdef.multi) {
    let idx = STATE.focusItemIdx;
    if (idx == null || !getItem(sid, idx)) idx = 0;
    selectFocusItem(idx);
    // Prebaci tu stavku na "Diktat" da se vidi šta se diktira
    const ic = document.querySelector(`.item-card[data-item-section="${sid}"][data-item-idx="${idx}"]`);
    if (ic) switchTab(ic, "raw");
    toggleItemRecording(sid, idx);
  } else {
    const card = document.querySelector(`section.card[data-section-id="${sid}"]`);
    if (card) switchTab(card, "raw");
    toggleRecording(sid, "raw");
  }
}

function switchTab(card, which) {
  if (!card) return;
  card.querySelectorAll(".seg-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === which));
  card.querySelectorAll(".tab-pane").forEach(p => {
    p.style.display = p.dataset.pane === which ? "block" : "none";
  });
  const pane = card.querySelector(`.tab-pane[data-pane="${which}"]`);
  if (pane) autoGrowIn(pane);
}

// === Recording (single section) ===
async function toggleRecording(sectionId, target = "raw") {
  if (STATE.recording && STATE.recording.section_id === sectionId
      && STATE.recording.target === target && STATE.recording.itemIdx == null) {
    stopRecording();
    return;
  }
  if (STATE.recording) stopRecording();
  await startRecording(sectionId, target);
}

// === Recording (multi item) ===
async function toggleItemRecording(sectionId, itemIdx) {
  if (STATE.recording && STATE.recording.section_id === sectionId
      && STATE.recording.itemIdx === itemIdx) {
    stopRecording();
    return;
  }
  if (STATE.recording) stopRecording();
  await startItemRecording(sectionId, itemIdx);
}

async function startItemRecording(sectionId, itemIdx) {
  const useGroq = STATE.config.stt_options.includes("groq");
  if (!useGroq) {
    toast("Web Speech za stavke nije implementiran. Koristi GROQ ključ.", "error");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream, { mimeType: pickMimeType() });
    const chunks = [];
    const rec = { section_id: sectionId, itemIdx, mediaRecorder: mr, chunks, warmingUp: true };
    mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      // Guarded clear — vidi komentar u startGroqRecording (zombi mikrofon)
      if (STATE.recording === rec) { STATE.recording = null; stopRecTimer(); }
      await processGroqItemRecording(sectionId, itemIdx, chunks, mr.mimeType);
    };
    mr.start();
    STATE.recording = rec;
    startRecTimer(stream);
    updateItemMicState(sectionId, itemIdx, "preparing");
    setTimeout(() => {
      if (STATE.recording && STATE.recording.mediaRecorder === mr) {
        STATE.recording.warmingUp = false;
        updateItemMicState(sectionId, itemIdx, "recording");
      }
    }, 500);
  } catch (err) {
    toast("Greška mikrofona [" + (err.name || "?") + "]: " + err.message, "error");
  }
}

async function processGroqItemRecording(sectionId, itemIdx, chunks, mimeType) {
  updateItemMicState(sectionId, itemIdx, "processing");
  const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
  if (blob.size < MIN_AUDIO_BYTES) {
    toast("Snimak prekratak (slučajan klik?) — ništa nije poslano", "error");
    updateItemMicState(sectionId, itemIdx, "idle");
    return;
  }
  const fd = new FormData();
  fd.append("audio", blob, "audio.webm");
  fd.append("section_id", sectionId);
  try {
    const res = await api("/api/transcribe", { method: "POST", body: fd });
    if (!(res.text || "").trim()) {
      toast("Nije prepoznat govor (tišina/prekratko) — pokušaj ponovo", "error");
    } else {
      // Sačuvaj original Whisper output za potencijalno učenje korekcija
      const key = `item:${sectionId}:${itemIdx}:raw`;
      STATE.whisperOriginals[key] = res.raw_whisper || res.text;
      appendToItem(sectionId, itemIdx, "raw", res.text);
      buzz([40, 80, 40]);  // dvostruki impuls: transkript je stigao
      toast("Transkripcija ✓", "success");
    }
  } catch (err) {
    toast("Transkripcija greška: " + err.message, "error");
  } finally {
    // STATE.recording čisti mr.onstop (guarded) — ne dirati ovdje
    updateItemMicState(sectionId, itemIdx, "idle");
  }
}

function updateItemMicState(sectionId, itemIdx, state) {
  updateFocusMic();
  const btn = document.querySelector(`[data-item-mic="${sectionId}"][data-item-idx="${itemIdx}"]`);
  if (!btn) return;
  btn.classList.remove("recording", "processing", "preparing");
  const label = btn.querySelector(".mic-label");
  if (state === "preparing") {
    btn.classList.add("preparing");
    if (label) label.textContent = "Pripremam...";
  } else if (state === "recording") {
    btn.classList.add("recording");
    if (label) label.textContent = "Zaustavi";
  } else if (state === "processing") {
    btn.classList.add("processing");
    if (label) label.textContent = "Obrađujem...";
  } else {
    if (label) label.textContent = "Diktiraj";
  }
}

function appendToItem(sectionId, itemIdx, target, text) {
  const item = getItem(sectionId, itemIdx);
  if (!item) return;
  const current = (item[target] || "").trim();
  const sep = current ? " " : "";
  item[target] = current ? current + sep + text : text;
  const ta = document.querySelector(
    `textarea[data-item-section="${sectionId}"][data-item-idx="${itemIdx}"][data-item-target="${target}"]`
  );
  if (ta) {
    ta.value = item[target];
    autoGrow(ta);
    ta.scrollTop = ta.scrollHeight;
  }
  updateSectionStatus(sectionId);
  autoSave();
}

// === Merge item ===
async function mergeItem(sectionId, itemIdx) {
  if (!STATE.config.claude_available) {
    toast("Claude API nije konfigurisan", "error");
    return;
  }
  const item = getItem(sectionId, itemIdx);
  if (!item || !item.raw.trim()) {
    toast("Nema sirove diktacije za spajanje");
    return;
  }
  const def = getSectionDef(sectionId);

  // Loguj korekciju (ako je korisnik editovao prije Spoji)
  maybeLogCorrection(`item:${sectionId}:${itemIdx}:raw`, item.raw);
  // Inline dugme više ne postoji (Spoji je u donjoj traci) — feedback ide na kokpit dugme.
  const btn = document.querySelector(`[data-item-merge="${sectionId}"][data-item-idx="${itemIdx}"]`);
  const oldLabel = btn ? btn.textContent : "";
  if (btn) { btn.textContent = "⏳"; btn.disabled = true; }
  setFocusMergeWorking(true);
  try {
    const res = await api("/api/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw_dictation: item.raw,
        section_id: sectionId,
        section_title: def.title || "",
        template_text: def.template_text || def.default || "",
        is_multi: true,  // Claude tretira kao listu
        is_numbered: false,  // Numeracija nije po stavki — radi je generator za .docx
        hint: def.hint || "",
        case_context: caseContext(sectionId),
      }),
    });
    item.final = res.text.trim();
    const finalTa = document.querySelector(
      `textarea[data-item-section="${sectionId}"][data-item-idx="${itemIdx}"][data-item-target="final"]`
    );
    if (finalTa) { finalTa.value = item.final; autoGrow(finalTa); }
    // Prebaci tu stavku na "Finalno" tab
    const _ic = document.querySelector(
      `.item-card[data-item-section="${sectionId}"][data-item-idx="${itemIdx}"]`
    );
    if (_ic) switchTab(_ic, "final");
    updateSectionStatus(sectionId);
    autoSave();
    toast(`Spojeno ✓ (${res.tokens_in}+${res.tokens_out} tok · ${cacheTag(res)})`, "success");
  } catch (err) {
    toast("Greška: " + err.message, "error");
  } finally {
    if (btn) { btn.textContent = oldLabel; btn.disabled = false; }
    setFocusMergeWorking(false);
  }
}

async function startRecording(sectionId, target) {
  const useGroq = STATE.config.stt_options.includes("groq");

  if (useGroq) {
    await startGroqRecording(sectionId, target);
  } else {
    startWebSpeechRecording(sectionId, target);
  }
}

async function startGroqRecording(sectionId, target) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream, { mimeType: pickMimeType() });
    const chunks = [];
    const rec = { section_id: sectionId, target, mediaRecorder: mr, chunks, warmingUp: true };
    mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      // Očisti SAMO ako je ovo još aktivno snimanje — korisnik je možda u međuvremenu
      // pokrenuo novo u drugoj sekciji (bezuslovni null bi pregazio referencu na njega
      // → "zombi" recorder koji drži mikrofon i ne može se zaustaviti).
      if (STATE.recording === rec) { STATE.recording = null; stopRecTimer(); }
      await processGroqRecording(sectionId, target, chunks, mr.mimeType);
    };
    // Pokreni snimanje ODMAH — tako MediaRecorder uhvati i 500ms warmup tišine
    mr.start();
    STATE.recording = rec;
    startRecTimer(stream);
    // UI: "Pripremam..." pa nakon 500ms "Snima"
    updateMicButtonState(sectionId, "preparing");
    setTimeout(() => {
      if (STATE.recording && STATE.recording.mediaRecorder === mr) {
        STATE.recording.warmingUp = false;
        updateMicButtonState(sectionId, "recording");
      }
    }, 500);
  } catch (err) {
    toast("Greška pristupa mikrofonu [" + (err.name || "?") + "]: " + err.message, "error");
    console.error(err);
  }
}

// Snimak manji od ovoga je gotovo sigurno slučajan klik (ni sekunda zvuka) —
// Whisper na takvom ulazu halucinira; ne šalji ga uopšte.
const MIN_AUDIO_BYTES = 4096;

function pickMimeType() {
  const types = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function processGroqRecording(sectionId, target, chunks, mimeType) {
  updateMicButtonState(sectionId, "processing");
  const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
  if (blob.size < MIN_AUDIO_BYTES) {
    toast("Snimak prekratak (slučajan klik?) — ništa nije poslano", "error");
    updateMicButtonState(sectionId, "idle");
    return;
  }
  const fd = new FormData();
  fd.append("audio", blob, "audio.webm");
  fd.append("section_id", sectionId);
  try {
    const res = await api("/api/transcribe", { method: "POST", body: fd });
    if (!(res.text || "").trim()) {
      // Fantom-filter na serveru ili tišina — ne diraj tekst i NE uči korekcije iz ovoga
      toast("Nije prepoznat govor (tišina/prekratko) — pokušaj ponovo", "error");
    } else {
      // Sačuvaj original Whisper output za potencijalno učenje korekcija
      const key = `single:${sectionId}:${target}`;
      STATE.whisperOriginals[key] = res.raw_whisper || res.text;
      appendToSection(sectionId, target, res.text);
      buzz([40, 80, 40]);  // dvostruki impuls: transkript je stigao
      toast("Transkripcija gotova ✓", "success");
    }
  } catch (err) {
    toast("Transkripcija greška: " + err.message, "error");
    console.error(err);
  } finally {
    // STATE.recording čisti mr.onstop (guarded) — ovdje bi bezuslovni null
    // pregazio eventualno novo snimanje pokrenuto tokom transkripcije.
    updateMicButtonState(sectionId, "idle");
  }
}

function startWebSpeechRecording(sectionId, target) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast("Browser ne podržava Web Speech. Postavi GROQ_API_KEY za bolju opciju.", "error");
    return;
  }
  const rec = new SR();
  rec.lang = "hr-HR";
  rec.continuous = true;
  rec.interimResults = false;
  rec.onresult = (e) => {
    let final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) final += e.results[i][0].transcript + " ";
    }
    if (final) appendToSection(sectionId, target, final.trim());
  };
  rec.onerror = (e) => {
    toast("Web Speech greška: " + e.error, "error");
    STATE.recording = null;
    stopRecTimer();
    updateMicButtonState(sectionId, "idle");
  };
  rec.onend = () => {
    if (STATE.recording && STATE.recording.section_id === sectionId) {
      STATE.recording = null;
      stopRecTimer();
      updateMicButtonState(sectionId, "idle");
    }
  };
  rec.start();
  STATE.recording = { section_id: sectionId, target, webSpeech: rec };
  startRecTimer();
  updateMicButtonState(sectionId, "recording");
}

function stopRecording() {
  if (!STATE.recording) return;
  if (STATE.recording.mediaRecorder) {
    STATE.recording.mediaRecorder.stop();
  } else if (STATE.recording.webSpeech) {
    STATE.recording.webSpeech.stop();
  }
}

// === Timer snimanja + nivo zvuka + pauza (rad bez gledanja u ekran) ===
let recTimerInterval = null;
let ampCtx = null, ampAnalyser = null, ampRAF = null, ampBuf = null;

function buzz(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {}
}

// Živi nivo zvuka → CSS var --mic-amp (0..1); amber/crveni prsten oko mikrofona
// pulsira s jačinom glasa. Funkcionalno: potvrda da mikrofon hvata (tišina = ravan prsten).
function startAmpMeter(stream) {
  stopAmpMeter();
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !stream) return;
    ampCtx = new AC();
    const src = ampCtx.createMediaStreamSource(stream);
    ampAnalyser = ampCtx.createAnalyser();
    ampAnalyser.fftSize = 256;
    src.connect(ampAnalyser);
    ampBuf = new Uint8Array(ampAnalyser.fftSize);
    ampTick();
  } catch (e) { /* WebAudio nedostupan — prsten se prosto ne prikazuje */ }
}
function ampTick() {
  if (!ampAnalyser) return;
  ampAnalyser.getByteTimeDomainData(ampBuf);
  let sum = 0;
  for (let i = 0; i < ampBuf.length; i++) { const v = (ampBuf[i] - 128) / 128; sum += v * v; }
  const rms = Math.sqrt(sum / ampBuf.length);     // 0..~1
  const amp = Math.min(1, rms * 3.2);             // pojačanje radi vidljivosti
  document.documentElement.style.setProperty("--mic-amp", amp.toFixed(3));
  ampRAF = requestAnimationFrame(ampTick);
}
function pauseAmpMeter() {
  if (ampRAF) { cancelAnimationFrame(ampRAF); ampRAF = null; }
  document.documentElement.style.setProperty("--mic-amp", "0");
}
function stopAmpMeter() {
  pauseAmpMeter();
  if (ampCtx) { try { ampCtx.close(); } catch (_) {} }
  ampCtx = null; ampAnalyser = null; ampBuf = null;
}

// Proteklo vrijeme uz uračunatu pauzu (stoji dok je pauzirano).
function recElapsed() {
  if (!STATE.recordingStartTs) return "";
  const ref = STATE.recPausedAt || Date.now();
  const s = Math.floor((ref - STATE.recordingStartTs - (STATE.recPausedMs || 0)) / 1000);
  return Math.floor(Math.max(0, s) / 60) + ":" + String(Math.max(0, s) % 60).padStart(2, "0");
}

function startRecTimer(stream) {
  STATE.recordingStartTs = Date.now();
  STATE.recPausedMs = 0;
  STATE.recPausedAt = null;
  clearInterval(recTimerInterval);
  recTimerInterval = setInterval(updateRecTimerLabels, 1000);
  updateRecTimerLabels();
  startAmpMeter(stream);
  buzz(80);  // kratka potvrda: snimanje je krenulo
}

function stopRecTimer() {
  clearInterval(recTimerInterval);
  recTimerInterval = null;
  STATE.recordingStartTs = null;
  STATE.recPausedAt = null;
  STATE.recPausedMs = 0;
  stopAmpMeter();
  const badge = document.getElementById("rec-timer");
  if (badge) { badge.classList.remove("show", "paused"); }
  buzz(40);  // potvrda: snimanje stalo
}

function isRecPaused() {
  return !!(STATE.recording && STATE.recording.mediaRecorder
            && STATE.recording.mediaRecorder.state === "paused");
}

// Pauza/nastavak nad aktivnim MediaRecorder-om (Web Speech ne podržava pauzu).
function pauseResumeRecording() {
  const rec = STATE.recording;
  if (!rec || !rec.mediaRecorder) return;
  const mr = rec.mediaRecorder;
  if (mr.state === "recording") {
    try { mr.pause(); } catch (_) { return; }
    STATE.recPausedAt = Date.now();
    pauseAmpMeter();
    buzz(30);
  } else if (mr.state === "paused") {
    try { mr.resume(); } catch (_) { return; }
    if (STATE.recPausedAt) { STATE.recPausedMs += Date.now() - STATE.recPausedAt; STATE.recPausedAt = null; }
    if (ampCtx && ampAnalyser && !ampRAF) ampTick();   // nastavi prsten
    buzz(60);
  } else { return; }
  const fm = document.getElementById("focus-mic");
  if (fm) fm.classList.toggle("paused", isRecPaused());
  updateFocusClearLabel();
  updateRecTimerLabels();
}

// Lijevo kokpit-dugme: dok snima = Pauza/Nastavi; inače = normalna uloga (Nova/Obriši).
function updateFocusClearLabel() {
  const fClear = document.getElementById("focus-clear");
  if (!fClear) return;
  if (STATE.recording && STATE.recording.mediaRecorder) {
    fClear.textContent = isRecPaused() ? "▶ Nastavi" : "⏸ Pauza";
    fClear.classList.remove("danger");
    return;
  }
  const sid = STATE.focusSectionId;
  const sdef = sid ? (STATE.config.sections || []).find(s => s.id === sid) : null;
  if (sdef && sdef.multi) { fClear.textContent = "➕ Nova"; fClear.classList.remove("danger"); }
  else { fClear.textContent = "✕ Obriši"; fClear.classList.add("danger"); }
}

function updateRecTimerLabels() {
  const t = recElapsed();
  const paused = isRecPaused();
  const badge = document.getElementById("rec-timer");
  if (badge) {
    const show = !!STATE.recording && !!t;
    badge.classList.toggle("show", show);
    badge.classList.toggle("paused", show && paused);
    if (show) badge.textContent = (paused ? "⏸ " : "● ") + t;
  }
  if (!STATE.recording || !t) return;
  // Inline mic dugmad (pilule sa tekstom) dobiju vrijeme u labelu
  document.querySelectorAll(".btn-mic.recording .mic-label").forEach(l => {
    l.textContent = (paused ? "Pauza · " : "Zaustavi · ") + t;
  });
  const om = document.getElementById("okolnosti-mic");
  if (om && om.classList.contains("recording")) om.textContent = (paused ? "⏸ " : "⏹ ") + t;
}

function updateMicButtonState(sectionId, state) {
  updateFocusMic();
  const btn = document.querySelector(`[data-mic="${sectionId}"]`);
  if (!btn) return;
  btn.classList.remove("recording", "processing", "preparing");
  const label = btn.querySelector(".mic-label");
  if (state === "preparing") {
    btn.classList.add("preparing");
    if (label) label.textContent = "Pripremam...";
  } else if (state === "recording") {
    btn.classList.add("recording");
    if (label) label.textContent = "Zaustavi";
  } else if (state === "processing") {
    btn.classList.add("processing");
    if (label) label.textContent = "Obrađujem...";
  } else {
    if (label) label.textContent = "Diktiraj";
  }
}

function appendToSection(sectionId, target, text) {
  const ta = document.querySelector(`textarea[data-section-id="${sectionId}"][data-target="${target}"]`);
  if (!ta) return;
  const current = ta.value.trim();
  const sep = current ? (current.endsWith(".") || current.endsWith("\n") ? " " : " ") : "";
  ta.value = current ? current + sep + text : text;
  autoGrow(ta);
  const sec = getSection(sectionId);
  sec[target] = ta.value;
  updateSectionStatus(sectionId);
  autoSave();
  ta.scrollTop = ta.scrollHeight;
}

// === Whisper correction logging (auto-učenje iz korisnikovih ispravki) ===
async function maybeLogCorrection(key, currentText) {
  const original = STATE.whisperOriginals[key];
  if (!original) return;  // nema sačuvanog originala
  const edited = (currentText || "").trim();
  if (!edited || edited === original.trim()) return;  // nema promjene
  try {
    const res = await api("/api/log_correction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ original, edited }),
    });
    if (res.learned && res.learned.length > 0) {
      // Server je naučio nove korekcije!
      const msg = res.learned.map(l => `"${l.before}" → "${l.after}"`).join(", ");
      toast(`✓ Naučena nova korekcija: ${msg}`, "success");
    }
  } catch (err) {
    console.warn("log_correction:", err.message);
  }
  // Obriši cached original — više se ne odnosi na trenutni sadržaj
  delete STATE.whisperOriginals[key];
}

// === Cleanup (radi nad finalnim tekstom — dodatna polish nakon merge-a) ===
async function cleanupSection(sectionId) {
  if (!STATE.config.claude_available) {
    toast("Claude API nije konfigurisan u .env fajlu", "error");
    return;
  }
  const ta = document.querySelector(`textarea[data-section-id="${sectionId}"][data-target="final"]`);
  if (!ta || !ta.value.trim()) {
    toast("Nema finalnog teksta za doradu (prvo Spoji)");
    return;
  }
  const sec = STATE.config.sections.find(s => s.id === sectionId);
  const btn = document.querySelector(`[data-cleanup="${sectionId}"]`);
  const oldLabel = btn.textContent;
  btn.textContent = "⏳ Doradjujem...";
  btn.disabled = true;
  try {
    const res = await api("/api/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: ta.value,
        section_id: sectionId,
        section_title: sec ? sec.title : "",
        case_context: caseContext(sectionId),
      }),
    });
    ta.value = res.text;
    autoGrow(ta);
    getSection(sectionId).final = res.text;
    autoSave();
    toast("Dorađeno ✓", "success");
  } catch (err) {
    toast("Greška: " + err.message, "error");
  } finally {
    btn.textContent = oldLabel;
    btn.disabled = false;
  }
}

// Sekcije kao { section_id: string } — TAČNO ono što bi ušlo u .docx
// (final ili raw fallback; multi = stavke spojene newline-ovima).
// Koriste generateReport i provjeriZapisnik.
function collectFlatSections() {
  const flat = {};
  for (const sid in STATE.sections) {
    const s = STATE.sections[sid];
    if (typeof s === "string") {
      if (s.trim()) flat[sid] = s;
    } else if (s && Array.isArray(s.items)) {
      const lines = s.items
        .map(it => (it.final || it.raw || "").trim())
        .filter(Boolean);
      if (lines.length) flat[sid] = lines.join("\n");
    } else if (s && (s.final || s.raw)) {
      flat[sid] = s.final || s.raw;
    }
  }
  return flat;
}

// === Provjera konzistentnosti cijelog nalaza (ništa ne mijenja) ===
let provjeraRunning = false;
async function provjeriZapisnik() {
  if (provjeraRunning) return;
  if (!STATE.config.claude_available) { toast("Claude nije konfigurisan", "error"); return; }
  flushAutoSave();
  const flat = collectFlatSections();
  if (!Object.keys(flat).length) { toast("Nema sadržaja za provjeru"); return; }
  provjeraRunning = true;
  toast("🔎 Provjeravam zapisnik…");
  try {
    const res = await nativeCall("provjera", {
      sections: flat,
      case_context: caseContext(),
    });
    if (res && res.__error) throw new Error(res.detail || ("status " + res.status));
    showTextModal("🔎 Provjera zapisnika", res.text || "Nema odgovora.");
  } catch (err) {
    toast("Provjera: " + err.message, "error");
  } finally {
    provjeraRunning = false;
  }
}

// Generički modal za prikaz teksta (rezultat provjere i sl.)
function showTextModal(title, text) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>${escapeHtml(title)}</h2>
        <button class="modal-close" data-close-modal>✕</button>
      </div>
      <div class="modal-body"><div class="text-modal-body">${escapeHtml(text)}</div></div>
      <div class="modal-footer">
        <button class="btn-primary" data-close-modal>Zatvori</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelectorAll("[data-close-modal]").forEach(b =>
    b.addEventListener("click", () => overlay.remove()));
}

// === Generate ===
async function generateReport() {
  // Provjeri da li su ime i KT broj popunjeni — bez njih filename će biti "Zapisnik.docx"
  const ime = (STATE.header.ime_prezime || "").trim();
  const kt = (STATE.header.kt_broj || "").trim();
  if (!ime || !kt) {
    const missing = [];
    if (!ime) missing.push("Prezime i ime");
    if (!kt) missing.push("KT broj");
    const proceed = await uiConfirm(
      `Nedostaje ${missing.join(" i ")} u zaglavlju.\n\n` +
      `Bez toga, fajl će se zvati "Zapisnik YYYY-MM-DD HH-MM.docx" umjesto "Prezime Ime - KT broj.docx".`,
      { title: "Upozorenje", okText: "Generiši svejedno", cancelText: "Popuni prvo" }
    );
    if (!proceed) {
      // Otvori zaglavlje da korisnik popuni
      const headerCard = $("#header-card");
      if (headerCard) {
        headerCard.classList.add("open");
        headerCard.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }
  }
  // (QA provjera PRAZNIH sekcija NAMJERNO ne postoji: kod spoljašnjeg pregleda
  //  većina sekcija legitimno ostaje na standardnom template tekstu.)
  // ALI: diktirano-a-NESPOJENO nikad nije namjerno — u zapisnik bi ušao sirovi govor.
  const nespojene = [];
  for (const s of STATE.config.sections) {
    const sec = getSection(s.id);
    const rawOnly = (s.multi && sec.items)
      ? sec.items.some(it => (it.raw || "").trim() && !(it.final || "").trim())
      : !!((sec.raw || "").trim() && !(sec.final || "").trim());
    if (rawOnly) nespojene.push(shortTitle(s.title) || s.title);
  }
  if (nespojene.length) {
    const ok = await uiConfirm(
      `Imaju diktat koji NIJE spojen — u zapisnik bi ušao sirovi govor:\n\n${nespojene.join(", ")}\n\nVrati se i spoji ih (🪄), ili generiši svejedno.`,
      { title: "Nespojen diktat", okText: "Generiši svejedno", cancelText: "Vrati se" }
    );
    if (!ok) return;
  }
  const btn = $("#btn-generate");
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = "⏳ Generišem...";

  const flatSections = collectFlatSections();
  try {
    // Direktan poziv Python-a (bez servera). Vraća {filename, docx_b64}.
    const res = await nativeCall("generate", { header: STATE.header, sections: flatSections });
    if (res && res.__error) throw new Error(res.detail || ("status " + res.status));
    const filename = res.filename || "zapisnik.docx";
    window.AndroidBridge.saveDocx(filename, res.docx_b64);
    toast("Zapisnik snimljen u Download ✓", "success");
  } catch (err) {
    toast("Greška generisanja: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

// === Drafts (multi) ===
let autoSaveTimer = null;

// Odmah izvrši odgođeni autoSave (ako postoji). Poziva se PRIJE promjene/brisanja
// drafta — inače debounce od 500ms proguta zadnje kucanje starog drafta, a pri
// brisanju tekućeg zna stvoriti "ghost" novi draft kad tajmer okine prekasno.
function flushAutoSave() {
  if (!autoSaveTimer) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
  const id = getCurrentDraftId();
  if (!id) return;
  try {
    persistDraft(id, autoDraftName(STATE.header), STATE.header, STATE.sections);
    flashSavedIndicator();
  } catch (e) {
    console.error("flushAutoSave:", e);
  }
}

function autoSave() {
  // Debounce — sačuvaj nakon 500ms mirovanja
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    let id = getCurrentDraftId();
    if (!id) {
      id = createNewDraft(autoDraftName(STATE.header));
      STATE.currentDraftId = id;
      updateDraftIndicator();
    }
    const name = autoDraftName(STATE.header);
    try {
      persistDraft(id, name, STATE.header, STATE.sections);
      // Ažuriraj naš poznati server timestamp (čak i pre uspjesnog upload-a, da polling
      // ne reaguje na naš rođeni write tokom timestamp toleranje od 2s)
      STATE.lastKnownServerTs = Date.now();
      flashSavedIndicator();
    } catch (e) {
      console.error("autoSave error:", e);
    }
  }, 500);
}

async function loadCurrentDraftIntoState() {
  const id = getCurrentDraftId();
  STATE.currentDraftId = id;
  if (!id) {
    STATE.header = {};
    STATE.sections = {};
    return false;
  }
  const data = await loadDraftById(id);
  if (!data) {
    setCurrentDraftId(null);
    STATE.currentDraftId = null;
    STATE.header = {};
    STATE.sections = {};
    return false;
  }
  STATE.header = data.header || {};
  STATE.sections = data.sections || {};
  STATE.lastKnownServerTs = data.updatedAt || 0;
  migrateSectionState();
  return true;
}

async function switchToDraft(id) {
  flushAutoSave();  // sačuvaj zadnje kucanje STAROG drafta prije prelaska
  const data = await loadDraftById(id);
  if (!data) {
    toast("Draft ne postoji", "error");
    return;
  }
  setCurrentDraftId(id);
  STATE.currentDraftId = id;
  STATE.whisperOriginals = {};  // korekcije se ne smiju učiti preko granice draftova
  STATE.header = data.header || {};
  STATE.sections = data.sections || {};
  STATE.lastKnownServerTs = data.updatedAt || 0;
  migrateSectionState();
  closeIzuzetiOverlay();
  renderHeaderForm();
  renderSections();
  updateDraftIndicator();
  hideConflictBanner();
  toast(`Učitan: ${data.name}`, "success");
}

// Da li draft ima STVARNI sadržaj? (Render sam kreira prazne objekte za svaku sekciju
// u STATE.sections, a izuzeti_checked je objekat — golo brojanje ključeva bi pitanje
// "novi draft?" prikazivalo i za potpuno prazan draft.)
function draftHasContent() {
  for (const k in STATE.header) {
    const v = STATE.header[k];
    if (typeof v === "string" && v.trim()) return true;
    if (v === true) return true;
    if (v && typeof v === "object" && Object.values(v).some(
        x => x === true || (typeof x === "string" && x.trim()))) return true;
  }
  for (const sid in STATE.sections) {
    const s = STATE.sections[sid];
    if (!s) continue;
    if (typeof s === "string" && s.trim()) return true;
    if (Array.isArray(s.items)) {
      if (s.items.some(it => ((it.raw || "") + (it.final || "")).trim())) return true;
    } else if (((s.raw || "") + (s.final || "")).trim()) return true;
  }
  return false;
}

async function newDraft() {
  // Pitaj samo ako trenutni draft ima sadržaj
  if (draftHasContent() && !(await uiConfirm("Trenutni draft biće sačuvan u listi.",
      { title: "Otvoriti novi prazan draft?", okText: "Otvori novi" }))) {
    return;
  }
  flushAutoSave();  // sačuvaj zadnje kucanje starog drafta
  const id = createNewDraft(autoDraftName({}));
  STATE.currentDraftId = id;
  STATE.header = {};
  STATE.sections = {};
  STATE.whisperOriginals = {};
  izuzetiResetDefaults();      // resetuj izuzete uzorke na default
  closeIzuzetiOverlay();       // zatvori prozor ako je otvoren
  renderHeaderForm();
  renderSections();
  updateDraftIndicator();
  autoSave();
  toast("Novi draft kreiran ✓", "success");
}

async function clearCurrent() {
  if (!(await uiConfirm("Sadržaj trenutnog drafta biće obrisan. Sam draft ostaje u listi — samo ga prazniš.",
      { title: "Obrisati sav sadržaj?", okText: "Obriši sadržaj", danger: true }))) return;
  STATE.header = {};
  STATE.sections = {};
  izuzetiResetDefaults();
  closeIzuzetiOverlay();
  renderHeaderForm();
  renderSections();
  autoSave();
  toast("Sadržaj obrisan");
}

// === Drafts modal ===
function openDraftsModal() {
  const drafts = listDrafts();
  const currentId = getCurrentDraftId();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <h2>Sačuvani draftovi (${drafts.length})</h2>
        <button class="modal-close" data-close-modal>✕</button>
      </div>
      <div class="modal-body">
        ${drafts.length === 0
          ? '<p class="modal-empty">Nema sačuvanih draftova. Kad počneš popunjavati zaglavlje, automatski se kreira novi draft.</p>'
          : drafts.map(d => {
              const date = new Date(d.updatedAt).toLocaleString("bs-BA");
              const isCurrent = d.id === currentId;
              const localBadge = d.localOnly ? '<span class="local-only-badge" title="Nije uplodovan na server">⚠ samo lokalno</span>' : '';
              return `
                <div class="draft-row ${isCurrent ? 'current' : ''}" data-draft-id="${d.id}">
                  <div class="draft-info">
                    <div class="draft-name">${isCurrent ? '● ' : ''}${escapeHtml(d.name)}${localBadge}</div>
                    <div class="draft-date">${date}</div>
                  </div>
                  <div class="draft-actions">
                    ${isCurrent ? '<span class="draft-badge">trenutno</span>'
                      : `<button class="btn-draft-open" data-open-id="${d.id}">Otvori</button>`}
                    <button class="btn-draft-rename" data-rename-id="${d.id}" title="Preimenuj">✎</button>
                    <button class="btn-draft-delete" data-delete-id="${d.id}" title="Obriši">🗑</button>
                  </div>
                </div>
              `;
            }).join("")
        }
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" data-close-modal>Zatvori</button>
        <button class="btn-primary" data-new-draft>+ Novi prazan draft</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener("click", e => {
    if (e.target === overlay) closeDraftsModal(overlay);
  });
  overlay.querySelectorAll("[data-close-modal]").forEach(b =>
    b.addEventListener("click", () => closeDraftsModal(overlay))
  );
  overlay.querySelectorAll("[data-open-id]").forEach(b =>
    b.addEventListener("click", async () => {
      await switchToDraft(b.dataset.openId);
      closeDraftsModal(overlay);
    })
  );
  overlay.querySelectorAll("[data-rename-id]").forEach(b =>
    b.addEventListener("click", async () => {
      const id = b.dataset.renameId;
      const d = listDrafts().find(x => x.id === id);
      const newName = await uiPrompt("Novi naziv drafta:", d ? d.name : "", { title: "Preimenuj draft" });
      if (newName && newName.trim() && d) {
        const data = await loadDraftById(id);
        if (data) {
          persistDraft(id, newName.trim(), data.header, data.sections);
          closeDraftsModal(overlay);
          openDraftsModal();
        }
      }
    })
  );
  overlay.querySelectorAll("[data-delete-id]").forEach(b =>
    b.addEventListener("click", async () => {
      const id = b.dataset.deleteId;
      const d = listDrafts().find(x => x.id === id);
      if (!d) return;
      if (!(await uiConfirm(`Draft "${d.name}" biće trajno obrisan. Ova akcija se ne može poništiti.`,
          { title: "Obrisati draft?", okText: "Obriši", danger: true }))) return;
      flushAutoSave();  // isprazni odgođeni tajmer — inače zna stvoriti ghost draft poslije brisanja
      const wasCurrent = id === getCurrentDraftId();
      deleteDraft(id);
      if (wasCurrent) {
        // Ako brišeš trenutni, učitaj prazno stanje
        STATE.currentDraftId = null;
        STATE.header = {};
        STATE.sections = {};
        renderHeaderForm();
        renderSections();
        updateDraftIndicator();
      }
      closeDraftsModal(overlay);
      openDraftsModal();
    })
  );
  overlay.querySelector("[data-new-draft]").addEventListener("click", () => {
    closeDraftsModal(overlay);
    newDraft();
  });
}

function closeDraftsModal(overlay) {
  if (overlay && overlay.parentElement) overlay.parentElement.removeChild(overlay);
}

// === Uvoz draftova iz ZIP-a (rezultat „Izvezi drafte") ===
// Spaja sa postojećima — server (Python) NIKAD ne pregazi postojeći draft.
async function importDrafts() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip,application/zip";
  input.style.display = "none";
  document.body.appendChild(input);
  input.addEventListener("change", async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    try {
      const zip_b64 = await blobToBase64(file);
      const res = await nativeCall("import_drafts", { zip_b64 });
      if (res && res.__error) throw new Error(res.detail || ("status " + res.status));
      await refreshDraftsFromServer();   // povuci novouvezene u lokalni keš
      updateDraftIndicator();
      const sk = res.skipped ? ` (preskočeno ${res.skipped})` : "";
      toast(`Uvezeno ${res.imported} draftova${sk} ✓`, "success");
      openDraftsModal();
    } catch (err) {
      toast("Uvoz: " + err.message, "error");
    }
  });
  input.click();
}

// === Izvoz svih draftova (ZIP u Download) — sigurnosna kopija ===
// Jedini uređaj + isključen cloud backup → ovo je jedina rezerva diktiranog rada.
async function exportDrafts() {
  flushAutoSave();  // i tekuće izmjene neka uđu u izvoz
  try {
    const res = await nativeCall("export_drafts", {});
    if (res && res.__error) throw new Error(res.detail || ("status " + res.status));
    window.AndroidBridge.saveFile(res.filename, res.zip_b64, "application/zip");
    toast(`Izvezeno ${res.count} draftova u Download ✓`, "success");
  } catch (err) {
    toast("Izvoz: " + err.message, "error");
  }
}

// === Draft indikator u topbar-u ===
function updateDraftIndicator() {
  const ind = $("#draft-name-indicator");
  if (!ind) return;
  const id = STATE.currentDraftId || getCurrentDraftId();
  if (!id) {
    ind.textContent = "(nema otvorenog nalaza)";
    ind.classList.add("dim");
    return;
  }
  ind.classList.remove("dim");
  // Auto ažuriraj naziv prema header-u (ime/KT)
  const name = autoDraftName(STATE.header);
  ind.textContent = name;
}

let savedFlashTimer = null;
function flashSavedIndicator() {
  const dot = $("#save-status-dot");
  if (!dot) return;
  dot.classList.add("saved");
  clearTimeout(savedFlashTimer);
  savedFlashTimer = setTimeout(() => dot.classList.remove("saved"), 800);
}

// (Polling svakih 10s UKLONJEN — standalone app je jedini pisac draftova, pa je
//  periodično buđenje Python-a radi čitanja vlastitih fajlova samo trošilo bateriju.
//  Keš liste se osvježava pri startu i pri svakom upisu kroz persistDraft.)

// === Konflikt banner ===
function showConflictBanner(draftId, serverTs) {
  hideConflictBanner();
  const banner = document.createElement("div");
  banner.id = "conflict-banner";
  banner.className = "conflict-banner";
  banner.innerHTML = `
    <span class="conflict-icon">⚠</span>
    <span class="conflict-text">
      Server ima <b>noviju verziju</b> ovog drafta
      (${new Date(serverTs).toLocaleTimeString("bs-BA")}).
      Vjerovatno je drugi uređaj radio izmjene.
    </span>
    <div class="conflict-actions">
      <button class="btn-conflict-load">⬇ Učitaj sa servera</button>
      <button class="btn-conflict-keep">✓ Zadrži moje izmjene</button>
    </div>
  `;
  document.body.appendChild(banner);
  banner.querySelector(".btn-conflict-load").addEventListener("click", async () => {
    await switchToDraft(draftId);
    hideConflictBanner();
  });
  banner.querySelector(".btn-conflict-keep").addEventListener("click", () => {
    // Forsiraj upload trenutnog stanja sa novim timestamp-om
    autoSave();
    hideConflictBanner();
    toast("Tvoje izmjene su snimljene kao najnovija verzija");
  });
}

function hideConflictBanner() {
  const b = $("#conflict-banner");
  if (b) b.remove();
}

// === Util ===
// Parsiraj Content-Disposition header — handle filename*=utf-8'' (RFC 5987) i filename=
function parseContentDispositionFilename(cd) {
  if (!cd) return null;
  // RFC 5987 format: filename*=utf-8''<URL-encoded>
  const m1 = cd.match(/filename\*=utf-8''([^;]+)/i);
  if (m1) {
    try { return decodeURIComponent(m1[1].trim()); }
    catch { /* fall through */ }
  }
  // Standardni format: filename="..."
  const m2 = cd.match(/filename="([^"]+)"/i);
  if (m2) return m2[1];
  // Standardni bez navodnika: filename=...
  const m3 = cd.match(/filename=([^;]+)/i);
  if (m3) return m3[1].trim();
  return null;
}

// Datum format koji koristi vještak: "DD.MM.YYYY. godine"
function formatDateToday() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}. godine`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

// === Init ===
async function init() {
  try {
    STATE.config = await api("/api/config");

    let statusText = "Gboard";
    let statusLevel = "warn";
    if (STATE.config.stt_options.includes("groq")) {
      statusText = "Groq ✓";
      statusLevel = "ok";
    }
    if (!STATE.config.claude_available) {
      statusText += " · bez Claude";
      statusLevel = "err";
    }
    setStatus(statusText, statusLevel);
  } catch (err) {
    setStatus("Server nedostupan", "err");
    toast("Ne mogu učitati config: " + err.message, "error");
    return;
  }

  // Migracija starih draftova → novi sistem (jednom)
  migrateLegacyDraft();

  // Povuci listu sa servera i merge sa lokalnim cache-om
  await refreshDraftsFromServer();

  // Učitaj trenutni draft (ako postoji) — pokušaj server prvo
  await loadCurrentDraftIntoState();

  renderHeaderForm();
  renderSections();
  updateDraftIndicator();

  if (!STATE.header.ime_prezime) {
    $("#header-card").classList.add("open");
  }

  $("#btn-drafts").addEventListener("click", openDraftsModal);
  $("#btn-new-draft").addEventListener("click", newDraft);
  $("#btn-clear").addEventListener("click", clearCurrent);
  $("#btn-generate").addEventListener("click", generateReport);

  // ⋮ meni u traci (Postavke / Osvježi) — zamjena za nativnu ActionBar
  const menuBtn = $("#btn-menu");
  const menu = $("#topbar-menu");
  if (menuBtn && menu) {
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.toggle("show");
    });
    document.addEventListener("click", () => menu.classList.remove("show"));
    const mProvjera = $("#menu-provjera");
    if (mProvjera) mProvjera.addEventListener("click", () => {
      menu.classList.remove("show");
      provjeriZapisnik();
    });
    const mExport = $("#menu-export");
    if (mExport) mExport.addEventListener("click", () => {
      menu.classList.remove("show");
      exportDrafts();
    });
    const mImport = $("#menu-import");
    if (mImport) mImport.addEventListener("click", () => {
      menu.classList.remove("show");
      importDrafts();
    });
    const mSettings = $("#menu-settings");
    const mReload = $("#menu-reload");
    if (mSettings) mSettings.addEventListener("click", () => {
      menu.classList.remove("show");
      if (window.AndroidBridge && AndroidBridge.openSettings) AndroidBridge.openSettings();
    });
    if (mReload) mReload.addEventListener("click", () => {
      menu.classList.remove("show");
      location.reload();
    });
  }

  // Fokus-kokpit donja traka: ← prethodna / 🎤 / sljedeća →
  const fPrev = $("#focus-prev");
  const fNext = $("#focus-next");
  const fMic = $("#focus-mic");
  if (fPrev) fPrev.addEventListener("click", () => focusGo(-1));
  if (fNext) fNext.addEventListener("click", () => focusGo(1));
  if (fMic) fMic.addEventListener("click", focusMic);
  // Obriši / Spoji u kokpitu — proxy na inline dugmad fokusirane sekcije
  const fClear = $("#focus-clear");
  const fMerge = $("#focus-merge");
  if (fClear) fClear.addEventListener("click", () => {
    // Dok snima, lijevo dugme je Pauza/Nastavi (a ne Nova/Obriši)
    if (STATE.recording && STATE.recording.mediaRecorder) { pauseResumeRecording(); return; }
    const sid = STATE.focusSectionId;
    if (!sid) return;
    const sdef = (STATE.config.sections || []).find(s => s.id === sid);
    if (sdef && sdef.multi) {
      // ➕ Nova stavka → dodaj i selektuj
      addItem(sid);
      rerenderMultiBody(sid);
      selectFocusItem(getSection(sid).items.length - 1);
    } else {
      document.querySelector(`[data-clear-raw="${sid}"]`)?.click();
    }
  });
  if (fMerge) fMerge.addEventListener("click", () => {
    const sid = STATE.focusSectionId;
    if (!sid) return;
    const sdef = (STATE.config.sections || []).find(s => s.id === sid);
    if (sdef && sdef.multi) {
      let idx = STATE.focusItemIdx;
      if (idx == null || !getItem(sid, idx)) idx = 0;
      mergeItem(sid, idx);
    } else {
      mergeSection(sid);
    }
  });

  // Service worker se NE registruje u native aplikaciji (nema servera; izbjegava cache probleme).
}

init();
