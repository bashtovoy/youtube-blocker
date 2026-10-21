# Nativer Test: dauerhafter Ordnerzugriff in Chrome

Chrome zeigt den Datei-Dialog (`showDirectoryPicker`) und die
Berechtigungsdialoge der File System Access API außerhalb des DOM.
CDP, Playwright und Cypress können sie nicht bedienen; einen Schalter
`--use-fake-ui-for-file-system-access` gibt es nicht. Der Test wird deshalb
von Hand begleitet. Er belegt das Verhalten, auf dem die Seite
`folder-access.html` aufbaut.

## Aufbau

- **Niemals das echte Profil verwenden.** Ein temporäres Profil anlegen
  (z. B. unter `/tmp` oder im OpenCode-Temp-Verzeichnis).
- Die entpackte Erweiterung aus `dist-chrome/` laden, nicht `extension/`
  (Firefox-Manifest).
- Chrome mit eigenem Debug-Port starten:

  ```bash
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --user-data-dir="$PROFILE" \
    --remote-debugging-port=9333 \
    --enable-unsafe-extension-debugging \
    --remote-allow-origins='*' \
    --no-first-run --no-default-browser-check \
    about:blank
  ```

- Einen leeren Testordner anlegen, z. B. `~/Desktop/YB-Native-Test`.

## Ablauf

1. Die Popup-Seite als echten Tab öffnen:
   `chrome-extension://<ID>/popup/popup.html`.
2. **Im Tab** einen Ordner wählen (nicht im Popup). Der native Dialog
   erscheint; im Berechtigungsdialog erlauben.
3. Tab schließen und einen neuen Tab mit derselben Seite öffnen.
   `getStatus().permission` ist jetzt `prompt` — der Zugriff war nur
   flüchtig.
4. Zugriff erneut anfordern. Chrome bietet jetzt den Restore-Dialog mit
   **„Bei jedem Besuch erlauben“** an; diese Option wählen.
5. Chrome vollständig neu starten und erneut `getStatus().permission`
   prüfen: `granted`, ohne dass ein Dialog erschien.
6. Im Service Worker `getStatus()` aufrufen und eine Testdatei über
   `saveOrQueue(...)` schreiben. Sie muss ohne Popup und ohne Klick
   ankommen.

## Beobachtetes Ergebnis

Chrome 155.0.8059.85, macOS, 2026-10-21:

| Schritt | Ergebnis |
|---|---|
| Ordnerwahl im Tab | nativer Dialog, danach `granted` |
| Tab schließen, neuer Tab | `prompt` (nur flüchtiger Grant) |
| Erneute Anforderung im Tab | Restore-Dialog, nach „Bei jedem Besuch erlauben“ `granted` |
| Browserneustart | `granted` ohne Klick |
| Service Worker | `granted`; Testdatei ohne Popup und ohne Klick geschrieben |

Damit ist belegt: Ein dauerhafter Zugriff ist nur über einen echten Tab
erreichbar; im Popup erteilt Chrome den Zugriff still und nur für den
Moment. Genau darauf basiert `extension/folder-access.html` mit der
Prüfrunde `?verify=1`.
