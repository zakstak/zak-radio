import { PLAY_ICON } from "./player.js";
import { SCROLL_KEYS } from "./motion.js";
import { focusBeside } from "./router.js";
import { plural, timeLabel as t, setText as setReaderText } from "./format.js";
import { problemCopy, problemKind, problemState } from "./problem.js";

const SOURCE_LABELS = {
  html: "Web page",
  htm: "Web page",
  web: "Web page",
  pdf: "PDF",
  text: "Text",
  txt: "Text",
  markdown: "Text",
  md: "Text",
};
const CHEVRON_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6"></path></svg>';
const FILTER_VALUES = [
  "all",
  "ready",
  "not-ready",
  "attention",
  "finished",
  "hidden",
];
// The list's heading names what the filter shows.
const FILTER_TITLES = {
  all: "All items",
  ready: "Ready to listen",
  "not-ready": "Not ready",
  attention: "Needs attention",
  finished: "Finished",
  hidden: "Hidden",
};
const HIDDEN_KEY = "zak-reader-hidden";
const CONTINUE_HINT_KEY = "zak-reader-continue-count";
const SORT_VALUES = ["newest", "recent", "title", "duration"];

// Processing notes are written for the pipeline. Say the same things in
// listener language; anything unrecognized is shown as written.
const WARNING_WORDS = [
  [
    /subscription wall|paywall/i,
    () =>
      "This site needs a subscription, so Reader couldn’t get the full text.",
  ],
  [
    /could not be fully extracted|partially extracted/i,
    () => "Reader couldn’t get all of the text from this page.",
  ],
  [
    /narration was not generated/i,
    () => "Narration isn’t available for this item.",
  ],
  [
    /language detected:\s*([^()]+?)\s*\(voice is ([^)]+)\)/i,
    (match) =>
      `The text is in ${match[1].trim()}, but the narrator reads in ${match[2].trim()}, so it may sound wrong.`,
  ],
  [
    /^(\d+) tables? (?:were|was) flattened into prose$/i,
    (match) =>
      `${match[1]} ${match[1] === "1" ? "table is" : "tables are"} read as plain text.`,
  ],
  [
    /^page headers repeated on (\d+) pages were removed$/i,
    (match) => `Page headers that repeated on ${match[1]} pages were left out.`,
  ],
];

function listenerWarning(text) {
  for (const [pattern, words] of WARNING_WORDS) {
    const match = pattern.exec(text);
    if (match) return words(match);
  }
  return text;
}
// Connection failures read the same as in Radio and Library (problem.js).
function itemErrorCopy(kind) {
  if (kind === "not-found")
    return {
      title: "We can’t find this article",
      text: "It may have been removed, or the link may be incomplete.",
    };
  return problemCopy(kind);
}

// Small element builder: h("p", { className: "x", text: "Hi" }, child…).
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key === "onclick") node.addEventListener("click", value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  node.append(
    ...children.flat().filter((child) => child !== null && child !== false),
  );
  return node;
}

// Case- and accent-insensitive text for search and title comparison.
function fold(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function sourceType(item) {
  return String(item?.source_type || "").toLowerCase();
}

function sourceLabel(item) {
  return SOURCE_LABELS[sourceType(item)] || "";
}

function failedNoun(item) {
  const type = sourceType(item);
  if (type === "pdf") return "PDF";
  return SOURCE_LABELS[type] === "Text" ? "file" : "page";
}

function siteLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function publishedLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return "";
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function errorKind(error) {
  const kind = problemKind(error);
  if (kind === "notfound") return "not-found";
  return kind === "busy" ? "server" : kind;
}

function notify(message, options) {
  return window.ZakNotify?.(message, options);
}

function notifyPlayer() {
  window.ZakPlayer?.update();
  window.ZakRefreshTitle?.();
}

export function initReader({ router }) {
  const supportedPlaybackRates = [0.75, 0.9, 1, 1.15, 1.25, 1.5, 1.75, 2];
  const storedPlaybackRate = Number(
    window.ZakStorage.get("readerPlaybackRate", "1.15"),
  );
  const desktopQuery = window.matchMedia(
    "(min-width: 768px) and (min-height: 501px)",
  );
  const state = {
    items: [],
    filtered: [],
    item: null,
    segments: [],
    images: [],
    index: 0,
    totalDuration: 0,
    position: 0,
    playbackRate: supportedPlaybackRates.includes(storedPlaybackRate)
      ? storedPlaybackRate
      : 1.15,
    lastSavedAt: 0,
    saveTimer: 0,
    loadGeneration: 0,
    loadAbort: null,
    metadataHandler: null,
    loaded: false,
    loading: null,
    bootComplete: false,
    bootGeneration: 0,
    bootAbort: null,
    refreshTimer: 0,
    activePlayback: null,
    imagesError: false,
    saveQueue: Promise.resolve(),
    playbackRevisions: Object.create(null),
    resumeReady: Object.create(null),
    resumeError: false,
    resumeConflict: false,
    bootError: false,
    needsRefresh: false,
    attemptedID: "",
    itemLoading: null,
    itemError: "",
    textError: "",
    saveErrors: Object.create(null),
    saveErrorNotified: false,
    localPlayback: Object.create(null),
    localProgress: Object.create(null),
    showingLibrary: false,
    filter: "all",
    sort: "newest",
    segmentsLoading: false,
    writerID: "",
    writerSequence: 0,
    effectiveDurations: Object.create(null),
    durationWarning: null,
    following: true,
    listScroll: 0,
    listFetchedAt: 0,
    listRefresh: null,
    announceTimer: 0,
    loadingTitle: "",
    // Items this browser hid from Reader. Stored here only; hiding never
    // deletes anything.
    hidden: new Set(readHidden()),
    lastSection: "",
    // The opened item shows "You stopped here" until narration plays.
    resumeMark: false,
    // The item still being narrated while another one is open (see
    // inPlayback), and whether its context is swapped in right now.
    parked: null,
    detached: false,
  };

  function readHidden() {
    try {
      const value = JSON.parse(window.ZakStorage.get(HIDDEN_KEY, "[]"));
      return Array.isArray(value)
        ? value.filter((id) => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  }

  function saveHidden() {
    window.ZakStorage.set(HIDDEN_KEY, JSON.stringify([...state.hidden]));
  }
  let readerScrollGeneration = 0;
  window.addEventListener(
    "scroll",
    () => {
      readerScrollGeneration++;
    },
    { passive: true },
  );

  const els = {
    view: document.getElementById("readerView"),
    items: document.getElementById("readerItems"),
    continue: document.getElementById("readerContinue"),
    continueItems: document.getElementById("readerContinueItems"),
    count: document.getElementById("readerCount"),
    listStatus: document.getElementById("readerListStatus"),
    search: document.getElementById("readerSearch"),
    sort: document.getElementById("readerSort"),
    hero: document.getElementById("readerHero"),
    main: document.getElementById("readerMain"),
    head: document.getElementById("readerItemHead"),
    libraryTitle: document.getElementById("readerLibraryTitle"),
    title: document.getElementById("readerTitle"),
    meta: document.getElementById("readerMeta"),
    details: document.getElementById("readerDetails"),
    notices: document.getElementById("readerNotices"),
    actions: document.getElementById("readerActions"),
    resume: document.getElementById("readerResume"),
    resumeLabel: document.getElementById("readerResumeLabel"),
    original: document.getElementById("readerOriginal"),
    source: document.getElementById("readerSource"),
    hint: document.getElementById("readerHint"),
    notes: document.getElementById("readerNotes"),
    notesSummary: document.getElementById("readerNotesSummary"),
    notesList: document.getElementById("readerNotesList"),
    toc: document.getElementById("readerToc"),
    tocCount: document.getElementById("readerTocCount"),
    tocList: document.getElementById("readerTocList"),
    tocNav: document.getElementById("readerTocNav"),
    tocOpen: document.getElementById("readerTocOpen"),
    tocSheet: document.getElementById("readerTocSheet"),
    tocSheetBody: document.getElementById("readerTocSheetBody"),
    tocSheetClose: document.getElementById("readerTocSheetClose"),
    more: document.getElementById("readerMore"),
    moreMenu: document.getElementById("readerMoreMenu"),
    finish: document.getElementById("readerFinish"),
    originalItem: document.getElementById("readerOriginalItem"),
    sourceItem: document.getElementById("readerSourceItem"),
    hide: document.getElementById("readerHide"),
    itemStatus: document.getElementById("readerItemStatus"),
    hiddenFilter: document.querySelector('[data-reader-filter="hidden"]'),
    attentionFilter: document.querySelector('[data-reader-filter="attention"]'),
    allTitle: document.getElementById("readerAllTitle"),
    textOpen: document.getElementById("readerTextOpen"),
    textMenu: document.getElementById("readerTextMenu"),
    text: document.getElementById("readerText"),
    audio: window.ZakAudio.element,
    libraryBack: document.getElementById("readerLibraryBack"),
  };

  const listening = document.getElementById("readerListening");
  const itemTime = document.getElementById("readerItemTime");
  const itemProgress = document.getElementById("readerItemProgress");
  function renderListening() {
    if (state.detached) return;
    const playable = Boolean(
      state.item && !state.itemError && state.segments.some(isPlayable),
    );
    listening.hidden = !playable;
    if (!playable) return;
    const position = Math.min(absoluteOffset(), state.totalDuration);
    setReaderText(
      itemTime,
      state.item.status === "ready"
        ? `${t(position)} of ${t(state.totalDuration)} · ${Math.round(state.totalDuration > 0 ? (position / state.totalDuration) * 100 : 0)}%`
        : `${t(state.totalDuration)} narrated so far · at ${t(position)}`,
    );
    itemProgress.max = state.totalDuration || 1;
    itemProgress.value = position;
    itemProgress.setAttribute(
      "aria-valuetext",
      state.item.status === "ready"
        ? `${t(position)} of ${t(state.totalDuration)}`
        : `At ${t(position)} · ${t(state.totalDuration)} narrated so far`,
    );
  }

  const api = window.ZakAPI;

  function readerWriterID() {
    if (state.writerID) return state.writerID;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    state.writerID = Array.from(bytes, (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    return state.writerID;
  }

  async function paged(path, key, options = {}) {
    const { onPage, ...requestOptions } = options;
    const result = [];
    const seen = new Set();
    const seenCursors = new Set();
    let offset = 0;
    let cursor = "";
    let pages = 0;
    for (;;) {
      if (cursor) {
        if (seenCursors.has(cursor))
          throw new Error("Pagination cursor cycle detected");
        seenCursors.add(cursor);
      }
      if (++pages > 1000)
        throw new Error("Pagination exceeded its page budget");
      const separator = path.includes("?") ? "&" : "?";
      const pagination = cursor
        ? `cursor=${encodeURIComponent(cursor)}`
        : `offset=${offset}`;
      const payload = await api(
        `${path}${separator}${pagination}`,
        requestOptions,
      );
      for (const value of payload[key] || []) {
        const identity =
          value && typeof value === "object" && value.id !== undefined
            ? `id:${value.id}`
            : value &&
                typeof value === "object" &&
                value.segment_index !== undefined
              ? `segment:${value.segment_index}`
              : `value:${JSON.stringify(value)}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        result.push(value);
      }
      if (onPage) onPage(result.slice(), payload);
      if (payload.next_cursor !== undefined && payload.next_cursor !== null) {
        if (
          typeof payload.next_cursor !== "string" ||
          !payload.next_cursor ||
          seenCursors.has(payload.next_cursor)
        )
          throw new Error("Pagination cursor did not advance");
        cursor = payload.next_cursor;
        continue;
      }
      if (payload.next_offset === undefined || payload.next_offset === null)
        return result;
      const next = Number(payload.next_offset);
      if (!Number.isInteger(next) || next <= offset)
        throw new Error("Pagination offset did not advance");
      offset = next;
    }
  }

  function itemHref(id) {
    const url = new URL("/reader", window.location.origin);
    url.searchParams.set("item", id);
    return `${url.pathname}${url.search}`;
  }

  function readySegmentCount(item) {
    if (state.item?.id === item.id && state.segments.length)
      return state.segments.filter((segment) => segment.status === "ready")
        .length;
    const count = Number(item.ready_segment_count);
    return Number.isFinite(count) ? count : null;
  }

  function narrationCounts() {
    const segments = state.segments;
    return {
      ready: segments.filter(isPlayable).length,
      total: segments.length,
    };
  }

  // Human status for an item: never internal keys, voices, or backends.
  // Statuses use the filter names: Ready, Not ready (with how far along),
  // and Needs attention (with why).
  function statusInfo(item) {
    if (item.status === "ready") return { label: "Ready", tone: "ready" };
    if (item.status === "processing") {
      const ready = readySegmentCount(item);
      const total = Number(item.segment_count) || state.segments.length;
      return {
        label:
          ready !== null && total > 0
            ? `Not ready · ${ready} of ${total} parts narrated`
            : "Not ready · narrating",
        tone: "progress",
      };
    }
    if (item.status === "failed")
      return {
        label: `Needs attention · couldn’t read the ${failedNoun(item)}`,
        short: "Needs attention",
        tone: "failed",
      };
    return { label: "Not ready · waiting to start", tone: "waiting" };
  }

  function progressOf(item) {
    const duration = Number(item.total_duration) || 0;
    const local = state.localProgress[item.id];
    const serverAt = Number(item.listened_at) || 0;
    let seconds =
      item.listened_seconds === null || item.listened_seconds === undefined
        ? null
        : Number(item.listened_seconds);
    let at = serverAt;
    if (local && local.at >= serverAt) {
      seconds = local.seconds;
      at = local.at;
    }
    if (seconds === null || !Number.isFinite(seconds) || duration <= 0)
      return { started: false, finished: false, position: 0, duration, at };
    const position = Math.max(0, Math.min(seconds, duration));
    const finished = item.status === "ready" && position >= duration - 0.75;
    return {
      started: position >= 1 && !finished,
      finished,
      position,
      duration,
      at,
    };
  }

  function rememberProgress(itemID, seconds) {
    if (!Number.isFinite(seconds)) return;
    state.localProgress[itemID] = { seconds, at: Date.now() / 1000 };
  }

  // Hidden items leave every list except "Hidden"; finished items stay in
  // the list, marked, and leave Continue listening.
  function applyReaderFilters() {
    const tokens = fold(els.search.value).split(" ").filter(Boolean);
    state.filtered = state.items.filter((item) => {
      const ready = item.status === "ready";
      const hidden = state.hidden.has(item.id);
      if (state.filter === "hidden") {
        if (!hidden) return false;
      } else if (hidden) return false;
      const failed = item.status === "failed";
      const matchesFilter =
        state.filter === "all" ||
        state.filter === "hidden" ||
        (state.filter === "ready" && ready) ||
        (state.filter === "not-ready" && !ready && !failed) ||
        (state.filter === "attention" && failed) ||
        (state.filter === "finished" && progressOf(item).finished);
      if (!matchesFilter) return false;
      if (!tokens.length) return true;
      const haystack = fold(
        `${item.title} ${item.author || ""} ${siteLabel(item.source_url)} ${sourceLabel(item)} ${statusInfo(item).label}`,
      );
      return tokens.every((token) => haystack.includes(token));
    });
    const collator = new Intl.Collator(undefined, {
      sensitivity: "base",
      numeric: true,
    });
    const newest = (a, b) =>
      Number(b.uploaded_at || 0) - Number(a.uploaded_at || 0);
    if (state.sort === "title") {
      state.filtered.sort((a, b) =>
        collator.compare(a.title || "", b.title || ""),
      );
    } else if (state.sort === "duration") {
      state.filtered.sort(
        (a, b) => Number(b.total_duration || 0) - Number(a.total_duration || 0),
      );
    } else if (state.sort === "recent") {
      state.filtered.sort(
        (a, b) => progressOf(b).at - progressOf(a).at || newest(a, b),
      );
    } else {
      state.filtered.sort(newest);
    }
  }

  function visibleItems() {
    return state.items.filter((item) => !state.hidden.has(item.id));
  }

  function countLabel() {
    const total = visibleItems().length;
    if (state.filter === "hidden")
      return plural(state.filtered.length, "hidden item");
    const narrowed = state.filtered.length !== total;
    return narrowed
      ? `${state.filtered.length.toLocaleString()} of ${plural(total, "item")}`
      : plural(total, "item");
  }

  function scheduleListAnnouncement() {
    window.clearTimeout(state.announceTimer);
    state.announceTimer = window.setTimeout(() => {
      setReaderText(
        els.listStatus,
        state.filtered.length ? `Showing ${countLabel()}.` : "No items match.",
      );
    }, 700);
  }

  function statusLine(item) {
    const status = statusInfo(item);
    return h("span", {
      className: `reader-status is-${status.tone}`,
      text: status.label,
    });
  }

  function progressLine(progress) {
    const percent = Math.max(
      0,
      Math.min(100, (progress.position / progress.duration) * 100),
    );
    return h(
      "span",
      { className: "reader-card-progress tabular" },
      h(
        "span",
        { className: "reader-meter", "aria-hidden": "true" },
        h("span", { style: `width: ${percent.toFixed(1)}%` }),
      ),
      h("span", {
        className: "tabular",
        text: `${t(progress.position)} of ${t(progress.duration)}`,
      }),
    );
  }

  function cardMeta(item) {
    const duration = Number(item.total_duration) || 0;
    return [
      sourceLabel(item),
      item.author || siteLabel(item.source_url),
      duration > 0
        ? `${t(duration)}${item.status === "ready" ? "" : " narrated so far"}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  // One verb per action: "Open" shows the item, and the card itself does
  // that; "Resume" is a button of its own on Continue listening cards, and
  // starts narration where you left off.
  function updateTitleReveal(card) {
    const title = card.querySelector(".reader-card-title");
    card.classList.toggle(
      "is-title-truncated",
      title.scrollHeight > title.clientHeight + 1,
    );
  }

  function listCard(item, { resume = false } = {}) {
    const progress = progressOf(item);
    const link = h(
      "a",
      {
        className: `reader-card${resume ? " is-continue" : ""}`,
        href: itemHref(item.id),
        dataset: { itemId: item.id, list: resume ? "continue" : "all" },
      },
      h("h4", {
        className: "reader-card-title",
        text: item.title || "Untitled",
      }),
      h("span", {
        className: "reader-card-title-reveal",
        "aria-hidden": "true",
        text: item.title || "Untitled",
      }),
      h("span", {
        className: "reader-card-meta tabular",
        text: cardMeta(item),
      }),
      progress.started ? progressLine(progress) : null,
      h(
        "span",
        { className: "reader-card-foot" },
        state.hidden.has(item.id)
          ? h("span", {
              className: "reader-status is-hidden",
              text: progress.finished ? "Finished · hidden" : "Hidden",
            })
          : progress.finished
            ? h("span", {
                className: "reader-status is-finished",
                text: "Finished",
              })
            : statusLine(item),
        resume
          ? null
          : h(
              "span",
              { className: "reader-card-action" },
              "Open",
              h("span", { html: CHEVRON_ICON }),
            ),
      ),
    );
    link.addEventListener("click", (event) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      openFromList(item.id);
    });
    link.addEventListener("pointerenter", () => updateTitleReveal(link));
    link.addEventListener("focus", () => updateTitleReveal(link));
    if (!resume) return h("li", {}, link);
    const play = h(
      "button",
      {
        type: "button",
        className: "button reader-card-resume",
        "aria-label": `Resume “${item.title || "Untitled"}” from ${t(progress.position)}`,
        dataset: { itemId: item.id, list: "resume" },
        html: PLAY_ICON,
      },
      "Resume",
    );
    play.addEventListener("click", () =>
      openFromList(item.id, { autoplay: true }),
    );
    return h("li", { className: "reader-continue-item" }, link, play);
  }

  // Up to three items in progress, most recent first. They leave "All
  // items" while they're shown here, so nothing is listed twice.
  function continueCandidates() {
    const searching = Boolean(els.search.value.trim());
    if (searching || state.filter !== "all" || state.bootError) return [];
    return visibleItems()
      .filter((item) => progressOf(item).started)
      .sort((a, b) => progressOf(b).at - progressOf(a).at)
      .slice(0, 3);
  }

  function renderContinue(candidates = continueCandidates()) {
    els.continue.hidden = !candidates.length;
    els.continueItems.replaceChildren(
      ...candidates.map((item) => listCard(item, { resume: true })),
    );
    if (state.bootComplete)
      window.ZakStorage.set(CONTINUE_HINT_KEY, String(candidates.length));
    return candidates;
  }

  function emptyListState() {
    if (!state.items.length) {
      return h(
        "li",
        { className: "reader-list-state" },
        h(
          "div",
          { className: "empty-state" },
          h("strong", { text: "Nothing in Reader yet." }),
          h("p", {
            text: "Articles and documents saved to Reader appear here, ready to read and listen to.",
          }),
        ),
      );
    }
    const query = els.search.value.trim();
    const actions = h("div", { className: "state-actions" });
    if (query)
      actions.append(
        h("button", {
          type: "button",
          className: "button",
          text: "Clear search",
          dataset: { readerAction: "clear-search" },
          onclick: () => {
            els.search.value = "";
            renderList();
            writeListURL();
            els.search.focus();
          },
        }),
      );
    if (state.filter !== "all")
      actions.append(
        h("button", {
          type: "button",
          className: "button",
          text: "Show all items",
          dataset: { readerAction: "show-all" },
          onclick: () => setFilter("all", { focus: true }),
        }),
      );
    else if (!query && state.hidden.size)
      actions.append(
        h("button", {
          type: "button",
          className: "button",
          text: "Show hidden items",
          dataset: { readerAction: "show-hidden" },
          onclick: () => setFilter("hidden", { focus: true }),
        }),
      );
    return h(
      "li",
      { className: "reader-list-state" },
      h(
        "div",
        { className: "empty-state" },
        h("strong", {
          text: query
            ? `Nothing matches “${query}”.`
            : state.filter === "finished"
              ? "No finished items yet"
              : "Nothing to show here.",
        }),
        h("p", {
          text: query
            ? "Check the spelling, or search by title, author, or site."
            : state.filter === "ready"
              ? "No items are ready to listen to yet."
              : state.filter === "finished"
                ? "Items you listen to the end appear here."
                : state.filter === "hidden"
                  ? "Nothing is hidden."
                  : state.filter === "not-ready"
                    ? "Nothing is waiting for narration."
                    : state.filter === "attention"
                      ? "Every item was read without problems."
                      : "Every item is hidden. Show hidden items to see them.",
        }),
        actions,
      ),
    );
  }

  function updateActiveTitleReveals() {
    els.view
      .querySelectorAll(".reader-card:is(:hover, :focus)")
      .forEach(updateTitleReveal);
  }
  window.addEventListener("resize", updateActiveTitleReveals, {
    passive: true,
  });
  document.fonts.ready.then(updateActiveTitleReveals);

  function renderList() {
    if (state.bootError) return;
    applyReaderFilters();
    const focused = document.activeElement?.closest?.("[data-item-id]");
    const focusedKey = focused
      ? `${focused.dataset.list}:${focused.dataset.itemId}`
      : "";
    const continuing = new Set(renderContinue().map((item) => item.id));
    const listed = state.filtered.filter((item) => !continuing.has(item.id));
    els.items.replaceChildren(...listed.map((item) => listCard(item)));
    if (!state.filtered.length) els.items.append(emptyListState());
    else if (!listed.length)
      els.items.append(
        h(
          "li",
          { className: "reader-list-state reader-list-note" },
          "Everything else is in Continue listening above.",
        ),
      );
    // The count matches the cards under it: items shown in Continue
    // listening aren't repeated here. Phones show the sort as an icon; the
    // count says which order it is. With nothing to show, the empty state
    // says so instead.
    const countText =
      continuing.size && listed.length
        ? plural(listed.length, "more item")
        : countLabel();
    const sortText = els.sort.selectedOptions[0]?.textContent || "";
    if (els.count.dataset.key !== `${countText}|${sortText}`) {
      els.count.dataset.key = `${countText}|${sortText}`;
      els.count.replaceChildren(
        countText,
        h("span", { className: "list-sort-note", text: ` · ${sortText}` }),
      );
    }
    els.count.hidden = !state.filtered.length;
    setReaderText(
      els.allTitle,
      els.search.value.trim() && state.filter === "all"
        ? "Matching items"
        : FILTER_TITLES[state.filter] || FILTER_TITLES.all,
    );
    els.hiddenFilter.hidden = !state.hidden.size && state.filter !== "hidden";
    // Keep the filter row stable while the list arrives, including when no
    // items currently need attention.
    els.attentionFilter.hidden = false;
    if (focusedKey && !focused.isConnected) {
      const [list, id] = focusedKey.split(/:(.*)/s);
      els.view
        .querySelector(
          `[data-list="${list}"][data-item-id="${CSS.escape(id)}"]`,
        )
        ?.focus({ preventScroll: true });
    }
  }

  // Placeholders keep the shape of what replaces them. Continue listening
  // gets as many as it showed last time, so the list doesn't jump down.
  function skeletonCard() {
    return h(
      "li",
      { "aria-hidden": "true" },
      h(
        "div",
        { className: "reader-card is-skeleton" },
        h("span", { className: "skeleton reader-skeleton-title" }),
        h("span", { className: "skeleton reader-skeleton-line" }),
        h("span", { className: "skeleton reader-skeleton-short" }),
      ),
    );
  }

  function renderListSkeleton() {
    // Most visits have something in progress; one placeholder row holds
    // its place until the list says otherwise.
    const continuing = Math.max(
      0,
      Math.min(3, Number(window.ZakStorage.get(CONTINUE_HINT_KEY, "1")) || 0),
    );
    const searching =
      Boolean(els.search.value.trim()) || state.filter !== "all";
    els.continue.hidden = searching || !continuing;
    els.continueItems.replaceChildren(
      ...Array.from({ length: searching ? 0 : continuing }, skeletonCard),
    );
    delete els.count.dataset.key;
    els.count.hidden = false;
    setReaderText(els.count, "Loading…");
    els.items.replaceChildren(...[0, 1, 2, 3].map(skeletonCard));
  }

  function syncListControls() {
    document.querySelectorAll("[data-reader-filter]").forEach((candidate) => {
      candidate.setAttribute(
        "aria-pressed",
        String(candidate.dataset.readerFilter === state.filter),
      );
    });
    if (els.sort.value !== state.sort) els.sort.value = state.sort;
  }

  function setFilter(filter, { focus = false } = {}) {
    state.filter = filter;
    syncListControls();
    if (focus)
      document
        .querySelector(`[data-reader-filter="${CSS.escape(filter)}"]`)
        ?.focus();
    renderList();
    writeListURL({
      push: true,
      focus: `[data-reader-filter="${CSS.escape(filter)}"]`,
    });
    scheduleListAnnouncement();
  }

  // Search, filter, and sort live in the address, like Library, so reloads,
  // bookmarks, and Back keep them. An open item keeps them too. A filter or
  // sort change is a history entry; typing in search replaces the entry,
  // except that starting a search is a step of its own.
  function writeListURL({ push = false, focus = "" } = {}) {
    if (!window.location.pathname.startsWith("/reader")) return;
    const url = new URL(window.location.href);
    const put = (key, value, fallback) => {
      if (value && value !== fallback) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    };
    put("q", els.search.value.trim().slice(0, 160), "");
    put("filter", state.filter, "all");
    put("sort", state.sort, "newest");
    if (url.href === window.location.href) return;
    if (push) router.push(url, { focus });
    else router.replace(url);
  }

  function readListURL({ reset = false } = {}) {
    const params = new URLSearchParams(window.location.search);
    if (!reset && !["q", "filter", "sort"].some((key) => params.has(key)))
      return false;
    els.search.value = (params.get("q") || "").slice(0, 160);
    const filter = params.get("filter") || "all";
    state.filter = FILTER_VALUES.includes(filter) ? filter : "all";
    const sort = params.get("sort") || "newest";
    state.sort = SORT_VALUES.includes(sort) ? sort : "newest";
    syncListControls();
    return true;
  }

  function renderLibrary() {
    router.setSkipTarget("readerLibraryTitle");
    state.showingLibrary = true;
    els.hero.hidden = false;
    els.main.hidden = true;
    els.text.inert = false;
    els.text.setAttribute("aria-busy", "false");
    window.clearTimeout(state.refreshTimer);
    els.text.textContent = "";
    clearTitleSegment();
    if (state.item && state.activePlayback?.itemID === state.item.id)
      rememberProgress(state.item.id, absoluteOffset());
    window.ZakAudio.refreshOwner?.();
    renderList();
    notifyPlayer();
    void refreshList();
  }

  function openFromList(id, { autoplay = false } = {}) {
    state.listScroll = window.scrollY;
    loadItem(id, { historyMode: "push", focusDetail: true, autoplay });
  }

  function goBackToList() {
    const previous = state.item?.id || state.attemptedID;
    router.commitScroll();
    const url = new URL(window.location.href);
    url.searchParams.delete("item");
    state.loadAbort?.abort();
    state.loadAbort = null;
    state.loadGeneration++;
    history.pushState({ scroll: [0, state.listScroll] }, "", url);
    renderLibrary();
    restoreListPlace(previous);
  }

  // Returning to the list puts it back where it was, with focus on the card
  // that was opened, however the listener came back.
  function restoreListPlace(previous, scroll = state.listScroll) {
    const apply = () => {
      router.scrollTo({ top: scroll, behavior: "instant" });
      const card =
        previous &&
        (els.items.querySelector(
          `[data-list="all"][data-item-id="${CSS.escape(previous)}"]`,
        ) ||
          els.view.querySelector(`[data-item-id="${CSS.escape(previous)}"]`));
      (card || els.libraryTitle).focus({ preventScroll: true });
      // Continue listening is a swipeable row: line it up on the card, not
      // part way through one.
      const item = card?.closest("#readerContinueItems > li");
      if (item) {
        const list = els.continueItems;
        const pad =
          Number.parseFloat(getComputedStyle(list).scrollPaddingInlineStart) ||
          0;
        list.scrollTo({
          left:
            list.scrollLeft +
            item.getBoundingClientRect().left -
            list.getBoundingClientRect().left -
            pad,
          behavior: "instant",
        });
      }
    };
    apply();
    // The router finishes its own scroll and focus after this; win after it.
    window.requestAnimationFrame(() => window.requestAnimationFrame(apply));
  }

  // Seconds before the given segment, counting only playable segments.
  function offsetBefore(index) {
    let x = 0;
    for (let i = 0; i < index; i++) {
      if (isPlayable(state.segments[i]))
        x += segmentDuration(state.segments[i]);
    }
    return x;
  }

  function ownsSelectedItem() {
    return (
      window.ZakAudio.is("reader") &&
      Boolean(state.item) &&
      state.activePlayback?.itemID === state.item.id
    );
  }

  // Opening another item never stops the narration that is playing: the
  // player and the lock screen keep describing and controlling it until the
  // listener presses Play on the item that is open. The narrated item's
  // context is parked meanwhile and swapped in for playback work (the next
  // part, seeking, the player). While it is swapped in, nothing renders into
  // the open item's page.
  const SESSION_KEYS = [
    "item",
    "segments",
    "index",
    "position",
    "totalDuration",
    "effectiveDurations",
  ];
  function session() {
    return Object.fromEntries(SESSION_KEYS.map((key) => [key, state[key]]));
  }

  function inPlayback(work) {
    const parked = state.parked;
    if (!parked || state.detached) return work();
    const view = session();
    Object.assign(state, parked);
    state.detached = true;
    try {
      return work();
    } finally {
      Object.assign(parked, session());
      Object.assign(state, view);
      state.detached = false;
    }
  }

  function absoluteOffset() {
    const ownsSelected =
      ownsSelectedItem() &&
      Number(state.activePlayback?.segmentIndex) ===
        Number(state.segments[state.index]?.segment_index);
    const position =
      ownsSelected && !els.audio.ended
        ? els.audio.currentTime || 0
        : state.position;
    return offsetBefore(state.index) + position;
  }

  function renderProgress() {
    renderResumeButton();
    updateReaderPositionState();
    notifyPlayer();
  }

  function updateReaderPositionState() {
    if (state.parked && !state.detached) {
      inPlayback(updateReaderPositionState);
      return;
    }
    if (
      !("mediaSession" in navigator) ||
      !window.ZakAudio.is("reader") ||
      !state.item ||
      state.totalDuration <= 0
    )
      return;
    const position = Math.max(
      0,
      Math.min(absoluteOffset(), state.totalDuration),
    );
    try {
      navigator.mediaSession.setPositionState({
        duration: state.totalDuration,
        position,
        playbackRate: state.playbackRate,
      });
    } catch {}
  }

  // The area between the sticky app bar and the docked player.
  function visibleBand() {
    const rail = document.querySelector(".app-rail");
    const railBottom =
      rail && getComputedStyle(rail).position !== "static"
        ? Math.max(0, rail.getBoundingClientRect().bottom)
        : 0;
    const player =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--bottom-chrome",
        ),
      ) || 0;
    return { top: railBottom, bottom: window.innerHeight - player };
  }

  // mode "follow": only scroll when the element is not comfortably visible.
  function scrollToElement(element, mode) {
    const rect = element.getBoundingClientRect();
    const { top, bottom } = visibleBand();
    const margin = 16;
    if (
      mode === "follow" &&
      rect.top >= top + margin &&
      rect.bottom <= bottom - margin
    )
      return;
    const available = Math.max(0, bottom - top);
    const delta =
      mode === "start" || rect.height > available * 0.6
        ? rect.top - top - margin
        : rect.top - top - Math.max(margin, (available - rect.height) / 3);
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.scrollTo({
      top: Math.max(0, window.scrollY + delta),
      behavior: reduced ? "auto" : "smooth",
    });
  }

  function currentSegmentElement() {
    if (state.detached) return null;
    const segment = state.segments[state.index];
    if (!isPlayable(segment) || els.main.hidden) return null;
    const segmentIndex = segment.segment_index;
    return els.main.querySelector(
      `[data-index="${CSS.escape(String(segmentIndex))}"]`,
    );
  }

  function highlight(scroll = true) {
    if (state.detached) return;
    els.main.querySelectorAll("[data-segment].is-current").forEach((el) => {
      el.classList.remove("is-current");
      el.removeAttribute("aria-current");
    });
    const el = currentSegmentElement();
    if (el) {
      el.classList.add("is-current");
      el.setAttribute("aria-current", "true");
      if (scroll && state.following) scrollToElement(el, "follow");
    }
    updateTocCurrent();
    const heading = state.segments.length ? currentHeading() : null;
    if (heading && isPlayingSelected()) announceSection(heading.text);
    else if (heading) state.lastSection = heading.text;
  }

  function isPlayingSelected() {
    return ownsSelectedItem() && !els.audio.paused;
  }

  // Manual scrolling while this item's narration is loaded (playing or
  // paused) stops the page from following it until "Back to narration".
  function pauseFollowing(event) {
    if (
      !state.following ||
      els.main.hidden ||
      !window.location.pathname.startsWith("/reader") ||
      !ownsSelectedItem()
    )
      return;
    if (event?.target?.closest?.("input, select, textarea, [contenteditable]"))
      return;
    state.following = false;
    notifyPlayer();
  }

  function backToNarration() {
    state.following = true;
    const el = currentSegmentElement();
    if (el) {
      scrollToElement(el, "center");
      // The player's button hides once following resumes; keep focus with
      // the narration instead of dropping it.
      focusSegment(el);
    }
    notifyPlayer();
  }

  window.addEventListener("wheel", pauseFollowing, { passive: true });
  window.addEventListener("touchmove", pauseFollowing, { passive: true });
  window.addEventListener("pointerdown", (event) => {
    // A press on the page scrollbar lands on the root element.
    if (event.target === document.documentElement) pauseFollowing(event);
  });
  window.addEventListener("keydown", (event) => {
    if (!SCROLL_KEYS.has(event.key) || event.metaKey || event.ctrlKey) return;
    if (
      event.key === " " &&
      event.target?.closest?.("button, a, summary, [role=button]")
    )
      return;
    pauseFollowing(event);
  });

  const actionRate = document.getElementById("readerActionRate");
  actionRate.replaceChildren(
    ...supportedPlaybackRates.map((rate) =>
      h("option", { value: String(rate), text: `${rate}×` }),
    ),
  );
  actionRate.value = String(state.playbackRate);
  actionRate.addEventListener("change", () =>
    setPlaybackRate(actionRate.value),
  );

  function applyPlaybackRate() {
    if (!supportedPlaybackRates.includes(state.playbackRate))
      state.playbackRate = 1.15;
    if (window.ZakAudio.is("reader"))
      els.audio.playbackRate = state.playbackRate;
    updateReaderPositionState();
  }

  function setPlaybackRate(value) {
    const rate = Number(value);
    state.playbackRate = supportedPlaybackRates.includes(rate) ? rate : 1.15;
    window.ZakStorage.set("readerPlaybackRate", String(state.playbackRate));
    applyPlaybackRate();
    actionRate.value = String(state.playbackRate);
    renderListening();
    notifyPlayer();
  }

  function loadAudio(position = 0, play = false) {
    if (!state.item || state.resumeReady[state.item.id] !== true) return false;
    if (play) clearResumePoint();
    if (!isPlayable(state.segments[state.index])) {
      state.index = state.segments.findIndex(isPlayable);
    }
    let seg = state.segments[state.index];
    if (!seg || seg.status !== "ready") return false;
    if (
      play &&
      position >= segmentDuration(seg) &&
      nextPlayableIndex(state.index) < 0
    ) {
      state.index = state.segments.findIndex(isPlayable);
      position = 0;
      seg = state.segments[state.index];
    }
    if (
      state.activePlayback &&
      (state.activePlayback.itemID !== state.item.id ||
        Number(state.activePlayback.segmentIndex) !== Number(seg.segment_index))
    ) {
      savePlayback(!els.audio.paused, true);
    }
    window.clearTimeout(state.saveTimer);
    state.saveTimer = 0;
    const src = `/reader-media/${encodeURIComponent(state.item.id)}/${seg.segment_index}.mp3`;
    if (state.metadataHandler) {
      els.audio.removeEventListener("loadedmetadata", state.metadataHandler);
      state.metadataHandler = null;
    }
    // Playing the open item ends the parked narration.
    if (!state.detached) state.parked = null;
    const changed = window.ZakAudio.claim(
      "reader",
      src,
      state.item.title || "Reader audio",
      { resume: play },
    );
    const generation = window.ZakAudio.generation;
    state.activePlayback = {
      itemID: state.item.id,
      segmentIndex: seg.segment_index,
      duration: segmentDuration(seg),
      generation,
    };
    state.position = position;
    if (!changed) els.audio.currentTime = position;
    else {
      const pauseRequests = window.ZakAudio.pauseRequests;
      state.metadataHandler = () => {
        state.metadataHandler = null;
        if (
          !window.ZakAudio.is("reader") ||
          window.ZakAudio.generation !== generation ||
          !els.audio.currentSrc.endsWith(src)
        )
          return;
        els.audio.currentTime = position;
        // An explicit Pause while the segment loads cancels the deferred start.
        if (play && window.ZakAudio.pauseRequests === pauseRequests)
          window.ZakAudio.play();
      };
      els.audio.addEventListener("loadedmetadata", state.metadataHandler, {
        once: true,
      });
    }
    applyPlaybackRate();
    highlight();
    renderProgress();
    if (play && !changed) window.ZakAudio.play();
    return true;
  }

  function stopActivePlayback() {
    state.parked = null;
    if (state.metadataHandler) {
      els.audio.removeEventListener("loadedmetadata", state.metadataHandler);
      state.metadataHandler = null;
    }
    if (!window.ZakAudio.is("reader")) return;
    if (!state.activePlayback) {
      window.ZakAudio.clear("reader");
      return;
    }
    const position = els.audio.currentTime || 0;
    savePlayback(false, true, position);
    window.ZakAudio.pause();
    state.activePlayback = null;
    window.ZakAudio.clear("reader");
  }

  function isPlayable(segment) {
    return segment?.status === "ready" && Number(segment.duration) > 0;
  }

  function segmentDuration(segment) {
    const effective = state.effectiveDurations[String(segment?.segment_index)];
    return Number.isFinite(effective) && effective > 0
      ? effective
      : Number(segment?.duration || 0);
  }

  function refreshTotalDuration() {
    state.totalDuration = state.segments
      .filter(isPlayable)
      .reduce((total, segment) => total + segmentDuration(segment), 0);
  }

  function nextPlayableIndex(after) {
    for (let index = after + 1; index < state.segments.length; index++) {
      if (isPlayable(state.segments[index])) return index;
    }
    return -1;
  }

  function previousPlayableIndex(before) {
    for (let index = before - 1; index >= 0; index--) {
      if (isPlayable(state.segments[index])) return index;
    }
    return -1;
  }

  function imagesForSegment(seg) {
    if (seg.kind !== "heading") return [];
    const key = seg.text.trim().toLowerCase();
    return state.images.filter(
      (img) => (img.figure || "").trim().toLowerCase() === key,
    );
  }

  function appendImage(img) {
    const figure = document.createElement("figure");
    figure.className = "reader-figure";
    const image = document.createElement("img");
    image.loading = "lazy";
    image.src = img.src;
    image.alt = img.alt || img.figure || "Reader image";
    image.addEventListener(
      "error",
      () => {
        const warning = h(
          "div",
          { className: "reader-figure-error" },
          h("span", { text: "This image couldn’t be loaded." }),
          h("button", {
            type: "button",
            className: "button",
            text: "Try again",
            dataset: { readerAction: "retry-image" },
            onclick: () =>
              loadItem(state.item.id, {
                historyMode: "none",
                background: true,
              }),
          }),
        );
        figure.replaceChildren(warning);
      },
      { once: true },
    );
    const cap = document.createElement("figcaption");
    cap.textContent = img.alt || img.figure || "";
    figure.append(image, cap);
    els.text.append(figure);
  }

  function clearTitleSegment() {
    delete els.title.dataset.segment;
    delete els.title.dataset.index;
    els.title.classList.remove("is-current");
  }

  // The first heading usually repeats the item title. The page title then
  // stands in for it, so the text doesn't open with the title twice.
  function titleSegment() {
    const first = state.segments[0];
    return first?.kind === "heading" &&
      state.item &&
      fold(first.text) === fold(state.item.title)
      ? first
      : null;
  }

  function headingDepth(segment) {
    return Array.isArray(segment.heading_path) && segment.heading_path.length
      ? segment.heading_path.length
      : 1;
  }

  function tocEntries() {
    const skip = titleSegment();
    const entries = [];
    state.segments.forEach((segment, position) => {
      if (segment.kind !== "heading" || segment === skip) return;
      entries.push({
        segment,
        position,
        depth: headingDepth(segment),
        start: offsetBefore(position),
      });
    });
    return entries;
  }

  // The first few words of a paragraph, to tell its play button apart.
  function openingWords(text, count = 6) {
    const words = String(text || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const opening = words
      .slice(0, count)
      .join(" ")
      .replace(/[,;:.!?]+$/, "");
    return words.length > count ? `${opening}…` : opening;
  }

  function playFromSegment(position) {
    state.index = position;
    state.following = true;
    loadAudio(0, true);
  }

  // Each playable paragraph has a named "Play from this paragraph" button
  // beside it, so it shows up when a screen reader lists controls, while the
  // paragraph stays text and headings stay headings. The buttons are one tab
  // stop: arrow keys move between them; a tap on the text plays too.
  function segmentElements() {
    return [...els.text.querySelectorAll(".reader-segment.is-playable")];
  }

  function playButtons() {
    return [...els.text.querySelectorAll(".segment-play")];
  }

  function playButtonFor(el) {
    return el?.closest?.(".reader-block")?.querySelector(".segment-play");
  }

  function setPlayStop(button) {
    for (const other of playButtons()) {
      other.tabIndex = other === button ? 0 : -1;
      if (other === button)
        other.setAttribute("aria-describedby", "readerHint");
      else other.removeAttribute("aria-describedby");
    }
  }

  function focusSegment(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const band = visibleBand();
    if (rect.top < band.top + 16 || rect.bottom > band.bottom - 16) {
      router.scrollTo({
        top: Math.max(
          0,
          window.scrollY +
            rect.top -
            band.top -
            Math.max(
              16,
              (band.bottom -
                band.top -
                Math.min(rect.height, band.bottom - band.top)) /
                2,
            ),
        ),
        behavior: "instant",
      });
    }
    const button = el.classList.contains("is-playable")
      ? playButtonFor(el)
      : null;
    if (!button) {
      el.tabIndex = -1;
      el.focus({ preventScroll: true });
      return;
    }
    setPlayStop(button);
    button.focus({ preventScroll: true });
  }

  function focusedSegmentIndex() {
    const active = document.activeElement;
    const segment =
      active?.closest?.("[data-segment]") ||
      active?.closest?.(".reader-block")?.querySelector("[data-segment]");
    return segment?.dataset.index;
  }

  // Opening an item you were partway through marks where you stopped with a
  // quiet rail, until narration plays again. The page opens at its header,
  // with Resume in view.
  function markResumePoint() {
    if (state.detached) return null;
    els.text.querySelector(".reader-resume-mark")?.remove();
    els.text
      .querySelectorAll(".reader-block.is-resume-point")
      .forEach((block) => block.classList.remove("is-resume-point"));
    const block =
      state.item && state.resumeMark
        ? currentSegmentElement()?.closest(".reader-block")
        : null;
    if (!block) return null;
    block.classList.add("is-resume-point");
    block.prepend(
      h(
        "p",
        { className: "reader-resume-mark" },
        h("span", { text: "You stopped here" }),
        h("span", { className: "tabular", text: t(absoluteOffset()) }),
      ),
    );
    return block;
  }

  function clearResumePoint() {
    if (!state.resumeMark || state.detached) return;
    state.resumeMark = false;
    markResumePoint();
  }

  function segmentPosition(el) {
    const index = Number(el?.dataset.index);
    return state.segments.findIndex(
      (segment) => Number(segment.segment_index) === index,
    );
  }

  els.text.addEventListener("click", (event) => {
    if (!state.item) return;
    const button = event.target.closest?.(".segment-play");
    const pending = event.target
      .closest?.(".reader-block")
      ?.querySelector(".reader-segment.is-pending");
    if (pending) {
      notify(
        "This paragraph is not narrated yet. It becomes available when narration is ready.",
      );
      return;
    }
    if (state.resumeReady[state.item.id] !== true) return;
    const el = button
      ? button.closest(".reader-block")?.querySelector(".reader-segment")
      : event.target.closest?.(".reader-segment.is-playable");
    if (!el) return;
    // Selecting text to copy it shouldn't start narration.
    if (!button && !window.getSelection()?.isCollapsed) return;
    const position = segmentPosition(el);
    if (position < 0) return;
    setPlayStop(playButtonFor(el));
    playFromSegment(position);
  });

  els.text.addEventListener("keydown", (event) => {
    const button = event.target.closest?.(".segment-play");
    if (!button || event.metaKey || event.ctrlKey || event.altKey) return;
    const buttons = playButtons();
    const index = buttons.indexOf(button);
    let next = -1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight")
      next = Math.min(buttons.length - 1, index + 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft")
      next = Math.max(0, index - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    if (next < 0) return;
    event.preventDefault();
    setPlayStop(buttons[next]);
    buttons[next].focus({ preventScroll: true });
    const block = buttons[next].closest(".reader-block");
    if (block) scrollToElement(block, "follow");
  });

  function renderText() {
    clearTitleSegment();
    els.text.textContent = "";
    if (!state.item) return;
    if (!state.segments.length) {
      if (state.textError || state.item.status === "failed") return;
      const ready = state.item.status === "ready";
      els.text.append(
        h(
          "div",
          { className: "empty-state" },
          h("strong", {
            text: ready
              ? "This item has no readable text."
              : "The text isn’t ready yet.",
          }),
          h("p", {
            text: ready
              ? "Download the original to read it in another app."
              : "It appears here as soon as Reader has processed it. This page updates automatically.",
          }),
        ),
      );
      return;
    }
    const resumeReady = state.resumeReady[state.item.id] === true;
    const skip = titleSegment();
    if (skip) {
      els.title.dataset.segment = "true";
      els.title.dataset.index = skip.segment_index;
    }
    const headingDepths = state.segments
      .filter((segment) => segment.kind === "heading" && segment !== skip)
      .map(headingDepth);
    const minDepth = headingDepths.length ? Math.min(...headingDepths) : 1;
    const usedImages = new Set();
    state.segments.forEach((seg) => {
      if (seg !== skip) {
        const heading = seg.kind === "heading";
        const quote = seg.kind === "quote";
        const tag = heading
          ? headingDepth(seg) > minDepth
            ? "h4"
            : "h3"
          : quote
            ? "blockquote"
            : "p";
        const playable = isPlayable(seg);
        const el = h(
          tag,
          {
            className: `reader-segment${heading ? " is-heading" : ""}${quote ? " is-quote" : ""}${playable ? (resumeReady ? " is-playable" : " is-waiting") : " is-pending"}`,
            id: `reader-segment-${seg.segment_index}`,
            dataset: { segment: "true", index: seg.segment_index },
          },
          seg.text,
        );
        const block = h("div", {
          className: `reader-block${heading ? " is-heading" : ""}`,
        });
        if (playable && resumeReady) {
          // Each one is named by where it starts, so moving between them
          // says which paragraph is which.
          const label = `Play from “${heading ? seg.text.slice(0, 80) : openingWords(seg.text)}”`;
          block.append(
            h("button", {
              type: "button",
              className: "segment-play",
              tabindex: "-1",
              "aria-label": label,
              title: label,
              html: PLAY_ICON,
            }),
          );
        }
        if (!playable) {
          el.setAttribute("aria-disabled", "true");
          block.append(
            h("button", {
              type: "button",
              className: "reader-pending-label",
              "aria-disabled": "true",
              html:
                state.item?.status === "failed"
                  ? "<span>No narration</span>"
                  : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 7v5l3 2"></path></svg><span>Not narrated yet</span>',
            }),
          );
        }
        block.append(el);
        els.text.append(block);
      }
      for (const img of imagesForSegment(seg)) {
        usedImages.add(img.index);
        appendImage(img);
      }
    });
    const remaining = state.images.filter((img) => !usedImages.has(img.index));
    if (remaining.length) {
      els.text.append(
        h("h3", { className: "reader-images-heading", text: "Images" }),
      );
      for (const img of remaining) appendImage(img);
    }
    // The tab stop sits on the paragraph being narrated, or the first one.
    const current = currentSegmentElement();
    const stop =
      playButtonFor(
        current?.classList.contains("is-playable") ? current : null,
      ) || playButtons()[0];
    if (stop) setPlayStop(stop);
    markResumePoint();
  }

  const TOC_KEY = "zak-reader-toc";
  function tocMemory() {
    try {
      const value = JSON.parse(window.ZakStorage.get(TOC_KEY, "{}"));
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  function tocGuess(id, known) {
    const remembered = tocMemory()[id];
    if (typeof remembered === "boolean") return remembered;
    return Number(known?.segment_count || 0) >= 8;
  }

  function rememberToc(id, show) {
    const memory = tocMemory();
    if (memory[id] === show) return;
    delete memory[id];
    memory[id] = show;
    const keys = Object.keys(memory);
    for (const key of keys.slice(0, Math.max(0, keys.length - 200)))
      delete memory[key];
    window.ZakStorage.set(TOC_KEY, JSON.stringify(memory));
  }

  function renderToc() {
    const entries = tocEntries();
    const show = entries.length >= 2 && !state.itemError;
    if (state.item && !state.segmentsLoading && !state.textError)
      rememberToc(state.item.id, show);
    els.toc.hidden = !show;
    els.tocOpen.hidden = !show;
    els.main.classList.toggle("has-toc", show);
    if (!show) {
      els.tocList.replaceChildren();
      closeTocSheet();
      return;
    }
    setReaderText(els.tocCount, plural(entries.length, "section"));
    const focusedToc = document.activeElement?.dataset?.tocIndex;
    const minDepth = Math.min(...entries.map((entry) => entry.depth));
    // Each section has two separate actions: go to its text, or play the
    // narration from it. Only the play action shows a time.
    const ready = state.item && state.resumeReady[state.item.id] === true;
    els.tocList.replaceChildren(
      ...entries.map((entry) => {
        const playFrom = isPlayable(entry.segment)
          ? entry.position
          : nextPlayableIndex(entry.position);
        return h(
          "li",
          {
            className: `reader-toc-item depth-${Math.min(2, entry.depth - minDepth)}`,
          },
          h(
            "button",
            {
              type: "button",
              className: "reader-toc-link",
              dataset: { tocIndex: entry.segment.segment_index },
              onclick: () => jumpToSegment(entry.segment.segment_index),
            },
            h("span", {
              className: "reader-toc-text",
              text: entry.segment.text,
            }),
          ),
          playFrom >= 0 && ready
            ? h(
                "button",
                {
                  type: "button",
                  className: "reader-toc-play",
                  "aria-label": `Play “${entry.segment.text}” from ${t(entry.start)}`,
                  title: `Play from ${t(entry.start)}`,
                  dataset: { tocPlay: entry.segment.segment_index },
                  onclick: () => {
                    // On phones the Contents sheet closes; focus moves to
                    // the paragraph now being narrated.
                    const fromSheet = els.tocSheet.open;
                    if (fromSheet) closeTocSheet({ returnFocus: false });
                    playFromSegment(playFrom);
                    if (fromSheet || !desktopQuery.matches) {
                      const el = currentSegmentElement();
                      if (el) {
                        scrollToElement(el, "center");
                        focusSegment(el);
                      }
                    }
                    announceSection(entry.segment.text, true);
                  },
                },
                h("span", { html: PLAY_ICON }),
                h("span", { className: "tabular", text: t(entry.start) }),
              )
            : null,
        );
      }),
    );
    if (focusedToc !== undefined)
      els.tocList
        .querySelector(`[data-toc-index="${CSS.escape(focusedToc)}"]`)
        ?.focus({ preventScroll: true });
    updateTocCurrent();
  }

  function currentHeading() {
    const skip = titleSegment();
    for (
      let i = Math.min(state.index, state.segments.length - 1);
      i >= 0;
      i--
    ) {
      const segment = state.segments[i];
      if (segment?.kind === "heading" && segment !== skip) return segment;
    }
    return null;
  }

  function updateTocCurrent() {
    const heading = state.segments.length ? currentHeading() : null;
    const key = heading ? String(heading.segment_index) : "";
    els.tocList.querySelectorAll("[data-toc-index]").forEach((button) => {
      const current = button.dataset.tocIndex === key;
      button.classList.toggle("is-current", current);
      if (current) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
  }

  function jumpToSegment(segmentIndex) {
    const el = els.text.querySelector(
      `[data-index="${CSS.escape(String(segmentIndex))}"]`,
    );
    if (!el) return;
    if (ownsSelectedItem()) {
      state.following = false;
      notifyPlayer();
    }
    if (els.tocSheet.open) closeTocSheet({ returnFocus: false });
    scrollToElement(el, "start");
    focusSegment(el);
  }

  // ---- Contents sheet: chapter access on phones, tablets, and from the
  // player. The same list moves between the side column and the sheet.
  let tocSheetOpener = null;
  function openTocSheet(opener = document.activeElement) {
    if (els.toc.hidden) return;
    if (desktopQuery.matches && !els.main.hidden) {
      // The side column already shows Contents: go to the current section.
      const current =
        els.tocList.querySelector(".reader-toc-link.is-current") ||
        els.tocList.querySelector(".reader-toc-link");
      current?.scrollIntoView({ block: "nearest" });
      current?.focus({ preventScroll: true });
      return;
    }
    tocSheetOpener = opener;
    els.tocSheetBody.append(els.tocNav);
    if (!els.tocSheet.open) els.tocSheet.showModal();
    const current =
      els.tocList.querySelector(".reader-toc-link.is-current") ||
      els.tocList.querySelector(".reader-toc-link");
    current?.scrollIntoView({ block: "center" });
    current?.focus({ preventScroll: true });
  }

  function closeTocSheet({ returnFocus = true } = {}) {
    if (!els.tocSheet.open) return;
    tocSheetReturn = returnFocus;
    els.tocSheet.close();
  }

  let tocSheetReturn = true;
  els.tocSheet.addEventListener("close", () => {
    els.toc.append(els.tocNav);
    const opener = tocSheetOpener;
    tocSheetOpener = null;
    if (tocSheetReturn && opener?.isConnected && !opener.closest("[hidden]"))
      opener.focus({ preventScroll: true });
    tocSheetReturn = true;
  });
  els.tocSheetClose.addEventListener("click", () => closeTocSheet());
  els.tocSheet.addEventListener("click", (event) => {
    if (event.target !== els.tocSheet) return;
    const box = els.tocSheet.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
      closeTocSheet();
  });
  els.tocOpen.addEventListener("click", () => openTocSheet(els.tocOpen));

  // ---- Sections: previous and next from the player ----
  function sectionStarts() {
    return tocEntries()
      .map((entry) => ({
        position: isPlayable(entry.segment)
          ? entry.position
          : nextPlayableIndex(entry.position),
        title: entry.segment.text,
      }))
      .filter((entry) => entry.position >= 0);
  }

  function currentSectionStart(starts = sectionStarts()) {
    let found = null;
    for (const start of starts)
      if (start.position <= state.index) found = start;
    return found;
  }

  // Previous restarts the current section unless it has only just begun.
  function stepSection(direction) {
    if (!state.item || state.resumeReady[state.item.id] !== true) return;
    const starts = sectionStarts();
    if (!starts.length) return;
    const playing = ownsSelectedItem() && !els.audio.paused;
    const current = currentSectionStart(starts);
    let target = null;
    if (direction > 0) {
      target = starts.find((start) => start.position > state.index) || null;
    } else {
      const into = current
        ? absoluteOffset() - offsetBefore(current.position)
        : 0;
      if (current && into > 3) target = current;
      else {
        const before = starts.filter(
          (start) => start.position < (current?.position ?? state.index),
        );
        target = before.at(-1) || {
          position: state.segments.findIndex(isPlayable),
          title: state.item.title || "",
        };
      }
    }
    if (!target || target.position < 0) return;
    state.index = target.position;
    state.following = true;
    // Moving the place doesn't take the audio from Radio or a preview.
    if (ownsSelectedItem()) loadAudio(0, playing);
    else {
      state.position = 0;
      highlight(false);
      renderProgress();
    }
    const el = currentSegmentElement();
    if (el && !els.main.hidden) scrollToElement(el, "follow");
    announceSection(target.title, true);
  }

  // Section changes are announced, briefly, so a screen-reader user knows
  // where the narration is. Paragraph changes are not, to keep it quiet.
  function announceSection(title, force = false) {
    if (!title || els.main.hidden || state.detached) return;
    if (!force && title === state.lastSection) return;
    state.lastSection = title;
    els.itemStatus.textContent = "";
    window.setTimeout(() => {
      els.itemStatus.textContent = force
        ? `Section: ${title}`
        : `Now reading: ${title}`;
    }, 60);
  }

  // An action is a button, or a link when it has an href (Open original
  // page), so it is visible at every width.
  function notice(tone, title, { text = "", list = [], action = null } = {}) {
    return h(
      "div",
      { className: `reader-notice is-${tone}` },
      h(
        "div",
        { className: "reader-notice-copy" },
        h("strong", { text: title }),
        text ? h("p", { text }) : null,
        list.length
          ? h("ul", {}, ...list.map((entry) => h("li", { text: entry })))
          : null,
      ),
      action?.href
        ? h("a", {
            className: "button",
            href: action.href,
            target: action.download ? null : "_blank",
            rel: action.download ? null : "noopener",
            download: action.download ? "" : null,
            text: action.label,
            dataset: { readerAction: action.key },
          })
        : action
          ? h("button", {
              type: "button",
              className: "button",
              text: action.label,
              dataset: { readerAction: action.key },
              onclick: action.run,
            })
          : null,
    );
  }

  function retryInBackground() {
    if (state.item)
      loadItem(state.item.id, { historyMode: "none", background: true });
  }

  function renderNotices() {
    const item = state.item;
    if (!item || state.itemError || state.detached) return;
    const focused = els.notices.contains(document.activeElement)
      ? document.activeElement?.dataset?.readerAction
      : "";
    const warnings = Array.isArray(item.quality_warnings)
      ? item.quality_warnings.filter(Boolean).map(String)
      : [];
    const readable = warnings.map(listenerWarning);
    const { ready: readyParts } = narrationCounts();
    const playable = state.segments.some(isPlayable);
    const notices = [];
    const original = /^https?:\/\//i.test(item.source_url || "")
      ? item.source_url
      : "";
    if (state.textError) {
      // The text didn't load: the reason and Try again sit right under the
      // title, in place of the reading instructions and dead controls.
      notices.push(textErrorBox(state.textError, item.id, original));
    } else if (item.status === "failed") {
      notices.push(
        notice("danger", `Reader couldn’t read this ${failedNoun(item)}.`, {
          text: original
            ? "You can still open the original page."
            : "You can still download the original.",
          list: readable,
          action: original
            ? {
                label: "Open original page",
                key: "open-original",
                href: original,
              }
            : {
                label: "Download original",
                key: "download-original",
                href: `/reader-source/${encodeURIComponent(item.id)}/source`,
                download: true,
              },
        }),
      );
    } else if (item.status === "processing") {
      notices.push(
        notice("info", "Narration is still being prepared.", {
          text: readyParts
            ? `The first ${plural(readyParts, "part")} ${readyParts === 1 ? "is" : "are"} ready. The rest will appear here as narration finishes.`
            : "This page updates as parts become ready.",
        }),
      );
    } else if (item.status !== "ready") {
      notices.push(
        notice("info", "Narration hasn’t started yet.", {
          text: "This page updates automatically when it does.",
        }),
      );
    } else if (!playable && state.segments.length && !state.segmentsLoading) {
      notices.push(
        notice("info", "This item has no narration.", {
          text: "You can still read the text below.",
        }),
      );
    }
    if (state.resumeError) {
      notices.push(
        notice(
          "warning",
          state.resumeConflict
            ? "Your place in this item changed in another tab or on another device."
            : "Your saved place couldn’t be loaded.",
          {
            text: "Playback is paused so your last position isn’t overwritten.",
            action: {
              label: state.resumeConflict ? "Load latest place" : "Try again",
              key: "retry-resume",
              run: retryInBackground,
            },
          },
        ),
      );
    }
    if (state.saveErrors[item.id]) {
      notices.push(
        notice("warning", "Couldn’t save your listening progress.", {
          action: {
            label: "Try again",
            key: "retry-save",
            run: () => retryPlaybackSave(),
          },
        }),
      );
    }
    if (state.imagesError) {
      notices.push(
        notice("info", "Images couldn’t be loaded.", {
          action: {
            label: "Try again",
            key: "retry-images",
            run: retryInBackground,
          },
        }),
      );
    }
    if (state.durationWarning) {
      const { declared, decoded } = state.durationWarning;
      notices.push(
        notice("info", "The timeline was adjusted.", {
          text: `One part of the narration ran ${decoded < declared ? "shorter" : "longer"} than expected (${t(decoded)} instead of ${t(declared)}).`,
        }),
      );
    }
    els.notices.replaceChildren(...notices);
    renderProcessingNotes(item.status === "ready" ? warnings : []);
    if (focused)
      els.notices
        .querySelector(`[data-reader-action="${CSS.escape(focused)}"]`)
        ?.focus({ preventScroll: true });
  }

  // Extraction notes on a ready item are useful context, not alerts, so they
  // stay folded away below the actions.
  function renderProcessingNotes(warnings) {
    const key = warnings.join("\n");
    if (els.notes.dataset.key === key) return;
    els.notes.dataset.key = key;
    els.notes.open = false;
    els.notes.hidden = !warnings.length;
    setReaderText(
      els.notesSummary,
      `About this text · ${plural(warnings.length, "note")}`,
    );
    els.notesList.replaceChildren(
      ...warnings.map((warning) => h("li", { text: listenerWarning(warning) })),
    );
  }

  function renderResumeButton() {
    renderListening();
    const item = state.item;
    if (!item || state.itemError || state.detached) return;
    const playable = state.segments.some(isPlayable);
    els.resume.hidden = !playable;
    if (!playable) return;
    const playing = isPlayingSelected();
    const position = absoluteOffset();
    const atEnd =
      position > 0 && position >= state.totalDuration - 0.5 && !playing;
    setReaderText(
      els.resumeLabel,
      playing
        ? "Pause"
        : atEnd
          ? item.status === "ready"
            ? "Listen again"
            : "Replay available narration"
          : position >= 1
            ? `Resume from ${t(position)}`
            : "Play",
    );
    // SVG elements have no hidden property; the button's class swaps icons.
    els.resume.classList.toggle("is-playing", playing);
    els.resume.disabled = state.resumeReady[item.id] !== true;
  }

  function renderItemHead() {
    const item = state.item;
    if (!item) return;
    els.head.classList.remove("is-error");
    const source = sourceLabel(item);
    setReaderText(els.meta, source);
    els.meta.hidden = !source;
    setReaderText(els.title, item.title || "Untitled");
    els.title.classList.remove("is-loading");
    els.title.classList.toggle("is-long", (item.title || "").length > 70);
    const playable = state.segments.some(isPlayable);
    const status = statusInfo(item);
    if (item.status === "processing" && !state.segmentsLoading) {
      const { ready, total } = narrationCounts();
      status.label = total
        ? `Not ready · ${ready} of ${total} parts narrated`
        : "Not ready · narrating";
    }
    const facts = [
      item.author,
      publishedLabel(item.published_at),
      playable
        ? `${t(state.totalDuration)}${item.status === "ready" ? "" : " narrated so far"}`
        : "",
    ].filter(Boolean);
    els.details.replaceChildren(
      ...[
        status.tone === "ready"
          ? null
          : h("span", {
              className: `badge${status.tone === "failed" ? " is-danger" : status.tone === "progress" ? " is-accent" : ""}`,
              text: status.short || status.label,
            }),
        facts.length
          ? h("span", { className: "tabular", text: facts.join(" · ") })
          : null,
      ].filter(Boolean),
    );
    els.details.hidden = !els.details.childElementCount;
    renderNotices();
    els.actions.hidden = Boolean(state.textError);
    els.main.classList.toggle(
      "has-no-narration",
      !playable && !state.segmentsLoading,
    );
    actionRate.disabled = !playable;
    actionRate.closest("label").hidden = !playable;
    els.textOpen.disabled = false;
    els.more.disabled = false;
    renderResumeButton();
    const original = /^https?:\/\//i.test(item.source_url || "")
      ? item.source_url
      : "";
    els.original.hidden = !original;
    els.originalItem.hidden = !original;
    if (original) {
      els.original.href = original;
      els.originalItem.href = original;
    } else {
      els.original.removeAttribute("href");
      els.originalItem.removeAttribute("href");
    }
    els.source.hidden = false;
    els.source.href = `/reader-source/${encodeURIComponent(item.id)}/source`;
    els.sourceItem.hidden = false;
    els.sourceItem.href = els.source.href;
    // The hint is guidance only, so it shows as soon as there's narration
    // and its line doesn't appear later and push the text down. It goes
    // when the text didn't load: there is nothing to tap.
    els.hint.hidden =
      Boolean(state.textError) ||
      (!playable && item.status !== "ready") ||
      window.ZakStorage.get("zak-reader-tap-hint-seen") === "true";

    els.textOpen.hidden = Boolean(state.textError) || !state.segments.length;
    els.actions.classList.remove("is-loading");
    // Keep a quieter heading when there is no narration to control.
    els.head.classList.toggle(
      "is-quiet",
      !playable && !state.segmentsLoading && !state.textError,
    );
    renderMoreMenu();
  }

  function renderMoreMenu() {
    const item = state.item;
    if (!item || state.detached) return;
    const playable = state.segments.some(isPlayable);
    const finished = progressOf(item).finished;
    els.finish.hidden = !playable || item.status !== "ready";
    els.finish.disabled = state.resumeReady[item.id] !== true;
    setReaderText(
      els.finish,
      finished ? "Mark as not finished" : "Mark as finished",
    );
    setReaderText(
      els.hide,
      state.hidden.has(item.id) ? "Show in Reader again" : "Hide from Reader",
    );
    document.getElementById("readerHiddenNote").hidden = !state.hidden.has(
      item.id,
    );
  }

  function renderTextPreservingFocus() {
    const focusedSegment = focusedSegmentIndex();
    const focusedAction = document.activeElement?.dataset?.readerAction;
    const priorScroll = window.scrollY;
    const priorScrollGeneration = readerScrollGeneration;
    renderText();
    if (focusedSegment !== undefined && focusedSegment !== null) {
      focusSegment(
        els.text.querySelector(
          `[data-index="${CSS.escape(String(focusedSegment))}"]`,
        ),
      );
    } else if (focusedAction) {
      els.main
        .querySelector(`[data-reader-action="${CSS.escape(focusedAction)}"]`)
        ?.focus({ preventScroll: true });
    }
    if (readerScrollGeneration === priorScrollGeneration) {
      window.scrollTo({ top: priorScroll });
    }
  }

  function showSaveError() {
    renderNotices();
    if (state.saveErrorNotified) return;
    state.saveErrorNotified = true;
    notify("Couldn’t save your listening progress.", {
      tone: "error",
      action: { label: "Try again", run: () => retryPlaybackSave() },
    });
  }

  function showDurationError(declared, decoded) {
    if (state.detached) return;
    state.durationWarning = { declared, decoded };
    renderNotices();
  }

  function skeletonText() {
    return h(
      "div",
      { className: "reader-skeleton", "aria-hidden": "true" },
      ...[92, 100, 96, 64, 0, 100, 88, 97, 72].map((width) =>
        width
          ? h("span", {
              className: "skeleton reader-skeleton-line",
              style: `width: ${width}%`,
            })
          : h("span", { className: "reader-skeleton-gap" }),
      ),
    );
  }

  const itemLoading = document.getElementById("readerItemLoading");
  function finishItemLoading() {
    const focused = itemLoading.contains(document.activeElement);
    els.main.classList.remove("is-loading");
    itemLoading.hidden = true;
    router.setSkipTarget("readerTitle");
    if (focused) els.title.focus({ preventScroll: true });
  }

  function showItemLoading(id) {
    const known = state.items.find((candidate) => candidate.id === id);
    itemLoading.hidden = false;
    itemLoading.replaceChildren(
      h("h2", {
        id: "readerLoadingTitle",
        className: "reader-title",
        tabindex: "-1",
        text: "Loading item…",
      }),
      skeletonText(),
    );
    itemLoading.firstElementChild.focus({ preventScroll: true });
    els.main.classList.add("is-loading");
    router.setSkipTarget("readerLoadingTitle");
    els.head.classList.remove("is-error", "is-quiet");
    // Nothing from the previous item stays: its place, its notes.
    state.resumeMark = false;
    const source = known ? sourceLabel(known) : "";
    setReaderText(els.meta, source);
    els.meta.hidden = !source;
    state.loadingTitle = known?.title || "";
    setReaderText(els.title, state.loadingTitle || "Loading item…");
    els.title.classList.toggle("is-long", state.loadingTitle.length > 70);
    renderProcessingNotes([]);
    els.details.hidden = false;
    els.details.replaceChildren(
      h("span", {
        className: "skeleton reader-skeleton-details",
        "aria-hidden": "true",
      }),
    );
    els.notices.replaceChildren();
    // The action row and hint keep their place while the item loads.
    els.actions.hidden = false;
    els.actions.classList.add("is-loading");
    els.hint.hidden = known ? known.status !== "ready" : false;
    els.title.classList.toggle("is-loading", !state.loadingTitle);
    els.toc.hidden = true;
    els.tocOpen.hidden = true;
    // Desktop keeps the Contents column the item had last time (or likely
    // has), so the text doesn't jump sideways when Contents arrives.
    els.main.classList.toggle("has-toc", tocGuess(id, known));
    els.tocList.replaceChildren();
    els.text.inert = true;
    els.text.setAttribute("aria-busy", "true");
    els.text.replaceChildren(skeletonText());
    clearTitleSegment();
    notifyPlayer();
  }

  function showReaderError(error, id) {
    const kind = errorKind(error);
    const copy = itemErrorCopy(kind);
    state.itemError = kind;
    els.main.classList.add("has-no-narration");
    els.text.inert = false;
    els.text.setAttribute("aria-busy", "false");
    els.head.classList.add("is-error");
    setReaderText(els.meta, "");
    els.meta.hidden = true;
    setReaderText(els.title, copy.title);
    els.title.classList.remove("is-long");
    renderProcessingNotes([]);
    els.details.hidden = true;
    els.details.replaceChildren();
    const actions = h("div", { className: "state-actions" });
    if (kind !== "not-found") {
      actions.append(
        h("button", {
          type: "button",
          className: "button is-primary",
          text: "Try again",
          dataset: { readerAction: "retry-item" },
          onclick: () =>
            loadItem(id, { historyMode: "replace", focusDetail: true }),
        }),
      );
    }
    actions.append(
      h("a", {
        className: "button",
        href: "/reader",
        dataset: { route: "/reader" },
        text: "Back to Reader",
      }),
    );
    els.notices.replaceChildren();
    els.actions.hidden = false;
    els.resume.hidden = true;
    els.textOpen.hidden = false;
    actionRate.disabled = true;
    actionRate.closest("label").hidden = true;
    els.textOpen.disabled = true;
    els.more.disabled = true;
    els.actions.classList.remove("is-loading");
    els.title.classList.remove("is-loading");
    els.hint.hidden = true;
    els.toc.hidden = true;
    els.tocOpen.hidden = true;
    els.main.classList.remove("has-toc");
    els.text.replaceChildren(
      h(
        "div",
        { className: "empty-state" },
        h("p", { text: copy.text }),
        actions,
      ),
    );
    clearTitleSegment();
    finishItemLoading();
    els.title.focus({ preventScroll: true });
    notifyPlayer();
  }

  // The shared error box for text that didn't load, with the original as a
  // way to read it meanwhile.
  function textErrorBox(kind, id, original = "") {
    const actions = [
      h("button", {
        type: "button",
        className: "button is-primary",
        text: "Try again",
        dataset: { readerAction: "retry-text" },
        onclick: () =>
          loadItem(id, { historyMode: "replace", focusDetail: true }),
      }),
      original
        ? h("a", {
            className: "button",
            href: original,
            target: "_blank",
            rel: "noopener",
            text: "Open original page",
            dataset: { readerAction: "open-original" },
          })
        : h("a", {
            className: "button",
            href: `/reader-source/${encodeURIComponent(id)}/source`,
            download: "",
            text: "Download original",
            dataset: { readerAction: "download-original" },
          }),
    ];
    const box = problemState({
      kind,
      title: "The text didn’t load",
      actions,
      className: "reader-text-error",
    });
    box.setAttribute("role", "alert");
    return box;
  }

  // An asynchronous failure says so: focus moves to the error's heading when
  // it was on the item title, and is announced otherwise.
  function showTextError(kind, id, { announce = false } = {}) {
    els.text.replaceChildren();
    renderNotices();
    if (!announce) return;
    const heading = els.notices.querySelector(".error-state-title");
    const active = document.activeElement;
    if (!active || active === document.body || active === els.title) {
      heading?.focus({ preventScroll: true });
    } else {
      els.itemStatus.textContent = "";
      window.setTimeout(() => {
        els.itemStatus.textContent = `The text didn’t load. ${problemCopy(kind).text}`;
      }, 60);
    }
  }

  function updateReaderURL(id, mode) {
    if (mode === "none") return;
    router.commitScroll();
    const url = new URL(window.location.href);
    url.pathname = "/reader";
    url.searchParams.set("item", id);
    const method = mode === "replace" ? "replaceState" : "pushState";
    if (
      `${url.pathname}${url.search}` !==
      `${location.pathname}${location.search}`
    ) {
      history[method](
        method === "replaceState" ? history.state || {} : { scroll: [0, 0] },
        "",
        url,
      );
    }
  }

  function restoreRouteScroll(fallback = null) {
    const pending = router.pendingScroll;
    const target = pending || fallback;
    if (!target) return;
    const apply = () =>
      router.scrollTo({
        left: Number(target[0]) || 0,
        top: Number(target[1]) || 0,
        behavior: "instant",
      });
    window.requestAnimationFrame(() => {
      apply();
      window.requestAnimationFrame(() => {
        apply();
        router.finishRestore(pending);
      });
    });
  }

  function mergeListItem(item, segments) {
    const index = state.items.findIndex(
      (candidate) => candidate.id === item.id,
    );
    if (index < 0) return;
    state.items[index] = {
      ...state.items[index],
      ...item,
      ready_segment_count: segments.filter(
        (segment) => segment.status === "ready",
      ).length,
    };
  }

  function itemLoadInFlight(id) {
    return (
      state.itemLoading?.id === id &&
      state.itemLoading.generation === state.loadGeneration
    );
  }

  async function loadItem(
    id,
    {
      historyMode = "none",
      focusDetail = false,
      background = false,
      autoplay = false,
    } = {},
  ) {
    state.loadAbort?.abort();
    const controller = new AbortController();
    state.loadAbort = controller;
    const generation = ++state.loadGeneration;
    const encoded = encodeURIComponent(id);
    const focusedSegment = background ? focusedSegmentIndex() : null;
    const focusedToc = background
      ? document.activeElement?.dataset?.tocIndex
      : null;
    const focusedAction = background
      ? document.activeElement?.dataset?.readerAction
      : null;
    const priorScroll = background ? window.scrollY : 0;
    const priorScrollGeneration = background ? readerScrollGeneration : 0;
    const onReader = () =>
      generation === state.loadGeneration &&
      !controller.signal.aborted &&
      window.location.pathname.startsWith("/reader");
    if (!background) {
      // Save the list's place in history before the item replaces it and
      // the shorter page clamps the scroll position.
      updateReaderURL(id, historyMode);
      els.hero.hidden = true;
      els.main.hidden = false;
      router.setSkipTarget("readerTitle");
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = 0;
      state.needsRefresh = false;
      // What is narrating keeps playing while this item loads, and while it
      // is open, until its own Play is pressed.
      if (ownsSelectedItem()) {
        if (!state.parked) state.parked = session();
      } else if (!state.parked && state.activePlayback?.itemID !== id) {
        stopActivePlayback();
      }
      state.showingLibrary = false;
      state.item = null;
      state.segments = [];
      state.images = [];
      state.imagesError = false;
      state.totalDuration = 0;
      listening.hidden = true;
      document.getElementById("readerHiddenNote").hidden = true;
      state.position = 0;
      state.effectiveDurations = Object.create(null);
      state.durationWarning = null;
      delete state.resumeReady[id];
      state.resumeError = false;
      state.resumeConflict = false;
      state.itemError = "";
      state.textError = "";
      state.following = true;
      state.segmentsLoading = true;
      state.attemptedID = id;
      state.itemLoading = { id, generation };
      showItemLoading(id);
      notifyPlayer();
    }
    try {
      const itemPromise = api(`/api/reader/items/${encoded}`, {
        signal: controller.signal,
      });
      const imagePromise = api(`/api/reader/items/${encoded}/images`, {
        signal: controller.signal,
      }).catch((error) => {
        if (error.name === "AbortError") throw error;
        return { images: [], error: true };
      });
      const { item } = await itemPromise;
      let segments = [];
      let segmentsError = null;
      try {
        segments = await paged(
          `/api/reader/items/${encoded}/segments`,
          "segments",
          {
            signal: controller.signal,
            onPage: (partial, payload) => {
              if (background || !onReader()) return;
              state.item = item;
              state.segmentsLoading = payload.next_offset != null;
              state.segments = partial;
              refreshTotalDuration();
              renderItemHead();
              els.resume.disabled = true;
            },
          },
        );
      } catch (error) {
        if (error.name === "AbortError" || error.status === 404) throw error;
        segmentsError = error;
      }
      state.segmentsLoading = false;
      if (segmentsError) {
        if (!onReader()) return false;
        if (background) {
          scheduleReaderRefresh(id);
          return false;
        }
        state.item = item;
        state.segments = [];
        state.attemptedID = "";
        state.textError = errorKind(segmentsError);
        refreshTotalDuration();
        renderItemHead();
        renderToc();
        els.text.inert = false;
        finishItemLoading();
        showTextError(state.textError, id, { announce: true });
        els.text.setAttribute("aria-busy", "false");
        notifyPlayer();
        return false;
      }
      const playable = segments.some(isPlayable);
      let playback = null;
      let playbackError = false;
      if (playable) {
        try {
          playback = await api(`/api/reader/playback?item_id=${encoded}`, {
            signal: controller.signal,
          });
        } catch (error) {
          if (error.name === "AbortError") throw error;
          playbackError = true;
        }
      }
      const localPlayback = state.localPlayback[item.id];
      if (localPlayback) {
        const serverRevision = Number(playback?.revision || 0);
        if (
          localPlayback.pending ||
          serverRevision < Number(localPlayback.revision || 0)
        ) {
          playback = {
            ...playback,
            segment_index: localPlayback.segment_index,
            position: localPlayback.position,
            playing: localPlayback.playing,
            revision: Math.max(
              serverRevision,
              Number(localPlayback.revision || 0),
            ),
          };
        } else if (serverRevision >= Number(localPlayback.revision || 0)) {
          delete state.localPlayback[item.id];
        }
      }
      if (!onReader()) return false;
      if (
        background &&
        (state.item?.id !== id ||
          new URLSearchParams(location.search).get("item") !== id)
      )
        return false;
      state.item = item;
      state.showingLibrary = false;
      state.attemptedID = "";
      state.textError = "";
      mergeListItem(item, segments);
      state.segments = segments;
      // Back on the item being narrated: the page takes over from the
      // parked context.
      if (state.parked?.item?.id === item.id) {
        state.effectiveDurations = state.parked.effectiveDurations;
        state.parked = null;
      }
      if (!background || !playbackError) {
        state.resumeError = playbackError;
        state.resumeConflict = false;
        state.resumeReady[item.id] = !playbackError;
      }
      if (
        playbackError &&
        window.ZakAudio.is("reader") &&
        state.activePlayback?.itemID === item.id
      ) {
        stopActivePlayback();
      }
      if (playback)
        state.playbackRevisions[item.id] = Number(playback.revision || 0);
      refreshTotalDuration();
      const activeIndex =
        window.ZakAudio.is("reader") && state.activePlayback?.itemID === item.id
          ? segments.findIndex(
              (segment) =>
                Number(segment.segment_index) ===
                  Number(state.activePlayback.segmentIndex) &&
                isPlayable(segment),
            )
          : -1;
      const restored =
        activeIndex >= 0
          ? activeIndex
          : playback
            ? segments.findIndex(
                (segment) =>
                  Number(segment.segment_index) ===
                    Number(playback.segment_index) && isPlayable(segment),
              )
            : -1;
      state.index = restored >= 0 ? restored : segments.findIndex(isPlayable);
      if (state.index < 0) state.index = 0;
      state.position =
        activeIndex >= 0
          ? Number(els.audio.currentTime || 0)
          : restored >= 0
            ? Number(playback?.position || 0)
            : 0;
      if (!background) {
        const progress = progressOf(item);
        state.resumeMark =
          activeIndex < 0 &&
          restored >= 0 &&
          !progress.finished &&
          offsetBefore(state.index) + state.position >= 1;
      }
      if (background) updateReaderURL(item.id, "none");
      renderItemHead();
      renderText();
      renderToc();
      renderList();
      state.needsRefresh =
        !playable ||
        segments.some((segment) =>
          ["pending", "processing"].includes(segment.status),
        );
      scheduleReaderRefresh(item.id);
      const narrating = !background && isPlayingSelected();
      highlight(false);
      renderProgress();
      renderPlaybackState();
      els.text.inert = false;
      els.text.setAttribute("aria-busy", "false");
      if (!background) finishItemLoading();
      if (background) {
        if (focusedSegment !== undefined && focusedSegment !== null) {
          focusSegment(
            els.text.querySelector(
              `[data-index="${CSS.escape(String(focusedSegment))}"]`,
            ),
          );
        } else if (focusedToc !== undefined && focusedToc !== null) {
          els.tocList
            .querySelector(`[data-toc-index="${CSS.escape(focusedToc)}"]`)
            ?.focus({ preventScroll: true });
        } else if (focusedAction) {
          (
            els.main.querySelector(
              `[data-reader-action="${CSS.escape(focusedAction)}"]`,
            ) || els.title
          ).focus({ preventScroll: true });
        }
        if (readerScrollGeneration === priorScrollGeneration) {
          restoreRouteScroll([0, priorScroll]);
        }
      }
      let placed = false;
      if (!background && router.pendingScroll) {
        restoreRouteScroll();
        placed = true;
      } else if (narrating) {
        // Narration kept playing while the item was closed: show where it is.
        const el = currentSegmentElement();
        if (el) scrollToElement(el, "follow");
        placed = true;
      }
      if (focusDetail) {
        if (!placed) router.scrollTo({ top: 0, behavior: "instant" });
        // Focus only what is in view: the title at the top, or, when the
        // page opens at the narration, the paragraph being read.
        if (placed && narrating) focusSegment(currentSegmentElement());
        else if (!placed) els.title.focus({ preventScroll: true });
      }
      if (
        autoplay &&
        !background &&
        playable &&
        state.resumeReady[item.id] === true &&
        !isPlayingSelected()
      ) {
        void toggleReaderPlayback();
        // An explicit Resume goes to the narration, and focus goes with it.
        window.requestAnimationFrame(() =>
          focusSegment(currentSegmentElement()),
        );
      }
      void imagePromise
        .then((imageData) => {
          if (!onReader() || state.item?.id !== item.id) return;
          state.images = imageData.images || [];
          state.imagesError = Boolean(imageData.error);
          renderNotices();
          renderTextPreservingFocus();
          highlight(false);
        })
        .catch(() => {});
      return true;
    } catch (error) {
      if (error.name === "AbortError" || generation !== state.loadGeneration)
        return false;
      if (background) {
        scheduleReaderRefresh(id);
        return false;
      }
      els.text.inert = false;
      els.text.setAttribute("aria-busy", "false");
      showReaderError(error, id);
      return false;
    } finally {
      if (state.itemLoading?.generation === generation)
        state.itemLoading = null;
    }
  }

  function reopenItemView() {
    router.setSkipTarget("readerTitle");
    const lostFocus =
      els.hero.contains(document.activeElement) ||
      document.activeElement === document.body;
    els.hero.hidden = true;
    els.main.hidden = false;
    state.showingLibrary = false;
    if (state.item && !state.itemError) {
      renderItemHead();
      if (state.textError) showTextError(state.textError, state.item.id);
      else renderText();
      renderToc();
      highlight(false);
      renderProgress();
    }
    if (lostFocus) els.title.focus({ preventScroll: true });
    notifyPlayer();
  }

  function scheduleReaderRefresh(id) {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = 0;
    if (!state.needsRefresh) return;
    state.refreshTimer = window.setTimeout(() => {
      state.refreshTimer = 0;
      if (location.pathname.startsWith("/reader") && state.item?.id === id) {
        loadItem(id, { historyMode: "none", background: true });
      }
    }, 5000);
  }

  function renderPlaybackState() {
    renderResumeButton();
    notifyPlayer();
  }

  function playbackBody(
    playing = !els.audio.paused,
    force = false,
    explicitPosition = null,
  ) {
    const active = state.activePlayback;
    if (
      !active ||
      (!force &&
        (!window.ZakAudio.is("reader") ||
          active.generation !== window.ZakAudio.generation)) ||
      state.resumeReady[active.itemID] === false
    )
      return null;
    window.clearTimeout(state.saveTimer);
    state.saveTimer = 0;
    state.lastSavedAt = Date.now();
    const observed =
      explicitPosition === null ? els.audio.currentTime || 0 : explicitPosition;
    const position = Math.max(0, Math.min(observed, active.duration));
    const body = {
      item_id: active.itemID,
      segment_index: active.segmentIndex,
      position,
      playing,
      writer_id: readerWriterID(),
      writer_sequence: ++state.writerSequence,
    };
    state.localPlayback[active.itemID] = {
      ...body,
      revision: Number(state.playbackRevisions[active.itemID] || 0),
      pending: true,
    };
    inPlayback(() => {
      if (state.item?.id !== active.itemID) return;
      const index = state.segments.findIndex(
        (segment) =>
          Number(segment.segment_index) === Number(active.segmentIndex),
      );
      if (index >= 0)
        rememberProgress(active.itemID, offsetBefore(index) + position);
    });
    return body;
  }

  async function persistPlayback(body, keepalive = false) {
    try {
      const saved = await api("/api/reader/playback", {
        method: "POST",
        keepalive,
        body: {
          ...body,
          base_revision: Number(state.playbackRevisions[body.item_id] || 0),
        },
      });
      state.playbackRevisions[body.item_id] = Number(saved.revision || 0);
      const local = state.localPlayback[body.item_id];
      if (
        local &&
        Number(local.writer_sequence) === Number(body.writer_sequence)
      ) {
        state.localPlayback[body.item_id] = {
          ...local,
          revision: Number(saved.revision || 0),
          pending: false,
        };
      }
      const failed = state.saveErrors[body.item_id];
      if (
        failed &&
        Number(failed.writer_sequence) <= Number(body.writer_sequence)
      ) {
        delete state.saveErrors[body.item_id];
        state.saveErrorNotified = false;
        if (state.item?.id === body.item_id) renderNotices();
      }
      return saved;
    } catch (error) {
      if (error.status === 409) {
        delete state.localPlayback[body.item_id];
        delete state.saveErrors[body.item_id];
        if (state.item?.id === body.item_id) {
          state.resumeReady[body.item_id] = false;
          state.resumeError = true;
          state.resumeConflict = true;
          // Narration parked from another item keeps playing: the conflict
          // is about this item only.
          const playingThis =
            window.ZakAudio.is("reader") &&
            (state.activePlayback
              ? state.activePlayback.itemID === body.item_id
              : !state.parked);
          if (playingThis) {
            window.ZakAudio.pause();
            state.activePlayback = null;
            window.ZakAudio.clear("reader");
          }
          renderItemHead();
          renderTextPreservingFocus();
          highlight(false);
          notifyPlayer();
          notify(
            playingThis
              ? "Paused: your place changed in another tab or device."
              : "Your place changed in another tab or device.",
            {
              tone: "error",
              action: { label: "Load latest place", run: retryInBackground },
            },
          );
        } else if (
          state.parked?.item?.id === body.item_id &&
          window.ZakAudio.is("reader")
        ) {
          const title = state.parked.item.title || "Reader";
          window.ZakAudio.pause();
          state.activePlayback = null;
          state.parked = null;
          window.ZakAudio.clear("reader");
          notify(
            `Paused “${title}”: your place changed in another tab or device.`,
            { tone: "error" },
          );
        }
      } else {
        const failed = state.saveErrors[body.item_id];
        if (
          !failed ||
          Number(failed.writer_sequence) <= Number(body.writer_sequence)
        ) {
          state.saveErrors[body.item_id] = body;
        }
        if (state.item?.id === body.item_id) showSaveError();
      }
      throw error;
    }
  }

  function savePlayback(
    playing = !els.audio.paused,
    force = false,
    explicitPosition = null,
  ) {
    const body = playbackBody(playing, force, explicitPosition);
    if (!body) return state.saveQueue;
    state.saveQueue = state.saveQueue
      .catch(() => {})
      .then(() => persistPlayback(body))
      .catch(() => {});
    return state.saveQueue;
  }

  function retryPlaybackSave() {
    const body = state.item && state.saveErrors[state.item.id];
    if (!body) return state.saveQueue;
    state.saveQueue = state.saveQueue
      .catch(() => {})
      .then(() => persistPlayback(body))
      .catch(() => {});
    return state.saveQueue;
  }

  function queuePlaybackSave() {
    if (
      !state.activePlayback ||
      !window.ZakAudio.is("reader") ||
      state.saveTimer
    )
      return;
    const delay = Math.max(0, 5000 - (Date.now() - state.lastSavedAt));
    state.saveTimer = window.setTimeout(
      () => savePlayback(!els.audio.paused),
      delay,
    );
  }

  function seekAbsolute(pos) {
    if (!state.item || state.resumeReady[state.item.id] !== true) return;
    const wasPlaying = window.ZakAudio.is("reader") && !els.audio.paused;
    pos = Math.max(0, Math.min(pos, state.totalDuration));
    if (state.totalDuration > 0 && pos >= state.totalDuration) {
      let finalIndex = -1;
      for (let i = state.segments.length - 1; i >= 0; i--) {
        if (isPlayable(state.segments[i])) {
          finalIndex = i;
          break;
        }
      }
      if (finalIndex >= 0) {
        state.index = finalIndex;
        const duration = segmentDuration(state.segments[finalIndex]);
        loadAudio(duration, false);
        window.ZakAudio.pause();
        state.position = duration;
        renderProgress();
        savePlayback(false, true, duration);
      }
      return;
    }
    let acc = 0;
    for (let i = 0; i < state.segments.length; i++) {
      if (!isPlayable(state.segments[i])) continue;
      const dur = segmentDuration(state.segments[i]);
      if (pos < acc + dur || nextPlayableIndex(i) < 0) {
        state.index = i;
        loadAudio(Math.max(0, pos - acc), wasPlaying);
        break;
      }
      acc += dur;
    }
  }

  // Media Session next/previous: move by whole segments. Previous restarts
  // the current segment unless it has only just begun.
  function stepSegment(direction) {
    if (!state.item || state.resumeReady[state.item.id] !== true) return;
    const playing = window.ZakAudio.is("reader") && !els.audio.paused;
    if (direction < 0 && absoluteOffset() - offsetBefore(state.index) > 3) {
      loadAudio(0, playing);
      return;
    }
    const target =
      direction > 0
        ? nextPlayableIndex(state.index)
        : previousPlayableIndex(state.index);
    if (target < 0) return;
    state.index = target;
    state.following = true;
    loadAudio(0, playing);
  }

  els.audio.addEventListener("timeupdate", () => {
    if (!window.ZakAudio.is("reader")) return;
    inPlayback(() => {
      if (state.activePlayback?.itemID === state.item?.id) {
        state.position = els.audio.currentTime || 0;
        renderProgress();
      }
    });
    queuePlaybackSave();
  });
  els.audio.addEventListener("play", () => {
    if (window.ZakAudio.is("reader")) {
      window.ZakStorage.set("zak-reader-tap-hint-seen", "true");
      els.hint.hidden = true;
    }
    if (window.ZakAudio.is("reader") && ownsSelectedItem()) clearResumePoint();
    renderPlaybackState();
  });
  els.audio.addEventListener("pause", () => {
    renderPlaybackState();
    if (window.ZakAudio.is("reader")) savePlayback(false);
  });
  els.audio.addEventListener("ended", () => inPlayback(segmentEnded));
  function segmentEnded() {
    if (state.activePlayback?.itemID !== state.item?.id) {
      savePlayback(false);
      return;
    }
    const segment = state.segments[state.index];
    const declared = Number(segment?.duration || 0);
    const decoded = Number(els.audio.duration || els.audio.currentTime || 0);
    if (declared > 0 && decoded > 0 && Math.abs(decoded - declared) > 0.25) {
      state.effectiveDurations[String(segment.segment_index)] = decoded;
      if (state.activePlayback) state.activePlayback.duration = declared;
      refreshTotalDuration();
      state.position = decoded;
      showDurationError(declared, decoded);
      renderProgress();
      const next = nextPlayableIndex(state.index);
      if (window.ZakAudio.is("reader") && next >= 0) {
        savePlayback(true, true, declared);
        state.activePlayback = null;
        state.index = next;
        loadAudio(0, true);
      } else {
        savePlayback(false, true, declared);
      }
      return;
    }
    const next = nextPlayableIndex(state.index);
    if (window.ZakAudio.is("reader") && next >= 0) {
      state.index = next;
      loadAudio(0, true);
    } else if (window.ZakAudio.is("reader") && !state.segmentsLoading) {
      state.position = segmentDuration(segment);
      renderProgress();
      savePlayback(false, true, state.position);
      // Only a complete item's final part means the article is finished.
      renderMoreMenu();
      renderList();
      notifyPlayer();
      if (!els.main.hidden && !state.detached) {
        els.itemStatus.textContent = "";
        window.setTimeout(() => {
          els.itemStatus.textContent =
            state.item?.status === "ready"
              ? `Finished “${state.item.title || "this item"}”.`
              : "You’ve reached the end of the narration available so far.";
        }, 60);
      }
    }
  }
  async function toggleReaderPlayback() {
    if (!state.item || state.resumeReady[state.item.id] !== true) return;
    if (!ownsSelectedItem()) loadAudio(state.position, true);
    else if (els.audio.paused) {
      if (els.audio.ended || absoluteOffset() >= state.totalDuration - 0.01) {
        state.index = state.segments.findIndex(isPlayable);
        loadAudio(0, true);
      } else {
        await window.ZakAudio.play();
      }
    } else {
      window.ZakAudio.pause();
      savePlayback(false);
    }
  }
  els.resume.addEventListener("click", () => {
    const starting = !isPlayingSelected();
    void toggleReaderPlayback();
    if (starting)
      window.requestAnimationFrame(() => focusSegment(currentSegmentElement()));
  });

  // Narration can carry the opener above the viewport while a menu is open.
  function restoreActionFocus(opener) {
    const rect = opener.getBoundingClientRect();
    const band = visibleBand();
    if (rect.top >= band.top && rect.bottom <= band.bottom)
      opener.focus({ preventScroll: true });
    else if (currentSegmentElement()) focusSegment(currentSegmentElement());
    else opener.focus();
  }

  // ---- More actions: mark finished, hide ----
  const menuPopover = typeof els.moreMenu.showPopover === "function";
  let moreClosedAt = 0;
  function moreOpen() {
    return menuPopover
      ? els.moreMenu.matches(":popover-open")
      : els.moreMenu.classList.contains("is-open");
  }
  function closeMore(returnFocus = false) {
    if (menuPopover && moreOpen()) els.moreMenu.hidePopover();
    els.moreMenu.classList.remove("is-open");
    els.more.setAttribute("aria-expanded", "false");
    if (returnFocus) restoreActionFocus(els.more);
  }
  els.more.addEventListener("click", () => {
    if (performance.now() - moreClosedAt < 300) return;
    if (moreOpen()) {
      closeMore(true);
      return;
    }
    renderMoreMenu();
    els.more.setAttribute("aria-expanded", "true");
    if (menuPopover) {
      els.moreMenu.showPopover();
      const rect = els.more.getBoundingClientRect();
      const box = els.moreMenu.getBoundingClientRect();
      const viewport = document.documentElement.clientWidth;
      const player =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--bottom-chrome",
          ),
        ) || 0;
      let top = rect.bottom + 6;
      if (top + box.height > window.innerHeight - player - 8)
        top = Math.max(8, rect.top - box.height - 6);
      els.moreMenu.style.left = `${Math.round(Math.min(Math.max(8, rect.right - box.width), viewport - box.width - 8))}px`;
      els.moreMenu.style.top = `${Math.round(top)}px`;
    } else {
      els.moreMenu.classList.add("is-open");
    }
    [...els.moreMenu.querySelectorAll("button, a")]
      .find(
        (node) =>
          !node.hidden && !node.disabled && node.getClientRects().length,
      )
      ?.focus({ preventScroll: true });
  });
  els.moreMenu.addEventListener("toggle", (event) => {
    if (event.newState !== "closed") return;
    moreClosedAt = performance.now();
    els.more.setAttribute("aria-expanded", "false");
    if (
      els.moreMenu.contains(document.activeElement) ||
      document.activeElement === document.body
    )
      restoreActionFocus(els.more);
  });
  els.moreMenu.addEventListener("keydown", (event) => {
    const items = [...els.moreMenu.querySelectorAll("button, a")].filter(
      (node) => !node.hidden && !node.disabled && node.getClientRects().length,
    );
    const index = items.indexOf(document.activeElement);
    let next = -1;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    else if (event.key === "ArrowUp")
      next = (index - 1 + items.length) % items.length;
    else if (event.key === "Escape" && !menuPopover) {
      event.preventDefault();
      closeMore(true);
      return;
    }
    if (next >= 0) {
      event.preventDefault();
      items[next].focus();
    }
  });

  // ---- Text settings: size, line spacing, and page color ----
  // Saved on this device, for every Reader item.
  const TEXT_KEY = "zak-reader-text";
  const TEXT_CHOICES = {
    size: ["small", "default", "large", "larger"],
    spacing: ["compact", "default", "airy"],
    theme: ["dark", "sepia", "light"],
  };
  const TEXT_FIELDS = {
    readerTextSize: "size",
    readerTextSpacing: "spacing",
    readerTextTheme: "theme",
  };
  function readTextPrefs() {
    let stored = {};
    try {
      stored = JSON.parse(window.ZakStorage.get(TEXT_KEY, "{}")) || {};
    } catch {}
    const prefs = {};
    for (const [key, choices] of Object.entries(TEXT_CHOICES)) {
      const fallback = key === "theme" ? "dark" : "default";
      prefs[key] = choices.includes(stored[key]) ? stored[key] : fallback;
    }
    return prefs;
  }
  let textPrefs = readTextPrefs();
  function applyTextPrefs() {
    els.main.dataset.textSize = textPrefs.size;
    els.main.dataset.textSpacing = textPrefs.spacing;
    els.main.dataset.textTheme = textPrefs.theme;
    els.textMenu.querySelectorAll('input[type="radio"]').forEach((input) => {
      input.checked = textPrefs[TEXT_FIELDS[input.name]] === input.value;
    });
  }
  applyTextPrefs();
  els.textMenu.addEventListener("change", (event) => {
    const input = event.target;
    const key = TEXT_FIELDS[input?.name];
    if (!key || !TEXT_CHOICES[key].includes(input.value)) return;
    // Keep the paragraph being read in the same place on screen.
    const anchor =
      currentSegmentElement() ||
      segmentElements().find(
        (el) => el.getBoundingClientRect().bottom > visibleBand().top,
      );
    const before = anchor?.getBoundingClientRect().top ?? null;
    textPrefs = { ...textPrefs, [key]: input.value };
    window.ZakStorage.set(TEXT_KEY, JSON.stringify(textPrefs));
    applyTextPrefs();
    if (anchor && before !== null)
      window.scrollBy({ top: anchor.getBoundingClientRect().top - before });
  });

  const textPopover = typeof els.textMenu.showPopover === "function";
  let textClosedAt = 0;
  function textMenuOpen() {
    return textPopover
      ? els.textMenu.matches(":popover-open")
      : els.textMenu.classList.contains("is-open");
  }
  function closeTextMenu(returnFocus = false) {
    if (textPopover && textMenuOpen()) els.textMenu.hidePopover();
    els.textMenu.classList.remove("is-open");
    els.textOpen.setAttribute("aria-expanded", "false");
    if (returnFocus) restoreActionFocus(els.textOpen);
  }
  els.textOpen.addEventListener("click", () => {
    if (performance.now() - textClosedAt < 300) return;
    if (textMenuOpen()) {
      closeTextMenu(true);
      return;
    }
    els.textOpen.setAttribute("aria-expanded", "true");
    if (textPopover) {
      els.textMenu.showPopover();
      const rect = els.textOpen.getBoundingClientRect();
      const box = els.textMenu.getBoundingClientRect();
      const viewport = document.documentElement.clientWidth;
      const chrome =
        parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            "--bottom-chrome",
          ),
        ) || 0;
      let top = rect.bottom + 6;
      if (top + box.height > window.innerHeight - chrome - 8)
        top = Math.max(8, rect.top - box.height - 6);
      els.textMenu.style.left = `${Math.round(Math.min(Math.max(8, rect.left), viewport - box.width - 8))}px`;
      els.textMenu.style.top = `${Math.round(top)}px`;
    } else {
      els.textMenu.classList.add("is-open");
    }
    els.textMenu
      .querySelector('input[type="radio"]:checked')
      ?.focus({ preventScroll: true });
  });
  els.textMenu.addEventListener("toggle", (event) => {
    if (event.newState !== "closed") return;
    textClosedAt = performance.now();
    els.textOpen.setAttribute("aria-expanded", "false");
    if (
      els.textMenu.contains(document.activeElement) ||
      document.activeElement === document.body
    )
      restoreActionFocus(els.textOpen);
  });

  for (const [panel, trigger, close] of [
    [els.moreMenu, els.more, closeMore],
    [els.textMenu, els.textOpen, closeTextMenu],
  ]) {
    panel.addEventListener("focusout", (event) => {
      if (
        !panel.contains(event.relatedTarget) &&
        event.relatedTarget !== trigger
      )
        close(false);
    });
    trigger.addEventListener("focusout", (event) => {
      if (
        !panel.contains(event.relatedTarget) &&
        event.relatedTarget !== trigger
      )
        close(false);
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        const controls = [
          ...panel.querySelectorAll("button, a[href], input"),
        ].filter(
          (node) =>
            !node.disabled &&
            !node.closest("[hidden]") &&
            node.getClientRects().length &&
            (node.type !== "radio" || node.checked),
        );
        const edge = event.shiftKey ? controls[0] : controls.at(-1);
        if (document.activeElement === edge) {
          event.preventDefault();
          // Move focus out before hiding the native popover, so its focus
          // restoration cannot reset the browser's tab starting point.
          focusBeside(trigger, event.shiftKey, panel);
          close(false);
        }
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    });
  }

  // Saves a place without playing it, for Mark as finished and its Undo.
  async function savePlace(item, absolute) {
    if (ownsSelectedItem()) {
      if (!els.audio.paused) window.ZakAudio.pause();
      seekAbsolute(absolute);
      // Seeking to the very end saves on its own.
      if (absolute < state.totalDuration)
        savePlayback(false, true, state.position);
      return;
    }
    let acc = 0;
    let index = -1;
    let position = 0;
    for (let i = 0; i < state.segments.length; i++) {
      if (!isPlayable(state.segments[i])) continue;
      const duration = segmentDuration(state.segments[i]);
      index = i;
      if (absolute < acc + duration || nextPlayableIndex(i) < 0) {
        position = Math.max(0, Math.min(duration, absolute - acc));
        break;
      }
      acc += duration;
    }
    if (index < 0) return;
    state.index = index;
    state.position = position;
    const body = {
      item_id: item.id,
      segment_index: state.segments[index].segment_index,
      position,
      playing: false,
      writer_id: readerWriterID(),
      writer_sequence: ++state.writerSequence,
    };
    state.localPlayback[item.id] = {
      ...body,
      revision: Number(state.playbackRevisions[item.id] || 0),
      pending: true,
    };
    rememberProgress(item.id, offsetBefore(index) + position);
    state.saveQueue = state.saveQueue
      .catch(() => {})
      .then(() => persistPlayback(body))
      .catch(() => {});
    await state.saveQueue;
  }

  function afterPlaceChange() {
    highlight(false);
    renderProgress();
    renderMoreMenu();
    renderList();
    notifyPlayer();
  }

  for (const link of [els.originalItem, els.sourceItem])
    link.addEventListener("click", () => closeMore(false));

  els.finish.addEventListener("click", async () => {
    closeMore(false);
    const item = state.item;
    if (!item || state.resumeReady[item.id] !== true) return;
    const previous = absoluteOffset();
    const finished = progressOf(item).finished;
    const title = item.title || "this item";
    await savePlace(item, finished ? 0 : state.totalDuration);
    afterPlaceChange();
    els.resume.focus({ preventScroll: true });
    notify(
      finished
        ? `Marked “${title}” as not finished. It starts from the beginning.`
        : `Marked “${title}” as finished.`,
      {
        action: {
          label: "Undo",
          run: async () => {
            await savePlace(item, previous);
            afterPlaceChange();
          },
        },
      },
    );
  });

  function setHidden(item, hidden) {
    if (hidden) state.hidden.add(item.id);
    else state.hidden.delete(item.id);
    saveHidden();
    renderMoreMenu();
    renderList();
  }

  document.getElementById("readerUnhide").addEventListener("click", () => {
    if (state.item) setHidden(state.item, false);
    els.more.focus({ preventScroll: true });
  });
  els.hide.addEventListener("click", () => {
    closeMore(false);
    const item = state.item;
    if (!item) return;
    const hide = !state.hidden.has(item.id);
    setHidden(item, hide);
    els.more.focus({ preventScroll: true });
    const title = item.title || "this item";
    notify(
      hide
        ? `Hid “${title}” from Reader on this device. Find it under Hidden.`
        : `“${title}” is back in Reader.`,
      { action: { label: "Undo", run: () => setHidden(item, !hide) } },
    );
  });
  let listURLTimer = 0;
  let listURLPending = null;
  // Leaving Reader with a search still settling writes it first, so Back
  // returns to what was typed.
  window.addEventListener("zak-before-route", () => {
    if (!listURLPending) return;
    const pending = listURLPending;
    listURLPending = null;
    window.clearTimeout(listURLTimer);
    writeListURL(pending);
  });
  els.search.addEventListener("input", () => {
    if (state.bootError) return;
    renderList();
    scheduleListAnnouncement();
    window.clearTimeout(listURLTimer);
    const startingSearch =
      !new URLSearchParams(window.location.search).get("q") &&
      Boolean(els.search.value.trim());
    listURLPending = { push: startingSearch, focus: "#readerSearch" };
    listURLTimer = window.setTimeout(() => {
      const pending = listURLPending;
      listURLPending = null;
      if (pending) writeListURL(pending);
    }, 350);
  });
  els.sort.addEventListener("change", () => {
    state.sort = SORT_VALUES.includes(els.sort.value)
      ? els.sort.value
      : "newest";
    renderList();
    writeListURL({ push: true, focus: "#readerSort" });
  });
  document.querySelectorAll("[data-reader-filter]").forEach((button) => {
    button.addEventListener("click", () =>
      setFilter(button.dataset.readerFilter),
    );
  });
  els.libraryBack.addEventListener("click", (event) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    goBackToList();
  });
  function syncTocMode() {
    els.toc.open = desktopQuery.matches;
  }
  syncTocMode();
  desktopQuery.addEventListener("change", syncTocMode);

  // A quiet refresh keeps statuses and progress current when the list is
  // shown again; failures keep what is already on screen.
  async function refreshList() {
    if (
      state.loading ||
      state.listRefresh ||
      !state.bootComplete ||
      state.bootError ||
      Date.now() - state.listFetchedAt < 15_000
    )
      return;
    state.listFetchedAt = Date.now();
    const generation = state.bootGeneration;
    state.listRefresh = paged("/api/reader/items", "items", {})
      .then((items) => {
        if (
          generation !== state.bootGeneration ||
          !location.pathname.startsWith("/reader")
        )
          return;
        state.items = items;
        if (state.showingLibrary) renderList();
      })
      .catch(() => {})
      .finally(() => {
        state.listRefresh = null;
      });
    await state.listRefresh;
  }

  async function boot(force = false) {
    if (state.loading) return state.loading;
    if (state.loaded && state.bootComplete && !force) return;
    applyPlaybackRate();
    readListURL();
    state.bootAbort?.abort();
    const controller = new AbortController();
    const generation = ++state.bootGeneration;
    state.bootAbort = controller;
    state.bootComplete = false;
    state.bootError = false;
    els.items.setAttribute("aria-busy", "true");
    if (!state.loaded) renderListSkeleton();
    const initiallyRequested = new URLSearchParams(location.search).get("item");
    if (initiallyRequested) {
      // Open the item right away; the list loads alongside it.
      if (
        state.item?.id !== initiallyRequested &&
        !itemLoadInFlight(initiallyRequested)
      )
        void loadItem(initiallyRequested, { historyMode: "none" });
    } else {
      state.showingLibrary = true;
      els.hero.hidden = false;
      els.main.hidden = true;
    }
    const request = (async () => {
      state.items = await paged("/api/reader/items", "items", {
        signal: controller.signal,
        onPage: (items) => {
          if (
            generation !== state.bootGeneration ||
            !location.pathname.startsWith("/reader")
          )
            return;
          state.items = items;
          state.loaded = true;
          state.bootError = false;
          renderList();
        },
      });
      if (
        generation !== state.bootGeneration ||
        !location.pathname.startsWith("/reader")
      )
        return;
      state.loaded = true;
      state.bootComplete = true;
      state.bootError = false;
      state.listFetchedAt = Date.now();
      els.items.setAttribute("aria-busy", "false");
      renderList();
      const currentRequested = new URLSearchParams(location.search).get("item");
      if (
        currentRequested &&
        state.item?.id !== currentRequested &&
        !itemLoadInFlight(currentRequested) &&
        state.attemptedID !== currentRequested
      ) {
        await loadItem(currentRequested, { historyMode: "none" });
      } else if (!currentRequested) {
        renderLibrary();
      }
    })();
    state.loading = request;
    try {
      await request;
    } catch (error) {
      if (error?.name !== "AbortError" && generation === state.bootGeneration)
        throw error;
    } finally {
      if (state.loading === request) state.loading = null;
      if (state.bootAbort === controller) state.bootAbort = null;
    }
  }

  function showReaderBootError(error) {
    state.bootError = true;
    els.items.setAttribute("aria-busy", "false");
    els.continue.hidden = true;
    delete els.count.dataset.key;
    els.count.hidden = false;
    setReaderText(els.count, "");
    const { title, text } = problemCopy(errorKind(error));
    const retry = h("button", {
      type: "button",
      className: "button is-primary",
      text: "Try again",
      dataset: { readerAction: "retry-list" },
    });
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try {
        await boot(true);
        if (state.showingLibrary)
          els.libraryTitle.focus({ preventScroll: true });
      } catch (nextError) {
        showReaderBootError(nextError);
        els.items
          .querySelector('[data-reader-action="retry-list"]')
          ?.focus({ preventScroll: true });
      }
    });
    els.items.replaceChildren(
      h(
        "li",
        { className: "reader-list-state" },
        problemState({ error, actions: [retry] }),
      ),
    );
    if (state.showingLibrary)
      setReaderText(els.listStatus, `${title}. ${text}`);
  }

  if (location.pathname.startsWith("/reader"))
    boot().catch(showReaderBootError);
  window.addEventListener("zak-audio-owner", (event) => {
    if (event.detail?.owner !== "reader") {
      if (state.metadataHandler) {
        els.audio.removeEventListener("loadedmetadata", state.metadataHandler);
        state.metadataHandler = null;
      }
    }
    renderPlaybackState();
  });
  // Another source taking the audio (Listen live, a Library preview) says
  // where narration stopped and offers to go back to it.
  window.addEventListener("zak-audio-release", (event) => {
    if (event.detail?.owner !== "reader" || !state.activePlayback) return;
    const position = Number(event.detail.position || 0);
    const active = state.activePlayback;
    savePlayback(false, true, position);
    if (event.detail?.nextOwner === "reader") return;
    let absolute = position;
    inPlayback(() => {
      if (state.item?.id !== active.itemID) return;
      const index = state.segments.findIndex(
        (segment) =>
          Number(segment.segment_index) === Number(active.segmentIndex),
      );
      if (index >= 0) {
        state.index = index;
        state.position = position;
        absolute = offsetBefore(index) + position;
      }
    });
    state.activePlayback = null;
    state.parked = null;
    if (!event.detail?.playing) return;
    const itemID = active.itemID;
    notify(`Reader paused at ${t(absolute)}.`, {
      action: { label: "Resume", run: () => resumeAfterHandoff(itemID) },
    });
  });

  function resumeAfterHandoff(itemID) {
    if (state.item?.id === itemID && state.resumeReady[itemID] === true) {
      void toggleReaderPlayback();
      return;
    }
    router.navigate(itemHref(itemID));
  }
  window.addEventListener("zak-route", async (event) => {
    if (event.detail?.path !== "/reader") {
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = 0;
      state.loadAbort?.abort();
      state.loadAbort = null;
      state.loadGeneration++;
      state.itemLoading = null;
      if (state.loading) {
        state.bootComplete = false;
        state.bootAbort?.abort();
        state.bootAbort = null;
        state.bootGeneration++;
        state.loading = null;
      }
      els.text.inert = false;
      return;
    }
    if (!state.loaded || !state.bootComplete) {
      try {
        await boot(!state.bootComplete);
      } catch (error) {
        showReaderBootError(error);
        if (!new URLSearchParams(location.search).get("item")) return;
      }
    }
    // Back and Forward restore exactly what the entry holds. Otherwise the
    // address wins when it names a search, and the remembered one goes back
    // into it when it doesn't.
    if (event.detail?.cause === "history") readListURL({ reset: true });
    else if (!readListURL()) writeListURL();
    const requested = new URLSearchParams(location.search).get("item");
    if (!requested) {
      const cameFromItem = !state.showingLibrary;
      const previous = state.item?.id || state.attemptedID;
      const pending = router.pendingScroll;
      state.loadAbort?.abort();
      state.loadAbort = null;
      state.loadGeneration++;
      renderLibrary();
      if (cameFromItem) {
        restoreListPlace(
          previous,
          pending ? Number(pending[1]) || 0 : state.listScroll,
        );
      }
      return;
    }
    if (state.item?.id !== requested) {
      if (!itemLoadInFlight(requested))
        await loadItem(requested, { historyMode: "none" });
    } else if (state.showingLibrary) {
      // History back to an item already in memory: show it at once, then
      // refresh it quietly.
      reopenItemView();
      await loadItem(requested, { historyMode: "none", background: true });
    } else if (
      state.item &&
      (state.needsRefresh || !state.segments.some(isPlayable))
    ) {
      await loadItem(state.item.id, { historyMode: "none", background: true });
    }
    restoreRouteScroll();
  });
  window.addEventListener("pagehide", () => {
    if (state.activePlayback && window.ZakAudio.is("reader")) {
      const body = playbackBody(!els.audio.paused, true);
      if (body) persistPlayback(body, true).catch(() => {});
    }
  });

  function currentSectionTitle() {
    return currentHeading()?.text || "";
  }

  // What the shared player shows while Reader has the audio: the item being
  // narrated, whichever item is open. Opening an item doesn't put it in the
  // player; its own Play does.
  function describePlayer() {
    if (!window.ZakAudio.is("reader") || !state.activePlayback) return null;
    if (
      els.audio.ended &&
      inPlayback(() => absoluteOffset() >= state.totalDuration - 0.5)
    )
      return null;
    return inPlayback(describeNarration);
  }

  function describeNarration() {
    const viewingItem =
      !state.detached &&
      window.location.pathname.startsWith("/reader") &&
      !state.showingLibrary &&
      !els.main.hidden;
    const item = state.item;
    if (!item) return null;
    const playable = state.segments.some(isPlayable);
    // Problems with the open page belong to that page, not to what plays.
    const textError = state.detached ? "" : state.textError;
    const resumeError = !state.detached && state.resumeError;
    const ready = state.resumeReady[item.id] === true;
    const ownsSelected = ownsSelectedItem();
    return {
      kind: "ondemand",
      source: "Reader",
      context: playable ? currentSectionTitle() : "",
      title: item.title || "Untitled",
      // Who wrote it and where it's from, as in the item's own header.
      subtitle: [item.author || siteLabel(item.source_url), sourceLabel(item)]
        .filter(Boolean)
        .join(" · "),
      href: itemHref(item.id),
      artwork: {
        glyph: "reader",
        seed: item.id,
        text: item.title || "",
        label: sourceLabel(item) || "Reader",
      },
      playing: ownsSelected && !els.audio.paused,
      disabled: !playable || !ready,
      note: textError
        ? "Narration couldn’t be loaded"
        : !playable
          ? ["processing", "pending", "draft"].includes(item.status)
            ? "Narration isn’t ready yet"
            : "No narration for this item"
          : resumeError
            ? "Paused to protect your saved place"
            : item.status !== "ready"
              ? `${t(state.totalDuration)} narrated so far`
              : "",
      position: absoluteOffset(),
      // Progress appears once the saved place is known, so it doesn't jump
      // from 0:00 to the resume point.
      duration: playable && (ready || resumeError) ? state.totalDuration : 0,
      seekable: playable && ready,
      skip: playable && ready,
      rate: playable
        ? { value: state.playbackRate, options: supportedPlaybackRates }
        : null,
      follow: { visible: viewingItem && ownsSelected && !state.following },
      download: null,
      // -10 and +10 stay in the dock whatever the item; Contents and the
      // previous and next section are in Contents and the full player.
      contents: viewingItem && !els.toc.hidden,
      sections:
        playable &&
        ready &&
        (state.detached ? sectionStarts().length > 0 : !els.toc.hidden)
          ? {
              previous: absoluteOffset() > 1,
              next: sectionStarts().some(
                (start) => start.position > state.index,
              ),
            }
          : null,
    };
  }

  window.ZakReader = {
    // The open item names the browser tab and history entry.
    documentTitle() {
      if (state.showingLibrary || els.main.hidden) return "";
      return state.item?.title || state.loadingTitle || "";
    },
    selectedId() {
      return state.showingLibrary
        ? ""
        : state.attemptedID || state.item?.id || "";
    },
    // The lock screen and the player act on what is narrating.
    play: () => inPlayback(toggleReaderPlayback),
    retryAudio: () => inPlayback(() => loadAudio(state.position, true)),
    stop: stopActivePlayback,
    seekBy(offset) {
      inPlayback(() => seekAbsolute(absoluteOffset() + Number(offset || 0)));
    },
    seekTo(position) {
      inPlayback(() => seekAbsolute(Number(position || 0)));
    },
    nextSegment() {
      inPlayback(() => stepSegment(1));
    },
    previousSegment() {
      inPlayback(() => stepSegment(-1));
    },
  };
  window.ZakPlayer?.register("reader", {
    describe: describePlayer,
    toggle: window.ZakReader.play,
    seekTo: window.ZakReader.seekTo,
    seekBy: window.ZakReader.seekBy,
    setRate: setPlaybackRate,
    follow: backToNarration,
    previousSection: () => inPlayback(() => stepSection(-1)),
    nextSection: () => inPlayback(() => stepSection(1)),
    openContents: (opener) => openTocSheet(opener),
  });
}
