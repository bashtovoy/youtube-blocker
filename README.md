# Youtube Blocker (Firefox & Chrome)

Browser-Erweiterung für Firefox und Chrome, die unerwünschte YouTube-Inhalte **anhand des Titels und
des Vorschaubilds** erkennt und für Treffer aus deiner Liste das offizielle
YouTube-Signal **„Kein Interesse“** sendet.

## Wie es funktioniert

| Erkennungskanal | Methode | Benötigte Bibliothek |
|---|---|---|
| Videotitel | Unscharfer Token-Abgleich (Fälle, Tippfehler, Präfixe) mit der Schlüsselwortliste | nein |
| Foto — OCR | Text im Vorschaubild wird mit Tesseract.js erkannt und in der Wortliste gesucht: PSM 11, getrennte Sprachmodelle, bei kurzem/unsicherem Text zusätzlich Rot-/Weiß-/Schwarz-Masken und Invertierung | `ocr-host.js` + `lib/tesseract.min.js` |
| Foto — Vorlage | Schneller perzeptueller Vergleich dHash+pHash | nein (eingebautes canvas) |
| Vorschaubild — Semantik | Lokales SigLIP: **Text aus deiner Liste → visueller Inhalt des Vorschaubilds**; Entscheidung über die kontrastive Margin (Ziel-Kosinus − bester Konkurrent), kein Sigmoid-Schwellwert, kein Hochladen von Referenzfotos. Modelle lokal (`setup.sh`) **oder** automatischer Erstbezug + Browser-Cache (siehe unten) | `transformers.min.js` + SigLIP-Modelle |
| Sprache im Video *(optional)* | Die ersten N Sekunden Audio laufen durch whisper.cpp (WASM) in einem separaten Worker, das Transkript wird in der Liste gesucht | `lib/whisper.js` + Modell in `models/` |

Bei einem Treffer wird die im Popup gewählte Aktion ausgeführt:

- **„Kein Interesse“** — automatischer Klick auf das offizielle Menü des
  Ergebniselements (⋮ → „Kein Interesse“). YouTube erhält ein echtes Signal
  von deinem Konto und empfiehlt die Inhalte nicht mehr.
- **„Nur ausblenden“** — CSS-Ausblendung des Elements (schneller und
  unabhängig vom Layout).

Alle Daten (Liste, Transkripte) werden nur lokal gespeichert
(`storage.local`) und nirgendwohin gesendet.

## Bibliotheken installieren

```bash
./setup.sh          # lädt tesseract.js (OCR: Bibliothek, Worker, Kern, eng/rus-Sprachdaten)
                    # außerdem die SigLIP-Modelle für die Semantik (siehe unten)
                    # optional — whisper.cpp und ein Modell für Sprache
```

## Installation in Firefox

1. `about:debugging#/runtime/this-firefox` → **Temporäres Add-on laden…**
2. Wähle `extension/manifest.json` aus.

Für eine dauerhafte Installation (aus dem Projektwurzelverzeichnis): `web-ext build --source-dir extension --artifacts-dir web-ext-artifacts --ignore-files "models/**" "models" "devreport.js"` (benötigt `web-ext`, z. B. via `npx web-ext`; die großen SigLIP-Modelle und die Dev-Brücke bleiben außen vor — die OCR-Sprachdaten in `lib/` sind enthalten, siehe „Modelle: lokaler Bezug und Offline-Betrieb“).

## Installation in Chrome

1. `node build-chrome.js` — baut `dist-chrome/` und `web-ext-artifacts/youtube_blocker-<version>-chrome.zip`.
2. `chrome://extensions` → **Entwicklermodus** einschalten → **Entpackte Erweiterung laden** → den Ordner `dist-chrome/` wählen.
3. Für den Chrome Web Store das erzeugte ZIP hochladen.

Hinweis: Chrome verlangt Manifest V3, und MV3-Service-Worker können keine Worker
erzeugen — deshalb laufen die Rechen-Hosts (SigLIP, Tesseract) in einem unsichtbaren
Offscreen-Dokument (`offscreen.html`), für Nutzer funktional identisch zu Firefox.
Der Firefox-Weg (Hintergrundseite) bleibt unverändert; `build-chrome.js` erzeugt das
MV3-Manifest aus dem Firefox-Manifest, damit beide Pakete aus einem Quellbaum kommen.
Mindestversion: Chrome 116.

## Verwendung

1. Öffne das Erweiterungs-Popup (Symbol in der Toolbar).
2. Trage die Liste ein — ein Begriff pro Zeile (Themen, Namen, Kanalnamen).
   Jeder Begriff wird im Titel und zusätzlich **semantisch im Vorschaubild**
   gesucht (lokales SigLIP). Über die Route je Begriff (Auto/Titel/OCR/Bild/
   Hybrid, siehe unten) lässt sich der Kanal einschränken. **OCR** lässt sich
   für Text im Vorschaubild zusätzlich einschalten. Unter jedem Begriff können
   **Ausnahmen** eingetragen werden; darunter steht die **globale Freigabe**
   (siehe „Ausnahmen und globale Freigaben“).
3. Bei Bedarf **„Members only“ ausblenden** aktivieren — Videos mit
   Mitglieder-Badge werden dann unabhängig von der Liste versteckt.
4. **„KI-Inhalte ausblenden“** ist standardmäßig aktiv: Karten mit dem
   YouTube-Hinweis-Badge für KI-erstellte Inhalte („AI“/„KI“/„ИИ“/„ШІ“)
   verschwinden unabhängig von der Liste; abschaltbar im Popup.
5. **„Werbekarten ‚YouTube empfiehlt‘ ausblenden“** ist ebenfalls standardmäßig
   aktiv: YouTube-eigene Werbe-/Empfehlungskarten („YouTube empfiehlt“,
   „Sponsored“, „Содержит платную рекламу“, CTA + „0 грн“ u. a.) verschwinden
   lokal, ohne „Kein Interesse“-Klick. Die Regeln liegen als Daten in
   `extension/promo-rules.js`; unter **„Diagnose der Werbeformate“** zeigt das
   Popup einen lokalen Bericht unbekannter Verdachtsfälle zum Kopieren.
6. Aktion wählen („Kein Interesse“ oder „Nur ausblenden“) — die Einstellungen
   werden automatisch gespeichert (Auto-Speichern mit kurzem Debounce) und
   sofort auf alle YouTube-Tabs angewendet.
7. YouTube-Tabs aktualisieren. Danach arbeitet die Erweiterung von selbst: Sie
   scannt die Vorschläge (Startseite, Suche, Abos, Seitenleiste, Empfehlungen)
   über einen MutationObserver.

Die Liste lässt sich als JSON exportieren; der Import öffnet einen eigenen Tab
(im Firefox-Popup würde der Datei-Dialog das Popup sofort schließen).

## Ausnahmen und globale Freigaben (ab 1.5.13)

Jedes Wort kann eigene Ausnahmen tragen. Im Popup steht unter dem Wort das Feld
**„Ausnahmen“**; in der Massenbearbeitung lautet das Format:

```
Roboter => Tennis, Tischtennis, Ping-Pong, tennis, теніс
```

Eine Ausnahme hebt nur dieses eine Wort auf. Andere Wörter der Liste treffen
weiterhin. Beispiel: „Робот-теннисист“ wird nicht wegen `Roboter` ausgeblendet;
ein Video, das zusätzlich `news` trifft, bleibt blockiert.

Zusätzlich gibt es die **globale Freigabe** („Global freigeben“ / „Разрешать
всё“). Eine Phrase pro Zeile, zum Beispiel:

```
No Tesla
```

Enthält Titel oder Kanal diese Phrase, wird die Karte durch kein Schlüsselwort
ausgeblendet — auch dann nicht, wenn sie weitere Wörter trifft. Normale
Tesla-Videos ohne „No Tesla“ bleiben blockiert. Dieselbe Phrase kann auch nur
beim Wort `Tesla` als Ausnahme eingetragen werden; dann gilt sie ausschließlich
für Tesla.

Matching: Groß-/Kleinschreibung, ё/е, Bindestriche und Satzzeichen werden
normalisiert. Kurze Begriffe (unter 4 Zeichen) treffen nur ein ganzes Wort;
längere auch Wortstämme (`теннис` → `теннисист`, `tennis` → `tennisplayer`).
Phrasen werden als Wortfolge verglichen, das letzte Wort darf ein Stamm sein
(`No Tesla` → `No Teslas`).

Grenzen:

- „No Tesla“ ist eine literale Phrase. „No Tesla? Tesla ist toll“ wird ebenfalls
  freigegeben. Eine semantische Anti-Tesla-Erkennung ist nicht enthalten.
- Die globale Freigabe wird gegen Titel und Kanal geprüft. Steht die Phrase nur
  im OCR-Text oder Transkript, greift sie in v1 nicht.
- KI-, Mitglieder- und Werbebadges werden durch Freigaben nicht aufgehoben.
- Bei einem semantischen Bildtreffer werden freigegebene Konzepte aus der
  Margin-Berechnung entfernt; ein anderes aktives Konzept kann weiterhin
  treffen. OCR und Sprache prüfen die Ausnahmen im jeweiligen Text mit.
- Alte JSON-Listen ohne `exceptions`/`allowAll` funktionieren unverändert; der
  Export enthält beide Felder ab 1.5.13.

## Kontrollbilder vor dem Ausblenden (ab 1.5.12)

Im Popup unter **„Kontrolle der Ausblendungen“** gibt es die Checkbox
**„Screenshot vor dem Ausblenden (nur Kartenbereich)“** (Standard: aus). Ist sie
aktiv, legt die Erweiterung vor jedem Ausblenden ein kleines JPEG der Karte ab —
nur der Rahmen der Karte, nicht der ganze Bildschirm:

```
Downloads/YouTube Blocker/JJJJ-MM-TT/HHMMSS_<videoId>_<Grund>.jpg
```

- Gründe im Dateinamen: `ai`, `members`, `promo`, `title`, `channel`,
  `semantic`, `ocr`, `speech`, `test`; Werbeplätze ohne Video-Kennung erscheinen
  als `slot`.
- JPEG-Qualität 30: Firefox speichert 1 CSS-Pixel je Bildpunkt, Chrome
  verkleinert auf höchstens 480 Pixel Breite — je nach Karte etwa 3–25 KB.
- Das Bild entsteht **vor** der Aktion — auch vor dem Klick auf „Kein
  Interesse“ und bei Werbe-Containern.
- Liegt die Karte noch nicht vollständig im sichtbaren Bereich, wartet das
  Ausblenden bis zu **8 Sekunden**; die Seite wird dabei nicht gescrollt.
  Wird die Karte in dieser Zeit nicht sichtbar, wird sie ohne Bild ausgeblendet
  und der Grund im Popup unter dem Häkchen angezeigt.
- **Status und Test:** Unter dem Häkchen steht der letzte Aufnahmeversuch
  (gespeichert, übersprungen oder Fehler). „Testaufnahme speichern“ prüft den
  kompletten Weg sofort, ohne auf eine Karte zu warten. Einstellungen wirken
  über `storage.onChanged` ohne Neuladen der YouTube-Seite.
- In Firefox-Privatfenstern wird der Download dem privaten Kontext zugeordnet;
  der Status zeigt das Privatfenster-Kennzeichen.
- Bereits ausgeblendete Karten, die YouTube neu rendert, erzeugen kein zweites
  Bild und keinen zweiten Zähler. Die Zahl „verdächtig“ in der Diagnose ist
  kein Zähler ausgeblendeter Karten.
- **Berechtigungen:** Beim ersten Einschalten fragt der Browser einmalig nach
  `downloads` und dem Zugriff auf alle Seiten (für den Bildschirmausschnitt).
  Beide sind optional und werden **nicht** bei der Installation verlangt;
  ohne sie bleibt die Funktion aus. Wird die Berechtigung später entzogen,
  zeigt das Popup einen Hinweis — Häkchen aus- und wieder einschalten.
- Firefox schneidet den Kartenrahmen direkt beim Aufnehmen zu
  (`tabs.captureTab`, `scale: 1`); Chrome nimmt den sichtbaren Tab auf und
  schneidet/verkleinert ihn im Hintergrund (`captureVisibleTab`, höchstens zwei
  Aufnahmen je Sekunde). Damit keine Bilder fremder Tabs entstehen, prüft
  Chrome unmittelbar vor der Aufnahme, dass der YouTube-Tab noch aktiv ist.

## Einstellungen

- `dHash/pHash-Schwelle` — Hamming-Distanz. Kleiner = strenger.
  Für Kopien derselben Vorschaubilder reichen 4–8.
- `Margin-Schwelle (Semantik)` — kontrastive Margin im Kosinus-Raum
  (Ziel-Kosinus − bester Kosinus der übrigen Konzepte), 0–1. Höher = strenger.
  Default **0.03**, kalibriert 10/2026 an Kontrollbildern (q8): echte Treffer
  liegen bei 0.04–0.08, Rauschen unter 0.03. Hinweis: Schreibweisen desselben
  Begriffs (Drone/Dron/UAV) sind füreinander Konkurrenten und drücken die
  Margin — pro Konzept möglichst eine Schreibweise verwenden. Weitere
  Kalibrierung: `gui-test-assets/padexp/`.
- `OCR-Sprachen` — standardmäßig `eng+rus`. Beim Öffnen des Popups werden
  die aktivierten Modelle vorgeladen; Status und Fortschritt stehen direkt
  unter der OCR-Zeile. Bei `eng+rus` laufen beide Modelle in getrennten
  Workern, damit ein Sprachwechsel die bereits geladene Sprache nicht
  verwirft.
- `Pause zwischen Signalen` — Schutz vor Flutung der YouTube-Oberfläche.
- Sprache: Das Modell wird in `extension/models/` abgelegt, der Pfad wird in
  `speechModel` angegeben (z. B. `models/ggml-small.bin` — für Russisch
  braucht man ein multilinguales Modell, `base.en` versteht nur Englisch).

## Oberflächensprache (ab 1.5.0)

Popup und Import-Seite sprechen Deutsch, Englisch, Russisch und Ukrainisch.
Die Auswahl steht oben im Popup; ohne gespeicherte Wahl wird beim ersten
Öffnen die Browsersprache übernommen (Fallback Deutsch). Die Wahl wird mit den
Einstellungen gespeichert (`settings.uiLang`) und reist im JSON-Export mit —
alte Exporte ohne `uiLang` behalten beim Import die aktuelle Sprache.

## Routen je Begriff und Kalibrierung (ab 1.3.0)

Jeder Begriff im Popup trägt optional eine **Route** — den Erkennungskanal:

| Route | Bedeutung |
|---|---|
| Auto | bisheriges Verhalten: Titel/Kanal + semantisches Bild (+ OCR, wenn aktiviert) |
| Titel | nur Titel-/Kanalabgleich |
| OCR | nur Texterkennung im Vorschaubild |
| Bild | nur semantisches Bild-Scoring |
| Hybrid | kontrollierte Kombination: Titel + OCR + Bild |

Die Route wird im Popup je Zeile gewählt, im JSON-Export/Import (`"route"`)
mitgeführt und ist ohne Codeänderungen konfigurierbar. Fehlt die Route
(z. B. in alten Exporten), gilt weiterhin „Auto“ — bestehende Listen
funktionieren unverändert.

Migration aus älteren Versionen:

- Der alte Wert `semanticThreshold` (Sigmoid 0.15) wird **nicht mehr
  verwendet**; die semantische Entscheidung basiert ausschließlich auf der
  kontrastiven Margin (`semanticMargin`). Alte Speicherwerte sind harmlos
  und können ignoriert werden.
- Schlüsselwörter ohne `route` verhalten sich wie bisher (alle Kanäle).

Kalibrierung: `gui-test-assets/padexp/` (siehe dortiges README) wertet ein
CSV-Manifest mit Vorschaubildern aus und liefert Precision/Recall/F1/FPR,
Verteilungen, Schwellen-Sweep und Latenz (70/30 Kalibrierung/Holdout). Die
Produktionsschwelle wird daraus konservativ abgeleitet (Falsch-Positive
wiegen schwerer) und hier dokumentiert.

## Modelle: lokaler Bezug und Offline-Betrieb (ab 1.4.0)

Die SigLIP-Modelle (Bild-Turm ~52–95 MB, Text-Turm ~94–106 MB, je nach
Gerät/Quantisierung: WebGPU q4f16, WASM q8) liegen **nicht** im ausgelieferten
Paket — das
AMO-Uploadlimit von 200 MB erlaubt das nicht. Die kleinen OCR-Sprachdaten
(`lib/eng.traineddata.gz`, `lib/rus.traineddata.gz`) sind dagegen im Paket
enthalten und werden beim Öffnen des Popups lokal vorgeladen. Die Erweiterung
sucht die SigLIP-Modelle in dieser Reihenfolge:

1. **Lokal** — `extension/models/siglip-base-patch16-224/onnx/…`, gefüllt von
   `setup.sh` (Dev-Builds, temporäre Installation).
2. **Browser-Cache** — bereits geladene Dateien (`transformers-cache`;
   `unlimitedStorage` im Manifest hebt das Quota auf).
3. **HuggingFace** — einmaliger Download von
   `huggingface.co/Xenova/siglip-base-patch16-224` (Revision fixiert). Das
   sind reine Gewichtsdateien, kein Code. Fortschritt: im Popup als
   „Semantik-Modelle werden geladen … X % (MB/MB, einmalig)“.

Nach dem ersten Bezug ist keine Verbindung mehr nötig; die Inferenz bleibt
lokal, es werden keine Daten gesendet. Der Erstbezug startet beim ersten
Vorschaubild-Vergleich. Waren Karten währenddessen schon geprüft, werden sie
automatisch neu bewertet, sobald der Kanal steht. Ein signierter Build
(`web-ext build` / AMO) bleibt unverändert unter dem Uploadlimit.

## Debugging und Prüfung (Dev-Modus)

Für End-to-End-Prüfungen ohne manuelles Öffnen der DevTools gibt es eine Dev-Infrastruktur:

```bash
node devserver.js &        # Log-Empfänger auf localhost:8788 + Befehlswarteschlange
npx web-ext run --source-dir extension   # Firefox mit Auto-Reload
node devtest.js "Anfrage"  # holt echte Titel aus den YouTube-Ergebnissen,
                           # setzt sie in die Blockliste und prüft die Auslösung
```

`extension/devreport.js` sendet `[YB]`-Logs an den devserver und fragt ihn
nach Testbefehlen ab (config/navigate/scroll/rescan). Läuft der devserver
nicht, deaktiviert sich das Modul nach 3 fehlgeschlagenen Versuchen still und
beeinflusst die Erweiterung nicht. Alle Logs werden zusätzlich in `dev.log` geschrieben.

## Bekannte Einschränkungen

- Die Selektoren des YouTube-Menüs („⋮“ → „Kein Interesse“) hängen vom Layout
  der Seite ab; bei einem Redesign kann der *dismiss*-Modus still ausfallen —
  dann greift der Fallback auf das Ausblenden. Die Erweiterung sucht den
  Menüpunkt über das `thumbs-down`-Icon, nicht über den Text, und ist daher
  unabhängig von der Sprache der Oberfläche.
- OCR ist aufwendig: bei großer Liste einschalten, sonst wird CPU unnötig verbraucht.
  Anfragen laufen sequenziell über eine Warteschlange; Ergebnisse werden je
  Bild-URL im Hintergrund-Host gecacht, die Tesseract-Worker werden nach zehn
  Minuten Leerlauf beendet und beim nächsten Bedarf neu gestartet. Bei kurzem
  oder unsicherem Erstantext läuft zusätzlich ein tiefer Durchgang mit fünf
  Bildvarianten — das kann pro Karte einige Sekunden dauern, verbessert aber
  stark stilisierte Thumbnails (neon, Rot/Weiß auf Schwarz, Glitch).
- Die Spracherkennung ist experimentell: lädt die Watch-Seite und den Audio-Stream,
  transkribiert nur die ersten N Sekunden. Für Russisch — multilinguales
  Modell (`small`), das sind ~460 MB im Worker.
- Shorts haben einen eigenen Renderer und sind im Erkennungsbereich enthalten; die Verfügbarkeit des offiziellen „Kein Interesse“ hängt vom aktuellen YouTube-Layout ab — wird kein eindeutiger Menüpunkt gefunden, wählt die Erweiterung keine zufällige Aktion, sondern blendet lokal aus.
- Die Werbekarten-Erkennung ist regelbasiert: YouTube benennt Badges und Layouts gelegentlich um. Dank mehrstufiger Signale (Text, Struktur, Container) trägt sie das meist weiter; ganz neue Formate erscheinen als Verdachtsfall im lokalen Diagnosebericht des Popups („Diagnose der Werbeformate“) und werden mit dem nächsten Release zur Regel. Es werden keine Daten gesendet.

## Struktur

```
extension/
  manifest.json   — MV2, content_scripts auf *.youtube.com
  content.js      — Orchestrator: DOM-Scan → Erkennung → Aktion
  matcher.js      — unscharfer Abgleich von Schlüsselwörtern
  promo-rules.js  — Datenregeln für Werbekarten (Muster, Gewichte, Schwelle)
  promo.js        — mehrstufige Werbekarten-Erkennung + Diagnose-Fingerabdruck
  image.js        — visuelle Deskriptoren (legacy; Referenzfotos nicht mehr nötig)
  semantic.js     — Content-Client: Text → Bild semantisches Matching (Messaging)
  semantic-host.js — SigLIP-Worker-Host in der Background-Seite (umgeht CSP/Trusted Types)
  semantic-worker.js — Text-/Bild-Embeddings + roher Kosinus (Bild-Turm resident, Text einmal je Liste)
  ocr.js          — Content-Client: Vorschaubild-OCR (Messaging)
  ocr-host.js     — Tesseract-Host in der Background-Seite (umgeht CSP/Trusted Types)
  speech.js       — whisper.cpp im Worker (optional)
  dismiss.js      — Klick auf „Kein Interesse“ / CSS-Ausblendung
  shots.js        — Kontrollbilder: Dateiname, Sichtbarkeit, Zuschnitt (Content + Hintergrund)
  background.js   — Badge-Zähler, Konfigurations-Cache, Semantik-/OCR-Routing, Kontrollbilder
  popup/          — Verwaltung von Liste und Einstellungen
  lib/ models/    — externe Bibliotheken; Modelle nur lokal (setup.sh) oder automatischer Erstbezug von HuggingFace in den Browser-Cache
```

## Änderungen in 1.1.0

- Erkennung auf den Scrollbereich beschränkt über `IntersectionObserver` (mit Vorladung).
- YouTube-Aktionen werden über eine gemeinsame Warteschlange serialisiert — mehrere Karten öffnen das Menü nicht mehr gleichzeitig.
- Gefährliches Anklicken des erstbesten Menüpunkts entfernt: Ohne eindeutiges „Kein Interesse“ wird nur lokal ausgeblendet.
- Die Ergebnisprüfung berücksichtigt nur einen neuen snackbar/Undo, der nach der aktuellen Aktion erschienen ist (Zustand wird vor dem Klick festgehalten).
- Für Vorschaubilder kommt zu `dHash` jetzt `pHash` hinzu — robust gegen Kompression, Farbe und leichten Zuschnitt.
- Das echte Vorschaubild wird vor der Prüfung geladen; ein Cache für visuelle Deskriptoren wurde ergänzt.
- Der Text-Matcher vergleicht nach Token und Wortgrenzen (kein blindes `includes()` und kein Prefix-Matching) — weniger falsche Treffer; auch der Kanalname wird berücksichtigt.
- In 1.1.1 zählt ein Bestätigungsdialog nur, wenn er nach der aktuellen Aktion erschienen ist; ein geöffnetes Menü ohne gefundenes „Kein Interesse“ gilt nicht mehr als Erfolg.
- Für dHash+pHash gilt eine kombinierte Toleranz: `pHash` allein kann eine Übereinstimmung nicht mehr bestätigen.
- Die Statistik trennt YouTube-Signale (`dismissedCount`) und lokale Ausblendungen (`hiddenCount`).
- Das Whisper-Standardmodell ist jetzt das multilinguale `models/ggml-base.bin`; im Popup sind Sprache, Modellpfad und Dauer der Sprachanalyse verfügbar.

> Der wichtigste visuelle Kanal ist jetzt **Text → Bild**. `dHash`/`pHash` und eigene Referenzfotos gehören nicht mehr zum Hauptszenario.

## Entwicklung und Tests

```bash
node --check extension/*.js      # Syntax
node tests/test-matcher.js       # Modultest des Text-Matchers und der Badge-Erkennung (Members/KI)
node tests/test-exceptions.js    # Freigaben pro Wort und global (No Tesla), Semantik-Filter
node tests/test-promo.js         # Werbekarten: Signale, Schwelle, externe Ziele, Diagnose
node tests/test-margin.js        # Kontrastive Margin-Entscheidung (Semantik)
node tests/test-routes.js        # Routen je Schlüsselwort (title/ocr/image/hybrid)
node tests/test-ocr-client.js    # OCR-Client: Nachrichtenformat, Kette, Fehler, Timeout
node tests/test-ocr-host-image.js # OCR-Host: AVIF/JPEG/WebP, PSM 11, Sprachwahl, Masken
node tests/test-background-route.js # Nachrichtenrouting (Firefox-Route / Chrome-Offscreen)
node tests/test-i18n.js          # Modultest der Oberflächensprachen (de/en/ru/uk)
node tests/test-shots.js         # Kontrollbilder: Dateiname, Sichtbarkeit, Zuschnitt
node tests/test-chrome-manifest.js # MV2→MV3-Transformation (Host-Muster, Service Worker, CSP, offscreen)
node tests/test-quiet-warn.js    # Log-Filter: genau die bekannten transformers.js-/Tesseract-Meldungen werden verworfen
node tests/test-ocr-worker.js    # OCR-Worker-Einstieg: Filter lädt vor dem Tesseract-Skript
node tests/test-reinject-health.js # Selbstheilung verwaister Content-Scripts (Drossel, Sitzungs-Marker, Versionswechsel)
node build-chrome.js             # Chrome-MV3-Sammlung → dist-chrome/ + web-ext-artifacts/*-chrome.zip
npx web-ext lint --source-dir extension
npx web-ext run  --source-dir extension --start-url https://www.youtube.com/
```

Die Änderungshistorie steht in [`CHANGELOG.md`](CHANGELOG.md). Lizenz: [`LICENSE`](LICENSE) (MIT).
