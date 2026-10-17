/* i18n.js — Oberflächensprache für Popup und Import-Tab (DE/EN/RU/UK).
   browser.i18n folgt fest der Browsersprache und lässt sich zur Laufzeit nicht
   umschalten — daher ein eigenes Wörterbuch. Wird von popup.html und
   import.html VOR popup.js/import.js geladen.
   Markierungen im HTML: data-i18n (Text), data-i18n-title (Tooltip),
   data-i18n-placeholder (Platzhalter).
   Platzhalter in Texten: {name}, wird von t(key, {name: …}) ersetzt. */
'use strict';

(function () {
  const LANGS = ['de', 'en', 'ru', 'uk'];

  const DICTS = {
    de: {
      ui_lang_label: 'Sprache der Oberfläche:',
      enabled: 'Erweiterung aktiviert',
      kw_legend: 'Wortliste zum Blockieren',
      kw_input_ph: 'neues Wort oder Satz, Enter — hinzufügen',
      kw_add: 'Hinzufügen',
      kw_empty: 'Liste ist leer — Wörter unten hinzufügen 🌱',
      kw_bulk_summary: 'Massenbearbeitung',
      kw_bulk_ph: 'ein Wort/Satz pro Zeile',
      kw_bulk_apply: 'Aus Text übernehmen',
      kw_hint: 'Jeder Eintrag ist ein Begriff, den die Erweiterung im Titel und semantisch im Vorschaubild sucht. Zum Beispiel: „Fußball“, „Elektroautos“, „Trump“. OCR kann zusätzlich für Text im Vorschaubild aktiviert werden.',
      checks_legend: 'Was geprüft wird',
      check_title: 'Videotitel',
      check_semantic: 'Semantik: Liste → Bild (SigLIP)',
      check_ocr: 'OCR: Text im Vorschaubild',
      check_speech: 'Sprache im Video (Whisper, aufwendig)',
      check_members: '„Members only“ ausblenden (Mitglieder-Badge)',
      check_fuzzy: 'Unscharfer Vergleich (Tippfehler, Fälle)',
      action_legend: 'Aktion und Feinabstimmung',
      action_label: 'Aktion:',
      mode_dismiss: '„Kein Interesse“ (YouTube-Signal)',
      mode_hide: 'Nur ausblenden',
      ocr_langs_label: 'OCR-Sprachen:',
      hash_label: 'dHash/pHash-Schwelle:',
      hash_hint: '(kleiner = strenger, von 64)',
      margin_label: 'Margin-Schwelle (Semantik):',
      margin_hint: '(Kosinus-Abstand zum besten Konkurrenten; höher = strenger)',
      delay_label: 'Pause zwischen Signalen, ms:',
      speech_lang_label: 'Sprache der Spracherkennung:',
      speech_model_label: 'Whisper-Modell:',
      speech_secs_label: 'Sprache analysieren, Sek.:',
      export: 'JSON exportieren',
      import: 'JSON importieren',
      kw_count: 'gesamt: {n} · aktiv: {on}',
      counter_yt_local: 'YouTube: {dis} · lokal: {hid}',
      kw_use_title: 'Dieses Wort verwenden',
      route_title: 'Erkennungskanal (Auto = alle)',
      del_title: 'Löschen',
      route_auto: 'Auto',
      route_title_lbl: 'Titel',
      route_ocr: 'OCR',
      route_image: 'Bild',
      route_hybrid: 'Hybrid',
      save_saving: 'Speichern…',
      save_saved: 'Gespeichert, Tabs aktualisiert',
      save_error: 'Speichern fehlgeschlagen: {msg}',
      kw_dup: 'Dieses Wort ist bereits vorhanden',
      unknown: 'unbekannt',
      sem_error: 'Semantik-Modelle: Fehler — {msg}',
      sem_ready: 'Semantik-Modelle bereit ({device}) · lokal, kein Upload',
      sem_loading: 'Semantik-Modelle werden geladen … {p} % ({loaded}/{total} MB, einmalig)',
      sem_preparing: 'Semantik-Modelle werden vorbereitet …',
      sem_idle: 'Semantik-Modelle: werden beim ersten Vorschaubild vorbereitet (einmaliger Download möglich, danach offline)',
      stat_ok: 'Arbeitet',
      stat_ok_idle: 'Bereit — Modelle werden bei Bedarf in Sekunden geladen',
      stat_off: 'Ausgeschaltet',
      stat_pending: 'Noch nicht vorbereitet — startet automatisch bei Bedarf',
      stat_wait: 'Wird gerade vorbereitet …',
      stat_err: 'Fehler — siehe Statuszeile',
      stat_speech_missing: 'Whisper-Bibliothek nicht installiert — setup.sh ausführen',
      import_doc_title: 'Wortlisten-Import — Youtube Blocker',
      import_h1: 'Wortliste importieren',
      import_hint: 'Wähle eine JSON-Datei — die Liste ersetzt die aktuelle und wird sofort in allen YouTube-Tabs übernommen.',
      import_pick: 'JSON-Datei wählen…',
      import_tip1: 'Geeignet ist die Datei „JSON exportieren“ aus dieser Erweiterung.',
      import_tip2_a: 'Format',
      import_fmt_arr1: '{ "keywords": ["krieg", …] }',
      import_tip2_b: 'oder einfach ein Array',
      import_fmt_arr2: '["krieg", …]',
      import_tip3_a: 'Einträge dürfen Strings oder Objekte sein:',
      import_fmt_obj: '{ "text": "…", "enabled": true }',
      import_no_list: 'Die Datei enthält keine Wortliste (erwartet wird ein Array oder { "keywords": [...] })',
      import_empty_list: 'Die Liste ist leer — die Datei enthält keine nicht-leeren Wörter',
      import_ok: 'Importierte Wörter: {n}. Dieser Tab kann geschlossen werden.',
      import_error: 'Importfehler: {msg}'
    },
    en: {
      ui_lang_label: 'Interface language:',
      enabled: 'Extension enabled',
      kw_legend: 'Blocklist',
      kw_input_ph: 'new word or phrase, Enter — add',
      kw_add: 'Add',
      kw_empty: 'List is empty — add words below 🌱',
      kw_bulk_summary: 'Bulk edit',
      kw_bulk_ph: 'one word/phrase per line',
      kw_bulk_apply: 'Apply from text',
      kw_hint: 'Each entry is a term the extension looks for in the title and semantically in the thumbnail. For example: “football”, “electric cars”, “Trump”. OCR can additionally be enabled for text in the thumbnail.',
      checks_legend: 'What gets checked',
      check_title: 'Video title',
      check_semantic: 'Semantics: list → image (SigLIP)',
      check_ocr: 'OCR: text in the thumbnail',
      check_speech: 'Speech in the video (Whisper, heavy)',
      check_members: 'Hide “Members only” (member badge)',
      check_fuzzy: 'Fuzzy matching (typos, case)',
      action_legend: 'Action and fine-tuning',
      action_label: 'Action:',
      mode_dismiss: '“Not interested” (YouTube signal)',
      mode_hide: 'Hide only',
      ocr_langs_label: 'OCR languages:',
      hash_label: 'dHash/pHash threshold:',
      hash_hint: '(lower = stricter, out of 64)',
      margin_label: 'Margin threshold (semantics):',
      margin_hint: '(cosine distance to best competitor; higher = stricter)',
      delay_label: 'Delay between signals, ms:',
      speech_lang_label: 'Speech recognition language:',
      speech_model_label: 'Whisper model:',
      speech_secs_label: 'Analyze speech, sec:',
      export: 'Export JSON',
      import: 'Import JSON',
      kw_count: 'total: {n} · active: {on}',
      counter_yt_local: 'YouTube: {dis} · local: {hid}',
      kw_use_title: 'Use this word',
      route_title: 'Detection channel (Auto = all)',
      del_title: 'Delete',
      route_auto: 'Auto',
      route_title_lbl: 'Title',
      route_ocr: 'OCR',
      route_image: 'Image',
      route_hybrid: 'Hybrid',
      save_saving: 'Saving…',
      save_saved: 'Saved, tabs refreshed',
      save_error: 'Saving failed: {msg}',
      kw_dup: 'This word already exists',
      unknown: 'unknown',
      sem_error: 'Semantic models: error — {msg}',
      sem_ready: 'Semantic models ready ({device}) · local, no upload',
      sem_loading: 'Semantic models loading … {p} % ({loaded}/{total} MB, one-time)',
      sem_preparing: 'Semantic models being prepared …',
      sem_idle: 'Semantic models: prepared on the first thumbnail (one-time download possible, offline afterwards)',
      stat_ok: 'Working',
      stat_ok_idle: 'Ready — models load on demand within seconds',
      stat_off: 'Disabled',
      stat_pending: 'Not prepared yet — starts automatically when needed',
      stat_wait: 'Preparing …',
      stat_err: 'Error — see status line',
      stat_speech_missing: 'Whisper library not installed — run setup.sh',
      import_doc_title: 'Keyword import — Youtube Blocker',
      import_h1: 'Import keyword list',
      import_hint: 'Pick a JSON file — the list replaces the current one and is applied to all YouTube tabs immediately.',
      import_pick: 'Choose JSON file…',
      import_tip1: 'Use the file from “Export JSON” in this extension.',
      import_tip2_a: 'Format',
      import_fmt_arr1: '{ "keywords": ["war", …] }',
      import_tip2_b: 'or just an array',
      import_fmt_arr2: '["war", …]',
      import_tip3_a: 'Entries may be strings or objects:',
      import_fmt_obj: '{ "text": "…", "enabled": true }',
      import_no_list: 'The file contains no keyword list (expected an array or { "keywords": [...] })',
      import_empty_list: 'The list is empty — the file contains no non-empty words',
      import_ok: 'Imported words: {n}. This tab can be closed.',
      import_error: 'Import error: {msg}'
    },
    ru: {
      ui_lang_label: 'Язык интерфейса:',
      enabled: 'Расширение включено',
      kw_legend: 'Список для блокировки',
      kw_input_ph: 'новое слово или фраза, Enter — добавить',
      kw_add: 'Добавить',
      kw_empty: 'Список пуст — добавьте слова ниже 🌱',
      kw_bulk_summary: 'Массовое редактирование',
      kw_bulk_ph: 'одно слово/фраза на строку',
      kw_bulk_apply: 'Взять из текста',
      kw_hint: 'Каждая запись — термин, который расширение ищет в названии и семантически на превью. Например: «футбол», «электромобили», «Трамп». Дополнительно можно включить OCR для текста на превью.',
      checks_legend: 'Что проверять',
      check_title: 'Название видео',
      check_semantic: 'Семантика: список → картинка (SigLIP)',
      check_ocr: 'OCR: текст на превью',
      check_speech: 'Речь в видео (Whisper, ресурсоёмко)',
      check_members: 'Скрывать «Members only» (бейдж участника)',
      check_fuzzy: 'Нечёткое сравнение (опечатки, регистр)',
      action_legend: 'Действие и тонкая настройка',
      action_label: 'Действие:',
      mode_dismiss: '«Не интересует» (сигнал YouTube)',
      mode_hide: 'Только скрывать',
      ocr_langs_label: 'Языки OCR:',
      hash_label: 'Порог dHash/pHash:',
      hash_hint: '(меньше = строже, из 64)',
      margin_label: 'Порог margin (семантика):',
      margin_hint: '(косинусный отрыв от лучшего конкурента; выше = строже)',
      delay_label: 'Пауза между сигналами, мс:',
      speech_lang_label: 'Язык распознавания речи:',
      speech_model_label: 'Модель Whisper:',
      speech_secs_label: 'Анализировать речь, сек.:',
      export: 'Экспорт JSON',
      import: 'Импорт JSON',
      kw_count: 'всего: {n} · активно: {on}',
      counter_yt_local: 'YouTube: {dis} · локально: {hid}',
      kw_use_title: 'Использовать это слово',
      route_title: 'Канал распознавания (Авто = все)',
      del_title: 'Удалить',
      route_auto: 'Авто',
      route_title_lbl: 'Название',
      route_ocr: 'OCR',
      route_image: 'Картинка',
      route_hybrid: 'Гибрид',
      save_saving: 'Сохранение…',
      save_saved: 'Сохранено, вкладки обновлены',
      save_error: 'Не удалось сохранить: {msg}',
      kw_dup: 'Такое слово уже есть',
      unknown: 'неизвестно',
      sem_error: 'Семантические модели: ошибка — {msg}',
      sem_ready: 'Семантические модели готовы ({device}) · локально, без отправки данных',
      sem_loading: 'Семантические модели загружаются … {p} % ({loaded}/{total} МБ, однократно)',
      sem_preparing: 'Семантические модели подготавливаются …',
      sem_idle: 'Семантические модели: подготовятся при первом превью (возможна однократная загрузка, затем офлайн)',
      stat_ok: 'Работает',
      stat_ok_idle: 'Готово — при необходимости модели загрузятся за пару секунд',
      stat_off: 'Выключено',
      stat_pending: 'Ещё не подготавливалось — запустится автоматически при необходимости',
      stat_wait: 'Идёт подготовка…',
      stat_err: 'Ошибка — см. строку статуса',
      stat_speech_missing: 'Библиотека Whisper не установлена — запусти setup.sh',
      import_doc_title: 'Импорт списка — Youtube Blocker',
      import_h1: 'Импорт списка слов',
      import_hint: 'Выбери JSON-файл — список заменит текущий и сразу применится во всех вкладках YouTube.',
      import_pick: 'Выбрать JSON-файл…',
      import_tip1: 'Подходит файл «Экспорт JSON» из этого расширения.',
      import_tip2_a: 'Формат',
      import_fmt_arr1: '{ "keywords": ["война", …] }',
      import_tip2_b: 'или просто массив',
      import_fmt_arr2: '["война", …]',
      import_tip3_a: 'Записи могут быть строками или объектами:',
      import_fmt_obj: '{ "text": "…", "enabled": true }',
      import_no_list: 'В файле нет списка слов (ожидается массив или { "keywords": [...] })',
      import_empty_list: 'Список пуст — в файле нет непустых слов',
      import_ok: 'Импортировано слов: {n}. Эту вкладку можно закрыть.',
      import_error: 'Ошибка импорта: {msg}'
    },
    uk: {
      ui_lang_label: 'Мова інтерфейсу:',
      enabled: 'Розширення увімкнено',
      kw_legend: 'Список для блокування',
      kw_input_ph: 'нове слово або фраза, Enter — додати',
      kw_add: 'Додати',
      kw_empty: 'Список порожній — додайте слова нижче 🌱',
      kw_bulk_summary: 'Масове редагування',
      kw_bulk_ph: 'одне слово/фраза на рядок',
      kw_bulk_apply: 'Узяти з тексту',
      kw_hint: "Кожен запис — термін, який розширення шукає в назві та семантично на прев'ю. Наприклад: «футбол», «електромобілі», «Трамп». Додатково можна увімкнути OCR для тексту на прев'ю.",
      checks_legend: 'Що перевіряти',
      check_title: 'Назва відео',
      check_semantic: 'Семантика: список → зображення (SigLIP)',
      check_ocr: "OCR: текст на прев'ю",
      check_speech: 'Мовлення у відео (Whisper, ресурсомістко)',
      check_members: 'Ховати «Members only» (бейдж учасника)',
      check_fuzzy: 'Нечітке порівняння (одруки, регістр)',
      action_legend: 'Дія та тонке налаштування',
      action_label: 'Дія:',
      mode_dismiss: '«Не цікавить» (сигнал YouTube)',
      mode_hide: 'Лише приховувати',
      ocr_langs_label: 'Мови OCR:',
      hash_label: 'Поріг dHash/pHash:',
      hash_hint: '(менше = суворіше, із 64)',
      margin_label: 'Поріг margin (семантика):',
      margin_hint: '(косинусний відрив від найкращого конкурента; більше = суворіше)',
      delay_label: 'Пауза між сигналами, мс:',
      speech_lang_label: 'Мова розпізнавання мовлення:',
      speech_model_label: 'Модель Whisper:',
      speech_secs_label: 'Аналізувати мовлення, сек.:',
      export: 'Експорт JSON',
      import: 'Імпорт JSON',
      kw_count: 'усього: {n} · активних: {on}',
      counter_yt_local: 'YouTube: {dis} · локально: {hid}',
      kw_use_title: 'Використати це слово',
      route_title: 'Канал розпізнавання (Авто = усі)',
      del_title: 'Видалити',
      route_auto: 'Авто',
      route_title_lbl: 'Назва',
      route_ocr: 'OCR',
      route_image: 'Зображення',
      route_hybrid: 'Гібрид',
      save_saving: 'Збереження…',
      save_saved: 'Збережено, вкладки оновлено',
      save_error: 'Не вдалося зберегти: {msg}',
      kw_dup: 'Таке слово вже є',
      unknown: 'невідомо',
      sem_error: 'Семантичні моделі: помилка — {msg}',
      sem_ready: 'Семантичні моделі готові ({device}) · локально, без надсилання даних',
      sem_loading: 'Семантичні моделі завантажуються … {p} % ({loaded}/{total} МБ, одноразово)',
      sem_preparing: 'Семантичні моделі готуються …',
      sem_idle: "Семантичні моделі: підготуються при першому прев'ю (можливе одноразове завантаження, далі офлайн)",
      stat_ok: 'Працює',
      stat_ok_idle: 'Готово — за потреби моделі завантажаться за кілька секунд',
      stat_off: 'Вимкнено',
      stat_pending: 'Ще не підготовлено — запуститься автоматично за потреби',
      stat_wait: 'Триває підготовка…',
      stat_err: 'Помилка — див. рядок статусу',
      stat_speech_missing: 'Бібліотеку Whisper не встановлено — запусти setup.sh',
      import_doc_title: 'Імпорт списку — Youtube Blocker',
      import_h1: 'Імпорт списку слів',
      import_hint: 'Вибери JSON-файл — список замінить поточний і одразу застосується в усіх вкладках YouTube.',
      import_pick: 'Вибрати JSON-файл…',
      import_tip1: 'Підходить файл «Експорт JSON» із цього розширення.',
      import_tip2_a: 'Формат',
      import_fmt_arr1: '{ "keywords": ["війна", …] }',
      import_tip2_b: 'або просто масив',
      import_fmt_arr2: '["війна", …]',
      import_tip3_a: "Записи можуть бути рядками або об'єктами:",
      import_fmt_obj: '{ "text": "…", "enabled": true }',
      import_no_list: 'У файлі немає списку слів (очікується масив або { "keywords": [...] })',
      import_empty_list: 'Список порожній — у файлі немає непорожніх слів',
      import_ok: 'Імпортовано слів: {n}. Цю вкладку можна закрити.',
      import_error: 'Помилка імпорту: {msg}'
    }
  };

  let current = 'de';

  /* Sprachcode auf eine unterstützte Sprache abbilden: 'ru-RU'/'ru_RU' → 'ru', sonst '' */
  function normalize(lang) {
    const base = String(lang || '').toLowerCase().split(/[-_]/)[0];
    return LANGS.includes(base) ? base : '';
  }

  /* Browsersprache ermitteln (z. B. 'ru-RU'); nicht unterstützt → Deutsch */
  function detect(api) {
    let ui = '';
    try {
      ui = (api && api.i18n && api.i18n.getUILanguage && api.i18n.getUILanguage())
        || (typeof navigator !== 'undefined' ? navigator.language : '');
    } catch (_) { /* getUILanguage fehlt → Fallback unten */ }
    return normalize(ui) || 'de';
  }

  /* Text zu Schlüssel; {name}-Platzhalter werden ersetzt.
     Unbekannter Schlüssel → Deutsch → Schlüssel selbst (mit Warnung). */
  function t(key, vars) {
    let s = DICTS[current][key];
    if (s === undefined) {
      s = DICTS.de[key];
      if (s === undefined) {
        console.warn('[i18n] unbekannter Schlüssel:', key);
        s = key;
      }
    }
    if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  }

  /* Alle markierten Elemente übersetzen (siehe Kopfkommentar) */
  function apply(root) {
    root = root || document;
    document.documentElement.lang = current;
    root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  }

  /* Sprache setzen und sofort anwenden */
  function set(lang) {
    current = normalize(lang) || 'de';
    apply();
    return current;
  }

  globalThis.YB = globalThis.YB || {};
  globalThis.YB.i18n = {
    LANGS, DICTS, normalize, detect, t, apply, set,
    get current() { return current; }
  };
})();
