(() => {
  const state = {
    tracks: [],
    visible: [],
    current: null,
    filter: "all",
    sort: "archive",
    view: window.ZakStorage.get("zak-library-view", "grid"),
    limit: 60,
    status: "loading",
    error: null,
    previewTriggerID: "",
    station: null,
  };

  const els = {
    search: document.getElementById("librarySearch"),
    sort: document.getElementById("librarySort"),
    count: document.getElementById("libraryCount"),
    heading: document.getElementById("libraryTitle"),
    tracks: document.getElementById("libraryTracks"),
    audio: window.ZakAudio.element,
    dock: document.getElementById("libraryPreviewDock"),
    dockCover: document.getElementById("libraryDockCover"),
    dockTitle: document.getElementById("libraryDockTitle"),
    currentTime: document.getElementById("libraryCurrentTime"),
    duration: document.getElementById("libraryDuration"),
    progress: document.getElementById("libraryProgress"),
    progressFill: document.getElementById("libraryProgressFill"),
    progressThumb: document.getElementById("libraryProgressThumb"),
    playPause: document.getElementById("libraryPlayPause"),
    back: document.getElementById("libraryBack"),
    forward: document.getElementById("libraryForward"),
    download: document.getElementById("libraryDownload"),
    stationTarget: document.getElementById("libraryStationTarget"),
  };

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function timeLabel(seconds) {
    const value = number(seconds);
    if (value <= 0) return "0:00";
    return `${Math.floor(value / 60)}:${Math.floor(value % 60)
      .toString()
      .padStart(2, "0")}`;
  }

  function sizeLabel(bytes) {
    const value = number(bytes);
    if (value <= 0) return "";
    return window.ZakFormatBytes(value);
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

  function createCover(track) {
    const fallback = () => window.ZakArtworkFallback();
    if (track.has_cover) {
      const image = document.createElement("img");
      image.src = window.ZakMediaURL.cover(track);
      image.alt = "";
      image.loading = "lazy";
      image.className = "track-cover";
      image.addEventListener("error", () => image.replaceWith(fallback()), {
        once: true,
      });
      return image;
    }
    return fallback();
  }

  function updateStationTarget() {
    state.station = window.ZakStation?.current?.() || null;
    if (!els.stationTarget || !state.station) return;
    const count = state.station.queue.length;
    if (state.station.canControl) {
      els.stationTarget.textContent = `Your picks will go to ${state.station.label}${count ? ` · ${count} already queued` : ""}.`;
    } else {
      els.stationTarget.textContent = `This is a listen-only private station. Its owner controls the queue.`;
    }
    document.querySelectorAll("[data-queue-action]").forEach((button) => {
      button.disabled = !state.station.canControl;
      button.title = state.station.canControl
        ? `Add to ${state.station.label}`
        : "This private station is listen-only";
    });
  }

  async function queueTrack(track, action, button, status) {
    const station = window.ZakStation?.current?.();
    if (!station?.canControl) {
      status.textContent = "This private station is listen-only.";
      return;
    }
    const label = action === "play_next" ? "Play next" : "Add to queue";
    button.disabled = true;
    status.textContent = `${label}…`;
    const result = await window.ZakStation.enqueue(action, track.id);
    updateStationTarget();
    if (result) {
      const title = window.ZakTrackDisplayTitle(track);
      status.textContent =
        action === "play_next"
          ? `${title} will play next on ${station.label}.`
          : `${title} was added to ${station.label}.`;
    } else {
      status.textContent = `Couldn’t update ${station.label}.`;
    }
    button.disabled = !window.ZakStation.current().canControl;
  }

  function matchesFilter(track, newestTrackTime = 0) {
    if (state.filter === "liked") return Boolean(track.liked);
    if (state.filter === "covers") return Boolean(track.has_cover);
    if (state.filter === "recent") {
      return (
        newestTrackTime > 0 &&
        dateValue(track) >= newestTrackTime - 180 * 24 * 60 * 60 * 1000
      );
    }
    return true;
  }

  function applyFilters() {
    if (state.status === "loading") {
      renderLibraryLoading();
      return;
    }
    if (state.status === "error") {
      renderLibraryError(state.error);
      return;
    }
    const query = els.search.value.trim().toLocaleLowerCase();
    const newestTrackTime =
      state.filter === "recent"
        ? state.tracks.reduce(
            (newest, track) => Math.max(newest, dateValue(track)),
            0,
          )
        : 0;
    state.visible = state.tracks.filter((track) => {
      const text = [
        track.title,
        track.artist,
        track.source,
        track.group,
        track.summary,
        track.search_text,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return (
        matchesFilter(track, newestTrackTime) &&
        (!query || text.includes(query))
      );
    });

    const collator = new Intl.Collator(undefined, {
      sensitivity: "base",
      numeric: true,
    });
    if (state.sort === "newest")
      state.visible.sort((a, b) => dateValue(b) - dateValue(a));
    if (state.sort === "title")
      state.visible.sort((a, b) =>
        collator.compare(a.title || "", b.title || ""),
      );
    if (state.sort === "duration")
      state.visible.sort((a, b) => number(b.duration) - number(a.duration));
    if (state.sort === "played")
      state.visible.sort((a, b) => number(b.play_count) - number(a.play_count));
    if (window.location.pathname.startsWith("/library")) {
      renderTracks();
      updatePlaybackUI();
    }
  }

  function renderLibraryLoading() {
    els.tracks.className =
      state.view === "list" ? "track-grid is-list" : "track-grid";
    els.tracks.setAttribute("aria-busy", "true");
    els.count.textContent = "Loading the archive…";
    els.heading.textContent = "All tracks";
    const loading = document.createElement("div");
    loading.className = "empty-message";
    loading.setAttribute("role", "status");
    loading.textContent = "Loading the archive…";
    els.tracks.replaceChildren(loading);
  }

  function addBadge(container, text, accent = false) {
    if (!text) return;
    const badge = document.createElement("span");
    badge.className = accent ? "track-badge is-accent" : "track-badge";
    badge.textContent = text;
    container.append(badge);
  }

  function renderTracks() {
    els.tracks.textContent = "";
    els.tracks.className =
      state.view === "list" ? "track-grid is-list" : "track-grid";
    els.count.textContent = `${Math.min(state.limit, state.visible.length)} of ${state.visible.length} matching tracks`;

    const labels = {
      all: "All tracks",
      liked: "Liked tracks",
      covers: "Tracks with artwork",
      recent: "Recent additions",
    };
    els.heading.textContent = els.search.value.trim()
      ? `Results for “${els.search.value.trim()}”`
      : labels[state.filter];

    if (!state.visible.length) {
      const empty = document.createElement("div");
      empty.className = "empty-message";
      empty.innerHTML =
        "<strong>No tracks found.</strong><br>Try a different search or filter.";
      els.tracks.append(empty);
      updatePlaybackUI();
      return;
    }

    const fragment = document.createDocumentFragment();
    state.visible.slice(0, state.limit).forEach((track) => {
      const displayTitle = window.ZakTrackDisplayTitle(track);
      const listView = state.view === "list";
      const card = document.createElement("article");
      card.className = listView ? "track-card is-list" : "track-card";
      card.dataset.trackId = track.id;

      const coverButton = document.createElement("button");
      coverButton.className = "track-cover-button";
      coverButton.type = "button";
      coverButton.setAttribute(
        "aria-label",
        `Choose actions for ${displayTitle}`,
      );
      coverButton.append(createCover(track));

      const icon = document.createElement("span");
      icon.className = "track-play";
      icon.textContent = "+";
      icon.setAttribute("aria-hidden", "true");
      coverButton.append(icon);

      const copy = document.createElement("div");
      copy.className = "track-card-copy";

      const identity = document.createElement("div");
      const kicker = document.createElement("div");
      kicker.className = "track-kicker";
      const source = document.createElement("span");
      source.textContent =
        window.ZakTrackDisplayGroup(track) || track.source || "Archive";
      const duration = document.createElement("span");
      duration.textContent = timeLabel(track.duration);
      kicker.append(source, duration);
      const title = document.createElement("div");
      title.className = "track-card-title";
      title.textContent = displayTitle;
      title.title = displayTitle;
      const artist = document.createElement("div");
      artist.className = "track-artist";
      artist.textContent = [track.artist || "Zak", track.source]
        .filter(Boolean)
        .join(" · ");
      identity.append(kicker, title, artist);

      const summary = document.createElement("p");
      summary.className = "track-summary";
      summary.textContent =
        track.summary ||
        `An original track from ${window.ZakTrackDisplayGroup(track) || track.source || "the Zak Radio archive"}.`;

      const stats = document.createElement("div");
      stats.className = "track-stats";
      addBadge(stats, dateLabel(track));
      addBadge(stats, sizeLabel(track.audio_bytes));
      addBadge(
        stats,
        number(track.play_count) ? `${number(track.play_count)} plays` : "",
      );
      addBadge(stats, track.liked ? "♥ Liked" : "", true);
      addBadge(
        stats,
        number(track.skip_count) ? `${number(track.skip_count)} skips` : "",
      );

      copy.append(identity, summary, stats);

      const actions = document.createElement("div");
      actions.className = "track-card-actions";
      const playNext = document.createElement("button");
      playNext.type = "button";
      playNext.className = "track-queue-action is-primary";
      playNext.dataset.queueAction = "play_next";
      playNext.textContent = "Play next";
      playNext.setAttribute("aria-label", `Play ${displayTitle} next`);
      const addQueue = document.createElement("button");
      addQueue.type = "button";
      addQueue.className = "track-queue-action";
      addQueue.dataset.queueAction = "add_to_queue";
      addQueue.textContent = "Add to queue";
      addQueue.setAttribute("aria-label", `Add ${displayTitle} to queue`);
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "track-preview-action";
      preview.dataset.previewTrack = track.id;
      preview.textContent = "Preview";
      preview.setAttribute("aria-label", `Preview ${displayTitle}`);
      const status = document.createElement("div");
      status.className = "track-action-status";
      status.setAttribute("aria-live", "polite");
      playNext.addEventListener("click", () =>
        queueTrack(track, "play_next", playNext, status),
      );
      addQueue.addEventListener("click", () =>
        queueTrack(track, "add_to_queue", addQueue, status),
      );
      preview.addEventListener("click", () => toggleTrack(track));
      coverButton.addEventListener("click", () => playNext.focus());
      actions.append(playNext, addQueue, preview, status);

      card.append(coverButton, copy, actions);
      fragment.append(card);
    });
    if (state.visible.length > state.limit) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "button library-load-more";
      more.textContent = `Show more (${state.visible.length - state.limit} remaining)`;
      more.addEventListener("click", () => {
        const firstNew = state.limit;
        state.limit += 60;
        renderTracks();
        document.querySelectorAll(".track-cover-button")[firstNew]?.focus();
      });
      fragment.append(more);
    }
    els.tracks.append(fragment);
    updateStationTarget();
    updatePlaybackUI();
  }

  function renderDock(track) {
    const displayTitle = window.ZakTrackDisplayTitle(track);
    els.dock.hidden = false;
    els.dock.inert = false;
    [els.playPause, els.back, els.forward, els.progress].forEach((control) => {
      control.disabled = false;
    });
    els.dock.classList.add("is-visible");
    els.dockCover.textContent = "";
    els.dockCover.append(createCover(track));
    els.dockTitle.textContent = `${displayTitle} · ${track.artist || "Zak"}`;
    els.download.href = window.ZakMediaURL.audio(track);
    els.download.tabIndex = 0;
    els.download.download = `${displayTitle || track.id}.mp3`;
    els.duration.textContent = timeLabel(track.duration);
    els.progress.max = String(number(track.duration));
  }

  function claimCurrentPreview() {
    if (!state.current) return false;
    if (!window.ZakAudio.is("library")) {
      window.ZakAudio.claim(
        "library",
        window.ZakMediaURL.audio(state.current),
        window.ZakTrackDisplayTitle(state.current),
      );
    }
    return true;
  }

  async function toggleTrack(track) {
    const requestedSource = window.ZakMediaURL.audio(track);
    if (
      state.current?.id === track.id &&
      window.ZakAudio.is("library") &&
      els.audio.currentSrc.endsWith(requestedSource)
    ) {
      if (els.audio.paused) await window.ZakAudio.play();
      else els.audio.pause();
      return;
    }
    state.current = track;
    state.previewTriggerID = track.id;
    window.ZakAudio.claim(
      "library",
      window.ZakMediaURL.audio(track),
      window.ZakTrackDisplayTitle(track),
    );
    els.audio.currentTime = 0;
    renderDock(track);
    await window.ZakAudio.play();
    updatePlaybackUI();
    els.playPause.focus({ preventScroll: true });
  }

  function updatePlaybackUI() {
    const ownsLibrary = window.ZakAudio.is("library");
    els.dock.hidden = !ownsLibrary;
    els.dock.inert = !ownsLibrary;
    els.dock.classList.toggle("is-visible", ownsLibrary);
    const playing = Boolean(
      window.ZakAudio.is("library") && state.current && !els.audio.paused,
    );
    els.playPause.setAttribute(
      "aria-label",
      playing ? "Pause preview" : "Play preview",
    );
    els.playPause
      .querySelector('[data-icon="play"]')
      .classList.toggle("hidden", playing);
    els.playPause
      .querySelector('[data-icon="pause"]')
      .classList.toggle("hidden", !playing);
    document.querySelectorAll("[data-track-id]").forEach((card) => {
      const active = playing && card.dataset.trackId === state.current?.id;
      card.classList.toggle("is-playing", active);
      const track = state.tracks.find(
        (item) => item.id === card.dataset.trackId,
      );
      const title = window.ZakTrackDisplayTitle(track);
      const button = card.querySelector("[data-preview-track]");
      button.textContent = active ? "Pause preview" : "Preview";
      button.setAttribute(
        "aria-label",
        `${active ? "Pause preview" : "Preview"} ${title}`,
      );
    });
  }

  function updateProgress() {
    const duration =
      number(els.audio.duration) || number(state.current?.duration);
    els.currentTime.textContent = timeLabel(els.audio.currentTime);
    els.duration.textContent = timeLabel(duration);
    els.progress.max = String(duration);
    els.progress.value = String(
      Math.min(els.audio.currentTime || 0, duration || 0),
    );
    renderProgress(els.audio.currentTime || 0, duration);
  }

  function renderProgress(position, duration) {
    const percent =
      duration > 0
        ? Math.max(0, Math.min(100, (position / duration) * 100))
        : 0;
    els.progressFill.style.width = `${percent}%`;
    els.progressThumb.style.left = `${percent}%`;
  }

  document.querySelectorAll("[data-library-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.libraryFilter;
      document.querySelectorAll("[data-library-filter]").forEach((item) => {
        const active = item === button;
        item.setAttribute("aria-pressed", String(active));
      });
      state.limit = 60;
      applyFilters();
    });
  });

  document.querySelectorAll("[data-library-view]").forEach((button) => {
    const active = button.dataset.libraryView === state.view;
    button.setAttribute("aria-pressed", String(active));
    button.addEventListener("click", () => {
      state.view = button.dataset.libraryView;
      window.ZakStorage.set("zak-library-view", state.view);
      document.querySelectorAll("[data-library-view]").forEach((item) => {
        const selected = item === button;
        item.setAttribute("aria-pressed", String(selected));
      });
      renderTracks();
    });
  });

  els.search.addEventListener("input", applyFilters);
  els.sort.addEventListener("change", () => {
    state.sort = els.sort.value;
    applyFilters();
  });
  els.playPause.addEventListener("click", () => {
    if (!claimCurrentPreview()) return;
    if (els.audio.paused) window.ZakAudio.play();
    else els.audio.pause();
  });
  els.back.addEventListener("click", () => {
    if (!claimCurrentPreview()) return;
    els.audio.currentTime = Math.max(0, els.audio.currentTime - 10);
  });
  els.forward.addEventListener("click", () => {
    if (!claimCurrentPreview()) return;
    els.audio.currentTime = Math.min(
      number(els.audio.duration) || Infinity,
      els.audio.currentTime + 10,
    );
  });
  els.progress.addEventListener("input", () => {
    if (!claimCurrentPreview()) return;
    els.audio.currentTime = number(els.progress.value);
    renderProgress(number(els.progress.value), number(els.progress.max));
  });
  els.audio.addEventListener("play", updatePlaybackUI);
  els.audio.addEventListener("pause", updatePlaybackUI);
  els.audio.addEventListener("ended", updatePlaybackUI);
  els.audio.addEventListener("timeupdate", () => {
    if (window.ZakAudio.is("library")) updateProgress();
  });
  els.audio.addEventListener("loadedmetadata", () => {
    if (window.ZakAudio.is("library")) updateProgress();
  });
  window.addEventListener("zak-audio-owner", updatePlaybackUI);
  window.addEventListener("zak-station", updateStationTarget);

  document.addEventListener("keydown", (event) => {
    const tag = document.activeElement?.tagName;
    const typing = ["INPUT", "SELECT", "TEXTAREA"].includes(tag);
    const interactive =
      ["BUTTON", "A"].includes(tag) ||
      document.activeElement?.isContentEditable;
    if (
      event.key === "/" &&
      !typing &&
      !interactive &&
      window.location.pathname.startsWith("/library")
    ) {
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
      window.location.pathname.startsWith("/library") &&
      state.current &&
      window.ZakAudio.is("library")
    ) {
      event.preventDefault();
      els.playPause.click();
    }
  });

  async function loadLibrary(force = false) {
    try {
      state.tracks = await window.ZakCatalog.load(force);
      state.visible = state.tracks.slice();
      state.status = "ready";
      state.error = null;
      els.tracks.setAttribute("aria-busy", "false");
      applyFilters();
      return true;
    } catch (error) {
      state.status = "error";
      state.error = error;
      els.tracks.setAttribute("aria-busy", "false");
      renderLibraryError(error);
      return false;
    }
  }

  function renderLibraryError(error) {
    els.count.textContent = "Archive unavailable";
    els.heading.textContent = "Archive unavailable";
    const message = document.createElement("div");
    message.className = "error-message";
    message.textContent = `The library could not be loaded. ${error?.message || ""} `;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      els.tracks.setAttribute("aria-busy", "true");
      const loaded = await loadLibrary(true);
      if (loaded) {
        await window.ZakRecoverShell?.();
        els.heading.focus({ preventScroll: true });
      } else if (retry.isConnected) {
        retry.disabled = false;
      }
    });
    message.append(retry);
    els.tracks.replaceChildren(message);
  }

  window.ZakCatalog.subscribe((tracks) => {
    const focusedTrack =
      document.activeElement?.closest?.("[data-track-id]")?.dataset.trackId;
    const focusedMore =
      document.activeElement?.classList?.contains("library-load-more");
    state.tracks = tracks;
    if (state.current) {
      const replacement = tracks.find((track) => track.id === state.current.id);
      if (replacement) {
        state.current = replacement;
        if (window.ZakAudio.is("library")) renderDock(replacement);
      } else if (window.ZakAudio.is("library")) {
        els.audio.pause();
        window.ZakAudio.clear("library");
        state.current = null;
      }
    }
    state.visible = tracks.slice();
    state.status = "ready";
    state.error = null;
    els.tracks.setAttribute("aria-busy", "false");
    applyFilters();
    if (focusedTrack) {
      const replacement = document.querySelector(
        `[data-track-id="${CSS.escape(focusedTrack)}"] .track-cover-button`,
      );
      (replacement || els.heading).focus({ preventScroll: true });
    } else if (focusedMore) {
      (document.querySelector(".library-load-more") || els.heading).focus({
        preventScroll: true,
      });
    }
  });
  window.addEventListener("zak-route", (event) => {
    if (event.detail?.path === "/library") {
      state.tracks = window.ZakCatalog.tracks;
      applyFilters();
    }
  });
  document
    .getElementById("libraryReturnLive")
    .addEventListener("click", async () => {
      const trigger = state.previewTriggerID;
      const returning = window.ZakAudio.returnLive();
      await returning;
      const source = trigger
        ? document.querySelector(
            `[data-track-id="${CSS.escape(trigger)}"] [data-preview-track]`,
          )
        : null;
      (source || els.search || els.heading).focus({ preventScroll: true });
    });
  loadLibrary();
  updateStationTarget();
})();
