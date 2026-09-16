import {
  getDeckNames,
  getModelNames,
  getModelFieldNames,
  getModelTemplates,
  exportNotes,
} from "./anki.js";
import { scrapeSpanishDictList } from "./content.js";

// Imported lists are filed as subdecks under this parent, named after the list.
const DECK_PARENT = "SpanishDict";
const FALLBACK_DECK = "SpanishDict::Imported";

// Remembered across popup opens (by card-type id, e.g. "basic").
const CARD_TYPE_STORAGE_KEY = "sd2anki.cardType";

// Models never used as a card source: Cloze needs {{c1::}} markup we don't inject,
// Image Occlusion needs image data we don't have, and the optional-reversed type
// would only ever make one card here (we never fill its "Add Reverse" field).
const EXCLUDED_PATTERNS = [/cloze/i, /image occlusion/i, /optional reversed/i];
const isExcludedModel = (name) => EXCLUDED_PATTERNS.some((re) => re.test(name));

// Turn a scraped list name into a safe Anki deck path. "::" is Anki's subdeck
// separator, so collapse any in the list name itself to avoid stray nesting.
function deckNameForList(listName) {
  const safe = (listName || "").replace(/::+/g, ":").replace(/\s+/g, " ").trim();
  return safe ? DECK_PARENT + "::" + safe : FALLBACK_DECK;
}

const statusBadge = document.getElementById("status-badge");
const statusDetail = document.getElementById("status-detail");
const modelField = document.getElementById("model-field");
const modelSelect = document.getElementById("model-select");
const scanButton = document.getElementById("scan-button");
const scanResult = document.getElementById("scan-result");
const exportButton = document.getElementById("export-button");
const exportProgress = document.getElementById("export-progress");
const retryButton = document.getElementById("retry-button");

// Centralized UI state. refreshControls() is the single place that decides which
// controls are enabled, so async handlers only have to flip `busy`.
let lastScrapedWords = [];
let lastListName = "";
let ankiConnected = false;
let busy = false;
// Resolved card-type options: [{ id, label, model, reverse }].
let cardTypes = [];

function setStatus(state, label, detail) {
  statusBadge.className = "badge badge--" + state;
  statusBadge.textContent = label;
  statusDetail.textContent = detail || "";
}

// Lock everything while an async call is in flight (prevents double-submits and
// race conditions); otherwise enable each control based on current state.
function refreshControls() {
  if (busy) {
    scanButton.disabled = true;
    exportButton.disabled = true;
    retryButton.disabled = true;
    modelSelect.disabled = true;
    return;
  }
  scanButton.disabled = !ankiConnected;
  exportButton.disabled = lastScrapedWords.length === 0 || cardTypes.length === 0;
  retryButton.disabled = false;
  modelSelect.disabled = !ankiConnected;
}

// Wipe transient scan/export output and invalidate any prior scrape.
function clearResults() {
  scanResult.textContent = "";
  exportProgress.textContent = "";
  lastScrapedWords = [];
  lastListName = "";
}

// Inspect the user's note types and resolve our four curated card-type options to
// real models. Each entry needs a backing model, so options whose model is absent
// are simply omitted rather than shown as broken choices.
async function buildCardTypes() {
  const models = (await getModelNames()).filter((name) => !isExcludedModel(name));
  if (!models.length) {
    cardTypes = [];
    return;
  }

  // Fetch fields + templates for every candidate (parallel; collections are small).
  const entries = await Promise.all(
    models.map(async (name) => {
      try {
        const [fields, templates] = await Promise.all([
          getModelFieldNames(name),
          getModelTemplates(name),
        ]);
        return [name, { fields: fields || [], templates: templates || {} }];
      } catch (err) {
        return [name, { fields: [], templates: {} }];
      }
    })
  );
  const info = Object.fromEntries(entries);

  const has2Fields = (name) => info[name].fields.length >= 2;
  const templateCount = (name) => Object.keys(info[name].templates).length;
  const templateText = (name) =>
    Object.values(info[name].templates)
      .map((tpl) => ((tpl && tpl.Front) || "") + ((tpl && tpl.Back) || ""))
      .join(" ");
  // Only a TTS template can produce sound from our text-only export.
  const usesTts = (name) => /\{\{\s*tts/i.test(templateText(name));

  const audioModel = models.find((name) => has2Fields(name) && usesTts(name));
  const basicModel =
    (models.includes("Basic") && has2Fields("Basic") && "Basic") ||
    models.find((n) => n !== audioModel && has2Fields(n) && templateCount(n) === 1) ||
    models.find((n) => n !== audioModel && has2Fields(n)) ||
    models.find(has2Fields);
  const bothModel =
    (models.includes("Basic (and reversed card)") && "Basic (and reversed card)") ||
    models.find((name) => has2Fields(name) && templateCount(name) >= 2);

  const types = [];
  if (audioModel) {
    types.push({ id: "audio", label: "Audio", model: audioModel, reverse: false });
  }
  if (basicModel) {
    types.push({ id: "basic", label: "Basic (Spanish → English)", model: basicModel, reverse: false });
    types.push({ id: "reversed", label: "Reversed (English → Spanish)", model: basicModel, reverse: true });
  }
  if (bothModel) {
    types.push({ id: "both", label: "Basic & reversed", model: bothModel, reverse: false });
  }

  cardTypes = types;
}

// Render the resolved card types into the dropdown, restoring the saved choice.
function renderCardTypes() {
  modelSelect.innerHTML = "";
  if (!cardTypes.length) {
    modelField.hidden = true;
    return;
  }
  const saved = localStorage.getItem(CARD_TYPE_STORAGE_KEY);
  const preferred = cardTypes.some((t) => t.id === saved) ? saved : cardTypes[0].id;
  for (const type of cardTypes) {
    const option = document.createElement("option");
    option.value = type.id;
    option.textContent = type.label;
    if (type.id === preferred) option.selected = true;
    modelSelect.appendChild(option);
  }
  modelField.hidden = false;
}

function selectedCardType() {
  return cardTypes.find((t) => t.id === modelSelect.value) || cardTypes[0] || null;
}

async function checkConnection() {
  busy = true;
  refreshControls();
  retryButton.hidden = true;
  modelField.hidden = true;
  setStatus("checking", "Checking Anki…", "");

  try {
    // deckNames is our connection probe — it throws if Anki/AnkiConnect is down.
    await getDeckNames();
    ankiConnected = true;
    setStatus("connected", "Connected to Anki", "");
    await buildCardTypes();
    renderCardTypes();
  } catch (err) {
    ankiConnected = false;
    cardTypes = [];
    setStatus(
      "error",
      "Anki Desktop Not Detected",
      "Open Anki and make sure the AnkiConnect add-on is installed and running."
    );
    retryButton.hidden = false;
  } finally {
    busy = false;
    refreshControls();
  }
}

async function scanActiveTab() {
  clearResults();
  busy = true;
  refreshControls();
  const idleLabel = scanButton.textContent;
  scanButton.textContent = "Scanning…";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null) {
      throw new Error("No active tab to scan.");
    }

    if (!/^https:\/\/www\.spanishdict\.com\/lists/.test(tab.url || "")) {
      scanResult.textContent = "Open a SpanishDict list page, then scan.";
      return;
    }

    // allFrames covers the case where the list renders inside an iframe; each
    // frame returns { listName, words }, so we flatten + dedupe the words and
    // take the list name from whichever frame actually produced rows.
    const injections = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: scrapeSpanishDictList,
    });

    const words = [];
    const seen = new Set();
    let listName = "";
    for (const frame of injections || []) {
      const result = frame.result || {};
      const frameWords = result.words || [];
      if (!listName && frameWords.length && result.listName) {
        listName = result.listName;
      }
      for (const word of frameWords) {
        const key = word.spanish + "→" + word.english;
        if (seen.has(key)) continue;
        seen.add(key);
        words.push(word);
      }
    }
    lastScrapedWords = words;
    lastListName = listName;

    if (words.length === 0) {
      scanResult.textContent = "No words found on this page.";
    } else {
      const inList = listName ? ' in "' + listName + '"' : "";
      scanResult.textContent =
        "Found " + words.length + (words.length === 1 ? " word" : " words") + inList;
      // Show where the cards will land before the user commits.
      exportProgress.textContent = "Will add to deck: " + deckNameForList(listName);
    }
  } catch (err) {
    scanResult.textContent = "Scan failed: " + err.message;
  } finally {
    scanButton.textContent = idleLabel;
    busy = false;
    refreshControls();
  }
}

async function exportToAnki() {
  if (lastScrapedWords.length === 0) return;

  const cardType = selectedCardType();
  if (!cardType) {
    exportProgress.textContent = "No usable Anki note type found.";
    return;
  }

  const deckName = deckNameForList(lastListName);

  exportProgress.textContent =
    "Sending " + lastScrapedWords.length + " notes to Anki…";
  busy = true;
  refreshControls();
  const idleLabel = exportButton.textContent;
  exportButton.textContent = "Exporting…";

  try {
    const summary = await exportNotes(
      lastScrapedWords,
      deckName,
      cardType.model,
      cardType.reverse
    );

    const parts = [
      summary.added + (summary.added === 1 ? " card added" : " cards added"),
    ];
    if (summary.skipped > 0) {
      parts.push(summary.skipped + " skipped (invalid)");
    }
    exportProgress.textContent = parts.join(" · ") + " → " + deckName;
  } catch (err) {
    exportProgress.textContent = "Export failed: " + err.message;
  } finally {
    exportButton.textContent = idleLabel;
    busy = false;
    refreshControls();
  }
}

// Remember the chosen card type for next time.
modelSelect.addEventListener("change", () => {
  localStorage.setItem(CARD_TYPE_STORAGE_KEY, modelSelect.value);
});

// A scrape is tied to one specific tab, so switching the active tab invalidates
// it. Clear stale output and disable export (unless mid-request).
chrome.tabs.onActivated.addListener(() => {
  if (busy) return;
  clearResults();
  refreshControls();
});

scanButton.addEventListener("click", scanActiveTab);
exportButton.addEventListener("click", exportToAnki);
retryButton.addEventListener("click", checkConnection);

document.addEventListener("DOMContentLoaded", checkConnection);
