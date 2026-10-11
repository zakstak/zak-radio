import { createAudioController } from "./audio.js";
import { createRouter } from "./router.js";
import { createLyricsView } from "./lyrics.js";
import { timeLabel } from "./format.js";
import { initLibrary } from "./library.js";
import { initReader } from "./reader.js";

const state = {
  tracks: [],
  current: null,
  station: null,
  connected: false,
  syncingProgress: false,
  userActivatedAudio: false,
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
  radioInterrupted: false,
  radioStopped: false,
  playbackRecoveryTimer: 0,
  playbackRecoveryAttempt: 0,
  playbackRecoveryInFlight: false,
  pollTimer: 0,
  controlQueue: Promise.resolve(),
  controlGeneration: 0,
  trackStatsRevision: 0,
  catalogRevision: "",
  likeQueues: new Map(),
  invalidStationLink: false,
  stationCapacityRetryAt: 0,
  stationCreatePending: false,
  stations: [],
};

const els = {
  appShell: document.querySelector(".app-shell"),
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
  lyricsFollow: document.getElementById("lyricsFollow"),
  lyricsSyncStatus: document.getElementById("lyricsSyncStatus"),
  prompt: document.getElementById("prompt"),
  download: document.getElementById("download"),
  stationProgress: document.getElementById("stationProgress"),
  transport: document.getElementById("transport"),
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
  dislike: document.getElementById("dislike"),
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
  stationSelect: document.getElementById("stationSelect"),
  stationAccess: document.getElementById("stationAccess"),
  mainStation: document.getElementById("mainStation"),
  shareStation: document.getElementById("shareStation"),
  shareFallback: document.getElementById("stationShareFallback"),
  shareLink: document.getElementById("stationShareLink"),
  shareClose: document.getElementById("stationShareClose"),
  createStation: document.getElementById("createStation"),
  stationCard: document.getElementById("stationCard"),
  radioView: document.getElementById("radioView"),
  stationCapabilityLabel: document.getElementById("stationCapabilityLabel"),
  stationCapabilityDetail: document.getElementById("stationCapabilityDetail"),
  ownerBar: document.getElementById("audioOwnerBar"),
  ownerKicker: document.getElementById("audioOwnerKicker"),
  ownerLabel: document.getElementById("audioOwnerLabel"),
  ownerPlayPause: document.getElementById("audioOwnerPlayPause"),
  returnLive: document.getElementById("returnLive"),
  ownerAnnouncement: document.getElementById("audioOwnerAnnouncement"),
  radioRetry: document.getElementById("radioRetry"),
  radioQueue: document.getElementById("radioQueue"),
  radioQueueSummary: document.getElementById("radioQueueSummary"),
  radioQueueTracks: document.getElementById("radioQueueTracks"),
  radioProgramming: document.getElementById("radioProgramming"),
  radioOwnerControls: document.getElementById("radioOwnerControls"),
  radioOwnerControlsSummary: document.getElementById(
    "radioOwnerControlsSummary",
  ),
  stationRandomMode: document.getElementById("stationRandomMode"),
  stationSkipDisliked: document.getElementById("stationSkipDisliked"),
  addCurrentToStation: document.getElementById("addCurrentToStation"),
  addToStationDialog: document.getElementById("addToStationDialog"),
  addToStationTrack: document.getElementById("addToStationTrack"),
  addToStationSelect: document.getElementById("addToStationSelect"),
  addToStationStatus: document.getElementById("addToStationStatus"),
  confirmAddToStation: document.getElementById("confirmAddToStation"),
};

let toastTimer;
let toastPriority = 0;
let toastPriorityUntil = 0;
let toastType = "";
let ownerAnnouncement = "Audio stopped";

function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function radioGroupValue(group) {
  return group.querySelector('input[type="radio"]:checked')?.value || "";
}

function setRadioGroupValue(group, value) {
  group.querySelectorAll('input[type="radio"]').forEach((input) => {
    input.checked = input.value === value;
  });
}

function setRadioGroupDisabled(group, disabled) {
  group.querySelectorAll('input[type="radio"]').forEach((input) => {
    input.disabled = disabled;
  });
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

function cleanedTrackLabel(value) {
  return String(value || "")
    .replace(/^#+\s*/, "")
    .replace(/^(?:🎵\s*)?(?:title|subject)\s*:\s*/i, "")
    .trim()
    .replace(/^[“"'`]+|[”"'`]+$/g, "")
    .trim();
}

function weakTrackLabel(value) {
  const label = cleanedTrackLabel(value);
  if (!label || label.length > 88 || /^\d+$/.test(label)) return true;
  if (/^(?:artist)\s*:/i.test(label)) return true;
  if (
    /^\[\s*(?:lyrics?|hook|verse|chorus|bridge|intro|outro|pre-?chorus)\b.*\]$/i.test(
      label,
    ) ||
    /^(?:lyrics?|verse|chorus|bridge|intro|outro|pre-?chorus)\]$/i.test(
      label,
    ) ||
    /^(?:lyrics?|hook|verse|chorus|bridge|intro|outro|pre-?chorus)\s*(?::.*)?$/i.test(
      label,
    )
  ) {
    return true;
  }
  if (/^[[(].*[\])]$/.test(label)) return true;
  return false;
}

function trackDisplayTitle(track) {
  const title = cleanedTrackLabel(track?.title);
  if (!weakTrackLabel(title)) return title;
  const subject = cleanedTrackLabel(
    String(track?.summary || "").split(/\r?\n/, 1)[0],
  );
  if (!weakTrackLabel(subject)) return subject;
  const group = cleanedTrackLabel(track?.group);
  if (!weakTrackLabel(group)) return group;
  return "Original track";
}

function trackDisplayGroup(track) {
  const group = cleanedTrackLabel(track?.group);
  return weakTrackLabel(group) ? "" : group;
}

function createArtworkFallback() {
  const fallback = document.createElement("span");
  fallback.className = "track-cover-fallback";
  fallback.setAttribute("aria-hidden", "true");
  fallback.innerHTML = `
    <svg class="no-artwork-icon" viewBox="0 0 96 96">
      <rect x="18" y="39" width="10" height="18" rx="5"></rect>
      <rect x="34" y="25" width="10" height="46" rx="5"></rect>
      <rect x="50" y="16" width="10" height="64" rx="5"></rect>
      <rect x="66" y="31" width="10" height="34" rx="5"></rect>
    </svg>
    <span>No artwork</span>`;
  return fallback;
}

window.ZakTrackDisplayTitle = trackDisplayTitle;
window.ZakTrackDisplayGroup = trackDisplayGroup;
window.ZakArtworkFallback = createArtworkFallback;

function showToast(message, { priority = 0, duration = 2200, type = "" } = {}) {
  if (priority < toastPriority && performance.now() < toastPriorityUntil)
    return;
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

const audioController = createAudioController({
  element: els.audio,
  shouldPlayRadio: radioShouldBeAudible,
  returnLive: returnLiveRadio,
  onPause: () => {
    state.radioInterrupted = false;
  },
  onRadioBlocked: () => {
    state.localRadioSuspended = true;
  },
  onOwnerChange: renderOwnerBar,
  onPlaybackChange: updateNowPlayingMetadata,
  onError: reportAudioError,
});
window.ZakAudio = audioController;

async function returnLiveRadio(sync = true) {
  const track = state.station ? currentTrack() : null;
  if (!track) {
    showToast(
      "Live station controls are unavailable. Local audio is still active.",
    );
    renderOwnerBar();
    return false;
  }
  state.userActivatedAudio = true;
  state.radioStopped = false;
  state.localRadioSuspended = false;
  els.audio.pause();
  window.dispatchEvent(
    new CustomEvent("zak-audio-release", {
      detail: {
        owner: audioController.owner,
        nextOwner: "radio",
        position: els.audio.currentTime || 0,
        playing: !els.audio.paused,
        generation: audioController.generation,
      },
    }),
  );
  const src = mediaAudioURL(track);
  audioController.claim("radio", src, trackDisplayTitle(track), {
    stationId: state.stationId,
  });
  if (sync) await syncAudioToStation();
  return true;
}

const router = createRouter({
  els: {
    appShell: els.appShell,
    ownerBar: els.ownerBar,
    skipToContent: els.skipToContent,
    stationCard: els.stationCard,
    title: els.title,
  },
  stationId: () => state.stationId,
  selectedReaderId: () => window.ZakReader?.selectedId?.(),
  onRender: (path) => {
    renderOwnerBar();
    updateShellContext();
    updateNowPlayingMetadata();
    renderStation();
    if (path === "/" && state.current) lyrics.load(state.current);
  },
  onHistory: () => {
    const stationId = requestedStation();
    if (stationId !== state.stationId) {
      state.controlGeneration++;
      state.controlQueue = Promise.resolve();
      state.stationRequestGeneration++;
      state.stationId = stationId;
      state.ownerToken =
        stationId === "main"
          ? ""
          : window.ZakStorage.get(`zak-radio-owner:${stationId}`, "");
      setStationLoading();
      connectStationEvents();
      const generation = state.stationRequestGeneration;
      void refreshStation().then((loaded) => {
        if (
          !loaded &&
          generation === state.stationRequestGeneration &&
          stationId === state.stationId
        ) {
          setStationUnavailable("Station unavailable");
        }
      });
    }
  },
});

function renderOwnerBar() {
  if (!audioController.owner) {
    router.setOwnerBarHidden(true);
    if (ownerAnnouncement !== "Audio stopped") {
      ownerAnnouncement = "Audio stopped";
      setText(els.ownerAnnouncement, ownerAnnouncement);
    }
    return;
  }
  const pathOwner = router.path().slice(1);
  const radioOffView =
    audioController.owner === "radio" && router.path() !== "/";
  const readerLibraryOwner =
    audioController.owner === "reader" &&
    router.path() === "/reader" &&
    !window.ZakReader?.selectedId?.();
  const radioIsLive = Boolean(state.station?.playing);
  const radioNeedsJoin =
    radioOffView &&
    radioIsLive &&
    (els.audio.paused ||
      state.localRadioSuspended ||
      !state.userActivatedAudio);
  router.setOwnerBarHidden(
    (audioController.owner === pathOwner && !readerLibraryOwner) ||
      (audioController.owner === "radio" && !radioOffView),
  );
  setText(els.ownerKicker, radioOffView ? "Live station" : "Listening locally");
  setText(els.ownerLabel, audioController.label);
  setText(els.returnLive, radioOffView ? "Open Radio" : "Return to live");
  els.returnLive.setAttribute(
    "aria-label",
    radioOffView ? "Open Radio controls" : "Return to live radio",
  );
  setText(
    els.ownerPlayPause,
    radioOffView && !radioIsLive
      ? "Station paused"
      : radioNeedsJoin
        ? "Join live"
        : els.audio.paused
          ? "Resume"
          : "Pause",
  );
  els.ownerPlayPause.disabled = radioOffView && !radioIsLive;
  els.ownerPlayPause.setAttribute(
    "aria-label",
    radioOffView && !radioIsLive
      ? "Station paused"
      : radioNeedsJoin
        ? "Join live audio"
        : `${els.audio.paused ? "Resume" : "Pause"} local audio`,
  );
  const announcement =
    audioController.owner === "radio"
      ? `${radioIsLive ? "Live station" : "Station paused"}: ${audioController.label}`
      : `Local audio: ${audioController.label}`;
  if (announcement !== ownerAnnouncement) {
    ownerAnnouncement = announcement;
    setText(els.ownerAnnouncement, announcement);
  }
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

function updateShellContext() {
  const path = router.path();
  els.shellContext.textContent =
    path === "/library"
      ? "Original music archive"
      : path === "/reader"
        ? "Source reading room"
        : `${state.tracks.length || "Shared"} tracks`;
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
  const request = api("/api/tracks", { signal: controller.signal }).then(
    (data) => {
      if (generation !== catalogGeneration)
        throw new DOMException("Stale catalog", "AbortError");
      const tracks = Array.isArray(data.tracks) ? data.tracks : [];
      if (!tracks.length)
        throw new Error("The archive has no playable tracks.");
      state.tracks = tracks;
      state.trackStatsRevision = Number(data.track_stats_revision || 0);
      state.catalogRevision = String(data.catalog_revision || "");
      for (const listener of catalogListeners) listener(tracks);
      return tracks;
    },
  );
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
  if (
    !revision ||
    revision <= state.trackStatsRevision ||
    !Array.isArray(payload.tracks)
  )
    return false;
  const byID = new Map(payload.tracks.map((stat) => [stat.track_id, stat]));
  for (const track of state.tracks) {
    const stat = byID.get(track.id);
    if (!stat) continue;
    track.liked = Boolean(stat.liked);
    track.disliked = Boolean(stat.disliked);
    track.like_count = Number(stat.like_count || 0);
    track.dislike_count = Number(stat.dislike_count || 0);
    track.skip_count = Number(stat.skip_count || 0);
  }
  state.trackStatsRevision = revision;
  if (state.station) {
    const current = state.tracks.find(
      (track) => track.id === state.station.track_id,
    );
    if (current) {
      state.station.liked = current.liked;
      state.station.disliked = current.disliked;
      state.station.like_count = current.like_count;
      state.station.dislike_count = current.dislike_count;
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
    showToast("Tap Play to allow audio in this browser.", {
      type: "audio-error",
    });
  } else {
    showToast("Audio is unavailable. Check the media file and try again.", {
      type: "audio-error",
    });
  }
}

function radioShouldBeAudible() {
  return Boolean(
    audioController.is("radio") &&
    state.station?.playing &&
    state.userActivatedAudio &&
    !state.radioStopped &&
    !state.localRadioSuspended,
  );
}

function clearPlaybackRecovery(resetAttempt = true) {
  window.clearTimeout(state.playbackRecoveryTimer);
  state.playbackRecoveryTimer = 0;
  if (resetAttempt) state.playbackRecoveryAttempt = 0;
}

function schedulePlaybackRecovery(delay = 0) {
  if (!radioShouldBeAudible() || navigator.onLine === false) return;
  window.clearTimeout(state.playbackRecoveryTimer);
  state.playbackRecoveryTimer = window.setTimeout(
    () => {
      state.playbackRecoveryTimer = 0;
      void recoverRadioPlayback();
    },
    Math.max(0, delay),
  );
}

async function recoverRadioPlayback() {
  if (state.playbackRecoveryInFlight || !radioShouldBeAudible()) return;
  // Native preparation is bounded. Superseding it would only send another
  // request and report the first attempt as blocked.
  if (audioController.preparing) {
    schedulePlaybackRecovery(1000);
    return;
  }
  state.playbackRecoveryInFlight = true;
  try {
    // Reload before refreshing: refresh also awaits play(), which may be stuck
    // on the interrupted request even though the media element has no error.
    audioController.reloadIfFailed({ stalled: true });
    const refreshed = await refreshStation(true);
    if (!radioShouldBeAudible()) return;
    if (!refreshed) await syncAudioToStation();
    if (
      !els.audio.paused &&
      !els.audio.error &&
      els.audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
    ) {
      clearPlaybackRecovery();
      return;
    }
    const delay = Math.min(30_000, 750 * 2 ** state.playbackRecoveryAttempt++);
    schedulePlaybackRecovery(delay);
  } finally {
    state.playbackRecoveryInFlight = false;
  }
}

function durationOf(track) {
  const n = Number(track?.duration);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function mediaAudioURL(track) {
  const version = encodeURIComponent(
    track?.audio_sha256 || state.catalogRevision || "current",
  );
  return `/media/${encodeURIComponent(track.id)}/audio?v=${version}`;
}

function mediaCoverURL(track) {
  const version = encodeURIComponent(
    track?.cover_sha256 || state.catalogRevision || "current",
  );
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

function stationDefinition(stationId = state.stationId) {
  return state.stations.find((station) => station.station_id === stationId);
}

function ownedSavedStations() {
  return state.stations.filter(
    (station) =>
      !station.built_in &&
      Boolean(
        window.ZakStorage.get(`zak-radio-owner:${station.station_id}`, ""),
      ),
  );
}

async function loadStations() {
  const result = await api("/api/stations");
  state.stations = Array.isArray(result.stations) ? result.stations : [];
  renderStationPicker();
  window.dispatchEvent(
    new CustomEvent("zak-stations", { detail: state.stations }),
  );
  return state.stations;
}

function renderStationPicker() {
  if (!els.stationSelect) return;
  const stations = state.stations.length
    ? state.stations
    : [{ station_id: "main", name: "All songs", built_in: true }];
  els.stationSelect.replaceChildren(
    ...stations.map((station) => {
      const option = document.createElement("option");
      option.value = station.station_id;
      option.textContent = station.name;
      return option;
    }),
  );
  if (stations.some((station) => station.station_id === state.stationId)) {
    els.stationSelect.value = state.stationId;
  }
}

async function updateSavedStation(stationId, changes) {
  const ownerToken = window.ZakStorage.get(`zak-radio-owner:${stationId}`, "");
  if (!ownerToken) throw new Error("This station is listen-only.");
  const result = await api(`/api/stations/${encodeURIComponent(stationId)}`, {
    method: "PATCH",
    body: { owner_token: ownerToken, ...changes },
  });
  await loadStations();
  return result.station;
}

let addToStationTrack = null;

function openAddToStation(track) {
  const stations = ownedSavedStations().filter(
    (station) => station.source_type === "list",
  );
  if (!stations.length) {
    showToast("Create a station with this song.");
    router.navigate("/library");
    window.dispatchEvent(
      new CustomEvent("zak-new-list-station", { detail: { track } }),
    );
    return false;
  }
  addToStationTrack = track;
  els.addToStationTrack.textContent = window.ZakTrackDisplayTitle(track);
  els.addToStationStatus.textContent = "";
  els.addToStationSelect.replaceChildren(
    ...stations.map((station) => {
      const option = document.createElement("option");
      option.value = station.station_id;
      option.textContent = station.name;
      return option;
    }),
  );
  els.addToStationDialog.showModal();
  return true;
}

window.ZakStations = {
  list: () => state.stations.map((station) => ({ ...station })),
  owned: () => ownedSavedStations().map((station) => ({ ...station })),
  reload: loadStations,
  update: updateSavedStation,
  addTrack: openAddToStation,
};

function canControlStation() {
  return (
    Boolean(state.station) &&
    (state.stationId === "main" || Boolean(state.station.can_control))
  );
}

function stationView() {
  const saved = Boolean(state.station?.saved);
  const definition = stationDefinition();
  return {
    stationId: state.stationId,
    kind: saved ? "radio" : "private",
    label:
      definition?.name ||
      state.station?.station_name ||
      (saved ? "All songs" : "your private station"),
    canControl: canControlStation(),
    supportsQueue: !saved,
    saved,
    queue: Array.isArray(state.station?.queue) ? [...state.station.queue] : [],
  };
}

function publishStationView() {
  window.dispatchEvent(
    new CustomEvent("zak-station", { detail: stationView() }),
  );
}

function setConnected(connected) {
  state.connected = connected;
  els.connectionDot.classList.toggle("is-connected", state.streamConnected);
  els.connectionDot.classList.toggle(
    "is-polling",
    !state.streamConnected && connected,
  );
  els.connectionDot.classList.toggle(
    "is-disconnected",
    !state.streamConnected && !connected,
  );
  const label = state.streamConnected
    ? "Station updates live"
    : connected
      ? "Station updates polling"
      : "Station updates reconnecting";
  const detail = state.streamConnected
    ? "Station changes are arriving live."
    : connected
      ? "The live station stream is reconnecting; station state is still refreshing."
      : "Station state is unavailable and Radio is retrying. Library and Reader recover separately.";
  setText(els.connectionText, label);
  els.connection.title = detail;
  els.connection.setAttribute("aria-label", `${label}. ${detail}`);
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
  setText(els.stationCapabilityLabel, "Station connecting");
  setText(
    els.stationCapabilityDetail,
    "Radio is waiting for authoritative station state. Library and Reader remain separate.",
  );
  els.radioView.classList.remove("is-listen-only");
  els.stationStatus.textContent = "Connecting…";
  els.livePulse.classList.remove("is-live");
  els.source.textContent = "Zak Radio";
  els.title.textContent = "Loading station…";
  els.details.textContent = "Connecting to the requested station.";
  lyrics.clear("Waiting for station content.");
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
    els.playPause,
    els.back10,
    els.forward10,
    els.prev,
    els.next,
    els.random,
    els.repeatOne,
    els.progress,
    els.like,
    els.dislike,
    els.createStation,
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
  const custom = state.stationId !== "main";
  els.mainStation.hidden = !custom;
  els.shareStation.hidden = !custom;
  els.createStation.hidden = false;
}

function focusAfterStationAction(preferred) {
  const target = [
    preferred,
    els.mainStation,
    els.createStation,
    els.shareStation,
    els.radioRetry,
  ].find(
    (element) =>
      element &&
      !element.hidden &&
      !element.disabled &&
      element.getClientRects().length > 0,
  );
  (target || els.stationMode).focus({ preventScroll: true });
}

const lyrics = createLyricsView({
  els: {
    audio: els.audio,
    lyrics: els.lyrics,
    lyricsViewport: els.lyricsViewport,
    lyricsFade: els.lyricsFade,
    lyricsMoreRow: els.lyricsMoreRow,
    toggleLyrics: els.toggleLyrics,
    lyricsFollow: els.lyricsFollow,
    lyricsSyncStatus: els.lyricsSyncStatus,
    prompt: els.prompt,
    toggleDetails: els.toggleDetails,
    promptPanel: els.promptPanel,
    detailsPanels: els.detailsPanels,
  },
  api,
  currentTrackId: () => state.current?.id,
  stationId: () => state.stationId,
  canSeek: canControlStation,
  isRadio: () => audioController.is("radio"),
  seek: (position) => postControl("seek", { position }),
  notify: showToast,
});

function renderTrack(track) {
  if (!track) return;
  const changed = state.current?.id !== track.id;
  const displayTitle = trackDisplayTitle(track);
  state.current = track;
  els.title.textContent = displayTitle;
  els.source.textContent =
    [track.source, track.artist].filter(Boolean).join(" · ") || "Zak Radio";
  els.details.textContent = [
    trackDisplayGroup(track),
    timeLabel(track.duration),
    fileSize(track.audio_bytes),
  ]
    .filter(Boolean)
    .join("  ·  ");
  els.download.href = mediaAudioURL(track);
  els.download.download = `${displayTitle || track.id}.mp3`;
  els.download.removeAttribute("aria-disabled");
  const showCoverFallback = () => {
    if (!els.emptyCover.querySelector(".no-artwork-icon")) {
      const fallback = createArtworkFallback();
      els.emptyCover.replaceChildren(...Array.from(fallback.childNodes));
    }
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
    audioController.claim("radio", src, displayTitle, {
      stationId: state.stationId,
    });
  }
  els.progress.max = String(durationOf(track));
  els.duration.textContent = timeLabel(durationOf(track));
  if (router.path() === "/") lyrics.load(track);
  if (changed) {
    els.nowPlayingAnnouncement.textContent = `Now playing ${displayTitle}`;
  }
  updateNowPlayingMetadata();
}

function requestNextTrack() {
  void postControl("next");
}

function renderStation() {
  const track = currentTrack();
  const station = state.station;
  if (!track || !station) return;
  const playing = Boolean(station.playing);
  const emptyRadio =
    Boolean(station.saved) && Number(station.eligible || 0) === 0;
  const repeatOne = Boolean(station.repeat_one);
  const shuffle = Boolean(station.shuffle);
  const needsLocalJoin =
    playing &&
    (!audioController.is("radio") ||
      els.audio.paused ||
      state.localRadioSuspended);
  els.stationStatus.textContent = emptyRadio
    ? "No songs match this station"
    : needsLocalJoin
      ? "Live now · tap Join live to hear"
      : playing
        ? "Live now"
        : "Station paused";
  els.livePulse.classList.toggle("is-live", playing);
  const playLabel = needsLocalJoin ? "Join live" : playing ? "Pause" : "Play";
  els.playPause.querySelector(".sr-only").textContent = playLabel;
  els.playPause.setAttribute("aria-label", playLabel);
  els.playIcon.classList.toggle("hidden", !needsLocalJoin && playing);
  els.pauseIcon.classList.toggle("hidden", needsLocalJoin || !playing);
  renderModeButton(els.repeatOne, repeatOne, "Repeat current track");
  renderModeButton(els.random, shuffle, "Shuffle");
  if (audioController.is("radio")) els.audio.loop = repeatOne;
  const likes = Number(station.like_count || 0);
  const dislikes = Number(station.dislike_count || 0);
  els.like.textContent = `Like · ${likes}`;
  els.like.setAttribute(
    "aria-label",
    `Like this song. ${likes} ${likes === 1 ? "like" : "likes"}`,
  );
  els.like.setAttribute("aria-pressed", "false");
  els.dislike.textContent = `Dislike · ${dislikes}`;
  els.dislike.setAttribute(
    "aria-label",
    `Dislike this song. ${dislikes} ${dislikes === 1 ? "dislike" : "dislikes"}`,
  );
  els.dislike.setAttribute("aria-pressed", "false");
  const skips = Number(station.skip_count || 0);
  els.skipCount.textContent = `${skips} early ${skips === 1 ? "skip" : "skips"}`;
  const queue = Array.isArray(station.queue) ? station.queue : [];
  const radio = Boolean(station.saved);
  const nextIDs = radio
    ? Array.isArray(station.up_next)
      ? station.up_next
      : []
    : queue;
  const nextTrack = state.tracks.find((item) => item.id === nextIDs[0]);
  if (radio && station.random_mode === "true_random") {
    els.radioQueueSummary.textContent = `${Number(station.eligible || 0)} songs in the pool. Every pick is independent, so repeats can happen.`;
  } else if (radio) {
    els.radioQueueSummary.textContent = nextIDs.length
      ? `${nextTrack ? trackDisplayTitle(nextTrack) : "A song"} is next · ${Number(station.remaining || nextIDs.length)} left before reshuffle.`
      : "The shuffled list will refill on the next song.";
  } else {
    els.radioQueueSummary.textContent = queue.length
      ? `${nextTrack ? trackDisplayTitle(nextTrack) : "A queued track"} is next${queue.length > 1 ? ` · ${queue.length} total` : ""}.`
      : "The private queue is empty.";
  }
  els.radioQueueTracks.replaceChildren(
    ...nextIDs.slice(0, 8).map((trackID) => {
      const item = document.createElement("li");
      const queuedTrack = state.tracks.find((track) => track.id === trackID);
      item.textContent = queuedTrack
        ? trackDisplayTitle(queuedTrack)
        : "Unknown song";
      return item;
    }),
  );
  const temporary = !radio;
  const canControl = canControlStation();
  const capability = canControl ? "control" : "listen-only";
  const capabilityChanged = els.radioView.dataset.capability !== capability;
  els.radioView.dataset.capability = capability;
  els.radioView.classList.toggle("is-listen-only", !canControl);
  setText(
    els.stationCapabilityLabel,
    temporary
      ? canControl
        ? "Private owner controls"
        : "Listen-only private station"
      : canControl
        ? state.stationId === "main"
          ? "Shared station control"
          : "Saved station owner controls"
        : "Listen-only saved station",
  );
  setText(
    els.stationCapabilityDetail,
    temporary
      ? canControl
        ? "This browser can control the private queue. Shared links can listen but cannot change it."
        : "Join live, follow lyrics, react, and download here. The creator owns transport and queue changes."
      : canControl
        ? "Join live, react, download, and shape this saved station from this browser."
        : "Join live, follow lyrics, react, and download here. The station owner controls transport and programming.",
  );
  els.stationMode.textContent = radio
    ? station.station_name || stationDefinition()?.name || "Radio station"
    : "Private queue";
  els.stationAccess.textContent = temporary
    ? canControl
      ? "Only this browser can turn this dial. The share link is listen-only."
      : "Listen-only. The creator controls this dial."
    : canControl
      ? ""
      : "Listen-only. The station owner controls its programming.";
  els.stationAccess.hidden = !els.stationAccess.textContent;
  renderStationIdentityActions();
  els.random.hidden = !temporary;
  els.prev.hidden = !temporary;
  els.back10.hidden = !temporary;
  els.forward10.hidden = !temporary;
  els.repeatOne.hidden = !temporary;
  els.stationProgress.hidden = !temporary;
  els.radioQueue.hidden = false;
  els.skipCount.hidden = !temporary;
  els.transport.classList.toggle("is-radio", !temporary);
  els.radioProgramming.hidden = !radio;
  els.radioOwnerControls.hidden = !radio;
  if (radio && capabilityChanged) els.radioOwnerControls.open = false;
  els.radioOwnerControlsSummary.textContent = canControl
    ? "Playback settings"
    : "Playback settings · listen-only";
  els.addCurrentToStation.hidden = !radio;
  setRadioGroupValue(els.stationRandomMode, station.random_mode || "deck");
  setRadioGroupDisabled(els.stationRandomMode, !canControl);
  els.stationSkipDisliked.checked = Boolean(station.skip_disliked);
  els.stationSkipDisliked.disabled = !canControl;
  els.stationSelect.value = state.stationId;
  els.lyrics.querySelectorAll(".synced-lyric-cue").forEach((cue) => {
    cue.disabled = !temporary || !canControl;
  });
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
  const canPauseLocally =
    playing && audioController.is("radio") && !els.audio.paused;
  els.playPause.disabled = !canControl && !needsLocalJoin && !canPauseLocally;
  if (emptyRadio) {
    els.playPause.disabled = true;
    els.next.disabled = true;
  }
  els.like.disabled = false;
  els.dislike.disabled = false;
  els.createStation.disabled =
    state.stationCreatePending ||
    performance.now() < state.stationCapacityRetryAt;
  if (
    !audioController.is("radio") ||
    els.audio.paused ||
    state.localRadioSuspended
  ) {
    updateProgressFromStation();
  }
  renderOwnerBar();
  updateNowPlayingMetadata();
}

function updateNowPlayingMetadata() {
  const track = currentTrack();
  const path = router.path();
  if (!track) {
    document.title =
      path === "/library"
        ? "Library · Zak Radio"
        : path === "/reader"
          ? "Reader · Zak Radio"
          : "Zak Radio";
    window.ZakNativeHost?.media({
      state: audioController.nativeState(),
      title: audioController.label || "Zak Radio",
      subtitle: "Zakstak",
    });
    return;
  }
  const playing = Boolean(state.station?.playing);
  if (audioController.is("radio") && path === "/") {
    document.title = `${playing ? "▶ " : ""}${trackDisplayTitle(track)} · Zak Radio`;
  } else if (path === "/library") {
    document.title = "Library · Zak Radio";
  } else if (path === "/reader") {
    document.title = "Reader · Zak Radio";
  } else {
    document.title = `${audioController.label || trackDisplayTitle(track)} · Zak Radio`;
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = els.audio.paused
      ? "paused"
      : "playing";
    if (audioController.is("radio")) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: trackDisplayTitle(track),
        artist: track.artist || "Zak",
        album: "Zak Radio",
        artwork: track.has_cover ? [{ src: mediaCoverURL(track) }] : [],
      });
    }
  }
  window.ZakNativeHost?.media({
    state: audioController.nativeState(),
    title: audioController.label || trackDisplayTitle(track),
    subtitle:
      audioController.owner === "radio"
        ? track.artist || "Zak Radio"
        : audioController.owner === "reader"
          ? "Zak Reader"
          : "Private library preview",
  });
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
  const percent =
    duration > 0 ? Math.max(0, Math.min(100, (position / duration) * 100)) : 0;
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

function currentStationLease(station, stationId, stationGeneration) {
  return (
    state.station === station &&
    state.stationId === stationId &&
    state.stationRequestGeneration === stationGeneration &&
    audioController.is("radio") &&
    audioController.stationId === stationId
  );
}

async function syncAudioToStation(
  station = state.station,
  stationId = state.stationId,
  stationGeneration = state.stationRequestGeneration,
) {
  const track = state.tracks.find((item) => item.id === station?.track_id);
  if (
    !station ||
    !track ||
    !currentStationLease(station, stationId, stationGeneration)
  )
    return;
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
      valid: () =>
        currentStationLease(station, stationId, stationGeneration) &&
        Number(state.station?.revision || 0) === revision,
    });
    if (
      !currentStationLease(station, stationId, stationGeneration) ||
      Number(state.station?.revision || 0) !== revision ||
      audioController.generation !== generation
    )
      return;
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
  station.disliked = Boolean(track.disliked);
  station.like_count = Number(track.like_count || 0);
  station.dislike_count = Number(track.dislike_count || 0);
  station.skip_count = Number(track.skip_count || 0);
  return track;
}

async function applyStation(
  station,
  {
    requestStarted = null,
    receivedAt = performance.now(),
    authoritative = false,
  } = {},
) {
  const stationId = state.stationId;
  const stationGeneration = state.stationRequestGeneration;
  if (!station) return;
  if (station.station_id && station.station_id !== stationId) return;
  if (
    station.catalog_revision &&
    station.catalog_revision !== state.catalogRevision
  ) {
    await loadCatalog(true);
  }
  if (
    stationId !== state.stationId ||
    stationGeneration !== state.stationRequestGeneration ||
    (station.station_id && station.station_id !== state.stationId)
  )
    return;
  if (state.station?.station_id === station.station_id) {
    const incomingRevision = Number(station.revision || 0);
    const currentRevision = Number(state.station.revision || 0);
    const incomingTime = Number(station.server_time || 0);
    const currentTime = Number(state.station.server_time || 0);
    if (
      incomingRevision < currentRevision ||
      (!authoritative &&
        incomingRevision === currentRevision &&
        incomingTime <= currentTime)
    )
      return;
  }
  const serverTime = Number(station.server_time || 0);
  if (serverTime > 0 && requestStarted !== null) {
    const sample =
      (Number(requestStarted) + Number(receivedAt)) / 2 / 1000 - serverTime;
    if (Number.isFinite(sample)) {
      state.serverClockOffset =
        state.serverClockOffset === null
          ? sample
          : state.serverClockOffset * 0.75 + sample * 0.25;
    }
  }
  station.can_control = state.stationId === "main" || Boolean(state.ownerToken);
  state.station = station;
  els.radioRetry.hidden = true;
  state.stationReceivedAt =
    serverTime > 0 && Number.isFinite(state.serverClockOffset)
      ? serverTime + state.serverClockOffset
      : receivedAt / 1000;
  const track = mergeCurrentStats(station);
  if (track && state.current !== track) renderTrack(track);
  if (track && !audioController.owner && !state.radioStopped) {
    audioController.claim(
      "radio",
      mediaAudioURL(track),
      trackDisplayTitle(track),
      {
        stationId,
      },
    );
  }
  renderStation();
  publishStationView();
  await syncAudioToStation(station, stationId, stationGeneration);
}

async function refreshStation(force = false, required = false) {
  const stationId = state.stationId;
  const generation = state.stationRequestGeneration;
  if (
    state.stationRequestInFlight?.generation === generation &&
    state.stationRequestInFlight?.stationId === stationId
  ) {
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
      if (
        generation !== state.stationRequestGeneration ||
        stationId !== state.stationId
      )
        return;
      setConnected(true);
      await applyStation(station, {
        requestStarted,
        receivedAt,
        authoritative: force,
      });
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      if (
        generation !== state.stationRequestGeneration ||
        stationId !== state.stationId
      )
        return;
      state.streamConnected = false;
      state.eventSource?.close();
      state.eventSource = null;
      setConnected(false);
      window.clearTimeout(state.eventReconnectTimer);
      state.eventReconnectTimer = window.setTimeout(connectStationEvents, 500);
      if (error.status === 404 && state.stationId !== "main") {
        showToast("That station is no longer available.", {
          priority: 10,
          duration: 4000,
        });
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
    if (state.stationRequestInFlight === activeRequest)
      state.stationRequestInFlight = null;
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
    showToast("That station is no longer available.", {
      priority: 10,
      duration: 4000,
    });
    await switchStation("main", "");
  });
  source.onerror = () => {
    if (source !== state.eventSource) return;
    source.close();
    state.streamConnected = false;
    setConnected(state.connected);
    const delay = Math.min(30000, 500 * 2 ** state.eventReconnectAttempt++);
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
    if (generation !== state.controlGeneration || stationId !== state.stationId)
      return;
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
      if (
        generation !== state.controlGeneration ||
        stationId !== state.stationId
      )
        return;
      setConnected(true);
      await applyStation(station);
      return station;
    } catch (error) {
      if (
        generation !== state.controlGeneration ||
        stationId !== state.stationId
      )
        return;
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
        showToast(
          "The change could not be confirmed. Reconnecting to the station.",
        );
      }
      return null;
    }
  };
  state.controlQueue = state.controlQueue.catch(() => {}).then(execute);
  return state.controlQueue;
}

window.ZakStation = {
  current: stationView,
  async enqueue(action, trackID) {
    if (
      !["play_next", "add_to_queue"].includes(action) ||
      !trackID ||
      state.stationId === "main" ||
      !canControlStation()
    )
      return null;
    return postControl(action, { track_id: trackID });
  },
};

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
  router.syncLinks();
  publishStationView();
  connectStationEvents();
  const loaded = await refreshStation();
  if (!loaded && state.stationId === (stationId || "main")) {
    setStationUnavailable("Station unavailable");
  }
  return loaded;
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
  const needsLocalJoin =
    stationPlaying &&
    (!audioController.is("radio") ||
      els.audio.paused ||
      state.localRadioSuspended);
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
    // Resuming the station also ends this device's local pause.
    state.localRadioSuspended = false;
    state.radioInterrupted = false;
    audioController.reloadIfFailed();
    audioController.play();
  } else {
    els.audio.pause();
  }
  postControl(shouldPlay ? "play" : "pause");
}

function toggleRepeatOne() {
  const enabled = !state.station?.repeat_one;
  if (state.station) {
    state.station.repeat_one = enabled;
    renderStation();
  }
  postControl("set_repeat_one", { repeat_one: enabled });
  showToast(`Repeat ${enabled ? "on" : "off"}`);
}

function toggleShuffle() {
  const enabled = !state.station?.shuffle;
  if (state.station) {
    state.station.shuffle = enabled;
    renderStation();
  }
  postControl("set_shuffle", { shuffle: enabled });
  showToast(`Shuffle ${enabled ? "on" : "off"}`);
}

async function addReaction(reaction) {
  const track = currentTrack();
  if (!track) return;
  const trackID = track.id;
  const queueKey = `${trackID}:${reaction}`;
  const previous = state.likeQueues.get(queueKey) || Promise.resolve();
  const mutation = previous
    .catch(() => {})
    .then(async () => {
      try {
        const result = await api("/api/reaction", {
          method: "POST",
          body: { track_id: trackID, reaction },
        });
        applyTrackStats(result);
      } catch {
        showToast("Couldn’t update this track.");
      }
    });
  state.likeQueues.set(queueKey, mutation);
  await mutation;
  if (state.likeQueues.get(queueKey) === mutation)
    state.likeQueues.delete(queueKey);
}

function setStationUnavailable(message) {
  if (audioController.is("radio")) audioController.clear("radio");
  state.station = null;
  state.current = null;
  els.stationMode.textContent = "Station unavailable";
  els.stationAccess.textContent = "Retry to reconnect to this station.";
  setText(els.stationCapabilityLabel, "Radio unavailable");
  setText(
    els.stationCapabilityDetail,
    "Station state could not be loaded. The music archive and Reader recover separately.",
  );
  els.radioView.classList.remove("is-listen-only");
  els.title.textContent = message;
  els.details.textContent =
    "Station state could not be loaded. The music archive remains available.";
  lyrics.clear("Station content is unavailable.");
  els.stationStatus.textContent = "Station unavailable";
  [
    els.playPause,
    els.back10,
    els.forward10,
    els.prev,
    els.next,
    els.random,
    els.repeatOne,
    els.progress,
    els.like,
    els.dislike,
    els.createStation,
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
  router.syncLinks();
  state.ownerToken =
    stationId === "main"
      ? ""
      : window.ZakStorage.get(`zak-radio-owner:${stationId}`, "");
  try {
    await loadCatalog(forceCatalog);
    await loadStations();
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
      showToast(
        "That station link was invalid. Returned to the shared station.",
        { priority: 10, duration: 4000 },
      );
    }
    window.clearInterval(state.pollTimer);
    state.pollTimer = window.setInterval(refreshStation, 5000);
  } catch {
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
els.back10.addEventListener("click", () =>
  postControl("relative_seek", { position: -10 }),
);
els.forward10.addEventListener("click", () =>
  postControl("relative_seek", { position: 10 }),
);
els.prev.addEventListener("click", () => postControl("prev"));
els.next.addEventListener("click", requestNextTrack);
els.random.addEventListener("click", toggleShuffle);
els.repeatOne.addEventListener("click", toggleRepeatOne);
els.like.addEventListener("click", () => addReaction("like"));
els.dislike.addEventListener("click", () => addReaction("dislike"));
els.toggleDetails.addEventListener("click", () => {
  const expanded = els.toggleDetails.getAttribute("aria-expanded") !== "true";
  els.toggleDetails.setAttribute("aria-expanded", String(expanded));
  els.toggleDetails.textContent = expanded ? "Hide details" : "View details";
  els.promptPanel.hidden = !expanded;
  els.detailsPanels.classList.toggle("is-split", expanded);
  window.queueMicrotask(lyrics.updateOverflow);
});
els.createStation.addEventListener("click", () => {
  router.navigate("/library");
  window.dispatchEvent(new CustomEvent("zak-new-station"));
});
els.stationSelect.addEventListener("change", async () => {
  const stationId = els.stationSelect.value;
  const ownerToken =
    stationId === "main"
      ? ""
      : window.ZakStorage.get(`zak-radio-owner:${stationId}`, "");
  await switchStation(stationId, ownerToken);
});
els.stationRandomMode.addEventListener("change", (event) => {
  if (!event.target.matches('input[type="radio"]')) return;
  postControl("set_station_random_mode", {
    random_mode: radioGroupValue(els.stationRandomMode),
  });
});
els.stationSkipDisliked.addEventListener("change", () =>
  postControl("set_station_skip_disliked", {
    skip_disliked: els.stationSkipDisliked.checked,
  }),
);
els.addCurrentToStation.addEventListener("click", () => {
  const track = currentTrack();
  if (track) openAddToStation(track);
});
els.confirmAddToStation.addEventListener("click", async () => {
  if (!addToStationTrack || !els.addToStationSelect.value) return;
  els.confirmAddToStation.disabled = true;
  els.addToStationStatus.textContent = "Adding…";
  try {
    await updateSavedStation(els.addToStationSelect.value, {
      add_track_id: addToStationTrack.id,
    });
    els.addToStationDialog.close();
    showToast("Song added to station.");
  } catch (error) {
    els.addToStationStatus.textContent =
      error.detail || error.message || "Couldn’t update the station.";
  } finally {
    els.confirmAddToStation.disabled = false;
  }
});
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
els.returnLive.addEventListener("click", async () => {
  const restoreRadioFocus =
    router.path() === "/" && els.ownerBar.contains(document.activeElement);
  if (audioController.is("radio")) router.navigate("/");
  else await audioController.returnLive();
  if (restoreRadioFocus) {
    (els.playPause.disabled ? els.title : els.playPause).focus({
      preventScroll: true,
    });
  }
});
els.ownerPlayPause.addEventListener("click", async () => {
  if (audioController.is("radio")) {
    if (!els.audio.paused) {
      state.localRadioSuspended = true;
      audioController.pause();
      renderStation();
    } else if (state.station?.playing) {
      state.userActivatedAudio = true;
      state.localRadioSuspended = false;
      await syncAudioToStation();
    } else {
      router.navigate("/");
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
    audioController.pause();
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
els.audio.addEventListener("error", () => {
  updateNowPlayingMetadata();
  reportAudioError(els.audio.error);
  schedulePlaybackRecovery(750);
});
els.audio.addEventListener("play", () => {
  // Chromium resumes media itself when a transient audio-focus loss ends.
  // Follow the station again instead of pausing at the next sync.
  if (audioController.is("radio") && state.radioInterrupted) {
    state.radioInterrupted = false;
    state.localRadioSuspended = false;
  }
  dismissToast("audio-error");
  if (audioController.is("radio")) renderStation();
  updateNowPlayingMetadata();
  renderOwnerBar();
});
els.audio.addEventListener("pause", () => {
  // A source swap or track end is temporary. Any other pause the app did not
  // request (such as audio-focus loss) must not be undone by a station poll.
  if (
    audioController.is("radio") &&
    !audioController.transitioning &&
    !els.audio.ended &&
    radioShouldBeAudible()
  ) {
    state.localRadioSuspended = true;
    state.radioInterrupted = true;
  }
  if (audioController.is("radio")) renderStation();
  // At the end of a source, wait for the ended handlers to decide what's next.
  if (!els.audio.ended) updateNowPlayingMetadata();
  renderOwnerBar();
  if (radioShouldBeAudible()) schedulePlaybackRecovery(1500);
});
els.audio.addEventListener("playing", () => {
  clearPlaybackRecovery();
  updateNowPlayingMetadata();
});
els.audio.addEventListener("waiting", () => {
  updateNowPlayingMetadata();
  schedulePlaybackRecovery(2500);
});
els.audio.addEventListener("stalled", () => schedulePlaybackRecovery(1000));
async function handleMediaCommand(command) {
  if (command === "play") {
    if (!audioController.owner) {
      // Nothing owns the element after Stop; Play returns to the station.
      await togglePlayback();
    } else if (audioController.is("reader") && window.ZakReader?.play) {
      // ZakReader.play toggles, so a repeated Play must not pause Reader.
      if (els.audio.paused) await window.ZakReader.play();
    } else if (!audioController.is("radio")) {
      await audioController.play();
    } else if (state.station?.playing) {
      state.userActivatedAudio = true;
      state.localRadioSuspended = false;
      await syncAudioToStation();
    } else {
      await togglePlayback();
    }
  } else if (command === "pause") {
    if (audioController.is("radio") && state.station?.playing) {
      state.localRadioSuspended = true;
    }
    audioController.pause();
    updateNowPlayingMetadata();
  } else if (command === "stop") {
    // Stop silences every owner. Without radioStopped, the next station
    // update would see no owner and reclaim the element for Radio.
    state.radioStopped = true;
    state.localRadioSuspended = true;
    state.userActivatedAudio = false;
    // Reader saves its position before releasing the element.
    if (audioController.is("reader")) window.ZakReader?.stop?.();
    if (audioController.owner) audioController.clear(audioController.owner);
  }
}

window.addEventListener("zakstak-native-media-command", (event) => {
  const command = event.detail?.command;
  if (["play", "pause", "stop"].includes(command)) {
    void handleMediaCommand(command);
  }
});

if ("mediaSession" in navigator) {
  try {
    navigator.mediaSession.setActionHandler("play", () =>
      handleMediaCommand("play"),
    );
    navigator.mediaSession.setActionHandler("pause", () =>
      handleMediaCommand("pause"),
    );
    navigator.mediaSession.setActionHandler("seekbackward", (details) => {
      const offset = Number(details.seekOffset || 10);
      if (audioController.is("reader")) window.ZakReader?.seekBy?.(-offset);
      else if (audioController.is("radio")) {
        if (state.stationId !== "main" && canControlStation())
          postControl("relative_seek", { position: -offset });
      } else
        els.audio.currentTime = Math.max(
          0,
          (els.audio.currentTime || 0) - offset,
        );
    });
    navigator.mediaSession.setActionHandler("seekforward", (details) => {
      const offset = Number(details.seekOffset || 10);
      if (audioController.is("reader")) window.ZakReader?.seekBy?.(offset);
      else if (audioController.is("radio")) {
        if (state.stationId !== "main" && canControlStation())
          postControl("relative_seek", { position: offset });
      } else
        els.audio.currentTime = Math.min(
          els.audio.duration || Infinity,
          (els.audio.currentTime || 0) + offset,
        );
    });
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      const position = Number(details.seekTime || 0);
      if (audioController.is("reader")) window.ZakReader?.seekTo?.(position);
      else if (audioController.is("radio")) {
        if (state.stationId !== "main" && canControlStation())
          postControl("seek", { position });
      } else els.audio.currentTime = position;
    });
  } catch {}
}
window.addEventListener("zak-audio-owner", renderStation);
els.audio.addEventListener("timeupdate", () => {
  if (audioController.is("radio")) {
    if (
      !els.audio.paused &&
      !els.audio.seeking &&
      els.audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
    ) {
      clearPlaybackRecovery();
    }
    updateProgressFromAudio();
    lyrics.update();
  }
});
els.audio.addEventListener("loadedmetadata", () => {
  if (audioController.is("radio")) {
    updateProgressFromAudio();
    lyrics.refresh();
  }
});
els.audio.addEventListener("ended", () => {
  if (!audioController.is("radio")) {
    // Reader's own ended handler may start the next segment; publish after it.
    window.setTimeout(updateNowPlayingMetadata);
    return;
  }
  updateNowPlayingMetadata();
  // Track boundaries are server-authoritative. Every listener receives the
  // resulting revision through SSE; refresh immediately as a degraded-path
  // fallback when the stream is temporarily unavailable.
  schedulePlaybackRecovery(0);
});

window.addEventListener("online", () => schedulePlaybackRecovery(0));
window.addEventListener("pageshow", () => schedulePlaybackRecovery(0));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") schedulePlaybackRecovery(0);
});
els.progress.addEventListener("input", () => {
  state.syncingProgress = true;
  els.currentTime.textContent = timeLabel(els.progress.value);
  renderProgress(Number(els.progress.value), Number(els.progress.max));
});
els.progress.addEventListener("change", async () => {
  const position = Number(els.progress.value || 0);
  state.syncingProgress = false;
  if (state.stationId === "main") {
    updateProgressFromStation();
    return;
  }
  await postControl("seek", { position });
});

document.addEventListener("keydown", (event) => {
  const activeTag = document.activeElement?.tagName || "";
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(activeTag);
  const interactive = /^(BUTTON|A|SUMMARY)$/.test(activeTag);
  if (
    typing ||
    interactive ||
    router.path() !== "/" ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey
  )
    return;
  if (event.code === "Space") {
    if (els.playPause.disabled) return;
    event.preventDefault();
    togglePlayback();
  } else if (event.key === "ArrowLeft") {
    if (state.stationId === "main" || !canControlStation()) return;
    event.preventDefault();
    postControl("relative_seek", { position: -10 });
  } else if (event.key === "ArrowRight") {
    if (state.stationId === "main" || !canControlStation()) return;
    event.preventDefault();
    postControl("relative_seek", { position: 10 });
  }
});

router.render();
boot();
initLibrary();
initReader({ router });
window.setInterval(() => {
  if (
    router.path() === "/" &&
    (!audioController.is("radio") ||
      els.audio.paused ||
      state.localRadioSuspended)
  ) {
    updateProgressFromStation();
  }
}, 500);
