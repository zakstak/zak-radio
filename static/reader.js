(() => {
  const supportedPlaybackRates = [1, 1.15, 1.25, 1.5, 1.75, 2];
  const storedPlaybackRate = Number(
    window.ZakStorage.get("readerPlaybackRate", "1.15"),
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
    bootError: false,
    needsRefresh: false,
    attemptedID: "",
    saveErrors: Object.create(null),
    localPlayback: Object.create(null),
    showingLibrary: false,
    filter: "all",
    sort: "newest",
    segmentsLoading: false,
    writerID: "",
    writerSequence: 0,
    effectiveDurations: Object.create(null),
  };
  let readerScrollGeneration = 0;
  window.addEventListener(
    "scroll",
    () => {
      readerScrollGeneration++;
    },
    { passive: true },
  );

  const els = {
    items: document.getElementById("readerItems"),
    count: document.getElementById("readerCount"),
    search: document.getElementById("readerSearch"),
    sort: document.getElementById("readerSort"),
    hero: document.getElementById("readerHero"),
    main: document.getElementById("readerMain"),
    libraryTitle: document.getElementById("readerLibraryTitle"),
    title: document.getElementById("readerTitle"),
    meta: document.getElementById("readerMeta"),
    details: document.getElementById("readerDetails"),
    text: document.getElementById("readerText"),
    audio: window.ZakAudio.element,
    playPause: document.getElementById("readerPlayPause"),
    playIcon: document.getElementById("readerPlayIcon"),
    pauseIcon: document.getElementById("readerPauseIcon"),
    back: document.getElementById("readerBack"),
    forward: document.getElementById("readerForward"),
    speed: document.getElementById("readerSpeed"),
    source: document.getElementById("readerSource"),
    progress: document.getElementById("readerProgress"),
    progressFill: document.getElementById("readerProgressFill"),
    progressThumb: document.getElementById("readerProgressThumb"),
    time: document.getElementById("readerTime"),
    duration: document.getElementById("readerDuration"),
    libraryBack: document.getElementById("readerLibraryBack"),
  };

  function t(seconds) {
    seconds = Number(seconds) || 0;
    const m = Math.floor(seconds / 60);
    return `${m}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  }

  function sizeLabel(bytes) {
    const value = Number(bytes);
    return Number.isFinite(value) && value > 0
      ? window.ZakFormatBytes(value)
      : "No audio";
  }

  function setReaderText(element, value) {
    if (element.textContent !== value) element.textContent = value;
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

  function applyReaderFilters() {
    const q = els.search.value.trim().toLowerCase();
    state.filtered = state.items.filter((item) => {
      const matchesSearch =
        !q ||
        `${item.title} ${item.source_url || ""} ${item.source_type || ""} ${item.status}`
          .toLowerCase()
          .includes(q);
      const ready = item.status === "ready";
      const matchesFilter =
        state.filter === "all" ||
        (state.filter === "ready" && ready) ||
        (state.filter === "processing" && !ready);
      return matchesSearch && matchesFilter;
    });
    const collator = new Intl.Collator(undefined, {
      sensitivity: "base",
      numeric: true,
    });
    if (state.sort === "title") {
      state.filtered.sort((a, b) =>
        collator.compare(a.title || "", b.title || ""),
      );
    } else if (state.sort === "duration") {
      state.filtered.sort(
        (a, b) => Number(b.total_duration || 0) - Number(a.total_duration || 0),
      );
    } else {
      state.filtered.sort(
        (a, b) => Number(b.uploaded_at || 0) - Number(a.uploaded_at || 0),
      );
    }
    els.count.textContent = `${state.filtered.length} reader items`;
  }

  function renderList() {
    applyReaderFilters();
    els.items.textContent = "";
    for (const item of state.filtered) {
      const card = document.createElement("button");
      card.type = "button";
      const isCurrent = !state.showingLibrary && state.item?.id === item.id;
      card.className = isCurrent ? "reader-card is-active" : "reader-card";
      card.dataset.itemId = item.id;
      if (isCurrent) card.setAttribute("aria-current", "true");
      const icon = document.createElement("div");
      icon.className = "reader-card-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML =
        '<svg viewBox="0 0 48 48"><path d="M13 6h16l8 8v28H13z"></path><path d="M29 6v9h8M19 23h12M19 29h12M19 35h8"></path></svg>';
      const copy = document.createElement("div");
      copy.className = "reader-card-copy";
      const kicker = document.createElement("div");
      kicker.className = "track-kicker";
      kicker.textContent = `${item.status || "saved"} · ${item.source_type || "source"}`;
      const title = document.createElement("div");
      title.className = "reader-card-title";
      title.textContent = item.title;
      const meta = document.createElement("div");
      meta.className = "reader-card-meta";
      meta.textContent = `${t(item.total_duration)} · ${item.segment_count} segments · ${sizeLabel(item.audio_bytes)}`;
      const url = document.createElement("div");
      url.className = "reader-card-url";
      url.textContent = item.source_url || item.source_type;
      copy.append(kicker, title, meta, url);
      const open = document.createElement("span");
      open.className = "reader-open-action";
      open.textContent =
        item.status === "ready" ? "Open Reader" : "View status";
      card.setAttribute("aria-label", `${open.textContent}: ${item.title}`);
      card.onclick = () =>
        loadItem(item.id, { historyMode: "push", focusDetail: true });
      card.append(icon, copy, open);
      els.items.append(card);
    }
    if (!state.filtered.length) {
      const empty = document.createElement("p");
      empty.className = "reader-empty";
      const heading = document.createElement("strong");
      if (state.items.length) {
        heading.textContent = "Nothing matches this Reader filter.";
        empty.append(heading, "Clear the search or choose a different status.");
      } else {
        heading.textContent = "The reading room is quiet.";
        empty.append(
          heading,
          "Saved documents will appear here when they are ready.",
        );
      }
      els.items.append(empty);
    }
  }

  function renderLibrary() {
    state.showingLibrary = true;
    els.hero.hidden = false;
    els.main.hidden = true;
    els.libraryBack.hidden = true;
    els.text.inert = false;
    els.text.setAttribute("aria-busy", "false");
    window.clearTimeout(state.refreshTimer);
    els.title.textContent = "Reader Library";
    setReaderText(els.meta, "Pick something to read/listen to");
    els.details.textContent = `${state.filtered.length} matching reader item${state.filtered.length === 1 ? "" : "s"}. Audio, source text, and images are preserved when available.`;
    els.source.removeAttribute("href");
    els.source.tabIndex = -1;
    els.source.setAttribute("aria-disabled", "true");
    const ownsReader =
      window.ZakAudio.is("reader") && Boolean(state.activePlayback);
    els.playPause.disabled = !ownsReader;
    [els.back, els.forward, els.progress].forEach((control) => {
      control.disabled = true;
    });
    els.text.textContent = "";
    if (!ownsReader) {
      els.time.textContent = "0:00";
      els.duration.textContent = "0:00";
      els.progress.value = "0";
      els.progress.max = "0";
      els.progressFill.style.width = "0%";
      els.progressThumb.style.left = "0%";
    }
    window.ZakAudio.refreshOwner?.();
    renderList();
    renderPlaybackState();
  }

  function absoluteOffset() {
    let x = 0;
    for (let i = 0; i < state.index; i++) {
      if (isPlayable(state.segments[i]))
        x += segmentDuration(state.segments[i]);
    }
    const ownsSelected =
      window.ZakAudio.is("reader") &&
      state.activePlayback?.itemID === state.item?.id &&
      Number(state.activePlayback?.segmentIndex) ===
        Number(state.segments[state.index]?.segment_index);
    const position =
      ownsSelected && !els.audio.ended
        ? els.audio.currentTime || 0
        : state.position;
    return x + position;
  }

  function renderProgress() {
    const pos = absoluteOffset();
    els.time.textContent = t(pos);
    els.duration.textContent = t(state.totalDuration);
    els.progress.max = String(state.totalDuration || 0);
    els.progress.value = String(Math.min(pos, state.totalDuration || pos));
    const percent =
      state.totalDuration > 0
        ? Math.max(0, Math.min(100, (pos / state.totalDuration) * 100))
        : 0;
    els.progressFill.style.width = `${percent}%`;
    els.progressThumb.style.left = `${percent}%`;
    updateReaderPositionState();
  }

  function updateReaderPositionState() {
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

  function highlight(scroll = true) {
    document.querySelectorAll("[data-segment]").forEach((el) => {
      el.classList.remove("is-current");
      el.querySelector("button")?.removeAttribute("aria-current");
    });
    const segmentIndex = state.segments[state.index]?.segment_index;
    const el = document.querySelector(`[data-index="${segmentIndex}"]`);
    if (el) {
      el.classList.add("is-current");
      el.querySelector("button")?.setAttribute("aria-current", "true");
      if (scroll) {
        const reduced = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        el.scrollIntoView({
          block: "center",
          behavior: reduced ? "auto" : "smooth",
        });
      }
    }
  }

  function applyPlaybackRate() {
    if (!supportedPlaybackRates.includes(state.playbackRate))
      state.playbackRate = 1.15;
    if (els.speed) els.speed.value = String(state.playbackRate);
    if (window.ZakAudio.is("reader"))
      els.audio.playbackRate = state.playbackRate;
    updateReaderPositionState();
  }

  function loadAudio(position = 0, play = false) {
    if (!state.item || state.resumeReady[state.item.id] !== true) return false;
    if (!isPlayable(state.segments[state.index])) {
      state.index = state.segments.findIndex(isPlayable);
    }
    let seg = state.segments[state.index];
    if (!seg || seg.status !== "ready") return;
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
    const changed = window.ZakAudio.claim(
      "reader",
      src,
      state.item.title || "Reader audio",
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
      state.metadataHandler = () => {
        state.metadataHandler = null;
        if (
          !window.ZakAudio.is("reader") ||
          window.ZakAudio.generation !== generation ||
          !els.audio.currentSrc.endsWith(src)
        )
          return;
        els.audio.currentTime = position;
        if (play) window.ZakAudio.play();
      };
      els.audio.addEventListener("loadedmetadata", state.metadataHandler, {
        once: true,
      });
    }
    applyPlaybackRate();
    highlight();
    if (play && !changed) window.ZakAudio.play();
    return true;
  }

  function stopActivePlayback() {
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
    els.audio.pause();
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
        const warning = document.createElement("div");
        warning.className = "reader-warning";
        warning.textContent = "Image unavailable. ";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "button";
        retry.textContent = "Retry image";
        retry.dataset.readerAction = "retry-image";
        retry.onclick = () =>
          loadItem(state.item.id, { historyMode: "none", background: true });
        warning.append(retry);
        figure.replaceChildren(warning);
      },
      { once: true },
    );
    const cap = document.createElement("figcaption");
    cap.textContent = img.alt || img.figure || "";
    figure.append(image, cap);
    els.text.append(figure);
  }

  function renderText() {
    els.text.textContent = "";
    if (state.resumeError) {
      const warning = document.createElement("div");
      warning.className = "reader-warning";
      warning.setAttribute("role", "alert");
      warning.textContent =
        "Saved listening progress is temporarily unavailable. Playback is paused to protect your last position. ";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "button";
      retry.textContent = "Retry saved progress";
      retry.dataset.readerAction = "retry-resume";
      retry.onclick = () =>
        loadItem(state.item.id, { historyMode: "none", background: true });
      warning.append(retry);
      els.text.append(warning);
    }
    if (state.saveErrors[state.item.id]) {
      const warning = document.createElement("div");
      warning.id = "readerSaveWarning";
      warning.className = "reader-warning";
      warning.setAttribute("role", "alert");
      warning.textContent = "Listening progress could not be saved. ";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "button";
      retry.textContent = "Retry progress save";
      retry.dataset.readerAction = "retry-save";
      retry.onclick = () => retryPlaybackSave();
      warning.append(retry);
      els.text.append(warning);
    }
    if (state.item.quality_warnings?.length) {
      const warnings = document.createElement("div");
      warnings.className = "reader-warning";
      warnings.textContent = state.item.quality_warnings.join(" · ");
      els.text.append(warnings);
    }
    if (state.imagesError) {
      const warning = document.createElement("div");
      warning.className = "reader-warning";
      warning.textContent = "Preserved images are temporarily unavailable. ";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "button";
      retry.textContent = "Retry images";
      retry.dataset.readerAction = "retry-images";
      retry.onclick = () =>
        loadItem(state.item.id, { historyMode: "none", background: true });
      warning.append(retry);
      els.text.append(warning);
    }
    if (!state.segments.length) {
      const empty = document.createElement("div");
      empty.className = "reader-empty";
      const heading = document.createElement("strong");
      heading.textContent =
        state.item.status === "ready"
          ? "No readable segments were produced."
          : "Audio is still being prepared.";
      empty.append(
        heading,
        "The preserved Source remains available while Reader processing completes.",
      );
      els.text.append(empty);
      return;
    }
    const usedImages = new Set();
    for (const seg of state.segments) {
      const el = document.createElement(seg.kind === "heading" ? "h3" : "p");
      el.className = `reader-segment${seg.kind === "heading" ? " is-heading" : ""}${seg.status !== "ready" ? " is-pending" : ""}`;
      el.dataset.segment = "true";
      el.dataset.index = seg.segment_index;
      const control = document.createElement("button");
      control.type = "button";
      control.className = "reader-segment-button";
      control.textContent = seg.text;
      control.disabled =
        seg.status !== "ready" || state.resumeReady[state.item.id] !== true;
      control.setAttribute(
        "aria-label",
        `${seg.kind === "heading" ? "Heading" : "Read"}: ${seg.text}`,
      );
      control.onclick = () => {
        state.index = state.segments.indexOf(seg);
        loadAudio(0, true);
      };
      el.append(control);
      els.text.append(el);
      for (const img of imagesForSegment(seg)) {
        usedImages.add(img.index);
        appendImage(img);
      }
    }
    const remaining = state.images.filter((img) => !usedImages.has(img.index));
    if (remaining.length) {
      const h = document.createElement("h3");
      h.className = "reader-images-heading";
      h.textContent = "Images";
      els.text.append(h);
      for (const img of remaining) appendImage(img);
    }
  }

  function renderTextPreservingFocus() {
    const focusedSegment =
      document.activeElement?.closest?.("[data-segment]")?.dataset.index;
    const focusedAction = document.activeElement?.dataset?.readerAction;
    const priorScroll = window.scrollY;
    const priorScrollGeneration = readerScrollGeneration;
    renderText();
    if (focusedSegment !== undefined && focusedSegment !== null) {
      document
        .querySelector(
          `[data-index="${CSS.escape(String(focusedSegment))}"] button`,
        )
        ?.focus({ preventScroll: true });
    } else if (focusedAction) {
      document
        .querySelector(`[data-reader-action="${CSS.escape(focusedAction)}"]`)
        ?.focus({ preventScroll: true });
    }
    if (readerScrollGeneration === priorScrollGeneration) {
      window.scrollTo({ top: priorScroll });
    }
  }

  function showSaveError() {
    if (document.getElementById("readerSaveWarning")) return;
    const warning = document.createElement("div");
    warning.id = "readerSaveWarning";
    warning.className = "reader-warning";
    warning.setAttribute("role", "alert");
    warning.textContent = "Listening progress could not be saved. ";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button";
    retry.textContent = "Retry progress save";
    retry.onclick = () => retryPlaybackSave();
    warning.append(retry);
    els.text.prepend(warning);
  }

  function showDurationError(declared, decoded) {
    let warning = document.getElementById("readerDurationWarning");
    if (!warning) {
      warning = document.createElement("div");
      warning.id = "readerDurationWarning";
      warning.className = "reader-warning";
      warning.setAttribute("role", "alert");
      els.text.prepend(warning);
    }
    const relation = decoded < declared ? "before" : "after";
    warning.textContent = `This audio ended at ${t(decoded)}, ${relation} its declared ${t(declared)} duration.`;
  }

  function updateReaderURL(id, mode) {
    if (mode === "none") return;
    window.ZakCommitScrollState?.();
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
    const pending = window.ZakPendingRouteScroll;
    const target = pending || fallback;
    if (!target) return;
    const apply = () =>
      window.scrollTo({
        left: Number(target[0]) || 0,
        top: Number(target[1]) || 0,
        behavior: "instant",
      });
    window.requestAnimationFrame(() => {
      apply();
      window.requestAnimationFrame(() => {
        apply();
        if (window.ZakPendingRouteScroll === pending) {
          window.ZakPendingRouteScroll = null;
        }
      });
    });
  }

  function showReaderError(error, id) {
    els.text.inert = false;
    els.text.setAttribute("aria-busy", "false");
    setReaderText(els.meta, "Reader item unavailable");
    els.title.textContent = "Reader item unavailable";
    els.details.textContent =
      `${id} could not be loaded. ${error.message || ""}`.trim();
    const message = document.createElement("div");
    message.className = "error-message";
    message.setAttribute("role", "alert");
    message.textContent = "This Reader item could not be loaded. ";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button";
    retry.textContent = "Retry";
    retry.onclick = () =>
      loadItem(id, { historyMode: "replace", focusDetail: true });
    message.append(retry);
    els.text.replaceChildren(message);
    els.title.focus({ preventScroll: true });
  }

  async function loadItem(
    id,
    { historyMode = "none", focusDetail = false, background = false } = {},
  ) {
    state.loadAbort?.abort();
    const controller = new AbortController();
    state.loadAbort = controller;
    const generation = ++state.loadGeneration;
    const encoded = encodeURIComponent(id);
    const focusedSegment = background
      ? document.activeElement?.closest?.("[data-segment]")?.dataset.index
      : null;
    const focusedItem = background
      ? document.activeElement?.closest?.("[data-item-id]")?.dataset.itemId
      : null;
    const focusedAction = background
      ? document.activeElement?.dataset?.readerAction
      : null;
    const priorScroll = background ? window.scrollY : 0;
    const priorScrollGeneration = background ? readerScrollGeneration : 0;
    if (!background) {
      els.hero.hidden = true;
      els.main.hidden = false;
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = 0;
      state.needsRefresh = false;
      if (state.activePlayback?.itemID !== id) stopActivePlayback();
      state.showingLibrary = false;
      state.item = null;
      state.segments = [];
      state.images = [];
      state.imagesError = false;
      state.totalDuration = 0;
      state.position = 0;
      state.effectiveDurations = Object.create(null);
      delete state.resumeReady[id];
      state.resumeError = false;
      state.segmentsLoading = true;
      state.attemptedID = id;
      updateReaderURL(id, historyMode);
      els.title.textContent = "Loading Reader item…";
      setReaderText(els.meta, "Loading Reader item…");
      els.title.focus({ preventScroll: true });
      els.source.removeAttribute("href");
      els.source.tabIndex = -1;
      els.source.setAttribute("aria-disabled", "true");
      els.text.inert = true;
      els.text.setAttribute("aria-busy", "true");
      const loading = document.createElement("p");
      loading.className = "reader-empty";
      loading.setAttribute("role", "status");
      loading.textContent = "Loading this Reader item…";
      els.text.replaceChildren(loading);
      [els.back, els.playPause, els.forward, els.progress].forEach(
        (control) => {
          control.disabled = true;
        },
      );
      renderProgress();
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
      const segments = await paged(
        `/api/reader/items/${encoded}/segments`,
        "segments",
        {
          signal: controller.signal,
          onPage: (partial, payload) => {
            if (
              background ||
              generation !== state.loadGeneration ||
              controller.signal.aborted ||
              !window.location.pathname.startsWith("/reader")
            )
              return;
            state.item = item;
            state.segmentsLoading = payload.next_offset != null;
            state.segments = partial;
            refreshTotalDuration();
            els.title.textContent = item.title;
            setReaderText(
              els.meta,
              `${item.status} · ${item.voice} · ${item.source_type}`,
            );
            els.details.textContent =
              payload.next_offset == null
                ? `${partial.length} segments`
                : `${partial.length} segments loaded · Loading more…`;
          },
        },
      );
      state.segmentsLoading = false;
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
            ...(playback || {}),
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
      if (
        generation !== state.loadGeneration ||
        controller.signal.aborted ||
        !window.location.pathname.startsWith("/reader")
      )
        return false;
      if (
        background &&
        (state.item?.id !== id ||
          new URLSearchParams(location.search).get("item") !== id)
      )
        return false;
      state.item = item;
      state.showingLibrary = false;
      els.libraryBack.hidden = false;
      state.attemptedID = "";
      const itemIndex = state.items.findIndex(
        (candidate) => candidate.id === item.id,
      );
      if (itemIndex >= 0) state.items[itemIndex] = item;
      state.segments = segments;
      if (!background || !playbackError) {
        state.resumeError = playbackError;
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
      state.position =
        activeIndex >= 0
          ? Number(els.audio.currentTime || 0)
          : restored >= 0
            ? Number(playback?.position || 0)
            : 0;
      els.title.textContent = item.title;
      setReaderText(
        els.meta,
        `${item.status} · ${item.voice} · ${item.source_type}`,
      );
      els.details.textContent = playable
        ? `${segments.length} segments · ${t(state.totalDuration)} · images loading · ${sizeLabel(item.audio_bytes)} audio`
        : `${segments.length} segments · Audio is still processing or unavailable.`;
      els.source.href = `/reader-source/${encoded}/source`;
      els.source.tabIndex = 0;
      els.source.setAttribute("aria-disabled", "false");
      [els.back, els.playPause, els.forward, els.progress].forEach(
        (control) => {
          control.disabled = !playable || state.resumeReady[item.id] !== true;
        },
      );
      if (background) updateReaderURL(item.id, "none");
      renderText();
      renderList();
      state.needsRefresh =
        !playable ||
        segments.some((segment) =>
          ["pending", "processing"].includes(segment.status),
        );
      scheduleReaderRefresh(item.id);
      highlight(!background);
      renderProgress();
      renderPlaybackState();
      els.text.inert = false;
      els.text.setAttribute("aria-busy", "false");
      if (background) {
        if (focusedSegment !== undefined && focusedSegment !== null) {
          document
            .querySelector(
              `[data-index="${CSS.escape(String(focusedSegment))}"] button`,
            )
            ?.focus({ preventScroll: true });
        } else if (focusedItem) {
          document
            .querySelector(`[data-item-id="${CSS.escape(focusedItem)}"]`)
            ?.focus({ preventScroll: true });
        } else if (focusedAction) {
          (
            document.querySelector(
              `[data-reader-action="${CSS.escape(focusedAction)}"]`,
            ) || els.title
          ).focus({ preventScroll: true });
        }
        if (readerScrollGeneration === priorScrollGeneration) {
          restoreRouteScroll([0, priorScroll]);
        }
      }
      if (!background && window.ZakPendingRouteScroll) {
        restoreRouteScroll();
      }
      if (focusDetail) {
        document
          .querySelector(".reader-main")
          .scrollIntoView({ block: "start" });
        els.title.focus({ preventScroll: true });
      }
      void imagePromise
        .then((imageData) => {
          if (
            generation !== state.loadGeneration ||
            controller.signal.aborted ||
            state.item?.id !== item.id ||
            !window.location.pathname.startsWith("/reader")
          )
            return;
          state.images = imageData.images || [];
          state.imagesError = Boolean(imageData.error);
          els.details.textContent = playable
            ? `${segments.length} segments · ${t(state.totalDuration)} · ${state.imagesError ? "images unavailable" : `${state.images.length} images`} · ${sizeLabel(item.audio_bytes)} audio`
            : `${segments.length} segments · Audio is still processing or unavailable.`;
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
    }
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
    const playing = Boolean(
      window.ZakAudio.is("reader") &&
      state.item &&
      state.activePlayback?.itemID === state.item.id &&
      !els.audio.paused,
    );
    els.playPause.setAttribute("aria-label", playing ? "Pause" : "Play");
    els.playIcon.classList.toggle("hidden", playing);
    els.pauseIcon.classList.toggle("hidden", !playing);
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
        if (state.item?.id === body.item_id) {
          document.getElementById("readerSaveWarning")?.remove();
        }
      }
      return saved;
    } catch (error) {
      if (error.status === 409) {
        delete state.localPlayback[body.item_id];
        delete state.saveErrors[body.item_id];
        if (state.item?.id === body.item_id) {
          state.resumeReady[body.item_id] = false;
          state.resumeError = true;
          if (window.ZakAudio.is("reader")) {
            els.audio.pause();
            state.activePlayback = null;
            window.ZakAudio.clear("reader");
          }
          [els.back, els.playPause, els.forward, els.progress].forEach(
            (control) => {
              control.disabled = true;
            },
          );
          renderText();
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
        els.audio.pause();
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

  els.audio.addEventListener("timeupdate", () => {
    if (!window.ZakAudio.is("reader")) return;
    if (state.activePlayback?.itemID === state.item?.id) {
      state.position = els.audio.currentTime || 0;
      renderProgress();
    }
    queuePlaybackSave();
  });
  els.audio.addEventListener("play", renderPlaybackState);
  els.audio.addEventListener("pause", () => {
    renderPlaybackState();
    if (window.ZakAudio.is("reader")) savePlayback(false);
  });
  els.audio.addEventListener("ended", () => {
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
    }
  });
  async function toggleReaderPlayback() {
    if (!state.item || state.resumeReady[state.item.id] !== true) return;
    const ownsSelected =
      window.ZakAudio.is("reader") &&
      state.activePlayback?.itemID === state.item.id;
    if (!ownsSelected) loadAudio(state.position, true);
    else if (els.audio.paused) {
      if (els.audio.ended || absoluteOffset() >= state.totalDuration - 0.01) {
        state.index = state.segments.findIndex(isPlayable);
        loadAudio(0, true);
      } else {
        await window.ZakAudio.play();
      }
    } else {
      els.audio.pause();
      savePlayback(false);
    }
  }
  els.playPause.onclick = toggleReaderPlayback;
  els.back.onclick = () => seekAbsolute(absoluteOffset() - 10);
  els.forward.onclick = () => seekAbsolute(absoluteOffset() + 10);
  els.progress.oninput = () => {
    const value = Number(els.progress.value || 0);
    const percent =
      state.totalDuration > 0
        ? Math.max(0, Math.min(100, (value / state.totalDuration) * 100))
        : 0;
    els.time.textContent = t(value);
    els.progressFill.style.width = `${percent}%`;
    els.progressThumb.style.left = `${percent}%`;
  };
  els.progress.onchange = () => seekAbsolute(Number(els.progress.value || 0));
  if (els.speed) {
    els.speed.onchange = () => {
      state.playbackRate = Number(els.speed.value) || 1.15;
      window.ZakStorage.set("readerPlaybackRate", String(state.playbackRate));
      applyPlaybackRate();
    };
  }
  els.search.oninput = () => {
    if (state.bootError) {
      showReaderBootError();
      return;
    }
    renderList();
  };
  els.sort.onchange = () => {
    state.sort = els.sort.value;
    renderList();
  };
  document.querySelectorAll("[data-reader-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.readerFilter;
      document.querySelectorAll("[data-reader-filter]").forEach((candidate) => {
        candidate.setAttribute("aria-pressed", String(candidate === button));
      });
      renderList();
    });
  });
  els.libraryBack.onclick = (event) => {
    event.preventDefault();
    window.ZakCommitScrollState?.();
    const url = new URL(window.location.href);
    url.searchParams.delete("item");
    history.pushState({ scroll: [0, 0] }, "", url);
    renderLibrary();
    (window.ZakRouteScroll?.to || window.scrollTo)({ top: 0 });
    els.libraryTitle.focus({ preventScroll: true });
  };

  async function boot(force = false) {
    if (state.loading) return state.loading;
    if (state.loaded && state.bootComplete && !force) return;
    applyPlaybackRate();
    state.bootAbort?.abort();
    const controller = new AbortController();
    const generation = ++state.bootGeneration;
    state.bootAbort = controller;
    state.bootComplete = false;
    els.items.setAttribute("aria-busy", "true");
    els.count.textContent = "Loading Reader…";
    const initiallyRequested = new URLSearchParams(location.search).get("item");
    if (!initiallyRequested) {
      els.hero.hidden = false;
      els.main.hidden = true;
      const loading = document.createElement("div");
      loading.className = "reader-empty";
      loading.setAttribute("role", "status");
      loading.textContent = "Loading Reader…";
      els.items.replaceChildren(loading);
    }
    const request = (async () => {
      state.items = await paged("/api/reader/items", "items", {
        signal: controller.signal,
        onPage: (items, payload) => {
          if (
            generation !== state.bootGeneration ||
            !location.pathname.startsWith("/reader")
          )
            return;
          state.items = items;
          state.loaded = true;
          state.bootError = false;
          renderList();
          const currentRequested = new URLSearchParams(location.search).get(
            "item",
          );
          if (!currentRequested) {
            els.count.textContent =
              payload.next_offset != null
                ? `${items.length} reader items · Loading more…`
                : `${items.length} reader items`;
          }
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
      els.items.setAttribute("aria-busy", "false");
      renderList();
      const currentRequested = new URLSearchParams(location.search).get("item");
      if (currentRequested && state.item?.id !== currentRequested) {
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

  function showReaderBootError() {
    state.bootError = true;
    state.showingLibrary = true;
    els.hero.hidden = false;
    els.main.hidden = true;
    els.items.setAttribute("aria-busy", "false");
    els.text.inert = false;
    els.text.setAttribute("aria-busy", "false");
    els.count.textContent = "Reader unavailable";
    const message = document.createElement("div");
    message.className = "error-message";
    message.setAttribute("role", "alert");
    message.textContent = "Reader could not be loaded. ";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button";
    retry.textContent = "Retry";
    retry.onclick = async () => {
      retry.disabled = true;
      try {
        await boot(true);
        els.title.focus({ preventScroll: true });
      } catch (error) {
        showReaderBootError(error);
      }
    };
    message.append(retry);
    els.items.replaceChildren(message);
    els.libraryTitle.focus({ preventScroll: true });
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
  window.addEventListener("zak-audio-release", (event) => {
    if (event.detail?.owner === "reader" && state.activePlayback) {
      savePlayback(false, true, Number(event.detail.position || 0));
      if (event.detail?.nextOwner !== "reader") state.activePlayback = null;
    }
  });
  window.addEventListener("zak-route", async (event) => {
    if (event.detail?.path !== "/reader") {
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = 0;
      state.loadAbort?.abort();
      state.loadAbort = null;
      state.loadGeneration++;
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
      } catch {
        showReaderBootError();
        return;
      }
    }
    const requested = new URLSearchParams(location.search).get("item");
    if (!requested) {
      const restoreLibraryFocus = !state.showingLibrary;
      state.loadAbort?.abort();
      state.loadAbort = null;
      state.loadGeneration++;
      renderLibrary();
      if (restoreLibraryFocus) {
        window.queueMicrotask(() =>
          els.libraryTitle.focus({ preventScroll: true }),
        );
      }
      return;
    }
    if (state.item?.id !== requested) {
      await loadItem(requested, { historyMode: "none" });
    } else if (state.showingLibrary) {
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
  window.ZakReader = {
    selectedId() {
      return state.showingLibrary
        ? ""
        : state.attemptedID || state.item?.id || "";
    },
    play: toggleReaderPlayback,
    seekBy(offset) {
      seekAbsolute(absoluteOffset() + Number(offset || 0));
    },
    seekTo(position) {
      seekAbsolute(Number(position || 0));
    },
  };
})();
