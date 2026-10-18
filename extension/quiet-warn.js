/* quiet-warn.js — blendet eine einzelne, rein kosmetische Warnung von
   transformers.js aus: „Unable to determine content-length from response
   headers. Will expand buffer when needed.“

   Die Bibliothek liest Modell-Dateien als Antworten ohne Content-Length-Header
   und meldet das bei jedem Dateibezug direkt über console.warn (siehe
   lib/transformers.min.js, Umfeld readResponse). In chrome://extensions erschien
   das als Warnung der Erweiterung und wurde für einen Fehler gehalten; auf die
   Funktion hat es keinen Einfluss (die Bibliothek erweitert ihren Puffer
   selbst).

   Unterdrückt wird NUR diese exakte Meldung (Präfix-Vergleich): Jede andere
   Warnung — auch von transformers.js — bleibt im Protokoll sichtbar. Die Datei
   wird am Anfang von semantic-worker.js eingebunden und deckt damit beide
   Betriebsarten ab (Bild- und temporärer Text-Worker laden dieselbe Datei).
   Der Bibliotheksaufruf erfolgt zur Laufzeit beim Modellbezug, nicht beim
   Import der Bibliothek — die Einbindungsreihenfolge ist deshalb unkritisch. */

if (!globalThis.__ybQuietContentLengthWarn) {
  globalThis.__ybQuietContentLengthWarn = true;

  const PREFIX = 'Unable to determine content-length from response headers.';
  const rawWarn = console.warn.bind(console);
  console.warn = function (...args) {
    if (typeof args[0] === 'string' && args[0].startsWith(PREFIX)) return;
    rawWarn(...args);
  };
}
