# SpanishDict to Anki Exporter

A Chrome extension (Manifest V3) that exports your [SpanishDict](https://www.spanishdict.com) vocabulary lists straight into the [Anki](https://apps.ankiweb.net) desktop app — one click, no copy-paste, no CSV round-trips.

It reads the list you're viewing, builds Anki notes from each Spanish/English pair, and adds them to a deck named after the list, using your local [AnkiConnect](https://foosoft.net/projects/anki-connect/) bridge.

<p align="center">
  <img src="icon128.png" alt="SpanishDict to Anki Exporter logo" width="128" height="128" />
</p>

---

## Features

- **One-click export** from any SpanishDict list page into Anki.
- **Resilient scraper** that survives SpanishDict's obfuscated, per-deploy CSS class names by reading the page *structurally* rather than by class.
- **Auto-named decks** — cards land in `SpanishDict::<list name>`, so each list gets its own subdeck.
- **Card-type picker** with the destination note type resolved to your real Anki models:
  - **Audio** (auto-detected — uses your text-to-speech note type)
  - **Basic** (Spanish → English)
  - **Reversed** (English → Spanish)
  - **Basic & reversed** (both directions)
- **Duplicates kept intact** — uses Anki's `allowDuplicate` so a re-export imports the full set without altering any text.
- **Toolbar badge** that lights up "SCAN" only when you're on a list page.
- **Works with non-English Anki** — note-type fields are mapped by position, so localized field names (e.g. `Anverso`/`Reverso`) just work.

---

## How it works

The interesting engineering lives in three places.

### 1. Scraping a class-obfuscated single-page app
SpanishDict is a React SPA whose CSS class names are hashed and change on every deploy (`R48g_E0W`, `v_38_Xaa`, …), so selector-by-class is hopeless. The scraper instead keys off the one stable signal — each vocabulary row is an anchor like:

```html
<a href="/translate/rojo"><div>rojo</div><div>red</div></a>
```

It collects `a[href*="/translate/"]` and reads the two column `<div>`s **by position**, never by class name. Because the content hydrates client-side, the scraper is `async` and retries for a few cycles until rows appear — gated to actual list frames so empty child frames don't add delay. A generic class/`lang`/audio heuristic remains as a fallback if the markup ever shifts.

### 2. Talking to Anki (AnkiConnect)
All Anki communication is funneled through one wrapper (`anki.js`) that speaks AnkiConnect's JSON-RPC v6 envelope and guards every call with a 5-second `AbortController` timeout, so a frozen Anki never hangs the UI. Export provisions the deck if needed (`createDeck`), then batches everything in a single `addNotes` call.

### 3. Choosing the right note type
At connect time the extension reads your note types (`modelNames`), their fields (`modelFieldNames`), and their templates (`modelTemplates`), then resolves the card-type menu to real models — including auto-detecting which model speaks aloud by scanning its templates for Anki's TTS tag (`{{tts …}}`). Each word is mapped onto the chosen model's first two fields (front/back), with an optional swap for the reversed direction.

---

## Install

### From source (developer mode)

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).
5. Pin the extension from the puzzle-piece menu.

---

## Setup — connect it to Anki

The extension talks to Anki through the **AnkiConnect** add-on. You only do this once.

1. **Install AnkiConnect:** in Anki, go to **Tools → Add-ons → Get Add-ons…** and enter code `2055492159`. Restart Anki.
2. **Allow the extension to connect (CORS):** Anki only answers requests from origins it trusts. Go to **Tools → Add-ons → AnkiConnect → Config** and add your extension's origin to `webCorsOriginList`:

   ```json
   {
     "webCorsOriginList": [
       "http://localhost",
       "chrome-extension://<YOUR_EXTENSION_ID>"
     ]
   }
   ```

   Replace `<YOUR_EXTENSION_ID>` with the ID shown on the extension's card at `chrome://extensions`. (For quick local testing you can use `"*"`, but a specific origin is safer.)
3. **Restart Anki** and keep it running while you export.

If the popup says **"Anki Desktop Not Detected,"** Anki isn't running, AnkiConnect isn't installed, or the origin isn't whitelisted.

---

## Usage

1. Open a vocabulary list on SpanishDict (`https://www.spanishdict.com/lists/...`). The toolbar badge turns green ("SCAN").
2. Click the extension icon. The popup confirms **"Connected to Anki."**
3. Pick a **Card type** from the dropdown.
4. Click **Scan Page** — it reports e.g. `Found 40 words in "colors"` and the destination deck.
5. Click **Export to Anki**. Cards are added to `SpanishDict::colors`.

---

## Card types explained

| Option | Backing model | Result |
|---|---|---|
| **Audio** | the model whose template uses `{{tts}}` | Anki reads the term aloud (no audio files needed) |
| **Basic** | `Basic` (or your first front/back model) | Spanish → English, one card |
| **Reversed** | same model, fields swapped | English → Spanish, one card |
| **Basic & reversed** | a model with two card templates | both directions |

Cloze, Image Occlusion, and "optional reversed" note types are intentionally excluded: the extension exports **text only**, so it can't fill cloze markup, image fields, or audio-file fields.

---

## Permissions

| Permission | Why |
|---|---|
| `activeTab` + `scripting` | run the scan on the page when you click the icon |
| `host_permissions: https://www.spanishdict.com/*` | read the open vocabulary list and drive the SCAN badge |
| `host_permissions: http://127.0.0.1:8765/*` | talk to your local AnkiConnect |

No data is sent anywhere except your own local Anki. There is no remote server and no analytics.

---

## Project structure

```
spanishdict-anki-exporter/
├── manifest.json     # MV3 config, permissions, icons
├── background.js     # service worker: SCAN badge on list pages
├── popup.html        # popup UI + styles
├── popup.js          # UI state, scan + export orchestration, card-type menu
├── content.js        # the scraper (injected on demand)
├── anki.js           # AnkiConnect wrapper (invoke, decks, models, export)
└── icon16/32/48/128.png
```

---

## Tech stack

- **JavaScript** — vanilla ES modules, no framework (Chrome Manifest V3).
- **HTML / CSS** — the popup UI.
- **AnkiConnect** — local HTTP API to the Anki desktop app.
- **Python + Pillow** — build-time only, to generate the icon PNGs (not shipped).

---

## Limitations & notes

- **Text only.** The scraper captures the Spanish term and English translation — not images or audio files. "Audio" cards work *only* if the chosen note type generates speech via Anki's TTS template.
- **SpanishDict markup can change.** The scraper is built to be resilient, but a large redesign could still require a selector update.
- **AnkiConnect must be running** and CORS-configured (see Setup).

---

## License

MIT — see `LICENSE`. (Add a `LICENSE` file if you haven't yet.)
