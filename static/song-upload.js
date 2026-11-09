import { initSongKeys } from "./song-keys.js";

export function initSongUpload() {
  initSongKeys();
  const entry = document.getElementById("songUploadEntry");
  const open = document.getElementById("songUploadOpen");
  const dialog = document.getElementById("songUploadDialog");
  const form = document.getElementById("songUploadForm");
  const fields = document.getElementById("songUploadFields");
  const submit = document.getElementById("songUploadSubmit");
  const status = document.getElementById("songUploadStatus");
  const result = document.getElementById("songUploadResult");
  const audio = form.elements.audio;
  const lyrics = form.elements.lyrics;
  let busy = false;
  let limits;

  async function checkAccess() {
    try {
      limits = await window.ZakAPI("/api/song-upload");
      entry.hidden = !limits.enabled;
      open.hidden = !limits.can_upload;
      document.getElementById("songKeysOpen").hidden = !limits.can_manage_keys;
      document.getElementById("songUploadSignIn").hidden = limits.can_upload;
    } catch {
      entry.hidden = true;
    }
  }
  checkAccess();
  document.addEventListener("zak-route", () => {
    if (window.location.pathname.startsWith("/library")) checkAccess();
  });

  open.addEventListener("click", () => {
    if (!busy) status.textContent = "";
    dialog.showModal();
    if (!busy) form.elements.title.focus();
  });
  document
    .getElementById("songUploadClose")
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => open.focus({ preventScroll: true }));
  audio.addEventListener("change", () => audio.setCustomValidity(""));
  lyrics.addEventListener("input", () => lyrics.setCustomValidity(""));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const file = audio.files[0];
    if (
      !/\.mp3$/i.test(file.name) ||
      file.size === 0 ||
      file.size > limits.max_audio_bytes
    ) {
      audio.setCustomValidity("Choose a nonempty .mp3 file, up to 32 MiB.");
      audio.reportValidity();
      return;
    }
    if (
      new TextEncoder().encode(lyrics.value).length > limits.max_lyrics_bytes
    ) {
      lyrics.setCustomValidity(
        "Lyrics must be no larger than 64 KiB of UTF-8 text.",
      );
      lyrics.reportValidity();
      return;
    }
    const body = new FormData(form);
    busy = true;
    fields.disabled = true;
    submit.disabled = true;
    form.setAttribute("aria-busy", "true");
    status.setAttribute("role", "status");
    status.textContent = "Uploading and checking audio…";
    result.textContent = "";
    let added = false;
    try {
      const response = await fetch("/api/tracks", {
        method: "POST",
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        let detail;
        if (
          response.headers.get("Content-Type")?.includes("application/json")
        ) {
          const payload = await response.json();
          detail =
            typeof payload.error?.message === "string"
              ? payload.error.message
              : "";
        } else {
          detail = (await response.text()).trim();
        }
        detail = detail.slice(0, 300);
        if (response.status === 401) await checkAccess();
        throw new Error(
          detail || `The song could not be added (${response.status}).`,
        );
      }
      if (!response.headers.get("Content-Type")?.includes("application/json")) {
        throw new Error(
          "Your sign-in may have expired. Reload this page and sign in again.",
        );
      }
      const { track } = await response.json();
      added = true;
      form.reset();
      result.textContent = `“${track.title}” was added to the library.`;
      status.textContent = result.textContent;
      try {
        await window.ZakCatalog.load(true);
      } catch {
        result.textContent = "Song added. Refresh Library to see it.";
      }
      dialog.close();
    } catch (error) {
      status.setAttribute("role", "alert");
      status.textContent =
        error.name === "TimeoutError"
          ? "The upload timed out. Check Library before trying again; the song may have been added."
          : error.message ||
            "The upload failed. Check Library before trying again.";
    } finally {
      busy = false;
      fields.disabled = false;
      submit.disabled = false;
      form.removeAttribute("aria-busy");
      if (!added && dialog.open) status.focus();
    }
  });
}
