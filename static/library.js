import { focusBeside } from "./router.js";
import {
  plural,
  timeLabel,
  stationSelection,
  radioGroupValue,
  setRadioGroupValue,
} from "./format.js";
import { animateLayout } from "./motion.js";
import {
  failureSentence,
  problemCopy,
  problemState,
  retryWait,
  waitWords,
} from "./problem.js";

const randomBrowserHex = window.ZakRandomBrowserHex;

// One name per idea: the "Recently added" shelf, chip, heading, and filter
// station option all say the same thing. "All songs" is the main station's
// name, so the whole library is "Every song".
const FILTER_LABELS = {
  all: "Every song",
  liked: "Liked by listeners",
  mine: "Your likes",
  covers: "Songs with artwork",
  recent: "Recently added",
};
const FILTER_KEYS = Object.keys(FILTER_LABELS);
// The filters a filter station can play: the server can't match Your likes,
// which are kept in this browser. The station editor's Include options.
export const STATION_FILTERS = ["all", "liked", "covers", "recent"];

// What a new filter station starts from: the search and filter on screen.
// This is the one place a Library filter becomes a station's filter. From
// Your likes the station includes every song and the editor says why,
// offering the liked songs shown as a hand-picked station instead, so the
// station never claims likes it can't play.
export function filterStationPrefill({
  query = "",
  filter = "all",
  shownIds = [],
} = {}) {
  const prefill = {
    query: query.slice(0, 160),
    mode: STATION_FILTERS.includes(filter) ? filter : "all",
    note: "",
    shownIds: [],
  };
  if (filter !== "mine") return prefill;
  return {
    ...prefill,
    note: shownIds.length
      ? "Filter stations can’t use Your likes, which are kept in this browser. You can keep the songs you liked as a hand-picked station instead."
      : "Filter stations can’t use Your likes, which are kept in this browser.",
    shownIds,
  };
}

// "match" is the order Library starts with: Best match while searching,
// Newest added first otherwise. Remember the order the listener chooses.
const SORT_VALUES = [
  "match",
  "newest",
  "archive",
  "title",
  "duration",
  "played",
];
const SORT_KEY = "zak-library-sort";
const VIEW_VALUES = ["grid", "list"];
const PAGE_SIZE = 60;
const SHELF_SIZE = 12;
const RECENT_WINDOW = 180 * 24 * 60 * 60 * 1000;

// What trackDisplayTitle (app.js) calls a song with no usable title.
const UNTITLED = "Untitled";

const KIND_LABELS = {
  list: "Hand-picked station",
  filter: "Filter station",
  temporary: "Temporary station",
};

const ICONS = {
  play: '<svg class="playback-icon" data-icon="play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 6.2v11.6a.8.8 0 0 0 1.2.7l9.3-5.8a.8.8 0 0 0 0-1.4L9.7 5.5a.8.8 0 0 0-1.2.7z"></path></svg>',
  pause:
    '<svg class="playback-icon" data-icon="pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5.5" width="4" height="13" rx="1.2"></rect><rect x="13.5" y="5.5" width="4" height="13" rx="1.2"></rect></svg>',
  more: '<svg class="library-dots" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg>',
  close:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"></path></svg>',
};

// ---------------------------------------------------------------- search
// Folding removes case and accents so "cafe" finds "Café". Words are also
// canonicalized for common British spellings so "harbour" finds "Harbor".

const FOLD_MAP = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
};
const MARKS = /\p{M}+/gu;
const WORD = /[\p{L}\p{N}]+/gu;
const SPELLING = new Map([
  ["grey", "gray"],
  ["greys", "grays"],
  ["centre", "center"],
  ["centres", "centers"],
  ["theatre", "theater"],
  ["metre", "meter"],
  ["litre", "liter"],
  ["fibre", "fiber"],
  ["sombre", "somber"],
  ["spectre", "specter"],
  ["lustre", "luster"],
]);
const META_LINE = /^(?:title|persona|seed|artist|model|style)\s*:/i;
const SECTION_LINE = /^\[[^\]]*\]$/;
const FIELD_WEIGHTS = {
  title: 10,
  artist: 6,
  group: 6,
  source: 2,
  notes: 3,
  text: 2,
};
// Fields a card shows. A match anywhere else is explained under the title.
const VISIBLE_FIELDS = new Set(["title", "artist", "group"]);
const FIELD_LABELS = { group: "Collection", source: "Made with" };

function foldChar(character) {
  const lower = character.toLocaleLowerCase();
  return FOLD_MAP[lower] ?? lower.normalize("NFD").replace(MARKS, "");
}

function fold(source) {
  return String(source || "")
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(MARKS, "")
    .replace(/[ßæœøłđðþı]/g, (character) => FOLD_MAP[character]);
}

// Folds text and keeps a map from folded offsets to source offsets, so
// matches found in folded text can be highlighted in the original.
function foldMapped(source) {
  let text = "";
  const map = [];
  let offset = 0;
  for (const character of String(source || "")) {
    const folded = foldChar(character);
    for (let index = 0; index < folded.length; index += 1) map.push(offset);
    text += folded;
    offset += character.length;
  }
  map.push(offset);
  return { text, map };
}

function canonicalWord(word) {
  if (SPELLING.has(word)) return SPELLING.get(word);
  const british = /^(\p{L}{3,})our(s?)$/u.exec(word);
  return british ? `${british[1]}or${british[2]}` : word;
}

function wordsOf(folded) {
  return (folded.match(WORD) || []).map(canonicalWord);
}

function indexField(text) {
  const folded = fold(text);
  const words = wordsOf(folded);
  return { folded, words, set: new Set(words) };
}

function typoLimit(term) {
  if (term.length >= 8) return 2;
  return term.length >= 4 ? 1 : 0;
}

// Optimal string alignment distance with an early exit once every cell in a
// row exceeds the limit.
function withinDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return false;
  let before = null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let smallest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, before[j - 2] + 1);
      }
      row.push(value);
      smallest = Math.min(smallest, value);
    }
    if (smallest > limit) return false;
    before = previous;
    previous = row;
  }
  return previous[b.length] <= limit;
}

function parseQuery(raw) {
  const text = String(raw || "").trim();
  const folded = fold(text).replace(/\s+/g, " ");
  return { raw: text, folded, terms: [...new Set(wordsOf(folded))] };
}

// 1 exact word, .8 word prefix, .6 substring, .45/.3 close spelling.
function matchTerm(term, field, fuzzy) {
  if (field.set.has(term)) return 1;
  if (field.words.some((word) => word.startsWith(term))) return 0.8;
  if (term.length >= 3 && field.folded.includes(term)) return 0.6;
  if (!fuzzy) return 0;
  const limit = typoLimit(term);
  if (!limit) return 0;
  for (const word of field.words) {
    if (withinDistance(term, word, limit)) return 0.45;
  }
  if (term.length >= 5) {
    for (const word of field.words) {
      if (
        word.length > term.length &&
        withinDistance(term, word.slice(0, term.length), limit)
      )
        return 0.3;
    }
  }
  return 0;
}

function scoreEntry(entry, query, fuzzy) {
  let score = 0;
  let hidden = false;
  const fields = new Set();
  for (const term of query.terms) {
    let best = 0;
    let bestField = "";
    for (const [key, field] of Object.entries(entry.fields)) {
      const allowFuzzy = fuzzy && (key !== "text" || term.length >= 6);
      const value = matchTerm(term, field, allowFuzzy) * FIELD_WEIGHTS[key];
      if (value > best) {
        best = value;
        bestField = key;
      }
    }
    if (!best) return null;
    score += best;
    fields.add(bestField);
    if (!VISIBLE_FIELDS.has(bestField) && bestField !== "source") hidden = true;
  }
  const title = entry.fields.title.folded;
  if (query.folded && title.startsWith(query.folded)) score += 20;
  else if (query.folded && title.includes(query.folded)) score += 12;
  return { score, hidden, fields: [...fields] };
}

function collectMatches(entries, query, fuzzy) {
  const results = [];
  for (const entry of entries) {
    const match = scoreEntry(entry, query, fuzzy);
    if (match) results.push({ entry, ...match });
  }
  return results;
}

function searchEntries(entries, query) {
  if (!query.terms.length) {
    return {
      fuzzy: false,
      results: entries.map((entry) => ({
        entry,
        score: 0,
        hidden: false,
        fields: [],
      })),
    };
  }
  const exact = collectMatches(entries, query, false);
  if (exact.length) return { fuzzy: false, results: exact };
  const close = collectMatches(entries, query, true);
  return { fuzzy: close.length > 0, results: close };
}

// Folded [start, end) ranges where the query terms appear.
function highlightRanges(folded, terms, fuzzy) {
  const ranges = [];
  const stopwords = new Set([
    "a",
    "an",
    "and",
    "at",
    "by",
    "for",
    "in",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
  ]);
  const phrase = terms.join(" ");
  if (terms.length > 1 && folded.includes(phrase)) {
    let start = folded.indexOf(phrase);
    while (start >= 0) {
      ranges.push([start, start + phrase.length]);
      start = folded.indexOf(phrase, start + phrase.length);
    }
    return ranges;
  }
  if (terms.some((term) => !stopwords.has(term)))
    terms = terms.filter((term) => !stopwords.has(term));
  for (const term of terms) {
    let found = false;
    for (const match of folded.matchAll(WORD)) {
      const word = match[0];
      const start = match.index;
      if (canonicalWord(word) === term) {
        ranges.push([start, start + word.length]);
        found = true;
      } else if (word.startsWith(term)) {
        ranges.push([start, start + term.length]);
        found = true;
      }
    }
    if (!found && term.length >= 3) {
      let index = folded.indexOf(term);
      while (index >= 0) {
        ranges.push([index, index + term.length]);
        found = true;
        index = folded.indexOf(term, index + term.length);
      }
    }
    if (!found && fuzzy && typoLimit(term)) {
      for (const match of folded.matchAll(WORD)) {
        if (withinDistance(term, canonicalWord(match[0]), typoLimit(term))) {
          ranges.push([match.index, match.index + match[0].length]);
        }
      }
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

// Appends text to parent with <mark> around the matched ranges. A window
// keeps long lines short, centered on the first match.
function appendHighlighted(parent, source, terms, fuzzy, windowSize = 0) {
  const { text, map } = foldMapped(source);
  const ranges = [];
  for (const [start, end] of highlightRanges(text, terms, fuzzy)) {
    const range = [map[start], map[end]];
    const last = ranges.at(-1);
    // "city sleeps" reads as one highlight, not two.
    if (last && /^\s*$/.test(source.slice(last[1], range[0])))
      last[1] = range[1];
    else ranges.push(range);
  }
  let from = 0;
  let to = source.length;
  if (windowSize && source.length > windowSize) {
    const anchor = ranges[0]?.[0] ?? 0;
    from = Math.max(0, anchor - Math.floor(windowSize / 3));
    to = Math.min(source.length, from + windowSize);
    from = Math.max(0, to - windowSize);
    if (from > 0) {
      const space = source.indexOf(" ", from);
      if (space >= 0 && space < anchor) from = space + 1;
    }
    if (to < source.length) {
      const space = source.lastIndexOf(" ", to);
      if (space > (ranges[0]?.[1] ?? from)) to = space;
    }
  }
  if (from > 0) parent.append("…");
  let cursor = from;
  for (const [start, end] of ranges) {
    if (end <= from || start >= to) continue;
    const markStart = Math.max(start, from);
    const markEnd = Math.min(end, to);
    if (markStart > cursor) parent.append(source.slice(cursor, markStart));
    const mark = document.createElement("mark");
    mark.textContent = source.slice(markStart, markEnd);
    parent.append(mark);
    cursor = markEnd;
  }
  if (cursor < to) parent.append(source.slice(cursor, to));
  if (to < source.length) parent.append("…");
  return ranges.length > 0;
}

// ---------------------------------------------------------------- module

export function initLibrary({ router } = {}) {
  // Phones get the denser list unless the listener chose a layout.
  const defaultView = window.matchMedia(
    "(max-width: 640px), (max-height: 500px)",
  ).matches
    ? "list"
    : "grid";
  const storedView = window.ZakStorage.get("zak-library-view", defaultView);
  function storedSort() {
    const value = window.ZakStorage.get(SORT_KEY, "match");
    return SORT_VALUES.includes(value) ? value : "match";
  }
  const storedOrDefaultView = () => {
    const value = window.ZakStorage.get("zak-library-view", defaultView);
    return VIEW_VALUES.includes(value) ? value : defaultView;
  };
  const state = {
    tracks: [],
    entries: [],
    results: [],
    parsed: parseQuery(""),
    fuzzy: false,
    query: "",
    filter: "all",
    sort: storedSort(),
    view: VIEW_VALUES.includes(storedView) ? storedView : defaultView,
    radioInterrupted: false,
    group: "",
    artist: "",
    limit: PAGE_SIZE,
    status: "loading",
    error: null,
    current: null,
    stationsReady: false,
    stationsFailed: false,
    stationsError: null,
    pendingDeletes: new Map(),
    deleteErrors: new Map(),
    editor: null,
    editorFocus: null,
    chooser: null,
    chooserHandoff: false,
    menuTrigger: null,
    renderTimer: 0,
    refreshAfterMenu: false,
    urlTimer: 0,
    urlPending: null,
    announceTimer: 0,
    lastAnnouncement: "",
    highlightTimer: 0,
    clampFrame: 0,
    catalogKey: "",
  };

  const byId = (id) => document.getElementById(id);
  const els = {
    page: byId("libraryView"),
    search: byId("librarySearch"),
    sort: byId("librarySort"),
    filters: [...document.querySelectorAll("[data-library-filter]")],
    groupFilter: byId("libraryGroupFilter"),
    toolbar: document.querySelector(".library-tools"),
    shelves: byId("libraryShelves"),
    jumpAll: byId("libraryJumpAll"),
    jumpAllLabel: byId("libraryJumpAllLabel"),
    heading: byId("libraryTitle"),
    count: byId("libraryCount"),
    saveFilter: byId("librarySaveFilter"),
    views: [...document.querySelectorAll("[data-library-view]")],
    queueNote: byId("libraryQueueNote"),
    tracks: byId("libraryTracks"),
    menu: byId("libraryTrackMenu"),
    status: byId("libraryStatus"),
    stationsHeading: byId("stationsTitle"),
    stationsSection: byId("stations"),
    stationsToggle: byId("stationsToggle"),
    stationsToggleCount: byId("stationsToggleCount"),
    newStation: byId("newStation"),
    stationList: byId("savedStationList"),
    onAir: byId("libraryOnAir"),
    onAirStation: byId("libraryOnAirStation"),
    onAirList: byId("libraryOnAirList"),
    audio: window.ZakAudio.element,
    chooser: byId("newStationDialog"),
    chooserError: byId("newStationError"),
    chooserLede: byId("newStationLede"),
    chooserCancel: byId("newStationCancel"),
    chooserOptions: [...document.querySelectorAll("[data-station-kind]")],
    editorDialog: byId("stationEditorDialog"),
    editor: byId("stationEditor"),
    editorKind: byId("stationEditorKind"),
    editorTitle: byId("stationEditorTitle"),
    editorName: byId("stationEditorName"),
    editorFilter: byId("stationEditorFilter"),
    editorQuery: byId("stationEditorQuery"),
    editorMode: byId("stationEditorMode"),
    editorMatches: byId("stationEditorMatches"),
    editorPreview: byId("stationEditorPreview"),
    editorNotice: byId("stationEditorNotice"),
    editorNoticeText: byId("stationEditorNoticeText"),
    editorUseShown: byId("stationEditorUseShown"),
    editorList: byId("stationEditorList"),
    editorSongCount: byId("stationEditorSongCount"),
    editorMembers: byId("stationEditorMembers"),
    editorSearch: byId("stationEditorSearch"),
    editorResults: byId("stationEditorResults"),
    editorRandom: byId("stationEditorRandom"),
    editorSkip: byId("stationEditorSkip"),
    editorError: byId("stationEditorError"),
    editorStatus: byId("stationEditorStatus"),
    editorCancel: byId("stationEditorCancel"),
    editorClose: byId("stationEditorClose"),
    chooserClose: byId("newStationClose"),
    editorSave: byId("stationEditorSave"),
    editorDiscard: byId("stationEditorDiscard"),
    editorKeep: byId("stationEditorKeep"),
    editorDiscardConfirm: byId("stationEditorDiscardConfirm"),
    editorAccess: byId("stationEditorAccess"),
    editorShare: byId("stationEditorShare"),
    editorTransfer: byId("stationEditorTransfer"),
    editorLinkFallback: byId("stationEditorLinkFallback"),
    editorLinkLabel: byId("stationEditorLinkLabel"),
    editorLinkField: byId("stationEditorLinkField"),
    editorAccessStatus: byId("stationEditorAccessStatus"),
  };
  const menuHome = els.menu.parentElement;
  const popoverSupported =
    typeof HTMLElement !== "undefined" &&
    typeof HTMLElement.prototype.showPopover === "function";

  // -------------------------------------------------------------- helpers

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  const onLibrary = () => window.location.pathname.startsWith("/library");
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
  const coarsePointer = window.matchMedia("(pointer: coarse)");
  const quote = (text) => `“${text}”`;
  const displayTitle = (track) => window.ZakTrackDisplayTitle(track);
  const displayGroup = (track) => window.ZakTrackDisplayGroup(track) || "";
  // Who made a song. Rows that leave out the collection still name it for
  // an "Untitled" song (one with no usable title), so it can be told apart.
  const byline = (track) =>
    [
      track.artist || "Zak",
      displayTitle(track) === UNTITLED ? displayGroup(track) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  // A new hand-picked station is named for its first song, unless that song
  // has no title of its own.
  const listName = (track) =>
    track && displayTitle(track) !== UNTITLED
      ? `${displayTitle(track)} and more`.slice(0, 80)
      : "Hand-picked mix";
  // Like and Dislike belong to this browser; Radio's reactions remember them.
  const likedHere = (track) =>
    Boolean(window.ZakReactions?.view?.(track)?.liked);
  const ownerToken = (stationId) =>
    window.ZakStorage.get(`zak-radio-owner:${stationId}`, "");

  function element(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function icon(name) {
    const template = document.createElement("template");
    template.innerHTML = ICONS[name];
    return template.content.firstElementChild;
  }

  function button(label, className = "button", onClick = null) {
    const node = element("button", className, label);
    node.type = "button";
    if (onClick) node.addEventListener("click", onClick);
    return node;
  }

  function dateValue(track) {
    const raw = track.created_at || "";
    const value = /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? Date.parse(`${raw}T00:00:00Z`)
      : Date.parse(raw);
    return Number.isFinite(value) ? value : 0;
  }

  function dateLabel(track) {
    const value = dateValue(track);
    if (!value) return "";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(value);
  }

  function sizeLabel(bytes) {
    const value = number(bytes);
    return value > 0 && window.ZakFormatBytes
      ? window.ZakFormatBytes(value)
      : "";
  }

  // Plain-language explanation of a failed request; never raw status text.
  // Connection failures use the shared diagnosis (problem.js).
  function problem(error, subject = "") {
    const status = number(error?.status);
    if (status === 404)
      return subject === "station"
        ? "This station isn’t available anymore."
        : "Zak Radio couldn’t find that.";
    if (status === 403) return "This device can’t edit this station anymore.";
    if (status === 429)
      return `Too many changes right now. Try again ${waitWords(retryWait(error))}.`;
    if (status === 400 || status === 409)
      return "Zak Radio couldn’t accept that change. Check the details and try again.";
    return problemCopy(error).text;
  }

  let announceTimer = 0;
  function announce(message) {
    if (!els.status) return;
    window.clearTimeout(announceTimer);
    els.status.textContent = "";
    announceTimer = window.setTimeout(() => {
      els.status.textContent = message;
    }, 60);
  }

  function notify(message, options = {}) {
    if (typeof window.ZakNotify === "function")
      return window.ZakNotify(message, options);
    announce(message);
    return { dismiss() {} };
  }

  function stationInfo() {
    const station = window.ZakStation?.current?.();
    return station?.known === true ? station : null;
  }

  const reconnectBanner = element("p", "library-reconnect");
  reconnectBanner.setAttribute("role", "status");
  reconnectBanner.hidden = true;
  els.page.querySelector(".library-intro").after(reconnectBanner);
  function syncConnectivity() {
    const lost = stationInfo()?.connected === false;
    reconnectBanner.hidden = !lost;
    reconnectBanner.textContent = lost
      ? "Reconnecting… You can browse loaded songs. New previews and station changes return when Zak Radio reconnects."
      : "";
    for (const node of document.querySelectorAll(
      "#newStation, #createStation, #stationEditorSave, #librarySaveFilter, [data-control='preview'], [data-needs-server], .station-tile [data-control='listen']",
    )) {
      const localPreview =
        node.dataset.control === "preview" &&
        node.closest("[data-track-id]")?.dataset.trackId ===
          state.current?.id &&
        window.ZakAudio.is("library");
      if (lost && !localPreview) {
        if (!node.hasAttribute("data-connection-disabled"))
          node.dataset.connectionDisabled = String(node.disabled);
        node.disabled = true;
      } else if (node.hasAttribute("data-connection-disabled")) {
        node.disabled = node.dataset.connectionDisabled === "true";
        delete node.dataset.connectionDisabled;
      }
      if (node.tagName === "A") {
        if (lost) node.setAttribute("aria-disabled", "true");
        else node.removeAttribute("aria-disabled");
      }
    }
  }
  window.addEventListener("zak-connection", syncConnectivity);
  els.page.addEventListener(
    "click",
    (event) => {
      if (event.target.closest('a[aria-disabled="true"]')) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );

  function queueTarget() {
    const station = stationInfo();
    return station?.kind === "temporary" &&
      station.canControl &&
      station.supportsQueue
      ? station
      : null;
  }

  function openRadio() {
    const link = document.querySelector('.primary-nav [data-route="/"]');
    if (link) link.click();
    else window.location.assign("/");
  }

  function focusVisible(target) {
    if (!target?.isConnected || target.closest("[hidden]")) return false;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "nearest" });
    return document.activeElement === target;
  }

  // -------------------------------------------------------------- catalog index

  function buildEntries(tracks) {
    state.entries = tracks.map((track, position) => {
      const title = displayTitle(track);
      return {
        track,
        position,
        title,
        group: displayGroup(track),
        date: dateValue(track),
        fields: {
          title: indexField(
            title === track.title ? title : `${title} ${track.title || ""}`,
          ),
          artist: indexField(track.artist),
          group: indexField(track.group),
          source: indexField(track.source),
          notes: indexField(track.summary),
          text: indexField(track.search_text),
        },
        lines: null,
      };
    });
  }

  // Lines worth quoting when a search matches lyrics, notes, or a prompt.
  function excerptLines(entry) {
    if (entry.lines) return entry.lines;
    const track = entry.track;
    const skip = new Set(
      [track.title, track.artist, track.source, track.created_at].map((value) =>
        String(value || "").trim(),
      ),
    );
    const notes = new Set(
      String(track.summary || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const seen = new Set();
    const lines = [];
    const sources = [track.summary, track.search_text];
    for (const source of sources) {
      for (const raw of String(source || "").split(/\r?\n/)) {
        const line = raw.trim();
        if (
          !line ||
          seen.has(line) ||
          skip.has(line) ||
          META_LINE.test(line) ||
          SECTION_LINE.test(line)
        )
          continue;
        seen.add(line);
        const commas = (line.match(/,/g) || []).length;
        const kind = notes.has(line)
          ? "Notes"
          : commas >= 2 && !/[.!?]["”]?$/.test(line)
            ? "Description"
            : "Lyrics";
        lines.push({ line, kind, field: indexField(line) });
      }
    }
    entry.lines = lines;
    return lines;
  }

  function bestExcerpt(entry, query, fuzzy) {
    let best = null;
    for (const item of excerptLines(entry)) {
      let count = 0;
      for (const term of query.terms) {
        if (matchTerm(term, item.field, fuzzy && term.length >= 4)) count += 1;
      }
      if (count && (!best || count > best.count)) best = { ...item, count };
      if (best?.count === query.terms.length) break;
    }
    return best;
  }

  // -------------------------------------------------------------- URL state

  function paramsFromURL() {
    const params = new URLSearchParams(window.location.search);
    const value = (key) => params.get(key) || "";
    return {
      present: ["q", "filter", "sort", "view", "group", "artist"].some((key) =>
        params.has(key),
      ),
      query: value("q").slice(0, 160),
      filter: FILTER_KEYS.includes(value("filter")) ? value("filter") : "all",
      sort: SORT_VALUES.includes(value("sort"))
        ? value("sort")
        : params.size
          ? "match"
          : storedSort(),
      view: VIEW_VALUES.includes(value("view")) ? value("view") : "",
      group: value("group").slice(0, 120),
      artist: value("artist").slice(0, 160),
    };
  }

  function adoptParams(params) {
    state.query = params.query;
    state.filter = params.filter;
    state.sort = params.sort;
    if (params.view) state.view = params.view;
    state.group = params.group;
    state.artist = params.artist;
    state.limit = PAGE_SIZE;
  }

  function stateURL() {
    const url = new URL(window.location.href);
    const put = (key, value, fallback) => {
      if (value && value !== fallback) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    };
    put("q", state.query.trim(), "");
    put("filter", state.filter, "all");
    put("sort", state.sort, "match");
    put("view", state.view, defaultView);
    put("group", state.group, "");
    put("artist", state.artist, "");
    return url;
  }

  // Drill-downs (a collection, See all, or a filter) are
  // history entries, so Back steps out one level at a time; `focus` names
  // the control to return focus to. Typing in search only replaces the
  // entry. This avoids duplicate browsing entries after a search is cleared.
  function writeURL({ push = false, focus = "" } = {}) {
    window.clearTimeout(state.urlTimer);
    state.urlPending = null;
    if (!onLibrary()) return;
    const url = stateURL();
    if (push) url.hash = "";
    if (url.href === window.location.href) return;
    if (push && router) router.push(url, { focus });
    else if (router) router.replace(url);
    else window.history.replaceState(window.history.state, "", url);
  }

  function scheduleURL() {
    window.clearTimeout(state.urlTimer);
    state.urlPending = { focus: "#librarySearch" };
    state.urlTimer = window.setTimeout(() => {
      const pending = state.urlPending;
      state.urlPending = null;
      writeURL(pending || {});
    }, 350);
  }

  // Leaving Library with a search still settling writes it first, so Back
  // returns to what was typed, not to the search before it.
  function flushURL() {
    if (!state.urlPending) return;
    const pending = state.urlPending;
    state.urlPending = null;
    window.clearTimeout(state.urlTimer);
    writeURL(pending);
  }

  // -------------------------------------------------------------- controls

  function narrowed() {
    return (
      Boolean(state.parsed.terms.length) ||
      state.filter !== "all" ||
      Boolean(state.group) ||
      Boolean(state.artist)
    );
  }

  const searching = () => Boolean(state.parsed.terms.length);

  // The order in effect. "match", the order Library starts with, is Best
  // match while searching and Newest added first otherwise; any other order
  // is the listener's own choice and applies either way.
  function activeSort() {
    return state.sort === "match" && !searching() ? "newest" : state.sort;
  }

  function syncControls() {
    if (els.search.value !== state.query) els.search.value = state.query;
    // Best match means nothing without search words, so it is offered only
    // while searching, and the control names the order the list is in.
    const match = els.sort.querySelector('option[value="match"]');
    match.hidden = !searching();
    match.disabled = !searching();
    const sort = activeSort();
    if (els.sort.value !== sort) els.sort.value = sort;
    // "All" is pressed only when nothing narrows the list, group included.
    els.filters.forEach((chip) => {
      const key = chip.dataset.libraryFilter;
      const pressed =
        key === "all"
          ? state.filter === "all" && !state.group && !state.artist
          : key === state.filter;
      chip.setAttribute("aria-pressed", String(pressed));
    });
    els.views.forEach((control) => {
      control.setAttribute(
        "aria-pressed",
        String(control.dataset.libraryView === state.view),
      );
    });
    renderGroupFilter();
    // Saving every song would only repeat the All songs station.
    els.saveFilter.hidden =
      state.status !== "ready" || !narrowed() || Boolean(state.artist);
  }

  function syncSaveFilter() {
    if (state.status === "ready" && !state.results.length)
      els.saveFilter.hidden = true;
  }

  function renderGroupFilter() {
    if (!state.group && !state.artist) {
      els.groupFilter.replaceChildren();
      els.groupFilter.hidden = true;
      return;
    }
    // The active collection is always a visible chip; pressing it removes it.
    const chip = button("", "filter-chip library-group-chip", () => {
      state.artist = "";
      setGroup("", { focus: true });
    });
    const label = state.artist ? `Artist: ${state.artist}` : state.group;
    chip.dataset.active = "true";
    chip.setAttribute("aria-label", `Remove filter: ${label}`);
    chip.title = `Remove filter: ${label}`;
    chip.append(element("span", "", label), icon("close"));
    els.groupFilter.replaceChildren(chip);
    els.groupFilter.hidden = false;
  }

  function setGroup(group, { focus = true, from = "" } = {}) {
    state.group = group;
    state.artist = "";
    state.limit = PAGE_SIZE;
    refresh({ announce: true });
    writeURL({ push: true, focus: from });
    revealResults({ focus });
  }

  // After the list changes, bring its heading into view just below the
  // sticky search bar. Focus moves there when the control that made the
  // change is no longer where the listener is looking.
  function revealResults({ focus = false } = {}) {
    if (!onLibrary()) return;
    const stickyTop = number(
      Number.parseFloat(
        els.page.style.getPropertyValue("--library-sticky-top"),
      ),
    );
    const offset = stickyTop + (els.toolbar?.offsetHeight || 0) + 12;
    // The list starts at its filter chips, so the active filter and its
    // remove control stay in view above the shelves or results.
    const anchor = els.page.querySelector(".library-filters") || els.heading;
    const top = anchor.getBoundingClientRect().top;
    const bottom = window.innerHeight - playerOffset() - 96;
    if (top < offset || top > bottom) {
      window.scrollTo({
        top: Math.max(0, window.scrollY + top - offset),
        behavior: calm.matches ? "auto" : "smooth",
      });
    }
    if (focus) els.heading.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------- results

  function computeResults() {
    const newest =
      state.filter === "recent"
        ? state.entries.reduce(
            (latest, entry) => Math.max(latest, entry.date),
            0,
          )
        : 0;
    const pool = state.entries.filter((entry) => {
      const track = entry.track;
      if (state.group && entry.group !== state.group) return false;
      if (state.artist && fold(track.artist) !== fold(state.artist))
        return false;
      if (state.filter === "liked") return Boolean(track.liked);
      if (state.filter === "mine") return likedHere(track);
      if (state.filter === "covers") return Boolean(track.has_cover);
      if (state.filter === "recent")
        return newest > 0 && entry.date >= newest - RECENT_WINDOW;
      return true;
    });
    state.parsed = parseQuery(state.query);
    const { fuzzy, results } = searchEntries(pool, state.parsed);
    state.fuzzy = fuzzy;
    const collator = new Intl.Collator(undefined, {
      sensitivity: "base",
      numeric: true,
    });
    const byPosition = (a, b) => a.entry.position - b.entry.position;
    // Songs without a date keep their archive place, after the dated ones.
    const oldest = (a, b) =>
      (a.entry.date || Infinity) - (b.entry.date || Infinity) ||
      byPosition(a, b);
    const sorters = {
      match: (a, b) => b.score - a.score || byPosition(a, b),
      newest: (a, b) => b.entry.date - a.entry.date || byPosition(a, b),
      archive: oldest,
      title: (a, b) =>
        collator.compare(a.entry.title, b.entry.title) || byPosition(a, b),
      duration: (a, b) =>
        number(b.entry.track.duration) - number(a.entry.track.duration) ||
        byPosition(a, b),
      played: (a, b) =>
        number(b.entry.track.play_count) - number(a.entry.track.play_count) ||
        byPosition(a, b),
    };
    results.sort(sorters[activeSort()] || byPosition);
    state.results = results;
  }

  function headingText() {
    const base = state.artist
      ? `Songs by ${state.artist}`
      : state.group
        ? state.filter === "all"
          ? state.group
          : `${FILTER_LABELS[state.filter]} in ${state.group}`
        : FILTER_LABELS[state.filter];
    return state.parsed.terms.length
      ? `Results for ${quote(state.parsed.raw)}`
      : base;
  }

  function countText() {
    const total = state.results.length;
    if (state.fuzzy) return plural(total, "close match", "close matches");
    return plural(total, "song");
  }

  function refresh({ announce: speak = false } = {}) {
    window.clearTimeout(state.renderTimer);
    state.parsed = parseQuery(state.query);
    syncControls();
    renderQueueNote();
    if (!onLibrary()) return;
    if (state.status === "loading") {
      renderLoading();
      return;
    }
    if (state.status === "error") {
      renderError(state.error);
      return;
    }
    computeResults();
    renderResults();
    if (speak) scheduleAnnouncement();
  }

  function scheduleRefresh() {
    window.clearTimeout(state.renderTimer);
    state.renderTimer = window.setTimeout(
      () => refresh({ announce: true }),
      140,
    );
  }

  // The message is built from the results just rendered for this query, and
  // a newer keystroke cancels it, so a count is never paired with the wrong
  // words.
  function scheduleAnnouncement() {
    window.clearTimeout(state.announceTimer);
    const query = state.query;
    const message = state.parsed.terms.length
      ? state.results.length
        ? `${countText()} for ${quote(state.parsed.raw)}.`
        : `No songs match ${quote(state.parsed.raw)}.`
      : `${headingText()}: ${countText()}.`;
    state.announceTimer = window.setTimeout(() => {
      if (state.query !== query) return;
      if (message === state.lastAnnouncement) return;
      state.lastAnnouncement = message;
      announce(message);
    }, 900);
  }

  function captureFocus() {
    const active = document.activeElement;
    if (!active || !els.tracks.contains(active)) return null;
    const card = active.closest("[data-track-id]");
    if (card && active.dataset.control)
      return { trackId: card.dataset.trackId, control: active.dataset.control };
    if (active.classList.contains("library-load-more")) return { more: true };
    return { other: true };
  }

  function restoreFocus(saved) {
    if (!saved) return;
    let target = null;
    if (saved.trackId) {
      target = els.tracks.querySelector(
        `[data-track-id="${CSS.escape(saved.trackId)}"] [data-control="${saved.control}"]`,
      );
    } else if (saved.more) {
      target = els.tracks.querySelector(".library-load-more");
    }
    (target || els.heading).focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ shelves
  // Browsing without a search or filter gets structure: what's new, what's
  // liked, and each collection. Each shelf is one tab stop; arrow keys move
  // along it.

  // Shelves and search results use the same song card and actions.
  function songShelfItem(entry, index, { likedBadge = true } = {}) {
    const item = element("li", "shelf-item");
    const card = createCard(
      { entry, fields: [], hidden: false },
      `shelf-${entry.track.id}`,
      { shelf: true, likedBadge },
    );
    card.querySelectorAll("button, a, [tabindex]").forEach((node) => {
      node.tabIndex = -1;
    });
    const preview = card.querySelector('[data-control="preview"]');
    preview.tabIndex = index === 0 ? 0 : -1;
    preview.setAttribute("aria-describedby", "shelfKeyboardHint");
    item.append(card);
    return item;
  }

  // Collections are compact chips: a small cover, the name, and a count.
  function groupShelfItem([group, entries], index) {
    const cover = entries.find((entry) => entry.track.has_cover) || entries[0];
    const item = element("li", "shelf-item");
    const control = button("", "shelf-card is-collection", () =>
      setGroup(group, {
        focus: true,
        from: `#libraryShelves [data-group="${CSS.escape(group)}"]`,
      }),
    );
    control.tabIndex = index === 0 ? 0 : -1;
    control.dataset.group = group;
    control.append(
      createArtwork(cover.track, "shelf-card-art"),
      element("span", "sr-only shelf-card-verb", "Show collection "),
      element("span", "shelf-card-title", group),
      element(
        "span",
        "shelf-card-meta tabular",
        plural(entries.length, "song"),
      ),
    );
    item.append(control);
    return item;
  }

  const CHEVRONS = {
    previous:
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6"></path></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6"></path></svg>',
  };

  // A shelf scrolls sideways. On pointer devices it has previous and next
  // buttons, and an edge fades where more is hidden; keyboards use the
  // arrow keys inside the row.
  function syncShelfEdges(row) {
    const max = row.scrollWidth - row.clientWidth;
    const start = row.scrollLeft > 2;
    const end = row.scrollLeft < max - 2;
    row.dataset.start = String(start);
    row.dataset.end = String(end);
    const section = row.closest(".shelf");
    const [previous, next] = section?.querySelectorAll(".shelf-step") || [];
    if (previous) previous.disabled = !start;
    if (next) next.disabled = !end;
  }

  function shelf(id, title, items, seeAll = null) {
    const section = element("section", `shelf is-${id}`);
    const headingId = `shelf-${id}`;
    section.setAttribute("aria-labelledby", headingId);
    const head = element("div", "shelf-head");
    const heading = element("h3", "shelf-title", title);
    heading.id = headingId;
    head.append(heading);
    const row = element("ul", "shelf-row");
    row.id = `shelf-row-${id}`;
    row.setAttribute("role", "list");
    row.setAttribute("aria-labelledby", headingId);
    row.append(...items);
    const tools = element("div", "shelf-tools");
    for (const direction of ["previous", "next"]) {
      const step = element("button", "icon-button shelf-step");
      step.type = "button";
      // A pointer convenience: the arrow keys already move along the row.
      step.tabIndex = -1;
      step.innerHTML = CHEVRONS[direction];
      step.setAttribute(
        "aria-label",
        `${direction === "previous" ? "Scroll back" : "Scroll forward"}: ${title}`,
      );
      step.setAttribute("aria-controls", row.id);
      step.addEventListener("click", () => {
        const distance = Math.max(160, row.clientWidth * 0.8);
        row.scrollBy({
          left: direction === "previous" ? -distance : distance,
          behavior: calm.matches ? "auto" : "smooth",
        });
      });
      tools.append(step);
    }
    if (seeAll) {
      const all = button("See all", "button-quiet shelf-see-all", seeAll);
      all.setAttribute("aria-label", `See all: ${title}`);
      all.dataset.shelf = id;
      tools.append(all);
    }
    head.append(tools);
    row.addEventListener("scroll", () => syncShelfEdges(row), {
      passive: true,
    });
    section.append(head, row);
    return section;
  }

  // Shelves stay in the page while a search or filter hides them, so their
  // sideways scroll is still where it was when Back returns to browsing.
  function renderShelves() {
    const show =
      state.status === "ready" && !narrowed() && state.view !== "list";
    els.shelves.hidden = !show;
    els.jumpAll.hidden = !show;
    els.shelves.classList.remove("is-loading");
    if (!show) return;
    const liked = state.entries.filter((entry) => entry.track.liked);
    const key = `${state.catalogKey}|${liked.map((entry) => entry.track.id)}`;
    if (els.shelves.dataset.key === key) {
      window.requestAnimationFrame(() =>
        els.shelves.querySelectorAll(".shelf-row").forEach(syncShelfEdges),
      );
      return;
    }
    els.shelves.dataset.key = key;
    const focused = els.shelves.contains(document.activeElement)
      ? document.activeElement
      : null;
    const focusTrack = focused?.closest("[data-track-id]")?.dataset.trackId;
    const focusKey = focusTrack || focused?.dataset.group || "";
    const groups = new Map();
    for (const entry of state.entries) {
      if (!entry.group) continue;
      if (!groups.has(entry.group)) groups.set(entry.group, []);
      groups.get(entry.group).push(entry);
    }
    const shelves = [];
    if (liked.length)
      shelves.push(
        shelf(
          "liked",
          "Liked by listeners",
          liked
            .slice(0, SHELF_SIZE)
            .map((entry, index) =>
              songShelfItem(entry, index, { likedBadge: false }),
            ),
          () => {
            state.filter = "liked";
            state.limit = PAGE_SIZE;
            refresh({ announce: true });
            writeURL({ push: true, focus: '[data-shelf="liked"]' });
            revealResults({ focus: true });
          },
        ),
      );
    if (groups.size > 1)
      shelves.push(
        shelf("collections", "Collections", [...groups].map(groupShelfItem)),
      );
    els.shelves.replaceChildren(...shelves);
    window.requestAnimationFrame(() =>
      els.shelves.querySelectorAll(".shelf-row").forEach(syncShelfEdges),
    );
    if (focusKey) {
      const selector = focusTrack
        ? `[data-track-id="${CSS.escape(focusKey)}"]`
        : `[data-group="${CSS.escape(focusKey)}"]`;
      const card = els.shelves.querySelector(selector);
      const target = card?.querySelector('[data-control="preview"]') || card;
      if (target) {
        for (const stop of target
          .closest(".shelf-row")
          .querySelectorAll('[tabindex="0"]'))
          stop.tabIndex = -1;
        target.tabIndex = 0;
        target.focus({ preventScroll: true });
      }
    }
  }

  // A shelf has one tab stop. Arrow keys select songs; ArrowDown opens actions.
  els.shelves.addEventListener("keydown", (event) => {
    const stop = event.target.closest?.(
      ".shelf-card, .track-card-preview, .track-card-more",
    );
    if (!stop) return;
    const items = [
      ...stop.closest(".shelf-row").querySelectorAll(".shelf-item"),
    ];
    const index = items.indexOf(stop.closest(".shelf-item"));
    if (event.key === "ArrowDown" || (event.shiftKey && event.key === "F10")) {
      const more = items[index].querySelector(".track-card-more");
      if (more) {
        event.preventDefault();
        more.click();
      }
      return;
    }
    let next = -1;
    if (event.key === "ArrowRight")
      next = Math.min(items.length - 1, index + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    if (next < 0) return;
    event.preventDefault();
    items.forEach((item, position) => {
      item
        .querySelectorAll(".shelf-card, .track-card-preview, .track-card-more")
        .forEach((node) => {
          node.tabIndex =
            position === next && !node.classList.contains("track-card-more")
              ? 0
              : -1;
        });
    });
    const target = items[next].querySelector(
      ".shelf-card, .track-card-preview",
    );
    target.focus();
    target.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  // Long titles clamp to two lines; a clamped title opens in place by touch,
  // click, or keyboard.
  function markClampedTitles() {
    window.cancelAnimationFrame(state.clampFrame);
    state.clampFrame = window.requestAnimationFrame(() => {
      els.tracks.querySelectorAll(".track-card-title").forEach((title) => {
        if (title.classList.contains("is-expanded")) return;
        const clamped = title.scrollHeight > title.clientHeight + 1;
        title.classList.toggle("is-clampable", clamped);
        if (clamped) {
          title.tabIndex = 0;
          title.setAttribute("role", "button");
          title.setAttribute("aria-expanded", "false");
        } else {
          title.removeAttribute("tabindex");
          title.removeAttribute("role");
          title.removeAttribute("aria-expanded");
        }
      });
    });
  }

  function toggleTitle(title) {
    const expanded = !title.classList.contains("is-expanded");
    title.classList.toggle("is-expanded", expanded);
    title.setAttribute("aria-expanded", String(expanded));
  }

  els.tracks.addEventListener("click", (event) => {
    const title = event.target.closest?.(".track-card-title.is-clampable");
    if (title) toggleTitle(title);
  });
  els.tracks.addEventListener("keydown", (event) => {
    const title = event.target.closest?.(".track-card-title.is-clampable");
    if (!title || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    toggleTitle(title);
  });

  function renderResults() {
    animateLayout(
      [els.tracks, els.page.querySelector(".library-results-head")],
      () => {
        closeMenu(false);
        renderShelves();
        const saved = captureFocus();
        els.tracks.className =
          state.view === "list" ? "track-grid is-list" : "track-grid";
        els.tracks.setAttribute("aria-busy", "false");
        els.heading.textContent = headingText();
        els.count.textContent = `${countText()} · ${els.sort.selectedOptions[0].textContent}`;
        // With no results, the empty state says so; no "0 songs · Best match".
        els.count.hidden = !state.results.length;
        els.jumpAllLabel.textContent = FILTER_LABELS.all;
        const fragment = document.createDocumentFragment();
        if (!state.results.length) {
          fragment.append(emptyState());
        } else {
          state.results.slice(0, state.limit).forEach((result, index) => {
            fragment.append(createCard(result, index));
          });
          const remaining = state.results.length - state.limit;
          if (remaining > 0) fragment.append(loadMoreButton(remaining));
        }
        els.tracks.replaceChildren(fragment);
        syncSaveFilter();
        syncPlayback();
        restoreFocus(saved);
        markClampedTitles();
        syncConnectivity();
      },
    );
  }

  function loadMoreButton(remaining) {
    const more = button(
      `Show ${plural(Math.min(PAGE_SIZE, remaining), "more song", "more songs")}`,
      "button library-load-more",
      () => {
        const firstNew = state.limit;
        state.limit += PAGE_SIZE;
        renderResults();
        els.tracks
          .querySelectorAll('[data-control="preview"]')
          [firstNew]?.focus();
      },
    );
    return more;
  }

  function stateBox(kind, title, text, actions = []) {
    const box = element(
      "div",
      kind === "error" ? "error-state" : "empty-state",
    );
    box.classList.add("library-state");
    box.append(element("strong", "", title), element("p", "", text));
    if (actions.length) {
      const row = element("div", "state-actions");
      row.append(...actions);
      box.append(row);
    }
    return box;
  }

  function emptyState() {
    const scoped =
      state.filter !== "all" || Boolean(state.group) || Boolean(state.artist);
    const showAll = button("Show every song", "button", () => {
      state.filter = "all";
      state.group = "";
      state.artist = "";
      state.limit = PAGE_SIZE;
      refresh({ announce: true });
      writeURL({ push: true });
      revealResults({ focus: true });
    });
    if (state.parsed.terms.length) {
      const clear = button("Clear search", "button is-primary", () => {
        state.query = "";
        state.limit = PAGE_SIZE;
        refresh({ announce: true });
        writeURL({ push: true });
        els.search.focus();
      });
      return stateBox(
        "empty",
        `No songs match ${quote(state.parsed.raw)}`,
        scoped
          ? "Nothing matches with the current filter. Show every song to search the whole library."
          : "Check the spelling or try fewer words. Search covers titles, artists, lyrics, and song descriptions.",
        scoped ? [clear, showAll] : [clear],
      );
    }
    if (state.filter === "liked") {
      return stateBox(
        "empty",
        "No liked songs yet",
        "Like songs while they play on Radio, and they’ll collect here.",
        [showAll],
      );
    }
    if (state.filter === "mine") {
      return stateBox(
        "empty",
        "You haven’t liked any songs here yet",
        "Songs you like on Radio or in the player collect here. Likes are kept in this browser or app.",
        [showAll],
      );
    }
    return stateBox(
      "empty",
      "Nothing here yet",
      "No songs fit this filter right now. Try another filter or show every song.",
      [showAll],
    );
  }

  // Placeholders have the geometry of what replaces them, shelves included,
  // so the page doesn't jump when songs arrive.
  function shelfSkeletons() {
    return ["liked", "collections"].map((kind) => {
      const section = element("div", `shelf is-${kind} is-skeleton`);
      section.setAttribute("aria-hidden", "true");
      const head = element("div", "shelf-head");
      head.append(element("span", "skeleton shelf-skeleton-title"));
      const row = element("div", "shelf-row");
      for (let index = 0; index < 6; index++) {
        const item = element("div", "shelf-item");
        if (kind === "liked") item.append(skeletonCard(false));
        else {
          const card = element("div", "shelf-card is-collection");
          card.append(
            element("span", "shelf-card-art skeleton"),
            element("span", "skeleton shelf-skeleton-title"),
            element("span", "skeleton library-skeleton-line is-short"),
          );
          item.append(card);
        }
        row.append(item);
      }
      section.append(head, row);
      return section;
    });
  }

  function skeletonCard(list) {
    const card = element(
      "div",
      list ? "track-card is-list is-skeleton" : "track-card is-skeleton",
    );
    card.setAttribute("aria-hidden", "true");
    const art = element("span", "track-card-art skeleton");
    const body = element("div", "track-card-body");
    const title = element("p", "track-card-title");
    title.append(element("span", "skeleton library-skeleton-line"));
    const meta = element("p", "track-card-meta");
    meta.append(element("span", "skeleton library-skeleton-line is-short"));
    body.append(title, meta);
    if (list) {
      const actions = element("div", "track-card-actions");
      actions.append(element("span", "skeleton track-card-skeleton-button"));
      card.append(art, body, element("span", "track-card-duration"), actions);
    } else {
      body.append(element("span", "track-card-group is-skeleton"));
      const actions = element("div", "track-card-actions");
      actions.append(element("span", "skeleton track-card-skeleton-button"));
      body.append(actions);
      card.append(art, body);
    }
    return card;
  }

  function renderLoading() {
    closeMenu(false);
    const browsing = !narrowed() && state.view !== "list";
    els.shelves.hidden = !browsing;
    els.jumpAll.hidden = !browsing;
    if (browsing && !els.shelves.dataset.key) {
      els.shelves.classList.add("is-loading");
      els.shelves.replaceChildren(...shelfSkeletons());
    }
    const list = state.view === "list";
    els.tracks.className = list ? "track-grid is-list" : "track-grid";
    els.tracks.setAttribute("aria-busy", "true");
    els.heading.textContent = headingText();
    els.count.textContent = "Loading songs…";
    els.count.hidden = false;
    els.tracks.replaceChildren(
      ...Array.from({ length: 8 }, () => skeletonCard(list)),
    );
  }

  function renderError(error) {
    closeMenu(false);
    els.shelves.hidden = true;
    els.jumpAll.hidden = true;
    if (!els.shelves.dataset.key) els.shelves.replaceChildren();
    els.tracks.className = "track-grid";
    els.tracks.setAttribute("aria-busy", "false");
    els.heading.textContent = headingText();
    els.count.textContent = "";
    const retry = button("Try again", "button is-primary", async () => {
      retry.disabled = true;
      state.status = "loading";
      refresh();
      if (state.stationsFailed) retryStations();
      const loaded = await loadLibrary(true);
      if (loaded) {
        await window.ZakRecoverShell?.();
        els.heading.focus({ preventScroll: true });
      } else {
        els.tracks.querySelector(".error-state button")?.focus();
      }
    });
    // The same heading, diagnosis, and next step as Radio and Reader; the
    // sentence under it says what didn't happen.
    const box = problemState({
      error,
      text: `The song list didn’t load. ${problemCopy(error).text}`,
      actions: [retry],
    });
    box.classList.add("library-state");
    box.setAttribute("role", "alert");
    els.tracks.replaceChildren(box);
  }

  // -------------------------------------------------------------- cards

  function createArtwork(track, className) {
    const art = element("div", className);
    if (track.has_cover) {
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.className = "track-cover";
      window.ZakImage(image, window.ZakMediaURL.cover(track), () =>
        image.replaceWith(window.ZakArtworkFallback(track)),
      );
      art.append(image);
    } else {
      art.append(window.ZakArtworkFallback(track));
    }
    return art;
  }

  // A card says which field a search matched when it isn't the title:
  // "Collection: Night Drive", highlighted.
  function matchedLabel(result, field, text) {
    if (!state.parsed.terms.length || !result.fields?.includes(field))
      return null;
    const line = element("p", "track-card-excerpt track-card-match");
    line.append(
      element("span", "track-card-excerpt-label", FIELD_LABELS[field]),
    );
    const words = element("span", "track-card-excerpt-text");
    appendHighlighted(words, text, state.parsed.terms, state.fuzzy);
    line.append(words);
    return line;
  }

  function createCard(
    result,
    index,
    {
      shelf = false,
      likedBadge = state.filter !== "liked" && state.filter !== "mine",
    } = {},
  ) {
    const { entry } = result;
    const track = entry.track;
    const title = entry.title;
    const list = state.view === "list";
    const terms = state.parsed.terms;
    const card = element("article", list ? "track-card is-list" : "track-card");
    card.dataset.trackId = track.id;
    card.dataset.title = title;
    const titleId = `library-track-${index}`;
    card.setAttribute("aria-labelledby", titleId);

    // Grid cards and shelves share the artwork overlay; List keeps its controls in a row.
    const art = createArtwork(track, "track-card-art");

    const body = element("div", "track-card-body");
    const heading = element("p", "track-card-title");
    heading.id = titleId;
    heading.title = title;
    if (
      !terms.length ||
      !appendHighlighted(heading, title, terms, state.fuzzy)
    ) {
      heading.replaceChildren(title);
    }
    // Liked is a small heart, a mark rather than a control: on the artwork
    // in the grid, at the end of the row in the list, so the artist name
    // keeps its room. Where every song is liked (the Liked by listeners
    // shelf and filter, and Your likes) it would say nothing. Screen
    // readers hear it after the title, as the card's description; hidden
    // text inside the title would join the card's name with a stray space
    // before its comma.
    let likedNote = null;
    if (track.liked && likedBadge) {
      const badge = element("span", "track-card-liked-badge");
      badge.setAttribute("aria-hidden", "true");
      badge.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"></path></svg>';
      art.append(badge);
      likedNote = element("span", "sr-only", "Liked by listeners");
      likedNote.id = `${titleId}-liked`;
      card.setAttribute("aria-describedby", likedNote.id);
    }
    const meta = element("p", "track-card-meta tabular");
    const artistName = track.artist || "Zak";
    const artist = element("span", "track-card-artist");
    if (
      !terms.length ||
      !result.fields?.includes("artist") ||
      !appendHighlighted(artist, artistName, terms, state.fuzzy)
    )
      artist.replaceChildren(artistName);
    const groupMatched = Boolean(
      entry.group && terms.length && result.fields?.includes("group"),
    );
    if (list && entry.group && !groupMatched && state.group !== entry.group)
      artist.append(` · ${entry.group}`);
    const duration = element("span", "track-card-duration tabular");
    duration.textContent = timeLabel(track.duration);
    meta.append(artist);
    if (!list) meta.append(element("span", "track-card-sep", "·"), duration);

    body.append(heading);
    if (likedNote) body.append(likedNote);
    body.append(meta);

    // A match on the collection is said and shown, not left unexplained.
    if (groupMatched) body.append(matchedLabel(result, "group", entry.group));
    else if (!list && entry.group && state.group !== entry.group) {
      const group = shelf
        ? element("span", "track-card-collection", entry.group)
        : button(entry.group, "track-card-group", () => {
            setGroup(entry.group, {
              focus: true,
              from: `[data-track-id="${CSS.escape(track.id)}"] [data-control="group"]`,
            });
          });
      if (!shelf) {
        group.dataset.control = "group";
        group.setAttribute(
          "aria-label",
          `${entry.group}, show this collection`,
        );
      }
      body.append(group);
    }
    if (track.source && terms.length && result.fields?.includes("source"))
      body.append(matchedLabel(result, "source", track.source));

    if (terms.length && result.hidden) {
      const excerpt = bestExcerpt(entry, state.parsed, state.fuzzy);
      if (excerpt) {
        const quoteLine = element("p", "track-card-excerpt");
        quoteLine.append(
          element("span", "track-card-excerpt-label", excerpt.kind),
        );
        const words = element("span", "track-card-excerpt-text");
        appendHighlighted(
          words,
          excerpt.line,
          terms,
          state.fuzzy,
          list ? 56 : 48,
        );
        quoteLine.append(words);
        body.append(quoteLine);
      }
    }

    const preview = element(
      "button",
      list
        ? "icon-button track-card-preview"
        : "icon-button track-card-preview track-card-play",
    );
    preview.type = "button";
    preview.dataset.control = "preview";
    preview.setAttribute("aria-label", `Preview ${title}`);
    preview.append(icon("play"), icon("pause"));

    preview.addEventListener("click", () => togglePreview(track));

    const more = element("button", "icon-button track-card-more");
    more.type = "button";
    more.dataset.control = "more";
    more.setAttribute("aria-label", `More actions for ${title}`);
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-controls", els.menu.id);
    more.append(icon("more"));
    more.addEventListener("click", () => openMenu(track, more));

    const actions = element("div", "track-card-actions");
    if (list) {
      card.append(art, body, duration, actions);
      actions.append(preview, more);
    } else {
      art.append(preview);
      card.append(art, body, more);
    }
    return card;
  }

  // -------------------------------------------------------------- preview

  function claimCurrentPreview() {
    if (!state.current) return false;
    if (!window.ZakAudio.is("library")) {
      window.ZakAudio.claim(
        "library",
        window.ZakMediaURL.audio(state.current),
        displayTitle(state.current),
      );
    }
    return true;
  }

  async function togglePreview(track) {
    const source = window.ZakMediaURL.audio(track);
    if (
      state.current?.id === track.id &&
      window.ZakAudio.is("library") &&
      els.audio.currentSrc.endsWith(source)
    ) {
      if (els.audio.paused) await window.ZakAudio.play();
      else window.ZakAudio.pause();
      syncPlayback();
      return;
    }
    if (stationInfo()?.connected === false) {
      notify("Previews return when Zak Radio reconnects.");
      return;
    }
    // Previews are private, so taking the audio from live radio says so and
    // offers the way back.
    const interrupting = window.ZakAudio.is("radio") && !els.audio.paused;
    state.current = track;
    window.ZakAudio.claim("library", source, displayTitle(track));
    if (interrupting) {
      state.radioInterrupted = true;
      notify("Radio paused here while you preview. Others keep listening.", {
        action: { label: "Listen live", run: backToLive },
      });
    }
    els.audio.currentTime = 0;
    syncPlayback();
    await window.ZakAudio.play();
    syncPlayback();
  }

  function backToLive() {
    state.radioInterrupted = false;
    return window.ZakAudio.returnLive();
  }

  function syncPlayback() {
    syncConnectivity();
    const owns = window.ZakAudio.is("library");
    const playing = Boolean(owns && state.current && !els.audio.paused);
    els.page.querySelectorAll(".track-card[data-track-id]").forEach((card) => {
      const active = owns && card.dataset.trackId === state.current?.id;
      const sounding = active && playing;
      card.classList.toggle("is-current", active);
      card.classList.toggle("is-playing", sounding);
      const preview = card.querySelector('[data-control="preview"]');
      if (!preview) return;
      const label = `${sounding ? "Pause" : "Preview"} ${card.dataset.title}`;
      if (preview.getAttribute("aria-label") !== label)
        preview.setAttribute("aria-label", label);
      const text = preview.querySelector(".track-card-preview-label");
      if (text) text.textContent = sounding ? "Pause" : "Preview";
    });
    document.querySelectorAll("[data-preview-track]").forEach((preview) => {
      const sounding =
        playing && preview.dataset.previewTrack === state.current?.id;
      const track = trackById(preview.dataset.previewTrack);
      preview.replaceChildren(icon(sounding ? "pause" : "play"));
      preview.setAttribute(
        "aria-label",
        `${sounding ? "Pause" : "Preview"} ${displayTitle(track)}`,
      );
      preview.setAttribute("aria-pressed", String(sounding));
    });
    window.ZakPlayer?.update?.();
  }

  const playerAdapter = {
    describe() {
      const track = state.current;
      if (!track) return null;
      const owns = window.ZakAudio.is("library");
      const title = displayTitle(track);
      return {
        kind: "ondemand",
        source: "Preview",
        context: displayGroup(track),
        title,
        subtitle: [track.artist || "Zak", displayGroup(track)]
          .filter(Boolean)
          .join(" · "),
        reactions: window.ZakReactions?.view?.(track) || null,
        href: "/library",
        artwork: track.has_cover
          ? { src: window.ZakMediaURL.cover(track), seed: track.id }
          : { seed: track.id },
        playing: owns && !els.audio.paused,
        disabled: false,
        // The Listen live button says how to get back to Radio; no extra
        // subtitle repeats it.
        note: "",
        liveLabel: "Listen live",
        position: owns ? number(els.audio.currentTime) : 0,
        duration:
          (owns && number(els.audio.duration)) || number(track.duration),
        seekable: true,
        skip: true,
        rate: null,
        follow: null,
        download: {
          href: window.ZakMediaURL.audio(track),
          filename: `${title || track.id}.mp3`,
        },
      };
    },
    toggle() {
      if (!claimCurrentPreview()) return;
      if (els.audio.paused) window.ZakAudio.play();
      else window.ZakAudio.pause();
    },
    seekTo(seconds) {
      if (!claimCurrentPreview()) return;
      const duration =
        number(els.audio.duration) || number(state.current.duration);
      els.audio.currentTime = Math.max(
        0,
        Math.min(duration || Infinity, number(seconds)),
      );
      window.ZakPlayer?.update?.();
    },
    seekBy(delta) {
      if (!claimCurrentPreview()) return;
      this.seekTo(number(els.audio.currentTime) + number(delta));
    },
  };

  let playerRegistered = false;
  function registerPlayer() {
    if (playerRegistered || typeof window.ZakPlayer?.register !== "function")
      return;
    window.ZakPlayer.register("library", playerAdapter);
    playerRegistered = true;
  }

  // -------------------------------------------------------------- track menu

  function menuOpen() {
    return popoverSupported
      ? els.menu.matches(":popover-open")
      : els.menu.classList.contains("is-open");
  }

  let lastMenuClose = { trigger: null, at: 0 };

  function finishMenu(returnFocus) {
    const trigger = state.menuTrigger;
    state.menuTrigger = null;
    lastMenuClose = { trigger, at: performance.now() };
    trigger?.setAttribute("aria-expanded", "false");
    els.menu.classList.remove("is-open");
    if (els.menu.parentElement !== menuHome) menuHome.append(els.menu);
    if (returnFocus && trigger?.isConnected)
      trigger.focus({ preventScroll: true });
    if (state.refreshAfterMenu) {
      state.refreshAfterMenu = false;
      window.setTimeout(() => refresh(), 0);
    }
  }

  function closeMenu(returnFocus = false) {
    if (!state.menuTrigger && !menuOpen()) return;
    if (popoverSupported && menuOpen()) els.menu.hidePopover();
    finishMenu(returnFocus);
  }

  function playerOffset() {
    const value = getComputedStyle(document.documentElement).getPropertyValue(
      "--bottom-chrome",
    );
    return number(Number.parseFloat(value));
  }

  function positionMenu() {
    const trigger = state.menuTrigger;
    if (!trigger || !popoverSupported) return;
    if (window.matchMedia("(max-width: 639px)").matches) {
      els.menu.style.left = "0px";
      els.menu.style.top = "auto";
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const box = els.menu.getBoundingClientRect();
    const viewport = document.documentElement.clientWidth;
    const bottom = window.innerHeight - playerOffset() - 8;
    const left = Math.min(
      Math.max(8, rect.right - box.width),
      Math.max(8, viewport - box.width - 8),
    );
    let top = rect.bottom + 6;
    if (top + box.height > bottom && rect.top - box.height - 6 > 8) {
      top = rect.top - box.height - 6;
    }
    els.menu.style.left = `${Math.round(left + window.scrollX)}px`;
    els.menu.style.top = `${Math.round(top + window.scrollY)}px`;
  }

  function menuItem(label, onSelect, needsServer = false) {
    const item = button(label, "", () => {
      closeMenu(true);
      onSelect();
    });
    item.setAttribute("role", "menuitem");
    if (needsServer) item.dataset.needsServer = "";
    item.disabled = needsServer && stationInfo()?.connected === false;
    if (item.disabled) item.dataset.connectionDisabled = "false";
    return item;
  }

  function buildMenu(track, trigger) {
    const title = displayTitle(track);
    const group = displayGroup(track);
    const head = element("div", "library-menu-head");
    head.append(element("strong", "", title));
    const facts = [track.artist || "Zak", timeLabel(track.duration)];
    head.append(element("span", "tabular", facts.join(" · ")));
    const details = [
      group,
      dateLabel(track) && `Added ${dateLabel(track)}`,
      number(track.play_count) && plural(track.play_count, "play"),
      number(track.skip_count) &&
        `Skipped early ${plural(track.skip_count, "time")}`,
    ].filter(Boolean);
    if (details.length) head.append(element("span", "", details.join(" · ")));

    const items = [];
    if (track.artist) {
      items.push(
        menuItem(`More by ${track.artist}`, () => {
          state.query = "";
          state.artist = track.artist;
          state.parsed = parseQuery(state.query);
          state.group = "";
          state.filter = "all";
          state.limit = PAGE_SIZE;
          refresh({ announce: true });
          writeURL({ push: true, focus: "#librarySearch" });
          els.search.focus();
        }),
      );
    }
    const target = queueTarget();
    if (target) {
      items.push(
        menuItem("Play next", () => queueTrack(track, "play_next"), true),
        menuItem("Add to queue", () => queueTrack(track, "add_to_queue"), true),
      );
    }
    items.push(
      menuItem(
        "Add to station",
        () => window.ZakStations?.addTrack?.(track, trigger),
        true,
      ),
    );
    if (!target && stationInfo()) {
      items.push(
        menuItem(
          "Start a temporary station",
          () => startTemporary({ track, opener: trigger }),
          true,
        ),
      );
    }
    if (group && state.group !== group) {
      items.push(
        menuItem(`More from ${group}`, () => setGroup(group, { focus: true })),
      );
    }
    const download = element("a", "library-menu-download");
    download.href = window.ZakMediaURL.audio(track);
    download.download = `${title || track.id}.mp3`;
    download.append(element("span", "", "Download"));
    const size = sizeLabel(track.audio_bytes);
    if (size)
      download.append(element("span", "library-menu-size tabular", size));
    download.setAttribute("role", "menuitem");
    download.addEventListener("click", () => closeMenu(false));
    items.push(download);

    els.menu.setAttribute("aria-label", `Actions for ${title}`);
    els.menu.replaceChildren(head, ...items);
  }

  function openMenu(track, trigger) {
    showMenu(trigger, () => buildMenu(track, trigger));
  }

  function buildStationMenu(station, tile) {
    const head = element("div", "library-menu-head");
    head.append(element("strong", "", station.name));
    head.append(element("span", "", stationSummary(station)));
    const share = menuItem("Copy listen-only link", () =>
      copyTileLink(station, tile),
    );
    const remove = menuItem(
      "Delete station",
      () => requestDelete(station),
      true,
    );
    remove.classList.add("is-danger");
    remove.dataset.keepNotice = "";
    els.menu.setAttribute("aria-label", `Actions for ${station.name}`);
    els.menu.replaceChildren(head, share, remove);
  }

  function showMenu(trigger, build) {
    if (state.menuTrigger === trigger && menuOpen()) {
      closeMenu(true);
      return;
    }
    // Pressing the trigger of an open menu light-dismisses it first; that
    // press should close the menu, not reopen it.
    if (
      lastMenuClose.trigger === trigger &&
      performance.now() - lastMenuClose.at < 300
    )
      return;
    closeMenu(false);
    build();
    state.menuTrigger = trigger;
    trigger.after(els.menu);
    trigger.setAttribute("aria-expanded", "true");
    if (popoverSupported) {
      els.menu.showPopover();
      positionMenu();
    } else {
      els.menu.classList.add("is-open");
    }
    els.menu.querySelector("button, a")?.focus({ preventScroll: true });
  }

  els.menu.addEventListener("toggle", (event) => {
    if (event.newState !== "closed" || !state.menuTrigger) return;
    const inside =
      els.menu.contains(document.activeElement) ||
      document.activeElement === document.body;
    finishMenu(inside);
  });

  els.menu.addEventListener("keydown", (event) => {
    const items = [...els.menu.querySelectorAll("button, a")];
    const index = items.indexOf(document.activeElement);
    if (
      event.key === "Tab" &&
      ((event.shiftKey && index === 0) ||
        (!event.shiftKey && index === items.length - 1))
    ) {
      event.preventDefault();
      const trigger = state.menuTrigger;
      closeMenu(false);
      focusBeside(trigger, event.shiftKey, els.menu);
      return;
    }
    let next = -1;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp")
      next = (index - 1 + items.length) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Escape" && !popoverSupported) {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (next >= 0) {
      event.preventDefault();
      items[next].focus();
    }
  });

  els.menu.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (!next || els.menu.contains(next) || next === state.menuTrigger) return;
    closeMenu(false);
  });

  let menuWidth = window.innerWidth;
  window.addEventListener(
    "resize",
    () => {
      // Phones resize the height as the address bar moves; ignore that.
      if (window.innerWidth === menuWidth) return;
      menuWidth = window.innerWidth;
      closeMenu(false);
    },
    { passive: true },
  );

  // -------------------------------------------------------------- queue and temporary stations

  async function queueTrack(track, action) {
    const title = displayTitle(track);
    if (!queueTarget()) {
      notify("Start a temporary station to queue songs.");
      return;
    }
    // A failure explains itself in the shared words, with Try again.
    const result = await window.ZakStation.enqueue(action, track.id, {
      outcome: `${quote(title)} wasn’t queued`,
      retry: () => queueTrack(track, action),
    });
    if (result) {
      notify(
        action === "play_next"
          ? `${quote(title)} will play next.`
          : `Added ${quote(title)} to the queue.`,
      );
    }
    renderQueueNote();
  }

  async function startTemporary({ track = null, opener = null } = {}) {
    if (typeof window.ZakStation?.createTemporary !== "function") {
      return {
        ok: false,
        message:
          "Temporary stations aren’t available right now. Reload and try again.",
      };
    }
    const result = await window.ZakStation.createTemporary({
      trackId: track?.id,
    });
    if (result?.ok) {
      // The queue note above the songs explains Play next and Add to queue.
      notify(
        track
          ? `Your temporary station is playing ${quote(displayTitle(track))}.`
          : "Your temporary station is playing.",
        { action: { label: "Open Radio", run: openRadio } },
      );
      renderQueueNote();
      renderStations();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      return { ok: true };
    }
    const failure = {
      ...result,
      ok: false,
      message:
        result?.message || "Couldn’t start a temporary station. Try again.",
    };
    // A full house needs guidance next to the choice, so the chooser opens
    // with it even when the start came from a song's menu.
    if (!els.chooser.open && failure.reason === "capacity") {
      openChooser({ opener, track });
      void showChooserFailure(failure);
    } else if (!els.chooser.open) {
      notify(failure.message, { tone: "error" });
    }
    return failure;
  }

  function renderQueueNote() {
    const station = stationInfo();
    if (station?.kind !== "temporary") {
      els.queueNote.hidden = true;
      return;
    }
    els.queueNote.textContent = station.canControl
      ? `Play next and Add to queue go to your temporary station · ${plural(station.queue.length, "song")} queued.`
      : "You’re listening to someone else’s temporary station. Only the person who started it can queue songs.";
    els.queueNote.hidden = false;
  }

  // -------------------------------------------------------------- stations strip

  function stationsReady() {
    return (
      state.stationsReady || (window.ZakStations?.list?.() || []).length > 0
    );
  }

  function stationSummary(station) {
    const parts = [stationSelection(station)];
    if (station.source_type !== "list")
      parts.push(plural(station.eligible_count || 0, "song"));
    parts.push(
      station.random_mode === "true_random"
        ? "Shuffle with repeats"
        : "No repeats",
    );
    if (station.skip_disliked) parts.push("Skips disliked");
    return parts.join(" · ");
  }

  function tileFor(stationId) {
    return els.stationList.querySelector(
      `.station-tile[data-station-id="${CSS.escape(stationId)}"]`,
    );
  }

  function stationTile(station) {
    const id = station.station_id;
    const tile = element("li", "station-tile");
    tile.dataset.stationId = id;
    tile.tabIndex = -1;
    const nameId = `station-tile-${id}`;
    tile.setAttribute("aria-labelledby", nameId);
    const copy = element("div", "station-tile-copy");
    const head = element("p", "station-tile-head");
    const name = element("strong", "station-tile-name", station.name);
    name.id = nameId;
    head.append(name);
    if (stationInfo()?.stationId === id) {
      head.append(element("span", "badge is-accent", "On Radio"));
    }
    copy.append(
      head,
      element("p", "station-tile-meta", stationSummary(station)),
    );

    const actions = element("div", "station-tile-actions");
    const listen = element("a", "button is-primary", "Listen");
    listen.href = `/?station=${encodeURIComponent(id)}`;
    listen.setAttribute("aria-label", `Listen to ${station.name}`);
    listen.dataset.control = "listen";
    // Listen plays the station here; a paused one this browser made starts
    // in the same step, instead of opening Radio to wait for itself.
    listen.addEventListener("click", (event) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        typeof window.ZakStation?.open !== "function"
      )
        return;
      event.preventDefault();
      void window.ZakStation.open(id);
    });
    const edit = button("Edit", "button", () =>
      openEditor({ station, opener: edit }),
    );
    edit.dataset.control = "edit";
    edit.setAttribute("aria-label", `Edit ${station.name}`);
    // Listen and Edit stay in view; sharing and Delete wait in a menu, so
    // Delete never sits beside an everyday action. Opening the menu keeps
    // an earlier delete undoable, so several deletes stay one Undo.
    const more = element("button", "icon-button station-tile-more");
    more.type = "button";
    more.dataset.control = "more";
    more.dataset.keepNotice = "";
    more.setAttribute("aria-label", `More actions for ${station.name}`);
    more.setAttribute("aria-expanded", "false");
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-controls", els.menu.id);
    more.append(icon("more"));
    more.addEventListener("click", () =>
      showMenu(more, () => buildStationMenu(station, tile)),
    );
    actions.append(listen, edit, more);
    tile.append(copy, actions);

    const failure = state.deleteErrors.get(id);
    if (failure) {
      const error = element("div", "station-tile-error");
      error.setAttribute("role", "alert");
      error.append(element("p", "", `Couldn’t delete. ${failure}`));
      const retry = button("Try again", "button", () => {
        state.deleteErrors.delete(id);
        state.pendingDeletes.set(id, {
          station,
          height: tileFor(id)?.getBoundingClientRect().height || 0,
        });
        commitDelete(id);
        focusAfterRemoval(id);
      });
      retry.dataset.control = "retry";
      retry.setAttribute("aria-label", `Try deleting ${station.name} again`);
      error.append(retry);
      tile.append(error);
    }
    return tile;
  }

  function deletedTile(pending) {
    const id = pending.station.station_id;
    const tile = element("li", "station-tile is-deleted");
    tile.dataset.stationId = id;
    // A second tap where Delete was lands here; it keeps the deletes
    // undoable instead of counting as the next action.
    tile.dataset.keepNotice = "";
    tile.tabIndex = -1;
    if (pending.height)
      tile.style.minHeight = `${Math.round(pending.height)}px`;
    const text = element("p", "station-tile-deleted");
    text.append(
      element("span", "", pending.committing ? "Deleting " : "Deleted "),
      element("strong", "", quote(pending.station.name)),
      pending.committing ? "" : " · Undo stays until your next action.",
    );
    if (pending.committing) {
      tile.append(text);
      return tile;
    }
    // Undo sits at the start, away from where Delete was.
    const undo = button("Undo", "button", () => undoDelete(id));
    undo.dataset.control = "undo";
    undo.dataset.keepNotice = "";
    undo.setAttribute("aria-label", `Undo deleting ${pending.station.name}`);
    tile.append(undo, text);
    return tile;
  }

  // The same listen-only link and confirmation as Radio's station sheet.
  // Without clipboard access the link appears in the tile to copy by hand.
  async function copyTileLink(station, tile) {
    const result = await window.ZakStations.copyListenLink(station.station_id);
    tile.querySelector(".station-tile-link")?.remove();
    if (result.ok) return;
    const field = element("label", "field station-tile-link");
    field.append(
      element("span", "", "Listen-only link"),
      element(
        "span",
        "field-hint",
        "People with this link can listen but can’t change the station.",
      ),
    );
    const input = element("input", "text-input");
    input.type = "text";
    input.readOnly = true;
    input.value = result.url;
    field.append(input);
    tile.append(field);
    input.focus();
    input.select();
  }

  function temporaryTile(station) {
    const tile = element("li", "station-tile is-temporary");
    tile.dataset.stationId = station.stationId;
    tile.tabIndex = -1;
    const nameId = "station-tile-temporary";
    tile.setAttribute("aria-labelledby", nameId);
    const copy = element("div", "station-tile-copy");
    const head = element("p", "station-tile-head");
    const name = element(
      "strong",
      "station-tile-name",
      station.label || "Temporary station",
    );
    name.id = nameId;
    head.append(name, element("span", "badge is-accent", "On Radio"));
    copy.append(
      head,
      element(
        "p",
        "station-tile-meta",
        `${stationInfo()?.playing ? "Playing" : "Plays"} from All songs${station.queue.length ? ` · ${plural(station.queue.length, "song")} queued` : " · queue songs with Play next"} · Ends after 24 hours without use`,
      ),
    );
    const actions = element("div", "station-tile-actions");
    const open = button("Open Radio", "button", openRadio);
    open.dataset.control = "open";
    actions.append(open);
    tile.append(copy, actions);
    return tile;
  }

  // Station events arrive often; only rebuild the strip when what it shows
  // changes, and keep keyboard focus on the same control when it does.
  let stationsKey = "";
  function stationsSignature() {
    const temporary = queueTarget();
    return JSON.stringify([
      stationsReady(),
      state.stationsFailed,
      stationInfo()?.stationId || "",
      temporary
        ? [
            temporary.stationId,
            temporary.label,
            temporary.queue.length,
            stationInfo()?.playing,
          ]
        : null,
      [...state.pendingDeletes.keys()],
      [...state.deleteErrors.entries()],
      (window.ZakStations?.owned?.() || []).map((station) => [
        station.station_id,
        station.name,
        stationSummary(station),
      ]),
    ]);
  }

  function renderStations({ force = false } = {}) {
    const key = stationsSignature();
    if (!force && key === stationsKey) return;
    stationsKey = key;
    const active = document.activeElement;
    const focusedTile = els.stationList.contains(active)
      ? active.closest(".station-tile")?.dataset.stationId
      : "";
    const focusedControl = focusedTile ? active.dataset.control || "tile" : "";
    paintStations();
    syncConnectivity();
    if (focusedTile) {
      const tile = tileFor(focusedTile);
      const target =
        focusedControl === "tile"
          ? tile
          : tile?.querySelector(`[data-control="${focusedControl}"]`);
      (target || tile || els.newStation).focus({ preventScroll: true });
    }
  }

  function paintStations() {
    const list = els.stationList;
    list.setAttribute(
      "aria-busy",
      String(!stationsReady() && !state.stationsFailed),
    );
    if (!stationsReady()) {
      setStationsCount(null);
      if (state.stationsFailed) {
        const tile = element("li", "station-tile is-message is-error");
        const alert = element("div");
        alert.setAttribute("role", "alert");
        alert.append(
          element("strong", "", "Your stations didn’t load"),
          element("p", "", problemCopy(state.stationsError).text),
          button("Try again", "button", retryStations),
        );
        tile.append(alert);
        list.replaceChildren(tile);
      } else {
        list.replaceChildren(
          ...Array.from({ length: 2 }, () => {
            const tile = element("li", "station-tile is-skeleton");
            tile.setAttribute("aria-hidden", "true");
            tile.append(
              element("span", "skeleton library-skeleton-line is-short"),
              element("span", "skeleton library-skeleton-line"),
              element("span", "skeleton library-skeleton-line"),
            );
            return tile;
          }),
        );
      }
      return;
    }
    const stations = window.ZakStations?.owned?.() || [];
    const tiles = [];
    const temporary = queueTarget();
    if (temporary) tiles.push(temporaryTile(temporary));
    let count = tiles.length;
    stations.forEach((station) => {
      const pending = state.pendingDeletes.get(station.station_id);
      if (pending && !pending.committed) tiles.push(deletedTile(pending));
      else if (!pending) {
        tiles.push(stationTile(station));
        count += 1;
      }
    });
    setStationsCount(count, temporary ? 1 : 0);
    if (!tiles.length) {
      const empty = element("li", "station-tile is-message");
      empty.append(
        element("strong", "", "No stations yet"),
        element(
          "p",
          "",
          "Make one to keep songs you like playing on Radio: a temporary station, a hand-picked station, or a filter station.",
        ),
      );
      tiles.push(empty);
    }
    list.replaceChildren(...tiles);
  }

  // Phones show Your stations behind one compact button next to the
  // heading, so search and browsing come first.
  let stationsOpen = false;
  function setStationsOpen(open, { focus = false } = {}) {
    stationsOpen = open;
    els.stationsSection.classList.toggle("is-open", open);
    els.stationsToggle.setAttribute("aria-expanded", String(open));
    if (open && focus) {
      els.stationsSection.scrollIntoView({ block: "start" });
      els.newStation.focus({ preventScroll: true });
    }
  }

  // One clean name, set as the button's label so the accessibility tree
  // reads exactly "Your stations, 2 saved" (or "…, none yet") rather than
  // joining the visible pieces with stray spaces. It starts with the
  // visible words and count, so speech input finds it.
  function setStationsCount(count, temporary = 0) {
    els.stationsToggleCount.textContent = count ? String(count) : "";
    const saved = Math.max(0, (count || 0) - temporary);
    let label = "Your stations";
    if (count === 0) label = "Your stations, none yet";
    else if (count && !temporary) label = `Your stations, ${count} saved`;
    else if (count && !saved) label = `Your stations, ${count} temporary`;
    else if (count)
      label = `Your stations, ${count} (${saved} saved, ${temporary} temporary)`;
    els.stationsToggle.setAttribute("aria-label", label);
  }

  els.stationsToggle.addEventListener("click", () =>
    setStationsOpen(!stationsOpen, { focus: !stationsOpen }),
  );

  byId("libraryJumpStations").addEventListener("click", (event) => {
    event.preventDefault();
    setStationsOpen(true, { focus: true });
  });

  async function retryStations() {
    state.stationsFailed = false;
    renderStations();
    try {
      await window.ZakStations.reload();
      state.stationsReady = true;
    } catch (error) {
      state.stationsFailed = true;
      state.stationsError = error;
    }
    renderStations();
    if (!state.stationsFailed)
      els.stationsHeading.focus({ preventScroll: true });
  }

  function highlightTile(stationId) {
    const tile = tileFor(stationId);
    if (!tile) return false;
    setStationsOpen(true);
    tile.classList.add("is-highlighted");
    window.clearTimeout(state.highlightTimer);
    state.highlightTimer = window.setTimeout(
      () => tileFor(stationId)?.classList.remove("is-highlighted"),
      2400,
    );
    // Focus lands on what the listener most likely does next: Listen.
    return focusVisible(
      tile.querySelector('[data-control="listen"], [data-control="open"]') ||
        tile,
    );
  }

  function focusAfterRemoval(stationId, neighborId = "") {
    const neighbor = neighborId ? tileFor(neighborId) : null;
    if (neighbor && focusVisible(neighbor)) return;
    if (!tileFor(stationId)) focusVisible(els.newStation);
  }

  // A deleted station's inline Undo stays until the listener's next action,
  // like every Undo: a press anywhere outside the deletes (another Delete,
  // an inline Undo, or the menu that holds Delete keep them), leaving
  // Library, or hiding or closing the page. Only then does the delete reach
  // the server.
  function requestDelete(station) {
    const id = station.station_id;
    const height = tileFor(id)?.getBoundingClientRect().height || 0;
    state.deleteErrors.delete(id);
    state.pendingDeletes.set(id, { station, height });
    renderStations();
    tileFor(id)
      ?.querySelector('[data-control="undo"]')
      ?.focus({ preventScroll: true });
    announceDeletes();
  }

  function waitingDeletes() {
    return [...state.pendingDeletes.values()].filter(
      (pending) => !pending.committing,
    );
  }

  function announceDeletes() {
    announce(
      "Station deleted. Undo stays in its place until your next action.",
    );
  }

  // The press finishes first: committing repaints the station list, which
  // would otherwise replace the control that was pressed under its handler.
  document.addEventListener(
    "click",
    (event) => {
      if (
        waitingDeletes().length &&
        !event.target.closest?.("[data-keep-notice]")
      )
        window.setTimeout(() => commitDeletes());
    },
    { capture: true },
  );

  function undoDelete(stationId) {
    const pending = state.pendingDeletes.get(stationId);
    if (!pending || pending.committing) return;
    state.pendingDeletes.delete(stationId);
    renderStations();
    highlightTile(stationId);
    if (waitingDeletes().length) announceDeletes();
    else {
      notify(`Restored ${quote(pending.station.name)}.`);
    }
  }

  function commitDeletes({ keepalive = false } = {}) {
    for (const pending of waitingDeletes())
      commitDelete(pending.station.station_id, { keepalive });
  }

  async function commitDelete(stationId, { keepalive = false } = {}) {
    const pending = state.pendingDeletes.get(stationId);
    if (!pending || pending.committing) return;
    pending.committing = true;
    renderStations({ force: true });
    // keepalive lets the request outlive a page that is closing or that a
    // phone suspends; a page that stays (or comes back) still finishes it.
    try {
      await window.ZakAPI(`/api/stations/${encodeURIComponent(stationId)}`, {
        method: "DELETE",
        body: { owner_token: ownerToken(stationId) },
        keepalive,
      });
      finishDelete(stationId);
    } catch (error) {
      if (number(error?.status) === 404) {
        finishDelete(stationId);
        return;
      }
      state.pendingDeletes.delete(stationId);
      state.deleteErrors.set(stationId, problem(error, "station"));
      renderStations();
      notify(
        failureSentence(error, `${quote(pending.station.name)} wasn’t deleted`),
        { tone: "error" },
      );
    }
  }

  async function finishDelete(stationId) {
    window.ZakStorage.remove(`zak-radio-owner:${stationId}`);
    const pending = state.pendingDeletes.get(stationId);
    if (pending) pending.committed = true;
    try {
      await window.ZakStations.reload();
    } catch {
      // The list refreshes with the next station event.
    }
    state.pendingDeletes.delete(stationId);
    renderStations();
  }

  // A hidden page may be closed without warning, so hiding it counts as the
  // next action too.
  window.addEventListener("pagehide", () => commitDeletes({ keepalive: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden")
      commitDeletes({ keepalive: true });
  });

  // -------------------------------------------------------------- chooser

  function setChooserBusy(busy) {
    els.chooserOptions.forEach((option) => {
      option.setAttribute("aria-disabled", String(busy));
    });
    els.chooser.classList.toggle("is-busy", busy);
  }

  function openChooser({ opener = null, track = null } = {}) {
    closeMenu(false);
    if (els.editorDialog.open) return;
    state.chooser = {
      opener: opener || document.activeElement,
      track,
      busy: false,
    };
    els.chooserError.hidden = true;
    els.chooserLede.textContent = "What kind of station do you want to make?";
    els.chooserError.textContent = "";
    els.chooserError.classList.remove("is-guidance");
    setChooserBusy(false);
    els.chooserOptions.forEach((option) => {
      option.disabled = false;
      option.removeAttribute("aria-disabled");
    });
    if (!els.chooser.open) els.chooser.showModal();
    els.chooserOptions[0]?.focus();
  }

  function closeChooser({ handoff = false } = {}) {
    if (state.chooser?.busy) return;
    state.chooserHandoff = handoff;
    els.chooser.close();
  }

  els.chooser.addEventListener("close", () => {
    const chooser = state.chooser;
    state.chooser = null;
    if (state.chooserHandoff) {
      state.chooserHandoff = false;
      return;
    }
    if (chooser?.opener?.isConnected)
      chooser.opener.focus({ preventScroll: true });
  });

  els.chooser.addEventListener("cancel", (event) => {
    if (state.chooser?.busy) event.preventDefault();
  });

  els.chooserCancel.addEventListener("click", () => closeChooser());

  els.chooserOptions.forEach((option) => {
    option.addEventListener("click", async () => {
      const chooser = state.chooser;
      if (!chooser || chooser.busy) return;
      const kind = option.dataset.stationKind;
      if (kind === "temporary") {
        chooser.busy = true;
        setChooserBusy(true);
        els.chooserError.hidden = true;
        const label = option.textContent;
        option.textContent = "Starting temporary station…";
        const result = await startTemporary({ track: chooser.track });
        option.textContent = label;
        chooser.busy = false;
        setChooserBusy(false);
        if (result.ok) {
          closeChooser();
        } else {
          await showChooserFailure(result, option);
        }
        return;
      }
      const opener = chooser.opener;
      const track = chooser.track;
      closeChooser({ handoff: true });
      if (kind === "list") openEditor({ sourceType: "list", track, opener });
      else
        openEditor({ sourceType: "filter", opener, ...currentFilterPrefill() });
    });
  });

  // Why a temporary station couldn't start, and what to do instead, shown
  // before the choices. A full house lists the stations that
  // count, each with End or Delete beside it. Hand-picked stations count
  // toward the same limit, so they aren't offered as a way around it.
  async function showChooserFailure(result, option = null) {
    const box = els.chooserError;
    box.replaceChildren(element("p", "", result.message));
    box.hidden = false;
    box.classList.toggle("is-guidance", result.reason === "capacity");
    if (result.reason !== "capacity") {
      option?.focus();
      return;
    }
    els.chooserLede.textContent = "Make room for a new station.";
    els.chooserOptions.forEach((choice) => {
      choice.disabled = true;
      choice.setAttribute("aria-disabled", "true");
    });
    box.prepend(
      element(
        "p",
        "capacity-list-lede",
        "End or delete a station below, or wait for a temporary station to expire, then try again.",
      ),
    );
    const track = state.chooser?.track || null;
    const own = (await window.ZakStation?.ownTemporary?.()) || [];
    if (!els.chooser.open) return;
    const saved = window.ZakStations?.owned?.() || [];
    const rows = [
      ...own.map((station) => ({
        id: station.stationId,
        name: "Your temporary station",
        meta: "Temporary station",
        temporary: true,
      })),
      ...saved.map((station) => ({
        id: station.station_id,
        name: station.name,
        meta: KIND_LABELS[station.source_type] || "Saved station",
        temporary: false,
      })),
    ];
    if (!result.perCreator) {
      box.append(
        element(
          "p",
          "",
          "Try again when one ends, or end one of yours to make room.",
        ),
      );
    }
    if (rows.length) {
      box.append(
        element(
          "p",
          "capacity-list-lede",
          result.perCreator
            ? "These are yours. End or delete one you no longer need to make room:"
            : "Yours:",
        ),
      );
      const list = element("ul", "capacity-list");
      list.setAttribute("role", "list");
      list.append(...rows.map((row) => capacityRow(row, box, track, option)));
      box.append(list);
    }
    const elsewhere = Math.max(0, (result.limit || 0) - rows.length);
    if (elsewhere || !rows.length)
      box.append(
        element(
          "p",
          "field-hint",
          `${elsewhere ? `${plural(elsewhere, "station")} ${elsewhere === 1 ? "is" : "are"}` : "Stations are"} held on other devices${result.perCreator ? " by people here" : " by other people"}. End or delete them on those devices. Temporary stations expire after 24 hours without use; saved stations stay until deleted.`,
        ),
      );
    box.append(
      button("Try temporary station again", "button", async () => {
        const retry = await startTemporary({ track });
        if (retry.ok) closeChooser();
        else await showChooserFailure(retry, option);
      }),
    );
    box.querySelector("button")?.focus({ preventScroll: true });
    box.scrollIntoView({ block: "nearest" });
  }

  // One station that counts toward the limit. Ending or deleting can't be
  // undone, so the first press asks for a second.
  function capacityRow(row, box, track, option) {
    const item = element("li", "capacity-row");
    const copy = element("span", "capacity-row-copy");
    copy.append(element("strong", "", row.name), element("span", "", row.meta));
    const verb = row.temporary ? "End" : "Delete";
    const action = button(verb, "button", async () => {
      if (action.dataset.armed !== "true") {
        action.dataset.armed = "true";
        action.textContent = `${verb} for good?`;
        action.classList.add("is-danger");
        return;
      }
      action.disabled = true;
      action.textContent = row.temporary ? "Ending…" : "Deleting…";
      const done = row.temporary
        ? await window.ZakStation.endTemporary(row.id)
        : await deleteStationNow(row.id);
      if (!done.ok) {
        action.disabled = false;
        action.dataset.armed = "false";
        action.classList.remove("is-danger");
        action.textContent = verb;
        notify(done.message, { tone: "error" });
        return;
      }
      renderStations();
      els.chooserOptions.forEach((choice) => {
        choice.disabled = false;
        choice.setAttribute("aria-disabled", "false");
      });
      box.replaceChildren(
        element(
          "p",
          "",
          `${row.temporary ? "Ended" : "Deleted"} ${row.temporary ? "your temporary station" : quote(row.name)}. There’s room for a new station now.`,
        ),
      );
      const start = button(
        "Start temporary station",
        "button is-primary",
        async () => {
          start.disabled = true;
          const retry = await startTemporary({ track });
          if (retry.ok) closeChooser();
          else await showChooserFailure(retry, option);
        },
      );
      const actions = element("div", "state-actions");
      actions.append(start);
      box.append(actions);
      box.classList.remove("is-guidance");
      start.focus({ preventScroll: true });
    });
    action.setAttribute(
      "aria-label",
      `${verb} ${row.temporary ? "your temporary station" : row.name}`,
    );
    item.append(copy, action);
    return item;
  }

  async function deleteStationNow(stationId) {
    try {
      await window.ZakAPI(`/api/stations/${encodeURIComponent(stationId)}`, {
        method: "DELETE",
        body: { owner_token: ownerToken(stationId) },
      });
    } catch (error) {
      if (number(error?.status) !== 404)
        return {
          ok: false,
          message: `Couldn’t delete it. ${problem(error, "station")}`,
        };
    }
    window.ZakStorage.remove(`zak-radio-owner:${stationId}`);
    window.ZakStation?.capacityFreed?.();
    try {
      await window.ZakStations.reload();
    } catch {
      // The list refreshes with the next station event.
    }
    return { ok: true };
  }

  // -------------------------------------------------------------- editor

  // The songs on screen, for a station that keeps them; a very long list
  // isn't offered.
  function shownTrackIds() {
    const ids = state.results.map(({ entry }) => entry.track.id);
    return ids.length <= 400 ? ids : [];
  }

  function currentFilterPrefill() {
    if (!onLibrary()) return filterStationPrefill();
    return filterStationPrefill({
      query: state.query.trim() || state.group,
      filter: state.filter,
      shownIds: shownTrackIds(),
    });
  }

  function defaultFilterName(query, mode) {
    const base = FILTER_LABELS[mode] || FILTER_LABELS.all;
    // "All songs" is the main station's name; don't reuse it.
    if (!query) return mode === "all" ? "Library mix" : base;
    const words = query.replace(/["“”]/g, "").trim();
    const name =
      mode === "all"
        ? `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)} radio`
        : `${base}: ${words}`;
    return name.slice(0, 80);
  }

  function editorFilterMatches() {
    return filterMatches(
      els.editorQuery.value,
      els.editorMode.value,
      els.editorSkip.checked,
    );
  }

  // The songs a filter station with these words would play: what Library
  // search finds for them among the songs it includes, then without disliked
  // songs when it skips them. The server matches the same way, so a saved
  // search keeps playing what it showed.
  function filterMatches(rawQuery, mode, skipDisliked = false) {
    const newest =
      mode === "recent"
        ? state.entries.reduce(
            (latest, entry) => Math.max(latest, entry.date),
            0,
          )
        : 0;
    const pool = state.entries.filter(({ track, date }) => {
      if (mode === "liked" && !track.liked) return false;
      if (mode === "covers" && !track.has_cover) return false;
      if (
        mode === "recent" &&
        (!newest || !date || date < newest - RECENT_WINDOW)
      )
        return false;
      return true;
    });
    const query = parseQuery(String(rawQuery || "").slice(0, 160));
    return searchEntries(pool, query)
      .results.filter(({ entry }) => !(skipDisliked && entry.track.disliked))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.entry.date - a.entry.date ||
          a.entry.position - b.entry.position,
      )
      .map(({ entry }) => entry);
  }

  // A few of the songs it would play, so the words can be judged by their
  // results while they're typed.
  function renderEditorPreview(matches) {
    const shown = matches.slice(0, 4);
    const rows = shown.map((entry) => {
      const row = document.createElement("li");
      row.className = "editor-preview-song";
      const title = document.createElement("span");
      title.className = "editor-preview-title";
      title.textContent = entry.title;
      row.append(title);
      if (entry.track.artist || entry.title === UNTITLED) {
        const artist = document.createElement("span");
        artist.className = "editor-preview-artist";
        artist.textContent = byline(entry.track);
        row.append(artist);
      }
      return row;
    });
    if (matches.length > shown.length) {
      const more = document.createElement("li");
      more.className = "editor-preview-more";
      more.textContent = `and ${plural(matches.length - shown.length, "more song", "more songs")}`;
      rows.push(more);
    }
    els.editorPreview.replaceChildren(...rows);
    els.editorPreview.hidden = !rows.length;
  }

  function renderEditorMatches() {
    if (state.editor?.sourceType !== "filter") return;
    if (state.status !== "ready") {
      els.editorMatches.textContent = "Checking which songs match…";
      els.editorPreview.hidden = true;
      return;
    }
    const matches = editorFilterMatches();
    const count = matches.length;
    els.editorMatches.textContent = count
      ? `${plural(count, "song")} ${count === 1 ? "matches" : "match"} right now. Songs added later join when they match.`
      : "No songs match these words. Try different words or include more songs.";
    els.editorMatches.classList.toggle("is-warning", !count);
    renderEditorPreview(matches);
    // With nothing matching, the songs that were on screen are the way out.
    const shown = state.editor.shownIds || [];
    const words = els.editorQuery.value.trim();
    if (!count && shown.length && els.editorNotice.hidden) {
      showEditorNotice(
        "You can keep the songs you were looking at instead, as a hand-picked station.",
      );
    } else if (count && words !== state.editor.noticeQuery) {
      els.editorNotice.hidden = true;
    }
  }

  function showEditorNotice(text) {
    const shown = state.editor?.shownIds || [];
    if (state.editor) state.editor.noticeQuery = els.editorQuery.value.trim();
    els.editorNoticeText.textContent = text;
    els.editorNotice.hidden = !text;
    els.editorUseShown.hidden = !shown.length;
    els.editorUseShown.textContent = `Make a hand-picked station of the ${plural(shown.length, "song")} shown`;
  }

  // Turns the filter editor into a hand-picked station of the songs that
  // were on screen, with the same name.
  function useShownSongs() {
    const editor = state.editor;
    if (!editor?.shownIds?.length) return;
    editor.sourceType = "list";
    editor.trackIds = [...editor.shownIds];
    els.editorKind.textContent = KIND_LABELS.list;
    els.editorTitle.textContent = "New hand-picked station";
    els.editorFilter.hidden = true;
    els.editorList.hidden = false;
    els.editorNotice.hidden = true;
    renderEditorMembers();
    renderEditorResults();
    clearEditorError();
    editorStatus(
      `Switched to a hand-picked station of ${plural(editor.trackIds.length, "song")}.`,
    );
    els.editorTitle.focus({ preventScroll: true });
  }

  els.editorUseShown.addEventListener("click", useShownSongs);

  function trackById(id) {
    return state.entries.find((entry) => entry.track.id === id)?.track || null;
  }

  function editorStatus(message) {
    els.editorStatus.textContent = "";
    window.setTimeout(() => {
      els.editorStatus.textContent = message;
    }, 60);
  }

  function songRow(
    track,
    fallbackTitle = "Song no longer in the library",
    excerpt = null,
  ) {
    const row = element("div", "editor-song");
    row.append(
      track
        ? createArtwork(track, "editor-song-art")
        : element("div", "editor-song-art"),
    );
    const copy = element("div", "editor-song-copy");
    copy.append(
      element("strong", "", track ? displayTitle(track) : fallbackTitle),
    );
    if (track) {
      const meta = element("span", "tabular");
      meta.textContent = `${byline(track)} · ${timeLabel(track.duration)}`;
      copy.append(meta);
    }
    if (excerpt) {
      const why = element("span", "editor-song-excerpt");
      why.append(element("span", "track-card-excerpt-label", excerpt.kind));
      appendHighlighted(why, excerpt.line, excerpt.terms, excerpt.fuzzy, 60);
      copy.append(why);
    }
    row.append(copy);
    if (track) {
      const preview = button("Preview", "button editor-song-preview", () =>
        togglePreview(track),
      );
      preview.replaceChildren(icon("play"));
      preview.dataset.previewTrack = track.id;
      preview.setAttribute("aria-label", `Preview ${displayTitle(track)}`);
      row.append(preview);
    }
    return row;
  }

  function renderEditorMembers(focusIndex = -1) {
    const editor = state.editor;
    if (!editor || editor.sourceType !== "list") return;
    const ids = editor.trackIds;
    const first = trackById(ids[0]);
    if (!editor.stationId && els.editorName.value === "Hand-picked mix") {
      els.editorName.value = listName(first);
    }

    if (focusIndex < 0 && els.editorMembers.contains(document.activeElement)) {
      focusIndex = [
        ...els.editorMembers.querySelectorAll(".editor-member"),
      ].indexOf(document.activeElement.closest(".editor-member"));
    }
    els.editorSongCount.textContent = `(${ids.length})`;
    if (!ids.length) {
      const empty = element(
        "li",
        "editor-empty",
        "No songs yet. Search above to add some.",
      );
      els.editorMembers.replaceChildren(empty);
    } else {
      els.editorMembers.replaceChildren(
        ...ids.map((id, index) => {
          const track = trackById(id);
          const item = element("li", "editor-member");
          const row = songRow(track);
          const title = track ? displayTitle(track) : "this song";
          const remove = button("Remove", "button-quiet", () => {
            editor.trackIds = editor.trackIds.filter(
              (trackId) => trackId !== id,
            );
            renderEditorMembers(index);
            renderEditorResults();
            editorStatus(`Removed ${quote(title)}.`);
          });
          remove.setAttribute("aria-label", `Remove ${title}`);
          row.append(remove);
          item.append(row);
          return item;
        }),
      );
    }
    syncPlayback();
    if (focusIndex >= 0) {
      const buttons = els.editorMembers.querySelectorAll(
        ".editor-member .button-quiet",
      );
      (
        buttons[Math.min(focusIndex, buttons.length - 1)] || els.editorSearch
      ).focus();
    }
  }

  function renderEditorResults() {
    const editor = state.editor;
    if (!editor || editor.sourceType !== "list") return;
    const query = parseQuery(els.editorSearch.value);
    if (!query.terms.length) {
      els.editorResults.replaceChildren();
      els.editorResults.hidden = true;
      return;
    }
    const focusedPreview = Boolean(
      document.activeElement?.dataset.previewTrack,
    );
    const focusedId = els.editorResults.contains(document.activeElement)
      ? document.activeElement.closest("[data-track-id]")?.dataset.trackId
      : "";
    const { results, fuzzy } = searchEntries(state.entries, query);
    results.sort(
      (a, b) => b.score - a.score || a.entry.position - b.entry.position,
    );
    if (editor.resultQuery !== query.raw) {
      editor.resultQuery = query.raw;
      editor.resultLimit = 8;
    }
    const shown = results.slice(0, editor.resultLimit);
    els.editorResults.hidden = false;
    if (!shown.length) {
      els.editorResults.replaceChildren(
        element("li", "editor-empty", `No songs match ${quote(query.raw)}.`),
      );
      return;
    }
    els.editorResults.replaceChildren(
      ...shown.map(({ entry, hidden }) => {
        const track = entry.track;
        const title = entry.title;
        const item = element("li", "editor-result");
        item.dataset.trackId = track.id;
        // Explain lyric and prompt matches, as the main results do.
        const match = hidden ? bestExcerpt(entry, query, fuzzy) : null;
        const row = songRow(
          track,
          undefined,
          match ? { ...match, terms: query.terms, fuzzy } : null,
        );
        const added = editor.trackIds.includes(track.id);
        const add = button(
          added ? "Added" : "Add",
          added ? "button is-added" : "button",
          () => {
            if (editor.trackIds.includes(track.id)) return;
            editor.trackIds.push(track.id);
            renderEditorMembers();
            renderEditorResults();
            clearEditorError();
            editorStatus(`Added ${quote(title)}.`);
          },
        );
        add.setAttribute("aria-label", `${added ? "Added" : "Add"} ${title}`);
        if (added) add.setAttribute("aria-disabled", "true");
        row.append(add);
        item.append(row);
        return item;
      }),
    );
    els.editorResults.prepend(
      element(
        "li",
        "editor-results-count field-hint",
        `${plural(results.length, "matching song")} · showing ${shown.length}`,
      ),
    );
    if (shown.length < results.length) {
      const more = element("li", "editor-results-more");
      more.append(
        button(
          `Show more (${results.length - shown.length} remaining)`,
          "button",
          () => {
            const firstNew = editor.resultLimit;
            editor.resultLimit += 16;
            renderEditorResults();
            els.editorResults
              .querySelectorAll(".editor-result")
              [firstNew]?.querySelector("button")
              ?.focus();
          },
        ),
      );
      els.editorResults.append(more);
    }
    syncPlayback();
    if (focusedId) {
      els.editorResults
        .querySelector(
          `[data-track-id="${CSS.escape(focusedId)}"] ${focusedPreview ? "[data-preview-track]" : "button:last-child"}`,
        )
        ?.focus();
    }
  }

  function clearEditorError() {
    window.clearInterval(editorRetryTimer);
    els.editorError.hidden = true;
    els.editorError.replaceChildren();
    els.editorName.removeAttribute("aria-invalid");
    els.editorName.removeAttribute("aria-describedby");
  }

  // After a rate limit, Try again stays disabled and counts down to when it
  // can work, instead of inviting a press that fails again.
  let editorRetryTimer = 0;
  function showEditorError(
    message,
    focusTarget = null,
    retry = false,
    waitSeconds = 0,
  ) {
    window.clearInterval(editorRetryTimer);
    const text = element("p", "", message);
    els.editorError.replaceChildren(text);
    if (retry) {
      const again = button("Try again", "button", () =>
        els.editor.requestSubmit(),
      );
      els.editorError.append(again);
      if (waitSeconds > 0) {
        const until = Date.now() + waitSeconds * 1000;
        const tick = () => {
          const left = Math.ceil((until - Date.now()) / 1000);
          if (left <= 0 || !again.isConnected) {
            window.clearInterval(editorRetryTimer);
            again.disabled = false;
            again.textContent = "Try again";
            return;
          }
          again.disabled = true;
          again.textContent = `Try again in ${timeLabel(left)}`;
        };
        tick();
        editorRetryTimer = window.setInterval(tick, 1000);
        // Focus stays on the message while the button waits.
        text.tabIndex = -1;
        if (!focusTarget) focusTarget = text;
      }
      if (!focusTarget) focusTarget = again;
    }
    els.editorError.hidden = false;
    if (focusTarget === els.editorName) {
      els.editorName.setAttribute("aria-invalid", "true");
      els.editorName.setAttribute("aria-describedby", "stationEditorError");
    }
    focusTarget?.focus();
  }

  // Why a save failed, with when it can work again.
  function editorFailure(error, name) {
    const status = number(error?.status);
    if (status === 429 && /capacity/i.test(error?.detail || "")) {
      const failure = window.ZakCapacityFailure?.(error);
      return {
        message: `Couldn’t create ${quote(name)}. ${failure?.message || "You’ve reached the station limit."} Delete a station you no longer need from Your stations to make room.`,
        retry: false,
      };
    }
    if (status === 429) {
      const wait = number(error?.retryAfter) || 60;
      return {
        message: `Couldn’t save ${quote(name)}. Too many changes in a short time. You can try again in ${wait >= 90 ? `about ${plural(Math.round(wait / 60), "minute")}` : "a minute"}.`,
        retry: true,
        wait,
      };
    }
    return {
      message: `Couldn’t save ${quote(name)}. ${problem(error, "station")}`,
      retry: true,
      wait: 0,
    };
  }

  function setEditorBusy(busy) {
    els.editorSave.setAttribute("aria-disabled", String(busy));
    els.editorCancel.setAttribute("aria-disabled", String(busy));
    els.editorDialog.classList.toggle("is-busy", busy);
  }

  function openEditor({
    sourceType = "filter",
    station = null,
    track = null,
    opener = null,
    query = "",
    mode = "all",
    note = "",
    shownIds = [],
    trackIds = track ? [track.id] : [],
  } = {}) {
    if (state.editor?.saving) return;
    closeMenu(false);
    if (els.chooser.open) closeChooser({ handoff: true });
    const editing = Boolean(station);
    const kind = station?.source_type || sourceType;
    state.editor = {
      stationId: station?.station_id || "",
      sourceType: kind,
      original: station ? { ...station } : null,
      originalName: station?.name || "",
      trackIds: [...(station ? station.track_ids || [] : trackIds)],
      opener: opener || document.activeElement,
      creationAttempt: null,
      saving: false,
      shownIds: station ? [] : shownIds,
    };
    state.editorFocus = null;
    els.editorKind.textContent = KIND_LABELS[kind];
    els.editorTitle.textContent = editing
      ? `Edit ${quote(station.name)}`
      : kind === "list"
        ? "New hand-picked station"
        : "New filter station";
    els.editorFilter.hidden = kind !== "filter";
    els.editorList.hidden = kind !== "list";
    els.editorQuery.value = editing ? station.filter_query || "" : query;
    els.editorMode.value = editing ? station.filter_mode || "all" : mode;
    els.editorName.value = editing
      ? station.name
      : kind === "list"
        ? listName(track)
        : defaultFilterName(query, mode);
    setRadioGroupValue(els.editorRandom, station?.random_mode || "deck");
    els.editorSkip.checked = Boolean(station?.skip_disliked);
    els.editorSearch.value = "";
    els.editorSave.textContent = editing ? "Save changes" : "Create station";
    els.editorStatus.textContent = "";
    clearEditorError();
    setEditorBusy(false);
    renderEditorMembers();
    renderEditorResults();
    renderEditorMatches();
    els.editorDiscard.hidden = true;
    els.editorAccess.hidden = !editing;
    els.editorAccess.open = false;
    els.editorLinkFallback.hidden = true;
    els.editorAccessStatus.textContent = "";
    els.editorNotice.hidden = true;
    if (kind === "filter" && note) showEditorNotice(note);
    renderEditorMatches();
    state.editor.initial = editorSnapshot();
    if (!els.editorDialog.open) els.editorDialog.showModal();
    els.editorDialog.scrollTop = 0;
    // On touch screens, editing a station (adding or removing songs) starts
    // at the heading, so the keyboard doesn't cover the sheet; the name
    // takes focus only for a new station, which needs one.
    if (editing && coarsePointer.matches) {
      els.editorTitle.focus({ preventScroll: true });
    } else {
      els.editorName.focus();
      if (!editing) els.editorName.select();
    }
  }

  // A save confirms every change, not just the first: "Renamed “A” to “B”
  // and removed 1 song."
  function joinWords(parts) {
    if (parts.length < 2) return parts.join("");
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
  }

  function saveSummary(before, body, name) {
    if (!before) return `Saved ${quote(name)}.`;
    const changes = [];
    if (Array.isArray(body.track_ids)) {
      const old = before.track_ids || [];
      const added = body.track_ids.filter((id) => !old.includes(id)).length;
      const removed = old.filter((id) => !body.track_ids.includes(id)).length;
      if (added) changes.push(`added ${plural(added, "song")}`);
      if (removed) changes.push(`removed ${plural(removed, "song")}`);
      if (!added && !removed && old.join(",") !== body.track_ids.join(","))
        changes.push("changed the song order");
    } else if (
      String(before.filter_query || "") !== String(body.filter_query || "") ||
      String(before.filter_mode || "all") !== String(body.filter_mode || "all")
    ) {
      changes.push("changed which songs it plays");
    }
    if ((before.random_mode || "deck") !== body.random_mode)
      changes.push(
        `set the playback order to ${body.random_mode === "true_random" ? "Shuffle with repeats" : "No repeats"}`,
      );
    if (Boolean(before.skip_disliked) !== Boolean(body.skip_disliked))
      changes.push(
        body.skip_disliked
          ? "turned on Skip disliked"
          : "turned off Skip disliked",
      );
    const renamed = before.name && before.name !== name;
    if (renamed) {
      const rest = changes.length ? ` and ${joinWords(changes)}` : "";
      return `Renamed ${quote(before.name)} to ${quote(name)}${rest}.`;
    }
    if (!changes.length) return `Saved ${quote(name)} with no changes.`;
    return `Saved ${quote(name)}: ${joinWords(changes)}.`;
  }

  function editorSnapshot() {
    return JSON.stringify([
      els.editorName.value.trim(),
      els.editorQuery.value.trim(),
      els.editorMode.value,
      radioGroupValue(els.editorRandom),
      els.editorSkip.checked,
      state.editor?.trackIds || [],
    ]);
  }

  function editorDirty() {
    return Boolean(state.editor) && editorSnapshot() !== state.editor.initial;
  }

  // Escape, the backdrop, and Cancel all ask first when there are changes.
  function closeEditor() {
    if (state.editor?.saving) return;
    if (!editorDirty()) {
      finishEditor();
      return;
    }
    if (!els.editorDiscard.hidden) {
      keepEditing();
      return;
    }
    state.editor.discardFocus = document.activeElement;
    els.editorDiscard.hidden = false;
    els.editorDiscard.scrollIntoView({ block: "nearest" });
    els.editorKeep.focus();
  }

  function keepEditing() {
    els.editorDiscard.hidden = true;
    const target = state.editor?.discardFocus;
    (target?.isConnected && els.editorDialog.contains(target)
      ? target
      : els.editorName
    ).focus();
  }

  function finishEditor() {
    if (state.editor) state.editor.closing = true;
    els.editorDialog.close();
  }

  // Sharing from the editor: the same listen-only link as Radio, and a
  // private edit link that moves editing to another device.
  function showLinkFallback(label, url) {
    els.editorLinkLabel.textContent = label;
    els.editorLinkField.value = url;
    els.editorLinkFallback.hidden = false;
    els.editorLinkField.focus();
    els.editorLinkField.select();
  }

  // The editor is a modal sheet, so confirmations appear inside it.
  function accessStatus(message) {
    els.editorAccessStatus.textContent = message;
  }

  els.editorShare.addEventListener("click", async () => {
    const stationId = state.editor?.stationId;
    if (!stationId) return;
    els.editorLinkFallback.hidden = true;
    accessStatus("");
    const url = window.ZakStations.listenLink(stationId);
    try {
      await navigator.clipboard.writeText(url);
      accessStatus(
        "Listen-only link copied. People with it can listen but can’t change the station.",
      );
    } catch {
      showLinkFallback("Listen-only link", url);
    }
  });

  els.editorTransfer.addEventListener("click", async () => {
    const stationId = state.editor?.stationId;
    const link = stationId ? window.ZakEditLink?.(stationId) : "";
    els.editorLinkFallback.hidden = true;
    accessStatus("");
    if (!link) {
      showEditorError("This device can’t edit this station anymore.");
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      accessStatus(
        "Private edit link copied. Open it on your other device to edit the station there. Keep it to yourself: anyone with it can change or delete the station.",
      );
    } catch {
      showLinkFallback("Private edit link (keep it to yourself)", link);
    }
  });

  els.editorKeep.addEventListener("click", keepEditing);
  els.editorDiscardConfirm.addEventListener("click", finishEditor);

  els.editorDialog.addEventListener("close", () => {
    const editor = state.editor;
    // Some browsers close on a repeated Escape even when asked not to; bring
    // unsaved changes back instead of dropping them.
    if (editor && !editor.closing && !editor.saving && editorDirty()) {
      els.editorDialog.showModal();
      els.editorDiscard.hidden = false;
      els.editorKeep.focus();
      return;
    }
    els.editorDiscard.hidden = true;
    els.editorStatus.textContent = "";
    state.editor = null;
    const target = state.editorFocus;
    state.editorFocus = null;
    if (target && highlightTile(target)) return;
    if (editor?.opener?.isConnected && !editor.opener.closest("[hidden]")) {
      editor.opener.focus({ preventScroll: true });
    } else if (onLibrary()) {
      focusVisible(els.newStation);
    }
  });

  els.editorDialog.addEventListener("cancel", (event) => {
    if (state.editor?.saving) {
      event.preventDefault();
      return;
    }
    if (editorDirty()) {
      event.preventDefault();
      closeEditor();
    }
  });

  for (const dialog of [els.editorDialog, els.chooser]) {
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      const inside =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      if (inside) return;
      if (dialog === els.chooser) closeChooser();
      else closeEditor();
    });
  }

  els.editorCancel.addEventListener("click", closeEditor);
  // The × asks about unsaved changes too, like Cancel and Escape.
  els.editorClose.addEventListener("click", closeEditor);
  els.chooserClose.addEventListener("click", () => closeChooser());
  els.editorName.addEventListener("input", () => {
    if (
      els.editorName.value.trim() &&
      els.editorName.hasAttribute("aria-invalid")
    )
      clearEditorError();
  });
  els.editorQuery.addEventListener("input", renderEditorMatches);
  els.editorMode.addEventListener("change", renderEditorMatches);
  els.editorSkip.addEventListener("change", renderEditorMatches);
  els.editorSearch.addEventListener("input", renderEditorResults);
  els.editorSearch.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    els.editorResults
      .querySelector(
        "button:not([data-preview-track]):not([aria-disabled='true'])",
      )
      ?.click();
  });
  els.editorQuery.addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.preventDefault();
  });

  els.editor.addEventListener("submit", async (event) => {
    event.preventDefault();
    const editor = state.editor;
    if (!editor || editor.saving) return;
    clearEditorError();
    const name = els.editorName.value.trim();
    if (!name) {
      showEditorError("Give the station a name.", els.editorName);
      return;
    }
    if (editor.sourceType === "list" && !editor.trackIds.length) {
      showEditorError("Add at least one song.", els.editorSearch);
      return;
    }
    if (
      editor.sourceType === "filter" &&
      state.status === "ready" &&
      !editorFilterMatches().length
    ) {
      showEditorError(
        editor.shownIds?.length
          ? "No songs match these words. Change the words, or make a hand-picked station of the songs shown."
          : "No songs match these words yet. Change the search words or what to include.",
        els.editorQuery,
      );
      return;
    }
    const body = {
      name,
      random_mode: radioGroupValue(els.editorRandom) || "deck",
      skip_disliked: els.editorSkip.checked,
    };
    if (editor.sourceType === "list") body.track_ids = [...editor.trackIds];
    else {
      body.filter_query = els.editorQuery.value.trim();
      body.filter_mode = els.editorMode.value;
    }
    editor.saving = true;
    setEditorBusy(true);
    els.editorStatus.textContent = editor.stationId ? "Saving…" : "Creating…";
    const previous = editor.original
      ? {
          name: editor.original.name,
          random_mode: editor.original.random_mode,
          skip_disliked: editor.original.skip_disliked,
          ...(editor.sourceType === "list"
            ? { track_ids: [...editor.original.track_ids] }
            : {
                filter_query: editor.original.filter_query,
                filter_mode: editor.original.filter_mode,
              }),
        }
      : null;
    let message = "";
    let created = !editor.original;
    try {
      if (editor.stationId) {
        if (!ownerToken(editor.stationId)) {
          throw Object.assign(new Error("listen-only"), { status: 403 });
        }
        await window.ZakStations.update(editor.stationId, body);
        message = saveSummary(editor.original, body, name);
      } else {
        const retrying = Boolean(editor.creationAttempt);
        editor.creationAttempt ||= {
          idempotency_key: randomBrowserHex(16),
          owner_token: randomBrowserHex(24),
        };
        const result = await window.ZakAPI("/api/stations", {
          method: "POST",
          body: {
            source_type: editor.sourceType,
            filter_mode: "all",
            filter_query: "",
            track_ids: [],
            ...body,
            ...editor.creationAttempt,
          },
        });
        window.ZakStorage.set(
          `zak-radio-owner:${result.station_id}`,
          result.owner_token,
        );
        // The create may have committed even if a later step fails. Keep its
        // identity so a retry updates it instead of creating another one.
        editor.stationId = result.station_id;
        editor.originalName = name;
        created = true;
        if (retrying) await window.ZakStations.update(result.station_id, body);
        else await window.ZakStations.reload();
        message = `Created ${quote(name)}.`;
      }
    } catch (error) {
      editor.saving = false;
      setEditorBusy(false);
      els.editorStatus.textContent = "";
      const failure = editorFailure(error, name);
      showEditorError(failure.message, null, failure.retry, failure.wait);
      return;
    }
    const stationId = editor.stationId;
    editor.saving = false;
    editor.closing = true;
    // The work is done; the status region no longer says "Saving…".
    els.editorStatus.textContent = "";
    state.stationsReady = true;
    renderStations();
    state.editorFocus = onLibrary() ? stationId : null;
    els.editorDialog.close();
    notify(
      message,
      created
        ? {
            action: {
              label: "Listen",
              run: () => window.ZakStation?.open?.(stationId),
            },
          }
        : {
            action: {
              label: "Undo",
              run: async () => {
                try {
                  await window.ZakStations.update(stationId, previous);
                  renderStations({ force: true });
                  notify(`Restored ${quote(previous.name)}.`);
                } catch (error) {
                  notify(
                    failureSentence(
                      error,
                      "the previous station settings weren’t restored",
                    ),
                    { tone: "error" },
                  );
                }
              },
            },
          },
    );
  });

  // -------------------------------------------------------------- events

  els.search.addEventListener("input", () => {
    window.clearTimeout(state.announceTimer);
    state.query = els.search.value;
    state.limit = PAGE_SIZE;
    state.parsed = parseQuery(state.query);
    scheduleRefresh();
    scheduleURL();
  });

  // On phones, searching scrolls the toolbar to the top so results get the
  // screen instead of the intro and stations.
  const compact = window.matchMedia("(max-width: 640px), (max-height: 500px)");
  els.search.addEventListener("focus", () => {
    if (!compact.matches) return;
    const toolbar = els.search.closest(".library-tools");
    const offset = number(
      Number.parseFloat(
        els.page.style.getPropertyValue("--library-sticky-top"),
      ),
    );
    const distance = toolbar.getBoundingClientRect().top - offset;
    if (distance > 1) {
      window.scrollBy({
        top: distance,
        behavior: calm.matches ? "auto" : "smooth",
      });
    }
  });

  els.search.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && els.search.value) {
      event.preventDefault();
      state.query = "";
      refresh({ announce: true });
      writeURL({ push: true, focus: "#librarySearch" });
    }
  });

  els.sort.addEventListener("change", () => {
    const value = SORT_VALUES.includes(els.sort.value)
      ? els.sort.value
      : "newest";
    // Newest added first is what the automatic order shows while not
    // searching, so choosing it there goes back to that order (Best match
    // when a search starts) rather than fixing newest for searches too.
    state.sort = value === "newest" && !searching() ? "match" : value;
    window.ZakStorage.set(SORT_KEY, state.sort);
    refresh({ announce: true });
    writeURL();
    // The sort control stays on screen in the sticky bar, so it keeps focus.
    revealResults();
  });

  function applyFilter(key) {
    // "All" clears every filter; a pressed chip turns itself off.
    if (key === "all") {
      state.filter = "all";
      state.group = "";
      state.artist = "";
    } else {
      state.filter = state.filter === key ? "all" : key;
    }
    state.limit = PAGE_SIZE;
    refresh({ announce: true });
    writeURL({ push: true, focus: `[data-library-filter="${key}"]` });
    revealResults();
  }

  els.filters.forEach((chip) => {
    chip.addEventListener("click", () =>
      applyFilter(chip.dataset.libraryFilter),
    );
  });

  els.views.forEach((control) => {
    control.addEventListener("click", () => {
      if (state.view === control.dataset.libraryView) return;
      state.view = control.dataset.libraryView;
      window.ZakStorage.set("zak-library-view", state.view);
      refresh();
      writeURL();
    });
  });

  // Saving keeps what was on screen: a filter station matches its words
  // as Library search does, close spellings included. Only when the station
  // would still play different songs (a collection shown as its name) does
  // the editor say so up front and offer a hand-picked station instead.
  function saveShownAsStation() {
    const shownIds = state.results.map(({ entry }) => entry.track.id);
    // Your likes live in this browser, so no filter station can play them;
    // the songs shown become a hand-picked station instead.
    if (state.filter === "mine") {
      openEditor({
        sourceType: "list",
        opener: els.saveFilter,
        trackIds: shownIds,
      });
      return;
    }
    const prefill = currentFilterPrefill();
    const { query } = prefill;
    let note = "";
    const plays = filterMatches(query, prefill.mode).length;
    if (plays !== shownIds.length) {
      note = plays
        ? `A station of “${query}” would play ${plural(plays, "song")}, not the ${plural(shownIds.length, "song")} shown.`
        : `No song matches “${query}” as a station.`;
    }
    openEditor({
      sourceType: "filter",
      opener: els.saveFilter,
      mode: prefill.mode,
      query,
      note,
      shownIds: shownTrackIds(),
    });
  }

  els.saveFilter.addEventListener("click", saveShownAsStation);
  els.jumpAll.addEventListener("click", (event) => {
    event.preventDefault();
    const head = els.heading.closest(".library-results-head") || els.heading;
    const offset =
      number(
        Number.parseFloat(
          els.page.style.getPropertyValue("--library-sticky-top"),
        ),
      ) +
      (els.toolbar?.offsetHeight || 0) +
      12;
    window.scrollTo({
      top: Math.max(
        0,
        window.scrollY + head.getBoundingClientRect().top - offset,
      ),
      behavior: calm.matches ? "auto" : "smooth",
    });
    els.heading.focus({ preventScroll: true });
  });
  els.newStation.addEventListener("click", () =>
    openChooser({ opener: els.newStation }),
  );

  window.addEventListener("zak-new-station", (event) =>
    openChooser({
      opener: event.detail?.opener,
      track: event.detail?.track || null,
    }),
  );
  window.addEventListener("zak-new-list-station", (event) =>
    openEditor({
      sourceType: "list",
      track: event.detail?.track || null,
      opener: event.detail?.opener,
    }),
  );
  window.addEventListener("zak-edit-station", (event) => {
    const stationId = event.detail?.stationId;
    const station = (window.ZakStations?.owned?.() || []).find(
      (item) => item.station_id === stationId,
    );
    if (!station) {
      notify("Only someone with editing access to this station can edit it.", {
        tone: "error",
      });
      return;
    }
    openEditor({ station, opener: event.detail?.opener });
  });

  window.addEventListener("zak-audio-owner", (event) => {
    registerPlayer();
    if (event.detail?.owner === "radio") state.radioInterrupted = false;
    syncPlayback();
  });
  for (const type of ["play", "pause", "ended"]) {
    els.audio.addEventListener(type, () => {
      if (
        type === "ended" &&
        window.ZakAudio.is("library") &&
        state.radioInterrupted
      ) {
        void backToLive().then((back) => {
          if (back) notify("Preview ended. Radio is playing again.");
        });
      }
      if (window.ZakAudio.is("library") || state.current) syncPlayback();
    });
  }
  // On Radio: the song on air and the next few, beside the songs on wide
  // screens, so the rail says what the radio is doing while you browse.
  let onAirKey = "";
  function renderOnAir() {
    const station = stationInfo();
    const ids = station?.trackId
      ? [station.trackId, ...station.upNext.slice(0, 4)]
      : [];
    const tracks = ids.map(trackById).filter(Boolean);
    els.onAir.hidden = !tracks.length;
    if (!tracks.length) return;
    els.onAirStation.textContent = `${station.playing ? "Live" : "Paused"} · ${station.label}`;
    els.onAirStation.dataset.live = String(station.playing);
    const key = JSON.stringify([ids, station.playing]);
    if (key === onAirKey) return;
    onAirKey = key;
    els.onAirList.replaceChildren(
      ...tracks.map((track, index) => {
        const item = element("li", "library-on-air-item");
        const copy = element("span", "library-on-air-copy");
        copy.append(
          element("span", "library-on-air-kicker", index ? "Next" : "Now"),
          element("span", "library-on-air-title", displayTitle(track)),
          element("span", "library-on-air-artist", byline(track)),
        );
        item.append(createArtwork(track, "library-on-air-art"), copy);
        if (!index) item.classList.add("is-now");
        return item;
      }),
    );
  }

  window.addEventListener("zak-station", () => {
    renderQueueNote();
    renderStations();
    renderOnAir();
  });
  window.addEventListener("zak-stations", () => {
    state.stationsReady = true;
    state.stationsFailed = false;
    renderStations();
  });
  window.addEventListener("zak-stations-failed", (event) => {
    if (stationsReady()) return;
    state.stationsFailed = true;
    state.stationsError = event.detail || null;
    renderStations();
  });

  window.addEventListener("zak-before-route", flushURL);

  window.addEventListener("zak-route", (event) => {
    if (event.detail?.path !== "/library") {
      closeMenu(false);
      commitDeletes();
      return;
    }
    const params = paramsFromURL();
    // Back and Forward restore exactly what the entry holds; a visit from
    // another view keeps the search the listener left here.
    if (event.detail?.cause === "history") {
      window.clearTimeout(state.urlTimer);
      state.urlPending = null;
      adoptParams(params);
      if (!params.view) state.view = storedOrDefaultView();
    } else if (params.present) adoptParams(params);
    writeURL();
    if (state.status !== "ready" && window.ZakCatalog.tracks?.length) {
      acceptTracks(window.ZakCatalog.tracks);
    }
    refresh();
    renderStations();
    if (window.location.hash === "#stations") setStationsOpen(true);
  });

  document.addEventListener("keydown", (event) => {
    if (!onLibrary() || event.defaultPrevented) return;
    if (document.querySelector("dialog[open]")) return;
    const active = document.activeElement;
    const tag = active?.tagName;
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(tag);
    const interactive =
      ["BUTTON", "A", "SUMMARY"].includes(tag) || active?.isContentEditable;
    if (event.key === "/" && !typing && !interactive) {
      event.preventDefault();
      els.search.focus();
    }
    if (
      event.code === "Space" &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !typing &&
      !interactive &&
      state.current &&
      window.ZakAudio.is("library")
    ) {
      event.preventDefault();
      playerAdapter.toggle();
    }
  });

  // Keep the sticky toolbar flush under the sticky app header.
  function syncStickyOffset() {
    const rail = document.querySelector(".app-rail");
    const style = rail ? getComputedStyle(rail) : null;
    const pinned =
      style && (style.position === "sticky" || style.position === "fixed");
    const height = pinned ? Math.round(rail.getBoundingClientRect().height) : 0;
    els.page.style.setProperty("--library-sticky-top", `${height}px`);
  }
  function syncCompactToolbar() {
    if (!onLibrary()) return;
    const top =
      Number.parseFloat(
        els.page.style.getPropertyValue("--library-sticky-top"),
      ) || 0;
    const stuck = els.toolbar.classList.contains("is-stuck");
    // Leave a small dead band when scrolling back past the sticky edge.
    // The toolbar's own 12px collapse must not immediately expand it.
    const edge = top + (stuck ? 16 : 1);
    els.toolbar.classList.toggle(
      "is-stuck",
      compact.matches &&
        window.scrollY > 0 &&
        els.toolbar.getBoundingClientRect().top <= edge,
    );
  }
  syncStickyOffset();
  window.addEventListener("scroll", syncCompactToolbar, { passive: true });
  window.addEventListener(
    "resize",
    () => {
      syncStickyOffset();
      syncCompactToolbar();
    },
    { passive: true },
  );
  if ("ResizeObserver" in window) {
    const rail = document.querySelector(".app-rail");
    if (rail) new ResizeObserver(syncStickyOffset).observe(rail);
  }

  // -------------------------------------------------------------- loading

  function acceptTracks(tracks) {
    state.tracks = tracks;
    state.catalogKey = `${tracks.length}:${tracks[0]?.id || ""}:${tracks.at(-1)?.id || ""}`;
    buildEntries(tracks);
    state.status = "ready";
    state.error = null;
    onAirKey = "";
    renderOnAir();
  }

  async function loadLibrary(force = false) {
    try {
      acceptTracks(await window.ZakCatalog.load(force));
      refresh();
      if (state.editor) {
        renderEditorMembers();
        renderEditorMatches();
      }
      return true;
    } catch (error) {
      state.status = "error";
      state.error = error;
      refresh();
      return false;
    }
  }

  window.ZakCatalog.subscribe((tracks) => {
    acceptTracks(tracks);
    if (state.current) {
      const replacement = tracks.find((track) => track.id === state.current.id);
      if (replacement) {
        state.current = replacement;
      } else if (window.ZakAudio.is("library")) {
        window.ZakAudio.pause();
        window.ZakAudio.clear("library");
        state.current = null;
      }
    }
    // Track stats change while people listen; don't yank an open menu away.
    if (menuOpen()) state.refreshAfterMenu = true;
    else refresh();
    if (state.editor) {
      renderEditorMembers();
      renderEditorResults();
      renderEditorMatches();
    }
    window.ZakPlayer?.update?.();
  });

  // A like here reaches the list with the stats the server confirms (the
  // catalog update above); one made in another tab arrives through storage.
  window.addEventListener("storage", (event) => {
    if (
      state.filter === "mine" &&
      (!event.key || event.key.startsWith("zak-reaction:"))
    )
      refresh();
  });

  if (onLibrary()) {
    const params = paramsFromURL();
    if (params.present) adoptParams(params);
  }
  registerPlayer();
  refresh();
  renderStations();
  loadLibrary();
  if (window.ZakStations?.failed) {
    state.stationsFailed = true;
    renderStations();
  }
  if (onLibrary() && window.location.hash === "#stations")
    setStationsOpen(true);
}
