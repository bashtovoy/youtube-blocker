/* quiet-warn.js — blendet rein kosmetische Warnungen der Bibliotheken aus:

   1) transformers.js: „Unable to determine content-length from response headers.
      Will expand buffer when needed.“ Die Bibliothek liest Modell-Dateien als
      Antworten ohne Content-Length-Header und meldet das bei jedem Dateibezug
      direkt über console.warn (siehe lib/transformers.min.js, Umfeld readResponse).
      Auf die Funktion hat es keinen Einfluss (die Bibliothek erweitert ihren
      Puffer selbst).

   2) tesseract.js-Kern: „Image too small to scale!! …“ und „Line cannot be
      recognized!!“. Der Kern (lib/tesseract-core-simd.wasm.js) meldet damit
      Ausschnitte, die zu klein zum Skalieren sind, oder Zeilen ohne erkennbaren
      Text — kein Fehler, nur Lärm bei kleinen oder schwachen Vorschaubildern.

   In chrome://extensions erschienen solche Meldungen als Warnungen der Erweiterung
   und wurden für Fehler gehalten. Unterdrückt wird NUR das jeweilige Präfix: Jede
   andere Warnung — auch dieser Bibliotheken — bleibt im Protokoll sichtbar.

   Eingebunden wird die Datei am Anfang von semantic-worker.js (ES-Import; Bild-
   und temporärer Text-Worker laden dieselbe Datei) und von ocr-worker.js vor dem
   Tesseract-Worker (importScripts). Der Tesseract-Kern bindet console.warn erst
   beim eigenen Laden — die Reihenfolge in ocr-worker.js ist deshalb entscheidend. */

if (!globalThis.__ybQuietWarn) {
  globalThis.__ybQuietWarn = true;

  const PREFIXES = [
    'Unable to determine content-length from response headers.',
    'Image too small to scale',
    'Line cannot be recognized'
  ];
  const rawWarn = console.warn.bind(console);
  console.warn = function (...args) {
    if (typeof args[0] === 'string' && PREFIXES.some(p => args[0].startsWith(p))) return;
    rawWarn(...args);
  };
}
