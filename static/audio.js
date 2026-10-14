export function createAudioController({
  element,
  shouldPlayRadio,
  returnLive,
  onPause,
  onRadioBlocked,
  onOwnerChange,
  onPlaybackChange,
  onError,
}) {
  const controller = {
    element,
    owner: "",
    label: "",
    stationId: "",
    generation: 0,
    playOperation: 0,
    pauseRequests: 0,
    preparing: 0,
    audible: false,
    transitioning: false,
    resuming: false,
    nativeState() {
      if (!this.owner) return "none";
      if (this.is("radio") && shouldPlayRadio()) {
        return this.audible && !element.paused && !element.ended
          ? "playing"
          : "buffering";
      }
      // A media error can stop audio without a pause event.
      if (element.error) return "paused";
      // During a stall (waiting) the element stays unpaused without audio.
      if (!element.paused) return this.audible ? "playing" : "buffering";
      // An owner that starts the next source once it loads is still active.
      return this.resuming ? "buffering" : "paused";
    },
    is(owner) {
      return this.owner === owner;
    },
    claim(owner, src, label, { stationId = "", resume = false } = {}) {
      const changedSource = !element.src.endsWith(src);
      const changedOwner = this.owner !== owner;
      const changedStation = owner === "radio" && this.stationId !== stationId;
      const needsReload =
        changedSource ||
        Boolean(element.error) ||
        element.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;
      if (!changedOwner && !changedStation && !changedSource && !needsReload) {
        this.label = label;
        onOwnerChange();
        onPlaybackChange();
        return false;
      }
      if (changedOwner || changedStation || changedSource) {
        window.dispatchEvent(
          new CustomEvent("zak-audio-release", {
            detail: {
              owner: this.owner,
              nextOwner: owner,
              position: element.currentTime || 0,
              playing: !element.paused,
              generation: this.generation,
            },
          }),
        );
      }
      this.generation++;
      this.transitioning = needsReload || changedOwner || changedStation;
      this.resuming = resume && this.transitioning;
      if (this.transitioning) this.audible = false;
      if (needsReload || changedOwner || changedStation) {
        element.pause();
      }
      this.owner = owner;
      this.label = label;
      this.stationId = owner === "radio" ? stationId : "";
      element.loop = false;
      clearMediaPositionState();
      if (needsReload) {
        element.src = src;
        element.load();
      }
      onOwnerChange();
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: label,
          artist:
            owner === "library" ? "Private library preview" : "Zak Reader",
          album: "Zak Radio",
        });
      }
      onPlaybackChange();
      window.dispatchEvent(
        new CustomEvent("zak-audio-owner", { detail: { owner, label } }),
      );
      return needsReload;
    },
    returnLive(sync = true) {
      return returnLive(sync);
    },
    clear(owner) {
      if (this.owner !== owner) return;
      this.generation++;
      this.audible = false;
      this.transitioning = false;
      this.resuming = false;
      element.pause();
      element.removeAttribute("src");
      element.load();
      this.owner = "";
      this.label = "";
      this.stationId = "";
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = null;
        clearMediaPositionState();
      }
      onOwnerChange();
      onPlaybackChange();
      window.dispatchEvent(
        new CustomEvent("zak-audio-owner", {
          detail: { owner: "", label: "" },
        }),
      );
    },
    pause() {
      // Explicit Pause cancels an in-flight play() and any start that an owner
      // deferred until metadata loads (see pauseRequests).
      this.playOperation++;
      this.pauseRequests++;
      this.resuming = false;
      onPause();
      element.pause();
      onPlaybackChange();
    },
    async play({ generation = this.generation, valid = () => true } = {}) {
      if (!this.owner || this.generation !== generation || !valid())
        return false;
      this.reloadIfFailed();
      const operation = ++this.playOperation;
      const isCurrent = () =>
        this.playOperation === operation &&
        this.generation === generation &&
        valid();
      let timeout;
      // Only the current start may change playback or native protection state.
      const failed = () => {
        if (!isCurrent()) return;
        this.resuming = false;
        onPlaybackChange();
      };
      try {
        if (element.paused || !this.audible) {
          this.preparing = operation;
          const ready = await window.ZakNativeHost?.prepare({
            title: this.label,
            subtitle: "Zak Radio",
          });
          if (this.preparing === operation) this.preparing = 0;
          if (!isCurrent() || (this.is("radio") && !shouldPlayRadio())) {
            // The host prepared for a play that is no longer wanted. Unless a
            // newer preparation is pending, restate what the page is doing.
            if (!this.preparing) onPlaybackChange();
            return false;
          }
          if (ready === false) {
            if (this.is("radio")) onRadioBlocked();
            element.pause();
            failed();
            return false;
          }
        }
        // A suspended mobile decoder can leave play() pending indefinitely.
        // Let the caller retry instead of blocking station refresh and recovery.
        const played = await Promise.race([
          element.play().then(() => true),
          new Promise((resolve) => {
            timeout = window.setTimeout(() => resolve(false), 4000);
          }),
        ]);
        if (!isCurrent()) return false;
        // A prepared host otherwise keeps foreground protection without audio.
        if (!played) failed();
        return played;
      } catch (error) {
        // Source changes and Pause can settle an earlier element.play() after
        // another owner or start has taken over. Its error belongs to that start.
        if (!isCurrent()) return false;
        if (error?.name !== "AbortError") {
          onError(error);
        }
        // Radio can't start here without a tap, so stop treating it as active.
        if (error?.name === "NotAllowedError" && this.is("radio"))
          onRadioBlocked();
        failed();
        return false;
      } finally {
        window.clearTimeout(timeout);
        if (this.preparing === operation) this.preparing = 0;
      }
    },
    reloadIfFailed({ stalled = false } = {}) {
      if (
        element.error ||
        element.networkState === HTMLMediaElement.NETWORK_NO_SOURCE ||
        (stalled &&
          !element.ended &&
          element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)
      ) {
        element.load();
        return true;
      }
      return false;
    },
    refreshOwner() {
      onOwnerChange();
    },
  };
  element.addEventListener("error", () => {
    controller.audible = false;
    controller.resuming = false;
  });
  element.addEventListener("pause", () => {
    controller.audible = false;
  });
  element.addEventListener("playing", () => {
    controller.audible = true;
    controller.transitioning = false;
    controller.resuming = false;
  });
  element.addEventListener("waiting", () => {
    controller.audible = false;
  });
  element.addEventListener("ended", () => {
    controller.audible = false;
    if (controller.is("radio")) controller.transitioning = true;
  });
  return controller;
}

function clearMediaPositionState() {
  if (
    !("mediaSession" in navigator) ||
    typeof navigator.mediaSession.setPositionState !== "function"
  )
    return;
  try {
    navigator.mediaSession.setPositionState();
  } catch {}
}
