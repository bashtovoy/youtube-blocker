# padexp — Offline-Evaluierung der semantischen Bildstufe

Werkzeuge zur Kalibrierung des semantischen Kanals (roher Kosinus + kontrastive
Margin, siehe `docs/SEMANTIC_FILTER_ROUTING.md`, Punkte 11–12). Nichts hier
wird vom Produkt geladen; **keine Modell-Binärdateien und keine
urheberrechtlich geschützten Vorschaubilder liegen im Repository**.

## Vorgehen

1. Statischen Server im Repository-Wurzelverzeichnis starten (nur lokal):
   `python3 -m http.server 8899`
2. Im Firefox öffnen: `http://localhost:8899/gui-test-assets/padexp/eval.html`
3. CSV-Manifest und Bilderordner wählen, Schwelle eintragen, „Auswerten“.

Die Seite nutzt exakt denselben Scoring-Pfad wie das Produkt
(`extension/semantic-worker.js`): Text-Embeddings einmalig je Wortliste, danach
nur der Bild-Turm. Entscheidungsgröße ist der rohe Kosinus und die kontrastive
Margin = Ziel-Kosinus − bester Kosinus der übrigen Konzepte.

## CSV-Manifest

```
image,keyword,label
bald_drohne_01.jpg,Drone,1
bald_drohne_01.jpg,Navy,0
strand_02.jpg,Drone,0
```

- `image` — Dateiname (muss im gewählten Ordner liegen, Namen eindeutig)
- `keyword` — Konzept aus der Blockliste (exakt, Groß-/Kleinschreibung zählt)
- `label` — `1` = Konzept auf dem Bild vorhanden, `0` = nicht
- Kommas im Konzept sind erlaubt (die letzte Spalte ist das Label)
- Eine Kopfzeile wird erkannt und übersprungen

## Ausgabe

- Precision/Recall/F1/FPR je Konzept auf **Kalibrierung (70 %)** und
  **Holdout (30 %)** — deterministischer Split über den FNV-1a-Hash des Dateinamens
- Verteilungen (min/p25/median/p75/p95/max/mean) für Ziel-Kosinus und Margin,
  getrennt Positiv/Negativ
- Schwellen-Sweep 0…0,5 (Makro Recall/FPR/F1 auf dem Kalibrierungsset)
- Latenz der Bildstufe (p50/p95)
- `report.json` (alle Werte inkl. Verteilungen und vollem Sweep) zum Download

## Regeln für die Produktionsschwelle

- Konservativ wählen: **Falsch-Positive wiegen schwerer** als verpasste Treffer
  (im Modus „Kein Interesse“ löst ein Treffer offizielle Signale aus).
- Schwelle aus der Kalibrierungstabelle ablesen, im Popup eintragen und den
  Wert im Projekt dokumentieren (Acceptance-Kriterium 9).
- Der Produkt-Default (`semanticMargin: 0.1`) ist bewusst streng und
  **unkalibriert** — er ist ein Startpunkt, keine kalibrierte Wahrheit.
- Kein Sigmoid-Schwellwert: Die Entscheidung basiert ausschließlich auf der
  kontrastiven Margin (Acceptance-Kriterium 4).

## Hinweise

- Der Split ist deterministisch: dieselben Dateinamen ergeben immer dieselbe
  70/30-Aufteilung — Kalibrierung und Holdout bleiben über Läufe vergleichbar.
- Gemischte Sprachen in den Konzepten sind erlaubt (wie im Produkt).
- Läuft nur mit Browser-Unterstützung für verschachtelte Module-Worker
  (identisch zur Produktionsumgebung: Firefox 114+).
