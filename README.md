# Youtube Blocker (Firefox)

Firefox-Erweiterung, die unerwünschte YouTube-Inhalte **anhand des Titels und
des Vorschaubilds** erkennt und für Treffer aus deiner Liste das offizielle
YouTube-Signal **„Kein Interesse“** sendet.

## Wie es funktioniert

| Erkennungskanal | Methode | Benötigte Bibliothek |
|---|---|---|
| Videotitel | Unscharfer Token-Abgleich (Fälle, Tippfehler, Präfixe) mit der Schlüsselwortliste | nein |
| Foto — OCR | Text im Vorschaubild wird mit Tesseract.js (ru+en) erkannt und in der Wortliste gesucht | `lib/tesseract.min.js` |
| Foto — Vorlage | Schneller perzeptueller Vergleich dHash+pHash | nein (eingebautes canvas) |
| Vorschaubild — Semantik | Lokales SigLIP: **Text aus deiner Liste → visueller Inhalt des Vorschaubilds**; kein Hochladen von Referenzfotos nötig | `transformers.min.js` + lokales SigLIP-Modell |
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
./setup.sh          # lädt tesseract.js (~2 MB + Sprachdaten)
                    # optional — whisper.cpp und ein Modell für Sprache
```

## Installation in Firefox

1. `about:debugging#/runtime/this-firefox` → **Temporäres Add-on laden…**
2. Wähle `extension/manifest.json` aus.

Für eine dauerhafte Installation: `cd extension && web-ext build` (benötigt `npm i -g web-ext`).

## Verwendung

1. Öffne das Erweiterungs-Popup (Symbol in der Toolbar).
2. Trage die Liste ein — ein Begriff pro Zeile (Themen, Namen, Kanalnamen).
   Jeder Begriff wird im Titel und zusätzlich **semantisch im Vorschaubild**
   gesucht (lokales SigLIP). **OCR** lässt sich für Text im Vorschaubild
   zusätzlich einschalten.
3. Bei Bedarf **„Members only“ ausblenden** aktivieren — Videos mit
   Mitglieder-Badge werden dann unabhängig von der Liste versteckt.
4. Aktion wählen („Kein Interesse“ oder „Nur ausblenden“) — die Einstellungen
   werden automatisch gespeichert (Auto-Speichern mit kurzem Debounce) und
   sofort auf alle YouTube-Tabs angewendet.
5. YouTube-Tabs aktualisieren. Danach arbeitet die Erweiterung von selbst: Sie
   scannt die Vorschläge (Startseite, Suche, Abos, Seitenleiste, Empfehlungen)
   über einen MutationObserver.

Die Liste lässt sich als JSON exportieren; der Import öffnet einen eigenen Tab
(im Firefox-Popup würde der Datei-Dialog das Popup sofort schließen).

## Einstellungen

- `dHash/pHash-Schwelle` — Hamming-Distanz. Kleiner = strenger.
  Für Kopien derselben Vorschaubilder reichen 4–8.
- `Semantik-Schwelle` — SigLIP-Wahrscheinlichkeit nach Sigmoid (0.05–0.95). Höher = strenger. Erster Richtwert: **0.15**, danach an echten Vorschaubildern kalibrieren.
- `OCR-Sprachen` — standardmäßig `eng+rus`.
- `Pause zwischen Signalen` — Schutz vor Flutung der YouTube-Oberfläche.
- Sprache: Das Modell wird in `extension/models/` abgelegt, der Pfad wird in
  `speechModel` angegeben (z. B. `models/ggml-small.bin` — für Russisch
  braucht man ein multilinguales Modell, `base.en` versteht nur Englisch).

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
  Anfragen laufen sequenziell über eine Warteschlange und werden per videoId gecacht.
- Die Spracherkennung ist experimentell: lädt die Watch-Seite und den Audio-Stream,
  transkribiert nur die ersten N Sekunden. Für Russisch — multilinguales
  Modell (`small`), das sind ~460 MB im Worker.
- Shorts haben einen eigenen Renderer und sind im Erkennungsbereich enthalten; die Verfügbarkeit des offiziellen „Kein Interesse“ hängt vom aktuellen YouTube-Layout ab — wird kein eindeutiger Menüpunkt gefunden, wählt die Erweiterung keine zufällige Aktion, sondern blendet lokal aus.

## Struktur

```
extension/
  manifest.json   — MV2, content_scripts auf *.youtube.com
  content.js      — Orchestrator: DOM-Scan → Erkennung → Aktion
  matcher.js      — unscharfer Abgleich von Schlüsselwörtern
  image.js        — visuelle Deskriptoren (legacy; Referenzfotos nicht mehr nötig)
  semantic.js     — API für Text → Bild semantisches Matching
  semantic-worker.js — SigLIP-Image-Text-Logits im Worker
  ocr.js          — Tesseract.js im Blob-Worker (CSP-Umgehung)
  speech.js       — whisper.cpp im Worker (optional)
  dismiss.js      — Klick auf „Kein Interesse“ / CSS-Ausblendung
  background.js   — Badge-Zähler, Konfigurations-Cache
  popup/          — Verwaltung von Liste und Einstellungen
  lib/ models/    — externe Bibliotheken (werden von setup.sh befüllt)
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
node tests/test-matcher.js       # Modultest des Text-Matchers
npx web-ext lint --source-dir extension
npx web-ext run  --source-dir extension --start-url https://www.youtube.com/
```

Die Änderungshistorie steht in [`CHANGELOG.md`](CHANGELOG.md). Lizenz: [`LICENSE`](LICENSE) (MIT).
