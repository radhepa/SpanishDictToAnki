// Scraper for SpanishDict vocabulary list pages.
//
// Injected into the active tab via chrome.scripting.executeScript (passed as
// `func`), so it must be FULLY SELF-CONTAINED: every helper is nested, it
// references only page globals, and it returns a plain JSON-safe object of the
// shape { listName, words }, where words is an array of { spanish, english,
// partOfSpeech } (partOfSpeech already normalized to an append-ready " (noun)"
// string, or "") and listName is the deck destination derived from the page.
//
// SpanishDict is an SPA with heavily obfuscated, per-deploy class hashes (e.g.
// "R48g_E0W") and no lang attributes, so class/lang heuristics don't survive.
// The one stable signal is the row anchor — each vocabulary entry is an
// <a href="/translate/..."> whose two inner column divs hold the Spanish word
// then the English translation:
//
//   <a href="/translate/red">
//     <div>                      <- wrapper
//       <div><span>rojo</span></div>   <- column 0: Spanish
//       <div><span>red</span></div>    <- column 1: English
//     </div>
//   </a>
//
// So we read columns by STRUCTURE, never by class name. Generic class/lang/audio
// heuristics remain as a secondary fallback in case the markup shifts.
//
// The function is async and returns a Promise — executeScript awaits it — so we
// retry while the SPA hydrates.
export async function scrapeSpanishDictList() {
  // Defensive whitespace sanitizer: flatten hard line breaks first (a stray \n or
  // \r would break Anki's single-line rendering), collapse the rest, then trim.
  const clean = (text) =>
    (text || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

  // Normalize a part-of-speech token into an append-ready " (noun)" form, or ""
  // when absent. Strips any parens/whitespace already applied so we never
  // double-wrap; the leading space lets it concatenate onto Front.
  const normalizePartOfSpeech = (raw) => {
    const token = clean(raw).replace(/^[()\s]+|[()\s]+$/g, "");
    return token ? ` (${token})` : "";
  };

  // First non-empty text from a list of selectors within `root`.
  const textBySelectors = (root, selectors) => {
    for (const selector of selectors) {
      const el = root.querySelector(selector);
      if (el) {
        const value = clean(el.textContent);
        if (value) return value;
      }
    }
    return "";
  };

  // The list's display name, used as the Anki deck destination. Prefer the page
  // header; fall back to the list slug in the URL (/lists/<id>/<slug>); last
  // resort is the document title with the " | SpanishDict" suffix stripped.
  const extractListName = () => {
    const header = textBySelectors(document, [
      '[class*="listName" i]',
      '[class*="listTitle" i]',
      "main h1",
      "h1",
    ]);
    if (header && !/^spanishdict$/i.test(header)) return header;

    const slug = location.pathname.match(/\/lists\/[^/]+\/([^/?#]+)/);
    if (slug) return decodeURIComponent(slug[1]).replace(/[-_]+/g, " ").trim();

    return clean((document.title || "").replace(/\s*[|\-–—].*$/, ""));
  };

  // Dedupe + sanitize on the way into the result set.
  const pushWord = (words, seen, spanish, english, partOfSpeech) => {
    const es = clean(spanish);
    const en = clean(english);
    if (!es || !en) return;
    const key = es + "→" + en;
    if (seen.has(key)) return;
    seen.add(key);
    words.push({
      spanish: es,
      english: en,
      partOfSpeech: normalizePartOfSpeech(partOfSpeech),
    });
  };

  // ---- Primary strategy: /translate/ row anchors (matches the live DOM) ----

  function extractFromAnchor(anchor) {
    // Find the columns container structurally: the shallowest element inside the
    // anchor whose direct children each carry text (Spanish col, English col).
    // This survives class-hash churn because it relies only on the tree shape.
    const candidates = [anchor, ...anchor.querySelectorAll("div")];
    for (const el of candidates) {
      const columns = Array.from(el.children).filter((child) =>
        clean(child.textContent)
      );
      if (columns.length >= 2) {
        return {
          spanish: columns[0].textContent,
          english: columns[1].textContent,
          partOfSpeech: "",
        };
      }
    }
    // Last resort: first two non-empty spans anywhere in the anchor.
    const spans = Array.from(anchor.querySelectorAll("span"))
      .map((span) => clean(span.textContent))
      .filter(Boolean);
    return { spanish: spans[0] || "", english: spans[1] || "", partOfSpeech: "" };
  }

  function scrapeFromTranslateAnchors() {
    const words = [];
    const seen = new Set();
    document.querySelectorAll('a[href*="/translate/"]').forEach((anchor) => {
      const { spanish, english, partOfSpeech } = extractFromAnchor(anchor);
      pushWord(words, seen, spanish, english, partOfSpeech);
    });
    return words;
  }

  // ---- Secondary fallback: generic class / lang / audio heuristics ----

  const ROW_ANCESTORS =
    'tr, li, [role="row"], [class*="row" i], [class*="entry" i], [class*="item" i], [class*="card" i]';

  function collectRows() {
    const found = new Set();

    [
      '[class*="vocabularyListRow" i]',
      '[class*="vocabRow" i]',
      '[class*="vocab" i][class*="row" i]',
      '[class*="listRow" i]',
      '[data-testid*="vocab" i]',
    ].forEach((selector) =>
      document.querySelectorAll(selector).forEach((el) => found.add(el))
    );

    document.querySelectorAll('tr, li, [role="row"], div').forEach((el) => {
      if (
        el.querySelector('[lang="es"], [lang^="es-"]') &&
        el.querySelector('[lang="en"], [lang^="en-"]')
      ) {
        found.add(el);
      }
    });

    document
      .querySelectorAll(
        '[class*="audio" i], [class*="playButton" i], [class*="speaker" i], [aria-label*="play" i]'
      )
      .forEach((btn) => {
        const row = btn.closest(ROW_ANCESTORS);
        if (row) found.add(row);
      });

    const rows = Array.from(found);
    return rows.filter(
      (el) => !rows.some((other) => other !== el && el.contains(other))
    );
  }

  function extractFromRow(row) {
    let spanish =
      textBySelectors(row, ['[lang="es"]', '[lang^="es-"]']) ||
      textBySelectors(row, [
        '[class*="source" i]',
        '[class*="spanish" i]',
        '[class*="term" i]',
        '[class*="word" i]',
      ]);

    let english =
      textBySelectors(row, ['[lang="en"]', '[lang^="en-"]']) ||
      textBySelectors(row, [
        '[class*="target" i]',
        '[class*="english" i]',
        '[class*="translation" i]',
        '[class*="definition" i]',
      ]);

    if (!spanish || !english) {
      const cells = Array.from(
        row.querySelectorAll('td, [class*="cell" i], [class*="col" i]')
      )
        .map((cell) => clean(cell.textContent))
        .filter(Boolean);
      if (!spanish && cells[0]) spanish = cells[0];
      if (!english && cells[1]) english = cells[1];
    }

    const partOfSpeech = textBySelectors(row, [
      '[class*="partOfSpeech" i]',
      '[class*="wordType" i]',
      '[class*="pos-" i]',
      "abbr[title]",
    ]);

    return { spanish, english, partOfSpeech };
  }

  function scrapeGenericRows() {
    const words = [];
    const seen = new Set();
    collectRows().forEach((row) => {
      const { spanish, english, partOfSpeech } = extractFromRow(row);
      pushWord(words, seen, spanish, english, partOfSpeech);
    });
    return words;
  }

  function scrapeOnce() {
    const primary = scrapeFromTranslateAnchors();
    return primary.length ? primary : scrapeGenericRows();
  }

  // SPA hydration guard: if nothing rendered yet, wait and retry (up to ~3s).
  // Gate on being an actual list frame — under allFrames this same code also runs
  // in the page's empty about:blank child frames, and without this gate each of
  // those would burn the full 3s retry loop and stall every single scan.
  const onListPage = /spanishdict\.com\/lists/.test(location.href);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let words = scrapeOnce();
  for (let attempt = 0; attempt < 6 && words.length === 0 && onListPage; attempt++) {
    await delay(500);
    words = scrapeOnce();
  }
  return { listName: extractListName(), words };
}
