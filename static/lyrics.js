import { timeLabel } from "./format.js";

export function createLyricsView({
  els,
  api,
  currentTrackId,
  stationId,
  canSeek,
  isRadio,
  seek,
  notify,
}) {
  const state = {
    lastTextTrackId: null,
    syncedLyrics: null,
    activeLyricCue: -1,
    lyricsLoadGeneration: 0,
    lyricFollowPausedUntil: 0,
  };
  function clearStationText(message) {
    state.lastTextTrackId = null;
    resetSyncedLyrics();
    setLyricsExpanded(false);
    els.lyrics.textContent = message;
    els.prompt.textContent = "";
    els.toggleDetails.setAttribute("aria-expanded", "false");
    els.toggleDetails.textContent = "View details";
    els.promptPanel.hidden = true;
    els.detailsPanels.classList.remove("is-split");
  }

  async function fetchText(track, kind) {
    const data = await api(`/api/track/${track.id}?kind=${kind}`);
    return data[kind] || "";
  }

  async function loadTrackText(track) {
    if (!track || state.lastTextTrackId === track.id) return;
    state.lastTextTrackId = track.id;
    const generation = ++state.lyricsLoadGeneration;
    resetSyncedLyrics();
    setLyricsExpanded(false);
    els.lyrics.textContent = "Loading...";
    els.prompt.textContent = "Loading...";
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
      renderTimedLyrics(value);
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

  async function loadTrackTextKind(track, kind, element) {
    try {
      const value = await fetchText(track, kind);
      if (currentTrackId() !== track.id) return;
      element.textContent = value.trim() || `No ${kind} found.`;
      if (kind === "lyrics" && track.lyrics_quality_status === "warning") {
        els.lyricsSyncStatus.textContent =
          "Auto-generated lyrics · timing may be off";
      }
    } catch {
      if (currentTrackId() !== track.id) return;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "button text-retry";
      retry.textContent = `Retry ${kind}`;
      retry.addEventListener("click", () =>
        loadTrackTextKind(track, kind, element),
      );
      element.replaceChildren(
        document.createTextNode(`Unable to load ${kind}. `),
        retry,
      );
    }
  }

  function resetSyncedLyrics() {
    state.syncedLyrics = null;
    state.activeLyricCue = -1;
    state.lyricFollowPausedUntil = 0;
    els.lyricsViewport.classList.remove("has-synced-lyrics");
    els.lyricsFollow.hidden = true;
    els.lyricsSyncStatus.textContent = "";
    els.toggleLyrics.hidden = false;
  }

  function renderTimedLyrics(timedLyrics) {
    state.syncedLyrics = timedLyrics;
    state.activeLyricCue = -1;
    els.lyricsViewport.classList.add("has-synced-lyrics");
    els.lyricsViewport.classList.add("is-collapsed");
    els.lyricsFade.hidden = true;
    els.lyricsMoreRow.hidden = true;
    els.toggleLyrics.hidden = true;
    els.lyricsFollow.hidden = true;
    els.lyricsSyncStatus.textContent = syncedLyricsStatus(timedLyrics);

    const root = document.createElement("div");
    root.className = "synced-lyrics";
    timedLyrics.cues.forEach((cue, index) => {
      const line = document.createElement("button");
      line.type = "button";
      line.className = "synced-lyric-cue";
      if (cue.quality_status === "warning") {
        line.classList.add("is-uncertain");
        line.title = "This line has lower-confidence words or timing.";
      }
      if (cue.secondary_text) line.classList.add("has-secondary-vocal");
      line.dataset.lyricCue = String(index);
      const primary = document.createElement("span");
      primary.className = "synced-lyric-primary";
      primary.textContent = cue.text;
      line.append(primary);
      if (cue.secondary_text) {
        const secondary = document.createElement("span");
        secondary.className = "synced-lyric-secondary";
        secondary.textContent = cue.secondary_text;
        line.append(secondary);
      }
      line.disabled = stationId() === "main" || !canSeek();
      line.setAttribute(
        "aria-label",
        `Seek to ${timeLabel(cue.start)}: ${cue.text}${
          cue.secondary_text ? `; overlapping vocal: ${cue.secondary_text}` : ""
        }`,
      );
      line.addEventListener("click", () => {
        if (stationId() === "main" || !canSeek()) {
          notify(
            stationId() === "main"
              ? "Radio playback stays live; seeking is unavailable."
              : "Only the station controller can seek this station.",
          );
          return;
        }
        seek(Number(cue.start || 0));
      });
      root.append(line);
    });
    els.lyrics.replaceChildren(root);
    updateSyncedLyrics();
  }

  function syncedLyricsStatus(timedLyrics) {
    if (timedLyrics?.quality?.alternate_vocals_unresolved) {
      return "Alternate vocals detected · exact words need review";
    }
    if (timedLyrics?.quality?.alternate_vocals_detected) {
      return "Following the song · alternate vocals included";
    }
    if (timedLyrics?.quality?.status === "warning") {
      return "Auto-generated lyrics · timing may be off";
    }
    const coverage = Math.round(
      Number(timedLyrics?.quality?.line_coverage || 0) * 100,
    );
    return coverage >= 100
      ? "Following the song"
      : `Following the song · ${coverage}% of written lines matched`;
  }

  function lyricCueAt(position) {
    const cues = state.syncedLyrics?.cues || [];
    let low = 0;
    let high = cues.length - 1;
    let candidate = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (Number(cues[middle].start) <= position) {
        candidate = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (candidate < 0) return -1;
    return position <= Number(cues[candidate].end) + 0.35 ? candidate : -1;
  }

  function updateSyncedLyrics(position = Number(els.audio.currentTime || 0)) {
    if (!state.syncedLyrics || !isRadio()) return;
    const next = lyricCueAt(position);
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
    if (!current || performance.now() < state.lyricFollowPausedUntil) return;
    const top =
      current.offsetTop -
      Math.max(0, (els.lyricsViewport.clientHeight - current.offsetHeight) / 2);
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    els.lyricsViewport.scrollTo({
      top: Math.max(0, top),
      behavior: reduced ? "auto" : "smooth",
    });
  }

  function pauseLyricFollowing() {
    if (!state.syncedLyrics) return;
    state.lyricFollowPausedUntil = performance.now() + 10000;
    els.lyricsFollow.hidden = false;
    els.lyricsSyncStatus.textContent = "Manual scrolling · follow paused";
  }

  function setLyricsExpanded(expanded) {
    els.lyricsViewport.classList.toggle("is-collapsed", !expanded);
    els.lyricsFade.hidden = expanded;
    els.toggleLyrics.setAttribute("aria-expanded", String(expanded));
    els.toggleLyrics.textContent = expanded
      ? "Collapse lyrics"
      : "Show full lyrics";
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
  }

  els.toggleLyrics.addEventListener("click", () => {
    setLyricsExpanded(
      els.toggleLyrics.getAttribute("aria-expanded") !== "true",
    );
  });
  els.lyricsFollow.addEventListener("click", () => {
    state.lyricFollowPausedUntil = 0;
    els.lyricsFollow.hidden = true;
    els.lyricsSyncStatus.textContent = syncedLyricsStatus(state.syncedLyrics);
    state.activeLyricCue = -1;
    updateSyncedLyrics();
  });
  ["wheel", "touchmove"].forEach((eventName) => {
    els.lyricsViewport.addEventListener(eventName, pauseLyricFollowing, {
      passive: true,
    });
  });
  if ("ResizeObserver" in window) {
    const lyricsResizeObserver = new ResizeObserver(() =>
      updateLyricsOverflow(),
    );
    lyricsResizeObserver.observe(els.lyrics);
    lyricsResizeObserver.observe(els.detailsPanels);
  } else {
    window.addEventListener("resize", updateLyricsOverflow);
  }
  return {
    clear: clearStationText,
    load: loadTrackText,
    update: updateSyncedLyrics,
    updateOverflow: updateLyricsOverflow,
    refresh() {
      state.activeLyricCue = -1;
      updateSyncedLyrics();
    },
  };
}
