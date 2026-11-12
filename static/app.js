import { createAudioController } from "./audio.js";
import { createRouter } from "./router.js";
import { createLyricsView } from "./lyrics.js";
import {
  timeLabel,
  plural,
  stationSelection,
  setText,
  setAttribute,
  radioGroupValue,
  setRadioGroupValue,
} from "./format.js";
import { animateLayout, seekKeys } from "./motion.js";
import {
  createPlayer,
  createNotifier,
  createVolumeControl,
  createProgress,
  paintProgress,
  bindProgress,
  createReactionButton,
  PLAY_ICON,
  PAUSE_ICON,
  STOP_ICON,
} from "./player.js";
import { artworkFallback, paintArtworkFallback } from "./artwork.js";
import { failureSentence, problemCopy, problemKind } from "./problem.js";
import { initLibrary } from "./library.js";
import { initSongUpload } from "./song-upload.js";
import { initReader } from "./reader.js";

const randomBrowserHex = window.ZakRandomBrowserHex;

const state = {
  tracks: [],
  current: null,
  station: null,
  // "" while the station loads or is shown; otherwise why it is unavailable:
  // "offline" | "unreachable" | "server" | "notfound" | "empty".
  stationError: "",
  catalogError: null,
  connected: false,
  everConnected: false,
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
  reactionQueues: new Map(),
  // The reaction the server has accepted from this browser, per song, while
  // toggles are in flight. Local storage holds the latest intent instead.
  confirmedReactions: new Map(),
  invalidStationLink: false,
  stationCapacityRetryAt: 0,
  stationCreatePending: false,
  lastCapacityFailure: null,
  stations: [],
  titleExpanded: false,
  // A listen-only listener asked to start hearing a paused station as soon
  // as its owner resumes it.
  autoListen: false,
  // The big Listen button has scrolled out of view on Radio.
  transportOffscreen: false,
  artworkTint: "",
  // This device was listening when "Pause for everyone" was pressed, so
  // "Resume for everyone" brings its audio back too.
  resumeHere: false,
  // Why the latest request failed: "offline" (no network), "unreachable"
  // (no answer), or "server" (Zak Radio answered with an error).
  lastFailure: "",
  stationsFailed: false,
  connectedListeners: null,
  // What the current song's lyrics are: "loading", "timed", "plain",
  // "none", or "error". Desktop moves Up next beside the player when a song
  // has none.
  lyricsKind: "loading",
  // The song and play state the now-playing live region last announced.
  announcedNowPlaying: "",
};

const byId = (id) => document.getElementById(id);
const els = {
  skipToContent: byId("skipToContent"),
  shellContext: byId("shellContext"),
  connection: byId("connection"),
  connectionText: byId("connectionText"),
  radioView: byId("radioView"),
  stationSwitch: byId("stationSwitch"),
  stationSheet: byId("stationSheet"),
  stationSheetClose: byId("stationSheetClose"),
  stationOptions: byId("stationOptions"),
  stationAccess: byId("stationAccess"),
  stationMenu: byId("stationMenu"),
  editStation: byId("editStation"),
  shareStation: byId("shareStation"),
  endStation: byId("endStation"),
  createStation: byId("createStation"),
  shareFallback: byId("stationShareFallback"),
  shareLink: byId("stationShareLink"),
  shareClose: byId("stationShareClose"),
  nowPlaying: byId("nowPlaying"),
  coverSurface: byId("coverSurface"),
  cover: byId("cover"),
  emptyCover: byId("emptyCover"),
  stationStatus: byId("stationStatus"),
  livePulse: byId("livePulse"),
  liveStation: byId("liveStation"),
  title: byId("title"),
  titleToggle: byId("titleToggle"),
  source: byId("source"),
  details: byId("details"),
  radioErrorActions: byId("radioErrorActions"),
  radioRetry: byId("radioRetry"),
  radioMainStation: byId("radioMainStation"),
  nowPlayingAnnouncement: byId("nowPlayingAnnouncement"),
  stationProgress: byId("stationProgress"),
  progressTrack: byId("progressTrack"),
  currentTime: byId("currentTime"),
  duration: byId("duration"),
  progress: byId("progress"),
  progressFill: byId("progressFill"),
  progressThumb: byId("progressThumb"),
  playPause: byId("playPause"),
  playPauseLabel: byId("playPauseLabel"),
  playIcon: byId("playIcon"),
  pauseIcon: byId("pauseIcon"),
  listenNote: byId("listenNote"),
  listenAlternatives: byId("listenAlternatives"),
  listenMain: byId("listenMain"),
  like: byId("like"),
  likeCount: byId("likeCount"),
  dislike: byId("dislike"),
  dislikeCount: byId("dislikeCount"),
  addCurrentToStation: byId("addCurrentToStation"),
  download: byId("download"),
  stationControls: byId("stationControls"),
  stationControlsTitle: byId("stationControlsTitle"),
  stationControlsNote: byId("stationControlsNote"),
  stationSkipLabel: byId("stationSkipLabel"),
  stationListenOnly: byId("stationListenOnly"),
  stationListenOnlyNote: byId("stationListenOnlyNote"),
  stationPause: byId("stationPause"),
  stationPauseLabel: byId("stationPauseLabel"),
  stationPauseIcon: byId("stationPauseIcon"),
  next: byId("next"),
  temporaryTransport: byId("temporaryTransport"),
  temporaryModes: byId("temporaryModes"),
  prev: byId("prev"),
  back10: byId("back10"),
  forward10: byId("forward10"),
  random: byId("random"),
  repeatOne: byId("repeatOne"),
  transcript: byId("transcript"),
  lyrics: byId("lyrics"),
  lyricsViewport: byId("lyricsViewport"),
  lyricsFrame: byId("lyricsFrame"),
  lyricsFade: byId("lyricsFade"),
  lyricsMoreRow: byId("lyricsMoreRow"),
  toggleLyrics: byId("toggleLyrics"),
  lyricsFollow: byId("lyricsFollow"),
  lyricsSyncStatus: byId("lyricsSyncStatus"),
  toggleDetails: byId("toggleDetails"),
  promptPanel: byId("promptPanel"),
  promptTitle: byId("promptTitle"),
  promptClose: byId("promptClose"),
  trackFacts: byId("trackFacts"),
  trackStats: byId("trackStats"),
  songDetailsSheet: byId("songDetailsSheet"),
  songDetailsSheetBody: byId("songDetailsSheetBody"),
  radioSide: byId("radioSide"),
  radioSecondary: byId("radioSecondary"),
  lyricsOpen: byId("lyricsOpen"),
  lyricsLegend: byId("lyricsLegend"),
  lyricsContext: byId("lyricsContext"),
  lyricsSheet: byId("lyricsSheet"),
  lyricsSheetClose: byId("lyricsSheetClose"),
  lyricsSheetArt: byId("lyricsSheetArt"),
  lyricsSheetTitle: byId("lyricsSheetTitle"),
  lyricsSheetMeta: byId("lyricsSheetMeta"),
  lyricsSheetToggle: byId("lyricsSheetToggle"),
  lyricsSheetSlot: byId("lyricsSheetSlot"),
  transcriptHead: document.querySelector("#transcript .transcript-head"),
  prompt: byId("prompt"),
  promptMeta: byId("promptMeta"),
  promptMetaList: byId("promptMetaList"),
  radioVolume: byId("radioVolume"),
  radioQueue: byId("radioQueue"),
  radioQueueTitle: byId("radioQueueTitle"),
  radioQueueSummary: byId("radioQueueSummary"),
  radioQueueTracks: byId("radioQueueTracks"),
  radioOwnerControls: byId("radioOwnerControls"),
  radioOwnerControlsSummary: byId("radioOwnerControlsSummary"),
  radioProgramming: byId("radioProgramming"),
  radioProgrammingNote: byId("radioProgrammingNote"),
  radioSettingsReadOnly: byId("radioSettingsReadOnly"),
  radioSettingsOrder: byId("radioSettingsOrder"),
  radioSettingsSkip: byId("radioSettingsSkip"),
  stationRandomMode: byId("stationRandomMode"),
  stationSkipDisliked: byId("stationSkipDisliked"),
  addToStationDialog: byId("addToStationDialog"),
  addToStationTrack: byId("addToStationTrack"),
  addToStationList: byId("addToStationList"),
  addToStationStatus: byId("addToStationStatus"),
  addToStationNew: byId("addToStationNew"),
  audio: byId("audio"),
  player: byId("player"),
  snackbarHost: byId("toast"),
  notifyAnnouncer: byId("notifyAnnouncer"),
};

const api = window.ZakAPI;
// Desktop gives Radio a side column for lyrics, details, and Up next.
const desktop = window.matchMedia("(min-width: 768px) and (min-height: 501px)");
const notify = createNotifier({
  host: els.snackbarHost,
  announcer: els.notifyAnnouncer,
});
window.ZakNotify = notify;
window.addEventListener("online", () => notify.online());

// A change that didn't go through, in the shared words, with Try again. A
// connection failure is restated once the connection is back.
function notifyFailure(
  error,
  outcome = "that change didn’t go through",
  retry = null,
) {
  const action = retry ? { label: "Try again", run: retry } : null;
  const connection = ["offline", "unreachable"].includes(problemKind(error));
  return notify(failureSentence(error, outcome), {
    tone: "error",
    action,
    reconnect: connection
      ? {
          message: `Back online. ${outcome.charAt(0).toLocaleUpperCase()}${outcome.slice(1)}.`,
          action,
        }
      : null,
  });
}
let audioErrorNotice = null;
let player = null;

function setRadioGroupDisabled(group, disabled) {
  group.querySelectorAll('input[type="radio"]').forEach((input) => {
    input.disabled = disabled;
  });
}

function skeleton(text, className = "skeleton-line") {
  const span = document.createElement("span");
  span.className = `skeleton ${className}`;
  span.textContent = text;
  return span;
}

function fileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 0.1 * 1024 * 1024) {
    return n < 1024 ? "<1 KB" : `${Math.max(1, Math.round(n / 1024))} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
window.ZakFormatBytes = (bytes) => fileSize(bytes) || "Audio";

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

// The neutral tile for a station that isn't available; songs without
// artwork get a tile of their own (artwork.js).
const ARTWORK_ICON = `
    <svg class="no-artwork-icon" viewBox="0 0 96 96">
      <rect x="18" y="39" width="10" height="18" rx="5"></rect>
      <rect x="34" y="25" width="10" height="46" rx="5"></rect>
      <rect x="50" y="16" width="10" height="64" rx="5"></rect>
      <rect x="66" y="31" width="10" height="34" rx="5"></rect>
    </svg>`;

function createArtworkFallback(track) {
  return artworkFallback(track?.id || track?.title || "");
}

window.ZakTrackDisplayTitle = trackDisplayTitle;
window.ZakTrackDisplayGroup = trackDisplayGroup;
window.ZakArtworkFallback = createArtworkFallback;

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
  onOwnerChange: audioOwnerChanged,
  onPlaybackChange: updateNowPlayingMetadata,
  onError: reportAudioError,
});
window.ZakAudio = audioController;

async function returnLiveRadio(sync = true) {
  const track = state.station ? currentTrack() : null;
  if (!track) {
    notify("Radio isn’t available right now. Try again in a moment.", {
      tone: "error",
    });
    player?.update();
    return false;
  }
  state.userActivatedAudio = true;
  state.radioStopped = false;
  state.localRadioSuspended = false;
  // Whether the previous owner was audible, so it can say it was paused.
  const wasPlaying = !els.audio.paused;
  els.audio.pause();
  window.dispatchEvent(
    new CustomEvent("zak-audio-release", {
      detail: {
        owner: audioController.owner,
        nextOwner: "radio",
        position: els.audio.currentTime || 0,
        playing: wasPlaying,
        generation: audioController.generation,
      },
    }),
  );
  audioController.claim(
    "radio",
    mediaAudioURL(track),
    trackDisplayTitle(track),
    {
      stationId: state.stationId,
    },
  );
  if (sync) await syncAudioToStation();
  return true;
}

const router = createRouter({
  els: {
    skipToContent: els.skipToContent,
    title: els.title,
  },
  stationId: () => state.stationId,
  selectedReaderId: () => window.ZakReader?.selectedId?.(),
  onRender: (path) => {
    player?.update();
    updateShellContext();
    updateNowPlayingMetadata();
    renderStation();
    if (path === "/" && state.current) lyrics.load(state.current);
    if (path === "/") announceNowPlaying();
  },
  onHistory: () => {
    // Only Radio's address says which station is on. Back and Forward
    // between stations tune the same way choosing one does.
    if (window.location.pathname !== "/") return;
    const stationId = requestedStation();
    if (stationId !== state.stationId)
      void tuneTo(stationId, { fromHistory: true });
  },
});

window.ZakRouter = router;

player = createPlayer({
  root: els.player,
  audio: els.audio,
  owner: () => audioController.owner,
  routePath: () => router.path(),
  navigate: (path) => router.navigate(path),
  liveAvailable: () => Boolean(state.station?.playing),
  listenLive: () => listenLive(),
  // On Radio the docked player appears once the main controls scroll away.
  radioDocked: () => router.path() === "/" && state.transportOffscreen,
});
window.ZakPlayer = player;

function audioOwnerChanged() {
  player?.update();
  syncMediaSessionActions();
}

function radioHearing() {
  return (
    audioController.is("radio") &&
    !els.audio.paused &&
    !state.localRadioSuspended
  );
}

function radioHref() {
  return state.stationId === "main"
    ? "/"
    : `/?station=${encodeURIComponent(state.stationId)}`;
}

function radioPosition() {
  if (!state.station) return 0;
  return radioHearing()
    ? Number(els.audio.currentTime || 0)
    : estimatedStationPosition(state.station);
}

// The mini-player shows Radio when it owns the audio away from the Radio view,
// once this listener has chosen to listen. On Radio itself it stands in for
// the main controls after they scroll out of view. Its play control does what
// the big button does, so a paused station you control starts in one tap.
const radioAdapter = {
  describe() {
    const track = currentTrack();
    const onRadio = router.path() === "/";
    if (!track) return null;
    if (!onRadio && (!state.userActivatedAudio || state.radioStopped))
      return null;
    const station = state.station;
    const hearing = radioHearing();
    const live = Boolean(station?.playing);
    const lost = connectionLost();
    const control = canControlStation();
    const empty = emptyStation();
    const shared = station && control && !empty && !lost;
    const action = listenerAction();
    return {
      kind: "live",
      source: "Radio",
      context: stationLabel(),
      title: trackDisplayTitle(track),
      subtitle: [track.artist, trackDisplayGroup(track)]
        .filter(Boolean)
        .join(" · "),
      reactions: station && !lost ? reactionView(track) : null,
      href: radioHref(),
      artwork: track.has_cover
        ? { src: mediaCoverURL(track), seed: track.id }
        : { seed: track.id },
      playing: hearing,
      toggleLabel: action.label,
      toggleIcon: action.icon,
      disabled: action.disabled,
      note:
        !station || lost
          ? hearing
            ? "Replaying this song until Zak Radio reconnects"
            : "Reconnecting…"
          : live
            ? ""
            : control
              ? stationKind() === "main"
                ? "Paused for everyone"
                : "Station paused"
              : "Paused by its owner",
      position: radioPosition(),
      duration: durationOf(track),
      seekable: seekableStation() && !lost,
      skip: seekableStation() && !lost,
      rate: null,
      follow: null,
      // The dock stays about playback; the full player has the song's own
      // actions, as Radio does.
      download: {
        href: mediaAudioURL(track),
        filename: `${trackDisplayTitle(track) || track.id}.mp3`,
        sheetOnly: true,
      },
      lyrics: ["timed", "plain"].includes(state.lyricsKind),
      queue: Boolean(station) && !empty,
      stationPause: shared
        ? {
            label: live ? pauseLabel() : resumeLabel(),
            icon: live ? PAUSE_ICON : PLAY_ICON,
            run: toggleStationForEveryone,
          }
        : null,
      stationScope: stationScope(),
      stationAction: shared
        ? { label: skipLabel(), run: () => skipForEveryone() }
        : null,
    };
  },
  async toggle() {
    await primaryAction();
  },
  seekTo(position) {
    if (seekableStation()) return seekStation(position);
    return undefined;
  },
  seekBy(offset) {
    if (seekableStation()) return seekStationBy(offset);
    return undefined;
  },
  openLyrics(opener) {
    openLyricsSheet(opener);
  },
  openQueue() {
    showQueue();
  },
};
player.register("radio", radioAdapter);

// Up next on Radio: the full player's Up next goes there from anywhere.
function showQueue() {
  const reveal = () => {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
    els.radioQueue.scrollIntoView({
      block: "start",
      behavior: calm.matches ? "auto" : "smooth",
    });
    els.radioQueueTitle.focus({ preventScroll: true });
  };
  if (router.path() === "/") {
    reveal();
    return;
  }
  router.navigate(radioHref());
  // After the router restores the view's place and focus.
  window.requestAnimationFrame(() => window.requestAnimationFrame(reveal));
}

function stopListening() {
  state.localRadioSuspended = true;
  audioController.pause();
  renderStation();
}

async function listenLive() {
  if (!state.station?.playing) return false;
  state.userActivatedAudio = true;
  state.localPlaybackBlocked = false;
  state.localRadioSuspended = false;
  state.radioStopped = false;
  if (!audioController.is("radio")) {
    const claimed = await audioController.returnLive(false);
    if (!claimed) return false;
  }
  audioController.reloadIfFailed();
  try {
    els.audio.currentTime = estimatedStationPosition(state.station);
  } catch {}
  const played = await audioController.play();
  state.localPlaybackBlocked = !played;
  renderStation();
  return played;
}

const STATION_PATTERN = /^[a-f0-9]{12}(?:[a-f0-9]{20})?$/;
const SESSION_STATION = "zak-radio-station";

// Only Radio's address names the station. Library and Reader keep to their
// own concerns; the station this tab was tuned to carries over through them.
function rememberStation(stationId) {
  try {
    if (stationId === "main") window.sessionStorage.removeItem(SESSION_STATION);
    else window.sessionStorage.setItem(SESSION_STATION, stationId);
  } catch {}
}

function sessionStation() {
  try {
    const value = window.sessionStorage.getItem(SESSION_STATION) || "";
    return STATION_PATTERN.test(value) ? value : "";
  } catch {
    return "";
  }
}

function requestedStation() {
  let requested = new URLSearchParams(window.location.search).get("station");
  if (window.location.pathname !== "/") {
    // An older Library or Reader link may still carry it.
    if (requested) {
      const url = new URL(window.location.href);
      url.searchParams.delete("station");
      window.history.replaceState(window.history.state || {}, "", url);
    } else {
      requested = sessionStation();
    }
  }
  if (!requested) return "main";
  if (STATION_PATTERN.test(requested)) return requested;
  const url = new URL(window.location.href);
  url.searchParams.delete("station");
  window.history.replaceState(window.history.state || {}, "", url);
  state.invalidStationLink = true;
  return "main";
}

function ownerTokenFor(stationId) {
  return stationId === "main"
    ? ""
    : window.ZakStorage.get(`zak-radio-owner:${stationId}`, "");
}

function updateShellContext() {
  const path = router.path();
  els.shellContext.textContent =
    path === "/library"
      ? "Original music archive"
      : path === "/reader"
        ? "Source reading room"
        : path === "/404"
          ? "Page not found"
          : state.tracks.length
            ? plural(state.tracks.length, "song")
            : "Shared listening";
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
      if (!tracks.length) {
        const error = new Error("The archive has no playable tracks.");
        error.code = "empty";
        throw error;
      }
      state.catalogError = null;
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
    state.catalogError ||
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
  if (state.station) mergeCurrentStats(state.station);
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
    audioErrorNotice = notify(
      "This browser blocked audio. Press Listen live or Play to start it.",
    );
  } else {
    audioErrorNotice = notify(
      "This audio couldn’t play. Check your connection and try again.",
      {
        tone: "error",
        action: {
          label: "Try again",
          run: () => {
            if (audioController.is("reader")) window.ZakReader?.retryAudio();
            else if (audioController.is("radio")) listenLive();
            else if (audioController.owner) audioController.play();
          },
        },
      },
    );
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

function trackById(trackId) {
  return state.tracks.find((track) => track.id === trackId) || null;
}

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
      !station.built_in && Boolean(ownerTokenFor(station.station_id)),
  );
}

function stationKind(stationId = state.stationId) {
  if (stationId === "main") return "main";
  if (state.station?.station_id === stationId)
    return state.station.saved ? "saved" : "temporary";
  return stationDefinition(stationId) ? "saved" : "temporary";
}

function stationLabel(stationId = state.stationId) {
  if (stationId === "main") return "All songs";
  const definition = stationDefinition(stationId);
  if (definition?.name) return definition.name;
  if (state.station?.station_id === stationId && state.station.station_name)
    return state.station.station_name;
  return stationKind(stationId) === "temporary"
    ? "Temporary station"
    : "Station";
}

function canControlStation() {
  return (
    Boolean(state.station) &&
    (state.stationId === "main" || Boolean(state.station.can_control))
  );
}

function emptyStation() {
  return (
    Boolean(state.station?.saved) && Number(state.station?.eligible || 0) === 0
  );
}

// Stations load on their own: a slow or failing song list never holds
// them back, and their failure has its own message in Library.
async function loadStations() {
  let result;
  try {
    result = await api("/api/stations");
  } catch (error) {
    state.stationsFailed = true;
    window.dispatchEvent(
      new CustomEvent("zak-stations-failed", { detail: error }),
    );
    throw error;
  }
  state.stationsFailed = false;
  state.stations = Array.isArray(result.stations) ? result.stations : [];
  renderStationPicker();
  renderStationPanel();
  window.dispatchEvent(
    new CustomEvent("zak-stations", { detail: state.stations }),
  );
  return state.stations;
}

function stationOptionButton({ id, name, meta }) {
  const option = document.createElement("button");
  option.type = "button";
  option.className = "station-option";
  option.dataset.stationId = id;
  const current = id === state.stationId;
  option.setAttribute("aria-current", String(current));
  const copy = document.createElement("span");
  copy.className = "station-option-copy";
  const title = document.createElement("span");
  title.className = "station-option-name";
  title.textContent = name;
  copy.append(title);
  if (meta) {
    const note = document.createElement("span");
    note.className = "station-option-meta";
    note.textContent = meta;
    copy.append(note);
  }
  option.append(copy);
  const check = document.createElement("span");
  check.className = "station-option-check";
  check.setAttribute("aria-hidden", "true");
  check.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"></path></svg>';
  option.append(check);
  // The name is set from the same words: visually hidden text would be read
  // with a stray space before its comma ("…pause or skip , playing now").
  option.setAttribute(
    "aria-label",
    [name, meta, current ? "playing now" : ""].filter(Boolean).join(", "),
  );
  return option;
}

// The station sheet lists every station this browser can tune to: All songs,
// the stations it can edit, other saved stations, and the temporary station
// it is on.
function renderStationPicker() {
  const saved = state.stations.filter((station) => !station.built_in);
  const builtIn = state.stations.find((station) => station.built_in);
  const groups = [
    {
      label: "",
      items: [
        {
          id: "main",
          name: builtIn?.name || "All songs",
          meta: "Everyone’s station · anyone listening can pause or skip",
        },
      ],
    },
  ];
  const describe = (station, owned) =>
    [stationSelection(station), owned ? "you can edit it" : "listen-only"].join(
      " · ",
    );
  const mine = saved.filter((station) => ownerTokenFor(station.station_id));
  const others = saved.filter((station) => !ownerTokenFor(station.station_id));
  if (mine.length)
    groups.push({
      label: "Your stations",
      items: mine.map((station) => ({
        id: station.station_id,
        name: station.name,
        meta: describe(station, true),
      })),
    });
  if (others.length)
    groups.push({
      label: "Other stations",
      items: others.map((station) => ({
        id: station.station_id,
        name: station.name,
        meta: describe(station, false),
      })),
    });
  if (
    state.stationId !== "main" &&
    !state.stations.some((station) => station.station_id === state.stationId)
  ) {
    const owned = Boolean(ownerTokenFor(state.stationId));
    groups.push({
      label: "Temporary",
      items: [
        {
          id: state.stationId,
          name: owned
            ? "Your temporary station"
            : "Someone’s temporary station",
          // When it ends is said once, in the note below the list.
          meta: owned ? "Access saved in this browser or app" : "Listen-only",
        },
      ],
    });
  }
  const focusedId = els.stationOptions.contains(document.activeElement)
    ? document.activeElement.dataset.stationId
    : "";
  els.stationOptions.replaceChildren(
    ...groups.map((group, index) => {
      const section = document.createElement("div");
      section.className = "station-option-group";
      section.setAttribute("role", "group");
      const headingId = `station-options-${index}`;
      if (group.label) {
        const heading = document.createElement("p");
        heading.id = headingId;
        heading.className = "section-label station-option-label";
        heading.textContent = group.label;
        section.append(heading);
        section.setAttribute("aria-labelledby", headingId);
      } else {
        section.setAttribute("aria-label", "Main station");
      }
      section.append(...group.items.map(stationOptionButton));
      return section;
    }),
  );
  if (state.stationsFailed) {
    const note = document.createElement("p");
    note.className = "field-hint";
    note.textContent = "Your stations will appear when Zak Radio reconnects.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button";
    retry.textContent = "Try again";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try {
        await reloadStations();
      } catch {
        /* The reconnect note stays visible. */
      }
      renderStationPicker();
    });
    els.stationOptions.append(note, retry);
  }
  if (focusedId)
    els.stationOptions
      .querySelector(`[data-station-id="${CSS.escape(focusedId)}"]`)
      ?.focus({ preventScroll: true });
}

async function updateSavedStation(stationId, changes) {
  const ownerToken = ownerTokenFor(stationId);
  if (!ownerToken) {
    const error = new Error("listen-only");
    error.status = 403;
    throw error;
  }
  const result = await api(`/api/stations/${encodeURIComponent(stationId)}`, {
    method: "PATCH",
    body: { owner_token: ownerToken, ...changes },
  });
  await loadStations();
  return result.station;
}

// ---- Add to station (shared by Radio and Library) ----
let addToStationTrack = null;
let addToStationOpener = null;

function listStationsForAdding() {
  return ownedSavedStations();
}

function stationHasTrack(station, trackId) {
  return (
    Array.isArray(station?.track_ids) && station.track_ids.includes(trackId)
  );
}

// The dialog lists every hand-picked station this browser can change, with
// a check on those that already have the song. A change takes effect at
// once and can be undone from its notification.
function openAddToStation(track, opener = document.activeElement) {
  const stations = listStationsForAdding();
  if (!stations.length) {
    window.dispatchEvent(
      new CustomEvent("zak-new-list-station", { detail: { track, opener } }),
    );
    return false;
  }
  addToStationTrack = track;
  addToStationOpener = opener;
  addToStationChange = null;
  els.addToStationTrack.textContent = `“${trackDisplayTitle(track)}”`;
  els.addToStationStatus.textContent = "";
  renderAddToStationRows();
  els.addToStationDialog.showModal();
  (
    els.addToStationList.querySelector("input:not(:checked):not(:disabled)") ||
    els.addToStationList.querySelector("input:not(:disabled)") ||
    els.addToStationNew
  ).focus();
  return true;
}

const addToStationPending = new Map();
// The latest change made in the open dialog, confirmed with Undo once it
// closes; while it is open, the dialog says so itself, so nothing covers it.
let addToStationChange = null;

function membershipWords(change, undone = false) {
  const title = trackDisplayTitle(change.track);
  const station = stationDefinition(change.stationId);
  const name = station?.name || change.name;
  if (undone)
    return change.add
      ? `Removed “${title}” from “${name}”.`
      : `“${title}” is back in “${name}”.`;
  return change.add
    ? `Added “${title}” to “${name}”.`
    : `Removed “${title}” from “${name}”.`;
}

function undoMembership(change) {
  return setStationMembership(change.stationId, change.track, !change.add, {
    undo: true,
  });
}

function showAddToStationStatus(message, change = null) {
  const parts = [message];
  if (change) {
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "button-quiet sheet-status-action";
    undo.textContent = "Undo";
    undo.addEventListener("click", () => {
      addToStationChange = null;
      void undoMembership(change);
    });
    parts.push(" ", undo);
  }
  els.addToStationStatus.replaceChildren(...parts);
}

function renderAddToStationRows() {
  const track = addToStationTrack;
  if (!track) return;
  const existing = new Map(
    [...els.addToStationList.children].map((item) => [
      item.querySelector("input").dataset.stationId,
      item,
    ]),
  );
  const rows = listStationsForAdding().map((station) => {
    let item = existing.get(station.station_id);
    if (!item) {
      item = document.createElement("li");
      item.innerHTML =
        '<label class="add-station-row"><input type="checkbox" class="add-station-check"><span class="add-station-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5.5 12.5 4 4 9-9"></path></svg></span><span class="add-station-name"></span><span class="add-station-meta tabular"></span></label>';
    }
    const input = item.querySelector("input");
    const pending =
      addToStationPending.get(station.station_id)?.trackId === track.id;
    input.dataset.stationId = station.station_id;
    input.checked = pending
      ? addToStationPending.get(station.station_id).add
      : stationHasTrack(station, track.id);
    input.disabled = station.source_type !== "list" || connectionLost();
    input.setAttribute("aria-disabled", String(pending || input.disabled));
    input.setAttribute("aria-busy", String(pending));
    item.querySelector(".add-station-name").textContent = station.name;
    item.querySelector(".add-station-meta").textContent =
      station.source_type !== "list"
        ? stationSelection(station)
        : pending
          ? "Saving…"
          : plural(station.track_ids?.length || 0, "song");
    return item;
  });
  els.addToStationNew.disabled = connectionLost();
  for (const item of els.addToStationList.querySelectorAll(":scope > li"))
    if (!rows.includes(item)) item.remove();
  rows.forEach((item, index) => {
    if (els.addToStationList.children[index] !== item)
      els.addToStationList.insertBefore(
        item,
        els.addToStationList.children[index] || null,
      );
  });
}

// Adds the song to a station or takes it out again. Undo reverses only that
// change.
async function setStationMembership(
  stationId,
  track,
  add,
  { undo = false } = {},
) {
  const station = stationDefinition(stationId);
  if (!station || !track) return false;
  if (addToStationPending.has(stationId)) {
    renderAddToStationRows();
    return false;
  }
  if (stationHasTrack(station, track.id) === add) return true;
  addToStationPending.set(stationId, { trackId: track.id, add });
  renderAddToStationRows();
  try {
    await updateSavedStation(
      stationId,
      add ? { add_track_id: track.id } : { remove_track_id: track.id },
    );
  } catch (error) {
    addToStationPending.delete(stationId);
    renderAddToStationRows();
    const outcome = add ? "the song wasn’t added" : "the song wasn’t removed";
    const message =
      error.status === 403
        ? "This device can’t change that station anymore."
        : failureSentence(error, outcome);
    if (els.addToStationDialog.open)
      els.addToStationStatus.textContent = message;
    else notify(message, { tone: "error" });
    return false;
  }
  addToStationPending.delete(stationId);
  renderAddToStationRows();
  const change = { stationId, track, add, name: station.name };
  const open = els.addToStationDialog.open && addToStationTrack === track;
  if (undo) {
    const words = membershipWords({ ...change, add: !add }, true);
    if (open) showAddToStationStatus(words);
    else notify(words);
  } else if (open) {
    addToStationChange = change;
    showAddToStationStatus(membershipWords(change), change);
  } else {
    notify(membershipWords(change), {
      action: { label: "Undo", run: () => undoMembership(change) },
    });
  }
  return true;
}

window.ZakStations = {
  list: () => state.stations.map((station) => ({ ...station })),
  owned: () => ownedSavedStations().map((station) => ({ ...station })),
  reload: loadStations,
  update: updateSavedStation,
  addTrack: openAddToStation,
  listenLink,
  copyListenLink,
  get failed() {
    return state.stationsFailed;
  },
};

function stationView() {
  const known = Boolean(state.station);
  const kind = stationKind();
  return {
    known,
    connected: state.connected,
    stationId: state.stationId,
    kind,
    label: stationLabel(),
    canControl: known && canControlStation(),
    supportsQueue: known && kind === "temporary",
    saved: kind !== "temporary",
    queue:
      known && Array.isArray(state.station.queue)
        ? [...state.station.queue]
        : [],
    // What's on and what comes next, for Library's On Radio panel.
    trackId: known ? String(state.station.track_id || "") : "",
    playing: known && Boolean(state.station.playing),
    upNext: !known
      ? []
      : kind === "temporary"
        ? [...(state.station.queue || [])]
        : state.station.random_mode === "true_random"
          ? []
          : [...(state.station.up_next || [])],
  };
}

function publishStationView() {
  window.dispatchEvent(
    new CustomEvent("zak-station", { detail: stationView() }),
  );
}

// ---- Connection indicator ----
// The header and now playing use the same words for the same state, and the
// dot and the words always change together. "Offline" means this device has
// no network; a server that answers with errors is "having trouble".
const CONNECTION = {
  connecting: ["Connecting…", "Connecting to the station."],
  connected: ["Connected", "Station changes arrive as they happen."],
  // Live updates dropped, but the station still refreshes every few seconds,
  // so everything on screen is current.
  degraded: [
    "Connected",
    "Live updates paused. The station refreshes every few seconds instead.",
  ],
  lost: [
    "Reconnecting…",
    "Can’t reach Zak Radio right now. Station controls return when it’s back.",
  ],
  trouble: [
    "Having trouble",
    "Your connection is fine, but Zak Radio is having trouble. Retrying in the background.",
  ],
  unreachable: [
    "Can’t connect",
    "Your device is online, but Zak Radio isn’t answering. Retrying in the background.",
  ],
  offline: [
    "Offline",
    "This device has no network connection. Radio reconnects when you’re back online.",
  ],
};

// Zak Radio was reachable and the station is on screen, but the latest
// requests failed: what's shown may be out of date.
function connectionLost() {
  return (
    Boolean(state.station) &&
    !state.stationError &&
    !state.connected &&
    state.everConnected
  );
}

// Why requests fail, in the listener's terms.
function failureMode(kind) {
  if (navigator.onLine === false || kind === "offline") return "offline";
  if (kind === "server") return "trouble";
  if (kind === "unreachable") return "unreachable";
  return "";
}

function connectionMode() {
  // Catalog errors preserve the station; station failures clear it.
  if (state.stationError && !state.station) {
    if (state.stationError === "empty" || state.stationError === "notfound")
      return state.connected ? "connected" : "connecting";
    return failureMode(state.stationError) || "unreachable";
  }
  if (connectionLost()) {
    const mode = failureMode(state.lastFailure);
    return mode === "offline" || mode === "trouble" ? mode : "lost";
  }
  if (state.streamConnected) return "connected";
  if (state.connected) return "degraded";
  if (state.everConnected) return failureMode(state.lastFailure) || "lost";
  return "connecting";
}

function renderConnection() {
  const mode = connectionMode();
  els.connection.dataset.state = mode;
  setText(els.connectionText, CONNECTION[mode][0]);
  els.connection.title = CONNECTION[mode][1];
  if (els.addToStationDialog.open) renderAddToStationRows();
  window.dispatchEvent(
    new CustomEvent("zak-connection", {
      detail: { connected: state.connected, message: CONNECTION[mode][1] },
    }),
  );
}

function setConnected(connected, error = null) {
  const changed = state.connected !== connected;
  state.connected = connected;
  if (connected) {
    state.everConnected = true;
    state.lastFailure = "";
    // A change that failed while the connection was down says so again,
    // now that it can be tried.
    if (changed) notify.online();
  } else if (error) {
    state.lastFailure = failureKind(error);
  }
  // Every status and shared control follows the connection at once.
  if (changed && state.station) renderStation();
  else {
    renderConnection();
    renderStatus();
  }
}

const lyricsSheetProgress = createProgress("lyrics-sheet-progress");
byId("lyricsSheetProgress").append(lyricsSheetProgress.row);
const lyricsSheetLike = createReactionButton("like");
const lyricsSheetDislike = createReactionButton("dislike");
byId("lyricsSheetReactions").append(lyricsSheetLike, lyricsSheetDislike);
const lyricsSheetShared = byId("lyricsSheetShared");
const lyricsSheetPause = byId("lyricsSheetPause");
const lyricsSheetSkip = byId("lyricsSheetSkip");
lyricsSheetPause.addEventListener("click", () => toggleStationForEveryone());
lyricsSheetSkip.addEventListener("click", () => skipForEveryone());
bindProgress(
  lyricsSheetProgress,
  () => ({
    duration: durationOf(currentTrack()),
    position: radioPosition(),
    seekable: seekableStation(),
  }),
  seekStation,
);

// ---- Radio rendering ----
function resetNowPlaying() {
  state.current = null;
  state.titleExpanded = false;
  els.cover.removeAttribute("src");
  els.cover.classList.add("hidden");
  els.emptyCover.classList.add("hidden");
  els.emptyCover.classList.remove("grid");
  els.download.removeAttribute("href");
  els.download.setAttribute("aria-disabled", "true");
  els.trackFacts.replaceChildren();
  delete els.trackFacts.dataset.key;
  els.titleToggle.hidden = true;
  els.title.classList.remove("is-clamped");
  renderProgress(0, 0);
}

function setStationLoading() {
  if (audioController.is("radio")) {
    audioController.clear("radio");
    state.localRadioSuspended = false;
  }
  state.station = null;
  state.stationError = "";
  resetNowPlaying();
  els.radioView.dataset.state = "loading";
  els.coverSurface.classList.add("skeleton");
  els.title.replaceChildren(skeleton("Loading station", "skeleton-title"));
  const sourceSkeleton = skeleton("Artist");
  sourceSkeleton.setAttribute("aria-hidden", "true");
  els.source.replaceChildren(sourceSkeleton);
  els.source.hidden = false;
  els.details.textContent = "";
  els.radioErrorActions.hidden = true;
  lyrics.clear("", { loading: true });
  renderStation();
  publishStationView();
}

// Connection failures read the same in every view (problem.js); the rest
// are Radio's own.
const UNAVAILABLE = {
  offline: [problemCopy("offline").title, problemCopy("offline").text],
  unreachable: [
    problemCopy("unreachable").title,
    problemCopy("unreachable").text,
  ],
  server: [problemCopy("server").title, problemCopy("server").text],
  notfound: [
    "This station isn’t available anymore",
    "It may have ended or been deleted. All songs is still playing.",
  ],
  empty: [
    "There’s nothing to play yet",
    "The music archive has no playable songs. Add music, then try again.",
  ],
};

function failureKind(error) {
  if (error?.code === "empty") return "empty";
  const kind = problemKind(error);
  return kind === "busy" ? "server" : kind;
}

function setStationUnavailable(kind = "unreachable", { catalog = false } = {}) {
  if (audioController.is("radio")) audioController.clear("radio");
  if (!catalog) state.station = null;
  state.stationError = UNAVAILABLE[kind] ? kind : "unreachable";
  if (
    !catalog &&
    ["offline", "unreachable", "server"].includes(state.stationError)
  )
    state.lastFailure = state.stationError;
  resetNowPlaying();
  const [title, detail] = UNAVAILABLE[state.stationError];
  els.radioView.dataset.state = "error";
  els.coverSurface.classList.remove("skeleton");
  delete els.emptyCover.dataset.seed;
  els.emptyCover.classList.remove("has-art-seed");
  els.emptyCover.style.removeProperty("--art-h");
  els.emptyCover.style.removeProperty("--art-h2");
  els.emptyCover.innerHTML = ARTWORK_ICON;
  els.emptyCover.classList.remove("hidden");
  els.emptyCover.classList.add("grid");
  els.title.textContent = catalog ? "Couldn’t load the song list" : title;
  els.title.classList.remove("is-long");
  els.nowPlaying.classList.remove("has-long-title");
  els.source.hidden = true;
  els.details.textContent = detail;
  els.radioErrorActions.hidden = false;
  els.radioMainStation.hidden = state.stationId === "main";
  lyrics.clear("Lyrics appear here when the station is back.");
  renderStation();
  publishStationView();
  updateNowPlayingMetadata();
}

function renderTrack(track) {
  if (!track) return;
  const changed = state.current?.id !== track.id;
  const displayTitle = trackDisplayTitle(track);
  state.current = track;
  els.radioView.dataset.state = "ready";
  els.coverSurface.classList.remove("skeleton");
  els.radioErrorActions.hidden = true;
  if (changed) state.titleExpanded = false;
  els.title.textContent = displayTitle;
  els.title.classList.toggle("is-long", displayTitle.length > 36);
  els.nowPlaying.classList.toggle("has-long-title", displayTitle.length > 36);
  renderTitleClamp();
  setText(els.source, track.artist || "");
  els.source.hidden = !track.artist;
  setText(
    els.details,
    [trackDisplayGroup(track), timeLabel(track.duration)]
      .filter(Boolean)
      .join(" · "),
  );
  els.download.href = mediaAudioURL(track);
  els.download.download = `${displayTitle || track.id}.mp3`;
  els.download.removeAttribute("aria-disabled");
  const showCoverFallback = () => {
    if (els.emptyCover.dataset.seed !== track.id) {
      els.emptyCover.dataset.seed = track.id;
      paintArtworkFallback(els.emptyCover, track.id);
    }
    els.cover.classList.add("hidden");
    els.emptyCover.classList.remove("hidden");
    els.emptyCover.classList.add("grid");
  };
  els.cover.onload = () => {
    setArtworkTint(artworkTint(els.cover));
    if (state.current === track) prepareMediaArtwork(els.cover, track);
  };
  if (track.has_cover) {
    window.ZakImage(els.cover, mediaCoverURL(track), () => {
      if (state.current !== track) return;
      showCoverFallback();
      setArtworkTint("");
    });
    els.cover.classList.remove("hidden");
    els.emptyCover.classList.add("hidden");
    els.emptyCover.classList.remove("grid");
  } else {
    showCoverFallback();
    setArtworkTint("");
  }
  if (audioController.is("radio")) {
    audioController.claim("radio", mediaAudioURL(track), displayTitle, {
      stationId: state.stationId,
    });
  }
  els.progress.max = String(durationOf(track));
  // Lyrics load with the song wherever the listener is, so the player can
  // offer them and the full-screen view opens with them in place.
  lyrics.load(track);
  announceNowPlaying();
  updateNowPlayingMetadata();
}

// The live region says what's playing once per song, and again when the
// station pauses or starts, whenever Radio is on screen or being heard: on a
// song change, on returning to Radio, and when a station switch elsewhere
// makes it the one being heard. A paused station says so, and so does one
// this device is waiting for, in the words of its status and note.
function announceNowPlaying() {
  const track = currentTrack();
  if (!track || !state.station) return;
  if (router.path() !== "/" && !radioHearing()) return;
  const title = trackDisplayTitle(track);
  const announcement = state.station.playing
    ? `Now playing ${title}`
    : state.autoListen
      ? `Waiting · ${title}`
      : `Paused · ${title}`;
  const key = `${track.id}\n${announcement}`;
  if (state.announcedNowPlaying === key) return;
  state.announcedNowPlaying = key;
  setText(els.nowPlayingAnnouncement, announcement);
}

// The stage takes a dim tint from the artwork: its average color, kept dark
// enough that text contrast never depends on the image.
const tintCanvas = document.createElement("canvas");
tintCanvas.width = 12;
tintCanvas.height = 12;
function artworkTint(image) {
  try {
    const context = tintCanvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, 12, 12);
    const { data } = context.getImageData(0, 0, 12, 12);
    let red = 0;
    let green = 0;
    let blue = 0;
    let weight = 0;
    for (let index = 0; index < data.length; index += 4) {
      const [r, g, b] = [data[index], data[index + 1], data[index + 2]];
      // Favor colorful pixels so a grey border doesn't wash the tint out.
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const w = 1 + chroma / 32;
      red += r * w;
      green += g * w;
      blue += b * w;
      weight += w;
    }
    if (!weight) return "";
    const channel = (value) => Math.round(value / weight);
    return `rgb(${channel(red)} ${channel(green)} ${channel(blue)})`;
  } catch {
    return "";
  }
}

// The tint is the page's, so Radio's full player and full-screen lyrics
// take the same light from the artwork as the stage.
function setArtworkTint(color) {
  if (state.artworkTint === color) return;
  state.artworkTint = color;
  const root = document.documentElement;
  if (color) root.style.setProperty("--art-tint", color);
  else root.style.removeProperty("--art-tint");
}

// Long titles take a smaller size and up to four lines, so common long
// titles read in full; only longer ones clamp, with a toggle.
function renderTitleClamp() {
  els.title.classList.remove("is-clamped");
  const lineHeight = Number.parseFloat(getComputedStyle(els.title).lineHeight);
  const lines = lineHeight
    ? Math.round(els.title.getBoundingClientRect().height / lineHeight)
    : 1;
  const overflowing = Boolean(state.current) && lines > 4;
  els.title.classList.toggle("is-clamped", overflowing && !state.titleExpanded);
  els.titleToggle.hidden =
    !overflowing && document.activeElement !== els.titleToggle;
  setAttribute(els.titleToggle, "aria-expanded", String(state.titleExpanded));
  setText(
    els.titleToggle,
    state.titleExpanded ? "Show less" : "Show full title",
  );
}

// Providers by their own names ("Suno", not "suno").
const PROVIDERS = {
  suno: "Suno",
  udio: "Udio",
  riffusion: "Riffusion",
  stable_audio: "Stable Audio",
  "stable audio": "Stable Audio",
  musicgen: "MusicGen",
  mubert: "Mubert",
  aiva: "AIVA",
};

function providerName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const known = PROVIDERS[raw.toLocaleLowerCase()];
  if (known) return known;
  return raw === raw.toLocaleLowerCase()
    ? `${raw.charAt(0).toLocaleUpperCase()}${raw.slice(1)}`
    : raw;
}

function renderTrackFacts(track, station) {
  const skips = Number(station?.skip_count || 0);
  const facts = [
    ["Artist", track.artist],
    ["Collection", trackDisplayGroup(track)],
    ["Length", timeLabel(track.duration)],
    ["Made with", providerName(track.source)],
    ["File size", fileSize(track.audio_bytes)],
  ].filter(([, value]) => value);
  // Listening statistics read as a sentence, in Library's words.
  const stats = station
    ? skips
      ? `Skipped early ${plural(skips, "time")}.`
      : "Never skipped early."
    : "";
  setText(els.trackStats, stats);
  els.trackStats.hidden = !stats;
  const key = JSON.stringify(facts);
  if (els.trackFacts.dataset.key === key) return;
  els.trackFacts.dataset.key = key;
  els.trackFacts.replaceChildren(
    ...facts.map(([label, value]) => {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.className = "tabular";
      description.textContent = value;
      row.append(term, description);
      return row;
    }),
  );
}

function storedReaction(trackId) {
  const value = window.ZakStorage.get(`zak-reaction:${trackId}`, "");
  return value === "like" || value === "dislike" ? value : "";
}

function writeReaction(trackId, reaction) {
  if (reaction) window.ZakStorage.set(`zak-reaction:${trackId}`, reaction);
  else window.ZakStorage.remove(`zak-reaction:${trackId}`);
}

function renderReactions() {
  const track = currentTrack();
  const station = state.station;
  const known = Boolean(track && station);
  const reaction = known ? storedReaction(track.id) : "";
  const likes = Number(station?.like_count || 0);
  const dislikes = Number(station?.dislike_count || 0);
  // Counts keep their room while the station loads, so the row doesn't
  // widen and wrap when they arrive.
  setText(els.likeCount, known ? String(likes) : "0");
  setText(els.dislikeCount, known ? String(dislikes) : "0");
  els.likeCount.classList.toggle("is-unknown", !known);
  els.dislikeCount.classList.toggle("is-unknown", !known);
  els.toggleDetails.hidden = !known;
  setAttribute(els.like, "aria-pressed", String(reaction === "like"));
  setAttribute(els.dislike, "aria-pressed", String(reaction === "dislike"));
  els.like.title = known ? `${plural(likes, "listener")} liked this song` : "";
  els.dislike.title = known
    ? `${plural(dislikes, "listener")} disliked this song`
    : "";
  els.like.disabled = !known;
  els.dislike.disabled = !known;
  els.addCurrentToStation.disabled = !known;
  renderLyricsSheet();
}

// The station switch at the top of Radio says what is playing and how:
// "Live · All songs", "Paused · Late Night Rotation", "Reconnecting…".
function renderStatus() {
  const station = state.station;
  const live = Boolean(station?.playing);
  const lost = connectionLost();
  const mode = connectionMode();
  let status = "Connecting…";
  let tone = "waiting";
  if (state.stationError === "empty") status = "Nothing to play";
  else if (state.stationError === "notfound") status = "Not available";
  else if (state.stationError || lost) {
    // Same words and color as the header.
    status = CONNECTION[mode][0];
    tone = ["trouble", "offline", "unreachable"].includes(mode)
      ? "problem"
      : "waiting";
  } else if (station && emptyStation()) {
    status = "No songs match";
    tone = "paused";
  } else if (station) {
    status = live ? "Live" : "Paused";
    tone = live ? "live" : "paused";
  }
  setText(els.stationStatus, status);
  setText(els.liveStation, stationLabel());
  // One clean name in the visible order: "Live: All songs. Change station".
  // The visible status is set in capitals, which screen readers may spell
  // out; the name keeps ordinary case and no stray punctuation.
  setAttribute(
    els.stationSwitch,
    "aria-label",
    `${status.replace(/…$/, "")}: ${stationLabel()}. Change station`,
  );
  els.livePulse.dataset.tone = tone;
}

// A station that has never played starts at the top of its first song.
function neverPlayed(station) {
  return !station.playing && Number(station.position || 0) < 0.5;
}

// What the big button does now. It is about this device: listen, stop, or
// wait for a paused station. When this browser controls a paused station,
// it starts the station and plays it here in one step, and the note under it
// says who else that reaches. Only listen-only listeners wait.
function listenerAction() {
  const station = state.station;
  const hearing = radioHearing();
  const live = Boolean(station?.playing);
  const lost = connectionLost();
  const control = canControlStation();
  const main = stationKind() === "main";
  const result = {
    label: "Listen live",
    icon: "play",
    playing: false,
    waiting: false,
    disabled: true,
    note: "On this device only",
    alternatives: false,
  };
  if (state.stationError) {
    result.note = "";
  } else if (!station || !state.current) {
    result.disabled = true;
  } else if (emptyStation()) {
    result.note = "No songs match this station";
  } else if (hearing) {
    Object.assign(result, {
      label: "Stop listening",
      icon: "stop",
      playing: true,
      disabled: false,
    });
    // The loaded song can repeat while the station is unreachable.
    result.note = !lost
      ? "On this device only"
      : audioController.audible
        ? "Replaying this song until Zak Radio reconnects"
        : "Connection lost · resumes when Zak Radio is back";
  } else if (lost) {
    result.note = "Connection lost · Radio keeps trying";
  } else if (live) {
    result.disabled = false;
  } else if (control) {
    const fresh = neverPlayed(station) && !main;
    result.label = fresh ? "Start and listen" : "Resume and listen";
    result.disabled = false;
    result.note = main
      ? "Paused · resumes All songs for everyone"
      : stationKind() === "temporary"
        ? fresh
          ? "Not started · starts it for you and anyone with the link"
          : "Paused · resumes it for you and anyone with the link"
        : fresh
          ? "Not started · starts it for anyone listening"
          : "Paused · resumes it for anyone listening";
  } else if (state.autoListen) {
    Object.assign(result, {
      label: "Stop waiting",
      icon: "stop",
      playing: true,
      waiting: true,
      disabled: false,
      note: "Waiting · plays here when its owner starts it",
      alternatives: true,
    });
  } else {
    Object.assign(result, {
      label: "Listen when it starts",
      disabled: false,
      note: "Paused by its owner · only they can start it",
      alternatives: true,
    });
  }
  return result;
}

function renderListener() {
  const action = listenerAction();
  setText(els.playPauseLabel, action.label);
  els.playPause.disabled = action.disabled;
  els.playPause.classList.toggle("is-playing", action.playing);
  els.playPause.classList.toggle(
    "is-waiting",
    action.waiting && !radioHearing(),
  );
  els.playIcon.classList.toggle("hidden", action.icon !== "play");
  els.pauseIcon.classList.toggle("hidden", action.icon === "play");
  setText(els.listenNote, action.note);
  els.listenNote.hidden = !action.note;
  els.listenAlternatives.hidden =
    !action.alternatives || state.stationId === "main";
}

function renderPresence() {
  const line = byId("stationPresence");
  const count = state.connectedListeners;
  const targets = [
    els.stationControls.querySelector(".station-controls-buttons"),
    els.radioSecondary,
    els.radioSide,
  ];
  if (els.radioQueue.parentElement === els.radioView)
    targets.push(els.radioQueue);
  animateLayout(targets, () => {
    line.hidden = count === null;
    setText(
      byId("presenceCount"),
      count === null
        ? ""
        : count <= 1
          ? "Just you tuned in"
          : `${count} tuned in`,
    );
  });
}

// Shared controls always name their effect on everyone listening.
function pauseLabel() {
  return "Pause for everyone";
}
function skipLabel() {
  return "Skip for everyone";
}
function resumeLabel() {
  return "Resume for everyone";
}

const PAUSE_PATH = '<path d="M9 6v12M15 6v12"></path>';
const RESUME_PATH = '<path d="m8 6 10 6-10 6z"></path>';

// Station-wide controls: Pause becomes Resume in the same place, naming
// the shared effect on every station. Listen-only listeners see who controls
// the station instead, in the same words as the station sheet.
function stationScope() {
  return connectionLost()
    ? "Unavailable until Zak Radio reconnects"
    : stationKind() === "main"
      ? "Affects everyone listening"
      : "Anyone on Zak Radio can listen · only you can change it";
}

function renderStationControls() {
  const station = state.station;
  const known = Boolean(station && state.current);
  const control = known && canControlStation();
  const lost = connectionLost();
  const kind = stationKind();
  const main = kind === "main";
  els.stationControls.hidden =
    Boolean(state.stationError) || (known && !control);
  els.stationListenOnly.hidden =
    Boolean(state.stationError) || !known || control;
  setText(els.stationListenOnlyNote, "shared by its owner");
  els.stationControls.classList.toggle("is-offline", lost);
  setText(
    els.stationControlsTitle,
    main
      ? "Shared controls"
      : kind === "temporary"
        ? "Your temporary station"
        : "Your station",
  );
  setText(els.stationControlsNote, stationScope());
  const live = Boolean(station?.playing);
  const empty = known && emptyStation();
  const action = !known || live ? "pause" : "resume";
  if (els.stationPause.dataset.action !== action) {
    els.stationPause.dataset.action = action;
    els.stationPauseIcon.innerHTML =
      action === "pause" ? PAUSE_PATH : RESUME_PATH;
  }
  setText(
    els.stationPauseLabel,
    action === "pause" ? pauseLabel() : resumeLabel(station),
  );
  setText(els.stationSkipLabel, skipLabel());
  els.stationPause.disabled = !control || empty || lost;
  els.stationPause.hidden = false;
  byId("stationShareNearby").hidden = !control || main;
  const skipUnavailable = !control || empty || lost;
  els.next.disabled =
    skipUnavailable && !(lost && document.activeElement === els.next);
  setAttribute(els.next, "aria-disabled", String(skipUnavailable));
  const temporary = control && kind === "temporary";
  els.stationControls.classList.toggle("is-temporary", temporary);
  els.temporaryTransport.hidden = !temporary;
  els.temporaryModes.hidden = !temporary;
  for (const button of [
    ...els.temporaryTransport.querySelectorAll("button"),
    ...els.temporaryModes.querySelectorAll("button"),
  ])
    button.disabled = lost;
  if (temporary) {
    setAttribute(els.random, "aria-pressed", String(Boolean(station.shuffle)));
    setAttribute(
      els.repeatOne,
      "aria-pressed",
      String(Boolean(station.repeat_one)),
    );
    els.random.title = station.shuffle ? "Shuffle is on" : "Shuffle is off";
    els.repeatOne.title = station.repeat_one
      ? "Repeating this song"
      : "Repeat is off";
  }
}

function queueItem(track, index, editable) {
  const item = document.createElement("li");
  item.className = "queue-item";
  item.dataset.queueIndex = String(index);
  item.dataset.trackId = track?.id || "";
  const art = document.createElement("span");
  art.className = "queue-art";
  if (track?.has_cover) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    window.ZakImage(image, mediaCoverURL(track), () => {
      art.replaceChildren(createArtworkFallback(track));
    });
    art.append(image);
  } else {
    art.append(createArtworkFallback(track));
  }
  const copy = document.createElement("span");
  copy.className = "queue-copy";
  const title = document.createElement("span");
  title.className = "queue-title";
  title.textContent = track ? trackDisplayTitle(track) : "Unknown song";
  copy.append(title);
  if (track?.artist) {
    const artist = document.createElement("span");
    artist.className = "queue-artist";
    artist.textContent = track.artist;
    copy.append(artist);
  }
  const length = document.createElement("span");
  length.className = "queue-duration tabular";
  length.textContent = track ? timeLabel(track.duration) : "";
  item.append(art, copy, length);
  if (editable && track) {
    const actions = document.createElement("div");
    actions.className = "queue-actions";
    const add = (label, action, disabled = false) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button-quiet";
      button.dataset.queueAction = action;
      button.textContent = label;
      button.setAttribute(
        "aria-label",
        `${label}: ${trackDisplayTitle(track)}`,
      );
      button.disabled = disabled;
      button.addEventListener("click", async () => {
        if (action === "details") {
          openQueueDetails(track, button);
          return;
        }
        const stationId = state.stationId;
        if (actions.contains(document.activeElement))
          els.radioQueueTitle.focus({ preventScroll: true });
        actions.querySelectorAll("button").forEach((node) => {
          node.disabled = true;
        });
        const result = await postControl(
          action,
          { track_id: track.id, position: index },
          { outcome: "the queue didn’t change" },
        );
        if (state.stationId !== stationId) return;
        delete els.radioQueueTracks.dataset.key;
        renderQueue();
        const target =
          result && action === "queue_move_up"
            ? index - 1
            : result && action === "queue_move_down"
              ? index + 1
              : Math.min(index, (state.station?.queue?.length || 1) - 1);
        els.radioQueueTracks
          .querySelector(`[data-queue-index="${target}"] button`)
          ?.focus({ preventScroll: true });
        if (!state.station?.queue?.length)
          els.radioQueueTitle.focus({ preventScroll: true });
        if (result) notify(`${label}: ${trackDisplayTitle(track)}.`);
      });
      actions.append(button);
    };
    add("Play now", "queue_play");
    add("Move up", "queue_move_up", index === 0);
    add(
      "Move down",
      "queue_move_down",
      index === state.station.queue.length - 1,
    );
    add("Remove from queue", "queue_remove");
    add("Song details", "details");
    item.append(actions);
  }
  return item;
}

function renderQueue() {
  const station = state.station;
  const focused = els.radioQueueTracks.contains(document.activeElement)
    ? document.activeElement
    : null;
  const focusedRow = focused?.closest("[data-queue-index]");
  const nextId = station?.queue?.[0] || station?.up_next?.[0];
  const nextTrack = trackById(nextId);
  const nextLine = byId("radioNext");
  nextLine.hidden = !nextTrack;
  setText(
    nextLine,
    nextTrack
      ? `Next: ${trackDisplayTitle(nextTrack)}${nextTrack.artist ? ` · ${nextTrack.artist}` : ""}`
      : "",
  );
  let ids = [];
  let summary = "";
  let libraryHint = false;
  if (state.stationError) {
    summary = "Up next appears when the station is back.";
  } else if (!station) {
    if (!els.radioQueueSummary.querySelector(".skeleton")) {
      if (els.radioQueueSummary.contains(document.activeElement))
        els.radioQueueTitle.focus({ preventScroll: true });
      els.radioQueueSummary.replaceChildren(skeleton("Loading what’s next"));
    }
    if (els.radioQueueTracks.dataset.key !== "loading") {
      if (focused) els.radioQueueTitle.focus({ preventScroll: true });
      els.radioQueueTracks.dataset.key = "loading";
      els.radioQueueTracks.replaceChildren(
        ...Array.from({ length: state.stationId === "main" ? 8 : 3 }, () => {
          const item = document.createElement("li");
          item.className = "queue-item is-loading";
          item.setAttribute("aria-hidden", "true");
          item.append(
            skeleton("", "queue-art"),
            skeleton("Song title", "skeleton-line"),
          );
          return item;
        }),
      );
    }
    els.radioQueueTracks.hidden = false;
    return;
  } else if (stationKind() === "temporary") {
    ids = Array.isArray(station.queue) ? station.queue : [];
    // With nothing queued, the server plays on through the catalog, which
    // is ordered by collection.
    const after = station.repeat_one
      ? "Nothing queued, so this song repeats."
      : station.shuffle
        ? "Nothing queued, so songs from the whole library play at random."
        : "Nothing queued, so the library plays in order, one collection at a time.";
    if (ids.length)
      summary = `${plural(ids.length, "song")} queued${canControlStation() ? "" : " · only its owner can change the queue"}`;
    else if (canControlStation()) {
      summary = `${after} Choose Play next or Add to queue on any song in Library.`;
      libraryHint = true;
    } else summary = after;
  } else if (emptyStation()) {
    summary = canControlStation()
      ? "No songs match this station. Edit the station to change which songs it plays."
      : "No songs match this station right now.";
  } else if (station.random_mode === "true_random") {
    summary = `Shuffle with repeats · any of ${plural(Number(station.eligible || 0), "song")} can play next`;
  } else {
    ids = Array.isArray(station.up_next) ? station.up_next : [];
    const remaining = Number(station.remaining || ids.length);
    summary = ids.length
      ? `No repeats · ${plural(remaining, "song")} left before reshuffling`
      : "No repeats · reshuffling after this song";
  }
  if (
    station &&
    stationKind() === "saved" &&
    !canControlStation() &&
    !emptyStation()
  )
    summary += " · only its owner can change the order";
  if (libraryHint) {
    if (!els.radioQueueSummary.querySelector("a")) {
      const link = document.createElement("a");
      link.href = "/library";
      link.dataset.route = "/library";
      link.textContent = "Open Library";
      els.radioQueueSummary.replaceChildren(`${summary} `, link);
      router.syncLinks();
    }
  } else {
    if (els.radioQueueSummary.contains(document.activeElement))
      els.radioQueueTitle.focus({ preventScroll: true });
    setText(els.radioQueueSummary, summary);
  }
  const editable = stationKind() === "temporary" && canControlStation();
  const shown =
    editable || stationKind() === "temporary" ? ids : ids.slice(0, 8);
  const key = `${state.stationId}:${editable}:${shown.join(",")}`;
  if (els.radioQueueTracks.dataset.key !== key) {
    if (focused) els.radioQueueTitle.focus({ preventScroll: true });
    els.radioQueueTracks.dataset.key = key;
    els.radioQueueTracks.replaceChildren(
      ...shown.map((id, index) => queueItem(trackById(id), index, editable)),
    );
    els.radioQueueTracks.hidden = !ids.length;
    if (focusedRow) {
      const matchingIndex = shown.indexOf(focusedRow.dataset.trackId);
      const index =
        matchingIndex >= 0
          ? matchingIndex
          : Math.min(Number(focusedRow.dataset.queueIndex), shown.length - 1);
      const row = els.radioQueueTracks.children[index];
      const action = focused.dataset.queueAction;
      const target =
        row?.querySelector(`[data-queue-action="${action}"]:not(:disabled)`) ||
        row?.querySelector("button:not(:disabled)");
      target?.focus({ preventScroll: true });
    }
  }
  els.radioQueueTracks.hidden = !ids.length;
}

els.titleToggle.addEventListener("blur", renderTitleClamp);

// Playback settings change the station for everyone. Listen-only listeners
// see what they are set to instead of controls they can't use.
function renderSettings() {
  const station = state.station;
  els.radioOwnerControls.hidden =
    stationKind() === "temporary" || Boolean(state.stationError);
  const lost = connectionLost();
  const readOnly = Boolean(station) && !canControlStation();
  const control = Boolean(station) && !readOnly && !lost;
  els.radioProgramming.hidden = readOnly;
  els.radioSettingsReadOnly.hidden = !readOnly;
  setRadioGroupDisabled(els.stationRandomMode, !control);
  els.stationSkipDisliked.disabled = !control;
  setText(
    els.radioProgrammingNote,
    !station
      ? "Loading this station’s settings…"
      : lost
        ? "You can change these again when Zak Radio reconnects."
        : "Changes affect everyone listening.",
  );
  if (!station) {
    setText(els.radioOwnerControlsSummary, "");
    return;
  }
  const mode = station.random_mode || "deck";
  const order = mode === "true_random" ? "Shuffle with repeats" : "No repeats";
  if (document.activeElement?.name !== "stationRandomMode")
    setRadioGroupValue(els.stationRandomMode, mode);
  els.stationSkipDisliked.checked = Boolean(station.skip_disliked);
  setText(els.radioSettingsOrder, order);
  setText(els.radioSettingsSkip, station.skip_disliked ? "On" : "Off");
  setText(
    els.radioOwnerControlsSummary,
    [order, station.skip_disliked ? "Skips disliked" : ""]
      .filter(Boolean)
      .join(" · "),
  );
}

function accessNote() {
  if (state.stationError) return "";
  if (!state.station) return null;
  const kind = stationKind();
  const control = canControlStation();
  // All songs says who can change it in its own line of the list.
  if (kind === "main") return "";
  if (kind === "saved")
    return control
      ? "Anyone on Zak Radio can listen. Only you can change it; your editing access is saved in this browser or app."
      : "Listen-only · shared by its owner. Only its owner can pause, skip, or change it.";
  return control
    ? `Your temporary station ${endsLabel(state.station.expires_at)}. People with the link can listen but can’t change it.`
    : "Listen-only · shared by its owner. Only its owner can pause, skip, or change it.";
}

// "ends in about 23 hours unless you use it", from a server expiry time.
function endsLabel(expiresAt) {
  const seconds = Number(expiresAt || 0) - serverNow();
  if (!Number.isFinite(seconds) || seconds <= 0)
    return "ends 24 hours after you last use it";
  return `ends in ${durationWords(seconds)} unless you use it`;
}

function serverNow() {
  return Number.isFinite(state.serverClockOffset)
    ? performance.now() / 1000 - state.serverClockOffset
    : Date.now() / 1000;
}

function durationWords(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `about ${plural(minutes, "minute")}`;
  const hours = Math.round(minutes / 60);
  return `about ${plural(hours, "hour")}`;
}

function renderStationPanel() {
  if (
    els.stationOptions.querySelector('[aria-current="true"]')?.dataset
      .stationId !== state.stationId
  )
    renderStationPicker();
  const note = accessNote();
  if (note === null) {
    if (!els.stationAccess.querySelector(".skeleton"))
      els.stationAccess.replaceChildren(skeleton("Checking this station"));
  } else {
    setText(els.stationAccess, note);
  }
  els.stationAccess.hidden = note === "";
  const definition = stationDefinition();
  els.editStation.hidden = !(
    definition &&
    !definition.built_in &&
    ownerTokenFor(state.stationId)
  );
  els.shareStation.hidden = state.stationId === "main" || !state.station;
  els.endStation.hidden = !(
    state.station &&
    stationKind() === "temporary" &&
    ownerTokenFor(state.stationId)
  );
  els.createStation.disabled = state.stationCreatePending;
}

function renderStation() {
  renderStationPanel();
  renderConnection();
  renderStatus();
  renderListener();
  renderStationControls();
  renderReactions();
  renderQueue();
  renderSettings();
  placeQueue();
  lyrics.syncStatus();
  const track = currentTrack();
  const station = state.station;
  if (track && station) {
    renderTrackFacts(track, station);
    lyrics.setSeekable(seekableStation());
    if (audioController.is("radio"))
      els.audio.loop = Boolean(station.repeat_one);
    if (!radioHearing()) updateProgressFromStation();
  }
  announceNowPlaying();
  player?.update();
  updateNowPlayingMetadata();
  syncMediaSessionActions();
}

function seekableStation() {
  return (
    Boolean(state.station) &&
    stationKind() === "temporary" &&
    canControlStation()
  );
}

// Tabs and history name what each page shows: the song on Radio, the open
// item in Reader.
function updateDocumentTitle() {
  const track = currentTrack();
  const path = router.path();
  let title = "Zak Radio";
  if (path === "/404") title = "Page not found · Zak Radio";
  else if (path === "/library") title = "Library · Zak Radio";
  else if (path === "/reader") {
    const item = window.ZakReader?.documentTitle?.() || "";
    title = `${item ? `${item} · ` : ""}Reader · Zak Radio`;
  } else if (track) {
    title = `${radioHearing() ? "▶ " : ""}${trackDisplayTitle(track)} · ${state.stationId !== "main" ? `${stationLabel()} · ` : ""}Zak Radio`;
  }
  if (document.title !== title) document.title = title;
}
window.ZakRefreshTitle = updateDocumentTitle;

function updateNowPlayingMetadata() {
  const track = currentTrack();
  updateDocumentTitle();
  if (!track) {
    window.ZakNativeHost?.media({
      state: audioController.nativeState(),
      title: audioController.label || "Zak Radio",
      subtitle: "Zakstak",
    });
    return;
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = els.audio.paused
      ? "paused"
      : "playing";
    if (audioController.is("radio")) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: trackDisplayTitle(track),
        artist: track.artist || "Zak",
        album: `Zak Radio · ${stationLabel()}`,
        artwork: mediaArtwork(track),
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
          : "Library preview",
  });
}

// ---- Media Session artwork ----
// Lock screens and notifications pick the size they need, so the loaded cover
// is drawn at three square sizes with explicit sizes and type. Songs without
// artwork use the app icon.
const ARTWORK_SIZES = [96, 256, 512];
const APP_ARTWORK = [
  { src: "/static/radio-braille.svg", sizes: "any", type: "image/svg+xml" },
];
const artworkCache = { key: "", entries: null };

function mediaArtwork(track) {
  if (!track?.has_cover) return APP_ARTWORK;
  const key = mediaCoverURL(track);
  if (artworkCache.key === key && artworkCache.entries)
    return artworkCache.entries;
  // Until the cover has loaded and been measured, the app icon stands in.
  return APP_ARTWORK;
}

function prepareMediaArtwork(image, track) {
  const key = mediaCoverURL(track);
  if (!image.naturalWidth || !image.naturalHeight) return;
  try {
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    const sx = (image.naturalWidth - side) / 2;
    const sy = (image.naturalHeight - side) / 2;
    const entries = ARTWORK_SIZES.map((size) => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      canvas
        .getContext("2d")
        .drawImage(image, sx, sy, side, side, 0, 0, size, size);
      return {
        src: canvas.toDataURL("image/jpeg", 0.86),
        sizes: `${size}x${size}`,
        type: "image/jpeg",
      };
    });
    artworkCache.key = key;
    artworkCache.entries = entries;
    updateNowPlayingMetadata();
  } catch {
    artworkCache.key = "";
    artworkCache.entries = null;
  }
}

// ---- Progress: read-only except on temporary stations you control ----
function renderProgress(position, duration) {
  const shown = Math.max(0, Math.min(position, duration || position));
  const remaining = Math.max(0, duration - shown);
  setText(els.currentTime, duration > 0 ? timeLabel(shown) : "—:——");
  setText(els.duration, duration > 0 ? `−${timeLabel(remaining)}` : "—:——");
  const percent =
    duration > 0 ? Math.max(0, Math.min(100, (shown / duration) * 100)) : 0;
  els.progressFill.style.width = `${percent}%`;
  els.progressThumb.style.left = `${percent}%`;
  const valueText = `${timeLabel(shown)} of ${timeLabel(duration)}`;
  paintProgress(lyricsSheetProgress, {
    position: shown,
    duration,
    seekable: seekableStation(),
  });
  const seekable = seekableStation();
  els.progress.hidden = !seekable;
  els.progressThumb.hidden = !seekable;
  if (seekable) {
    for (const name of [
      "role",
      "aria-label",
      "aria-valuemin",
      "aria-valuemax",
      "aria-valuenow",
      "aria-valuetext",
    ])
      els.progressTrack.removeAttribute(name);
    els.progress.max = String(duration);
    els.progress.value = String(shown);
    setAttribute(els.progress, "aria-valuetext", valueText);
  } else {
    setAttribute(els.progressTrack, "role", "progressbar");
    setAttribute(els.progressTrack, "aria-label", "Song progress");
    setAttribute(els.progressTrack, "aria-valuemin", "0");
    setAttribute(
      els.progressTrack,
      "aria-valuemax",
      String(Math.round(duration)),
    );
    setAttribute(els.progressTrack, "aria-valuenow", String(Math.round(shown)));
    setAttribute(els.progressTrack, "aria-valuetext", valueText);
  }
}

function updateProgressFromAudio() {
  const track = currentTrack();
  if (!track || state.syncingProgress) return;
  const duration = durationOf(track) || els.audio.duration || 0;
  const position = els.audio.currentTime || state.station?.position || 0;
  renderProgress(position, duration);
}

function updateProgressFromStation() {
  const track = currentTrack();
  if (!track || !state.station || state.syncingProgress) return;
  renderProgress(estimatedStationPosition(state.station), durationOf(track));
}

function estimatedStationPosition(station) {
  let position = Number(station.position || 0);
  if (station.playing) {
    position += Math.max(0, performance.now() / 1000 - state.stationReceivedAt);
  }
  const duration = durationOf(trackById(station.track_id) || currentTrack());
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
  const track = trackById(station?.track_id);
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
  const track = trackById(station.track_id);
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
    if (!state.catalogError) {
      try {
        await loadCatalog(true);
      } catch (error) {
        state.catalogError = error;
        scheduleBootRetry();
      }
    }
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
  const wasKnown = Boolean(state.station);
  state.station = station;
  state.stationError = "";
  state.stationReceivedAt =
    serverTime > 0 && Number.isFinite(state.serverClockOffset)
      ? serverTime + state.serverClockOffset
      : receivedAt / 1000;
  const track = mergeCurrentStats(station);
  if (!track && state.catalogError) {
    setStationUnavailable(failureKind(state.catalogError), { catalog: true });
    return;
  }
  const targets = [
    ...els.radioView.querySelectorAll(
      ".station-bar, .cover-frame, .track-title, .title-toggle, .track-source, .track-details, .details-toggle, .listen-control, .radio-volume, .station-progress, .radio-next, .track-actions, .station-controls, .station-listen-only",
    ),
    els.radioSecondary,
    els.radioSide,
  ];
  if (els.radioQueue.parentElement === els.radioView)
    targets.push(els.radioQueue);
  const previousTitleHeight = els.title.getBoundingClientRect().height;
  const changed = track && state.current?.id !== track.id;
  animateLayout(targets, () => {
    if (track && state.current !== track) renderTrack(track);
    if (!wasKnown) renderStationPicker();
    renderStation();
  });
  if (changed) {
    const height = els.title.getBoundingClientRect().height;
    const duration = window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches
      ? 1
      : 220;
    els.title.animate(
      [
        {
          clipPath: `inset(0 0 ${Math.max(0, height - previousTitleHeight)}px 0)`,
          opacity: 0.35,
        },
        { clipPath: "inset(0)", opacity: 1 },
      ],
      { duration, easing: "ease-out" },
    );
  }
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
  publishStationView();
  if (state.autoListen && station.playing) {
    // The owner resumed the station this listener was waiting for.
    state.autoListen = false;
    const played = await listenLive();
    notify(
      played
        ? `“${stationLabel()}” started. You’re listening.`
        : `“${stationLabel()}” started. Press Listen live to hear it.`,
    );
    return;
  }
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
      setConnected(false, error);
      window.clearTimeout(state.eventReconnectTimer);
      state.eventReconnectTimer = window.setTimeout(connectStationEvents, 500);
      if (error.status === 404 && state.stationId !== "main") {
        notify("That station isn’t available anymore. Switched to All songs.");
        await switchStation("main", "");
        return false;
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
  state.connectedListeners = null;
  renderPresence();
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
  source.addEventListener("presence", (event) => {
    if (source !== state.eventSource) return;
    try {
      const count = JSON.parse(event.data).connected;
      state.connectedListeners =
        Number.isInteger(count) && count >= 0 ? count : null;
      renderPresence();
    } catch {}
  });
  source.addEventListener("catalog", async () => {
    if (source !== state.eventSource) return;
    try {
      await loadCatalog(true);
    } catch (error) {
      if (error.name === "AbortError") return;
      state.catalogError = error;
      scheduleBootRetry();
    }
  });
  source.addEventListener("track", (event) => {
    if (source !== state.eventSource) return;
    try {
      applyTrackStats(JSON.parse(event.data));
    } catch {}
  });
  source.addEventListener("expired", async () => {
    if (source !== state.eventSource) return;
    notify("That station isn’t available anymore. Switched to All songs.");
    await switchStation("main", "");
  });
  source.onerror = () => {
    if (source !== state.eventSource) return;
    source.close();
    state.connectedListeners = null;
    renderPresence();
    state.streamConnected = false;
    setConnected(state.connected);
    const delay = Math.min(30000, 500 * 2 ** state.eventReconnectAttempt++);
    state.eventReconnectTimer = window.setTimeout(() => {
      if (source === state.eventSource) connectStationEvents();
    }, delay);
  };
}

// Station changes are shared: they never start or stop this listener's audio.
// A change that doesn't go through is treated like a dropped connection: the
// song keeps playing and stays on screen, the station reconnects in the
// background, and one notification says what didn't happen, with Try again.
async function postControl(
  action,
  extra = {},
  { outcome = "", retry = null, quiet = false } = {},
) {
  const stationId = state.stationId;
  const ownerToken = state.ownerToken;
  const generation = state.controlGeneration;
  const stale = () =>
    generation !== state.controlGeneration || stationId !== state.stationId;
  const execute = async () => {
    if (stale()) return null;
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
      if (stale()) return null;
      setConnected(true);
      await applyStation(station);
      return station;
    } catch (error) {
      if (stale()) return null;
      if (error.status === 403 && stationId !== "main") {
        window.ZakStorage.remove(`zak-radio-owner:${stationId}`);
        state.ownerToken = "";
        if (state.station) {
          state.station.can_control = false;
          renderStation();
        }
        notify("This device can’t change this station anymore.", {
          tone: "error",
        });
        return null;
      }
      // Asked to slow down: the connection is fine, so it isn't shown as
      // lost. Anything else is shown as a connection problem until the
      // station answers again; either way the station rolls back to what
      // it really is when it does.
      if (problemKind(error) !== "busy") setConnected(false, error);
      await refreshStation(true);
      if (!quiet && !stale()) {
        notifyFailure(error, outcome || undefined, retry);
      }
      return null;
    }
  };
  state.controlQueue = state.controlQueue.catch(() => {}).then(execute);
  return state.controlQueue;
}

// Moves within a temporary station this browser controls.
function seekStation(position) {
  return postControl(
    "seek",
    { position },
    { outcome: "the jump didn’t happen", retry: () => seekStation(position) },
  );
}

function seekStationBy(offset) {
  return postControl(
    "relative_seek",
    { position: offset },
    {
      outcome: "the jump didn’t happen",
      retry: () => seekStationBy(offset),
    },
  );
}

function previousSong() {
  return postControl(
    "prev",
    {},
    { outcome: "the previous song didn’t play", retry: previousSong },
  );
}

// Confirmations name the result, so nobody has to look for it: what was
// skipped and what plays now.
async function skipForEveryone() {
  const track = currentTrack();
  const station = state.station;
  if (!track || !station || !canControlStation() || connectionLost()) return;
  const previous = {
    trackId: track.id,
    position: estimatedStationPosition(station),
    title: trackDisplayTitle(track),
  };
  const result = await postControl(
    "next",
    {},
    { outcome: "the skip didn’t happen", retry: skipForEveryone },
  );
  if (!result) return;
  const now = currentTrack();
  const nowTitle =
    now && now.id !== previous.trackId ? trackDisplayTitle(now) : "";
  const everyone = stationKind() === "main" ? " for everyone" : "";
  notify(
    nowTitle
      ? `Skipped “${previous.title}”${everyone}. Now playing “${nowTitle}”.`
      : `Skipped “${previous.title}”${everyone}.`,
    {
      action: {
        label: "Undo",
        run: async () => {
          const selected = await postControl(
            "select",
            { track_id: previous.trackId },
            { outcome: "the skip wasn’t undone" },
          );
          if (!selected) return;
          await postControl(
            "seek",
            { position: previous.position },
            { quiet: true },
          );
          notify(`Back to “${previous.title}”${everyone}.`);
        },
      },
    },
  );
}

async function pauseForEveryone() {
  const station = state.station;
  if (!station?.playing || !canControlStation()) return;
  const wasHearing = radioHearing();
  state.resumeHere = wasHearing;
  station.position = estimatedStationPosition(station);
  station.playing = false;
  state.stationReceivedAt = performance.now() / 1000;
  if (audioController.is("radio")) els.audio.pause();
  renderStation();
  const result = await postControl(
    "pause",
    {},
    { outcome: "the station wasn’t paused", retry: pauseForEveryone },
  );
  if (!result) {
    // Nothing changed for anyone, so nothing changes here either: the
    // station plays on, and so does this device if it was listening.
    if (state.station === station && !station.playing) {
      station.playing = true;
      renderStation();
      if (wasHearing) void syncAudioToStation();
    }
    return;
  }
  notify(
    stationKind() === "main"
      ? `Paused “${stationLabel()}” for everyone.`
      : `Paused “${stationLabel()}”.`,
    {
      action: {
        label: "Undo",
        run: () => resumeForEveryone({ listen: wasHearing, undo: true }),
      },
    },
  );
}

function stationReach() {
  const kind = stationKind();
  return kind === "main"
    ? " for everyone"
    : kind === "temporary"
      ? " for anyone with the link"
      : " for anyone listening";
}

async function resumeForEveryone({
  listen = true,
  undo = false,
  quiet = false,
} = {}) {
  const station = state.station;
  if (!station || station.playing || !canControlStation()) return false;
  const starting = neverPlayed(station);
  state.autoListen = false;
  state.resumeHere = false;
  if (listen) {
    state.userActivatedAudio = true;
    state.localRadioSuspended = false;
    state.radioInterrupted = false;
    state.radioStopped = false;
    if (!audioController.is("radio")) await audioController.returnLive(false);
  }
  station.playing = true;
  state.stationReceivedAt = performance.now() / 1000;
  renderStation();
  if (listen) {
    audioController.reloadIfFailed();
    void audioController.play();
  }
  const result = await postControl(
    "play",
    {},
    {
      outcome: starting
        ? "the station didn’t start"
        : "the station didn’t resume",
      retry: () => resumeForEveryone({ listen, undo, quiet }),
    },
  );
  if (!result) {
    if (state.station === station && station.playing) {
      station.playing = false;
      if (audioController.is("radio")) els.audio.pause();
      renderStation();
    }
    return false;
  }
  if (!quiet) {
    const reach = stationReach();
    const message = undo
      ? `Playing “${stationLabel()}” again${reach}.`
      : starting
        ? `Started “${stationLabel()}”${reach}.`
        : `Resumed “${stationLabel()}”${reach}.`;
    notify(
      listen
        ? `${message} You’re listening.`
        : `${message} You’re not listening on this device.`,
      listen ? {} : { action: { label: "Listen live", run: listenLive } },
    );
  }
  return true;
}

// The station-wide Pause control becomes Resume while the station is paused.
// It changes the station, not this device: it plays here only if this
// device was listening when the station was paused. "Start and listen" on
// the big button does both.
async function toggleStationForEveryone() {
  const station = state.station;
  if (!station) return;
  if (station.playing) {
    await pauseForEveryone();
    return;
  }
  await resumeForEveryone({ listen: state.resumeHere || state.autoListen });
}

// The big button: listen, stop, or, for a paused station, start it and
// listen when this browser controls it, or wait for its owner when it
// doesn't.
async function primaryAction() {
  const station = state.station;
  if (!station) return;
  if (radioHearing()) {
    state.resumeHere = false;
    stopListening();
    return;
  }
  if (station.playing) {
    await listenLive();
    return;
  }
  if (canControlStation()) {
    if (!emptyStation() && !connectionLost())
      await resumeForEveryone({ listen: true });
    return;
  }
  state.autoListen = !state.autoListen;
  // This press is the gesture that lets the browser start audio later.
  if (state.autoListen) state.userActivatedAudio = true;
  else state.resumeHere = false;
  renderStation();
  notify(
    state.autoListen
      ? `You’ll hear “${stationLabel()}” as soon as its owner starts it.`
      : "Stopped waiting.",
  );
}

// While waiting for a paused station, "Listen to All songs" switches to All
// songs instead, which stops waiting.
async function listenToMain() {
  const previous = { id: state.stationId, label: stationLabel() };
  state.autoListen = false;
  state.userActivatedAudio = true;
  await switchStation("main", "", { history: "push" });
  if (state.station?.playing) await listenLive();
  notify("Listening to All songs.", {
    action: {
      label: `Back to “${previous.label}”`,
      run: () =>
        switchStation(previous.id, ownerTokenFor(previous.id), {
          history: "push",
        }),
    },
  });
}

window.ZakStation = {
  current: stationView,
  ownTemporary: ownTemporaryStations,
  endTemporary: endTemporaryStation,
  // Listen to a station from elsewhere (Library's Listen, a notification).
  // A paused station this browser controls starts in the same step; one it
  // doesn't control is waited for.
  async open(stationId, { listen = true } = {}) {
    if (stationId !== state.stationId || !state.station)
      await switchStation(stationId, ownerTokenFor(stationId), {
        history: "push",
      });
    if (router.path() !== "/") router.navigate("/");
    if (!listen || !state.station || state.stationId !== stationId) return;
    state.userActivatedAudio = true;
    if (state.station.playing) await listenLive();
    else if (canControlStation()) await primaryAction();
    else if (!state.autoListen) {
      state.autoListen = true;
      renderStation();
    }
  },
  // A failed queue change says so itself, in the shared words, with Try
  // again; `outcome` names what didn't happen ("“Taillights” wasn’t queued").
  async enqueue(action, trackID, { outcome = "", retry = null } = {}) {
    if (
      !["play_next", "add_to_queue"].includes(action) ||
      !trackID ||
      state.stationId === "main" ||
      !canControlStation()
    )
      return null;
    return postControl(action, { track_id: trackID }, { outcome, retry });
  },
  createTemporary: createTemporaryStation,
  // A slot was freed elsewhere (a saved station deleted), so the next start
  // shouldn't wait out the guard.
  capacityFreed() {
    state.stationCapacityRetryAt = 0;
  },
};

// Temporary stations this browser started and that still exist. The owner
// token is only stored locally, so that's where to look for them.
async function ownTemporaryStations() {
  const saved = new Set(state.stations.map((station) => station.station_id));
  const ids = [];
  try {
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index) || "";
      const id = key.startsWith("zak-radio-owner:") ? key.slice(16) : "";
      if (id && !saved.has(id) && /^[a-f0-9]{12}(?:[a-f0-9]{20})?$/.test(id))
        ids.push(id);
    }
  } catch {
    return [];
  }
  const found = await Promise.all(
    ids.slice(0, 6).map(async (stationId) => {
      try {
        const snapshot = await api(
          `/api/station?${new URLSearchParams({ station_id: stationId })}`,
        );
        if (snapshot.saved) return null;
        return { stationId, expiresAt: Number(snapshot.expires_at || 0) };
      } catch (error) {
        if (error.status === 404)
          window.ZakStorage.remove(`zak-radio-owner:${stationId}`);
        return null;
      }
    }),
  );
  return found.filter(Boolean);
}

async function endTemporaryStation(stationId) {
  const ownerToken = ownerTokenFor(stationId);
  if (!ownerToken) return { ok: false, message: "This device can’t end it." };
  try {
    await api(`/api/stations/${encodeURIComponent(stationId)}`, {
      method: "DELETE",
      body: { owner_token: ownerToken },
    });
  } catch (error) {
    if (error.status !== 404) {
      return {
        ok: false,
        message: failureSentence(error, "the station didn’t end"),
      };
    }
  }
  window.ZakStorage.remove(`zak-radio-owner:${stationId}`);
  // A slot just freed up, so the next start shouldn't wait out the guard.
  state.stationCapacityRetryAt = 0;
  if (state.stationId === stationId) await switchStation("main", "");
  return { ok: true };
}

async function createTemporaryStation({ trackId } = {}) {
  if (state.stationCreatePending)
    return { ok: false, message: "A station is already being started." };
  if (performance.now() < state.stationCapacityRetryAt)
    return state.lastCapacityFailure;
  state.stationCreatePending = true;
  renderStationPanel();
  try {
    let attempt = null;
    try {
      attempt = JSON.parse(
        window.ZakStorage.get("zak-radio-create-attempt", "null"),
      );
    } catch {}
    if (!attempt?.idempotency_key || !attempt?.owner_token) {
      attempt = {
        idempotency_key: randomBrowserHex(16),
        owner_token: randomBrowserHex(24),
      };
      window.ZakStorage.set(
        "zak-radio-create-attempt",
        JSON.stringify(attempt),
      );
    }
    // Without a chosen song, the station starts with the one on Radio.
    const radioTrack = trackId ? null : currentTrack();
    const firstTrackId = trackId || radioTrack?.id || state.tracks[0]?.id;
    const created = await api("/api/stations", {
      method: "POST",
      body: {
        track_id: firstTrackId,
        idempotency_key: attempt.idempotency_key,
        owner_token: attempt.owner_token,
      },
    });
    window.ZakStorage.remove("zak-radio-create-attempt");
    window.ZakStorage.set(
      `zak-radio-owner:${created.station_id}`,
      created.owner_token,
    );
    const loaded = await switchStation(
      created.station_id,
      created.owner_token,
      { history: "push" },
    );
    if (!loaded) {
      return {
        ok: false,
        stationId: created.station_id,
        message:
          "The station started, but it didn’t load. Try again from Radio.",
      };
    }
    // A new station starts playing, here and for anyone with the link.
    state.userActivatedAudio = true;
    if (state.station && !state.station.playing)
      await resumeForEveryone({ listen: true, quiet: true });
    else await listenLive();
    // What it starts with, so the confirmation can say so.
    return {
      ok: true,
      stationId: created.station_id,
      firstTrack: trackById(firstTrackId),
      fromRadio: Boolean(radioTrack),
    };
  } catch (error) {
    if (error.status === 429) {
      if (!/capacity/i.test(error.detail || "")) {
        return {
          ok: false,
          message:
            "Too many stations were started just now. Wait a minute and try again.",
        };
      }
      const failure = capacityFailure(error);
      state.lastCapacityFailure = failure;
      state.stationCapacityRetryAt = performance.now() + 5000;
      return failure;
    }
    if (error.status === 400)
      window.ZakStorage.remove("zak-radio-create-attempt");
    return {
      ok: false,
      message: failureSentence(error, "the station didn’t start"),
    };
  } finally {
    state.stationCreatePending = false;
    renderStationPanel();
  }
}

// A full house, said plainly: how many stations fit, how many there are, and
// that temporary and saved stations count alike.
function capacityFailure(error) {
  const retryAfter = Number(error?.retryAfter || 0);
  const limit = Number(error?.limit || 0);
  const perCreator = error?.limitScope !== "service";
  const savedOnly = /saved stations/i.test(error?.detail || "");
  const count = limit ? plural(limit, "station") : "";
  let message = perCreator
    ? limit
      ? `Up to ${count} can run here at once, and all ${limit} are in use.`
      : "The stations people here started have reached the limit."
    : limit
      ? `Zak Radio has room for ${count} at once, and all of them are in use.`
      : "Zak Radio has no room for another station right now.";
  if (perCreator) message += " Temporary and saved stations both count.";
  if (retryAfter)
    message += ` ${perCreator ? "A temporary station" : "The next temporary station"} ends in ${durationWords(retryAfter)} unless it’s used again.`;
  return {
    ok: false,
    reason: "capacity",
    retryAfter,
    limit,
    perCreator,
    savedOnly,
    message,
  };
}
window.ZakCapacityFailure = capacityFailure;

// A station the listener chooses is a place of its own in history ("push"),
// so Back returns to the previous station and never leaves the app from the
// first switch. Switches the app makes itself (a station that ended or
// expired) replace the entry instead.
async function switchStation(
  stationId,
  ownerToken,
  { updateURL = true, history = "replace" } = {},
) {
  state.controlGeneration++;
  state.controlQueue = Promise.resolve();
  state.stationRequestGeneration++;
  state.stationId = stationId || "main";
  state.ownerToken = ownerToken || "";
  state.autoListen = false;
  state.resumeHere = false;
  els.shareFallback.hidden = true;
  rememberStation(state.stationId);
  if (updateURL && window.location.pathname === "/") {
    const url = new URL(window.location.href);
    if (state.stationId === "main") url.searchParams.delete("station");
    else url.searchParams.set("station", state.stationId);
    if (history === "push") router.push(url, { focus: "#stationSwitch" });
    else router.replace(url);
  }
  router.syncLinks();
  renderStationPicker();
  setStationLoading();
  connectStationEvents();
  const generation = state.stationRequestGeneration;
  const loaded = await refreshStation();
  if (
    !loaded &&
    generation === state.stationRequestGeneration &&
    !state.station
  ) {
    setStationUnavailable(state.lastFailure || failureKind(null));
  }
  return loaded;
}

function listenLink(stationId) {
  const url = new URL(window.location.origin + "/");
  url.searchParams.set("station", stationId);
  return url.toString();
}

// Copies a station's listen-only link and confirms it. When the clipboard
// isn't available the caller shows the link in a field to copy by hand.
async function copyListenLink(stationId) {
  const url = listenLink(stationId);
  try {
    await navigator.clipboard.writeText(url);
    notify(
      "Link copied. People with it can listen but can’t change the station.",
    );
    return { ok: true, url };
  } catch {
    return { ok: false, url };
  }
}

async function toggleRepeatOne() {
  const station = state.station;
  const enabled = !station?.repeat_one;
  if (station) {
    station.repeat_one = enabled;
    renderStation();
  }
  const result = await postControl(
    "set_repeat_one",
    { repeat_one: enabled },
    { outcome: "Repeat didn’t change", retry: toggleRepeatOne },
  );
  if (!result && state.station === station && station) {
    station.repeat_one = !enabled;
    renderStation();
  }
}

async function toggleShuffle() {
  const station = state.station;
  const enabled = !station?.shuffle;
  if (station) {
    station.shuffle = enabled;
    renderStation();
  }
  const result = await postControl(
    "set_shuffle",
    { shuffle: enabled },
    { outcome: "Shuffle didn’t change", retry: toggleShuffle },
  );
  if (!result && state.station === station && station) {
    station.shuffle = !enabled;
    renderStation();
  }
}

// Playback settings change the station for everyone listening, so they
// confirm like Pause and Skip do, with Undo.
const RANDOM_MODE_NAMES = {
  deck: "No repeats",
  true_random: "Shuffle with repeats",
};

function settingReach() {
  return stationKind() === "main" ? " for everyone" : ` on “${stationLabel()}”`;
}

async function setRandomMode(mode, { undo = false } = {}) {
  const station = state.station;
  const previous = station?.random_mode || "deck";
  if (!station || mode === previous) {
    renderSettings();
    return;
  }
  const result = await postControl(
    "set_station_random_mode",
    { random_mode: mode },
    {
      outcome: "the playback order didn’t change",
      retry: () => setRandomMode(mode, { undo }),
    },
  );
  if (!result) {
    setRadioGroupValue(
      els.stationRandomMode,
      state.station?.random_mode || "deck",
    );
    renderSettings();
    return;
  }
  const name = RANDOM_MODE_NAMES[mode] || mode;
  notify(
    undo
      ? `Playback order is back to ${name}${settingReach()}.`
      : `Playback order is now ${name}${settingReach()}.`,
    undo
      ? {}
      : {
          action: {
            label: "Undo",
            run: () => setRandomMode(previous, { undo: true }),
          },
        },
  );
}

async function setSkipDisliked(enabled, { undo = false } = {}) {
  const station = state.station;
  if (!station || Boolean(station.skip_disliked) === enabled) {
    renderSettings();
    return;
  }
  const result = await postControl(
    "set_station_skip_disliked",
    { skip_disliked: enabled },
    {
      outcome: "Skip disliked didn’t change",
      retry: () => setSkipDisliked(enabled, { undo }),
    },
  );
  if (!result) {
    els.stationSkipDisliked.checked = Boolean(state.station?.skip_disliked);
    renderSettings();
    return;
  }
  const message = enabled
    ? `Disliked songs are now skipped${settingReach()}.`
    : `Disliked songs play again${settingReach()}.`;
  notify(
    message,
    undo
      ? {}
      : {
          action: {
            label: "Undo",
            run: () => setSkipDisliked(!enabled, { undo: true }),
          },
        },
  );
}

// ---- Reactions: one per listener (this browser) and song ----
function adjustReactionCounts(track, from, to) {
  const delta = { like: 0, dislike: 0 };
  if (from) delta[from] -= 1;
  if (to) delta[to] += 1;
  track.like_count = Math.max(0, Number(track.like_count || 0) + delta.like);
  track.dislike_count = Math.max(
    0,
    Number(track.dislike_count || 0) + delta.dislike,
  );
  if (state.station?.track_id === track.id) mergeCurrentStats(state.station);
}

function postReaction(trackId, reaction, remove = false) {
  return api("/api/reaction", {
    method: "POST",
    body: remove
      ? { track_id: trackId, reaction, remove: true }
      : { track_id: trackId, reaction },
  });
}

// Any song's reaction: Radio's own row, and the full player for Radio and
// Library previews. Counts change at once and roll back if the change
// doesn't go through.
async function toggleReaction(reaction, track = currentTrack()) {
  if (!track) return;
  const trackId = track.id;
  const previous = storedReaction(trackId);
  const next = previous === reaction ? "" : reaction;
  if (!state.confirmedReactions.has(trackId))
    state.confirmedReactions.set(trackId, previous);
  writeReaction(trackId, next);
  adjustReactionCounts(track, previous, next);
  renderReactions();
  player?.update();
  const queued = state.reactionQueues.get(trackId) || Promise.resolve();
  // Each toggle moves the server from what it last accepted to this toggle's
  // choice, so an earlier failure can't make a later one undo a reaction
  // this browser never added.
  const mutation = queued
    .catch(() => {})
    .then(async () => {
      try {
        const confirmed = state.confirmedReactions.get(trackId) || "";
        if (confirmed && confirmed !== next) {
          applyTrackStats(await postReaction(trackId, confirmed, true));
          state.confirmedReactions.set(trackId, "");
        }
        if (next && confirmed !== next) {
          applyTrackStats(await postReaction(trackId, next));
          state.confirmedReactions.set(trackId, next);
        }
      } catch (error) {
        // A newer toggle is queued: it reconciles from the confirmed
        // reaction, so leave its selection on screen.
        if (state.reactionQueues.get(trackId) !== mutation) return;
        const saved = state.confirmedReactions.get(trackId) || "";
        adjustReactionCounts(track, storedReaction(trackId), saved);
        writeReaction(trackId, saved);
        renderReactions();
        window.ZakCatalog.notify();
        player?.update();
        notifyFailure(error, "your reaction wasn’t saved", () =>
          toggleReaction(reaction, track),
        );
      }
    });
  state.reactionQueues.set(trackId, mutation);
  await mutation;
  if (state.reactionQueues.get(trackId) === mutation) {
    state.reactionQueues.delete(trackId);
    state.confirmedReactions.delete(trackId);
  }
}

// The full player shows reactions for whatever song it plays.
function reactionView(track) {
  if (!track) return null;
  const reaction = storedReaction(track.id);
  return {
    liked: reaction === "like",
    disliked: reaction === "dislike",
    likes: Number(track.like_count || 0),
    dislikes: Number(track.dislike_count || 0),
    toggle: (kind) => toggleReaction(kind, track),
  };
}
window.ZakReactions = { view: reactionView };

async function boot(forceCatalog = false) {
  const stationId = requestedStation();
  state.stationId = stationId;
  state.ownerToken = ownerTokenFor(stationId);
  rememberStation(stationId);
  router.syncLinks();
  setStationLoading();
  if (!state.stations.length || state.stationsFailed)
    void loadStations().catch(() => {});
  try {
    await loadCatalog(forceCatalog);
  } catch (error) {
    els.shellContext.textContent = "Library unavailable";
    state.catalogError = error;
    scheduleBootRetry();
  }
  if (!state.catalogError) bootRetryAttempt = 0;
  updateShellContext();
  try {
    await refreshStation(false, true);
    connectStationEvents();
    if (state.invalidStationLink) {
      state.invalidStationLink = false;
      notify("That station link doesn’t work. Showing All songs instead.");
    }
  } catch (error) {
    setStationUnavailable(failureKind(error));
    connectStationEvents();
  }
  window.clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(refreshStation, 5000);
}

// Without the catalog nothing can play, so keep retrying in the background.
let bootRetryTimer = 0;
let bootRetryAttempt = 0;
function scheduleBootRetry() {
  window.clearTimeout(bootRetryTimer);
  const delay = Math.min(60_000, 5000 * 2 ** bootRetryAttempt++);
  bootRetryTimer = window.setTimeout(async () => {
    if (!state.catalogError) return;
    try {
      await loadCatalog(true);
      bootRetryAttempt = 0;
      if (state.station) await refreshStation(true);
      else await boot(false);
    } catch {
      scheduleBootRetry();
    }
  }, delay);
}

window.ZakRecoverShell = async () => {
  if (state.station && state.tracks.length) await refreshStation(true);
  else if (!state.station || !state.eventSource) await boot(false);
};

// ---- Lyrics ----
const lyrics = createLyricsView({
  els: {
    lyrics: els.lyrics,
    lyricsContext: els.lyricsContext,
    lyricsViewport: els.lyricsViewport,
    lyricsFrame: els.lyricsFrame,
    lyricsFade: els.lyricsFade,
    lyricsMoreRow: els.lyricsMoreRow,
    toggleLyrics: els.toggleLyrics,
    lyricsFollow: els.lyricsFollow,
    lyricsSyncStatus: els.lyricsSyncStatus,
    lyricsLegend: els.lyricsLegend,
    lyricsQuality: byId("lyricsQuality"),
    lyricsQualityLabel: byId("lyricsQualityLabel"),
    lyricsQualityNotes: byId("lyricsQualityNotes"),
    prompt: els.prompt,
    promptMeta: els.promptMeta,
    promptMetaList: els.promptMetaList,
  },
  api,
  currentTrackId: () => state.current?.id,
  position: radioPosition,
  canSeek: seekableStation,
  seek: (position) => seekStation(position),
  isLive: () => Boolean(state.station?.playing),
  onAvailability(kind) {
    state.lyricsKind = kind;
    placeQueue();
    player?.update();
  },
});

// ---- Media Session ----
function setMediaAction(action, handler) {
  try {
    navigator.mediaSession.setActionHandler(action, handler);
  } catch {}
}

// Register only what this listener can use, so the OS hides dead buttons.
// Lock-screen Pause stays personal; Next on Radio changes the station.
function syncMediaSessionActions() {
  if (!("mediaSession" in navigator)) return;
  const owner = audioController.owner;
  const reader = window.ZakReader;
  const stationControl =
    owner === "radio" && Boolean(state.station) && canControlStation();
  let next = null;
  let previous = null;
  let seek = null;
  if (owner === "reader") {
    if (typeof reader?.nextSegment === "function")
      next = () => reader.nextSegment();
    if (typeof reader?.previousSegment === "function")
      previous = () => reader.previousSegment();
    seek = {
      by: (offset) => reader?.seekBy?.(offset),
      to: (position) => reader?.seekTo?.(position),
    };
  } else if (owner === "library") {
    seek = {
      by: (offset) => {
        const duration = els.audio.duration || Infinity;
        els.audio.currentTime = Math.max(
          0,
          Math.min(duration, (els.audio.currentTime || 0) + offset),
        );
      },
      to: (position) => {
        els.audio.currentTime = position;
      },
    };
  } else if (stationControl && seekableStation()) {
    next = function skipSong() {
      return postControl(
        "next",
        {},
        { outcome: "the skip didn’t happen", retry: skipSong },
      );
    };
    previous = () => previousSong();
    seek = {
      by: (offset) => seekStationBy(offset),
      to: (position) => seekStation(position),
    };
  } else if (stationControl) {
    next = () => skipForEveryone();
  }
  setMediaAction("nexttrack", next);
  setMediaAction("previoustrack", previous);
  setMediaAction(
    "seekbackward",
    seek ? (details) => seek.by(-Number(details?.seekOffset || 10)) : null,
  );
  setMediaAction(
    "seekforward",
    seek ? (details) => seek.by(Number(details?.seekOffset || 10)) : null,
  );
  setMediaAction(
    "seekto",
    seek ? (details) => seek.to(Number(details?.seekTime || 0)) : null,
  );
}

async function handleMediaCommand(command) {
  if (command === "play") {
    if (!audioController.owner) {
      // Nothing owns the element after Stop; Play returns to the station.
      if (state.station?.playing) await listenLive();
    } else if (audioController.is("reader") && window.ZakReader?.play) {
      // ZakReader.play toggles, so a repeated Play must not pause Reader.
      if (els.audio.paused) await window.ZakReader.play();
    } else if (!audioController.is("radio")) {
      await audioController.play();
    } else if (state.station?.playing) {
      await listenLive();
    }
  } else if (command === "pause") {
    if (audioController.is("radio") && state.station?.playing) {
      state.localRadioSuspended = true;
    }
    audioController.pause();
    renderStation();
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
  setMediaAction("play", () => handleMediaCommand("play"));
  setMediaAction("pause", () => handleMediaCommand("pause"));
}

// ---- Volume (desktop) ----
els.radioVolume.append(createVolumeControl({ audio: els.audio }));

// ---- Event wiring ----
els.playPause.addEventListener("click", primaryAction);
els.stationPause.addEventListener("click", toggleStationForEveryone);
els.next.addEventListener("click", skipForEveryone);
els.next.addEventListener("blur", renderStationControls);
els.prev.addEventListener("click", () => previousSong());
els.back10.addEventListener("click", () => seekStationBy(-10));
els.forward10.addEventListener("click", () => seekStationBy(10));
els.random.addEventListener("click", toggleShuffle);
els.repeatOne.addEventListener("click", toggleRepeatOne);
els.like.addEventListener("click", () => toggleReaction("like"));
els.dislike.addEventListener("click", () => toggleReaction("dislike"));
els.titleToggle.addEventListener("click", () => {
  state.titleExpanded = !state.titleExpanded;
  renderTitleClamp();
});
if ("ResizeObserver" in window) {
  new ResizeObserver(() => {
    if (state.current) renderTitleClamp();
  }).observe(els.title);
}
// ---- Song details ----
// Details use the same dismissible sheet at every width, leaving lyrics in
// place. The button opens that dialog, so it keeps its name and has no
// expanded state of its own.
function detailsOpen() {
  return !els.promptPanel.hidden;
}

function homeDetails() {
  if (els.transcript.nextElementSibling !== els.promptPanel)
    els.transcript.after(els.promptPanel);
}

function setDetailsOpen(open) {
  if (!open) {
    if (els.songDetailsSheet.open) els.songDetailsSheet.close();
    homeDetails();
    els.promptPanel.hidden = true;
    return;
  }
  els.songDetailsSheetBody.append(els.promptPanel);
  els.promptPanel.hidden = false;
  if (!els.songDetailsSheet.open) els.songDetailsSheet.showModal();
  els.promptTitle.focus({ preventScroll: true });
}

els.toggleDetails.addEventListener("click", () => setDetailsOpen(true));
els.promptClose.addEventListener("click", () => {
  setDetailsOpen(false);
  els.toggleDetails.focus({ preventScroll: true });
});
els.songDetailsSheet.addEventListener("close", () => {
  if (!detailsOpen()) return;
  setDetailsOpen(false);
  if (!document.querySelector("dialog[open]"))
    els.toggleDetails.focus({ preventScroll: true });
});
els.songDetailsSheet.addEventListener("click", (event) => {
  if (event.target !== els.songDetailsSheet) return;
  const box = els.songDetailsSheet.getBoundingClientRect();
  if (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  )
    setDetailsOpen(false);
});

// Up next keeps one home at each breakpoint, independent of lyrics.
function placeQueue() {
  if (desktop.matches) {
    if (els.radioQueue.parentElement !== els.radioSecondary)
      els.radioSecondary.prepend(els.radioQueue);
  } else if (els.radioQueue.previousElementSibling !== els.radioSide) {
    els.radioSide.after(els.radioQueue);
  }
  // Catalog metadata selects the layout before the lyrics request finishes.
  // Loading (or a text-fetch failure) never hides or relocates the controls.
  const layout = state.current
    ? state.current.has_lyrics || state.current.has_synced_lyrics
      ? "available"
      : "none"
    : state.lyricsKind;
  els.radioView.dataset.lyrics =
    layout === "none" && els.radioSide.contains(document.activeElement)
      ? "available"
      : layout;
  if (
    document.documentElement.dataset.keyboard === "true" &&
    els.radioSecondary.contains(document.activeElement)
  ) {
    const focused = document.activeElement;
    window.requestAnimationFrame(() => {
      if (
        document.activeElement !== focused ||
        document.documentElement.dataset.keyboard !== "true"
      )
        return;
      // Lyrics and the queue layout can move the focused settings column.
      // Native scrolling respects the header and player's scroll padding.
      focused.scrollIntoView({ block: "nearest", behavior: "instant" });
    });
  }
  const available =
    Boolean(state.current) && ["timed", "plain"].includes(state.lyricsKind);
  // A song change must not remove the keyboard user's current control.
  // Its now-unavailable entry disappears after focus leaves it.
  els.lyricsOpen.hidden =
    !available && document.activeElement !== els.lyricsOpen;
  const quickOpen = byId("lyricsQuickOpen");
  quickOpen.hidden =
    (!available || desktop.matches) && document.activeElement !== quickOpen;
}

els.lyricsOpen.addEventListener("blur", placeQueue);
byId("lyricsQuickOpen").addEventListener("blur", placeQueue);
els.radioSide.addEventListener("focusout", () => {
  requestAnimationFrame(() => {
    if (!els.radioSide.contains(document.activeElement)) placeQueue();
  });
});

desktop.addEventListener("change", () => {
  if (detailsOpen()) setDetailsOpen(false);
  placeQueue();
});

// ---- Lyrics, full screen ----
// Phones follow the song in a view of its own, opened from the player,
// instead of scrolling the page away from the controls. The lyrics move into
// it and back, so they keep their place and follow state.
let lyricsSheetOpener = null;
let lyricsSheetArt = "";

function renderLyricsSheet() {
  if (!els.lyricsSheet.open) return;
  const track = currentTrack();
  setText(els.lyricsSheetTitle, track ? trackDisplayTitle(track) : "Lyrics");
  setText(
    els.lyricsSheetMeta,
    [track?.artist, stationLabel()].filter(Boolean).join(" · "),
  );
  const artKey = track ? `${track.id}:${track.has_cover}` : "";
  if (artKey !== lyricsSheetArt) {
    lyricsSheetArt = artKey;
    if (track?.has_cover) {
      const image = document.createElement("img");
      image.alt = "";
      window.ZakImage(image, mediaCoverURL(track), () =>
        paintArtworkFallback(els.lyricsSheetArt, track.id),
      );
      els.lyricsSheetArt.classList.remove("has-art-seed");
      els.lyricsSheetArt.replaceChildren(image);
    } else if (track) {
      paintArtworkFallback(els.lyricsSheetArt, track.id);
    }
  }
  const action = listenerAction();
  setAttribute(els.lyricsSheetToggle, "aria-label", action.label);
  els.lyricsSheetToggle.title = action.label;
  if (els.lyricsSheetToggle.dataset.icon !== action.icon) {
    els.lyricsSheetToggle.dataset.icon = action.icon;
    els.lyricsSheetToggle.innerHTML =
      action.icon === "play" ? PLAY_ICON : STOP_ICON;
  }
  els.lyricsSheetToggle.disabled = action.disabled;
  // The same station-wide controls as Shared controls: Pause becomes Resume
  // while the station is paused.
  setText(byId("lyricsSheetScope"), stationScope());
  setText(
    lyricsSheetPause,
    state.station?.playing === false ? resumeLabel() : pauseLabel(),
  );
  lyricsSheetShared.hidden = !(
    canControlStation() &&
    state.station &&
    !emptyStation() &&
    !connectionLost()
  );
  const reaction = track ? reactionView(track) : null;
  for (const [button, pressed, count] of [
    [lyricsSheetLike, reaction?.liked, reaction?.likes],
    [lyricsSheetDislike, reaction?.disliked, reaction?.dislikes],
  ]) {
    button.setAttribute("aria-pressed", String(Boolean(pressed)));
    button.disabled = !track || Boolean(els.like.disabled);
    setText(button.lastElementChild, String(Number(count) || 0));
  }
}

function openLyricsSheet(opener = document.activeElement) {
  if (!state.current) return;
  lyricsSheetOpener = opener;
  if (state.lyricsKind === "loading") lyrics.load(state.current);
  els.lyricsSheetSlot.append(
    els.lyricsContext,
    els.lyricsFrame,
    els.lyricsMoreRow,
    els.lyricsFollow,
  );
  if (!els.lyricsSheet.open) els.lyricsSheet.showModal();
  lyrics.setMode("sheet");
  renderLyricsSheet();
  els.lyricsSheetClose.focus({ preventScroll: true });
}

els.lyricsSheet.addEventListener("close", () => {
  els.transcriptHead.after(els.lyricsContext);
  els.lyricsContext.after(els.lyricsFrame);
  els.lyricsFrame.after(els.lyricsMoreRow);
  els.lyricsMoreRow.after(els.lyricsFollow);
  lyrics.setMode("page");
  const opener = lyricsSheetOpener;
  lyricsSheetOpener = null;
  if (opener?.checkVisibility({ visibilityProperty: true }))
    opener.focus({ preventScroll: true });
  else if (els.radioView.checkVisibility({ visibilityProperty: true }))
    (els.playPause.disabled ? els.title : els.playPause).focus({
      preventScroll: true,
    });
});
els.lyricsSheetClose.addEventListener("click", () => els.lyricsSheet.close());
els.lyricsSheetToggle.addEventListener("click", () => primaryAction());
els.lyricsOpen.addEventListener("click", () => openLyricsSheet(els.lyricsOpen));
byId("lyricsQuickOpen").addEventListener("click", () =>
  openLyricsSheet(byId("lyricsQuickOpen")),
);
lyricsSheetLike.addEventListener("click", () => els.like.click());
lyricsSheetDislike.addEventListener("click", () => els.dislike.click());
byId("stationShareNearby").addEventListener("click", async () => {
  const result = await copyListenLink(state.stationId);
  if (!result.ok) {
    openStationSheet();
    els.shareLink.value = result.url;
    els.shareFallback.hidden = false;
    els.shareLink.focus();
    els.shareLink.select();
  }
});
let queueDetailsOpener = null;
function openQueueDetails(track, opener) {
  queueDetailsOpener = opener;
  setText(byId("queueDetailsTitle"), trackDisplayTitle(track));
  setText(
    byId("queueDetailsMeta"),
    [track.artist, trackDisplayGroup(track), timeLabel(track.duration)]
      .filter(Boolean)
      .join(" · "),
  );
  setText(
    byId("queueDetailsDescription"),
    track.summary || track.search_text || "No description available.",
  );
  byId("queueDetailsDownload").href = mediaAudioURL(track);
  byId("queueDetails").showModal();
}
byId("queueDetailsClose").addEventListener("click", () =>
  byId("queueDetails").close(),
);
byId("queueDetails").addEventListener("close", () => {
  if (queueDetailsOpener?.isConnected)
    queueDetailsOpener.focus({ preventScroll: true });
  else els.radioQueueTitle.focus({ preventScroll: true });
});

// ---- Station sheet: the station switcher, its access, and its actions ----
// The station name at the top of Radio opens it. It lists the stations, says
// who can change the one playing, and holds Edit, Share, End, and New.
function openStationSheet() {
  renderStationPicker();
  renderStationPanel();
  els.shareFallback.hidden = true;
  disarmEndStation();
  if (!els.stationSheet.open) els.stationSheet.showModal();
  els.stationSwitch.setAttribute("aria-expanded", "true");
  (
    els.stationOptions.querySelector('[aria-current="true"]') ||
    els.stationOptions.querySelector("button")
  )?.focus({ preventScroll: true });
}

function closeStationSheet() {
  if (els.stationSheet.open) els.stationSheet.close();
}

els.stationSwitch.addEventListener("click", openStationSheet);
els.stationSheetClose.addEventListener("click", closeStationSheet);
els.stationSheet.addEventListener("close", () => {
  els.stationSwitch.setAttribute("aria-expanded", "false");
  disarmEndStation();
  // Another dialog may take over (New station, Edit); it handles focus.
  window.setTimeout(() => {
    if (!document.querySelector("dialog[open]") && !stationSheetHandoff)
      els.stationSwitch.focus({ preventScroll: true });
    stationSheetHandoff = false;
  });
});
let stationSheetHandoff = false;
els.stationSheet.addEventListener("click", (event) => {
  if (event.target !== els.stationSheet) return;
  const box = els.stationSheet.getBoundingClientRect();
  const inside =
    event.clientX >= box.left &&
    event.clientX <= box.right &&
    event.clientY >= box.top &&
    event.clientY <= box.bottom;
  if (!inside) closeStationSheet();
});
els.stationOptions.addEventListener("click", async (event) => {
  const option = event.target.closest?.("[data-station-id]");
  if (!option) return;
  const stationId = option.dataset.stationId;
  closeStationSheet();
  if (stationId === state.stationId) return;
  await tuneTo(stationId);
});

// Choosing a station while listening means "play this". A live station plays
// at once; a paused one this browser controls starts in the same step, with
// Undo; one it doesn't control is waited for, as Radio itself shows. Back and
// Forward (fromHistory) keep listening to a live station but never start
// one for everyone.
async function tuneTo(stationId, { fromHistory = false } = {}) {
  const previous = {
    id: state.stationId,
    label: stationLabel(),
    hearing: radioHearing(),
  };
  const listening = previous.hearing || state.autoListen;
  await switchStation(stationId, ownerTokenFor(stationId), {
    updateURL: !fromHistory,
    history: "push",
  });
  const station = state.station;
  if (!listening || state.stationId !== stationId || !station) return;
  state.userActivatedAudio = true;
  if (station.playing) {
    await listenLive();
    return;
  }
  if (fromHistory) return;
  const back = {
    label: `Back to “${previous.label}”`,
    run: () => returnToStation(previous),
  };
  if (canControlStation() && !emptyStation()) {
    const starting = neverPlayed(station);
    const started = await resumeForEveryone({ listen: true, quiet: true });
    if (!started) return;
    notify(
      `${starting ? "Started" : "Resumed"} “${stationLabel()}”${stationReach()}. You’re listening.`,
      {
        action: {
          label: "Undo",
          run: async () => {
            await postControl(
              "pause",
              {},
              { outcome: "the station wasn’t paused again" },
            );
            await returnToStation(previous);
          },
        },
      },
    );
    return;
  }
  if (emptyStation()) {
    notify(`No songs match “${stationLabel()}” yet, so nothing is playing.`, {
      action: back,
    });
    return;
  }
  // The big button and its note say this device is waiting, with Listen to
  // All songs beside them, and the status region announces it.
  state.autoListen = true;
  renderStation();
}

async function returnToStation(previous) {
  await switchStation(previous.id, ownerTokenFor(previous.id), {
    history: "push",
  });
  if (previous.hearing && state.station?.playing) await listenLive();
  notify(`Back to “${stationLabel()}”.`);
}
// Arrow keys move through the list, as in a menu.
els.stationOptions.addEventListener("keydown", (event) => {
  const items = [...els.stationOptions.querySelectorAll("button")];
  const index = items.indexOf(document.activeElement);
  let next = -1;
  if (event.key === "ArrowDown") next = (index + 1) % items.length;
  else if (event.key === "ArrowUp")
    next = (index - 1 + items.length) % items.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  if (next < 0) return;
  event.preventDefault();
  items[next].focus();
});

function handOffStationSheet() {
  stationSheetHandoff = true;
  closeStationSheet();
}

els.createStation.addEventListener("click", () => {
  handOffStationSheet();
  window.dispatchEvent(
    new CustomEvent("zak-new-station", {
      detail: { opener: els.stationSwitch },
    }),
  );
});
els.editStation.addEventListener("click", () => {
  handOffStationSheet();
  window.dispatchEvent(
    new CustomEvent("zak-edit-station", {
      detail: { stationId: state.stationId, opener: els.stationSwitch },
    }),
  );
});
els.stationMenu
  .querySelector("#yourStations")
  ?.addEventListener("click", () => closeStationSheet());
// Ending can't be undone, so the first press asks for a second one.
let endStationArmed = 0;
function disarmEndStation() {
  window.clearTimeout(endStationArmed);
  endStationArmed = 0;
  setText(els.endStation, "End this temporary station");
  els.endStation.classList.remove("is-danger");
}
els.endStation.addEventListener("click", async () => {
  if (!endStationArmed) {
    setText(els.endStation, "Press again to end it for everyone");
    els.endStation.classList.add("is-danger");
    endStationArmed = window.setTimeout(disarmEndStation, 5000);
    return;
  }
  disarmEndStation();
  closeStationSheet();
  const stationId = state.stationId;
  const result = await endTemporaryStation(stationId);
  if (result.ok) {
    notify("Ended your temporary station. Now playing All songs.");
    els.title.focus({ preventScroll: true });
  } else {
    notify(result.message, { tone: "error" });
  }
});
els.listenMain.addEventListener("click", listenToMain);
els.stationRandomMode.addEventListener("change", (event) => {
  if (!event.target.matches('input[type="radio"]')) return;
  void setRandomMode(radioGroupValue(els.stationRandomMode));
});
els.stationSkipDisliked.addEventListener("change", () =>
  setSkipDisliked(els.stationSkipDisliked.checked),
);
els.addCurrentToStation.addEventListener("click", () => {
  const track = currentTrack();
  if (track) openAddToStation(track, els.addCurrentToStation);
});
els.addToStationList.addEventListener("change", (event) => {
  const input = event.target.closest?.("input[data-station-id]");
  if (!input) return;
  void setStationMembership(
    input.dataset.stationId,
    addToStationTrack,
    input.checked,
  );
});
els.addToStationNew.addEventListener("click", () => {
  const track = addToStationTrack;
  const opener = addToStationOpener;
  addToStationOpener = null;
  els.addToStationDialog.close();
  window.dispatchEvent(
    new CustomEvent("zak-new-list-station", { detail: { track, opener } }),
  );
});
els.addToStationDialog.addEventListener("close", () => {
  const opener = addToStationOpener;
  addToStationOpener = null;
  // The change made there, confirmed where it can still be undone.
  const change = addToStationChange;
  addToStationChange = null;
  if (change)
    notify(membershipWords(change), {
      action: { label: "Undo", run: () => undoMembership(change) },
    });
  if (opener?.isConnected) {
    window.setTimeout(() => {
      if (!document.querySelector("dialog[open]"))
        opener.focus({ preventScroll: true });
    });
  }
});
els.shareStation.addEventListener("click", async () => {
  const result = await copyListenLink(state.stationId);
  if (result.ok) {
    closeStationSheet();
    return;
  }
  els.shareLink.value = result.url;
  els.shareFallback.hidden = false;
  els.shareLink.focus();
  els.shareLink.select();
});
els.shareClose.addEventListener("click", () => {
  els.shareFallback.hidden = true;
  closeStationSheet();
});
els.radioRetry.addEventListener("click", async () => {
  els.radioRetry.disabled = true;
  try {
    if (state.tracks.length) {
      await switchStation(state.stationId, state.ownerToken, {
        updateURL: false,
      });
      if (!state.pollTimer)
        state.pollTimer = window.setInterval(refreshStation, 5000);
    } else {
      await boot(true);
    }
  } finally {
    els.radioRetry.disabled = false;
  }
  // Loading hides the button; keep focus on the result instead of <body>.
  if (state.station) els.title.focus({ preventScroll: true });
  else if (!els.radioErrorActions.hidden)
    els.radioRetry.focus({ preventScroll: true });
});
els.radioMainStation.addEventListener("click", async () => {
  await switchStation("main", "");
  if (state.station) els.title.focus({ preventScroll: true });
});
window.addEventListener("zak-stations", () => {
  renderStationPicker();
  renderStationPanel();
});
// Another source taking the shared audio says so, with the way back. Reader
// says it for its narration; a Library preview says it for itself.
window.addEventListener("zak-audio-release", (event) => {
  const { owner, nextOwner, playing } = event.detail || {};
  if (owner !== "radio" || nextOwner !== "reader" || !playing) return;
  notify("Radio paused for Reader.", {
    action: { label: "Listen live", run: () => listenLive() },
  });
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
  audioErrorNotice?.dismiss();
  audioErrorNotice = null;
  if (audioController.is("radio")) renderStation();
  updateNowPlayingMetadata();
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
  if (radioShouldBeAudible()) schedulePlaybackRecovery(1500);
});
els.audio.addEventListener("playing", () => {
  clearPlaybackRecovery();
  if (audioController.is("radio")) announceNowPlaying();
  updateNowPlayingMetadata();
  if (connectionLost() && audioController.is("radio")) renderListener();
});
els.audio.addEventListener("waiting", () => {
  updateNowPlayingMetadata();
  schedulePlaybackRecovery(2500);
  if (connectionLost() && audioController.is("radio")) renderListener();
});
els.audio.addEventListener("stalled", () => schedulePlaybackRecovery(1000));
window.addEventListener("zak-audio-owner", renderStation);
els.audio.addEventListener("timeupdate", () => {
  if (!audioController.is("radio")) return;
  if (
    !els.audio.paused &&
    !els.audio.seeking &&
    els.audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
  ) {
    clearPlaybackRecovery();
  }
  if (radioHearing()) {
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

window.addEventListener("online", () => {
  renderConnection();
  renderStatus();
  if (state.stationError && !state.tracks.length) void boot(true);
  else void refreshStation(true);
  schedulePlaybackRecovery(0);
});
// The browser knows the network is gone before the next poll fails.
window.addEventListener("offline", () => {
  state.lastFailure = "offline";
  if (state.station) setConnected(false);
  else {
    renderConnection();
    renderStatus();
  }
});

// On Radio, the docked player takes over as soon as the song's progress
// scrolls under the header, at every width, so progress and Stop never
// scroll away with it.
let dockFrame = 0;
function syncRadioDock() {
  dockFrame = 0;
  let offscreen = false;
  if (router.path() === "/") {
    const rail = document.querySelector(".app-rail");
    const top = rail ? Math.max(0, rail.getBoundingClientRect().bottom) : 0;
    const progress = els.stationProgress.getBoundingClientRect();
    offscreen = progress.height > 0 && progress.bottom < top + 4;
  }
  if (offscreen === state.transportOffscreen) return;
  state.transportOffscreen = offscreen;
  player.update();
}
function scheduleRadioDock() {
  if (!dockFrame) dockFrame = window.requestAnimationFrame(syncRadioDock);
}
window.addEventListener("scroll", scheduleRadioDock, { passive: true });
window.addEventListener("resize", scheduleRadioDock, { passive: true });
window.addEventListener("zak-route", scheduleRadioDock);
window.addEventListener("pageshow", () => schedulePlaybackRecovery(0));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") schedulePlaybackRecovery(0);
});
let keyboardSeeking = false;
function previewSeek() {
  state.syncingProgress = true;
  const duration = Number(els.progress.max);
  const position = Number(els.progress.value);
  setText(els.currentTime, timeLabel(position));
  setText(els.duration, `−${timeLabel(Math.max(0, duration - position))}`);
  setAttribute(
    els.progress,
    "aria-valuetext",
    `${timeLabel(position)} of ${timeLabel(duration)}`,
  );
  const percent = duration > 0 ? (position / duration) * 100 : 0;
  els.progressFill.style.width = `${percent}%`;
  els.progressThumb.style.left = `${percent}%`;
}
async function commitSeek() {
  if (!state.syncingProgress) return;
  const position = Number(els.progress.value || 0);
  state.syncingProgress = false;
  if (seekableStation()) await seekStation(position);
  else updateProgressFromStation();
}

els.progress.addEventListener("keydown", (event) => {
  if (!(event.key in seekKeys) && !["Home", "End"].includes(event.key)) return;
  if (!seekableStation() || event.altKey || event.ctrlKey || event.metaKey)
    return;
  event.preventDefault();
  keyboardSeeking = true;
  const max = Number(els.progress.max);
  els.progress.value = String(
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? max
        : Math.max(
            0,
            Math.min(max, Number(els.progress.value) + seekKeys[event.key]),
          ),
  );
  previewSeek();
});
els.progress.addEventListener("keyup", (event) => {
  if (!(event.key in seekKeys) && !["Home", "End"].includes(event.key)) return;
  keyboardSeeking = false;
  void commitSeek();
});
els.progress.addEventListener("blur", () => {
  keyboardSeeking = false;
  void commitSeek();
});
els.progress.addEventListener("input", previewSeek);
els.progress.addEventListener("change", () => {
  if (!keyboardSeeking) void commitSeek();
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  const activeTag = target?.tagName || "";
  const typing =
    /^(INPUT|TEXTAREA|SELECT)$/.test(activeTag) || target?.isContentEditable;
  const interactive =
    /^(BUTTON|A|SUMMARY)$/.test(activeTag) ||
    target === els.lyricsViewport ||
    Boolean(target?.closest?.("dialog"));
  if (
    typing ||
    interactive ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey
  )
    return;
  if (event.code === "Space") {
    if (!player.shortcut("toggle")) return;
    event.preventDefault();
  } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    if (!player.shortcut("seekBy", event.key === "ArrowLeft" ? -10 : 10))
      return;
    event.preventDefault();
  }
});

// A private edit link (/library#edit=<station>.<token>) moves editing of a
// saved station to this browser. The secret leaves the address at once.
const EDIT_LINK = /^#edit=([a-f0-9]{32})\.([a-f0-9]{48})$/;
async function claimEditLink() {
  const match = EDIT_LINK.exec(window.location.hash);
  if (!match) return;
  const [, stationId, token] = match;
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(window.history.state, "", url);
  try {
    // An empty change checks the token without changing the station.
    await api(`/api/stations/${encodeURIComponent(stationId)}`, {
      method: "PATCH",
      body: { owner_token: token },
    });
  } catch (error) {
    notify(
      error.status === 403 || error.status === 404 || error.status === 400
        ? "That edit link doesn’t work anymore. Copy a new one from a device that can still edit the station."
        : "Couldn’t check that edit link. Open it again when you’re connected.",
      { tone: "error" },
    );
    return;
  }
  window.ZakStorage.set(`zak-radio-owner:${stationId}`, token);
  if (state.stationId === stationId) {
    state.ownerToken = token;
    if (state.station) state.station.can_control = true;
  }
  await loadStations().catch(() => {});
  renderStation();
  const name = stationDefinition(stationId)?.name;
  notify(
    name
      ? `You can now edit “${name}” on this device too.`
      : "You can now edit that station on this device too.",
  );
}
window.ZakEditLink = (stationId) => {
  const token = ownerTokenFor(stationId);
  if (!token) return "";
  return `${window.location.origin}/library#edit=${stationId}.${token}`;
};

const editClaim = claimEditLink();
router.render();
boot();
initLibrary({ router });
initSongUpload();
initReader({ router });
void editClaim;
syncMediaSessionActions();
window.setInterval(() => {
  if (!state.station || radioHearing()) return;
  if (router.path() === "/" || els.lyricsSheet.open) {
    updateProgressFromStation();
    lyrics.update();
  }
  if (player.shown === "radio") player.update();
}, 500);
