/* dismiss.js — отправка YouTube сигнала «Не интересно» через штатное меню элемента */
(function () {
  'use strict';

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function q(root, sel) { return root.querySelector(sel); }

  function fullClick(el) {
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
      const ev = type.startsWith('pointer')
        ? new PointerEvent(type, { bubbles: true, cancelable: true, composed: true })
        : new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window });
      el.dispatchEvent(ev);
    });
  }

  function findMenuButton(item) {
    return q(item, 'ytd-menu-renderer yt-icon-button.dropdown-icon-button') ||
      q(item, 'c3-pill-button button-icon') ||
      q(item, 'ytd-thumbnail-overlay-toggle-button-renderer') ||
      q(item, 'yt-icon-button#button') ||
      item.querySelector('yt-icon-button');
  }

  /* Иконка thumbs-down («Это не интересует») внутри открытого меню */
  function findNotInterestedEntry(scope) {
    const icons = scope.querySelectorAll('yt-icon, iron-icon');
    for (const icon of icons) {
      const use = icon.querySelector && icon.querySelector('use');
      const src = icon.getAttribute && (icon.getAttribute('src') || '');
      const id = use ? (use.getAttribute('xlink:href') || use.getAttribute('href') || '') : '';
      if (src.includes('thumbs-down') || src.includes('DISLIKE') ||
          id.includes('thumbs-down') || id.includes('DISLIKE')) {
        return icon.closest('ytd-menu-service-item-renderer, paper-item, tp-yt-paper-item');
      }
    }
    return null;
  }

  async function openMenu(item) {
    const btn = findMenuButton(item);
    if (!btn) throw new Error('menu button not found');
    /* для polymer-кнопок достаточно click(), но делаем полный набор событий */
    const target = btn.shadowRoot ? (btn.querySelector('button') || btn) : btn;
    fullClick(target);
    /* ждём появления overlay-меню */
    for (let i = 0; i < 25; i++) {
      await sleep(40);
      const entry = findNotInterestedEntry(document);
      if (entry) return entry;
      const anyMenu = document.querySelector('ytd-watch-next-secondary-results-renderer tp-yt-paper-listbox, ytd-item-section-renderer tp-yt-paper-listbox, tp-yt-paper-listbox');
      if (anyMenu && anyMenu.offsetParent !== null) return anyMenu;
    }
    throw new Error('menu did not open');
  }

  async function clickDismissConfirm() {
    /* Иногда YouTube показывает модальное окно причин. ВАЖНО:
       никогда не кликаем снэкбар «Отменить / Undo» — это откатило бы
       только что отправленный сигнал «Не интересно». Кликаем подтверждение
       ТОЛЬКО внутри реально открытого диалога (tp-yt-paper-dialog). */
    await sleep(250);
    const dialog = Array.from(document.querySelectorAll('tp-yt-paper-dialog'))
      .find(d => d.offsetParent !== null);
    if (!dialog) return false;
    const isUndo = t => /undo|отмен|cancel|назад|\bback\b|close|закрыть/i.test(t);
    const btns = Array.from(dialog.querySelectorAll(
      'tp-yt-paper-button, button, yt-button-shape button'));
    const confirm = btns.find(b => {
      if (b.offsetParent === null) return false;
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '');
      if (isUndo(label)) return false;
      return b.id === 'confirm-button' || b.id === 'submit-button' ||
        /submit|send|отправ|подтверд|\bconfirm\b|\bdone\b|save|сохран/i.test(label);
    });
    if (confirm) { fullClick(confirm); return true; }
    return false;
  }

  /**
   * Отправить «Не интересно» для элемента выдачи.
   * @param {HTMLElement} item ytd-video-renderer / ytd-rich-item-renderer и т.п.
   */
  async function notInterested(item) {
    const entry = await openMenu(item);
    let target = entry;
    if (!entry || !entry.querySelector) {
      throw new Error('no menu entry');
    }
    if (!entry.classList.contains('ytd-menu-service-item-renderer') &&
        !entry.classList.contains('paper-item')) {
      /* получили весь список — ищем нужный пункт внутри */
      target = findNotInterestedEntry(entry) ||
        entry.querySelector('ytd-menu-service-item-renderer, paper-item');
    }
    if (!target) throw new Error('not-interested entry not found');
    const clickable = target.shadowRoot
      ? (target.shadowRoot.querySelector('a, #button, paper-button, .ytd-menu-service-item-renderer') || target)
      : (target.querySelector('a, #button, tp-yt-paper-button, paper-button') || target);
    fullClick(clickable);
    await clickDismissConfirm();
    return true;
  }

  /* Простое CSS-скрытие как alternate-режим */
  const STYLE_ID = 'yb-hide-style';
  function hideItem(item) {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = '.yb-hidden{display:none !important;}';
      (document.head || document.documentElement).appendChild(style);
    }
    const target = item.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-playlist-panel-video-renderer') || item;
    target.classList.add('yb-hidden');
  }

  /**
   * Подтверждение, что dismiss прошёл: YouTube показывает снэкбар с кнопкой
   * «Отменить» (undo) и/или убирает элемент из выдачи.
   */
  async function waitForUndo(item) {
    const container = document.getElementById('snackbar-container') ||
      item.closest('ytd-secondary-search-container-renderer') || document;
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      const gone = !document.contains(item) || item.offsetParent === null || item.classList.contains('yb-hidden');
      const undo = Array.from(container.querySelectorAll('button, tp-yt-paper-button, a'))
        .some(b => /undo|отмен/i.test(b.getAttribute('aria-label') || b.textContent || ''));
      if (undo || gone) return true;
    }
    return false;
  }

  window.YB = window.YB || {};
  window.YB.dismiss = { notInterested, hideItem, fullClick, sleep, waitForUndo };
})();
