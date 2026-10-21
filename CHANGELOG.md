# Changelog

Alle bedeutenden Änderungen des Projekts sind hier dokumentiert. Format — [Keep a Changelog](https://keepachangelog.com/),
Versionierung — [Semantic Versioning](https://semver.org/).

## [1.5.21] — 2026-10-21

### Behoben
- **Chrome fragt den Ordnerzugriff nicht mehr bei jedem Öffnen erneut ab.**
  Bisher wurde die Freigabe im Popup erteilt. Chrome zeigt dort keinen
  Berechtigungsdialog: Für das Popup gilt der Zugriff still und nur für den
  Augenblick; nach dem Schließen war er fort. Deshalb stand beim nächsten
  Öffnen wieder „Zugriff bestätigen“, und der Service Worker konnte wartende
  Bilder nicht schreiben. Die Einrichtung läuft jetzt auf der neuen Seite
  **Ordnerzugriff** in einem echten Tab. Dort zeigt Chrome den Dialog; nach
  „Bei jedem Besuch erlauben“ bleibt der Zugriff dauerhaft — auch für den
  Service Worker und nach einem Browserneustart.
- **Die Seite prüft das Ergebnis selbst.** Nach der Freigabe schließt der
  Hintergrund den Tab und öffnet die Seite mit `?verify=1` neu. Ist der
  Zugriff dann ohne Klick „granted“, ist er dauerhaft; andernfalls erklärt
  die Seite den zweiten Schritt und öffnet den Dialog erneut. Erst danach
  werden wartende Bilder geschrieben.

### Geändert
- **Popup:** „Ordner wählen…“ und „Zugriff einrichten…“ öffnen die neue
  Seite. Der irreführende Hinweis, im Popup „Bei jedem Besuch erlauben“ zu
  wählen, ist ersetzt und nennt jetzt den echten Weg.
- **Testaufnahme:** Fehlt der Ordnerzugriff, öffnet sie die Einrichtungsseite
  und meldet das im Popup, statt einen wirkungslosen Einmal-Zugriff zu holen.

### Tests
- `e2e-chrome-fsa` prüft, dass der Popup-Knopf die Einrichtungsseite öffnet,
  die Seite mit erteiltem Zugriff den dauerhaften Zustand zeigt und die
  Warteschlange selbst nachschreibt.
- `test-background-route` prüft `ybfolder-reopen`: Tab schließen, Prüfseite
  genau einmal mit `?verify=1&n=…` öffnen und ohne Absender-Tab sauber
  ablehnen.

## [1.5.20] — 2026-10-21

### Behoben
- **Chrome: „Zugriff erneuern“ schreibt wartende Bilder jetzt wirklich.**
  Die Ordnerfreigabe erteilt der Nutzer im Popup, geschrieben wurde die
  Warteschlange aber vom Service Worker — der dieselbe Freigabe nicht zwingend
  sieht. Der Klick schien deshalb zu wirken, „Wartend: N“ blieb stehen, und
  beim nächsten Öffnen verlangte der Ordnerstatus erneut eine Bestätigung. Das
  Popup schreibt die Warteschlange jetzt direkt im eigenen Kontext (dort gilt
  die soeben erteilte Freigabe); der Hintergrund zieht über die neue Meldung
  `ybshot-folder-note` nur noch den `lastShot`-Status nach.
- **Fehlgeschlagenes Nachschreiben war stumm.** Fehlender Zugriff oder ein
  Schreibfehler beim Nachschreiben werden im Popup jetzt sichtbar gemeldet,
  statt den wartenden Bestand unverändert zu lassen.

### Geändert
- **Popup erklärt die Chrome-Freigabe.** Solange der Ordnerzugriff bestätigt
  werden muss, steht unter dem Ordnerstatus ein Hinweis, im Chrome-Dialog
  „Bei jedem Besuch erlauben“ zu wählen — Chrome schützt den Ordnerzugriff und
  fragt nach einem Neustart sonst erneut. Die wartenden Bilder werden
  unmittelbar nach der Bestätigung geschrieben.

### Tests
- `test-background-route` prüft die Statusmeldung `ybshot-folder-note`
  (passende Kennung → `saved`, fremde Kennung → unverändert).
- `e2e-chrome-fsa` schreibt die Warteschlange zusätzlich aus dem
  Popup-Fensterkontext nach und prüft, dass Datei und `lastShot` ankommen.

## [1.5.19] — 2026-10-21

### Geändert
- **Der vollständige Grund steht jetzt im Dateinamen jedes Kontrollbilds.**
  Bisher enthielt der Name nur den kurzen Kanal (`_ai`, `_title`, `_semantic`);
  jetzt steht dort der ausgeschriebene Grund: `_ai-generated`, `_members-only`,
  `_promo`, `_test` sowie mit Suchbegriff `_title_<begriff>`,
  `_channel_<begriff>`, `_semantic-image_<begriff>`, `_ocr_<begriff>` und
  `_speech_<begriff>`. Unbekannte Gründe werden als `_other_<grund>` abgelegt.
  Kyrillische und deutsche Begriffe werden für den Dateinamen in ASCII
  umgeschrieben (`война` → `voyna`, `Müller` → `mueller`); Pfadtrenner und
  Sonderzeichen werden zu `_`. Der Name bleibt dadurch auf allen Systemen
  gültig, und die Kontrolle braucht kein zusätzliches Protokoll.

### Behoben
- **Chrome: „Failed to create WebGPU Context Provider“ im Fehlerprotokoll.**
  Ohne GPU-Adapter protokolliert Chrome jede WebGPU-Anfrage als Warnung — auch
  die bloße Geräteprobe der Semantik, und nach jedem Update erneut. Chrome nutzt
  die Semantik jetzt ohne WebGPU direkt in Wasm (`YB_FORCE_WASM` im
  Offscreen-Dokument); Firefox behält die Probe samt versionsgebundenem
  Fallback. Dadurch bleibt das Protokoll in Chrome frei von dieser Warnung.
- **Chrome: „Detected N diacritics“ und Leptonica-Boxmeldungen aus dem
  Fehlerprotokoll.** Der OCR-Host setzt `debug_file=/dev/null`; Tesseracts
  `tprintf`-Diagnosen landen damit nicht mehr in der Konsole. Gegen die
  upstreambekannten Meldungen „Error in boxClipToRectangle: box outside
  rectangle“ und „Error in pixScanForForeground: invalid box“ bekommt jedes
  OCR-Bild einen weißen Rand; komplett leere oder komplett gefüllte Masken
  werden vor Tesseract verworfen. Der Log-Filter (`quiet-warn.js`) deckt die
  beiden Leptonica-Texte und die exakte Diacritics-Zeile zusätzlich als
  letzte Absicherung ab.
- **OCR-Cache auf `ocr-v3` angehoben.** Alte Texte aus der Pipeline ohne Rand
  dürfen einen erneuten Lauf nicht verhindern.

### Tests
- `test-shots` prüft den vollständigen Grund im Dateinamen, kyrillische und
  deutsche Umschrift, Pfadtrenner im Suchbegriff und die Längenbegrenzung.
- `test-ocr-host-image` prüft `debug_file=/dev/null`, den weißen Rand im
  schnellen und tiefen Lauf sowie das Überspringen leerer Graustufenmasken.
- `test-quiet-warn` und `test-ocr-worker` decken die Leptonica-Meldungen und
  die exakte Diacritics-Zeile ab.
- `test-sem-gpu-fallback` prüft, dass Chrome ohne WebGPU-Anfrage startet und
  kein Fallback-Merkmal mehr schreibt; Firefox-Tests bleiben erhalten.
- `e2e-chrome-ocr` lädt die Erweiterung in echtem Chrome, lässt den
  Offscreen-Host ein PNG mit Diacritics und Text an Ober-/Unterkante erkennen
  und prüft, dass die Konsole von Offscreen-Dokument und OCR-Worker frei von
  Diacritics-, Leptonica- und WebGPU-Meldungen bleibt.

## [1.5.18] — 2026-10-21

### Behoben
- **Chrome zeigte für jedes Kontrollbild einen nativen „Speichern unter“-Dialog.**
  Chrome ignoriert `saveAs:false` bei `downloads.download`, wenn die globale
  Einstellung „Fragen, wo jede Datei gespeichert werden soll“ aktiv ist. Chrome
  schreibt Kontrollbilder jetzt über die File System Access API direkt in einen
  einmal gewählten Ordner. Ein Download-Fallback existiert dort nicht mehr.
- **Fehlende Ordnerfreigabe blockiert das Ausblenden nicht.** Ohne Ordner oder
  nach einem Browserneustart ohne bestätigte Freigabe wird das JPEG als Blob
  lokal in IndexedDB vorgemerkt; die Karte wird trotzdem ausgeblendet. Nach
  „Zugriff erneuern“ schreibt der Service Worker die Warteschlange nach.
- **Wartende Bilder aktualisieren den Popup-Status.** Aus `pending` wird nach
  dem Nachschreiben `saved`; der zuletzt angezeigte Dateiname entspricht der
  tatsächlich geschriebenen Datei.

### Hinzugefügt
- Chrome-only-Bereich „Screenshot-Ordner“ im Popup mit Ordnerwahl, Status,
  Freigabe-Erneuerung und Anzahl wartender Bilder.
- `folder-store.js` kapselt Verzeichnis-Handle, IndexedDB-Warteschlange,
  eindeutige Dateinamen und das Schreiben aus dem MV3-Service-Worker.
- Übersetzungen für Ordnerwahl, Warteschlange und Fehlerzustände in
  Deutsch, Englisch, Russisch und Ukrainisch.

### Tests
- `test-folder-store` prüft Warteschlange ohne Ordner, Nachschreiben,
  Freigabeverlust und Kollisionsnamen mit IndexedDB-/FSA-Attrappen.
- `test-background-route` prüft den Chrome-Ordnerweg ohne
  `downloads.download`, den `pending`-Status und das Nachschreiben.
- `e2e-chrome-fsa` startet ein isoliertes Chrome, legt einen OPFS-Handle in
  IndexedDB, lässt den Service Worker schreiben und prüft eine echte
  `captureVisibleTab`-Aufnahme im Ordner.
- Zusätzlich real geprüft: Chrome 155 mit automatischer YouTube-Aufnahme und
  Ausblenden im FSA-Ordner; Firefox 158 mit automatischer Aufnahme und
  Ausblenden über den Downloadweg — jeweils in isolierten Profilen.

## [1.5.17] — 2026-10-21

### Behoben
- **Automatische Kontrollbilder auf echten YouTube-Seiten.** Karten außerhalb
  des sichtbaren Bereichs wurden zwar über `rootMargin` erkannt, aber nach dem
  Warten auf volle Sichtbarkeit still ohne Bild ausgeblendet. Jetzt bleiben sie
  vorgemerkt und werden beim Erscheinen aufgenommen und erst dann ausgeblendet.
  Teilweise sichtbare Karten liefern den sichtbaren Ausschnitt; nach 120
  Sekunden ohne Sichtbarkeit wird mit Diagnose im Popup ausgeblendet. Die Seite
  wird weiterhin nicht automatisch gescrollt.
- **Scan wurde auf belebten YouTube-Seiten nicht ausgeführt.** Der
  MutationObserver setzte den 350-ms-Scan-Timer bei jeder Änderung zurück;
  YouTube mutiert große Teile der Seite oft häufiger, sodass der Timer nie
  feuerte. Der Scan ist jetzt gedrosselt statt entprellt.
- **Offizieller KI-Badge auf der Videoseite.** Der Badge wird in den
  Watch-Metadaten erkannt (`badge-shape`, u. a. `aria-label="AI: Content was
  made with AI"`). Die Wiedergabe wird blockiert und die Video-Kennung lokal
  gemerkt; Feed- und Suchkarten dieses Videos werden danach auch ohne Badge
  ausgeblendet. Es gibt keine Titel- oder sonstige Heuristik für KI-Inhalte.
- **KI-Kennung wird nur bei aktiver Einstellung angewendet.** Gemerkte
  Kennungen blenden Karten ausschließlich aus, solange „KI-Inhalte ausblenden“
  aktiv ist.

### Geändert
- Vorgemerkte Kontrollbilder werden seriell behandelt: vollständig sichtbar
  sofort, bei teilweiser Sichtbarkeit 15 Sekunden nach dem Vormerken als
  Ausschnitt, sonst nach 120 Sekunden ohne Bild mit `lastShot`-Diagnose.
- Popup-Hinweise erklären die Watch-Seiten-Erkennung und den sichtbaren
  Ausschnitt; der Status kennzeichnet teilweise Aufnahmen.

### Tests
- `test-ai` prüft Watch-/Live-Links, die Badge-Suche und die Sperrtexte in
  allen vier Oberflächensprachen.
- `test-shots` prüft `visiblePart` inklusive Masthead/Guide und
  `test-background-route` übernimmt `partial` in `lastShot`.
- Zusätzlich im isolierten Firefox-Profil geprüft: automatische Aufnahme einer
  sichtbaren YouTube-Sucherkarte, Vormerkung einer Offscreen-Karte bis zum
  Scrollen, KI-Sperrbildschirm auf `watch?v=wFAvZSefhnE` und Ausblenden der
  zugehörigen Feed-Karte über die gemerkte Kennung.

## [1.5.16] — 2026-10-21

### Hinzugefügt
- **Status des letzten Kontrollbilds im Popup.** Jeder Aufnahmeversuch
  hinterlässt `lastShot` mit Zeitpunkt, Datei, Grund, Video-Kennung,
  Sichtbarkeit, Privatfenster-Kennzeichen und Status (`saved`, `skipped`,
  `failed`). Das Popup zeigt die letzte Aufnahme samt Fehlertext und
  aktualisiert sich über `storage.onChanged` — auch wenn der Versuch nur
  wegen einer nicht vollständig sichtbaren Karte übersprungen wurde.
- **Knopf „Testaufnahme speichern“.** Er prüft Berechtigungen, Aufnahme und
  Download ohne auf eine passende Karte zu warten und speichert den sichtbaren
  Tab als JPEG (`..._test_test.jpg`). Fehler erscheinen direkt im Popup.
- **Erklärung der Diagnosezahl:** Die Zahl „verdächtig“ zählt nur lokal
  gespeicherte Werbe-Verdachtsfälle, keine ausgeblendeten Karten.

### Geändert
- **Einstellungen wirken ohne Neuladen.** Das Content-Skript hört auf
  `storage.onChanged` und übernimmt insbesondere `shotBeforeHide` sofort,
  setzt die Aufnahme-Markierungen zurück und scannt die Seite neu.
- **Downloaderfolg wird tatsächlich geprüft.** Nach `downloads.download`
  wartet der Hintergrund auf `downloads.onChanged`/`downloads.search` und
  meldet abgebrochene Downloads oder Zeitüberschreitungen im Popup. Der
  Content wartet weiterhin nur auf den Aufnahmestart, damit das Ausblenden
  nicht durch den Download blockiert wird.
- **Privatfenster:** Bei Firefox-Privatfenstern wird `incognito` an den
  Download übergeben; die Statusanzeige kennzeichnet den Kontext.

### Tests
- `test-shots` deckt den Dateinamen der manuellen Testaufnahme ab;
  `test-background-route` prüft manuelle und automatische Aufnahmen im
  Privatfenster samt `lastShot`; `test-i18n` prüft die neuen Status- und
  Testmeldungen in allen vier Oberflächensprachen.

## [1.5.15] — 2026-10-20

### Hinzugefügt
- **OCR-Modell wird beim Öffnen des Popups sichtbar vorgeladen.** Ist OCR
  aktiviert, initialisiert das Popup die in `OCR-Sprachen` gewählten
  Tesseract-Modelle sofort und zeigt darunter Status, Fortschrittsbalken und
  bei einem Fehler einen Knopf „Erneut laden“. Der Ladevorgang läuft im
  Hintergrund-/Offscreen-Host weiter, auch wenn das Popup gleich wieder
  schließt. Bei `eng+rus` werden beide Modelle in getrennten Workern
  vorbereitet; nach zehn Minuten Leerlauf werden sie gemeinsam beendet.
- Der Host meldet dafür `state`, `loading`, `langs`, `loadingLangs`, `stage`,
  `progress` und `error`. Die neuen Routen `prepare` und `status` sind auch im
  Chrome-Offscreen-Dokument verfügbar.

### Geändert
- **Klarstellung zum Paket:** Die OCR-Sprachdaten `lib/eng.traineddata.gz` und
  `lib/rus.traineddata.gz` bleiben im Firefox-/Chrome-Paket. Aus dem
  AMO-Paket werden weiterhin nur die großen SigLIP-Modelle (`models/`)
  ausgeschlossen.

### Tests
- `test-ocr-host-image` prüft den neuen Vorwärmpfad, den Bereit-Status mit
  beiden Sprachen und dass ein vorhandener `eng`-Worker beim Wechsel auf
  `rus` nicht mehr beendet wird.

## [1.5.14] — 2026-10-20

### Geändert
- **Mehrstufige OCR für stilisierte Vorschaubilder.** Der erste Lauf nutzt
  jetzt PSM 11 (`SPARSE_TEXT`) statt PSM 6 und lädt nur die wahrscheinlichere
  Sprache: Bei lateinischem Titel/Kanal `eng`, bei überwiegend kyrillischem
  `rus`; `eng+rus` wird nicht mehr als ein gemischtes Modell geladen. Kurzer
  oder unsicherer Erstantext löst einen zweiten Durchgang mit fünf Varianten
  aus: Graustufen/Otsu, lockere Rot-Maske, helle Maske, invertierte Graustufen
  und dunkle Maske, jeweils 2× skaliert. Die Texte werden dedupliziert
  zusammengeführt; dadurch werden getrennte Überschriften wie rotes „RIP“ und
  weißes „LLMs?“ in einem Ergebnis sichtbar.
- **Sprachhinweis aus dem Content-Script.** `content.js` sendet Titel und Kanal
  als Hinweis an `ocr.js`/`host-routes.js`; der Host wählt danach das
  Tesseract-Modell. Der Cache-Schlüssel enthält jetzt Pipeline-Version,
  Sprache und Hinweis, damit alte fehlerhafte Texte nicht wiederverwendet
  werden.

### Tests
- `test-ocr-host-image` prüft PSM 11, die Sprachwahl (eng/rus), den tiefen
  Lauf mit fünf Varianten und die lockere Rot-Maske an einem dunkelroten
  Testmuster.
- `test-ocr-client` prüft die Weitergabe des Sprachhinweises.
- Referenzkarte `kuO4NOqp7Tc` („The End of LLMs? (NCM)“) im isolierten
  Browser-Harness: Das OCR-Ergebnis enthält jetzt `RIP`; der Matcher findet
  das kurze Schlüsselwort ohne Titel-Workaround.

## [1.5.13] — 2026-10-20

### Hinzugefügt
- **Ausnahmen pro Schlüsselwort.** Jeder Eintrag kann eigene Freigaben tragen
  (im Popup unter dem Wort, in der Massenbearbeitung als
  `Wort => Ausnahme, Ausnahme`). Eine Ausnahme hebt nur dieses Wort auf;
  andere Wörter der Liste treffen weiterhin. Beispiel:
  `Робот => теннис, настольный теннис, пинг-понг, tennis, теніс`.
- **Globale Freigaben.** Das neue Feld „Global freigeben“ lässt eine Karte
  durch, wenn Titel oder Kanal eine der eingetragenen Phrasen enthält — auch
  dann, wenn weitere Wörter der Liste treffen. Beispiel: `No Tesla` lässt
  Anti-Tesla-Videos durch, während normale Tesla-Videos blockiert bleiben.
  Dieselbe Phrase kann alternativ nur beim Wort `Tesla` als Ausnahme
  eingetragen werden und gilt dann ausschließlich für dieses Wort.
- **Sanfte Morphologie.** Kurze Begriffe (unter 4 Zeichen) treffen nur ein
  ganzes Wort; längere auch Wortstämme (`теннис` → `теннисист`, `tennis` →
  `tennisplayer`). Phrasen werden als Wortfolge verglichen, das letzte Wort
  darf ein Stamm sein (`No Tesla` → `No Teslas`).
- **Semantik und weitere Kanäle.** Freigegebene Konzepte werden vor der
  Margin-Entscheidung aus den SigLIP-Scores entfernt, damit sie keinen echten
  Treffer verdrängen. OCR und Sprache prüfen die Ausnahmen im jeweiligen Text
  zusammen mit Titel und Kanal.

### Geändert
- `matcher.js` um `channelEntries`, `matchEntries`, `exceptionsOf`,
  `firstException`, `exceptionMatches` und `activeScores` erweitert;
  `channelKeywords` bleibt abwärtskompatibel.
- `content.js` prüft globale Freigaben nach Badges/Werbekarten und vor dem
  Titelabgleich; Titel-, OCR- und Sprachtreffer berücksichtigen die Ausnahmen
  ihres Wortes.
- Popup: Ausnahmefeld je Wort, globales Freigabefeld, Massenformat
  `Wort => Ausnahmen`; beim Massenübernehmen bleiben `enabled` und `route`
  bereits vorhandener Wörter erhalten.
- JSON-Export/Import bewahrt `exceptions` und `settings.allowAll`; ältere
  Dateien ohne diese Felder funktionieren weiter.

### Tests
- Neuer Unit-Test `test-exceptions`: Normalisierung, kurze/lange Begriffe,
  `No Tesla`, mehrere Treffer (erster nicht freigegebener Treffer),
  Routen/Kanäle und Entfernen freigegebener Konzepte vor der Margin-Entscheidung.

## [1.5.12] — 2026-10-20

### Hinzugefügt
- **Kontrollbilder vor dem Ausblenden (optional, Standard aus).** Die neue Checkbox **„Screenshot vor dem Ausblenden (nur Kartenbereich)“** unter „Kontrolle der Ausblendungen“ speichert vor jeder Ausblendung ein kleines JPEG — ausschließlich den Rahmen der Karte, nicht den Bildschirm. Ablage im Download-Verzeichnis des Browsers als `YouTube Blocker/JJJJ-MM-TT/HHMMSS_<videoId>_<Grund>.jpg` (ohne Video-Kennung `slot`); Gründe: `ai`, `members`, `promo`, `title`, `channel`, `semantic`, `ocr`, `speech`. JPEG-Qualität 30 — Firefox speichert 1 CSS-Pixel je Bildpunkt, Chrome höchstens 480 Pixel Breite; je nach Karte etwa 3–25 KB. Das Bild entsteht **vor** der Aktion, also auch vor dem Klick auf „Kein Interesse“ und bei Werbe-Containern.
- **Sichtbarkeit statt Scrollen.** Liegt eine Karte noch nicht vollständig im sichtbaren Bereich (oder ist der Tab im Hintergrund), wartet das Ausblenden bis zu 8 Sekunden auf ihre Sichtbarkeit; die Seite wird nicht gescrollt. Wird sie nicht sichtbar, blendet die Erweiterung ohne Bild aus und vermerkt das in der Konsole. Bereits ausgeblendete Karten erzeugen nach einem Re-Render weder ein zweites Bild noch einen zweiten Zähler.
- **Optionale Berechtigungen.** `downloads` und `<all_urls>` stehen in `optional_permissions` und werden erst beim Einschalten der Checkbox einmalig angefragt — die Installation selbst bleibt unverändert. Ohne Berechtigung bleibt die Funktion aus; das Popup zeigt einen Hinweis, wenn sie später entzogen wird. Firefox nimmt den Kartenrahmen direkt auf (`tabs.captureTab`, `scale: 1`); Chrome nimmt den sichtbaren Tab auf, schneidet ihn im Hintergrund zu und verkleinert ihn (`captureVisibleTab`, Warteschlange mit höchstens zwei Aufnahmen je Sekunde). Vor der Chrome-Aufnahme wird geprüft, dass der YouTube-Tab noch aktiv ist.

### Geändert
- `shots.js` bündelt die reinen Helfer (Dateiname, Sichtbarkeitsprüfung, Zuschnitt) für Content-Skript und Hintergrund; das Manifest lädt es vor `content.js` und im Hintergrund.
- `build-chrome.js` trennt optionale Berechtigungen für MV3: `downloads` bleibt in `optional_permissions`, `<all_urls>` wandert nach `optional_host_permissions`.
- Popup-Texte für die neue Funktion in Deutsch, Englisch, Russisch und Ukrainisch.

### Tests
- Neuer Unit-Test `test-shots`: Dateiname (Datum, Uhrzeit, Kennung, Grund, ASCII-Sicherheit), vollständige Sichtbarkeit inklusive Masthead, Zuschnitt des Chrome-Bildes und Ausgabegröße.
- `test-chrome-manifest` prüft zusätzlich die Trennung der optionalen Berechtigungen.
- In isolierten temporären Profilen geprüft (Firefox 158, Chromium 136): Speicherung mit Unterordner und Grund, Bildgröße 480×127 (Chrome) bzw. 1063×281/200×379 (Firefox), korrekter Ausschnitt nach Scrollen, verzögertes Ausblenden ohne Bild bei nichtsichtbaren Karten und Re-Render ohne Duplikat.

## [1.5.11] — 2026-10-19

### Hinzugefügt
- **Filter für YouTube-eigene Werbekarten („YouTube empfiehlt“).** YouTube schiebt in Feed und Suche bezahlte Karten ein, die wie normale Videos aussehen — mit Werbe-Badge in der Metazeile („YouTube рекомендует“, „YouTube empfiehlt“, „YouTube recommends“, „YouTube рекомендує“), Handlungsaufforderung („Попробовать за 0 грн“, „Try for free“) und teilweise Preis-/Gratis-Marker. Statt fester DOM-Selektoren zählen mehrere unabhängige Signale zusammen: Textmarker (Badge, CTA, „Sponsored“/„Gesponsert“, „Содержит платную рекламу“), Struktur (externe Ziele — auch über den YouTube-Redirect-Wrapper `/redirect?q=…` aufgelöst — und fehlende Dauer/Aufrufe/Datum) sowie bekannte Werbe-Container (`ytd-ad-slot-renderer`, `ytd-in-feed-ad-layout-renderer`, `ytd-promoted-sparkles-web-renderer` u. a.). Erst ab der Regelschwelle (3) wird ausgeblendet; ein Badge oder ein bekannter Werbe-Container erreicht sie allein, CTA plus Preis (1+1) bewusst nicht. Die neue Einstellung **„Werbekarten ‚YouTube empfiehlt‘ ausblenden“** unter „Was geprüft wird“ arbeitet wie der KI-Badge-Filter: lokal, unabhängig von der Wortliste, ohne „Kein Interesse“-Klick, mit eigenem Statusindikator; Standard **aktiv**. Spät gerenderte Marker werden nachgezogen, ein Re-Render blendet erneut aus, reine Werbeplätze ohne Video-Bezug verschwinden direkt.
- **Diagnose unbekannter Werbeformate (lokal, ohne Netzverkehr).** Karten mit schwachen Signalen unterhalb der Schwelle oder mit Verdachtswörtern („рекоменд“, „sponsor“, „werbung“, „anzeige“, „промо“, „0 грн“ …) landen als kompakter Fingerabdruck — Signal-IDs, kurze Textausschnitte, externe Hosts, Kürzel des Titels, Regelversion — in einem lokalen Klingelspeicher (höchstens 50 Einträge, Duplikate per Hash verworfen). Das Popup zeigt unter **„Diagnose der Werbeformate“** die Anzahl und kopiert den JSON-Bericht auf Klick; die Erweiterung versendet nichts von selbst. Damit wird ein neues Werbeformat mit einer Textprobe gemeldet und mit dem nächsten Release zur Regel.

### Geändert
- **Werbe-Regeln liegen als Daten in `extension/promo-rules.js`** (Muster als Strings, Gewichte, Schwelle, Container-Liste, Diagnose-Wörter): Ein neues Format ist ein Dateneintrag, keine Änderung der Erkennungslogik. Geladen werden die Regeln vor `content.js` (Firefox-Manifest und Chrome-Transform identisch); `YB.debug.state()` zeigt `hidePromoted` und `promoSuspects`, `YB.debug.audit()` zählt Werbetreffer (`promo`, `promoHidden`, `promoProcessedUnhidden`), `YB.debug.promoSuspects()` gibt den Diagnosebericht aus.

### Tests
- Neuer Unit-Test `test-promo`: Badge-Muster in vier Sprachen mit Gegenproben (u. a. „Nur für Mitglieder“, „Рекомендуем посмотреть“), CTA- und Preismuster, interne vs. externe Ziele inklusive `/redirect?q=…`-Auflösung, Punktschwelle (Badge allein reicht, CTA+Preis nicht, extern+CTA ja), Titel-Abzug (ein Titel „Попробовать за 0 грн“ zählt nie), Diagnose-Fingerabdruck und Klingelspeicher (Duplikate, Obergrenze, Reihenfolge).

## [1.5.10] — 2026-10-18

### Behoben
- **Nach einem manuellen Neuladen der Erweiterung (gleiche Version) blieben offene YouTube-Tabs taub, bis die Seite von Hand neu geladen wurde.** Bisher prüfte der Hintergrund verwaiste Content-Scripts strikt einmal je Version — ein manuelles Neuladen der ungepackten Erweiterung feuert in Chrome aber kein `onInstalled`, und die Tabs bekamen nie wieder Skripte: weder Wortliste noch OCR noch Semantik liefen dort noch. Jetzt fällt das Nachreichen gedrosselt auch zwischendurch an (höchstens alle 2 Minuten, Notbremse 30 Sekunden) und heilt verwaiste Tabs selbst; eine frische Extension-Sitzung (Chrome leert `storage.session` bei Reload/Update/Neustart) löst es sofort aus. Die Kosten bleiben minimal: eine `storage`-Lesung je Start, ein Ping-Lauf erst nach Ablauf der Drossel — gesunde Tabs werden nicht angefasst.
- **Die Meldungen „Image too small to scale!! …“ und „Line cannot be recognized!!“ sammelten sich im Fehlerbereich von chrome://extensions ein.** Der tesseract.js-Kern meldet damit zu kleine Ausschnitte bzw. Zeilen ohne erkennbaren Text — kein Fehler, nur kosmetischer Lärm bei schwachen Vorschaubildern, der wie ein Defekt aussah. Der neue Worker-Einstieg `ocr-worker.js` lädt den vorhandenen Log-Filter (`quiet-warn.js`) vor dem Tesseract-Worker; der Filter deckt jetzt auch diese beiden Präfixe ab. Alles andere bleibt im Protokoll sichtbar.

### Geändert
- **Firefox-Manifest: eigener Android-Mindeststand (`gecko_android.strict_min_version` 142.0).** Die AMO-Prüfung warnte, dass `data_collection_permissions` von Firefox für Android erst ab 142 unterstützt wird und der Desktop-Floor 140 damit für Android zu niedrig ansetzt. Desktop bleibt bei 140, Android ist jetzt ausdrücklich ab 142 deklariert — die Warnung verschwindet, ohne Desktop-Nutzer auszusperren.

### Tests
- Neuer Unit-Test `test-reinject-health`: Drossel und Notbremse greifen, frische Sitzung und Versionswechsel heilen sofort, gesunde Tabs bleiben unberührt, ladende/schlafende Tabs werden übersprungen, die Firefox-Form ohne `storage.session` verhält sich rein nach Intervall.
- Neuer Unit-Test `test-ocr-worker`: der Worker-Einstieg lädt den Log-Filter vor dem Tesseract-Skript; `test-quiet-warn` deckt die beiden tesseract.js-Meldungen ab; `test-ocr-host-image` prüft zusätzlich, dass der Host den Filter-Worker (`ocr-worker.js`) ansteuert.

## [1.5.9] — 2026-10-18

### Hinzugefügt
- **Filter für KI-gekennzeichnete Inhalte („KI“-Badge).** YouTube versieht Videos, bei denen der Uploader den KI-Einsatz angegeben hat, mit einem kurzen Hinweis-Badge. Es ist lokalisiert (en „AI“, de „KI“, ru „ИИ“, uk „ШІ“) und trägt die Langfassung im `aria-label` (verifiziert am 18.10.2026: „AI: Content was made with AI“, „KI-Hinweis: Inhalt wurde mit KI erstellt“, „ИИ: контент создан с помощью ИИ“, „ШІ: контент створено за допомогою штучного інтелекту“). Die neue Einstellung **„KI-Inhalte ausblenden („KI“-Badge)“** unter „Was geprüft wird“ blendet solche Karten lokal aus — wie „Members only“ ohne „Kein Interesse“-Signal, mit eigenem Zähler und Nachprüfung für Badges, die YouTube erst nach dem ersten Rendern nachliefert. Der kurze Token zählt nur als ganzes Feld (ein Titel wie „AI news“ nie), geprüft werden nur Badge-Knoten; die Einstellung arbeitet unabhängig von der Wortliste. Standard: **aktiv**.
- `YB.debug.state()` zeigt zusätzlich `hideAiGenerated`; `YB.debug.audit()` zählt KI-Treffer getrennt (`ai`, `aiHidden`, `aiProcessedUnhidden`).

### Tests
- Neue Matcher-Tests für das KI-Badge: vier lokalisierte Token, beide Langfassungen, Gegenproben („AI news“, „Sora AI“, „AI music mix“, „KI-News“, „MAI“, „Auto-dubbed“, „Members only“, leer/`null`).
- Neues Live-Szenario `t-ai-badge` (Chrome for Testing, separates Profil, 25 Prüfungen): Gespeicherte Einstellungen ohne den Schlüssel → Standard in Content und Popup aktiv, Beobachter läuft auch mit leerer Wortliste; KI-Karten werden ausgeblendet (Meta-Badge „AI“, Overlay-Variante „ШІ“, aria-Langtext), Kontrollkarten („Auto-dubbed“, Titel „AI news“, „Members only“ bei ausgeschaltetem Members-Filter) bleiben sichtbar; `audit.ai`/`aiHidden` stimmen, der sichtbare Zähler wächst; mit beiden Schaltern wird die Members-Karte nachgezogen ausgeblendet; Re-Render blendet erneut aus; bei abgeschaltetem Schalter bleibt eine neue KI-Karte sichtbar und das Popup zeigt den Schalter aus; keine Konsolenfehler. Bestehende Badge-/Titel-Szenarien (`t-synthetic`) laufen unverändert grün.

## [1.5.8] — 2026-10-18

### Behoben
- **Kosmetische „content-length“-Warnung aus dem Erweiterungsprotokoll entfernt.** transformers.js liest die Modell-Dateien als Antworten ohne Content-Length-Header und meldet das bei jedem Modellbezug per `console.warn` („Unable to determine content-length from response headers. Will expand buffer when needed.“); in chrome://extensions erschien das als Warnung der Erweiterung und wurde für einen Fehler gehalten. Der Semantik-Worker blendet jetzt genau diese eine Meldung aus (`quiet-warn.js`) — jede andere Warnung, auch von transformers.js selbst, bleibt sichtbar. Unverändert bleibt: Nach einem Erweiterungs-Update wird der WebGPU-Fehlschlag einmal neu geprüft (versionsgebundenes Merkmal), danach ist das Protokoll ruhig.

### Tests
- Neuer Unit-Test `test-quiet-warn`: nur die exakte content-length-Meldung wird verworfen, andere Warnungen passieren unverändert. Das Live-Szenario `t-sem-gpu-flag` prüft zusätzlich, dass im gesamten Ablauf keine content-length-Zeile mehr auftaucht (vorher im Baseline-Lauf als vorhanden belegt).

## [1.5.7] — 2026-10-18

### Behoben
- **Vorschaubild-OCR scheiterte an AVIF-Miniaturen und hinterließ Fehler im Erweiterungsprotokoll.** ytimg.com liefert hq720-Vorschaubilder inzwischen als AVIF — auch unter .jpg-URLs und unabhängig vom Accept-Header. Der Tesseract-Kern (Leptonica) kann AVIF nicht lesen; pro Bild entstanden dadurch „Error in pixReadStream: Unknown format“, „Image file /input cannot be read!“ und „Error attempting to read image“ in chrome://extensions, und die Karte blieb ohne OCR-Text. Der OCR-Host lädt die Bytes jetzt selbst (`fetch`), prüft, dass es sich um ein Bild handelt, und wandelt alles, was der Kern nicht direkt liest (AVIF & Co.), über den Browser in PNG um (`createImageBitmap` → Canvas). JPEG/PNG/WebP/BMP/TIFF gehen unverändert an den Kern. 404/HTML und nicht dekodierbare Bilder werden still übersprungen (Karte gilt als „ohne Text“), bewusst ohne Cache — ein späterer Rescan darf die URL erneut versuchen.
- **WebGPU-Fehlschlag füllte ohne GPU-Adapter das Fehlerprotokoll.** Ohne GPU-Adapter (etwa ohne Grafikbeschleunigung) protokolliert Chrome jede WebGPU-Anfrage als Warnung „Failed to create WebGPU Context Provider“ — auch die kurze Geräte-Probe der Semantik, und bei jedem Neustart wieder. Ein gescheiterter Versuch wird jetzt gemerkt (`semGpuFallback` in `storage.local`; im Chrome-Offscreen über den Service Worker, der dort als einziger Storage-Zugriff hat). Danach startet die Semantik direkt in Wasm, ohne erneute WebGPU-Anfrage. Der gemerkte Wert trägt die Erweiterungsversion (etwa `wasm@1.5.7`): Nach einem Update zählt das Merkmal als veraltet und WebGPU wird einmal neu probiert, sodass Umgebungsänderungen (etwa aktivierte Grafikbeschleunigung) berücksichtigt werden. Normale Browser-Neustarts behalten das Merkmal.

### Tests
- Neuer Unit-Test `test-ocr-host-image` (AVIF → PNG über Canvas, JPEG/WebP direkt, 404/HTML/kaputte Bilder als stiller Skip, kein Negativ-Cache) und `test-sem-gpu-fallback` (genau eine WebGPU-Probe, Merkmal in beiden Speicherwegen — Offscreen über den Service Worker, Firefox direkt —, keine erneute Probe im frischen Host). Live-Szenarien `t-ocr-urls` (echte AVIF-URLs aus einem Feed) und `t-sem-gpu-flag` (Merkmal überlebt den Browser-Neustart, keine neue Protokollzeile).

## [1.5.6] — 2026-10-18

### Behoben
- **Neue Wörter wirkten manchmal erst nach dem manuellen Neuladen (F5) der YouTube-Seite.** Ursache: Beim Extension-Update tauschen Chrome und Firefox Content-Scripts in bereits geöffneten Tabs nicht aus. Die alte Instanz verliert dabei ihren Extension-Kontext („verwaist“), Nachrichten des Popups laufen ins Leere — die neue Wortliste erreichte den Tab nie wieder. Jetzt injiziert der Hintergrund nach einem Update (einmal je Version, per `ybping` nur in wirklich veraltete Tabs) automatisch die aktuelle Skriptliste: Chrome über `scripting.executeScript` (neue Berechtigung), Firefox über `tabs.executeScript`. Eine neu gestartete Instanz meldet die Beobachter der alten sauber ab (`window.YB.__instance.dispose`), damit nichts doppelt läuft.
- Zusätzlich zeigt das Popup beim Öffnen und nach jedem Speichern einen Hinweis mit Knopf **„Tabs neu laden“**, wenn ein Tab auch danach keine aktuelle Version meldet (z. B. geschützte oder schlafende Tabs) — statt wie bisher still zu scheitern.

### Tests
- Neuer Unit-Test `test-stale-tabs` (Erkennungslogik: verwaist/Altversion/Schlaf-Tabs) und neues Live-Szenario `t-stale-tab` (Update bei offener YouTube-Seite → neue Wörter greifen ohne F5; gesunde Tabs werden nicht als veraltet gemeldet).

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
