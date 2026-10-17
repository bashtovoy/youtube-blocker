# Changelog

Alle bedeutenden Änderungen des Projekts sind hier dokumentiert. Format — [Keep a Changelog](https://keepachangelog.com/),
Versionierung — [Semantic Versioning](https://semver.org/).

## [1.5.0] — 2026-10-17

### Hinzugefügt
- **Wählbare Oberflächensprache (DE/EN/RU/UK)**: Im Popup lässt sich die Sprache der Oberfläche umschalten — auch die Import-Seite folgt ihr. Ohne gespeicherte Wahl wird beim ersten Öffnen die Browsersprache übernommen (Fallback Deutsch); danach gilt die Auswahl. Sie wird mit den Einstellungen gespeichert (`settings.uiLang`) und im JSON-Export/-Import mitgeführt.
- Eigene Übersetzungsschicht `popup/i18n.js` statt `browser.i18n`: nötig, weil Firefox-`i18n` an die Browsersprache gebunden ist und nicht zur Laufzeit umschaltet.
- Test `tests/test-i18n.js`: prüft Schlüssel- und Platzhalter-Parität der vier Wörterbücher sowie die Abdeckung aller im HTML/JS verwendeten Schlüssel.

### Geändert
- Popup- und Import-Texte sind mit `data-i18n`-Attributen markiert; die deutschen Texte bleiben unverändert.
- JSON-Import ohne `uiLang` (alte Exporte) behält die aktuell gewählte Oberflächensprache.

## [1.4.0] — 2026-10-17

### Hinzugefügt
- **Modelle laden selbst nach (Remote-Fallback)**: Fehlen die SigLIP-Dateien in `extension/models/` — z. B. in der signierten AMO-Version, deren Paket wegen des 200-MB-Uploadlimits keine Modelle enthalten kann — lädt die Erweiterung sie beim ersten Bildabgleich direkt von HuggingFace (Revision fixiert) und legt sie im Browser-Cache ab (`transformers-cache`, `unlimitedStorage` im Manifest). Danach läuft alles offline; die Inferenz bleibt ausschließlich lokal.
- Popup zeigt den Semantik-Status inklusive Downloadfortschritt („Semantik-Modelle werden geladen … X % (MB/MB, einmalig)“).
- Stand der semantische Kanal anfangs nicht bereit (z. B. laufender Erstbezug), werden bereits geprüfte Karten automatisch neu bewertet, sobald er steht — ohne manuellen Reload.

### Geändert
- **Eigener Text-Turm statt Gesamtmodell**: Der temporäre Text-Worker nutzt jetzt `SiglipTextModel` (`text_model_q4/q4f16`) statt des 218-MB-Gesamtmodells — identische Embeddings (Diagnose: Abweichung ≤ 1e-3), kleinerer Bezug (99/155 MB) und kürzerer Lauf. Der Bild-Turm bleibt dauerhaft resident.
- `semantic-worker.js`: `allowRemoteModels=true` mit fixierter Revision; Netz-/Downloadfehler sind wiederholbar (kein dauerhaftes Abschalten des Kanals), Fortschrittsmeldungen gehen an den Host.
- `setup.sh` lädt nur noch die beiden Türme (`vision_model_q4/q4f16`, `text_model_q4/q4f16`).
- README: Abschnitt zu Modellbezug, Offline-Betrieb und AMO-Uploadlimit.

## [1.3.0] — 2026-10-17

### Hinzugefügt
- **Routen je Schlüsselwort** (`title`/`ocr`/`image`/`hybrid`, Auswahl im Popup, im JSON-Export/-Import mitgeführt): Jeder Begriff lässt sich auf einen Erkennungskanal beschränken — z. B. nur Titel oder nur semantisches Bild. Fehlende Route = bisheriges Verhalten (alle Kanäle); bestehende Listen und Exporte funktionieren unverändert.
- **Kontrastive Margin statt Sigmoid**: Die semantische Entscheidung nutzt den rohen Kosinus der SigLIP-Embeddings und die Margin „Ziel-Kosinus − bester Konkurrent“ (`semanticMargin`, Popup-Feld „Margin-Schwelle“, Default 0.1 — bewusst streng und unkalibriert). Bei einem Treffer protokolliert die Konsole die Entscheidung (Konzept, Ziel-Kosinus, Konkurrenz, Margin, Schwelle, Profil `margin-v1`).
- **Kalibrierungswerkzeuge** in `gui-test-assets/padexp/`: Offline-Auswertung eines CSV-Manifests mit Precision/Recall/F1/FPR je Konzept, Verteilungen von Kosinus und Margin, Schwellen-Sweep, deterministischer 70/30-Split (Kalibrierung/Holdout) und Latenz p50/p95 — nur Skripte, keine Bilder oder Modelle im Repo.

### Geändert
- **Schneller und sparsamer**: Der SigLIP-Text-Turm läuft nur noch einmal je Wortlisten-Revision (temporärer Worker, danach beendet — garantiertes Freigeben der 218 MB); dauerhaft bleibt nur der Bild-Turm im Speicher (**63 MB statt 218 MB**). Die Text-Embeddings überleben den Idle-Abbau im Host und werden zurückgespielt (Wiedereinstieg nur mit Bild-Turm statt erneutem Text-Lauf).
- Worker-Protokoll: `image-scores` liefert Kosinus-Werte statt Sigmoid-Wahrscheinlichkeiten; `semanticThreshold` ist ersetzt durch `semanticMargin` (alte gespeicherte Werte werden ignoriert).

### Tests
- Neu: `tests/test-margin.js` (Margin-Entscheidung, Grenzwerte, Synonym-Kannibalisierung) und `tests/test-routes.js` (Routen-Matrix, Altformat-Kompatibilität).

## [1.2.3] — 2026-10-16

### Behoben
- Semantischer Bildabgleich auf YouTube funktioniert wieder: YouTube verbietet Content-Scripts per Trusted Types/CSP das Erzeugen von Workern (`Worker constructor: Sink type mismatch … blocked by CSP`), wodurch der Kanal bisher still ausfiel. Der SigLIP-Worker läuft jetzt in der Background-Seite (`semantic-host.js`); Content-Scripts sprechen nur noch per Messaging mit ihm.
- Der SigLIP-Score läuft auf WASM rund 3× schneller (≈15 s → ≈5 s pro Vorschaubild): Batch-Padding nur auf die längste Sequenz statt 64 Tokens pro Prompt. Ergebnisse werden pro Bild-URL und Wortlisten-Version gecacht.
- Ein Worker für alle Tabs statt einem pro Tab; Lazy-Init beim ersten Bildvergleich, Abbau nach 10 Minuten Leerlauf, Modell-/Worker-Fehler werden einmal gemeldet statt pro Karte.
- Shorts-Regale im neuen Layout (`ytm-shorts-lockup-view-model-v2`) werden wieder erkannt.
- Von YouTube neu gerenderte Karten (Shelf-/Feed-Recycling) oder Karten, deren Klassen YouTube zurücksetzt, verlieren den Ausblendstatus nicht mehr dauerhaft: bereits getroffene Videos werden lokal erneut ausgeblendet (Re-Hide-Sweep in `scanNow` + Beobachtung von `class`-Änderungen) — ohne zweites offizielles Signal und ohne den Zähler erneut zu erhöhen.
- Badge-Zähler verlor Inkremente bei parallelen Treffern (nicht serialisiertes Lesen/Schreiben im Background).

## [1.2.2] — 2026-10-16

### Hinzugefügt
- JSON-Import der Wortliste in einem eigenen Tab (das Firefox-Popup schließt sich, sobald der Datei-Dialog aufgeht, und `onchange` ginge verloren).
- Option „Members only“: Videos mit Mitglieder-Badge werden ausgeblendet.
- Sichtbare Build-Nummer im Popup-Kopfbereich.

### Geändert
- Automatisches Speichern im Popup mit Debounce statt „Speichern“-Button; jede Änderung benachrichtigt die YouTube-Tabs sofort.
- Robuste Selektoren für die neuen YouTube-Komponenten (`yt-lockup-view-model`, Shorts-View-Model); nicht gerenderte Karten werden erneut geprüft statt dauerhaft übersprungen.
- Badge-Zähler wird bei jedem Neuladen/Übergang der YouTube-Seite zurückgesetzt.

## [1.2.0] — semantischer Text-zu-Bild-Abgleich

- Die Wortliste wird über das lokale SigLIP-Modell mit dem visuellen Inhalt der Vorschaubilder verglichen.
- Fotovorlagen sind nicht mehr Pflichtbestandteil des semantischen Workflows.
- SigLIP nutzt projizierte Image-Text-Logits und einen Sigmoid-Score.
- OCR und Titel-/Kanalabgleich bleiben zusätzliche Erkennungskanäle.

## [1.1.1]

- Lokale Semantic-Vision-Schicht SigLIP für den bildlich-semantischen Vergleich von Vorschaubildern.
- Referenzfotos erhalten normalisierte 768-dimensionale Embeddings und werden lokal gespeichert.
- Die Inferenz läuft in einem eigenen Worker; ohne Modell arbeitet die klassische Kaskade weiter.
- Neue Einstellungen `checkSemanticImage` und `semanticThreshold`.
- Verfeinerte `Not interested`-Prüfung, Text-Matcher und kombinierter dHash/pHash-Matcher.

## [1.1.0] — 2026-10-04

Zusammenführung der Verbesserungen aus einem externen Audit (unter Beibehaltung der zuvor umgesetzten Fixes).

### Hinzugefügt
- Verarbeitung von Karten im Scrollbereich über `IntersectionObserver` (rootMargin-Vorladung) statt Scannen des gesamten DOM.
- Lebenszyklus des Vorschaubilds: Das echte Vorschaubild wird geladen (`waitForImage`), der Schlüssel für die erneute Verarbeitung berücksichtigt die Bild-URL.
- LRU-Cache für visuelle Deskriptoren der Vorschaubilder (dieselbe URL wird nicht erneut berechnet).
- Serialisierung der YouTube-Aktionen über eine gemeinsame Warteschlange (mehrere Karten öffnen das Menü nicht mehr gleichzeitig).
- `pHash` (DCT) als zweiter visueller Deskriptor über dem schnellen `dHash`; eine Vorlage speichert beide.
- Getrennte Statistik: `dismissedCount` (offizielle YouTube-Signale) und `hiddenCount` (lokale Ausblendungen); Badge = Summe.
- Abgleich über den Kanalnamen (neben dem Titel).
- Whisper-Felder im Popup: Sprache, Modellpfad, Dauer der Analyse.
- Modultest `tests/test-matcher.js`.

### Geändert
- Text-Matcher: blindes `includes()` entfernt; Abgleich nach Token und Wortgrenzen, kurze Wörter werden nur vollständig verglichen, Unscharfheit mit begrenzter Levenshtein-Distanz (weniger falsche Treffer).
- Strengere Ergebnisprüfung: Der Snackbar-Zustand wird VOR dem Klick festgehalten und nur ein neues `Undo`/Snackbar/Verschwinden der Karte wird gezählt.
- Das Whisper-Standardmodell wurde auf das multilinguale `models/ggml-base.bin` gebracht (abgestimmt mit `content.js` und `setup.sh`).

### Behoben
- Gefährlicher Fallback „ersten Menüpunkt anklicken“ entfernt: Wird kein eindeutiger Punkt „Kein Interesse“ gefunden, wird nichts Zufälliges ausgewählt, sondern nur lokal ausgeblendet.

## [1.0.3] — 2026-10-04

### Geändert
- Umstellung auf `IntersectionObserver`, es werden nur sichtbare Karten gescannt; `scroll`-Listener entfernt.
- Helles, „fröhliches“ Popup-Theme.

## [1.0.2] — 2026-10-04

### Behoben
- Kritischer Bug: `clickDismissConfirm()` konnte im Snackbar „Rückgängig/Undo“ anklicken und das gerade gesendete Signal zurücknehmen. Die Bestätigung wird nur innerhalb eines wirklich geöffneten Dialogs gesucht, Undo wird nie angeklickt.
- Der Modus „nur Bilder“ startete kein Scannen (`hasDetectionTargets()` berücksichtigte nur Schlüsselwörter).
- Die Auswahl der OCR-Sprachen wurde faktisch nicht angewendet (der Parameter `langs` erreichte die Worker-Initialisierung nicht; Neuerstellung des Workers beim Sprachwechsel ergänzt).

### Hinzugefügt
- Extraktion und Abgleich des Kanalnamens.

## [1.0.1] — 2026-09-30

### Geändert
- Produktions-Manifest: Dev-Brücke `devreport.js` aus den geladenen Skripten entfernt, Berechtigungen von `<all_urls>` auf konkrete Domains eingeschränkt, `data_collection_permissions` und gültige Icons 48/96 ergänzt.

## [1.0.0] — 2026-09-30

### Hinzugefügt
- Basisimplementierung: Erkennung über den Titel (unscharfer Matcher) und das Vorschaubild (dHash + OCR), optionale Sprache (Whisper), Automatisierung von „Kein Interesse“, Popup-Editor für die Liste, Zähler am Badge.
