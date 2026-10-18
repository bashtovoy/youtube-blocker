# Changelog

Alle bedeutenden Änderungen des Projekts sind hier dokumentiert. Format — [Keep a Changelog](https://keepachangelog.com/),
Versionierung — [Semantic Versioning](https://semver.org/).

## [1.5.5] — 2026-10-18

### Behoben
- **Semantik-Statusanzeige blieb nach Browser-Neustart oder Update grau (○), obwohl die Modelle bereits geladen waren.** Es gibt zwei kalte Pfade, in denen kein Host-Status existiert: der Chrome-Service-Worker beantwortet Statusfragen, solange das Offscreen-Dokument noch nicht gestartet ist (neuer Zustand `off` ohne `lastUsedAt`), und der Host selbst startet nach jedem Neustart mit `off`. Beide prüfen jetzt den Modellbestand im Browser-Cache (neu: `model-cache.js`, Cache API „transformers-cache“, beide Turm-Paare q8/q4f16) und melden ihn als Feld `cached`. Das Popup zeigt damit grün mit dem Tooltip „Bereit — Modelle werden bei Bedarf in Sekunden geladen“ und dem Hinweis „Semantik-Modelle: heruntergeladen …“ statt „werden beim ersten Vorschaubild vorbereitet“. Ohne Cache bleibt die Anzeige bewusst grau (einmaliger Erstbezug beim ersten Vorschaubild).
- Zusätzlich: Wurden die Modelle in der laufenden Sitzung geladen (Cache, lokale Dateien oder Erstbezug), gilt der Bestand als vorhanden (`filesCached`) — die Anzeige fällt nicht mehr hinter den Live-Status zurück.

### Tests
- Neues Chrome-E2E-Szenario `t-sem-status`: Kaltstart mit Cache → grün (`off` + `cached:true`), Cache gelöscht → grau mit Hinweis, echter Erstbezug mit sichtbarem Fortschrittsbalken → grün (`ready`), Browser-Neustart mit Cache → wieder grün. Alle Schritte grün auf Chrome for Testing (isoliertes Testprofil).

## [1.5.4] — 2026-10-18

### Behoben
- **„Members only“ wurde nicht mehr erkannt und damit nicht ausgeblendet (Sammel-Build Chrome und Firefox).** YouTube rendert die Mitgliedschafts-Markierung inzwischen über View-Model-Badges (`yt-thumbnail-badge-view-model`, `yt-thumbnail-overlay-badge-view-model`, `ytd-badge-supported-renderer` u. a.); der bisherige Selektor fand sie nicht. Der Badge-Text wird jetzt aus Textinhalt, `aria-label` und `title` zusammengesetzt und über eine mehrsprachige Erkennung im Matcher geprüft (verifiziert an @LinusTechTips in de/ru/uk/en; „Sponsored“, Uhrzeiten und „Membership“ zählen bewusst nicht). Ein erst nach dem ersten Rendern angehängter Badge wird ebenfalls erkannt: vorgemerkte Karten werden bei DOM-Mutationen und beim Re-Render erneut geprüft.
- **„Members only“ wird lokal ausgeblendet, statt „Kein Interesse“ zu senden.** Die Markierung gehört zum Angebot, nicht zu den Interessen — im *dismiss*-Modus wird sie jetzt ohne Menü-Klick entfernt (eigener Zähler `hiddenCount`).
- **Semantik: Bildabgleich lieferte seit 1.2.3 unbrauchbare Werte (Padding-Regression).** Die Text-Prompts werden wieder auf die volle Modelllänge gepolstert (`padding:'max_length'`): SigLIP poolt die letzte Position und ist auf den EOS-Pad-Schwanz trainiert — ohne Pad kippte das Ranking messbar (Kontrollbild Katze: „cat“ −0.066 auf Platz 4 statt 0.051 auf Platz 1). Zusätzlich werden Konzepte intern kleingeschrieben, weil der Gemma-Tokenizer Großschreibung anders zerlegt („drone“ 0.072 vs. „Drone“ −0.015 auf demselben Drohnen-Vorschaubild). Erst damit liefert der Kanal echte Treffer (Ende-zu-Ende in Chrome verifiziert).
- **Leere Zahlenfelder aus alten Importen** (z. B. `actionDelayMs:""`) wurden über `Number('')` zu 0 und schalteten die Pausen still ab; Content, Popup und Import bereinigen Werte jetzt (Bereiche 0–60000 / 0–1 / 10–600 / 0–30, Import hebt Leerwerte auf Defaults). Die Popup-Speicherung wartet zudem auf `load()` — ein früher Klick kann keine leeren Felder mehr überschreiben.
- **`dHash/pHash-Schwelle`** wird im Popup jetzt geladen und gespeichert (fehlte in der Werte-Liste).
- **Sprachkanal:** War der Blob-Worker auf YouTube durch die CSP blockiert, warf `speech.js` einen unbehandelten Fehler im Content-Script; der Start fängt das jetzt ab und meldet kontrolliert „nicht verfügbar“ (mit `browser`/`chrome`-Shim).

### Geändert
- **Semantik-Standardschwelle 0.1 → 0.03** (kalibriert 10/2026 an Kontrollbildern mit q8: echte Treffer 0.04–0.08, Rauschen < 0.03; 0.1 war praktisch unerreichbar). Gilt für Content-Standard, Popup, Import-Merge und `marginDecision`-Fallback. Siehe `docs/SEMANTIC_FILTER_ROUTING.md`, Nachtrag 10/2026.
- **WASM-Quantisierung q4 → q8** (deutlich größere Abstände echter Treffer: 0.04–0.08 statt 0.02–0.05); WebGPU bleibt q4f16. `setup.sh` lädt entsprechend q8 für WASM.
- **`config-changed` startet die Beobachter ohne Neuladen** — wurde eine Seite mit leerer Liste geöffnet, existierte kein MutationObserver, und erst danach angelegte Einträge wurden bis zum manuellen Reload ignoriert.
- **Importe mergen die Einstellungen**, statt sie zu ersetzen; eine reine Wortliste (Array) setzt keine Einstellungen mehr zurück.
- `YB.debug.state()` zeigt zusätzlich `imageKeywords`, `semanticReady`, `semanticFailed`; neu `YB.debug.audit()` mit Members-Zählern für Tests und Betrieb.

### Tests
- Neue Matcher-Tests für die Badge-Erkennung (mehrsprachige Positivbeispiele, Gegenproben „Sponsored“/Uhrzeit/„Membership“); `tests/test-margin.js` an den neuen Fallback angepasst.
- Chrome-E2E auf Chrome for Testing (separates Testprofil): Members-Badges in vier Sprachen, spät gerenderte Badges und Re-Render, Popup-Wertebereinigung, OCR-Route, Semantik-Download/Scoring/Content-Route, robuster Sprachkanal, dismiss-Modus — alle grün.

## [1.5.3] — 2026-10-17

### Hinzugefügt
- **Fortschrittsbalken für den Modellbezug im Popup:** Der einmalige SigLIP-Download wird jetzt als horizontaler Balken mit Prozent- und MB-Angabe angezeigt; ohne exakte Byte-Werte läuft eine unbestimmte Animation. Sind die Modelle bereit, wird die Zeile grün mit Haken.
- **Statusanzeige je Erkennungskanal unter „Was geprüft wird“:** Ein Symbol rechts neben jedem Eintrag zeigt den echten Zustand — grüner Haken = aktiv und einsatzbereit (Semantik-Modelle bereit, OCR-Host erreichbar, lokale Kanäle ohne Abhängigkeiten), grauer Ring = ausgeschaltet oder noch nicht vorbereitet, blaue Punkte = lädt gerade, rotes Ausrufezeichen = Fehler. Für die Spracherkennung wird geprüft, ob die Whisper-Bibliothek wirklich installiert ist (die Platzhalterdatei aus dem Paket zählt nicht). Erklärungen erscheinen als Tooltip in der eingestellten Oberflächensprache. Gibt die Semantik nach Leerlauf ihren Arbeitsspeicher frei, bleibt die Anzeige grün — die Modelle laden bei Bedarf automatisch in Sekunden nach.
- **Chrome-Unterstützung (Manifest V3):** Dieselbe Erweiterung läuft jetzt auch in Chrome — `node build-chrome.js` erzeugt `dist-chrome/` und ein ZIP für „Entpackte Erweiterung laden“ bzw. den Chrome Web Store, das MV3-Manifest entsteht dabei automatisch aus dem Firefox-Manifest. Da MV3-Service-Worker keine Worker erzeugen können, laufen die Rechen-Hosts (SigLIP, Tesseract) in einem unsichtbaren Offscreen-Dokument (`offscreen.html`); der Firefox-Weg über die Hintergrundseite bleibt unverändert. Gemeinsame Bausteine: `host-routes.js`; die Hintergrund-Nachrichten nutzen nun die von beiden Browsern unterstützte Antwortform (`sendResponse`), `storage.local.onChanged` wurde durch das portable `storage.onChanged` ersetzt.

### Behoben
- **Manifest bereinigt:** Der versehentlich unter `content_scripts` abgelegte Block `web_accessible_resources` wurde entfernt. In Manifest V2 ist das ein Schlüssel auf oberster Ebene; an der falschen Stelle wurde er ignoriert und Firefox zeigte beim Laden eine Manifest-Warnung. Die aktuellen Worker (Semantik, OCR) laufen im Hintergrund und brauchen keine für Webseiten freigegebenen Ressourcen.
- **Semantik: Gerätewechsel jetzt zuverlässig.** Scheiterte der Start auf der GPU (kein nutzbarer WebGPU-Adapter — etwa in virtuellen Maschinen, Remote-Sitzungen oder ohne passenden Grafiktreiber), blieb die Semantik dauerhaft auf Fehler: Der Ausweichversuch auf WASM lief im selben Worker und scheiterte reproduzierbar am beschädigten ONNX-Laufzeitzustand (dieselbe Adapter-Meldung). Jetzt meldet der Worker den nötigen Gerätewechsel an den Host, der ihn durch einen frischen Worker ersetzt — der WASM-Ausweichpfad startet sauber, im Chrome-Offscreen-Dokument end-to-end verifiziert (Modellstart und Bildbewertung ohne GPU).

## [1.5.2] — 2026-10-17

### Behoben
- **OCR der Vorschaubilder funktioniert jetzt auf YouTube.** Der Tesseract-Worker wurde — wie zuvor schon der SigLIP-Worker (1.3.0) — aus dem Content-Script in die Background-Seite verlegt (`ocr-host.js`): YouTube (Trusted Types + CSP) blockiert das Erzeugen von Workern aus Content-Scripts, dadurch startete der Kanal dort überhaupt nicht (`Worker constructor: … blocked by CSP`). Zusätzlich fehlten der Sprach-/API-Initialisierungsschritt (tesseract.js 4.1.1 lädt Sprache und API nicht automatisch) und die richtige Optionsübergabe (4.1.1 akzeptiert `createWorker`-Optionen nur als einzelnes Objekt — die v5-artige Aufrufform ließ Worker-, Kern- und Sprachpfade wirkungslos, sodass alles über CDN-Standardpfade lief). Jetzt laufen Bibliothek, Worker-Skript, SIMD-Kern (4.0.4, selbstenthalten) und eng/rus-Sprachdaten vollständig lokal aus `lib/`; zur Laufzeit gibt es keinen CDN-Bezug.
- Nur echte Kanal-Fehler (Bibliothek/Kern/Sprachdaten defekt) schalten den OCR-Kanal für die Seitensession ab; einzelne Bildfehler werden übersprungen. Erkennungstexte werden im Hintergrund-Host je Bild-URL gecacht.

### Geändert
- Die Tesseract-Bibliothek wird nicht mehr in jede YouTube-Seite injiziert; im Content-Script bleibt nur der schlanke Messaging-Client (`ocr.js`). Der Hintergrund-Host beendet den Worker nach zehn Minuten Leerlauf und startet ihn beim nächsten Bedarf neu.
- `web_accessible_resources` von den OCR-Dateien befreit (die Seite braucht sie nicht mehr), `setup.sh` lädt das Worker-Skript mit, die tote Kern-URL (404) ist ersetzt, der separate `.wasm`-Bezug entfällt — das 4.0.4-Abbild bringt die wasm-Binärdatei bereits mit.
- Test `tests/test-ocr-client.js`: Nachrichtenformat, Serialisierung, Fehler- und Timeoutpfade des OCR-Clients.

## [1.5.1] — 2026-10-17

### Behoben
- **Semantik-Status im Popup ist jetzt immer sichtbar.** Vorher blieb die Statuszeile nach einem frischen Start leer, bis die erste Bildprüfung lief — der Hintergrundprozess veröffentlicht den Status jetzt schon beim Start, das Popup zeigt ohne gespeicherten Status den Hinweistext statt einer leeren Zeile und fragt beim Öffnen zusätzlich den Live-Status beim Hintergrundprozess ab.

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
