# Changelog

Alle bedeutenden Änderungen des Projekts sind hier dokumentiert. Format — [Keep a Changelog](https://keepachangelog.com/),
Versionierung — [Semantic Versioning](https://semver.org/).

## [1.2.3] — 2026-10-24

### Hinzugefügt
- Optionaler Filter für stark übertriebene Gesichtsausdrücke in Vorschaubildern auf Basis des vorhandenen lokalen SigLIP-Modells.
- Separater Schwellenwert; Funktion ist standardmäßig deaktiviert.
- Keine neue Modellabhängigkeit und keine Übertragung von Vorschaubildern.

### Hinweise
- Erste Version bewertet das ganze Vorschaubild statt einer ausgeschnittenen Gesichtsregion; Ergebnisse müssen anhand realer Beispiele kalibriert werden.

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
