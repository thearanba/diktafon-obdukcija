"""
Schema sekcija obdukcionog zapisnika.

Mapira sekcije koje doktor diktira na konkretne paragrafe u template-u.
Template se NIKAD ne mijenja — koristi se samo kao izvor strukture.
"""

DEFAULT_IZUZETI_UZORCI = (
    "Tokom obdukcije izuzeti uzorci: papilarnih linija, uzorak krvi za DNA "
    "te uzorci krvi, očne vodice, urina, žući i želučanog sadržaja za analizu "
    "na alkohol i psihoaktivne supstance. Svi uzorci predani krim-tehničaru na dalje postupanje."
)

# Polja zaglavlja (popunjavaju se u tabeli template-a)
HEADER_FIELDS = [
    {"id": "ime_prezime", "label": "Prezime i ime (kako će biti u nazivu fajla i draft-a)", "uppercase": True, "placeholder": "Prezime Ime, npr. Kasapović Bekir"},
    {"id": "spol", "label": "Pol (Claude usklađuje rod u svim sekcijama)", "placeholder": "muški / ženski",
     "quick_options": ["muški", "ženski"]},
    {"id": "drzavljanin", "label": "Državljanin", "placeholder": "BiH"},
    {"id": "prebivaliste", "label": "Prebivalište", "placeholder": "Sarajevo"},
    {"id": "adresa", "label": "Adresa", "placeholder": "Ulica i broj"},
    {"id": "rodjen", "label": "Rođen/a", "placeholder": "DD.MM.YYYY. godine"},
    {"id": "pronadjen", "label": "Pronađen/preminuo", "placeholder": "DD.MM.YYYY. godine"},
    {"id": "tuzilac", "label": "Tužilac", "placeholder": "Ime i prezime tužioca"},
    {"id": "kt_broj", "label": "Tužilački broj (pun, sa oznakom tužilaštva — T09=KS, T03=TK...)",
     "placeholder": "T09 0 KTA 0210285 26"},
    {"id": "okolnosti_label", "label": "Naziv polja okolnosti", "placeholder": "Uviđaj", "default": "Okolnosti slučaja"},
    {"id": "okolnosti", "label": "Okolnosti / Uviđaj (tekst)", "multiline": True,
     "placeholder": "Opis okolnosti slučaja..."},
    {"id": "izuzeti_uzorci", "label": "Izuzeti uzorci (ide iza okolnosti u zapisniku)",
     "multiline": True, "default": DEFAULT_IZUZETI_UZORCI,
     "placeholder": "Standardni tekst — uredi ako su uzorci drugačiji za ovaj slučaj"},
    {"id": "datum_obdukcije", "label": "Datum obdukcije", "placeholder": "DD.MM.YYYY. godine",
     "today_button": True},
    {"id": "pomocnik", "label": "Pomoćnik obducenta", "placeholder": "Ime i prezime",
     "quick_options": ["Adnan Mušić", "Džejla Kitovnica"]},
]

# Sekcije za diktiranje (mapirane na paragraf indekse u template-u)
# multi=True znači da korisnik može unijeti više paragrafa (svaka linija = paragraf)
DICTATION_SECTIONS = [
    {
        "id": "s1_opsti",
        "title": "1. Opšti opis (pol, dužina, dob, odjeća)",
        "para_idx": 3,
        "expect": '1.',
        "default": "Muški/ženski leš dužine oko XXX cm, u dobi od XX godina, na kojem je odjeća: ...",
        "hint": "Diktiraj: pol, dužinu, dob, odjeću. Brojeve govori normalno (172 cm, 45 godina).",
    },
    {
        "id": "s1_konstitucija",
        "title": "Konstitucija, mrtvačka ukočenost i mrlje",
        "para_idx": 4,
        "expect": 'Kostura',
        "default": "Kostura i mišića dobro razvijenih, dobre uhranjenosti. Mrtvačka ukočenost izražena u svim mišićima. Mrtvačke mrlje izražene postranično i straga, slivene, ljubičasto crvene boje. Koža blijedo sivo ružičasta.",
        "hint": "Default je standardni opis — modificiraj samo razlike.",
    },
    {
        "id": "s2_glava_lice",
        "title": "2. Glava i lice (kosa, brada, oči)",
        "para_idx": 5,
        "expect": '2.',
        "default": "Kosa . Brada i brkovi dužine oko cm. Očni kapci zatvoreni. Veznice i bjeloočnice glatke, sjajne, . Rožnjače glatke, sjajne, . Dužice . Zjenice .",
    },
    {
        "id": "s2_usta",
        "title": "Usta i sluznica usana",
        "para_idx": 6,
        "expect": 'Usta',
        "default": "Usta poluotvorena. Sluznica usana glatka, ružičasta.",
    },
    {
        "id": "s2_zubi_vrat_grudi",
        "title": "Zubi, vrat, grudi, trbuh, ekstremiteti",
        "para_idx": 7,
        "expect": 'Zubi',
        "default": "Zubi: . Na mjestu nedostajućih zuba alveolni greben izravnat. Vrat srednje pokretljiv. Grudni koš valjkast, ravnomjeran, simetričan. Trbuh u ravni grudnog koša, opuštene prednje stjenke. Kosmatost polnog predjela je muškog-ženskog tipa, spolovilo uredno razvijeno. Ekstremiteti pravilni, simetrični.",
    },
    {
        "id": "s3_povrede",
        "title": "3. Vidljive povrede (više paragrafa)",
        "para_idx": 9,
        "expect": '3.',
        "default": "",
        "multi": True,
        "hint": "Svaku povredu u novi paragraf (pritisni Enter). Ako nema povreda, ostavi prazno ili napiši 'Nema vidljivih povreda.'",
    },
    {
        "id": "s4_otvori",
        "title": "4. Tjelesni otvori",
        "para_idx": 10,
        "expect": '4.',
        "default": "U spoljašnjim tjelesnim otvorima: ušiju, nosa, usta, polnog otvora i čmara nema stranog sadržaja.",
    },
    {
        "id": "s5_mozak",
        "title": "5. Glava (poglavina, lobanja, mozak)",
        "para_idx": 13,
        "expect": '5.',
        "default": "Tkivo poglavine glatko, sjajno, vlažno, . Krov lobanje kruškolik, srednje debljine, kosti svoda lobanje očuvane. Tvrda moždanica bjeličasto sedefasta, glatka, sjajna, srednjekrvna. U moždaničnim slivovima nešto tamno crvene krvi. Meke moždanice glatke, sjajne. Mozak ...",
    },
    {
        "id": "s6_jezik",
        "title": "6. Jezik, ždrijelo, štitnjača",
        "para_idx": 15,
        "expect": '6.',
        "default": "Jezik odgovarajuće velik, jasne građe i crteža, sivkasto ružičast. Limfni čvorići korijena jezika srednje veličine, pokretni. U ždrijelu i jednjaku , njihova sluznica glatka, sjajna, svijetlo crvene boje. U grkljanu, dušniku i glavnim dušnicama , njihova sluznica glatka, sjajna. Limfni čvorići ispod račve dušnika pojedinačni, modrikasti, veličine zrna graška. Štitnjače srednje velike, smeđkaste.",
    },
    {
        "id": "s7_pluca",
        "title": "7. Pluća i grudna šupljina",
        "para_idx": 16,
        "expect": '7.',
        "default": "U grudnim šupljinama: nema stranog sadržaja. Poplućnica i porebrica glatke, sjajne. Pluća srednje velika. Tkivo pluća, a sa rezne plohe se na pritisak iz najsitnijih dušnica istiskuje oskudan sluzav sadržaj, a iz sitnih krvnih sudova nešto tečne krvi.",
    },
    {
        "id": "s8_srce",
        "title": "8. Srce i osrčje",
        "para_idx": 17,
        "expect": '8.',
        "default": "U srčanoj kesi oko ml bistrog, žućkastog sadržaja. Vanjski i unutrašnji list osrčja glatki, sjajni. Srce slobodno, srednje veliko, čvrsto. Srčana arterijska i venska ušća, njihovi zalisci. Osrčnica i usrčnica glatke, sjajne. Srčani mišić jasne građe i crteža, srednje debljine, srednjekrvan. Desna komora srednje debela, a lijeva debljine oko cm. Srčane arterije prohodne. Grudna aorta glatke, sjajne intime. Jajasta rupica u zidu između pretkomora zatvorena.",
    },
    {
        "id": "s9_trbuh",
        "title": "9. Trbuh (jetra, slezena, bubrezi, žučna kesa)",
        "para_idx": 19,
        "expect": '9.',
        "default": "U trbušnoj šupljini nema stranog sadržaja. Potrbušnice glatke, sjajne. Slezena slobodna, srednje velika, tkivo jasne građe, ljubičaste boje. U žučnoj kesici oko 10 ml žuči, njena sluznica somotasta, zelenkasto prebojena žučnim bojama. Jetra srednje velika, glatke, providne čaure, jasne građe i crteža, srednjekrvna. Gušterača odgovarajuće velika, sitnorežnjasta. Nadbubrezi odgovarajuće veliki, jasne granice tanke žućkaste kore i uske mrke sredine. Bubrezi srednje veliki, lako skidljive čahure, glatke površine, jasne granice svijetle kore i tamnih piramida, srednjekrvni. Bubrežna korita srednje široka, sluznica bubrežnih korita i mokraćovoda glatka, sivkasta. U mokraćnom mjehuru oko ml mokraće, sluznica sivkasta, naborana. Spolni organi uredno razvijeni.",
    },
    {
        "id": "s10_git",
        "title": "10. Želudac i crijeva",
        "para_idx": 20,
        "expect": '10.',
        "default": "U želucu oko ml sadržaja. Sluznica želuca . U dvanaestopalačnom crijevu nešto sluzavog sadržaja, njegova sluznica ružičasta. U tankom, debelom, srpastom i završnom crijevu oskudan zelenkast, gust, do mrk jednoličan crijevni sadržaj, njihova sluznica glatka, sjajna, mnogokrvna.",
    },
    {
        "id": "s11_kostur",
        "title": "11. Kostur (više paragrafa za prelome)",
        "para_idx": 24,
        "expect": '11.',
        "default": "",
        "multi": True,
        "hint": "Svaki prelom u novi paragraf. Ako nema preloma, napiši 'Bez preloma kostiju.'",
    },
    {
        "id": "dodatne",
        "title": "Dodatne pretrage",
        "para_idx": 27,
        "expect": '',
        "default": "",
        "multi": True,
        "hint": "Npr. histologija, toksikologija — više paragrafa.",
    },
    {
        "id": "misljenje",
        "title": "Mišljenje (numerisana lista)",
        "para_idx": 35,
        "expect": 'Smrt je',
        "default": "Smrt je nasilna i uzrokovana je ",
        "multi": True,
        "numbered": True,
        "hint": "Svaka tačka u novi red — automatski numeriše 1., 2., 3. ...",
    },
]


def all_section_ids():
    return [s["id"] for s in DICTATION_SECTIONS]


def load_template_texts(template_path: str) -> dict:
    """Učita stvarni tekst paragrafa iz template fajla (read-only).
    Vraća dict mapping section_id -> template paragraph text.

    Ovo je 'ground truth' za Claude merge — uvijek u sinhronu sa template-om.
    """
    from docx import Document
    doc = Document(template_path)
    paras = doc.paragraphs
    result = {}
    for s in DICTATION_SECTIONS:
        idx = s["para_idx"]
        if idx < len(paras):
            result[s["id"]] = paras[idx].text.strip()
        else:
            result[s["id"]] = ""
    return result


def sections_with_template(template_path: str):
    """Vraća kopiju DICTATION_SECTIONS sa dodanim 'template_text' poljem."""
    template_texts = load_template_texts(template_path)
    enriched = []
    for s in DICTATION_SECTIONS:
        copy = dict(s)
        copy["template_text"] = template_texts.get(s["id"], "")
        enriched.append(copy)
    return enriched
