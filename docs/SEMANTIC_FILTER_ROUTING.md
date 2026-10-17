# Semantik-Filter-Routing — Implementierungsaufgabe

## Umfang

Die semantische Filterschicht für den realen Produktumfang von Youtube Blocker implementieren.

Das Produkt ist KEIN universeller Bildklassifikator. Der Nutzer gibt eine konkrete Blockliste unerwünschter Begriffe vor. Jedes Schlüsselwort muss den am besten geeigneten Erkennungskanal nutzen:

- Titel-/Kanaltext
- OCR des Vorschaubilds
- semantischer Bildabgleich des Vorschaubilds
- eine kontrollierte Kombination der oben genannten Kanäle

Themen, die aus einem Bild nicht sinnvoll erkennbar sind, dürfen NICHT durch das Bildmodell gezwungen werden.

Referenzliste des Nutzers für die Validierung:

- Дрон
- Робот
- Трамп
- Drone
- Robot
- Dron
- Putin
- Trump
- drontech
- cybercab
- elon musk
- leak
- news
- leaked
- Navy
- Brad Pit
- UAV

Der aktuelle Produktionsstand ist Commit `de571f6`.

## Bereits validierte Rechercheergebnisse

1. Das offizielle Hugging-Face-Modell `google/siglip-base-patch16-224` und das lokale ONNX-Modell stimmen bei identischen Eingaben eng überein.
2. Padding ist nicht die Ursache.
3. Der SigLIP-Sigmoid-Score mit dem aktuellen `logit_bias` ist als absoluter Schwellenwert für die Domäne der YouTube-Vorschaubilder nicht brauchbar.
4. Der rohe Kosinus ist nützlich, die kontrastive Margin ist im vorhandenen Experiment mit 431 Vorschaubildern deutlich besser.
5. Hartes Kategorie-Gating (z. B. zuerst ENGINEERED, dann Konzept) war kontraproduktiv.
6. Das aktuelle Produktions-`semantic.js` verwendet noch `bestTextMatch(scores, 0.15)`; das darf nicht die semantische Entscheidungsregel bleiben.
7. Die bestehende Content-Pipeline ist wertvoll und muss erhalten bleiben:
   Titel -> semantisches Vorschaubild/OCR -> optional Sprache -> Dismiss/Verstecken.
8. Die semantische Schicht soll nur Kandidaten prüfen und cachen — entsprechend der allgemeinen Architektur von Open-Source-Projekten wie xrai/rai:
   zuerst günstige deterministische Prüfungen, teure visuelle Inferenz nur für verbleibende Karten, Ergebnisse cachen, fail open.
9. KEINEN Code aus ytff kopieren. Das Repository enthält im geprüften Stand keine Lizenz. Nur als Architekturreferenz für Batching/Caching/Regressionsmethodik nutzen.
10. xrai/rai ist MIT-lizenziert; sein Kandidaten-Gate, die Golden-Set-Evaluierung und der Latenz-/Fail-Open-Ansatz sind gültige Architekturreferenzen. Keinen unrelated X-spezifischen Code kopieren.

## Erforderliche Implementierung

### 1. Routing-Metadaten für Schlüsselwörter hinzufügen

Die lokale Schlüsselwort-Repräsentation so erweitern, dass jedes Schlüsselwort optional eine Detektor-Route tragen kann:

- `title`
- `ocr`
- `image`
- `hybrid`

Abwärtskompatibilität ist Pflicht: Vorhandenes importiertes JSON, das nur `{text, enabled}` enthält, muss weiterhin funktionieren.

Die 17 Schlüsselwörter des Nutzers NICHT fest in die Produktion einprogrammieren.

Ist keine Route angegeben, bleibt das aktuelle abwärtskompatible Verhalten erhalten, bis die Routing-Migration abgeschlossen ist.

### 2. Titelabgleich zuerst beibehalten

Der Titel-/Kanalabgleich bleibt die günstigste und früheste Prüfung.

Das SigLIP-Bildmodell nicht ausführen, wenn die Karte bereits über die konfigurierte Titel-/Kanal-Route getroffen hat.

### 3. Semantisches Bild-Scoring als Ranking-/Kontrastiv-Mechanismus umsetzen

NICHT verwenden:

`sigmoid(logit) >= 0.15`

als semantische Entscheidung.

Genug Rohinformationen aus dem Semantik-Worker bereitstellen, um zu berechnen:

- roher Kosinus / normalisierte Text-Bild-Ähnlichkeit
- Score des Zielkonzepts
- Score konkurrierender Referenzkonzepte
- kontrastive Margin

Die kontrastive Entscheidung soll konzeptspezifisch sein:

`margin = target_score - best_reference_score`

Vor der Kalibrierung keinen einzigen globalen universellen Schwellenwert annehmen.

Die Implementierung muss das lokale SigLIP-Modell und den WASM-Pfad beibehalten.

### 4. Das Schlüsselwort-Set des Nutzers bleibt das semantische Ziel-Set

Das Modell muss die Konzepte bewerten, die der Nutzer tatsächlich eingegeben hat — keine feste Taxonomie.

Für bildfähige Konzepte darf der Worker Prompts intern normalisieren, aber UI/Konfiguration müssen den ursprünglichen Nutzertext bewahren.

### 5. Universelle visuelle Klassifikation vermeiden

NICHT einführen:

- ENGINEERED/PERSON/NATURE/OTHER als verpflichtendes Produktions-Gate
- eine feste Objektontologie
- generische Bildklassifikation ohne Bezug zur Blockliste des Nutzers

Die semantische Schicht beantwortet:

„Wie stark entspricht diese Karte visuell diesem unerwünschten Konzept des Nutzers relativ zu den konfigurierten konkurrierenden Begriffen?“

### 6. Routing-Leitfaden

Erste Routing-Hypothesen für Recherche/Validierung:

IMAGE / HYBRID:
- Дрон / Drone / Dron
- Робот / Robot
- cybercab

IMAGE optional, aber primär TITLE/OCR:
- Trump / Трамп
- Putin
- Elon Musk
- Brad Pit
- Navy
- UAV

TITLE/OCR primär, kein erforderlicher Bilddetektor:
- news
- leak
- leaked
- drontech

Dies sind Hypothesen, keine dauerhaft einprogrammierte Richtlinie. Die Implementierung muss die Routenwahl pro Schlüsselwort erlauben.

### 7. OCR ist ein separater Detektor

OCR unabhängig vom semantischen Bild-Scoring halten.

Ein auf Titel/OCR geroutetes Schlüsselwort darf kein SigLIP erfordern.

Bei `checkThumbOcr=false` muss OCR global deaktiviert bleiben — exakt wie heute.

### 8. Teure Inferenz nur für Kandidaten

Der xrai-Disziplin folgen:

- zuerst deterministischer Titel-/Kanalabgleich
- nur geeignete Karten gehen in die teure semantische Bildarbeit über
- Deduplizierung/In-Flight-Sperre
- Scores cachen nach Bild-URL + Version des Schlüsselwort-Sets
- fail open bei Modell-/Worker-/Laufzeitfehlern
- den Feed niemals blockieren, nur weil der Semantik-Worker nicht verfügbar ist

Keinen Remote-KI-Dienst hinzufügen.

### 9. Textvorbereitung bündeln

Die Embeddings der Nutzerkonzepte einmal pro Revision des Schlüsselwort-Sets vorbereiten/berechnen, nicht einmal pro Karte.

Identische Konzepte nicht für jedes Vorschaubild erneut tokenisieren.

### 10. Diagnostik

Optionaler Debug-Output unter dem bestehenden `logMatch`-/`[YB]`-Mechanismus.

Bei einem semantischen Treffer genug protokollieren, um die Entscheidung nachzuvollziehen:

- Schlüsselwort
- Ziel-Kosinus
- Referenz-/Bestkonkurrenz-Kosinus
- Margin
- Schwellenwert-/Profilkennung
- source = semantic-image

NICHT die Binärdaten der Vorschaubilder protokollieren.

### 11. Evaluierungs-Harness

Einen neuen Recherche-/Evaluierungsbereich unter `gui-test-assets/padexp/` anlegen.

Heruntergeladene Modell-Binärdateien oder urheberrechtlich geschützte Roh-Vorschaubilder nicht committen.

Skripte hinzufügen, die ein extern vorbereitetes CSV-Manifest einlesen und ausgeben:

- Präzision pro Schlüsselwort
- Recall
- F1
- Falsch-Positiv-Rate
- Verteilung des Ziel-Kosinus
- Verteilung der kontrastiven Margin
- Kalibrierung vs. Holdout
- Latenz p50/p95 für die semantische Bildstufe

Eine deterministische 70/30-Aufteilung in Kalibrierung/Holdout verwenden.

Das vorhandene Experiment mit 431 Vorschaubildern darf als historische Referenz dienen, seine Labels dürfen aber nicht stillschweigend als neue Produktionswahrheit übernommen werden.

### 12. Abnahmekriterien vor dem Merge

Eine Produktionsimplementierung ist nur akzeptabel, wenn:

1. Die bestehenden Titel-Filtertests grün bleiben.
2. Die bestehenden OCR-Tests grün bleiben.
3. Die bestehenden Semantik-Init-/Laufzeittests grün bleiben.
4. Kein Produktionscode Sigmoid 0.15 als semantische Abnahmeregel verwendet.
5. Eine Route pro Schlüsselwort ohne Codeänderungen konfigurierbar ist.
6. Ein semantischer Bildfehler niemals die Titel-/OCR-Filterung oder den normalen Feed-Betrieb verhindert.
7. Semantische Arbeit gecacht wird und für dieselbe Karte nicht unnötig erneut läuft.
8. Eine Holdout-Evaluierung zeigt, dass kontrastives Scoring im vorgesehenen Nutzerfilter-Datensatz nützlicher ist als die alte absolute Sigmoid-Entscheidung.
9. Der exakte Produktionsschwellenwert/-profil aus Kalibrierungsdaten dokumentiert wird statt allein aus der Theorie gewählt zu werden.
10. Der nutzerseitige Standard konservativ bleibt: Falsch-Positive sind aggressivem Überfiltern vorzuziehen.

## In dieser Aufgabe NICHT tun

- Keinen Chrome-only-Fork erstellen.
- Firefox MV2 nicht auf MV3 migrieren.
- SigLIP nicht durch ein größeres Modell ersetzen.
- Keine Remote-KI-/Cloud-Klassifikation hinzufügen.
- Keine Sprachanalyse hinzufügen.
- OCR nicht standardmäßig aktivieren.
- Keine universelle Bildtaxonomie hinzufügen.
- Die Schlüsselwortliste des Nutzers nicht automatisch ändern.
- Den alten dHash/pHash-Code nicht löschen, solange keine separate Aufräumaufgabe angelegt wird.
- Nicht allein aufgrund von Metriken des Kalibrierungssets mergen.

## Lieferergebnisse

1. Implementierung auf dem Branch `feature/semantic-filter-routing`.
2. Tests für Routing, kontrastives Scoring und Caching.
3. Evaluierungsskript(e) und ein Textbericht.
4. Klare Migrationshinweise für bestehende Einstellungen/importiertes JSON.
5. Keine Modell-Binärdateien und kein Roh-Bildkorpus mit Urheberrechtsbezug committen.

## Referenz-Implementierungsideen

Nur als Architekturreferenzen verwenden:

- `sidntrivedi/ytff`: Batching, Ergebnis-Caching, deterministische Evaluierungsdisziplin. Keinen Code kopieren, da die Lizenz im geprüften Repository nicht festgestellt wurde.
- `phuaky/xrai`: Kandidaten-only lokales Vision-Gate, Golden-Set-Regression, Latenz-Evaluierung, Fail-Open-Verhalten. Das Repository ist MIT-lizenziert.

Die Implementierung muss nativ zu Youtube Blocker bleiben und seine aktuelle Firefox-/Local-First-Architektur bewahren.

## Nachtrag 10/2026 — Padding-Befund, Kalibrierung und neue Defaults

Der Befund in Punkt 2 („Padding ist nicht die Ursache“) ist überholt. Der
Wechsel von `padding:'max_length'` auf `padding:true` (Commit 23a7618,
„schnellere WASM-Batches“) hat die Pooling-Position des Text-Turms verschoben
und den Bildabgleich dauerhaft in Rauschen verwandelt.

Reproduzierte Messungen (Kontroll-Vorschaubilder, q8, WASM, 10/2026):

- `padding:true` (kein Pad, alle Prompts gleich lang): „cat“ erreicht auf dem
  Katzenbild nur −0.066 (Platz 4, unter „car“ und „pizza“).
- `padding:'max_length'` (64 Tokens, EOS-Pad): „cat“ 0.051 (Platz 1) — SigLIP
  poolt die letzte Position und ist auf den EOS-Pad-Schwanz trainiert; die
  offizielle transformers.js-Pipeline nutzt für SigLIP dasselbe Padding.
- Groß-/Kleinschreibung normalisieren: Der Gemma-Tokenizer zerlegt „Drone“
  anders als „drone“ — auf demselben Drohnen-Vorschaubild: „drone“ 0.072 vs.
  „Drone“ −0.015, „uav“ 0.046 vs. „UAV“ −0.003. Darum werden Nutzertexte nur
  intern für die Prompts kleingeschrieben; UI und Konfiguration behalten den
  Originaltext.

Kalibrierung (9 Kontrollbilder, 17er-Nutzerliste, q8): echte Treffer
(Ziel-Kosinus) 0.038–0.089, Rauschen auf Kontrollbildern (Katze/Auto) ≤ 0.032;
kontrastive Margin bei kurzen, disjunkten Listen 0.03–0.08. Bei Synonymen in
der Liste (Drone/Dron/Дрон/UAV) kollabiert die Margin (~0.002), weil die
Schreibweisen füreinander Konkurrenten sind — Migration: pro Konzept möglichst
eine Schreibweise. Daraus abgeleitet und umgesetzt: Standard-Margin **0.03**
(Content, Popup, Import, Fallback) und WASM-Quantisierung **q8** statt q4
(größere Trefferabstände; WebGPU bleibt q4f16).
