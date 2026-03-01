window.addEventListener("error", (e) => {
  console.error("JS error:", e.error || e.message);
});

const SCRYFALL_COLLECTION_URL = "https://api.scryfall.com/cards/collection";

const BASIC_LANDS = new Set([
  "Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes",
  "Snow-Covered Plains", "Snow-Covered Island", "Snow-Covered Swamp",
  "Snow-Covered Mountain", "Snow-Covered Forest",
]);

const MAX_UNIQUE_CARDS = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quote = (str) => encodeURIComponent(str);

function chunked(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
const escapeAttr = escapeHtml;

function fmtPrice(value) {
  return value ? `$${value} USD` : "—";
}

/** for split/dfc names */
function storeQueryName(cardName) {
  return String(cardName).split(" // ")[0].split("/")[0].trim();
}

function facetofaceSearchUrl(cardName) {
  const q = storeQueryName(cardName);
  return `https://facetofacegames.com/search?q=${quote(q)}&filter__Availability=In+Stock&sort_by=price_asc`;
}
function games401SearchUrl(cardName) {
  const q = storeQueryName(cardName);
  return `https://store.401games.ca/pages/search-results?q=${quote(q)}&sort=price_min_to_max&filters=In+Stock,True`;
}
function moxfieldPrintSearchUrl(setCode, collectorNumber, cardName) {
  let q = `set:${String(setCode).toLowerCase()} cn:${collectorNumber}`;
  if (cardName) q += ` "${cardName}"`;
  return `https://moxfield.com/search/cards?q=${quote(q)}`;
}
function moxfieldArtistSearchUrl(artistName) {
  const q = `a:"${artistName}"`;
  return `https://moxfield.com/search/cards?q=${quote(q)}`;
}

function getImageUri(cardObj) {
  if (cardObj.image_uris) {
    return cardObj.image_uris.large || cardObj.image_uris.normal || cardObj.image_uris.png || null;
  }
  if (Array.isArray(cardObj.card_faces) && cardObj.card_faces.length > 0) {
    const iu = cardObj.card_faces[0].image_uris || {};
    return iu.large || iu.normal || iu.png || null;
  }
  return null;
}

function isPaperPrint(cardObj) {
  return Array.isArray(cardObj.games) && cardObj.games.includes("paper");
}

/** parsing **/
function parseDecklistNames(deckText) {
  const names = [];
  const seen = new Set();

  const cleanCardName = (raw) => {
    let s = String(raw || "").trim();

    // archidekt style count prefix: "1x "
    s = s.replace(/^\d+\s*x?\s+/i, "");

    // strips trailing tags like: [Sideboard], [Ramp], etc.
    s = s.replace(/\s*\[[^\]]*]$/g, "");

    // strips trailing set/collector/foil info like: "(WOE) 202 *F*" or "(woe) 34"
    // removes "(SET)" + following collector number + foil markers
    s = s.replace(/\s*\([A-Za-z0-9]{2,6}\)\s*\d+[A-Za-z]?\s*(\*[^*]+\*)?\s*$/i, "");

    // strips a trailing collector number even if set code missing (rare)
    s = s.replace(/\s+\d+[A-Za-z]?\s*$/i, "");

    // normalizes split formatting:
    // some exports use " / " for DFCs; scryfall likes " // "
    if (s.includes(" / ") && !s.includes(" // ")) {
      s = s.replace(/\s+\/\s+/g, " // ");
    }

    // final trim
    s = s.trim();

    // keeps first face only for lookup stability
    const lookupName = s.split(" // ")[0].trim();

    // if everything gets stripped accidentally, bail
    if (!lookupName) return null;

    return lookupName;
  };

  for (const rawLine of deckText.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (/^-{3,}$/.test(line)) break;

    // ignores weird headers
    if (/^[A-Za-z ].*\(\d+\)$/.test(line)) continue;
    if (/^(commander|sideboard|maybeboard)$/i.test(line)) continue;

    if (line.toUpperCase().startsWith("SIDEBOARD")) continue;

    const name = cleanCardName(line);
    if (!name) continue;

    if (BASIC_LANDS.has(name)) continue;
    if (!seen.has(name)) {
      if (names.length >= MAX_UNIQUE_CARDS) break;

      seen.add(name);
      names.push(name);
    }
  }

  return names;
}

/* scryfall */
async function scryfallCollectionLookup(cardNames) {
  const results = [];
  const chunks = chunked(cardNames, 75);

  for (const ch of chunks) {
    const payload = { identifiers: ch.map((name) => ({ name })) };
    const resp = await fetch(SCRYFALL_COLLECTION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`Scryfall collection error: ${resp.status}`);
    const data = await resp.json();
    results.push(...(data.data || []));
    await sleep(120);
  }

  return results;
}

async function fetchAllPages(url) {
  const out = [];
  let nextUrl = url;

  while (nextUrl) {
    const resp = await fetch(nextUrl);
    if (!resp.ok) throw new Error(`Scryfall list error: ${resp.status}`);
    const data = await resp.json();
    out.push(...(data.data || []));
    nextUrl = data.has_more ? data.next_page : null;
    await sleep(120);
  }
  return out;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = [];
  let i = 0;

  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await mapper(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

/* dedupe + order */
function isBaseCollectorNumber(collector) {
  const s = String(collector || "").trim();
  return /^[0-9]+[A-Za-z]?$/.test(s);
}

function dedupeUniqueArt(prints) {
  const chosen = new Map();

  function priorityTuple(c) {
    return [
      c.promo ? 0 : 1,
      isBaseCollectorNumber(c.collector_number) ? 1 : 0,
      c.released_at || "",
      c.set_name || "",
      String(c.collector_number || ""),
    ];
  }

  const printsSorted = [...prints].sort((a, b) => {
    const ka = priorityTuple(a);
    const kb = priorityTuple(b);
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return 1;
      if (ka[i] > kb[i]) return -1;
    }
    return 0;
  });

  for (const c of printsSorted) {
    if (!isPaperPrint(c)) continue;

    const frameEffects = Array.isArray(c.frame_effects) ? [...c.frame_effects].sort() : [];
    const treatmentKey = [
      Boolean(c.full_art),
      c.border_color || "",
      c.frame || "",
      frameEffects.join("|"),
    ].join("::");

    let artKey;
    if (c.illustration_id) {
      artKey = `ILL:${c.illustration_id}::TREAT:${treatmentKey}`;
    } else {
      artKey = [
        c.oracle_id || "",
        c.name || "",
        c.artist || "",
        treatmentKey,
        getImageUri(c) || "",
      ].join("::");
    }

    if (!chosen.has(artKey)) chosen.set(artKey, c);
  }

  return [...chosen.values()];
}

function displayTreatmentPriority(c) {
  const frameEffects = new Set(c.frame_effects || []);
  const isFullArt = Boolean(c.full_art);
  const isExtended = frameEffects.has("extendedart");
  const isShowcase = frameEffects.has("showcase");
  const isBorderless = frameEffects.has("borderless") || c.border_color === "borderless";

  if (!(isFullArt || isExtended || isShowcase || isBorderless)) return 0; // regular
  if (isShowcase) return 1;
  if (isBorderless) return 2;
  if (isExtended) return 3;
  if (isFullArt) return 4;
  return 5;
}

function sortPrintsForDisplay(prints) {
  return [...prints].sort((a, b) => {
    const ra = a.released_at || "";
    const rb = b.released_at || "";
    if (ra !== rb) return ra < rb ? 1 : -1; // newest first

    const sa = a.set_name || "";
    const sb = b.set_name || "";
    if (sa !== sb) return sa < sb ? 1 : -1;

    const pa = displayTreatmentPriority(a);
    const pb = displayTreatmentPriority(b);
    if (pa !== pb) return pa - pb; // regular first

    return String(a.collector_number || "").localeCompare(String(b.collector_number || ""));
  });
}

/* rendering */
function renderRows(groupedItems, options) {
  const rowsEl = document.getElementById("rows");
  rowsEl.querySelectorAll(".row").forEach((r) => r.remove());

  for (const item of groupedItems) {
    const cardName = item.display_name;
    const prints = item.prints;

    const variantCount = prints.length;
    const variantLabel = variantCount === 1 ? "variant" : "variants";

    const row = document.createElement("div");
    row.className = "row";
    row.dataset.cardName = cardName.toLowerCase();

    const left = document.createElement("div");
    left.className = "row-left";

    const leftTop = document.createElement("div");
    leftTop.className = "row-left-top";
    leftTop.innerHTML = `
      <div class="name">${escapeHtml(cardName)}</div>
      <div class="sub">${variantCount} ${variantLabel}</div>
    `;
    left.appendChild(leftTop);

    if (options.showStores) {
      const f2f = facetofaceSearchUrl(cardName);
      const g401 = games401SearchUrl(cardName);
      const stores = document.createElement("div");
      stores.className = "row-store-links";
      stores.innerHTML = `
        <button class="store" href="${escapeAttr(f2f)}" target="_blank" rel="noopener">Face to Face</a>
        <button class="store" href="${escapeAttr(g401)}" target="_blank" rel="noopener">401 Games</a>
      `;
      left.appendChild(stores);
    }

    const strip = document.createElement("div");
    strip.className = "art-strip";

    for (const c of prints) {
      const img = getImageUri(c);
      if (!img) continue;

      const setName = c.set_name || "Unknown Set";
      const setCode = String(c.set || "").toUpperCase();
      const collector = c.collector_number || "?";
      const artist = c.artist || "Unknown";
      const artistUrl = moxfieldArtistSearchUrl(artist);
      const moxUrl = moxfieldPrintSearchUrl(setCode, collector, cardName);
      const promo = c.promo ? "Yes" : "No";

      const prices = c.prices || {};
      const usd = fmtPrice(prices.usd);
      const usdFoil = fmtPrice(prices.usd_foil);

      const card = document.createElement("div");
      card.className = "print-card";
      card.innerHTML = `
        <a href="${escapeAttr(moxUrl)}" target="_blank" rel="noopener">
          <img src="${escapeAttr(img)}" alt="${escapeAttr(cardName)}">
        </a>
        <div class="caption">
          <div class="set-line"><strong>${escapeHtml(setName)}</strong> (${escapeHtml(setCode)}) #${escapeHtml(String(collector))}</div>
          <span class="subtle">Artist:</span> <a href="${escapeAttr(artistUrl)}" target="_blank" rel="noopener">${escapeHtml(artist)}</a><br>
          <span class="subtle">Promo:</span> ${escapeHtml(promo)}<br>
          <span class="subtle">Price:</span> ${escapeHtml(usd)} <span class="subtle">|</span> <span class="subtle">Foil:</span> ${escapeHtml(usdFoil)}
        </div>
      `;
      strip.appendChild(card);
    }

    requestAnimationFrame(() => {
      if (strip.scrollWidth > strip.clientWidth) {
        strip.classList.add("has-scrollbar");
      } else {
        strip.classList.remove("has-scrollbar");
      }
    });

    row.appendChild(left);
    row.appendChild(strip);
    rowsEl.appendChild(row);
  }
}

/* text fade on parsing text */
function setStatus(text, clearAfterMs = 0, type = "info") {
  const el = document.getElementById("statusLine");
  if (!el) return;

  window.clearTimeout(setStatus._t);
  window.clearTimeout(setStatus._fadeT);

  el.classList.remove("is-fading", "is-error");
  if (type === "error") el.classList.add("is-error");

  el.textContent = text;

  if (clearAfterMs > 0) {
    setStatus._fadeT = window.setTimeout(() => {
      el.classList.add("is-fading");
    }, Math.max(0, clearAfterMs - 220));

    setStatus._t = window.setTimeout(() => {
      if (el.textContent === text) el.textContent = "";
      el.classList.remove("is-fading", "is-error");
    }, clearAfterMs);
  }
}

/* main flow */
async function generateFromText(deckText, options) {
  const metaLine = document.getElementById("metaLine");

  const cardNames = parseDecklistNames(deckText);
  metaLine.textContent =
  `Found ${cardNames.length} cards (max ${MAX_UNIQUE_CARDS}). Skipping basic lands.`;
  setStatus("Looking up cards…");

  const baseCards = await scryfallCollectionLookup(cardNames);

  const perCard = async (base, i) => {
    const name = base.name || "Unknown";
    const printsUrl = base.prints_search_uri;
    if (!printsUrl) return null;

    const url = printsUrl.includes("include_extras=")
      ? printsUrl
      : printsUrl + (printsUrl.includes("?") ? "&" : "?") + "include_extras=true";

    setStatus(`Fetching prints… (${i + 1}/${baseCards.length}) ${name}`);

    const allPrints = await fetchAllPages(url);

    let distinct = dedupeUniqueArt(allPrints);
    distinct = sortPrintsForDisplay(distinct);

    // prefers a non-universes beyond display name when possible
    const nonUb = distinct.filter((p) => p.set_type !== "universesbeyond");
    let displayName = name;
    if (nonUb.length > 0) {
      const newestNonUb = [...nonUb].sort((a, b) =>
        (a.released_at || "") < (b.released_at || "") ? 1 : -1
      )[0];
      displayName = newestNonUb.name || name;
    }

    return { display_name: displayName, prints: distinct };
  };

  // concurrency limit: 3
  const groupedMaybe = await mapWithConcurrency(baseCards, 3, perCard);
  const grouped = groupedMaybe.filter(Boolean);

  grouped.sort((a, b) =>
    a.display_name.toLowerCase().localeCompare(b.display_name.toLowerCase())
  );

  setStatus("Rendering…");
  renderRows(grouped, options);

  window.dispatchEvent(new Event("resize"));

  const totalArts = grouped.reduce((sum, g) => sum + g.prints.length, 0);

  if (grouped.length === 0) {
    metaLine.textContent = "No matches found.";
    throw new Error("No cards matched. Check spelling or use a plain-text export.");
  }

  const cardCount = grouped.length;
  const cardLabel = cardCount === 1 ? "card" : "cards";
  metaLine.textContent = `${totalArts} distinct artworks across ${cardCount} ${cardLabel}.`;
  setStatus("Done", 2000);

  return { cards: grouped.length, arts: totalArts };
}

/* wire ui */
function attachFiltering() {
  const searchBox = document.getElementById("searchBox");
  const rowsEl = document.getElementById("rows");

  searchBox.addEventListener("input", () => {
    const q = searchBox.value.trim().toLowerCase();
    const rows = Array.from(rowsEl.querySelectorAll(".row"));
    for (const row of rows) {
      const name = row.dataset.cardName || "";
      row.style.display = (!q || name.includes(q)) ? "" : "none";
    }
  });
}

function setHasGallery(hasGallery) {
  const emptyState = document.getElementById("emptyState");
  if (emptyState) emptyState.style.display = hasGallery ? "none" : "";
}

function showTopbarClearButton(show) {
  const btn = document.getElementById("topClearBtn");
  if (!btn) return;
  btn.hidden = !show;
}

function main() {
  const params = new URLSearchParams(location.search);
  const showStores = params.get("stores") === "1"; // default OFF; add ?stores=1 to show

  const deckInput = document.getElementById("deckInput");
  const generateBtn = document.getElementById("generateBtn");
  const clearBtn = document.getElementById("clearBtn");

  const topClearBtn = document.getElementById("topClearBtn");
  if (topClearBtn) {
    topClearBtn.addEventListener("click", () => {
      // clears gallery
      document.getElementById("rows").querySelectorAll(".row").forEach((r) => r.remove());

      setHasGallery(false);
      showTopbarClearButton(false);
      setStatus("");

      document.getElementById("metaLine").textContent =
        "Paste a decklist below to generate a gallery of all unique card art. Up to 100 cards can be parsed at a time.";
    });
  }

  attachFiltering();

  window.addEventListener("resize", () => {
    document.querySelectorAll(".art-strip").forEach((strip) => {
      if (strip.scrollWidth > strip.clientWidth) strip.classList.add("has-scrollbar");
      else strip.classList.remove("has-scrollbar");
    });
  });

  // restores from localStorage
  const saved = localStorage.getItem("deckText");
  if (saved) deckInput.value = saved;

  setHasGallery(false);
  showTopbarClearButton(false);

  clearBtn.addEventListener("click", () => {
    const rowsEl = document.getElementById("rows");
    rowsEl.querySelectorAll(".row").forEach((r) => r.remove());

    document.getElementById("statusLine").textContent = "";
    document.getElementById("metaLine").textContent =
      "Paste a decklist below to generate a gallery of all unique card art. Up to 100 cards can be parsed at a time.";

    setHasGallery(false);
    showTopbarClearButton(false);
  });

  generateBtn.addEventListener("click", async () => {
    const text = deckInput.value || "";
    if (!text.trim()) return;

    const parsed = parseDecklistNames(text);
    const meaningful = parsed.filter((n) => n.length >= 2);

    if (meaningful.length === 0) {
      setStatus("That doesn't look like a complete card name yet.", 2500, "error");
      return;
    }

    localStorage.setItem("deckText", text);

    generateBtn.disabled = true;

    try {
      // keeps import ui visible while loading (so page doesn't look empty)
      setStatus("Starting…");

      const result = await generateFromText(text, { showStores });

      // hides import ui + shows "start over" button
      setHasGallery(true);
      showTopbarClearButton(true);

    } catch (e) {
      console.error(e);
      setStatus(`Error: ${e.message}`, 4000, "error");

      // keeps import ui visible if it failed
      setHasGallery(false);
      showTopbarClearButton(false);
    } finally {
      generateBtn.disabled = false;
    }
  });
}

main();