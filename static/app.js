const state = {
  tracks: [],
  current: null,
  station: null,
  connected: false,
  syncingProgress: false,
  userActivatedAudio: false,
  lastTextTrackId: null,
  stationReceivedAt: 0,
  serverClockOffset: null,
  stationId: "main",
  ownerToken: "",
  eventSource: null,
  eventReconnectTimer: 0,
  eventReconnectAttempt: 0,
  streamConnected: false,
  stationRequestGeneration: 0,
  stationRequestInFlight: null,
  localPlaybackBlocked: false,
  localRadioSuspended: false,
  pollTimer: 0,
  controlQueue: Promise.resolve(),
  controlGeneration: 0,
  trackStatsRevision: 0,
  catalogRevision: "",
  likeQueues: new Map(),
  invalidStationLink: false,
  stationCapacityRetryAt: 0,
  stationCreatePending: false,
  renderedPath: "",
};

const els = {
  skipToContent: document.getElementById("skipToContent"),
  shellContext: document.getElementById("shellContext"),
  connection: document.getElementById("connection"),
  connectionDot: document.getElementById("connectionDot"),
  connectionText: document.getElementById("connectionText"),
  title: document.getElementById("title"),
  source: document.getElementById("source"),
  details: document.getElementById("details"),
  audio: document.getElementById("audio"),
  cover: document.getElementById("cover"),
  emptyCover: document.getElementById("emptyCover"),
  lyrics: document.getElementById("lyrics"),
  lyricsViewport: document.getElementById("lyricsViewport"),
  lyricsFade: document.getElementById("lyricsFade"),
  lyricsMoreRow: document.getElementById("lyricsMoreRow"),
  toggleLyrics: document.getElementById("toggleLyrics"),
  prompt: document.getElementById("prompt"),
  download: document.getElementById("download"),
  currentTime: document.getElementById("currentTime"),
  duration: document.getElementById("duration"),
  progress: document.getElementById("progress"),
  progressFill: document.getElementById("progressFill"),
  progressThumb: document.getElementById("progressThumb"),
  playPause: document.getElementById("playPause"),
  back10: document.getElementById("back10"),
  forward10: document.getElementById("forward10"),
  prev: document.getElementById("prev"),
  next: document.getElementById("next"),
  random: document.getElementById("random"),
  repeatOne: document.getElementById("repeatOne"),
  like: document.getElementById("like"),
  skipCount: document.getElementById("skipCount"),
  stationStatus: document.getElementById("stationStatus"),
  nowPlayingAnnouncement: document.getElementById("nowPlayingAnnouncement"),
  livePulse: document.getElementById("livePulse"),
  playIcon: document.getElementById("playIcon"),
  pauseIcon: document.getElementById("pauseIcon"),
  detailsPanels: document.getElementById("detailsPanels"),
  promptPanel: document.getElementById("promptPanel"),
  toggleDetails: document.getElementById("toggleDetails"),
  toast: document.getElementById("toast"),
  stationMode: document.getElementById("stationMode"),
  stationAccess: document.getElementById("stationAccess"),
  mainStation: document.getElementById("mainStation"),
  shareStation: document.getElementById("shareStation"),
  shareFallback: document.getElementById("stationShareFallback"),
  shareLink: document.getElementById("stationShareLink"),
  shareClose: document.getElementById("stationShareClose"),
  createStation: document.getElementById("createStation"),
  stationCard: document.getElementById("stationCard"),
  ownerBar: document.getElementById("audioOwnerBar"),
  ownerKicker: document.getElementById("audioOwnerKicker"),
  ownerLabel: document.getElementById("audioOwnerLabel"),
  ownerPlayPause: document.getElementById("audioOwnerPlayPause"),
  returnLive: document.getElementById("returnLive"),
  ownerAnnouncement: document.getElementById("audioOwnerAnnouncement"),
  radioRetry: document.getElementById("radioRetry"),
};

let toastTimer;
let toastPriority = 0;
let toastPriorityUntil = 0;
let toastType = "";
let scrollStateTimer = 0;
let ownerAnnouncement = "Audio stopped";

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function timeLabel(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return "0:00";
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function fileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "Audio";
  if (n < 0.1 * 1024 * 1024) {
    return n < 1024 ? "<1 KB" : `${Math.max(1, Math.round(n / 1024))} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
window.ZakFormatBytes = fileSize;

function showToast(message, { priority = 0, duration = 2200, type = "" } = {}) {
  if (priority < toastPriority && performance.now() < toastPriorityUntil) return;
  window.clearTimeout(toastTimer);
  toastPriority = priority;
  toastPriorityUntil = performance.now() + duration;
  toastType = type;
  els.toast.hidden = false;
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => {
    els.toast.classList.remove("is-visible");
    toastPriority = 0;
    toastPriorityUntil = 0;
    toastType = "";
    toastTimer = window.setTimeout(() => {
      if (!els.toast.classList.contains("is-visible")) {
        els.toast.textContent = "";
        els.toast.hidden = true;
      }
    }, 200);
  }, duration);
}

function dismissToast(type) {
  if (!type || toastType !== type) return;
  window.clearTimeout(toastTimer);
  els.toast.classList.remove("is-visible");
  els.toast.textContent = "";
  els.toast.hidden = true;
  toastPriority = 0;
  toastPriorityUntil = 0;
  toastType = "";
}

function routePath() {
  if (window.location.pathname.startsWith("/library")) return "/library";
  if (window.location.pathname.startsWith("/reader")) return "/reader";
  return "/";
}

function setOwnerBarHidden(hidden) {
  els.ownerBar.hidden = hidden;
  document.body.classList.toggle("has-audio-owner", !hidden);
}

function renderOwnerBar() {
  if (!audioController.owner) {
    setOwnerBarHidden(true);
    if (ownerAnnouncement !== "Audio stopped") {
      ownerAnnouncement = "Audio stopped";
      setText(els.ownerAnnouncement, ownerAnnouncement);
    }
    return;
  }
	const pathOwner = routePath().slice(1);
	const radioOffView = audioController.owner === "radio" && routePath() !== "/";
	const readerLibraryOwner = audioController.owner === "reader" &&
	  routePath() === "/reader" && !window.ZakReader?.selectedId?.();
	const radioIsLive = Boolean(state.station?.playing);
  const radioNeedsJoin = radioOffView && radioIsLive &&
    (els.audio.paused || state.localRadioSuspended || !state.userActivatedAudio);
	setOwnerBarHidden((audioController.owner === pathOwner && !readerLibraryOwner) ||
	  (audioController.owner === "radio" && !radioOffView));
  setText(els.ownerKicker, radioOffView
    ? "Live station"
    : "Listening locally");
  setText(els.ownerLabel, audioController.label);
  setText(els.returnLive, radioOffView ? "Open Radio" : "Return to live");
  els.returnLive.setAttribute("aria-label", radioOffView
    ? "Open Radio controls"
    : "Return to live radio");
  setText(els.ownerPlayPause, radioOffView && !radioIsLive
    ? "Station paused"
    : radioNeedsJoin ? "Join live" : els.audio.paused ? "Resume" : "Pause");
  els.ownerPlayPause.disabled = radioOffView && !radioIsLive;
  els.ownerPlayPause.setAttribute("aria-label",
    radioOffView && !radioIsLive
      ? "Station paused"
      : radioNeedsJoin
      ? "Join live audio"
      : `${els.audio.paused ? "Resume" : "Pause"} local audio`);
  const announcement = audioController.owner === "radio"
    ? `${radioIsLive ? "Live station" : "Station paused"}: ${audioController.label}`
    : `Local audio: ${audioController.label}`;
  if (announcement !== ownerAnnouncement) {
    ownerAnnouncement = announcement;
    setText(els.ownerAnnouncement, announcement);
  }
}

function syncRouteLinks() {
  document.querySelectorAll("[data-route]").forEach((link) => {
    const url = new URL(link.dataset.route, window.location.origin);
    if (state.stationId !== "main") url.searchParams.set("station", state.stationId);
    link.href = `${url.pathname}${url.search}`;
  });
}

function requestedStation() {
  const requested = new URLSearchParams(window.location.search).get("station");
  if (!requested) return "main";
  if (/^[a-f0-9]{12}(?:[a-f0-9]{20})?$/.test(requested)) return requested;
  const url = new URL(window.location.href);
  url.searchParams.delete("station");
  window.history.replaceState(window.history.state || {}, "", url);
  state.invalidStationLink = true;
  return "main";
}

function renderRoute(focusView = false, preserveScroll = false) {
  const path = routePath();
  state.renderedPath = path;
  els.skipToContent.href = path === "/library"
    ? "#libraryViewTitle"
    : path === "/reader" ? "#readerTitle" : "#title";
  document.querySelectorAll("[data-view]").forEach((view) => {
    view.hidden = view.dataset.view !== path;
  });
  document.querySelectorAll("[data-route]").forEach((link) => {
    if (link.dataset.route === path) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  els.stationCard.hidden = path !== "/";
  syncRouteLinks();
  renderOwnerBar();
  updateShellContext();
  updateNowPlayingMetadata();
  renderStation();
  if (path === "/" && state.current) loadTrackText(state.current);
  if (!preserveScroll) window.scrollTo({ top: 0 });
  window.dispatchEvent(new CustomEvent("zak-route", { detail: { path } }));
  if (focusView) {
    const heading = path === "/library"
      ? document.getElementById("libraryViewTitle")
      : path === "/reader" ? document.getElementById("readerTitle") : els.title;
    window.queueMicrotask(() => heading?.focus({ preventScroll: true }));
  }
}

function updateShellContext() {
  const path = routePath();
  els.shellContext.textContent = path === "/library"
    ? "Original music archive"
    : path === "/reader"
      ? "Source reading room"
      : `${state.tracks.length || "Shared"} tracks`;
}

function navigate(path) {
  commitScrollState();
  const url = new URL(window.location.href);
  url.pathname = path;
  if (state.stationId !== "main") url.searchParams.set("station", state.stationId);
  else url.searchParams.delete("station");
  if (path !== "/reader") url.searchParams.delete("item");
  else if (routePath() === "/reader") url.searchParams.delete("item");
  else {
    const item = window.ZakReader?.selectedId?.();
    if (item) url.searchParams.set("item", item);
  }
  if (`${url.pathname}${url.search}` !== `${window.location.pathname}${window.location.search}`) {
    window.history.pushState({ scroll: [0, 0] }, "", url);
  }
  renderRoute(true);
}

const audioController = {
  element: els.audio,
  owner: "",
  label: "",
  generation: 0,
  is(owner) {
    return this.owner === owner;
  },
  claim(owner, src, label) {
    const changedSource = !els.audio.src.endsWith(src);
    const needsReload = changedSource || Boolean(els.audio.error) ||
      els.audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;
    if (this.owner !== owner || changedSource) {
      window.dispatchEvent(new CustomEvent("zak-audio-release", {
        detail: {
          owner: this.owner,
          nextOwner: owner,
          position: els.audio.currentTime || 0,
          playing: !els.audio.paused,
          generation: this.generation,
        },
      }));
    }
    this.generation++;
    if (needsReload) {
      els.audio.pause();
    }
    this.owner = owner;
    this.label = label;
    els.audio.loop = false;
    clearMediaPositionState();
    if (needsReload) {
      els.audio.src = src;
      els.audio.load();
    }
    renderOwnerBar();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: label,
        artist: owner === "library" ? "Private library preview" : "Zak Reader",
        album: "Zak Radio",
      });
    }
    updateNowPlayingMetadata();
    window.dispatchEvent(new CustomEvent("zak-audio-owner", { detail: { owner, label } }));
    return needsReload;
  },
  async returnLive(sync = true) {
    const track = state.station ? currentTrack() : null;
    if (!track) {
      showToast("Live station controls are unavailable. Local audio is still active.");
      renderOwnerBar();
      return false;
    }
    state.userActivatedAudio = true;
    state.localRadioSuspended = false;
    els.audio.pause();
    window.dispatchEvent(new CustomEvent("zak-audio-release", {
      detail: {
        owner: this.owner,
        nextOwner: "radio",
        position: els.audio.currentTime || 0,
        playing: !els.audio.paused,
        generation: this.generation,
      },
    }));
    this.generation++;
    this.owner = "radio";
    this.label = track.title || "Live station";
    clearMediaPositionState();
    renderOwnerBar();
    const src = mediaAudioURL(track);
    if (!els.audio.src.endsWith(src)) {
      els.audio.src = src;
      els.audio.load();
    }
    window.dispatchEvent(new CustomEvent("zak-audio-owner", {
      detail: { owner: "radio", label: this.label },
    }));
    updateNowPlayingMetadata();
    if (sync) await syncAudioToStation();
    return true;
  },
  clear(owner) {
    if (this.owner !== owner) return;
    this.generation++;
    els.audio.pause();
    els.audio.removeAttribute("src");
    els.audio.load();
    this.owner = "";
    this.label = "";
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = null;
      clearMediaPositionState();
    }
    renderOwnerBar();
    updateNowPlayingMetadata();
    window.dispatchEvent(new CustomEvent("zak-audio-owner", {
      detail: { owner: "", label: "" },
    }));
  },
  async play({ generation = this.generation, valid = () => true } = {}) {
    this.reloadIfFailed();
    try {
      await els.audio.play();
      return true;
    } catch (error) {
      if (error?.name !== "AbortError" && this.generation === generation && valid()) {
        reportAudioError(error);
      }
      return false;
    }
  },
	reloadIfFailed() {
    if (els.audio.error || els.audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) {
      els.audio.load();
      return true;
    }
	  return false;
	},
	refreshOwner() {
	  renderOwnerBar();
	},
};

window.ZakAudio = audioController;
window.ZakNavigate = navigate;
window.ZakShowToast = showToast;

function clearMediaPositionState() {
  if (!("mediaSession" in navigator) ||
      typeof navigator.mediaSession.setPositionState !== "function") return;
  try {
    navigator.mediaSession.setPositionState();
  } catch {}
}

let catalogRequest;
let catalogGeneration = 0;
const catalogListeners = new Set();
async function loadCatalog(force = false) {
	if (catalogRequest && !force) return catalogRequest.promise;
	if (catalogRequest && force) {
	  catalogRequest.controller.abort();
	  catalogRequest = null;
	}
	if (state.tracks.length && !force) return state.tracks;
	const controller = new AbortController();
	const generation = ++catalogGeneration;
	const activeRequest = { controller, promise: null };
	const request = api("/api/tracks", { signal: controller.signal }).then((data) => {
	  if (generation !== catalogGeneration) throw new DOMException("Stale catalog", "AbortError");
	  const tracks = Array.isArray(data.tracks) ? data.tracks : [];
	  if (!tracks.length) throw new Error("The archive has no playable tracks.");
	  state.tracks = tracks;
	  state.trackStatsRevision = Number(data.track_stats_revision || 0);
	  state.catalogRevision = String(data.catalog_revision || "");
	  for (const listener of catalogListeners) listener(tracks);
	  return tracks;
	});
	activeRequest.promise = request;
	catalogRequest = activeRequest;
	try {
	  return await request;
	} finally {
	  if (catalogRequest === activeRequest) catalogRequest = null;
	}
}

function applyTrackStats(payload) {
  const revision = Number(payload?.revision || 0);
  if (!revision || revision <= state.trackStatsRevision || !Array.isArray(payload.tracks)) return false;
  const byID = new Map(payload.tracks.map((stat) => [stat.track_id, stat]));
  for (const track of state.tracks) {
    const stat = byID.get(track.id);
    if (!stat) continue;
    track.liked = Boolean(stat.liked);
    track.skip_count = Number(stat.skip_count || 0);
  }
  state.trackStatsRevision = revision;
  if (state.station) {
    const current = state.tracks.find((track) => track.id === state.station.track_id);
    if (current) {
      state.station.liked = current.liked;
      state.station.skip_count = current.skip_count;
    }
  }
  renderStation();
  window.ZakCatalog.notify();
  return true;
}
window.ZakCatalog = {
  get tracks() {
    return state.tracks;
  },
  load: loadCatalog,
  subscribe(listener) {
    catalogListeners.add(listener);
    return () => catalogListeners.delete(listener);
  },
  notify() {
    for (const listener of catalogListeners) listener(state.tracks);
  },
};

function reportAudioError(error) {
  if (error?.name === "NotAllowedError") {
    showToast("Tap Play to allow audio in this browser.", { type: "audio-error" });
  } else {
    showToast("Audio is unavailable. Check the media file and try again.",
      { type: "audio-error" });
  }
}

function durationOf(track) {
  const n = Number(track?.duration);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function mediaAudioURL(track) {
  const version = encodeURIComponent(track?.audio_sha256 || state.catalogRevision || "current");
  return `/media/${encodeURIComponent(track.id)}/audio?v=${version}`;
}

function mediaCoverURL(track) {
  const version = encodeURIComponent(track?.cover_sha256 || state.catalogRevision || "current");
  return `/media/${encodeURIComponent(track.id)}/cover?v=${version}`;
}

window.ZakMediaURL = {
  audio: mediaAudioURL,
  cover: mediaCoverURL,
};

function currentTrack() {
  return state.current;
}

const api = window.ZakAPI;

function stationQuery() {
  const params = new URLSearchParams({ station_id: state.stationId });
  return params.toString();
}

function canControlStation() {
  return Boolean(state.station) &&
    (state.stationId === "main" || Boolean(state.station.can_control));
}

function setConnected(connected) {
  state.connected = connected;
  els.connectionDot.classList.toggle("is-connected", state.streamConnected);
  els.connectionDot.classList.toggle("is-disconnected", !state.streamConnected);
  setText(els.connectionText, state.streamConnected
    ? "Connected"
    : connected ? "Polling" : "Reconnecting");
}

function setStationLoading() {
  if (audioController.is("radio")) {
    audioController.clear("radio");
    state.localRadioSuspended = false;
  }
  state.station = null;
  state.current = null;
  els.stationMode.textContent = "Loading station";
  els.stationAccess.textContent = "Waiting for authoritative station state.";
  els.stationStatus.textContent = "Connecting…";
  els.livePulse.classList.remove("is-live");
  els.source.textContent = "Zak Radio";
  els.title.textContent = "Loading station…";
  els.details.textContent = "Connecting to the requested station.";
  clearStationText("Waiting for station content.");
  els.cover.removeAttribute("src");
  els.cover.classList.add("hidden");
  els.emptyCover.textContent = "…";
  els.emptyCover.classList.remove("hidden");
  els.emptyCover.classList.add("grid");
  els.currentTime.textContent = "0:00";
  els.duration.textContent = "0:00";
  els.progress.value = "0";
  els.progress.max = "0";
  renderProgress(0, 0);
  els.radioRetry.hidden = true;
  [
    els.playPause, els.back10, els.forward10, els.prev, els.next, els.random,
    els.repeatOne, els.progress, els.like, els.createStation,
  ].forEach((control) => {
    control.disabled = true;
  });
  els.download.removeAttribute("href");
  els.download.setAttribute("aria-disabled", "true");
  renderStationIdentityActions();
  renderOwnerBar();
  updateNowPlayingMetadata();
}

function renderStationIdentityActions() {
  const temporary = state.stationId !== "main";
  els.mainStation.hidden = !temporary;
  els.shareStation.hidden = !temporary;
  els.createStation.hidden = temporary;
}

function focusAfterStationAction(preferred) {
  const target = [
    preferred,
    els.mainStation,
    els.createStation,
    els.shareStation,
    els.radioRetry,
  ].find((element) => element && !element.hidden && !element.disabled &&
    element.getClientRects().length > 0);
  (target || els.stationMode).focus({ preventScroll: true });
}

function clearStationText(message) {
  state.lastTextTrackId = null;
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
  setLyricsExpanded(false);
  els.lyrics.textContent = "Loading...";
  els.prompt.textContent = "Loading...";
  await Promise.allSettled([
    loadTrackTextKind(track, "lyrics", els.lyrics),
    loadTrackTextKind(track, "prompt", els.prompt),
  ]);
  if (state.current?.id === track.id) window.requestAnimationFrame(updateLyricsOverflow);
}

async function loadTrackTextKind(track, kind, element) {
  try {
    const value = await fetchText(track, kind);
    if (state.current?.id !== track.id) return;
    element.textContent = value.trim() || `No ${kind} found.`;
  } catch {
    if (state.current?.id !== track.id) return;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button text-retry";
    retry.textContent = `Retry ${kind}`;
    retry.addEventListener("click", () => loadTrackTextKind(track, kind, element));
    element.replaceChildren(document.createTextNode(`Unable to load ${kind}. `), retry);
  }
}

function setLyricsExpanded(expanded) {
  els.lyricsViewport.classList.toggle("is-collapsed", !expanded);
  els.lyricsFade.hidden = expanded;
  els.toggleLyrics.setAttribute("aria-expanded", String(expanded));
  els.toggleLyrics.textContent = expanded ? "Collapse lyrics" : "Show full lyrics";
}

function updateLyricsOverflow() {
  const expanded = els.toggleLyrics.getAttribute("aria-expanded") === "true";
  const wasCollapsed = els.lyricsViewport.classList.contains("is-collapsed");
  if (!wasCollapsed) els.lyricsViewport.classList.add("is-collapsed");
  const overflows = els.lyrics.scrollHeight > els.lyricsViewport.clientHeight + 1;
  if (!wasCollapsed) els.lyricsViewport.classList.remove("is-collapsed");
  els.lyricsMoreRow.hidden = !overflows;
  els.lyricsFade.hidden = expanded || !overflows;
}

function renderTrack(track) {
  if (!track) return;
  const changed = state.current?.id !== track.id;
  state.current = track;
  els.title.textContent = track.title || "Untitled";
  els.source.textContent = [track.source, track.artist].filter(Boolean).join(" · ") || "Zak Radio";
  els.details.textContent = [track.group, timeLabel(track.duration), fileSize(track.audio_bytes)].filter(Boolean).join("  ·  ");
  els.download.href = mediaAudioURL(track);
  els.download.download = `${track.title || track.id}.mp3`;
  els.download.removeAttribute("aria-disabled");
  const showCoverFallback = () => {
    setText(els.emptyCover, (track.title || track.id || "Z").trim().charAt(0).toUpperCase() || "Z");
    els.cover.classList.add("hidden");
    els.emptyCover.classList.remove("hidden");
    els.emptyCover.classList.add("grid");
  };
  els.cover.onerror = showCoverFallback;
  els.cover.classList.toggle("hidden", !track.has_cover);
  els.emptyCover.classList.toggle("hidden", track.has_cover);
  els.emptyCover.classList.toggle("grid", !track.has_cover);
  if (track.has_cover) els.cover.src = mediaCoverURL(track);
  else showCoverFallback();
	const src = mediaAudioURL(track);
	if (audioController.is("radio")) {
	  audioController.label = track.title || "Untitled";
	  renderOwnerBar();
	}
	if (audioController.is("radio") && !els.audio.src.endsWith(src)) {
    els.audio.src = src;
    els.audio.load();
  }
  els.progress.max = String(durationOf(track));
  els.duration.textContent = timeLabel(durationOf(track));
  if (routePath() === "/") loadTrackText(track);
  if (changed) {
    els.nowPlayingAnnouncement.textContent = `Now playing ${track.title || "Untitled"}`;
  }
  updateNowPlayingMetadata();
}

function renderStation() {
  const track = currentTrack();
  const station = state.station;
  if (!track || !station) return;
  const playing = Boolean(station.playing);
  const repeatOne = Boolean(station.repeat_one);
  const shuffle = Boolean(station.shuffle);
  const needsLocalJoin = playing &&
    (!audioController.is("radio") || els.audio.paused || state.localRadioSuspended);
  els.stationStatus.textContent = needsLocalJoin
    ? "Live now · tap Join live to hear"
    : playing ? "Live now" : "Station paused";
  els.livePulse.classList.toggle("is-live", playing);
  const playLabel = needsLocalJoin ? "Join live" : playing ? "Pause" : "Play";
  els.playPause.querySelector(".sr-only").textContent = playLabel;
  els.playPause.setAttribute("aria-label", playLabel);
  els.playIcon.classList.toggle("hidden", !needsLocalJoin && playing);
  els.pauseIcon.classList.toggle("hidden", needsLocalJoin || !playing);
  renderModeButton(els.repeatOne, repeatOne, "Repeat current track");
  renderModeButton(els.random, shuffle, "Shuffle");
  if (audioController.is("radio")) els.audio.loop = repeatOne;
  els.like.textContent = station.liked ? "Liked" : "Like";
  els.like.setAttribute("aria-pressed", station.liked ? "true" : "false");
  const skips = Number(station.skip_count || 0);
  els.skipCount.textContent = `${skips} early ${skips === 1 ? "skip" : "skips"}`;
  const temporary = state.stationId !== "main";
  const canControl = canControlStation();
  els.stationMode.textContent = temporary ? "Private station" : "Shared station";
  els.stationAccess.textContent = temporary
    ? canControl
      ? "Only this browser can turn this dial. The share link is listen-only."
      : "Listen-only. The creator controls this dial."
    : "Everyone here can turn the dial.";
  renderStationIdentityActions();
  [
    els.playPause,
    els.back10,
    els.forward10,
    els.prev,
    els.next,
    els.random,
    els.repeatOne,
    els.progress,
  ].forEach((control) => {
    control.disabled = !canControl;
  });
  const canPauseLocally = playing && audioController.is("radio") && !els.audio.paused;
  els.playPause.disabled = !canControl && !needsLocalJoin && !canPauseLocally;
  els.like.disabled = false;
  els.createStation.disabled = state.stationCreatePending ||
    performance.now() < state.stationCapacityRetryAt;
  if (!audioController.is("radio") || els.audio.paused || state.localRadioSuspended) {
    updateProgressFromStation();
  }
  renderOwnerBar();
  updateNowPlayingMetadata();
}

function updateNowPlayingMetadata() {
  const track = currentTrack();
  const path = routePath();
  if (!track) {
    document.title = path === "/library" ? "Library · Zak Radio" : path === "/reader" ? "Reader · Zak Radio" : "Zak Radio";
    return;
  }
  const playing = Boolean(state.station?.playing);
  if (audioController.is("radio") && path === "/") {
    document.title = `${playing ? "▶ " : ""}${track.title || "Untitled"} · Zak Radio`;
  } else if (path === "/library") {
    document.title = "Library · Zak Radio";
  } else if (path === "/reader") {
    document.title = "Reader · Zak Radio";
  } else {
    document.title = `${audioController.label || track.title || "Zak Radio"} · Zak Radio`;
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = els.audio.paused ? "paused" : "playing";
    if (!audioController.is("radio")) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title || "Untitled",
      artist: track.artist || "Zak",
      album: "Zak Radio",
      artwork: track.has_cover
        ? [{ src: mediaCoverURL(track) }]
        : [],
    });
  }
}

function renderModeButton(button, active, label) {
  button.setAttribute("aria-pressed", String(active));
  button.setAttribute("aria-label", `${label}: ${active ? "on" : "off"}`);
  button.title = `${label}: ${active ? "on" : "off"}`;
}

function updateProgressFromAudio() {
  const track = currentTrack();
  if (!track || state.syncingProgress) return;
  const duration = durationOf(track) || els.audio.duration || 0;
  const position = els.audio.currentTime || state.station?.position || 0;
  els.currentTime.textContent = timeLabel(position);
  els.duration.textContent = timeLabel(duration);
  els.progress.max = String(duration);
  els.progress.value = String(Math.min(position, duration || position));
  renderProgress(position, duration);
}

function updateProgressFromStation() {
  const track = currentTrack();
  if (!track || !state.station) return;
  const duration = durationOf(track);
  const position = estimatedStationPosition(state.station);
  els.currentTime.textContent = timeLabel(position);
  els.duration.textContent = timeLabel(duration);
  els.progress.max = String(duration);
  els.progress.value = String(Math.min(position, duration || position));
  renderProgress(position, duration);
}

function renderProgress(position, duration) {
  const percent = duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0;
  els.progressFill.style.width = `${percent}%`;
  els.progressThumb.style.left = `${percent}%`;
}

function estimatedStationPosition(station) {
  let position = Number(station.position || 0);
  if (station.playing) {
    position += Math.max(0, performance.now() / 1000 - state.stationReceivedAt);
  }
  const duration = durationOf(currentTrack());
  return duration ? Math.min(position, duration) : position;
}

async function syncAudioToStation() {
  const station = state.station;
  const track = currentTrack();
  if (!station || !track || !audioController.is("radio")) return;
  if (station.playing && state.localRadioSuspended) {
    els.audio.pause();
    renderStation();
    return;
  }
  const revision = Number(station.revision || 0);
  const generation = audioController.generation;
  const target = estimatedStationPosition(station);
  const drift = Math.abs((els.audio.currentTime || 0) - target);
  if (!state.syncingProgress && drift > 1.25) {
    try {
      els.audio.currentTime = target;
    } catch {}
  }
  if (station.playing) {
    if (!state.userActivatedAudio) {
      state.localPlaybackBlocked = true;
      els.audio.pause();
      renderStation();
      return;
    }
    const played = await audioController.play({
      generation,
      valid: () => state.station === station && Number(state.station?.revision || 0) === revision &&
        audioController.is("radio"),
    });
    if (state.station !== station || Number(state.station?.revision || 0) !== revision ||
        !audioController.is("radio") || audioController.generation !== generation) return;
    state.localPlaybackBlocked = !played;
    renderStation();
  } else {
    state.localPlaybackBlocked = false;
    els.audio.pause();
  }
  updateProgressFromAudio();
}

function mergeCurrentStats(station) {
  const track = state.tracks.find((item) => item.id === station.track_id);
  if (!track) return null;
  station.liked = Boolean(track.liked);
  station.skip_count = Number(track.skip_count || 0);
  return track;
}

async function applyStation(station, {
  requestStarted = null,
  receivedAt = performance.now(),
  authoritative = false,
} = {}) {
  if (!station) return;
  if (station.station_id && station.station_id !== state.stationId) return;
  if (station.catalog_revision &&
      station.catalog_revision !== state.catalogRevision) {
    await loadCatalog(true);
  }
  if (state.station?.station_id === station.station_id) {
    const incomingRevision = Number(station.revision || 0);
    const currentRevision = Number(state.station.revision || 0);
    const incomingTime = Number(station.server_time || 0);
    const currentTime = Number(state.station.server_time || 0);
    if (incomingRevision < currentRevision ||
        (!authoritative &&
          incomingRevision === currentRevision && incomingTime <= currentTime)) return;
  }
  const serverTime = Number(station.server_time || 0);
  if (serverTime > 0 && requestStarted !== null) {
    const sample = ((Number(requestStarted) + Number(receivedAt)) / 2) / 1000 - serverTime;
    if (Number.isFinite(sample)) {
      state.serverClockOffset = state.serverClockOffset === null
        ? sample
        : state.serverClockOffset * 0.75 + sample * 0.25;
    }
  }
  station.can_control = state.stationId === "main" || Boolean(state.ownerToken);
  state.station = station;
  els.radioRetry.hidden = true;
  state.stationReceivedAt = serverTime > 0 && Number.isFinite(state.serverClockOffset)
    ? serverTime + state.serverClockOffset
    : receivedAt / 1000;
  const track = mergeCurrentStats(station);
  if (track && state.current !== track) renderTrack(track);
  if (track && !audioController.owner) {
    audioController.claim("radio", mediaAudioURL(track), track.title || "Live station");
  }
  renderStation();
  await syncAudioToStation();
}

async function refreshStation(force = false, required = false) {
  const stationId = state.stationId;
  const generation = state.stationRequestGeneration;
  if (state.stationRequestInFlight?.generation === generation &&
      state.stationRequestInFlight?.stationId === stationId) {
    if (!force) return state.stationRequestInFlight.promise;
    state.stationRequestInFlight.controller.abort();
    state.stationRequestInFlight = null;
  }
  const controller = new AbortController();
  const requestStarted = performance.now();
  const request = (async () => {
    try {
      const station = await api(`/api/station?${stationQuery()}`, {
        signal: controller.signal,
      });
      const receivedAt = performance.now();
      if (generation !== state.stationRequestGeneration || stationId !== state.stationId) return;
      setConnected(true);
      await applyStation(station, {
        requestStarted, receivedAt, authoritative: force,
      });
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      if (generation !== state.stationRequestGeneration || stationId !== state.stationId) return;
      state.streamConnected = false;
      state.eventSource?.close();
      state.eventSource = null;
      setConnected(false);
      window.clearTimeout(state.eventReconnectTimer);
      state.eventReconnectTimer = window.setTimeout(connectStationEvents, 500);
      if (error.status === 404 && state.stationId !== "main") {
        showToast("That temporary station expired.", { priority: 10, duration: 4000 });
        await switchStation("main", "");
      }
      if (required && !state.station) throw error;
      return false;
    }
  })();
  const activeRequest = { generation, stationId, controller, promise: request };
  state.stationRequestInFlight = activeRequest;
  try {
    return await request;
  } finally {
    if (state.stationRequestInFlight === activeRequest) state.stationRequestInFlight = null;
  }
}

function connectStationEvents() {
  window.clearTimeout(state.eventReconnectTimer);
  state.eventReconnectTimer = 0;
  state.eventSource?.close();
  state.streamConnected = false;
  setConnected(state.connected);
  const source = new EventSource(`/api/station/events?${stationQuery()}`);
  state.eventSource = source;
  source.onopen = () => {
    if (source !== state.eventSource) return;
    state.streamConnected = true;
    state.eventReconnectAttempt = 0;
    setConnected(true);
  };
  source.addEventListener("station", async (event) => {
    if (source !== state.eventSource) return;
    try {
      state.streamConnected = true;
      state.eventReconnectAttempt = 0;
      setConnected(true);
      await applyStation(JSON.parse(event.data));
    } catch {}
  });
  source.addEventListener("track", (event) => {
    if (source !== state.eventSource) return;
    try {
      applyTrackStats(JSON.parse(event.data));
    } catch {}
  });
  source.addEventListener("expired", async () => {
    if (source !== state.eventSource) return;
    showToast("That temporary station expired.", { priority: 10, duration: 4000 });
    await switchStation("main", "");
  });
  source.onerror = () => {
    if (source !== state.eventSource) return;
    source.close();
    state.streamConnected = false;
    setConnected(state.connected);
    const delay = Math.min(30000, 500 * (2 ** state.eventReconnectAttempt++));
    state.eventReconnectTimer = window.setTimeout(() => {
      if (source === state.eventSource) connectStationEvents();
    }, delay);
  };
}

async function postControl(action, extra = {}) {
  const stationId = state.stationId;
  const ownerToken = state.ownerToken;
  const generation = state.controlGeneration;
  state.userActivatedAudio = true;
  const execute = async () => {
    if (generation !== state.controlGeneration || stationId !== state.stationId) return;
    try {
      const station = await api("/api/control", {
        method: "POST",
        body: {
          station_id: stationId,
          owner_token: ownerToken,
          action,
          ...extra,
        },
      });
      if (generation !== state.controlGeneration || stationId !== state.stationId) return;
      setConnected(true);
      await applyStation(station);
    } catch (error) {
      if (generation !== state.controlGeneration || stationId !== state.stationId) return;
      if (error.status === 403 && stationId !== "main") {
        window.ZakStorage.remove(`zak-radio-owner:${stationId}`);
        state.ownerToken = "";
        if (state.station) {
          state.station.can_control = false;
          renderStation();
        }
      }
      setConnected(false);
      const restored = await refreshStation(true);
      if (restored) {
        showToast("The station rejected that change. Live state was restored.");
      } else {
        if (audioController.is("radio")) els.audio.pause();
        state.station = null;
        els.stationStatus.textContent = "Station state unavailable";
        els.playPause.disabled = true;
        showToast("The change could not be confirmed. Reconnecting to the station.");
      }
    }
  };
  state.controlQueue = state.controlQueue.catch(() => {}).then(execute);
  return state.controlQueue;
}

async function switchStation(stationId, ownerToken) {
  state.controlGeneration++;
  state.controlQueue = Promise.resolve();
  state.stationRequestGeneration++;
  state.stationId = stationId || "main";
  state.ownerToken = ownerToken || "";
  setStationLoading();
  const url = new URL(window.location.href);
  if (state.stationId === "main") {
    url.searchParams.delete("station");
  } else {
    url.searchParams.set("station", state.stationId);
  }
  window.history.replaceState(window.history.state || {}, "", url);
  syncRouteLinks();
  connectStationEvents();
  const loaded = await refreshStation();
  if (!loaded && state.stationId === (stationId || "main")) {
    setStationUnavailable("Station unavailable");
  }
  return loaded;
}

async function createTemporaryStation() {
  if (state.stationCreatePending) return;
  const restoreFocus = document.activeElement === els.createStation;
  state.stationCreatePending = true;
  els.createStation.disabled = true;
  let focusTarget = els.createStation;
  try {
    let attempt;
    try {
      attempt = JSON.parse(window.ZakStorage.get("zak-radio-create-attempt", "null"));
    } catch {}
    if (!attempt?.idempotency_key || !attempt?.owner_token) {
      attempt = {
        idempotency_key: randomBrowserHex(16),
        owner_token: randomBrowserHex(24),
      };
      window.ZakStorage.set("zak-radio-create-attempt", JSON.stringify(attempt));
    }
    const created = await api("/api/stations", {
      method: "POST",
      body: {
        track_id: currentTrack()?.id || state.tracks[0]?.id,
        idempotency_key: attempt.idempotency_key,
        owner_token: attempt.owner_token,
      },
    });
    window.ZakStorage.remove("zak-radio-create-attempt");
    const ownerPersisted = window.ZakStorage.set(
      `zak-radio-owner:${created.station_id}`, created.owner_token);
    const loaded = await switchStation(created.station_id, created.owner_token);
    if (loaded) {
      focusTarget = els.mainStation;
      showToast(ownerPersisted
        ? "Private station created for 24 hours."
        : "Private station created. This browser cannot save ownership after reload.", {
        priority: ownerPersisted ? 0 : 10,
        duration: ownerPersisted ? 2200 : 5000,
      });
    } else {
      showToast("Private station created, but its state could not be loaded. Retry the station.",
        { priority: 10, duration: 5000 });
    }
  } catch (error) {
    if (error.status === 429 && /capacity/i.test(error.detail || "")) {
      state.stationCapacityRetryAt = performance.now() + 5000;
      els.createStation.disabled = true;
      window.setTimeout(() => {
        if (performance.now() >= state.stationCapacityRetryAt) renderStation();
      }, 5100);
      showToast("All private-station slots are in use. Try again after one expires.",
        { priority: 10, duration: 5000 });
      focusTarget = els.stationMode;
    } else {
      if (error.status === 400) window.ZakStorage.remove("zak-radio-create-attempt");
      showToast("Couldn’t create a private station.");
    }
  } finally {
    state.stationCreatePending = false;
    if (state.station) renderStation();
    if (restoreFocus) focusAfterStationAction(focusTarget);
  }
}

function randomBrowserHex(bytes) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function copyStationLink() {
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set("station", state.stationId);
  try {
    await navigator.clipboard.writeText(url.toString());
    els.shareFallback.hidden = true;
    showToast("Listen-only station link copied.");
  } catch {
    els.shareLink.value = url.toString();
    els.shareFallback.hidden = false;
    els.shareLink.focus();
    els.shareLink.select();
    showToast("Copy the visible listen-only station link.");
  }
}

async function togglePlayback() {
  const stationPlaying = Boolean(state.station?.playing);
  const needsLocalJoin = stationPlaying &&
    (!audioController.is("radio") || els.audio.paused || state.localRadioSuspended);
  if (needsLocalJoin) {
    state.userActivatedAudio = true;
    state.localPlaybackBlocked = false;
    state.localRadioSuspended = false;
    if (!audioController.is("radio")) await audioController.returnLive(false);
    audioController.reloadIfFailed();
    try {
      els.audio.currentTime = estimatedStationPosition(state.station);
    } catch {}
    const played = await audioController.play();
    state.localPlaybackBlocked = !played;
    renderStation();
    return;
  }
  if (stationPlaying && !canControlStation()) {
    state.localRadioSuspended = true;
    els.audio.pause();
    renderStation();
    return;
  }
  if (!canControlStation()) return;
  if (!audioController.is("radio")) await audioController.returnLive(false);
  const shouldPlay = !stationPlaying;
  state.userActivatedAudio = true;
  if (state.station) {
    state.station.playing = shouldPlay;
    state.stationReceivedAt = performance.now() / 1000;
    renderStation();
  }
  if (shouldPlay) {
    audioController.reloadIfFailed();
    audioController.play();
  } else {
    els.audio.pause();
  }
  postControl(shouldPlay ? "play" : "pause");
}

function toggleRepeatOne() {
  const enabled = !Boolean(state.station?.repeat_one);
  if (state.station) {
    state.station.repeat_one = enabled;
    renderStation();
  }
  postControl("set_repeat_one", { repeat_one: enabled });
  showToast(`Repeat ${enabled ? "on" : "off"}`);
}

function toggleShuffle() {
  const enabled = !Boolean(state.station?.shuffle);
  if (state.station) {
    state.station.shuffle = enabled;
    renderStation();
  }
  postControl("set_shuffle", { shuffle: enabled });
  showToast(`Shuffle ${enabled ? "on" : "off"}`);
}

async function toggleLike() {
  const track = currentTrack();
  if (!track) return;
  const trackID = track.id;
  const previous = state.likeQueues.get(trackID) || Promise.resolve();
  const mutation = previous.catch(() => {}).then(async () => {
    try {
      const result = await api("/api/like", {
        method: "POST",
        body: { track_id: trackID },
      });
      applyTrackStats(result);
    } catch {
      showToast("Couldn’t update this track.");
    }
  });
  state.likeQueues.set(trackID, mutation);
  await mutation;
  if (state.likeQueues.get(trackID) === mutation) state.likeQueues.delete(trackID);
}

function setStationUnavailable(message) {
  if (audioController.is("radio")) audioController.clear("radio");
  state.station = null;
  state.current = null;
  els.stationMode.textContent = "Station unavailable";
  els.stationAccess.textContent = "Retry to reconnect to this station.";
  els.title.textContent = message;
  els.details.textContent = "Station state could not be loaded. The music archive remains available.";
  clearStationText("Station content is unavailable.");
  els.stationStatus.textContent = "Station unavailable";
  [
    els.playPause, els.back10, els.forward10, els.prev, els.next, els.random,
    els.repeatOne, els.progress, els.like, els.createStation,
  ].forEach((control) => {
    control.disabled = true;
  });
  els.download.removeAttribute("href");
  els.download.setAttribute("aria-disabled", "true");
  els.radioRetry.hidden = false;
  renderStationIdentityActions();
  renderOwnerBar();
  updateNowPlayingMetadata();
}

async function boot(forceCatalog = false) {
  setStationLoading();
  setConnected(false);
  const stationId = requestedStation();
  state.stationId = stationId;
  syncRouteLinks();
  state.ownerToken = stationId === "main"
    ? ""
    : window.ZakStorage.get(`zak-radio-owner:${stationId}`, "");
  try {
    await loadCatalog(forceCatalog);
  } catch (error) {
    els.shellContext.textContent = "Library unavailable";
    setConnected(false);
    setStationUnavailable(error.message || "Library unavailable");
    return;
  }
  els.radioRetry.hidden = true;
  updateShellContext();
  try {
    await refreshStation(false, true);
    connectStationEvents();
    if (state.invalidStationLink) {
      state.invalidStationLink = false;
      showToast("That station link was invalid. Returned to the shared station.",
        { priority: 10, duration: 4000 });
    }
    window.clearInterval(state.pollTimer);
    state.pollTimer = window.setInterval(refreshStation, 5000);
  } catch (error) {
    setConnected(false);
    setStationUnavailable("Station unavailable");
    connectStationEvents();
    window.clearInterval(state.pollTimer);
    state.pollTimer = window.setInterval(refreshStation, 5000);
  }
}

window.ZakRecoverShell = async () => {
  if (!state.station || !state.eventSource) await boot(false);
};

els.playPause.addEventListener("click", togglePlayback);
els.back10.addEventListener("click", () => postControl("relative_seek", { position: -10 }));
els.forward10.addEventListener("click", () => postControl("relative_seek", { position: 10 }));
els.prev.addEventListener("click", () => postControl("prev"));
els.next.addEventListener("click", () => postControl("next"));
els.random.addEventListener("click", toggleShuffle);
els.repeatOne.addEventListener("click", toggleRepeatOne);
els.like.addEventListener("click", toggleLike);
els.toggleDetails.addEventListener("click", () => {
  const expanded = els.toggleDetails.getAttribute("aria-expanded") !== "true";
  els.toggleDetails.setAttribute("aria-expanded", String(expanded));
  els.toggleDetails.textContent = expanded ? "Hide details" : "View details";
  els.promptPanel.hidden = !expanded;
  els.detailsPanels.classList.toggle("is-split", expanded);
  window.queueMicrotask(updateLyricsOverflow);
});
els.toggleLyrics.addEventListener("click", () => {
  setLyricsExpanded(els.toggleLyrics.getAttribute("aria-expanded") !== "true");
});
if ("ResizeObserver" in window) {
  const lyricsResizeObserver = new ResizeObserver(() => updateLyricsOverflow());
  lyricsResizeObserver.observe(els.lyrics);
  lyricsResizeObserver.observe(els.detailsPanels);
} else {
  window.addEventListener("resize", updateLyricsOverflow);
}
els.createStation.addEventListener("click", createTemporaryStation);
els.mainStation.addEventListener("click", async () => {
  const restoreFocus = document.activeElement === els.mainStation;
  await switchStation("main", "");
  if (restoreFocus) focusAfterStationAction(els.createStation);
});
els.shareStation.addEventListener("click", copyStationLink);
els.shareClose.addEventListener("click", () => {
  els.shareFallback.hidden = true;
  els.shareStation.focus();
});
document.querySelectorAll("[data-route]").forEach((link) => {
  link.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(link.dataset.route);
  });
});
window.addEventListener("popstate", (event) => {
	const scroll = Array.isArray(event.state?.scroll) ? event.state.scroll : [0, 0];
	window.ZakPendingRouteScroll = [Number(scroll[0]) || 0, Number(scroll[1]) || 0];
	const restoredAwayFromTop = window.ZakPendingRouteScroll.some((value) => value !== 0);
	const changedView = state.renderedPath !== routePath();
  const stationId = requestedStation();
  if (stationId !== state.stationId) {
    state.controlGeneration++;
    state.controlQueue = Promise.resolve();
    state.stationRequestGeneration++;
    state.stationId = stationId;
    state.ownerToken = stationId === "main"
      ? ""
      : window.ZakStorage.get(`zak-radio-owner:${stationId}`, "");
    setStationLoading();
    connectStationEvents();
    const generation = state.stationRequestGeneration;
    void refreshStation().then((loaded) => {
      if (!loaded && generation === state.stationRequestGeneration &&
          stationId === state.stationId) {
        setStationUnavailable("Station unavailable");
      }
    });
  }
	renderRoute(changedView && !restoredAwayFromTop, true);
	window.requestAnimationFrame(() => {
    window.scrollTo({
      left: window.ZakPendingRouteScroll?.[0] || 0,
      top: window.ZakPendingRouteScroll?.[1] || 0,
      behavior: "instant",
    });
	  const hasReaderItem = routePath() === "/reader" &&
	    new URLSearchParams(location.search).has("item");
	  if (changedView && restoredAwayFromTop) {
	    const routeLink = [...document.querySelectorAll(`[data-route="${routePath()}"]`)]
	      .find((link) => link.getClientRects().length && !link.closest("[hidden]"));
	    routeLink?.focus({ preventScroll: true });
	  }
	  if (!hasReaderItem) window.ZakPendingRouteScroll = null;
  });
});
if ("scrollRestoration" in window.history) {
  window.history.scrollRestoration = "manual";
}
if (!Array.isArray(window.history.state?.scroll)) {
  window.history.replaceState({
    ...(window.history.state || {}),
    scroll: [window.scrollX, window.scrollY],
  }, "");
}
function commitScrollState() {
  window.history.replaceState({
    ...(window.history.state || {}),
    scroll: [window.scrollX, window.scrollY],
  }, "");
}
window.ZakCommitScrollState = commitScrollState;
window.addEventListener("scroll", () => {
  window.clearTimeout(scrollStateTimer);
  scrollStateTimer = window.setTimeout(() => {
    commitScrollState();
  }, 120);
}, { passive: true });
els.returnLive.addEventListener("click", async () => {
  const restoreRadioFocus = routePath() === "/" && els.ownerBar.contains(document.activeElement);
  if (audioController.is("radio")) navigate("/");
  else await audioController.returnLive();
  if (restoreRadioFocus) {
    (els.playPause.disabled ? els.title : els.playPause).focus({ preventScroll: true });
  }
});
els.ownerPlayPause.addEventListener("click", async () => {
  if (audioController.is("radio")) {
    if (!els.audio.paused) {
      state.localRadioSuspended = true;
      els.audio.pause();
      renderStation();
    } else if (state.station?.playing) {
      state.userActivatedAudio = true;
      state.localRadioSuspended = false;
      await syncAudioToStation();
    } else {
      navigate("/");
    }
    return;
  }
  if (els.audio.paused) {
    if (audioController.is("reader") && window.ZakReader?.play) {
      await window.ZakReader.play();
    } else {
      await audioController.play();
    }
  } else {
    els.audio.pause();
  }
});
els.radioRetry.addEventListener("click", async () => {
	els.radioRetry.disabled = true;
	try {
	  await boot(true);
	  if (state.station && !els.radioRetry.hidden) els.radioRetry.hidden = true;
	  if (state.station) els.title.focus({ preventScroll: true });
	} finally {
	  els.radioRetry.disabled = false;
	}
});
els.audio.addEventListener("error", () => reportAudioError(els.audio.error));
els.audio.addEventListener("play", () => {
  dismissToast("audio-error");
  if (audioController.is("radio")) renderStation();
  updateNowPlayingMetadata();
  renderOwnerBar();
});
els.audio.addEventListener("pause", () => {
  if (audioController.is("radio")) renderStation();
  updateNowPlayingMetadata();
  renderOwnerBar();
});
if ("mediaSession" in navigator) {
  try {
    navigator.mediaSession.setActionHandler("play", async () => {
      if (audioController.is("reader") && window.ZakReader?.play) {
        await window.ZakReader.play();
      } else if (!audioController.is("radio")) {
        await audioController.play();
      } else if (state.station?.playing) {
        state.userActivatedAudio = true;
        state.localRadioSuspended = false;
        await syncAudioToStation();
      } else {
        await togglePlayback();
      }
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      if (audioController.is("radio") && state.station?.playing) {
        state.localRadioSuspended = true;
      }
      els.audio.pause();
    });
    navigator.mediaSession.setActionHandler("seekbackward", (details) => {
      const offset = Number(details.seekOffset || 10);
      if (audioController.is("reader")) window.ZakReader?.seekBy?.(-offset);
      else if (audioController.is("radio")) {
        if (canControlStation()) postControl("relative_seek", { position: -offset });
      }
      else els.audio.currentTime = Math.max(0, (els.audio.currentTime || 0) - offset);
    });
    navigator.mediaSession.setActionHandler("seekforward", (details) => {
      const offset = Number(details.seekOffset || 10);
      if (audioController.is("reader")) window.ZakReader?.seekBy?.(offset);
      else if (audioController.is("radio")) {
        if (canControlStation()) postControl("relative_seek", { position: offset });
      }
      else els.audio.currentTime = Math.min(els.audio.duration || Infinity,
        (els.audio.currentTime || 0) + offset);
    });
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      const position = Number(details.seekTime || 0);
      if (audioController.is("reader")) window.ZakReader?.seekTo?.(position);
      else if (audioController.is("radio")) {
        if (canControlStation()) postControl("seek", { position });
      }
      else els.audio.currentTime = position;
    });
  } catch {}
}
window.addEventListener("zak-audio-owner", renderStation);
els.audio.addEventListener("timeupdate", () => {
  if (audioController.is("radio")) updateProgressFromAudio();
});
els.audio.addEventListener("loadedmetadata", () => {
  if (audioController.is("radio")) updateProgressFromAudio();
});
els.audio.addEventListener("ended", () => {
  if (!audioController.is("radio")) return;
  // Track boundaries are server-authoritative. Every listener receives the
  // resulting revision through SSE; refresh immediately as a degraded-path
  // fallback when the stream is temporarily unavailable.
  refreshStation();
});
els.progress.addEventListener("input", () => {
  state.syncingProgress = true;
  els.currentTime.textContent = timeLabel(els.progress.value);
  renderProgress(Number(els.progress.value), Number(els.progress.max));
});
els.progress.addEventListener("change", async () => {
  const position = Number(els.progress.value || 0);
  state.syncingProgress = false;
  await postControl("seek", { position });
});

document.addEventListener("keydown", (event) => {
  const activeTag = document.activeElement?.tagName || "";
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(activeTag);
  const interactive = /^(BUTTON|A)$/.test(activeTag);
  if (typing || interactive || routePath() !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (event.code === "Space") {
    if (els.playPause.disabled) return;
    event.preventDefault();
    togglePlayback();
  } else if (event.key === "ArrowLeft") {
    if (!canControlStation()) return;
    event.preventDefault();
    postControl("relative_seek", { position: -10 });
  } else if (event.key === "ArrowRight") {
    if (!canControlStation()) return;
    event.preventDefault();
    postControl("relative_seek", { position: 10 });
  }
});

renderRoute();
boot();
window.setInterval(() => {
  if (routePath() === "/" &&
      (!audioController.is("radio") || els.audio.paused || state.localRadioSuspended)) {
    updateProgressFromStation();
  }
}, 500);
