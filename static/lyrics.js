import { timeLabel } from "./format.js";
import { failureSentence } from "./problem.js";
import { animateLayout, SCROLL_KEYS } from "./motion.js";

// Untimed lyrics often mark sections in brackets ("[Chorus]"). They are
// labels for the song's structure, not sung lines.
const SECTION_MARKER = /^\s*\[([^\]\n]{1,40})\]\s*$/;

// Lyrics for the current Radio song. Timed lyrics follow the station position
// until the listener scrolls; following then stays off until "Follow the
// song" or the next song. Lines are seek buttons only when this listener can
// seek. On touch screens timed lyrics scroll with the page instead of inside
// a box of their own, except in the full-screen view ("sheet" mode), where
// they scroll in place beside the controls.
export function createLyricsView({
  els,
  api,
  currentTrackId,
  position,
  canSeek,
  seek,
  isLive = () => true,
  onAvailability = () => {},
}) {
  // Desktop widths keep lyrics in their own column, even on touch screens.
  const touch = window.matchMedia("(pointer: coarse) and (max-width: 1023px)");
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
  const state = {
    lastTextTrackId: null,
    syncedLyrics: null,
    activeLyricCue: -1,
    lyricsLoadGeneration: 0,
    following: true,
    seekable: false,
    plainWarning: false,
    mode: "page",
    availability: "loading",
  };

  // What the song's lyrics are: "loading", "timed", "plain", "none", or
  // "error". Radio lays out around it.
  function setAvailability(kind) {
    if (state.availability === kind) return;
    state.availability = kind;
    onAvailability(kind);
  }

  // The follow state has a line of its own; how trustworthy the lyrics are
  // is one short phrase that opens the full notes.
  function setStatus(message) {
    if (els.lyricsSyncStatus.textContent !== message)
      els.lyricsSyncStatus.textContent = message;
    els.lyricsSyncStatus.hidden = !message;
  }

  // Neutral facts about the lyrics (backing vocals in italics, lines that
  // aren't timed) are a quiet legend, not a warning.
  // Entries are text, or { text, mark } for one keyed by a symbol in the
  // lyrics (the uncertain-line dot).
  function setLegend(lines = []) {
    const key = JSON.stringify(lines);
    if (els.lyricsLegend.dataset.key !== key) {
      els.lyricsLegend.dataset.key = key;
      els.lyricsLegend.replaceChildren(
        ...lines.map((line) => {
          const item = document.createElement("span");
          item.className = "lyrics-legend-item";
          if (typeof line === "object" && line.mark) {
            const mark = document.createElement("span");
            mark.className = `lyrics-legend-mark is-${line.mark}`;
            mark.setAttribute("aria-hidden", "true");
            const name = document.createElement("span");
            name.className = "sr-only";
            name.textContent = `${line.name} `;
            item.append(mark, name);
          }
          item.append(typeof line === "object" ? line.text : line);
          return item;
        }),
      );
    }
    els.lyricsLegend.hidden = !lines.length;
  }

  // Amber is kept for real reliability warnings.
  function setQuality(label = "", notes = []) {
    const key = JSON.stringify([label, notes]);
    if (els.lyricsQuality.dataset.key === key) return;
    els.lyricsQuality.dataset.key = key;
    els.lyricsQuality.hidden = !label;
    els.lyricsQuality.dataset.quality =
      label === "Auto-generated lyrics" ? "automatic" : "uncertain";
    els.lyricsQualityLabel.textContent = label;
    els.lyricsQuality.setAttribute("aria-expanded", "false");
    els.lyricsQualityNotes.hidden = true;
    els.lyricsQualityNotes.replaceChildren(
      ...notes.map((note) => {
        const item = document.createElement("li");
        item.textContent = note;
        return item;
      }),
    );
  }

  els.lyricsQuality.addEventListener("click", () => {
    const open = els.lyricsQuality.getAttribute("aria-expanded") !== "true";
    els.lyricsQuality.setAttribute("aria-expanded", String(open));
    els.lyricsQualityNotes.hidden = !open;
  });

  els.lyricsContext.addEventListener("focusout", (event) => {
    if (event.relatedTarget && els.lyricsContext.contains(event.relatedTarget))
      return;
    els.lyricsQuality.setAttribute("aria-expanded", "false");
    els.lyricsQualityNotes.hidden = true;
  });
  els.lyricsContext.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || els.lyricsQualityNotes.hidden) return;
    event.preventDefault();
    els.lyricsQualityNotes.hidden = true;
    els.lyricsQuality.setAttribute("aria-expanded", "false");
    els.lyricsQuality.focus({ preventScroll: true });
  });

  function pageScrolling() {
    return (
      touch.matches && Boolean(state.syncedLyrics) && state.mode !== "sheet"
    );
  }

  function setViewportRegion(scrollable) {
    if (scrollable && (!touch.matches || state.mode === "sheet")) {
      els.lyricsViewport.setAttribute("role", "region");
      els.lyricsViewport.setAttribute("aria-labelledby", "lyricsTitle");
      els.lyricsViewport.tabIndex = 0;
    } else {
      els.lyricsViewport.removeAttribute("role");
      els.lyricsViewport.removeAttribute("aria-labelledby");
      els.lyricsViewport.removeAttribute("tabindex");
    }
  }

  function renderSkeleton() {
    els.lyrics.replaceChildren(
      ...[78, 64, 84, 52].map((width) => {
        const line = document.createElement("span");
        line.className = "skeleton skeleton-lyric";
        line.style.width = `${width}%`;
        line.setAttribute("aria-hidden", "true");
        return line;
      }),
    );
  }

  function clearStationText(message, { loading = false } = {}) {
    focusLyricsContainer();
    state.lastTextTrackId = null;
    state.lyricsLoadGeneration++;
    resetSyncedLyrics();
    setLyricsExpanded(false);
    setAvailability(loading ? "loading" : "error");
    if (loading) renderSkeleton();
    else els.lyrics.textContent = message;
    renderPrompt(null, "");
    els.lyricsMoreRow.hidden = true;
    els.lyricsFade.hidden = true;
  }

  // The song description is the musical description alone. Lines such as
  // "Title:", "Persona:", and "Seed:" are how the song was made; they go
  // under "Creation details", and a title that repeats the song's is left out.
  const CREATION_LINE =
    /^(title|persona|seed|model|version|artist|weirdness|style influence)\s*:\s*(.*)$/i;
  function renderPrompt(track, text, message = "") {
    const description = [];
    const details = [];
    for (const raw of String(text || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")) {
      const line = raw.trim();
      const match = CREATION_LINE.exec(line);
      if (!match) {
        description.push(raw);
        continue;
      }
      const label =
        match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
      const value = match[2].trim();
      if (!value) continue;
      if (
        label === "Title" &&
        track &&
        value.toLocaleLowerCase() ===
          String(window.ZakTrackDisplayTitle?.(track) || track.title || "")
            .trim()
            .toLocaleLowerCase()
      )
        continue;
      details.push([label, value]);
    }
    const words = description.join("\n").trim();
    els.prompt.textContent =
      message || words || (track ? EMPTY_TEXT.prompt : "");
    els.promptMeta.hidden = !details.length;
    els.promptMeta.open = false;
    els.promptMetaList.replaceChildren(
      ...details.map(([label, value]) => {
        const row = document.createElement("div");
        const term = document.createElement("dt");
        term.textContent = label;
        const definition = document.createElement("dd");
        definition.textContent = value;
        row.append(term, definition);
        return row;
      }),
    );
  }

  async function fetchText(track, kind) {
    const data = await api(`/api/track/${track.id}?kind=${kind}`);
    return data[kind] || "";
  }

  function focusLyricsContainer() {
    const focused = document.activeElement;
    if (
      els.lyrics.contains(focused) ||
      els.lyricsContext.contains(focused) ||
      els.lyricsMoreRow.contains(focused) ||
      focused === els.lyricsFollow
    )
      els.lyricsFrame.focus({ preventScroll: true });
  }

  async function loadTrackText(track) {
    if (!track || state.lastTextTrackId === track.id) return;
    focusLyricsContainer();
    state.lastTextTrackId = track.id;
    const generation = ++state.lyricsLoadGeneration;
    resetSyncedLyrics();
    setLyricsExpanded(false);
    setAvailability("loading");
    renderSkeleton();
    els.lyricsMoreRow.hidden = true;
    els.lyricsFade.hidden = true;
    renderPrompt(null, "", "Loading…");
    const lyricRequest = track.has_synced_lyrics
      ? loadTimedLyrics(track, generation)
      : loadTrackTextKind(track, "lyrics", els.lyrics);
    await Promise.allSettled([
      lyricRequest,
      loadTrackTextKind(track, "prompt", els.prompt),
    ]);
    if (currentTrackId() === track.id)
      window.requestAnimationFrame(updateLyricsOverflow);
  }

  async function loadTimedLyrics(track, generation) {
    try {
      const value = await fetchText(track, "timed_lyrics");
      if (
        currentTrackId() !== track.id ||
        generation !== state.lyricsLoadGeneration
      )
        return;
      if (!value?.cues?.length) throw new Error("No synchronized lyric cues");
      animateLayout([els.lyricsFrame], () => renderTimedLyrics(value));
    } catch {
      if (
        currentTrackId() !== track.id ||
        generation !== state.lyricsLoadGeneration
      )
        return;
      resetSyncedLyrics();
      await loadTrackTextKind(track, "lyrics", els.lyrics);
    }
  }

  const EMPTY_TEXT = {
    lyrics: "This song has no lyrics.",
    prompt: "This song has no description.",
  };

  function renderPlainLyrics(element, text) {
    const nodes = [];
    let lines = [];
    const flush = () => {
      while (lines.length && !lines[0].trim()) lines.shift();
      while (lines.length && !lines.at(-1).trim()) lines.pop();
      if (lines.length) {
        const stanza = document.createElement("span");
        stanza.className = "lyrics-stanza";
        stanza.textContent = lines.join("\n");
        nodes.push(stanza);
      }
      lines = [];
    };
    for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
      const marker = SECTION_MARKER.exec(line);
      if (!marker) {
        lines.push(line);
        continue;
      }
      flush();
      const label = document.createElement("span");
      label.className = "lyrics-section-label";
      label.textContent = marker[1].trim();
      nodes.push(label);
    }
    flush();
    element.replaceChildren(...nodes);
  }

  async function loadTrackTextKind(track, kind, element) {
    try {
      const value = await fetchText(track, kind);
      if (currentTrackId() !== track.id) return;
      animateLayout([els.lyricsFrame], () => {
        if (kind === "lyrics") focusLyricsContainer();
        if (kind === "prompt") renderPrompt(track, value);
        else if (value.trim()) renderPlainLyrics(element, value);
        else element.textContent = EMPTY_TEXT[kind];
        if (kind === "lyrics") {
          setAvailability(value.trim() ? "plain" : "none");
          state.plainWarning = track.lyrics_quality_status === "warning";
          setStatus("");
          setLegend();
          setQuality(
            state.plainWarning ? "Auto-generated lyrics" : "",
            state.plainWarning
              ? [
                  "These lyrics were transcribed automatically, so some words may be wrong.",
                ]
              : [],
          );
          updateLyricsOverflow();
        }
      });
    } catch (error) {
      if (currentTrackId() !== track.id) return;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "button text-retry";
      retry.textContent = "Try again";
      retry.addEventListener("click", () =>
        loadTrackTextKind(track, kind, element),
      );
      const message = document.createElement("span");
      message.textContent = `${failureSentence(
        error,
        kind === "lyrics"
          ? "the lyrics didn’t load"
          : "the song description didn’t load",
      )} `;
      if (kind === "prompt") renderPrompt(track, "", " ");
      else setAvailability("error");
      if (kind === "lyrics") focusLyricsContainer();
      element.replaceChildren(message, retry);
    }
  }

  function resetSyncedLyrics() {
    state.syncedLyrics = null;
    state.activeLyricCue = -1;
    state.following = true;
    state.plainWarning = false;
    els.lyricsViewport.classList.remove("has-synced-lyrics", "is-page-scroll");
    els.lyricsFollow.hidden = true;
    setStatus("");
    setQuality();
    setLegend();
    setViewportRegion(false);
    els.toggleLyrics.hidden = false;
  }

  function cueElement(cue, index, seekable) {
    const line = document.createElement(seekable ? "button" : "p");
    if (seekable) line.type = "button";
    line.className = "synced-lyric-cue";
    line.dataset.lyricCue = String(index);
    const primary = document.createElement("span");
    primary.className = "synced-lyric-primary";
    primary.textContent = cue.text;
    line.append(primary);
    // An uncertain line gets a small dot in the margin, keyed by the
    // legend above, instead of a label that repeats on every line.
    if (cue.quality_status === "warning") {
      line.classList.add("is-uncertain");
      const flag = document.createElement("span");
      flag.className = "lyric-flag";
      const words = document.createElement("span");
      words.className = "sr-only";
      words.textContent = " (uncertain)";
      flag.append(words);
      primary.append(flag);
    }
    if (cue.secondary_text) {
      const secondary = document.createElement("span");
      secondary.className = "synced-lyric-secondary";
      const label = document.createElement("span");
      label.className = "sr-only";
      label.textContent = "Backing vocal: ";
      secondary.append(label, cue.secondary_text);
      line.append(secondary);
    }
    if (seekable) {
      // The name is set from the same words: visually hidden text would be
      // read with a stray space before its comma ("…after rain , play from
      // 0:06").
      line.setAttribute(
        "aria-label",
        [
          `${cue.text}${cue.quality_status === "warning" ? " (uncertain)" : ""}`,
          cue.secondary_text ? `backing vocal: ${cue.secondary_text}` : "",
          `play from ${timeLabel(cue.start)}`,
        ]
          .filter(Boolean)
          .join(", "),
      );
      line.addEventListener("click", () => {
        if (!canSeek()) return;
        state.following = true;
        renderFollowState();
        seek(Number(cue.start || 0));
      });
    }
    return line;
  }

  function renderTimedLyrics(timedLyrics) {
    focusLyricsContainer();
    state.syncedLyrics = timedLyrics;
    state.activeLyricCue = -1;
    state.following = true;
    state.seekable = Boolean(canSeek());
    setAvailability("timed");
    els.lyricsViewport.classList.add("has-synced-lyrics");
    els.lyricsViewport.classList.add("is-collapsed");
    els.lyricsViewport.classList.toggle("is-page-scroll", pageScrolling());
    setViewportRegion(true);
    els.lyricsFade.hidden = true;
    els.lyricsMoreRow.hidden = true;
    els.toggleLyrics.hidden = true;
    const root = document.createElement("div");
    root.className = "synced-lyrics";
    timedLyrics.cues.forEach((cue, index) => {
      root.append(cueElement(cue, index, state.seekable));
    });
    els.lyrics.replaceChildren(root);
    renderFollowState();
    updateSyncedLyrics();
  }

  function setSeekable(seekable) {
    if (!state.syncedLyrics || Boolean(seekable) === state.seekable) return;
    const scrollTop = els.lyricsViewport.scrollTop;
    const following = state.following;
    renderTimedLyrics(state.syncedLyrics);
    state.following = following;
    renderFollowState();
    els.lyricsViewport.scrollTop = scrollTop;
  }

  // One short phrase for the most important reliability caveat, with the
  // full list behind it, and a quiet legend for what is simply how the
  // lyrics are shown.
  function qualityStatus(timedLyrics) {
    const uncertain = timedLyrics?.cues?.some(
      (cue) => cue.quality_status === "warning",
    );
    const quality = timedLyrics?.quality || {};
    const coverage = Math.round(Number(quality.line_coverage || 0) * 100);
    const notes = [];
    const legend = [];
    let label = "";
    if (quality.status === "warning") {
      label = "Auto-generated lyrics";
      notes.push(
        "These lyrics were transcribed automatically, so words and timing may be off.",
      );
    }
    if (uncertain) {
      label ||= "Some lines uncertain";
      notes.push("Some lines were hard to make out and may have wrong words.");
      legend.push({
        text: "marks a line that may have wrong words.",
        mark: "uncertain",
        name: "A dot",
      });
    }
    if (quality.alternate_vocals_unresolved) {
      label ||= "Backing vocals may be wrong";
      notes.push(
        "Backing vocals are shown in italics and may have wrong words.",
      );
    } else if (quality.alternate_vocals_detected) {
      legend.push("Backing vocals are indented in italics.");
    }
    if (coverage > 0 && coverage < 100) {
      legend.push(`${coverage}% of lines are timed; the rest don’t highlight.`);
    }
    return { label, notes, legend };
  }

  // "Following the song" only while the song is playing.
  function renderFollowState() {
    if (!state.syncedLyrics) return;
    els.lyricsFollow.hidden = state.following;
    els.lyricsFollow.classList.toggle("is-floating", pageScrolling());
    setStatus(
      !isLive()
        ? ""
        : state.following
          ? "Following the song"
          : "Not following · you scrolled",
    );
    const quality = qualityStatus(state.syncedLyrics);
    setQuality(quality.label, quality.notes);
    setLegend(quality.legend);
  }

  function lyricCueAt(at) {
    const cues = state.syncedLyrics?.cues || [];
    let low = 0;
    let high = cues.length - 1;
    let candidate = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (Number(cues[middle].start) <= at) {
        candidate = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (candidate < 0) return -1;
    return at <= Number(cues[candidate].end) + 0.35 ? candidate : -1;
  }

  // The space between the sticky app bar and the docked player.
  function visibleBand() {
    const rail = document.querySelector(".app-rail");
    const top = rail ? Math.max(0, rail.getBoundingClientRect().bottom) : 0;
    const player =
      Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--bottom-chrome",
        ),
      ) || 0;
    return { top, bottom: window.innerHeight - player };
  }

  function scrollToCue(current, behavior) {
    if (!pageScrolling()) {
      const top =
        current.offsetTop -
        Math.max(
          0,
          (els.lyricsViewport.clientHeight - current.offsetHeight) / 2,
        );
      els.lyricsViewport.scrollTo({ top: Math.max(0, top), behavior });
      return;
    }
    // Page scrolling follows only while the listener is reading the lyrics,
    // so it never pulls the controls away.
    const band = visibleBand();
    const box = els.lyricsViewport.getBoundingClientRect();
    if (box.top > band.top + 96 || box.bottom < band.bottom - 48) return;
    const rect = current.getBoundingClientRect();
    const height = band.bottom - band.top;
    if (
      rect.top >= band.top + height * 0.2 &&
      rect.bottom <= band.bottom - height * 0.3
    )
      return;
    window.scrollBy({
      top: rect.top - (band.top + height * 0.35),
      behavior,
    });
  }

  function updateSyncedLyrics() {
    if (!state.syncedLyrics) return;
    const next = lyricCueAt(Number(position()) || 0);
    if (next === state.activeLyricCue) return;
    if (state.activeLyricCue >= 0) {
      const previous = els.lyrics.querySelector(
        `[data-lyric-cue="${state.activeLyricCue}"]`,
      );
      previous?.classList.remove("is-current");
      previous?.removeAttribute("aria-current");
    }
    state.activeLyricCue = next;
    if (next < 0) return;
    const current = els.lyrics.querySelector(`[data-lyric-cue="${next}"]`);
    current?.classList.add("is-current");
    current?.setAttribute("aria-current", "true");
    if (!current || !state.following) return;
    scrollToCue(current, calm.matches ? "auto" : "smooth");
  }

  function stopFollowing() {
    if (!state.syncedLyrics || !state.following) return;
    state.following = false;
    renderFollowState();
  }

  function setLyricsExpanded(expanded) {
    els.lyricsViewport.classList.toggle("is-collapsed", !expanded);
    els.lyricsFade.hidden = expanded;
    els.toggleLyrics.setAttribute("aria-expanded", String(expanded));
    els.toggleLyrics.textContent = expanded ? "Show less" : "Show full lyrics";
  }

  function updateLyricsOverflow() {
    if (state.syncedLyrics) {
      els.lyricsMoreRow.hidden = true;
      els.lyricsFade.hidden = true;
      return;
    }
    const expanded = els.toggleLyrics.getAttribute("aria-expanded") === "true";
    const wasCollapsed = els.lyricsViewport.classList.contains("is-collapsed");
    if (!wasCollapsed) els.lyricsViewport.classList.add("is-collapsed");
    const overflows =
      els.lyrics.scrollHeight > els.lyricsViewport.clientHeight + 1;
    if (!wasCollapsed) els.lyricsViewport.classList.remove("is-collapsed");
    els.lyricsMoreRow.hidden = !overflows;
    els.lyricsFade.hidden = expanded || !overflows;
    const scrolls =
      els.lyricsViewport.scrollHeight > els.lyricsViewport.clientHeight + 1 &&
      ["auto", "scroll"].includes(
        getComputedStyle(els.lyricsViewport).overflowY,
      );
    setViewportRegion(scrolls);
  }

  els.toggleLyrics.addEventListener("click", () => {
    setLyricsExpanded(
      els.toggleLyrics.getAttribute("aria-expanded") !== "true",
    );
  });
  els.lyricsFollow.addEventListener("click", () => {
    state.following = true;
    renderFollowState();
    state.activeLyricCue = -1;
    if (pageScrolling()) {
      const current = els.lyrics.querySelector(".is-current");
      current?.scrollIntoView({
        block: "center",
        behavior: calm.matches ? "auto" : "smooth",
      });
    }
    updateSyncedLyrics();
    if (!pageScrolling()) els.lyricsViewport.focus({ preventScroll: true });
  });
  for (const eventName of ["wheel", "touchmove"]) {
    els.lyricsViewport.addEventListener(eventName, stopFollowing, {
      passive: true,
    });
  }
  els.lyricsViewport.addEventListener("keydown", (event) => {
    if (event.target === els.lyricsViewport && SCROLL_KEYS.has(event.key))
      stopFollowing();
  });
  // Dragging the scrollbar targets the viewport itself.
  els.lyricsViewport.addEventListener("pointerdown", (event) => {
    if (event.target === els.lyricsViewport) stopFollowing();
  });
  if ("ResizeObserver" in window) {
    const lyricsResizeObserver = new ResizeObserver(() =>
      updateLyricsOverflow(),
    );
    lyricsResizeObserver.observe(els.lyrics);
  } else {
    window.addEventListener("resize", updateLyricsOverflow);
  }
  // "sheet": the full-screen view, where the lyrics scroll in place;
  // "page": the Radio view.
  function setMode(mode) {
    state.mode = mode === "sheet" ? "sheet" : "page";
    if (state.syncedLyrics) {
      els.lyricsViewport.classList.toggle("is-page-scroll", pageScrolling());
      setViewportRegion(true);
      state.following = true;
      renderFollowState();
      state.activeLyricCue = -1;
      updateSyncedLyrics();
      if (state.mode === "sheet") {
        const current = els.lyrics.querySelector(".is-current");
        if (current) scrollToCue(current, "auto");
      }
    } else {
      updateLyricsOverflow();
    }
  }

  return {
    clear: clearStationText,
    load: loadTrackText,
    update: updateSyncedLyrics,
    updateOverflow: updateLyricsOverflow,
    setSeekable,
    setMode,
    syncStatus: renderFollowState,
    refresh() {
      state.activeLyricCue = -1;
      updateSyncedLyrics();
    },
  };
}
