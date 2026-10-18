/* stale-tabs.js — erkennt YouTube-Tabs, in denen nach einem Extension-Update
   noch die alte (verwaiste) Content-Script-Instanz läuft. Reine Logik ohne
   Browser: Das Popup nutzt sie live, Node-Tests prüfen sie isoliert. */
(function () {
  'use strict';

  /* pings: [{ id, ok, version }] — ok=false: ybping kam nicht an (Instanz verwaist
     oder Skript noch gar nicht injiziert). Ein Tab gilt als veraltet, wenn er
     nicht antwortet ODER eine andere als die laufende Version meldet. */
  function staleTabIds(pings, currentVersion) {
    const cur = String(currentVersion || '');
    return (pings || [])
      .filter(p => p && (!p.ok || String(p.version || '') !== cur))
      .map(p => p.id);
  }

  /* Tabs der Reihe nach anpingen: send(tabId) → Promise<Antwort>.
     Schlafende (discarded) und noch ladende Tabs werden übersprungen — sie
     bekommen beim Öffnen bzw. nach document_idle ohnehin frische Skripte und
     würden hier nur fälschlich als veraltet erscheinen. */
  async function pingTabs(tabs, send, currentVersion) {
    const pings = [];
    for (const tab of tabs || []) {
      if (!tab || tab.discarded || tab.status === 'loading') continue;
      try {
        const res = await send(tab.id);
        pings.push({ id: tab.id, ok: true, version: res && res.version ? String(res.version) : '' });
      } catch (e) {
        pings.push({ id: tab.id, ok: false, version: '' });
      }
    }
    return { pings, stale: staleTabIds(pings, currentVersion) };
  }

  const api = { staleTabIds, pingTabs };
  if (typeof window !== 'undefined') { window.YB = window.YB || {}; window.YB.staleTabs = api; }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
