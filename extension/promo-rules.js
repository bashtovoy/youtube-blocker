/* promo-rules.js — Datenregeln für YouTube-eigene Werbekarten („YouTube empfiehlt“).
   Bewusst reine Daten (Strings, Zahlen, Listen): Ein neues Werbeformat ist eine
   Ergänzung hier, keine Änderung der Erkennungslogik in promo.js/content.js.
   Muster sind reguläre Ausdrücke als Strings (Flags: i) — geprüft in
   tests/test-promo.js. Kalibrierung: 19.10.2026, Startseite (ru), Karte mit
   „YouTube рекомендует … Попробовать за 0 грн“. */
(function () {
  'use strict';

  window.YB = window.YB || {};
  window.YB.promoRules = {
    version: 1,
    updated: '2026-10-19',

    /* Starke Textmarker in Badge-/Metazeile. Der Badge-Marker allein erreicht
       die Schwelle: „YouTube empfiehlt/recommends/рекомендует“ ist eindeutig.
       Wortgrenzen über Unicode-Klassen (\p{L}\p{N}) statt \b: JS-\b kennt nur
       ASCII und würde an jedem kyrillischen Wort scheitern. */
    badgePatterns: [
      '(?<![\\p{L}\\p{N}])youtube\\s+(recommends?|empfiehlt|рекомендует|рекомендує|推荐|推薦)',
      'recommended\\s+by\\s+youtube',
      'empfohlen\\s+von\\s+youtube',
      '(?<![\\p{L}\\p{N}])sponsored(?![\\p{L}\\p{N}])',
      '(?<![\\p{L}\\p{N}])gesponsert(?![\\p{L}\\p{N}])',
      '(?<![\\p{L}\\p{N}])paid\\s+promotion(?![\\p{L}\\p{N}])',
      '(?<![\\p{L}\\p{N}])содержит\\s+платную\\s+рекламу(?![\\p{L}\\p{N}])',
      '(?<![\\p{L}\\p{N}])enthält\\s+bezahlte\\s+werbung(?![\\p{L}\\p{N}])',
      '^\\s*(ad|anzeige|реклама)\\s*$'
    ],

    /* Handlungsaufforderungen — nur in Button-Knoten bzw. als Textmuster.
       Allein zu schwach (Gewicht 1), in Kombination aber eindeutig. */
    ctaPatterns: [
      '^(попробовать|попробуйте|попробуй|установить|установите|скачать|подробнее|узнать\\s+больше|начать|зарегистрироваться|оформить|купить|заказать)(\\s|$)',
      '^(try|get\\s+started|install|download|learn\\s+more|sign\\s+up|shop\\s+now|order\\s+now|subscribe)(\\s|$)',
      '^(ausprobieren|kostenlos\\s+testen|installieren|herunterladen|mehr\\s+erfahren|jetzt\\s+kaufen|abonnieren|anmelden)(\\s|$)',
      '^(спробувати|встановити|завантажити|дізнатися\\s+більше|зареєструватися|купити|замовити)(\\s|$)'
    ],

    /* Preis-/Gratis-Marker („0 грн“, „бесплатно“, „free“) — schwaches Signal.
       Kein Abschluss-„\b“: Nach „$“/„₴“ gäbe es keine Wortgrenze. Die
       Unicode-Grenze davor verhindert Treffer mitten in Zahlen („1000 грн“). */
    pricePatterns: [
      '(?<![\\p{L}\\p{N}])0([.,]\\d{1,2})?\\s*(грн|₴|руб|₽|р\\.?|€|eur|\\$|usd)',
      '(?<![\\p{L}\\p{N}])(free|kostenlos|gratis|бесплатно|безкоштовно)(?![\\p{L}\\p{N}])'
    ],

    /* Bekannte Werbe-Container: schneller Pfad, aber nicht die einzige Grundlage. */
    containers: [
      'ytd-ad-slot-renderer',
      'ytd-in-feed-ad-layout-renderer',
      'ytd-promoted-sparkles-web-renderer',
      'ytd-promoted-video-renderer',
      'ytd-display-ad-renderer',
      'ytd-banner-promo-renderer',
      'ytd-companion-slot-renderer'
    ],

    /* Knoten, in denen Badge-/Button-Texte erwartet werden (für Textextraktion
       und Fingerabdruck). Bewusst breit: YouTube benennt Wrapper häufig um. */
    badgeSelectors: [
      'badge-shape',
      'yt-badge-view-model',
      'ytd-badge-supported-renderer',
      '[class*="badge" i]',
      'yt-content-metadata-view-model',
      '#metadata-line'
    ],
    ctaSelectors: [
      'button',
      'yt-button-shape',
      'tp-yt-paper-button',
      'a[role="button"]',
      '[role="button"]'
    ],
    markerSelectors: [
      'badge-shape',
      'yt-badge-view-model',
      'ytd-badge-supported-renderer',
      'button',
      'yt-button-shape',
      'tp-yt-paper-button',
      '[role="button"]',
      'yt-content-metadata-view-model',
      '#metadata-line'
    ],

    /* Wörter, die auf ein NOCH UNBEKANNTES Werbeformat hindeuten. Sie lösen
       keine Ausblendung aus, sondern landen im lokalen Diagnosebericht. */
    suspectPatterns: [
      '(?<![\\p{L}\\p{N}])recommend',
      '(?<![\\p{L}\\p{N}])empfiehl',
      '(?<![\\p{L}\\p{N}])рекоменд',
      '(?<![\\p{L}\\p{N}])спонсор',
      '(?<![\\p{L}\\p{N}])sponsor',
      '(?<![\\p{L}\\p{N}])промо',
      '(?<![\\p{L}\\p{N}])promo',
      '(?<![\\p{L}\\p{N}])реклам',
      '(?<![\\p{L}\\p{N}])werbung',
      '(?<![\\p{L}\\p{N}])anzeige',
      '(?<![\\p{L}\\p{N}])advert',
      '0\\s*(грн|₴|руб|₽)'
    ],

    /* Gewichte und Schwelle. Badge bzw. bekannter Container erreichen die
       Schwelle allein; CTA+Preis (1+1) bewusst nicht. */
    weights: {
      badge: 3,
      container: 3,
      external: 2,
      cta: 1,
      price: 1,
      noMeta: 1
    },
    threshold: 3,
    suspectsMax: 50
  };
})();
