/* ai.js — gemeinsame, DOM-freie Helfer für die KI-Kennzeichnung.
   YouTube zeigt den offiziellen Hinweis „AI/KI/ИИ/ШІ“ nicht zuverlässig auf
   Feed-Karten, sondern häufig erst in den Metadaten der Videoseite. Deshalb
   erkennt content.js den Badge dort und merkt sich die Video-Kennung lokal;
   Feed-Karten mit dieser Kennung werden anschließend ausgeblendet. */
(function () {
  'use strict';

  const root = (typeof self !== 'undefined') ? self : window;

  /* Bewusst nur die Videoseite: ytd-watch-metadata enthält den offiziellen
     Badge neben dem Titel. Nicht die Beschreibung und keine Empfehlungen. */
  const WATCH_BADGE_SELECTOR = [
    'ytd-watch-metadata badge-shape',
    'ytd-watch-metadata ytd-badge-supported-renderer',
    'ytd-video-primary-info-renderer badge-shape',
    'ytd-video-primary-info-renderer ytd-badge-supported-renderer'
  ].join(', ');

  const OVERLAY_TEXTS = {
    de: {
      title: 'KI-gekennzeichnetes Video blockiert',
      body: 'YouTube kennzeichnet dieses Video als mit KI erstellt. Die Wiedergabe wurde gestoppt und die Kennung lokal gespeichert; künftige Karten dieses Videos werden ausgeblendet.',
      back: 'Zurück'
    },
    en: {
      title: 'AI-labelled video blocked',
      body: 'YouTube labels this video as made with AI. Playback was stopped and the video ID was saved locally; future cards for this video will be hidden.',
      back: 'Back'
    },
    ru: {
      title: 'Видео с маркировкой ИИ заблокировано',
      body: 'YouTube помечает это видео как созданное с помощью ИИ. Воспроизведение остановлено, идентификатор сохранён локально; карточки этого видео в дальнейшем будут скрываться.',
      back: 'Назад'
    },
    uk: {
      title: 'Відео з маркуванням ШІ заблоковано',
      body: 'YouTube позначає це відео як створене за допомогою ШІ. Відтворення зупинено, ідентифікатор збережено локально; картки цього відео надалі приховуватимуться.',
      back: 'Назад'
    }
  };

  /* Watch- und Live-Seiten. Shorts und youtu.be werden bewusst nicht
     mitgenommen: dort gibt es keine ytd-watch-metadata-Metadaten. */
  function watchId(url) {
    let parsed;
    try {
      parsed = new URL(String(url || ''));
    } catch (e) {
      return '';
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== 'youtube.com' && !host.endsWith('.youtube.com')) return '';
    let id = '';
    if (parsed.pathname === '/watch') {
      id = parsed.searchParams.get('v') || '';
    } else {
      const live = parsed.pathname.match(/^\/live\/([A-Za-z0-9_-]{11})$/);
      if (live) id = live[1];
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
  }

  function badgeFields(node) {
    if (!node) return [];
    return [
      node.textContent,
      node.getAttribute && node.getAttribute('aria-label'),
      node.getAttribute && node.getAttribute('title')
    ].filter(Boolean);
  }

  /* isAi(text) kommt aus matcher.js; so bleibt die Spracherkennung an einer
     Stelle und ai.js ist ohne DOM testbar. */
  function findBadge(container, isAi) {
    if (!container || typeof container.querySelectorAll !== 'function' || typeof isAi !== 'function') return null;
    for (const badge of container.querySelectorAll(WATCH_BADGE_SELECTOR)) {
      for (const field of badgeFields(badge)) {
        if (isAi(field)) return badge;
      }
      for (const child of badge.querySelectorAll('[aria-label], [title]')) {
        for (const field of badgeFields(child)) {
          if (isAi(field)) return badge;
        }
      }
    }
    return null;
  }

  function overlayText(lang) {
    const key = String(lang || '').toLowerCase().split(/[-_]/)[0];
    return OVERLAY_TEXTS[key] || OVERLAY_TEXTS.en;
  }

  root.YB = root.YB || {};
  root.YB.ai = { watchId, badgeFields, findBadge, overlayText, WATCH_BADGE_SELECTOR };
})();
