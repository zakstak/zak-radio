import { seekKeys as deltas } from "./motion.js";
import { timeLabel, setText, setAttribute } from "./format.js";
import { artworkSeed, paintArtworkFallback } from "./artwork.js";

// One player for every audio source, in two surfaces: the docked bar and the
// full player sheet. Owners describe what to show; both surfaces keep the
// same words and controls whatever the source is.
//
// Phones get a one-row dock (artwork, title, at most one extra control, and
// play) above the tab bar; tapping it opens the full player sheet with
// everything else. Wider screens keep the full dock.
const OWNER_ROUTES = { radio: "/", library: "/library", reader: "/reader" };
const OWNER_VIEWS = {
  radio: "Open Radio",
  library: "Open Library",
  reader: "Open in Reader",
};

// Play, pause, and stop are solid glyphs of the same optical weight.
export const PLAY_ICON =
  '<svg class="playback-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 6.2v11.6a.8.8 0 0 0 1.2.7l9.3-5.8a.8.8 0 0 0 0-1.4L9.7 5.5a.8.8 0 0 0-1.2.7z"></path></svg>';
export const PAUSE_ICON =
  '<svg class="playback-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5.5" width="4" height="13" rx="1.2"></rect><rect x="13.5" y="5.5" width="4" height="13" rx="1.2"></rect></svg>';
export const STOP_ICON =
  '<svg class="playback-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2"></rect></svg>';
const SECTION_PREVIOUS_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6v12"></path><path class="is-solid" d="M18 6.6v10.8a.7.7 0 0 1-1.1.6L9.4 12.6a.7.7 0 0 1 0-1.2l7.5-5.4a.7.7 0 0 1 1.1.6z"></path></svg>';
const SECTION_NEXT_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.5 6v12"></path><path class="is-solid" d="M6 6.6v10.8a.7.7 0 0 0 1.1.6l7.5-5.4a.7.7 0 0 0 0-1.2L7.1 6a.7.7 0 0 0-1.1.6z"></path></svg>';
const CONTENTS_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h1M4.5 12h1M4.5 17.5h1"></path></svg>';
const VOLUME_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="is-solid" d="M4.5 9.5h3l4-3.5v12l-4-3.5h-3z"></path><path class="volume-wave-1" d="M15 9.5a3.5 3.5 0 0 1 0 5"></path><path class="volume-wave-2" d="M17.5 7a7 7 0 0 1 0 10"></path></svg>';
const DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg>';
const SKIP_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l8 6-8 6zM18 5v14"></path></svg>';
const LIVE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="is-solid" cx="12" cy="12" r="2.2"></circle><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.4 5.4a9.3 9.3 0 0 0 0 13.2M18.6 5.4a9.3 9.3 0 0 1 0 13.2"></path></svg>';
const QUEUE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5h11M4 11.5h11M4 16.5h6"></path><path class="is-solid" d="M14 14.6v4.8a.6.6 0 0 0 .9.5l3.9-2.4a.6.6 0 0 0 0-1l-3.9-2.4a.6.6 0 0 0-.9.5z"></path></svg>';
const LYRICS_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5h10M4 11h12M4 15.5h7"></path><circle cx="17.5" cy="17" r="2.5"></circle><path d="M20 17V8.5l-2-.5"></path></svg>';
const CLOSE_DOWN_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9.5 6 6 6-6"></path></svg>';
const HEART_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"></path></svg>';
const DISLIKE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h9l3 8-3 1h-4l1 5a2 2 0 0 1-3 1L7 12z"></path></svg>';

// Reader items have no cover, so they get a typographic one: the title's
// first letter, set large in the reading face on a tile seeded by the item,
// with the kind of source beneath it.
function paintTypeArt(target, { seed = "", text = "", label = "" }) {
  const value = artworkSeed(seed || text);
  const hue = value % 360;
  target.classList.add("is-reader");
  target.style.setProperty("--art-h", String(hue));
  target.style.setProperty("--art-h2", String((hue + 30 + (value % 40)) % 360));
  const letter =
    [...String(text || "").replace(/^[^\p{L}\p{N}]+/u, "")][0] || "R";
  const mark = element("span", "type-art-letter");
  mark.textContent = letter.toLocaleUpperCase();
  const kind = element("span", "type-art-label");
  kind.textContent = label || "Reader";
  target.replaceChildren(mark, kind);
}

function element(tag, className, attributes = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value);
  }
  return node;
}

// A compact volume slider for pointer devices; phones use their own volume
// buttons. Every slider on the page follows the same audio element.
export function createVolumeControl({ audio, label = "Volume" }) {
  const wrap = element("div", "volume-control");
  const mute = element("button", "icon-button volume-mute", {
    type: "button",
    "aria-label": "Mute",
    title: "Mute",
    "aria-pressed": "false",
  });
  mute.innerHTML = VOLUME_ICON;
  const input = element("input", "volume-range", {
    type: "range",
    min: "0",
    max: "1",
    step: "0.05",
    "aria-label": label,
  });
  wrap.append(mute, input);
  let stored = Number(window.ZakStorage?.get("zak-volume", "1"));
  if (!Number.isFinite(stored) || stored < 0 || stored > 1) stored = 1;
  if (Math.abs(audio.volume - stored) > 0.001) audio.volume = stored;
  function sync() {
    const value = audio.muted ? 0 : audio.volume;
    input.value = String(value);
    input.style.setProperty("--volume", `${Math.round(value * 100)}%`);
    input.setAttribute("aria-valuetext", `${Math.round(value * 100)}%`);
    mute.setAttribute(
      "aria-pressed",
      String(audio.muted || audio.volume === 0),
    );
    const quiet = audio.muted || audio.volume === 0;
    mute.setAttribute("aria-label", quiet ? "Unmute" : "Mute");
    mute.title = quiet ? "Unmute" : "Mute";
    wrap.dataset.level = quiet ? "off" : audio.volume < 0.5 ? "low" : "high";
  }
  input.addEventListener("input", () => {
    const value = Number(input.value);
    audio.muted = false;
    audio.volume = value;
    window.ZakStorage?.set("zak-volume", String(value));
  });
  mute.addEventListener("click", () => {
    if (audio.muted || audio.volume === 0) {
      audio.muted = false;
      if (audio.volume === 0) audio.volume = 0.6;
    } else {
      audio.muted = true;
    }
  });
  audio.addEventListener("volumechange", sync);
  sync();
  return wrap;
}

// A seek bar that is a slider where seeking is allowed and a read-only
// progress bar everywhere else.
export function createProgress(className) {
  const row = element("div", `range-row ${className}`);
  const elapsed = element("span", "player-time tabular");
  const track = element("div", "range-track");
  const fill = element("div", "range-fill");
  const thumb = element("div", "range-thumb");
  const input = element("input", "range-input", {
    type: "range",
    min: "0",
    max: "0",
    step: "0.1",
    value: "0",
    "aria-label": "Playback position",
  });
  track.append(fill, thumb, input);
  const end = element("span", "range-end player-time tabular");
  row.append(elapsed, track, end);
  return { row, elapsed, track, fill, thumb, input, end, scrubbing: false };
}

export function paintProgress(parts, view) {
  const duration = Math.max(0, Number(view.duration) || 0);
  const position = Math.max(
    0,
    Math.min(Number(view.position) || 0, duration || Infinity),
  );
  parts.row.hidden = duration <= 0;
  if (duration <= 0) return 0;
  const shown = parts.scrubbing ? Number(parts.input.value) : position;
  const remaining = Math.max(0, duration - shown);
  setText(parts.elapsed, timeLabel(shown));
  setText(parts.end, `−${timeLabel(remaining)}`);
  const percent = Math.max(0, Math.min(100, (shown / duration) * 100));
  parts.fill.style.width = `${percent}%`;
  parts.thumb.style.left = `${percent}%`;
  const valueText = `${timeLabel(shown)} of ${timeLabel(duration)}`;
  if (view.seekable) {
    parts.input.hidden = false;
    for (const name of [
      "role",
      "aria-label",
      "aria-valuemin",
      "aria-valuemax",
      "aria-valuenow",
      "aria-valuetext",
    ])
      parts.track.removeAttribute(name);
    parts.input.max = String(duration);
    if (!parts.scrubbing) parts.input.value = String(position);
    setAttribute(parts.input, "aria-valuetext", valueText);
    parts.thumb.hidden = false;
  } else {
    parts.input.hidden = true;
    parts.thumb.hidden = true;
    setAttribute(parts.track, "role", "progressbar");
    setAttribute(parts.track, "aria-label", "Playback position");
    setAttribute(parts.track, "aria-valuemin", "0");
    setAttribute(parts.track, "aria-valuemax", String(Math.round(duration)));
    setAttribute(parts.track, "aria-valuenow", String(Math.round(position)));
    setAttribute(parts.track, "aria-valuetext", valueText);
  }
  return percent;
}

// A held arrow key previews one seek; release or blur commits it once.
export function bindProgress(parts, describe, seekTo) {
  const input = parts.input;
  let keyboard = false;
  const paint = () => paintProgress(parts, describe());
  const commit = async () => {
    if (!parts.scrubbing) return;
    const value = Number(input.value);
    parts.scrubbing = false;
    if (describe()?.seekable) await seekTo(value);
    paint();
  };
  input.addEventListener("keydown", (event) => {
    if (!(event.key in deltas) && !["Home", "End"].includes(event.key)) return;
    if (!describe()?.seekable || event.altKey || event.ctrlKey || event.metaKey)
      return;
    event.preventDefault();
    event.stopPropagation();
    keyboard = true;
    const max = Number(input.max);
    input.value = String(
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? max
          : Math.max(0, Math.min(max, Number(input.value) + deltas[event.key])),
    );
    parts.scrubbing = true;
    paint();
  });
  input.addEventListener("keyup", (event) => {
    if (!(event.key in deltas) && !["Home", "End"].includes(event.key)) return;
    keyboard = false;
    void commit();
  });
  input.addEventListener("input", () => {
    parts.scrubbing = true;
    paint();
  });
  input.addEventListener("change", () => {
    if (!keyboard) void commit();
  });
  input.addEventListener("blur", () => {
    keyboard = false;
    void commit();
  });
}

export function createReactionButton(kind) {
  const button = element("button", "button player-reaction", {
    type: "button",
    "aria-pressed": "false",
  });
  button.dataset.reaction = kind;
  button.innerHTML = `${kind === "like" ? HEART_ICON : DISLIKE_ICON}<span>${kind === "like" ? "Like" : "Dislike"}</span><span class="reaction-count tabular">0</span>`;
  return button;
}

function toggleState(view) {
  const isLive = view.kind === "live";
  const label =
    view.toggleLabel ||
    (isLive
      ? view.playing
        ? "Stop listening"
        : "Listen live"
      : view.playing
        ? "Pause"
        : "Play");
  const icon =
    view.toggleIcon || (view.playing ? (isLive ? "stop" : "pause") : "play");
  return { label, icon };
}

function paintToggle(button, view) {
  const { label, icon } = toggleState(view);
  setAttribute(button, "aria-label", label);
  button.title = label;
  if (button.dataset.icon !== icon) {
    button.dataset.icon = icon;
    button.innerHTML =
      icon === "play" ? PLAY_ICON : icon === "stop" ? STOP_ICON : PAUSE_ICON;
  }
  button.disabled = Boolean(view.disabled);
}

function paintRate(label, select, view) {
  if (!view.rate?.options?.length) {
    label.hidden = true;
    return;
  }
  label.hidden = false;
  const key = view.rate.options.join(",");
  if (select.dataset.options !== key) {
    select.dataset.options = key;
    select.replaceChildren(
      ...view.rate.options.map((value) => {
        const option = document.createElement("option");
        option.value = String(value);
        option.textContent = `${Number(value)}×`;
        return option;
      }),
    );
  }
  if (document.activeElement !== select) select.value = String(view.rate.value);
}

function rateControl(className) {
  const label = element("label", className);
  const name = element("span", "sr-only");
  name.textContent = "Playback speed";
  const select = element("select", "player-rate-select tabular");
  label.append(name, select);
  return { label, select };
}

function iconButton(className, label, icon) {
  const button = element("button", `icon-button ${className}`, {
    type: "button",
    "aria-label": label,
    title: label,
  });
  button.innerHTML = icon;
  return button;
}

function skipButton(className, delta) {
  const label = delta < 0 ? "Back 10 seconds" : "Forward 10 seconds";
  const button = element("button", `icon-button ${className}`, {
    type: "button",
    "aria-label": label,
    title: label,
  });
  button.innerHTML = `<span class="player-skip-label tabular" aria-hidden="true">${delta < 0 ? "−10" : "+10"}</span>`;
  return button;
}

// A labelled action button whose label can hide on narrow surfaces; the
// accessible name stays.
function labelledButton(className, icon) {
  const button = element("button", className, { type: "button" });
  button.innerHTML = `${icon}<span class="player-action-label"></span>`;
  return button;
}

function paintLabelled(button, label, iconHTML = "") {
  setText(button.lastElementChild, label);
  setAttribute(button, "aria-label", label);
  if (iconHTML && button.dataset.iconKey !== iconHTML) {
    button.dataset.iconKey = iconHTML;
    button.firstElementChild.outerHTML = iconHTML;
  }
}

export function createPlayer({
  root,
  audio,
  owner,
  routePath,
  navigate,
  liveAvailable,
  listenLive,
  radioDocked = () => false,
}) {
  const adapters = new Map();
  const compact = window.matchMedia("(max-width: 639px)");
  let frame = 0;
  let shown = "";
  let lastArtwork = "";

  // ---- Dock ----
  root.replaceChildren();
  const line = element("div", "player-line", { "aria-hidden": "true" });
  const lineFill = element("span", "");
  line.append(lineFill);
  const inner = element("div", "player-inner");
  const art = element("a", "player-art", {
    tabindex: "-1",
    "aria-hidden": "true",
  });
  // Reader puts its Contents in the artwork's place on wider screens.
  const contents = iconButton("player-contents", "Contents", CONTENTS_ICON);
  contents.setAttribute("aria-haspopup", "dialog");
  const meta = element("div", "player-meta");
  const kicker = element("p", "player-kicker");
  const source = element("span", "player-source");
  const context = element("span", "player-context");
  kicker.append(source, context);
  const title = element("a", "player-title");
  const note = element("p", "player-note");
  // Phones: the art and title open the full player.
  const open = element("button", "player-open", {
    type: "button",
    "aria-haspopup": "dialog",
  });
  meta.append(kicker, title, note);

  const transport = element("div", "player-transport");
  const back = skipButton("player-skip", -10);
  const toggle = element("button", "play-button player-toggle", {
    type: "button",
  });
  const forward = skipButton("player-skip", 10);
  const dockRate = rateControl("player-rate");
  transport.append(back, toggle, forward, dockRate.label);

  const progress = createProgress("player-progress");

  const extras = element("div", "player-extras");
  // "Back to narration" floats above the bar instead of adding a row.
  const follow = element("button", "button player-follow", { type: "button" });
  follow.textContent = "Back to narration";
  const download = element("a", "button-quiet player-download", {
    download: "",
  });
  download.innerHTML = `${DOWNLOAD_ICON}<span class="player-action-label">Download</span>`;
  const liveButton = labelledButton("button player-live", LIVE_ICON);
  // Station-wide changes look different from this device's own controls.
  const stationAction = labelledButton(
    "button player-station-action",
    SKIP_ICON,
  );
  const volume = createVolumeControl({ audio });
  volume.classList.add("player-volume");
  extras.append(download, liveButton, stationAction, volume);

  inner.append(art, contents, meta, open, transport, progress.row, extras);
  root.append(line, follow, inner);

  // ---- Full player sheet ----
  const sheet = element("dialog", "sheet player-sheet", {
    "aria-labelledby": "playerSheetTitle",
  });
  const body = element("div", "player-sheet-body");
  const head = element("div", "player-sheet-head");
  const close = iconButton(
    "player-sheet-close",
    "Close player",
    CLOSE_DOWN_ICON,
  );
  const sheetSource = element("p", "player-sheet-source");
  const go = element("a", "button-quiet player-sheet-go");
  head.append(close, sheetSource, go);
  const sheetArt = element("div", "player-sheet-art", {
    "aria-hidden": "true",
  });
  const sheetCopy = element("div", "player-sheet-copy");
  const sheetTitle = element("h2", "player-sheet-title", {
    id: "playerSheetTitle",
  });
  // Who made it and where it's from, as on Radio: artist and collection,
  // or a Reader item's author and source.
  const sheetSubtitle = element("p", "player-sheet-subtitle");
  const sheetNote = element("p", "player-sheet-note");
  sheetCopy.append(sheetTitle, sheetSubtitle, sheetNote);
  const sheetProgress = createProgress("player-sheet-progress");
  const sheetTransport = element("div", "player-sheet-transport");
  const sectionPrevious = iconButton(
    "player-section",
    "Previous section",
    SECTION_PREVIOUS_ICON,
  );
  const sheetBack = skipButton("player-skip", -10);
  const sheetToggle = element("button", "play-button player-sheet-toggle", {
    type: "button",
  });
  const sheetForward = skipButton("player-skip", 10);
  const sectionNext = iconButton(
    "player-section",
    "Next section",
    SECTION_NEXT_ICON,
  );
  sheetTransport.append(
    sectionPrevious,
    sheetBack,
    sheetToggle,
    sheetForward,
    sectionNext,
  );
  const sheetActions = element("div", "player-sheet-actions");
  const sheetStation = labelledButton(
    "button player-station-action",
    SKIP_ICON,
  );
  const sheetShared = element("div", "player-sheet-shared", {
    role: "group",
    "aria-label": "Shared controls",
  });
  const sheetScope = element("p", "player-sheet-scope");
  const sheetPause = labelledButton("button player-station-action", PAUSE_ICON);
  sheetShared.append(sheetScope, sheetPause, sheetStation);
  const sheetLive = labelledButton("button player-live", LIVE_ICON);
  const sheetLyrics = labelledButton("button player-sheet-lyrics", LYRICS_ICON);
  paintLabelled(sheetLyrics, "Lyrics");
  const sheetQueue = labelledButton("button player-sheet-queue", QUEUE_ICON);
  paintLabelled(sheetQueue, "Up next");
  const sheetContents = labelledButton("button", CONTENTS_ICON);
  paintLabelled(sheetContents, "Contents");
  const sheetFollow = element("button", "button", { type: "button" });
  sheetFollow.textContent = "Back to narration";
  const sheetRate = rateControl("player-rate player-sheet-rate");
  const sheetDownload = element("a", "button player-download", {
    download: "",
  });
  sheetDownload.innerHTML = `${DOWNLOAD_ICON}<span class="player-action-label">Download</span>`;
  // This song: the same reactions as on Radio, and its download.
  const sheetSong = element("div", "player-sheet-song", {
    role: "group",
    "aria-label": "This song",
  });
  const sheetLike = createReactionButton("like");
  const sheetDislike = createReactionButton("dislike");
  sheetSong.append(sheetLike, sheetDislike, sheetDownload);
  // Where to look (Lyrics, Up next, Contents) comes first; a station-wide
  // change, or the way back to Radio, comes last, on its own.
  sheetActions.append(
    sheetLyrics,
    sheetQueue,
    sheetContents,
    sheetFollow,
    sheetRate.label,
    sheetShared,
    sheetLive,
  );
  body.append(
    head,
    sheetArt,
    sheetCopy,
    sheetSong,
    sheetProgress.row,
    sheetTransport,
    sheetActions,
  );
  sheet.append(body);
  document.body.append(sheet);

  function adapterFor(name) {
    return name ? adapters.get(name) : null;
  }

  function describe(name) {
    const adapter = adapterFor(name);
    if (!adapter) return null;
    try {
      return adapter.describe() || null;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  // The player always describes the source that is actually heard (or was
  // last heard), whatever page is open. Opening a Reader item or a Library
  // song never changes it; the page's own Play does, and then the audio,
  // the player, and the lock screen switch together.
  function selection() {
    const path = routePath();
    const current = owner();
    // Paused narration remains resumable in Reader. Radio owns its own page.
    if (path === "/" && current === "reader" && audio.paused) return null;
    if (path === "/" && (!current || current === "radio")) {
      // Radio's own controls are on screen until they scroll away; the
      // sheet, once open, stays.
      if (!radioDocked() && !sheet.open) return null;
      const view = describe("radio");
      return view ? { name: "radio", view } : null;
    }
    if (!current) return null;
    const view = describe(current);
    return view ? { name: current, view } : null;
  }

  // The bottom chrome is the dock plus, on phones, the tab bar. Views read
  // --bottom-chrome to keep what they scroll to clear of it.
  function syncHeight() {
    const dock = root.hidden
      ? 0
      : Math.ceil(root.getBoundingClientRect().height);
    const nav = document.querySelector(".primary-nav");
    const fixedNav =
      nav && getComputedStyle(nav).position === "fixed"
        ? Math.ceil(nav.getBoundingClientRect().height)
        : 0;
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty("--player-height", `${dock}px`);
    rootStyle.setProperty("--bottom-chrome", `${dock + fixedNav}px`);
    keepFocusVisible();
  }

  function keepFocusVisible() {
    const focused = document.activeElement;
    if (
      document.documentElement.dataset.keyboard !== "true" ||
      !focused ||
      focused === document.body ||
      focused.closest("dialog, .player, .primary-nav, .app-rail")
    )
      return;
    const rect = focused.getBoundingClientRect();
    const chrome =
      Number.parseFloat(
        document.documentElement.style.getPropertyValue("--bottom-chrome"),
      ) || 0;
    const bottom = window.innerHeight - chrome - 12;
    if (rect.height && rect.top < window.innerHeight && rect.bottom > bottom)
      window.scrollBy({ top: rect.bottom - bottom, behavior: "instant" });
  }
  document.addEventListener("focusin", () =>
    window.requestAnimationFrame(keepFocusVisible),
  );

  function paintArtwork(target, view, cacheKey) {
    const key = view.artwork?.src
      ? `src:${view.artwork.src}`
      : view.artwork?.glyph === "reader"
        ? `reader:${view.artwork.seed || ""}:${view.artwork.text || ""}:${view.artwork.label || ""}`
        : `seed:${view.artwork?.seed || ""}`;
    if (
      target.dataset.artKey === `${cacheKey}${key}` &&
      target.childElementCount
    )
      return;
    target.dataset.artKey = `${cacheKey}${key}`;
    target.classList.remove("has-art-seed", "is-reader");
    target.style.removeProperty("--art-h");
    target.style.removeProperty("--art-h2");
    if (view.artwork?.src) {
      const image = element("img", "", { alt: "", loading: "lazy" });
      const fallback = () =>
        paintArtworkFallback(target, view.artwork?.seed || view.title || "");
      if (typeof window.ZakImage === "function")
        window.ZakImage(image, view.artwork.src, fallback);
      else {
        image.addEventListener("error", fallback);
        image.src = view.artwork.src;
      }
      target.replaceChildren(image);
    } else if (view.artwork?.glyph === "reader") {
      paintTypeArt(target, view.artwork);
    } else {
      paintArtworkFallback(target, view.artwork?.seed || view.title || "");
    }
  }

  function paintDock(name, view) {
    root.dataset.owner = name;
    root.dataset.kind = view.kind;
    const artKey = view.artwork?.src
      ? view.artwork.src
      : `${view.artwork?.glyph || ""}:${view.artwork?.seed || ""}`;
    if (artKey !== lastArtwork || !art.childElementCount) {
      lastArtwork = artKey;
      paintArtwork(art, view, "dock:");
    }
    art.href = view.href || "/";
    setText(source, view.source || "");
    setText(context, view.context ? ` · ${view.context}` : "");
    setText(title, view.title || "");
    title.href = view.href || "/";
    title.title = view.title || "";
    setText(note, view.note || "");
    note.hidden = !view.note;
    setAttribute(
      open,
      "aria-label",
      `${view.source ? `${view.source}: ` : ""}${view.title || "Player"}${view.note ? `, ${view.note}` : ""}. Open player`,
    );
    // The compact open button owns this area. Artwork and title are text,
    // with no links hidden beneath its hit area.
    if (compact.matches) {
      art.removeAttribute("href");
      title.removeAttribute("href");
    }

    paintToggle(toggle, view);
    back.hidden = !view.skip;
    forward.hidden = !view.skip;
    contents.hidden = !view.contents;
    art.hidden = !contents.hidden && !compact.matches;

    const percent = paintProgress(progress, view);
    lineFill.style.width = `${percent || 0}%`;
    line.hidden = !(Number(view.duration) > 0);

    paintRate(dockRate.label, dockRate.select, view);
    follow.hidden = !view.follow?.visible;
    if (view.download?.href && !view.download.sheetOnly) {
      download.hidden = false;
      download.href = view.download.href;
      download.download = view.download.filename || "";
      download.setAttribute("aria-label", "Download");
    } else {
      download.hidden = true;
      download.removeAttribute("href");
    }
    const live = name === owner() && name !== "radio" && liveAvailable();
    liveButton.hidden = !live;
    paintLabelled(liveButton, view.liveLabel || "Listen live");
    stationAction.hidden = !view.stationAction;
    if (view.stationAction) {
      paintLabelled(stationAction, view.stationAction.label);
      stationAction.disabled = Boolean(view.stationAction.disabled);
    }
    // The volume slider only shows on pointer devices; it never adds a row
    // by itself.
    // Phones keep shared skip out of the mini player (it's in the full
    // player and on Radio, labelled for everyone).
    const extraCount = [
      download,
      liveButton,
      ...(compact.matches ? [] : [stationAction]),
    ].filter((node) => !node.hidden).length;
    root.classList.toggle("has-extras", extraCount > 0);
  }

  // Whether the page already shows what this player is playing.
  function atOwnerView(name, view) {
    if (routePath() !== OWNER_ROUTES[name]) return false;
    if (name !== "reader") return true;
    const wanted = new URL(
      view.href || "/reader",
      window.location.origin,
    ).searchParams.get("item");
    return new URLSearchParams(window.location.search).get("item") === wanted;
  }

  function paintSheet(name, view) {
    sheet.dataset.owner = name;
    paintArtwork(sheetArt, view, "sheet:");
    setText(
      sheetSource,
      [view.source, view.context].filter(Boolean).join(" · "),
    );
    const route = OWNER_ROUTES[name];
    go.hidden = !view.href || atOwnerView(name, view);
    go.href = view.href || route;
    setText(go, OWNER_VIEWS[name] || "Open");
    setText(sheetTitle, view.title || "");
    setText(sheetSubtitle, view.subtitle || "");
    sheetSubtitle.hidden = !view.subtitle;
    setText(sheetNote, view.note || "");
    sheetNote.hidden = !view.note;
    const reactions = view.reactions || null;
    for (const [button, pressed, count, noun] of [
      [sheetLike, reactions?.liked, reactions?.likes, "liked"],
      [sheetDislike, reactions?.disliked, reactions?.dislikes, "disliked"],
    ]) {
      button.hidden = !reactions;
      if (!reactions) continue;
      setAttribute(button, "aria-pressed", String(Boolean(pressed)));
      setText(button.lastElementChild, String(Number(count) || 0));
      button.title = `${Number(count) || 0} ${Number(count) === 1 ? "listener" : "listeners"} ${noun} this song`;
    }
    paintProgress(sheetProgress, view);
    paintToggle(sheetToggle, view);
    sheetBack.hidden = !view.skip;
    sheetForward.hidden = !view.skip;
    const sections = view.sections || null;
    sectionPrevious.hidden = !sections;
    sectionNext.hidden = !sections;
    if (sections) {
      sectionPrevious.disabled = !sections.previous;
      sectionNext.disabled = !sections.next;
    }
    sheetShared.hidden = !view.stationPause && !view.stationAction;
    setText(sheetScope, view.stationScope || "");
    sheetPause.hidden = !view.stationPause;
    if (view.stationPause) {
      paintLabelled(
        sheetPause,
        view.stationPause.label,
        view.stationPause.icon,
      );
      sheetPause.disabled = Boolean(view.stationPause.disabled);
    }
    sheetStation.hidden = !view.stationAction;
    if (view.stationAction) {
      paintLabelled(sheetStation, view.stationAction.label);
      sheetStation.disabled = Boolean(view.stationAction.disabled);
    }
    sheetLive.hidden = !(
      name === owner() &&
      name !== "radio" &&
      liveAvailable()
    );
    paintLabelled(sheetLive, view.liveLabel || "Listen live");
    sheetLyrics.hidden = !view.lyrics;
    sheetQueue.hidden = !view.queue;
    sheetContents.hidden = !view.contents;
    sheetFollow.hidden = !view.follow?.visible;
    paintRate(sheetRate.label, sheetRate.select, view);
    if (view.download?.href) {
      sheetDownload.hidden = false;
      sheetDownload.href = view.download.href;
      sheetDownload.download = view.download.filename || "";
    } else {
      sheetDownload.hidden = true;
      sheetDownload.removeAttribute("href");
    }
    sheetSong.hidden = !reactions && sheetDownload.hidden;
  }

  function render() {
    frame = 0;
    const selected = selection();
    const wasHidden = root.hidden;
    if (!selected) {
      root.hidden = true;
      shown = "";
      root.dataset.owner = "";
      if (sheet.open) sheet.close();
      if (!wasHidden) syncHeight();
      return;
    }
    const { name, view } = selected;
    shown = name;
    root.hidden = false;
    paintDock(name, view);
    if (sheet.open) paintSheet(name, view);
    if (wasHidden) syncHeight();
  }

  function update() {
    if (frame) return;
    frame = window.requestAnimationFrame(render);
  }

  function call(method, ...args) {
    const adapter = adapterFor(shown);
    if (typeof adapter?.[method] === "function")
      return adapter[method](...args);
    return undefined;
  }

  let sheetOpener = null;
  function openSheet(opener = document.activeElement) {
    const selected = selection();
    if (!selected) return;
    sheetOpener = opener;
    paintSheet(selected.name, selected.view);
    if (!sheet.open) sheet.showModal();
    sheetToggle.focus({ preventScroll: true });
  }

  function closeSheet({ returnFocus = true } = {}) {
    if (!sheet.open) return;
    sheetReturn = returnFocus;
    sheet.close();
  }
  let sheetReturn = true;
  sheet.addEventListener("close", () => {
    const opener = sheetOpener;
    sheetOpener = null;
    if (
      sheetReturn &&
      opener?.isConnected &&
      !opener.closest("[hidden]") &&
      !document.querySelector("dialog[open]")
    )
      opener.focus({ preventScroll: true });
    sheetReturn = true;
    update();
  });
  sheet.addEventListener("click", (event) => {
    if (event.target !== sheet) return;
    const box = sheet.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
      closeSheet();
  });
  close.addEventListener("click", () => closeSheet());
  open.addEventListener("click", () => openSheet(open));
  go.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    closeSheet({ returnFocus: false });
    const target = new URL(go.href, window.location.origin);
    navigate(`${target.pathname}${target.search}${target.hash}`);
  });

  for (const button of [toggle, sheetToggle]) {
    button.addEventListener("click", async () => {
      await call("toggle");
      update();
    });
  }
  for (const button of [back, sheetBack])
    button.addEventListener("click", () => call("seekBy", -10));
  for (const button of [forward, sheetForward])
    button.addEventListener("click", () => call("seekBy", 10));
  for (const parts of [progress, sheetProgress])
    bindProgress(
      parts,
      () => selection()?.view || {},
      (value) => call("seekTo", value),
    );
  for (const { select } of [dockRate, sheetRate])
    select.addEventListener("change", () =>
      call("setRate", Number(select.value)),
    );
  follow.addEventListener("click", () => call("follow"));
  sheetFollow.addEventListener("click", () => {
    closeSheet({ returnFocus: false });
    call("follow");
  });
  sectionPrevious.addEventListener("click", () => call("previousSection"));
  sectionNext.addEventListener("click", () => call("nextSection"));
  contents.addEventListener("click", () => call("openContents", contents));
  sheetContents.addEventListener("click", () => {
    closeSheet({ returnFocus: false });
    call("openContents", open);
  });
  sheetLyrics.addEventListener("click", () => {
    closeSheet({ returnFocus: false });
    call("openLyrics", open);
  });
  sheetQueue.addEventListener("click", () => {
    closeSheet({ returnFocus: false });
    call("openQueue");
  });
  for (const button of [liveButton, sheetLive]) {
    button.addEventListener("click", async () => {
      // Radio takes over; the full player of what was playing goes.
      if (button === sheetLive) closeSheet({ returnFocus: false });
      await listenLive();
      update();
    });
  }
  for (const button of [sheetLike, sheetDislike]) {
    button.addEventListener("click", async () => {
      const view = describe(shown);
      await view?.reactions?.toggle?.(button.dataset.reaction);
      update();
    });
  }
  sheetPause.addEventListener("click", async () => {
    await describe(shown)?.stationPause?.run?.();
    update();
  });
  for (const button of [stationAction, sheetStation]) {
    button.addEventListener("click", async () => {
      const view = describe(shown);
      await view?.stationAction?.run?.();
      update();
    });
  }
  for (const link of [title, art]) {
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      if (compact.matches) {
        openSheet(open);
        return;
      }
      const target = new URL(link.href, window.location.origin);
      navigate(`${target.pathname}${target.search}${target.hash}`);
    });
  }
  compact.addEventListener("change", () => {
    if (!compact.matches) closeSheet({ returnFocus: false });
    update();
    syncHeight();
  });

  for (const eventName of [
    "timeupdate",
    "play",
    "pause",
    "loadedmetadata",
    "ended",
    "ratechange",
  ]) {
    audio.addEventListener(eventName, update);
  }
  window.addEventListener("zak-audio-owner", update);
  window.addEventListener("zak-route", () => {
    closeSheet({ returnFocus: false });
    update();
    window.requestAnimationFrame(syncHeight);
  });
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(syncHeight);
    observer.observe(root);
    const nav = document.querySelector(".primary-nav");
    if (nav) observer.observe(nav);
  } else {
    window.addEventListener("resize", syncHeight);
  }
  syncHeight();

  return {
    register(name, adapter) {
      if (!OWNER_ROUTES[name]) throw new Error(`Unknown player owner: ${name}`);
      adapters.set(name, adapter);
      update();
    },
    update,
    shortcut(action, value) {
      const name = owner() || (routePath() === "/" ? "radio" : "");
      const view = describe(name);
      if (!view || view.disabled || (action === "seekBy" && !view.seekable))
        return false;
      Promise.resolve(adapterFor(name)?.[action]?.(value)).then(update);
      return true;
    },
    open: openSheet,
    get shown() {
      return shown;
    },
  };
}

// Notifications. Each message is announced once through a polite live
// region; the notification itself never takes focus. It has one fixed home,
// directly above the bottom chrome (the dock and, on phones, the tab bar),
// so it never moves over the station's shared controls or the player. An
// Undo stays until the next action instead of timing out.
const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"></path></svg>';

export function createNotifier({ host, announcer }) {
  let current = null;
  let announceFrame = 0;
  const apple = /Mac|iPhone|iPad/.test(
    navigator.userAgentData?.platform || navigator.platform || "",
  );
  const undoKeys = apple ? "Command+Z" : "Control+Z";
  let keyboardUsed = false;
  document.addEventListener(
    "keydown",
    () => {
      keyboardUsed = true;
    },
    { capture: true },
  );

  function announce(message) {
    window.cancelAnimationFrame(announceFrame);
    announcer.textContent = "";
    announceFrame = window.requestAnimationFrame(() => {
      announcer.textContent = message;
    });
  }

  function typing(target) {
    return Boolean(
      target?.closest?.("input, textarea, select, [contenteditable='true']"),
    );
  }

  // Ctrl+Z (Command+Z on Apple devices) runs a visible Undo.
  document.addEventListener("keydown", (event) => {
    if (
      !current?.undo ||
      event.key.toLowerCase() !== "z" ||
      event.shiftKey ||
      event.altKey ||
      !(apple ? event.metaKey : event.ctrlKey) ||
      typing(event.target)
    )
      return;
    event.preventDefault();
    current.runAction();
  });

  // Any other action ends an Undo: a press elsewhere, or a change of view.
  // Controls marked data-keep-notice (another Delete, an inline Undo) are
  // part of the same change and keep it.
  document.addEventListener(
    "click",
    (event) => {
      if (
        current?.persistent &&
        !event.target.closest?.(".snackbar, [data-keep-notice]")
      )
        current.dismiss("next-action");
    },
    { capture: true },
  );
  window.addEventListener("zak-route", () => {
    if (current?.persistent) current.dismiss("navigation");
  });

  // A failure caused by the connection can say what to do once it is back
  // (`reconnect`: the message and action to show then), so a notice never
  // keeps saying "Can't reach Zak Radio" after the app has reconnected.
  function notify(
    message,
    {
      action = null,
      tone = "",
      duration,
      onDismiss = null,
      reconnect = null,
    } = {},
  ) {
    current?.dismiss("replaced");
    const snackbar = element(
      "div",
      `snackbar${tone === "error" ? " is-error" : ""}`,
      { role: "region", "aria-label": "Notification" },
    );
    const text = element("p", "snackbar-message");
    text.textContent = message;
    snackbar.append(text);
    let returnFocus = null;
    let timer = 0;
    let dismissed = false;
    const undo = action?.label === "Undo";
    const persistent = Boolean(action?.label) && action.label !== "Listen live";
    const lifetime = Number(duration) || (tone === "error" ? 7000 : 5000);

    const handle = {
      undo,
      reconnect,
      persistent: false,
      dismiss(reason = "dismissed") {
        if (dismissed) return;
        dismissed = true;
        window.clearTimeout(timer);
        const hadFocus = snackbar.contains(document.activeElement);
        snackbar.remove();
        if (current === handle) current = null;
        if (hadFocus && returnFocus?.isConnected)
          returnFocus.focus({ preventScroll: true });
        onDismiss?.(reason);
      },
      runAction() {
        handle.dismiss("action");
        action?.run?.();
      },
    };

    function schedule() {
      if (persistent) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => handle.dismiss("timeout"), lifetime);
    }

    if (action?.label) {
      const button = element("button", "button-quiet snackbar-action", {
        type: "button",
      });
      button.textContent = action.label;
      button.addEventListener("click", () => handle.runAction());
      snackbar.append(button);
    }
    const close = element("button", "icon-button snackbar-close", {
      type: "button",
      "aria-label": "Dismiss",
      title: "Dismiss",
    });
    close.innerHTML = CLOSE_ICON;
    close.addEventListener("click", () => handle.dismiss("dismissed"));
    snackbar.append(close);

    snackbar.addEventListener("focusin", (event) => {
      if (!snackbar.contains(event.relatedTarget))
        returnFocus = event.relatedTarget;
      window.clearTimeout(timer);
    });
    snackbar.addEventListener("focusout", (event) => {
      if (!snackbar.contains(event.relatedTarget)) schedule();
    });
    snackbar.addEventListener("pointerenter", () => window.clearTimeout(timer));
    snackbar.addEventListener("pointerleave", () => {
      if (!snackbar.contains(document.activeElement)) schedule();
    });
    snackbar.addEventListener("keydown", (event) => {
      if (event.key === "Escape") handle.dismiss("dismissed");
    });
    // Modal receipts reserve space above the form and move home on close.
    const modal = [...document.querySelectorAll("dialog[open]")].at(-1);
    if (modal) {
      modal.prepend(snackbar);
      modal.addEventListener(
        "close",
        () => {
          if (!dismissed && modal.contains(snackbar)) host.append(snackbar);
        },
        { once: true },
      );
    } else {
      host.append(snackbar);
    }
    current = handle;
    // The press that showed this message must not count as the next action.
    window.setTimeout(() => {
      if (current === handle) handle.persistent = persistent;
    });
    // Say what can be done, not where it is on screen.
    announce(
      undo
        ? `${message} Undo from the notification${keyboardUsed || window.matchMedia("(pointer: fine)").matches ? `, or press ${undoKeys}` : ""}.`
        : action?.label
          ? `${message} ${action.label} from the notification.`
          : message,
    );
    schedule();
    return handle;
  }

  notify.online = () => {
    const pending = current?.reconnect;
    if (!pending) return;
    notify(pending.message, { action: pending.action || null });
  };
  return notify;
}
