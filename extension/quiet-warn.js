/* quiet-warn.js — blendet rein kosmetische Meldungen der Bibliotheken aus:

   transformers.js: „Unable to determine content-length from response headers.
   Will expand buffer when needed.“ Die Bibliothek liest Modell-Dateien als
   Antworten ohne Content-Length-Header und meldet das bei jedem Dateibezug
   direkt über console.warn (siehe lib/transformers.min.js, Umfeld readResponse).
   Auf die Funktion hat es keinen Einfluss (die Bibliothek erweitert ihren
   Puffer selbst).

   In chrome://extensions erschienen solche Meldungen als Warnungen der Erweiterung
   und wurden für Fehler gehalten. Unterdrückt wird NUR das jeweilige Präfix bzw.
   das exakte Muster: Jede andere Warnung — auch dieser Bibliothek — bleibt im
   Protokoll sichtbar.

   Eingebunden wird die Datei am Anfang von semantic-worker.js (ES-Import). Die
   OCR läuft seit PaddleOCR nicht mehr in einem Worker, der Leptonica-/
   Tesseract-Meldungen erzeugen könnte. */

if (!globalThis.__ybQuietWarn) {
  globalThis.__ybQuietWarn = true;

  const PREFIXES = [
    'Unable to determine content-length from response headers.'
  ];
  const LINE_PATTERNS = [];
  function quiet(args) {
    if (typeof args[0] !== 'string') return false;
    if (PREFIXES.some(p => args[0].startsWith(p))) return true;
    return args.length === 1 && LINE_PATTERNS.some(re => re.test(args[0].trim()));
  }
  const rawWarn = console.warn.bind(console);
  console.warn = function (...args) {
    if (quiet(args)) return;
    rawWarn(...args);
  };
  const rawLog = console.log.bind(console);
  console.log = function (...args) {
    if (quiet(args)) return;
    rawLog(...args);
  };
}
