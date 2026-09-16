// Wrapper around the local AnkiConnect HTTP API. All AnkiConnect knowledge lives
// here so the popup/content code never touches the request shape directly.

const ANKI_CONNECT_URL = "http://127.0.0.1:8765";
const ANKI_CONNECT_VERSION = 6;
const REQUEST_TIMEOUT_MS = 5000; // local desktop should answer fast; bail if it hangs

const MODEL_NAME = "Basic"; // built-in Anki note type with Front / Back fields
const NOTE_TAG = "spanishdict";

// Generic AnkiConnect call. Wraps fetch in the JSON-RPC v6 envelope AnkiConnect
// expects and unwraps the {result, error} response. A 5s AbortController guards
// against a frozen Anki instance leaving the UI stuck mid-request.
export async function ankiInvoke(action, params = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(ANKI_CONNECT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, version: ANKI_CONNECT_VERSION, params }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error("AnkiConnect returned HTTP " + response.status);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error);
    }
    return data.result;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Anki connection timed out — check if Anki is responsive");
    }
    // fetch rejects with a TypeError on network failure: Anki not running,
    // add-on missing, or origin blocked by CORS. Re-throw our own protocol
    // errors (HTTP status / data.error) unchanged.
    if (error instanceof TypeError) {
      throw new Error("Could not reach AnkiConnect at " + ANKI_CONNECT_URL);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function getDeckNames() {
  return ankiInvoke("deckNames");
}

// Note types the user has in Anki. On an English install this includes "Basic";
// on a localized install it may be "Básico" etc., which is exactly why the caller
// lets the user pick rather than us hardcoding a name.
export function getModelNames() {
  return ankiInvoke("modelNames");
}

// A note type's field names, in order (field 0 is the front for Basic-style models).
export function getModelFieldNames(modelName) {
  return ankiInvoke("modelFieldNames", { modelName });
}

// A note type's card templates: { "Card 1": { Front, Back }, ... }. Used to detect
// which model speaks via Anki TTS and which has a reverse (second) card.
export function getModelTemplates(modelName) {
  return ankiInvoke("modelTemplates", { modelName });
}

// Front-field text: the Spanish word plus the normalized POS suffix (" (noun)").
function frontText(word) {
  return word.spanish + (word.partOfSpeech || "");
}

// Provision the deck if needed, then add all notes in one batched call.
// The note type is chosen by the caller; we map each word onto that model's first
// two fields BY POSITION (field 0 = front, field 1 = back). Reading the model's
// real field names means this works even when Anki's UI language localizes
// "Front"/"Back" (e.g. "Anverso"/"Reverso").
export async function exportNotes(words, deckName, modelName = MODEL_NAME, reverse = false) {
  if (!Array.isArray(words) || words.length === 0) {
    return { total: 0, added: 0, skipped: 0 };
  }

  const fieldNames = await getModelFieldNames(modelName);
  if (!Array.isArray(fieldNames) || fieldNames.length < 2) {
    throw new Error(
      'Note type "' + modelName + '" needs at least two fields (front and back).'
    );
  }
  const [firstField, secondField] = fieldNames;

  const existingDecks = await getDeckNames();
  if (!existingDecks.includes(deckName)) {
    await ankiInvoke("createDeck", { deck: deckName });
  }

  // `reverse` puts the English prompt on the front (first field) and the Spanish
  // term on the back; otherwise Spanish (with POS) is the prompt. The POS suffix
  // always travels with the Spanish side.
  const notes = words.map((word) => {
    const spanish = frontText(word);
    const english = word.english;
    return {
      deckName,
      modelName,
      fields: {
        [firstField]: reverse ? english : spanish,
        [secondField]: reverse ? spanish : english,
      },
      // allowDuplicate lets Anki add the note even when its front matches an
      // existing one — the full list imports intact, with unaltered text.
      options: { allowDuplicate: true },
      tags: [NOTE_TAG],
    };
  });

  // addNotes returns a real ID per note here (duplicates allowed); a null only
  // appears for a genuinely invalid note, which we count as skipped.
  const noteIds = await ankiInvoke("addNotes", { notes });
  const added = noteIds.filter((id) => id !== null).length;

  return {
    total: notes.length,
    added,
    skipped: notes.length - added,
  };
}
