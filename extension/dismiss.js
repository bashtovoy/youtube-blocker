/* dismiss.js — штатное действие YouTube «Не интересно» без опасного fallback-клика */
(function () {
  'use strict';

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function fullClick(el) {
    if (!el) throw new Error('click target missing');
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      const ev = type.startsWith('pointer')
        ? new PointerEvent(type, { bubbles: true, cancelable: true, composed: true })
        : new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window });
      el.dispatchEvent(ev);
    });
  }

  function visible(el) { return !!el && el.offsetParent !== null; }

  function findMenuButton(item) {
    return item.querySelector('ytd-menu-renderer yt-icon-button.dropdown-icon-button') ||
      item.querySelector('c3-pill-button button-icon') ||
      item.querySelector('yt-icon-button#button') ||
      item.querySelector('yt-icon-button');
  }

  const NI_RE = /not\s+interested|не\s*интерес|nicht\s*interess|nicht\s*interessiert|no\s*me\s*interesa|no\s*me\s*interessa|pas\s*int[eé]ress|不感兴趣|感興趣/i;

  function entryText(entry) {
    if (!entry) return '';
    return [
      entry.getAttribute && entry.getAttribute('aria-label'),
      entry.textContent
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function hasDislikeIcon(entry) {
    if (!entry || !entry.querySelectorAll) return false;
    for (const icon of entry.querySelectorAll('yt-icon, iron-icon')) {
      const use = icon.querySelector && icon.querySelector('use');
      const src = icon.getAttribute && (icon.getAttribute('src') || '');
      const id = use ? (use.getAttribute('xlink:href') || use.getAttribute('href') || '') : '';
      if (src.includes('thumbs-down') || src.includes('DISLIKE') || id.includes('thumbs-down') || id.includes('DISLIKE')) return true;
    }
    return false;
  }

  function findNotInterestedEntry(scope) {
    const all = scope.querySelectorAll ? scope.querySelectorAll(
      'ytd-menu-service-item-renderer, tp-yt-paper-item, paper-item, [role="menuitem"], [role="option"]'
    ) : [];
    for (const el of all) {
      if (!visible(el)) continue;
      const text = entryText(el);
      if (NI_RE.test(text) || hasDislikeIcon(el)) return el;
    }
    return null;
  }

  async function openMenu(item) {
    const btn = findMenuButton(item);
    if (!btn) throw new Error('menu button not found');
    const target = btn.shadowRoot ? (btn.shadowRoot.querySelector('button') || btn) : btn.querySelector?.('button') || btn;
    fullClick(target);
    for (let i = 0; i < 30; i++) {
      await sleep(50);
      const entry = findNotInterestedEntry(document);
      if (entry) return entry;
      const menus = document.querySelectorAll('ytd-popup-container tp-yt-paper-listbox, tp-yt-paper-listbox, [role="menu"]');
      for (const menu of menus) if (visible(menu)) return menu;
    }
    throw new Error('menu did not open');
  }

  function snapshotUndo() {
    return new Set(Array.from(document.querySelectorAll(
      '#snackbar-container button, #notification-container button, tp-yt-paper-toast button, ytd-popup-container button'
    )).filter(visible).map(b => b));
  }

  async function clickDismissConfirm() {
    await sleep(250);
    const dialog = Array.from(document.querySelectorAll('tp-yt-paper-dialog, [role="dialog"]')).find(visible);
    if (!dialog) return false;
    const buttons = Array.from(dialog.querySelectorAll('tp-yt-paper-button, button, yt-button-shape button')).filter(visible);
    const rejectUndo = t => /undo|отмен|cancel|назад|back|close|закрыт/i.test(t);
    const confirm = buttons.find(b => {
      const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim();
      if (rejectUndo(label)) return false;
      return b.id === 'confirm-button' || b.id === 'submit-button' || /submit|send|отправ|подтверд|confirm|done|save|сохран/i.test(label);
    });
    if (!confirm) return false;
    fullClick(confirm);
    return true;
  }

  async function notInterested(item) {
    const undoBefore = snapshotUndo();
    const entry = await openMenu(item);
    if (!entry || !entry.querySelector) throw new Error('no menu entry');

    let target = entry;
    if (!target.matches('ytd-menu-service-item-renderer, tp-yt-paper-item, paper-item, [role="menuitem"], [role="option"]')) {
      target = findNotInterestedEntry(entry);
    }
    /* Критически важно: не нажимаем первый пункт меню, если нужный пункт не найден. */
    if (!target) throw new Error('not-interested entry not found');

    const clickable = target.shadowRoot
      ? (target.shadowRoot.querySelector('a, #button, paper-button') || target)
      : (target.querySelector('a, #button, tp-yt-paper-button, paper-button, button') || target);
    fullClick(clickable);
    await clickDismissConfirm();
    return { undoBefore };
  }

  function hideItem(item) {
    const STYLE_ID = 'yb-hide-style';
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = '.yb-hidden{display:none!important;}';
      (document.head || document.documentElement).appendChild(style);
    }
    const target = item.closest(
      'ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-item-renderer'
    ) || item;
    target.classList.add('yb-hidden');
  }

  async function waitForOutcome(item, undoBefore) {
    for (let i = 0; i < 24; i++) {
      await sleep(150);
      const gone = !document.contains(item) || item.offsetParent === null || item.classList.contains('yb-hidden');
      if (gone) return { ok: true, via: 'item' };
      const undoNow = Array.from(document.querySelectorAll(
        '#snackbar-container button, #notification-container button, tp-yt-paper-toast button, ytd-popup-container button'
      )).filter(visible);
      const newUndo = undoNow.some(b => !undoBefore.has(b) && /undo|отмен/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')));
      if (newUndo) return { ok: true, via: 'undo' };
      const notice = Array.from(document.querySelectorAll('#snackbar-container, #notification-container, tp-yt-paper-toast'))
        .filter(visible)
        .some(el => /not\s+interested|не\s*интерес|nicht\s*interess/i.test(el.textContent || ''));
      if (notice) return { ok: true, via: 'snackbar' };
    }
    return { ok: false, via: null };
  }

  window.YB = window.YB || {};
  window.YB.dismiss = { notInterested, hideItem, fullClick, sleep, waitForOutcome };
})();
