import { timeLabel } from "./format.js";
import { failureSentence, retryWait, waitWords } from "./problem.js";
import { initSongKeys } from "./song-keys.js";
import {
  characterCount,
  checkMP3,
  formBytes,
  hasControlCharacters,
} from "./song-upload-checks.js";
import {
  actionButton,
  clearFieldError,
  clearProblem,
  returnFocus,
  setFieldError,
  showProblem,
  signInAgainLink,
} from "./song-forms.js";

// Longer than the server's own two-minute read deadline, so its answer
// normally arrives first.
const UPLOAD_TIMEOUT_MS = 150_000;
const TEXT_LIMIT = 120;
const AUDIO_HINT = "Up to 32 MB and 20 minutes.";

function retryAfterOf(request) {
  const seconds = Number(request.getResponseHeader("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

// Only Zak Radio's own JSON answer is read. Anything else (a gateway's
// sign-in page or error page) is described, never shown.
function readResponse(request) {
  let payload = null;
  if (
    (request.getResponseHeader("Content-Type") || "").includes(
      "application/json",
    )
  ) {
    try {
      payload = JSON.parse(request.responseText);
    } catch {}
  }
  const answeredBy = new URL(
    request.responseURL || "/api/tracks",
    location.href,
  ).pathname;
  if (request.status === 201 && payload?.track)
    return { ok: true, track: payload.track };
  const error = {
    status: request.status,
    code: typeof payload?.error?.code === "string" ? payload.error.code : "",
    retryAfter: retryAfterOf(request),
    existingTrackId:
      typeof payload?.existing_track_id === "string"
        ? payload.existing_track_id
        : "",
  };
  // Redirected to a sign-in page, or a page instead of an answer.
  if (answeredBy !== "/api/tracks" || (!payload && request.status < 400))
    return { ok: false, error: { status: 401, code: "", retryAfter: 0 } };
  return { ok: false, error };
}

// XMLHttpRequest, not fetch, because only it reports upload progress.
function sendSong(body, { onProgress, onSent }) {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/tracks");
    request.timeout = UPLOAD_TIMEOUT_MS;
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total)
        onProgress(event.loaded / event.total);
    });
    request.upload.addEventListener("load", onSent);
    request.addEventListener("load", () => resolve(readResponse(request)));
    request.addEventListener("error", () =>
      resolve({ ok: false, error: { status: 0 } }),
    );
    request.addEventListener("timeout", () =>
      resolve({ ok: false, error: { status: 0, timeout: true } }),
    );
    request.send(body);
  });
}

function trackTitle(trackId) {
  const track = window.ZakCatalog?.tracks?.find((item) => item.id === trackId);
  if (!track) return "";
  return window.ZakTrackDisplayTitle?.(track) || track.title || "";
}

// What happened, in Library's words: the sentence, the field it belongs
// to (if any), and the next steps.
function describeFailure(error, sent) {
  const status = Number(error.status) || 0;
  if (status === 401)
    return {
      message: `${failureSentence(error, "the song wasn’t added")} Sign in again in a new tab, then try again.`,
      actions: ["signin", "retry"],
    };
  switch (error.code) {
    case "duplicate_audio": {
      const title = trackTitle(error.existingTrackId);
      return {
        message: title
          ? `This song is already in Library as “${title}”.`
          : "This song is already in Library.",
        actions: error.existingTrackId ? ["show"] : [],
        trackId: error.existingTrackId,
      };
    }
    case "invalid_audio":
      return {
        field: "audio",
        message:
          "Zak Radio couldn’t play this file. Choose a complete MP3 up to 20 minutes long.",
      };
    case "invalid_request":
      return {
        message:
          "Zak Radio couldn’t accept these song details, so the song wasn’t added. Check the title, artist, and lyrics.",
        actions: [],
      };
    case "catalog_conflict":
      return {
        message:
          "Library is full, so the song wasn’t added. Ask the person who runs Zak Radio to make room.",
        actions: [],
      };
    case "storage_full":
      return {
        message:
          "Zak Radio is out of storage space, so the song wasn’t added. Ask the person who runs Zak Radio to free up space.",
        actions: [],
      };
    case "upload_busy":
      return {
        message: `Another song is being added, so this one wasn’t. Try again ${waitWords(retryWait(error))}.`,
        actions: ["retry"],
      };
  }
  if (status === 413)
    return {
      field: "audio",
      message: "This song is too large to upload. Choose an MP3 up to 32 MB.",
    };
  // Once the whole file is sent, a lost answer or a server failure may
  // come after the song was added. A retry with the same file can't add it
  // twice: it finds the song instead.
  const uncertain = sent && (status === 0 || status >= 500);
  const message = failureSentence(
    error,
    uncertain ? "the song may not have been added" : "the song wasn’t added",
  );
  return {
    message: uncertain
      ? `${message} Trying again won’t add it twice.`
      : message,
    actions: ["retry"],
  };
}

export function initSongUpload({ library = null } = {}) {
  const entry = document.getElementById("songUploadEntry");
  const open = document.getElementById("songUploadOpen");
  const keysOpen = document.getElementById("songKeysOpen");
  const signIn = document.getElementById("songUploadSignIn");
  const result = document.getElementById("songUploadResult");
  const resultError = document.getElementById("songUploadResultError");
  const dialog = document.getElementById("songUploadDialog");
  const form = document.getElementById("songUploadForm");
  const fields = document.getElementById("songUploadFields");
  const submit = document.getElementById("songUploadSubmit");
  const status = document.getElementById("songUploadStatus");
  const statusActions = document.getElementById("songUploadStatusActions");
  const resultActions = document.getElementById("songUploadResultActions");
  const problem = document.getElementById("songUploadError");
  const progressRow = document.getElementById("songUploadProgressRow");
  const progress = document.getElementById("songUploadProgress");
  const audioHint = document.getElementById("songUploadAudioHint");
  const inputs = {
    title: form.elements.title,
    artist: form.elements.artist,
    audio: form.elements.audio,
    lyrics: form.elements.lyrics,
  };
  let busy = false;
  let limits = null;
  let audioCheck = null;
  // Set while Show song closes the dialog, so its close handler leaves
  // focus on the song instead of returning it to Add song.
  let keepFocus = false;

  async function checkAccess() {
    try {
      limits = await window.ZakAPI("/api/song-upload");
    } catch {
      // Keep what was known; an upload in progress reports here.
      if (!limits) entry.hidden = true;
      return;
    }
    entry.hidden = !limits.enabled;
    open.hidden = !limits.can_upload;
    keysOpen.hidden = !limits.can_manage_keys;
    signIn.hidden = limits.can_upload;
    signIn.href = `${window.location.pathname}${window.location.search}`;
  }
  initSongKeys({ onSignedOut: checkAccess });
  checkAccess();
  window.addEventListener("zak-route", (event) => {
    if (event.detail?.path === "/library") checkAccess();
  });
  // Back from signing in on another tab: show what this sign-in allows.
  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      window.location.pathname.startsWith("/library") &&
      limits?.enabled &&
      !limits.can_upload
    )
      checkAccess();
  });

  // ---- The chosen file: its length and size, checked as soon as it's picked.
  function audioFacts(file) {
    if (audioCheck?.file !== file) {
      audioCheck = {
        file,
        promise: file
          .arrayBuffer()
          .then((bytes) =>
            checkMP3(bytes, limits?.max_duration_seconds || 1200),
          )
          .catch(() => ({ ok: false, reason: "unreadable" })),
      };
    }
    return audioCheck.promise;
  }

  async function audioProblem(file) {
    if (!file) return "Choose an MP3 file.";
    if (!/\.mp3$/i.test(file.name))
      return "Choose an MP3 file. Its name ends in .mp3.";
    if (file.size === 0) return "This file is empty. Choose another MP3 file.";
    if (file.size > (limits?.max_audio_bytes || Infinity))
      return `This file is ${window.ZakFormatBytes(file.size)}. Choose an MP3 up to 32 MB.`;
    const facts = await audioFacts(file);
    if (facts.reason === "too_long")
      return "This song is longer than 20 minutes. Choose one up to 20 minutes long.";
    // Anything else the server decides: it decodes the whole file.
    return "";
  }

  async function describeAudio() {
    const file = inputs.audio.files[0];
    clearFieldError(inputs.audio);
    audioHint.textContent = AUDIO_HINT;
    if (!file) return;
    const message = await audioProblem(file);
    if (inputs.audio.files[0] !== file) return;
    if (message) {
      setFieldError(inputs.audio, message);
      return;
    }
    const facts = await audioFacts(file);
    audioHint.textContent = facts.ok
      ? `${timeLabel(facts.seconds)} · ${window.ZakFormatBytes(file.size)}`
      : `${window.ZakFormatBytes(file.size)} · ${AUDIO_HINT}`;
  }

  function textProblem(value, missing) {
    if (!value) return missing;
    if (characterCount(value) > TEXT_LIMIT)
      return `Use ${TEXT_LIMIT} characters or fewer.`;
    if (hasControlCharacters(value))
      return "Remove tabs and other hidden characters.";
    return "";
  }

  function lyricsProblem(value) {
    if (formBytes(value) > (limits?.max_lyrics_bytes || Infinity))
      return "These lyrics are too long. Shorten them to about 60,000 characters.";
    if (hasControlCharacters(value, true))
      return "Remove hidden control characters from the lyrics.";
    return "";
  }

  // Every field is checked at once; the first one with a problem is focused.
  async function validate() {
    const problems = [
      [inputs.title, textProblem(inputs.title.value.trim(), "Enter a title.")],
      [
        inputs.artist,
        textProblem(inputs.artist.value.trim(), "Enter the artist."),
      ],
      [inputs.audio, await audioProblem(inputs.audio.files[0])],
      [inputs.lyrics, lyricsProblem(inputs.lyrics.value)],
    ];
    let first = null;
    for (const [input, message] of problems) {
      if (!message) {
        clearFieldError(input);
        continue;
      }
      setFieldError(input, message);
      first ??= input;
    }
    first?.focus();
    return !first;
  }

  for (const input of [inputs.title, inputs.artist, inputs.lyrics]) {
    input.addEventListener("input", () => clearFieldError(input));
  }
  inputs.audio.addEventListener("change", describeAudio);
  form.addEventListener("reset", () => {
    for (const input of Object.values(inputs)) clearFieldError(input);
    audioHint.textContent = AUDIO_HINT;
    audioCheck = null;
  });

  // ---- Showing a song: Library finds it, the way a search would.
  function showSong(trackId) {
    if (dialog.open) {
      keepFocus = true;
      dialog.close();
    }
    clearProblem(resultError);
    if (!library?.showTrack(trackId)) returnFocus(open);
  }

  function actionsFor(failure, place) {
    return (failure.actions || []).map((action) => {
      if (action === "signin") return signInAgainLink();
      if (action === "show")
        return actionButton("Show song", () => showSong(failure.trackId));
      return actionButton("Try again", () => {
        if (place === "page") {
          clearProblem(resultError);
          dialog.showModal();
        }
        form.requestSubmit();
      });
    });
  }

  async function fail(error, sent) {
    if (error.code === "duplicate_audio" && !trackTitle(error.existingTrackId))
      await window.ZakCatalog.load(true).catch(() => {});
    const failure = describeFailure(error, sent);
    if (error.status === 401) checkAccess();
    status.textContent = "";
    result.textContent = "";
    if (failure.field) {
      setFieldError(inputs[failure.field], failure.message);
      if (dialog.open) inputs[failure.field].focus();
      else
        showProblem(resultError, `The song wasn’t added. ${failure.message}`);
      return;
    }
    showProblem(problem, failure.message, actionsFor(failure, "dialog"));
    if (dialog.open) {
      problem.querySelector("button, a")?.focus();
      return;
    }
    // Closed while it uploaded: the outcome still reaches the listener.
    showProblem(resultError, failure.message, actionsFor(failure, "page"));
  }

  // A finished upload says so in the dialog and under the Library buttons,
  // each with Show song, so the outcome is there whether or not the dialog
  // was closed while it uploaded.
  function showAdded(message, trackId) {
    status.textContent = message;
    result.textContent = message;
    for (const row of [statusActions, resultActions]) {
      row.replaceChildren(
        ...(trackId
          ? [actionButton("Show song", () => showSong(trackId))]
          : []),
      );
      row.hidden = !trackId;
    }
  }

  function clearAdded() {
    for (const row of [statusActions, resultActions]) {
      row.hidden = true;
      row.replaceChildren();
    }
  }

  async function succeed(track) {
    form.reset();
    let listed = true;
    try {
      await window.ZakCatalog.load(true);
    } catch {
      listed = false;
    }
    const title = trackTitle(track.id) || track.title;
    if (listed) showAdded(`“${title}” is now in Library.`, track.id);
    else showAdded(`“${title}” is now in Library. Refresh Library to see it.`);
    if (dialog.open) statusActions.querySelector("button")?.focus();
  }

  function lockForm(on) {
    fields.disabled = on;
    progressRow.hidden = !on;
    if (on) {
      submit.setAttribute("aria-disabled", "true");
      form.setAttribute("aria-busy", "true");
    } else {
      submit.removeAttribute("aria-disabled");
      form.removeAttribute("aria-busy");
    }
  }

  open.addEventListener("click", () => {
    keepFocus = false;
    clearProblem(resultError);
    if (!busy) {
      status.textContent = "";
      statusActions.hidden = true;
      statusActions.replaceChildren();
    }
    dialog.showModal();
    if (!busy)
      (form.querySelector('[aria-invalid="true"]') || inputs.title).focus();
  });
  document
    .getElementById("songUploadClose")
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (busy) result.textContent = status.textContent;
    if (keepFocus) {
      keepFocus = false;
      return;
    }
    returnFocus(open);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    // Claimed before anything waits: a second submit while the file is
    // still being read would otherwise send a second, empty request.
    busy = true;
    let outcome = null;
    let sent = false;
    try {
      // Try again goes with the error it belonged to; focus moves first.
      if (problem.contains(document.activeElement)) submit.focus();
      clearProblem(problem);
      if (!limits) await checkAccess();
      if (!(await validate())) return;
      const title = inputs.title.value.trim();
      // Read the form before its fields are disabled, which drops them.
      const body = new FormData(form);
      // Focus stays on the button while the fields are locked.
      if (fields.contains(document.activeElement)) submit.focus();
      lockForm(true);
      progress.value = 0;
      clearAdded();
      status.textContent = `Uploading “${title}”…`;
      result.textContent = dialog.open ? "" : status.textContent;
      clearProblem(resultError);
      outcome = await sendSong(body, {
        onProgress(fraction) {
          progress.value = Math.round(fraction * 100);
        },
        onSent() {
          sent = true;
          progress.removeAttribute("value");
          status.textContent = `Checking “${title}”…`;
          if (!dialog.open) result.textContent = status.textContent;
        },
      });
    } finally {
      lockForm(false);
      busy = false;
    }
    if (!outcome) return;
    if (outcome.ok) await succeed(outcome.track);
    else await fail(outcome.error, sent);
  });
}
