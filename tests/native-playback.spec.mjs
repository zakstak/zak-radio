import { test, expect } from "@playwright/test";

// These tests run against the two-track fixture (see playwright.config.mjs), so
// every 1.5-second track boundary swaps the media element's source.

// Installs a fake Vessel bridge before the app boots. With automaticReady, the
// host acknowledges every media.prepare immediately; otherwise the test does.
// With deferCapabilities, the hello reply waits for window.__sendCapabilities.
async function openWithNativeHost(
  page,
  { automaticReady = true, deferCapabilities = false, path = "/" } = {},
) {
  await page.addInitScript(({ automaticReady, deferCapabilities }) => {
    const schema = "zakstak.native.v1";
    const reply = (message) =>
      window.ZakstakNativeBridge.onmessage({
        data: JSON.stringify({ schema, ...message }),
      });
    window.__hostMessages = [];
    window.__playedSources = [];
    window.__readyAll = (ready = true) => {
      for (const message of window.__hostMessages) {
        if (message.type === "media.prepare") {
          reply({ type: "media.ready", requestId: message.requestId, ready });
        }
      }
    };
    window.__command = (command) =>
      window.dispatchEvent(
        new CustomEvent("zakstak-native-media-command", { detail: { command } }),
      );
    window.ZakstakNativeBridge = {
      postMessage(value) {
        const message = JSON.parse(value);
        window.__hostMessages.push(message);
        if (message.type === "hello") {
          window.__sendCapabilities = () =>
            reply({
              type: "capabilities",
              mediaBuffering: true,
              foregroundMediaPreparation: true,
            });
          if (!deferCapabilities) queueMicrotask(window.__sendCapabilities);
        }
        if (message.type === "media.prepare" && automaticReady) {
          queueMicrotask(() =>
            reply({ type: "media.ready", requestId: message.requestId, ready: true }),
          );
        }
      },
    };
    document.addEventListener("DOMContentLoaded", () => {
      document.querySelector("#audio").addEventListener("playing", (event) => {
        window.__playedSources.push(new URL(event.target.currentSrc).pathname);
      });
    });
  }, { automaticReady, deferCapabilities });
  await page.goto(path);
}

const playedSources = (page) => page.evaluate(() => window.__playedSources);
const playedCount = async (page) => (await playedSources(page)).length;
const audioPaused = (page) => page.locator("#audio").evaluate((audio) => audio.paused);
const audioOwner = (page) => page.evaluate(() => window.ZakAudio.owner);
const mediaStates = (page) =>
  page.evaluate(() =>
    window.__hostMessages.filter((message) => message.type === "media").map((message) => message.state),
  );
const lastMediaState = async (page) => (await mediaStates(page)).at(-1);
const prepareRequested = (page) =>
  page.evaluate(() => window.__hostMessages.some((message) => message.type === "media.prepare"));
const sendCommand = (page, command) =>
  page.evaluate((command) => window.__command(command), command);

async function startRadio(page) {
  await expect(page.locator("#playPause")).toBeEnabled();
  await page.locator("#playPause").click();
  await expect.poll(() => playedCount(page)).toBeGreaterThanOrEqual(1);
}

// Station revisions advance when the station is read, and each one reaches the
// page through SSE. Waiting for several proves later updates stay silent.
async function waitForStationRevisions(page, count) {
  const revision = async () =>
    (await (await page.request.get("/api/station?station_id=main")).json()).revision;
  const start = await revision();
  await expect.poll(revision, { timeout: 8000 }).toBeGreaterThanOrEqual(start + count);
}

async function expectStoppedSilently(page) {
  await waitForStationRevisions(page, 3);
  expect(await audioOwner(page)).toBe("");
  expect(await audioPaused(page)).toBe(true);
  expect(await lastMediaState(page)).toBe("none");
}

async function mockReader(page, { segments, onMedia = null, onSave = null }) {
  const media = await (await page.request.get("/media/alpha/audio")).body();
  const item = {
    id: "reader-native",
    title: "Native reader",
    source_url: "https://example.test/native",
    source_type: "html",
    status: "ready",
    voice: "fixture",
    total_duration: 1.5 * segments.length,
    segment_count: segments.length,
    audio_bytes: media.length * segments.length,
    uploaded_at: 1_700_000_000,
  };
  await page.route("**/reader-media/**", async (route) => {
    await onMedia?.(new URL(route.request().url()).pathname);
    await route.fulfill({ contentType: "audio/mpeg", body: media });
  });
  await page.route("**/api/reader/**", async (route) => {
    const url = new URL(route.request().url());
    const json = (body) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/reader/items") return json({ items: [item], next_offset: null });
    if (url.pathname === `/api/reader/items/${item.id}`) return json({ item });
    if (url.pathname.endsWith("/segments")) {
      return json({
        segments: segments.map((text, index) => ({
          segment_index: index,
          heading_path: [],
          kind: "paragraph",
          text,
          status: "ready",
          duration: 1.5,
          audio_bytes: media.length,
        })),
        next_offset: null,
      });
    }
    if (url.pathname.endsWith("/images")) return json({ images: [] });
    if (url.pathname === "/api/reader/playback" && route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      onSave?.(body);
      return json({ ...body, revision: 1 });
    }
    if (url.pathname === "/api/reader/playback") {
      return json({ item_id: item.id, segment_index: 0, position: 0, playing: false, revision: 0 });
    }
    return route.fallback();
  });
  return item;
}

test("native foreground readiness precedes playback and stale readiness cannot undo Stop", async ({ page }) => {
  await openWithNativeHost(page, { automaticReady: false });
  await expect(page.locator("#playPause")).toBeEnabled();
  await page.locator("#playPause").click();
  await expect.poll(() => prepareRequested(page)).toBe(true);
  expect(await audioPaused(page)).toBe(true);
  await page.evaluate(() => {
    window.__command("stop");
    window.__readyAll();
  });
  await expect.poll(() => audioOwner(page)).toBe("");
  await page.waitForTimeout(500);
  expect(await playedSources(page)).toEqual([]);
});

test("track changes stay buffering or playing until an explicit Pause", async ({ page }) => {
  await openWithNativeHost(page);
  await startRadio(page);
  await expect.poll(() => playedCount(page)).toBeGreaterThanOrEqual(4);
  // Both fixture tracks played, so the element really changed source.
  expect(new Set(await playedSources(page))).toEqual(
    new Set(["/media/alpha/audio", "/media/beta/audio"]),
  );
  const states = await mediaStates(page);
  const active = states.slice(states.indexOf("playing"));
  expect(active).toContain("buffering");
  expect(active.every((state) => state === "playing" || state === "buffering")).toBe(true);

  await sendCommand(page, "pause");
  await expect.poll(() => lastMediaState(page)).toBe("paused");
  const count = await playedCount(page);
  // Outlast several track boundaries and the recovery timers.
  await page.waitForTimeout(5000);
  expect(await playedCount(page)).toBe(count);
  expect(await audioPaused(page)).toBe(true);
});

test("native Stop stays silent across later station revisions", async ({ page }) => {
  await openWithNativeHost(page);
  await startRadio(page);
  await sendCommand(page, "stop");
  await expectStoppedSilently(page);
});

test("native Play after Stop returns to the live station", async ({ page }) => {
  await openWithNativeHost(page);
  await startRadio(page);
  await sendCommand(page, "stop");
  await expect.poll(() => audioOwner(page)).toBe("");
  const count = await playedCount(page);
  await sendCommand(page, "play");
  await expect.poll(() => playedCount(page)).toBeGreaterThan(count);
  expect(await audioOwner(page)).toBe("radio");
  expect(await audioPaused(page)).toBe(false);
});

test("native Stop of a Library preview keeps Radio from reclaiming playback", async ({ page }) => {
  await openWithNativeHost(page);
  // Playing Radio first leaves the user-activation flag set, which used to let
  // the next station update resume Radio once Stop cleared the Library owner.
  await startRadio(page);
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await page.getByRole("button", { name: "Preview Alpha Sunrise" }).click();
  await expect.poll(() => audioOwner(page)).toBe("library");
  await sendCommand(page, "stop");
  await expectStoppedSilently(page);
});

test("native Stop saves Reader progress as paused", async ({ page }) => {
  const saves = [];
  const item = await mockReader(page, {
    segments: ["Only segment."],
    onSave: (body) => saves.push(body),
  });
  await openWithNativeHost(page, { path: "/reader" });
  await page.locator(`[data-item-id="${item.id}"]`).click();
  await page.getByRole("button", { name: "Read: Only segment." }).click();
  await expect.poll(() => page.locator("#audio").evaluate((audio) => audio.currentTime))
    .toBeGreaterThan(0.2);
  const savedBeforeStop = saves.length;
  await sendCommand(page, "stop");
  await expect.poll(() => saves.length).toBeGreaterThan(savedBeforeStop);
  expect(saves.at(-1)).toMatchObject({ item_id: item.id, playing: false });
  expect(saves.at(-1).position).toBeGreaterThan(0.2);
  expect(await audioOwner(page)).toBe("");
});

test("Pause while the next Reader segment loads cancels its deferred start", async ({ page }) => {
  let requestedNextSegment = false;
  let releaseNextSegment;
  const nextSegmentGate = new Promise((resolve) => {
    releaseNextSegment = resolve;
  });
  const item = await mockReader(page, {
    segments: ["First segment.", "Second segment."],
    onMedia: async (path) => {
      if (!path.endsWith("/1.mp3")) return;
      requestedNextSegment = true;
      await nextSegmentGate;
    },
  });
  await openWithNativeHost(page, { path: "/reader" });
  await page.locator(`[data-item-id="${item.id}"]`).click();
  await page.getByRole("button", { name: "Read: First segment." }).click();
  // The first segment ends and Reader defers the second start until metadata.
  await expect.poll(() => requestedNextSegment, { timeout: 8000 }).toBe(true);
  await sendCommand(page, "pause");
  releaseNextSegment();
  await expect.poll(() => page.locator("#audio").evaluate((audio) => audio.readyState))
    .toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(500);
  expect(await audioPaused(page)).toBe(true);
  expect(await playedSources(page)).toEqual([`/reader-media/${item.id}/0.mp3`]);
});

test("Play before the capabilities reply still waits for foreground preparation", async ({ page }) => {
  await openWithNativeHost(page, { deferCapabilities: true });
  await expect(page.locator("#playPause")).toBeEnabled();
  await page.locator("#playPause").click();
  await page.waitForTimeout(200);
  expect(await audioPaused(page)).toBe(true);
  expect(await prepareRequested(page)).toBe(false);
  await page.evaluate(() => window.__sendCapabilities());
  await expect.poll(() => playedCount(page)).toBeGreaterThanOrEqual(1);
  const types = await page.evaluate(() => window.__hostMessages.map((message) => message.type));
  expect(types).toContain("media.prepare");
});

test("a media error is not reported to the host as playing", async ({ page }) => {
  await openWithNativeHost(page, { path: "/library" });
  await page.getByRole("button", { name: "Preview Alpha Sunrise" }).click();
  // Loop the short fixture so the preview cannot pause by ending.
  await page.locator("#audio").evaluate(async (audio) => {
    audio.loop = true;
    if (audio.paused) await audio.play();
  });
  await expect.poll(() => lastMediaState(page)).toBe("playing");
  // A decode or network failure sets error without pausing the element.
  await page.locator("#audio").evaluate((audio) => {
    Object.defineProperty(audio, "error", { configurable: true, get: () => ({ code: 3 }) });
    audio.dispatchEvent(new Event("error"));
  });
  await expect.poll(() => lastMediaState(page)).toBe("paused");
  expect(await audioPaused(page)).toBe(false);
});

test("a stalled Library preview is reported as buffering", async ({ page }) => {
  await openWithNativeHost(page, { path: "/library" });
  await page.getByRole("button", { name: "Preview Alpha Sunrise" }).click();
  // Loop the short fixture so the preview cannot pause by ending.
  await page.locator("#audio").evaluate(async (audio) => {
    audio.loop = true;
    if (audio.paused) await audio.play();
  });
  await expect.poll(() => lastMediaState(page)).toBe("playing");
  // A network stall fires waiting and leaves the element unpaused.
  await page.locator("#audio").evaluate((audio) => audio.dispatchEvent(new Event("waiting")));
  await expect.poll(() => lastMediaState(page)).toBe("buffering");
  expect(await audioPaused(page)).toBe(false);
  await page.locator("#audio").evaluate((audio) => audio.dispatchEvent(new Event("playing")));
  await expect.poll(() => lastMediaState(page)).toBe("playing");
});

test("a prepared play that the browser rejects reports paused to the host", async ({ page }) => {
  await openWithNativeHost(page, { path: "/library" });
  const played = await page.evaluate(async () => {
    window.ZakAudio.claim("library", "/media/alpha/audio", "Blocked preview");
    // For example, an autoplay policy rejection without a pause or error event.
    document.querySelector("#audio").play = () =>
      Promise.reject(new DOMException("Blocked", "NotAllowedError"));
    return window.ZakAudio.play();
  });
  expect(played).toBe(false);
  const messages = await page.evaluate(() => window.__hostMessages);
  const prepared = messages.findLastIndex((message) => message.type === "media.prepare");
  expect(prepared).toBeGreaterThanOrEqual(0);
  expect(messages.slice(prepared + 1)).toContainEqual(
    expect.objectContaining({ type: "media", state: "paused" }),
  );
});

test("rejected foreground preparation stays silent through later station updates", async ({ page }) => {
  await openWithNativeHost(page, { automaticReady: false });
  await expect(page.locator("#playPause")).toBeEnabled();
  await page.locator("#playPause").click();
  await expect.poll(() => prepareRequested(page)).toBe(true);
  await page.evaluate(() => window.__readyAll(false));
  await expect.poll(() => lastMediaState(page)).toBe("paused");
  await page.waitForTimeout(4000);
  expect(await playedSources(page)).toEqual([]);
  expect(await audioPaused(page)).toBe(true);
});

test("an interruption stays paused through station updates", async ({ page }) => {
  await openWithNativeHost(page);
  await startRadio(page);
  // Audio-focus loss pauses the element without any request from the app.
  await page.locator("#audio").evaluate((audio) => audio.pause());
  await expect.poll(() => lastMediaState(page)).toBe("paused");
  const count = await playedCount(page);
  await page.waitForTimeout(3500);
  expect(await playedCount(page)).toBe(count);
  expect(await audioPaused(page)).toBe(true);
});

test("Radio keeps following the station after a transient interruption ends", async ({ page }) => {
  await openWithNativeHost(page);
  await startRadio(page);
  const count = await playedCount(page);
  // Chromium pauses for a transient focus loss and resumes the same player
  // when it ends, before the track changes.
  await page.locator("#audio").evaluate(async (audio) => {
    audio.pause();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await audio.play();
  });
  await expect.poll(() => playedCount(page), { timeout: 8000 })
    .toBeGreaterThanOrEqual(count + 3);
  expect(await audioPaused(page)).toBe(false);
});

test("Play after a local pause resumes this device when the station was paused elsewhere", async ({ page }) => {
  await openWithNativeHost(page);
  await startRadio(page);
  await sendCommand(page, "pause");
  await expect(page.locator("#playPause")).toHaveAttribute("aria-label", "Join live");
  // Another listener pauses the shared station.
  const paused = await page.request.post("/api/control", {
    data: { station_id: "main", owner_token: "", action: "pause" },
  });
  expect(paused.ok()).toBe(true);
  await expect(page.locator("#playPause")).toHaveAttribute("aria-label", "Play");
  const count = await playedCount(page);
  await sendCommand(page, "play");
  await expect.poll(() => playedCount(page)).toBeGreaterThan(count);
  // Outlast the control response and its station sync.
  await page.waitForTimeout(1000);
  expect(await audioPaused(page)).toBe(false);
});

for (const owner of ["library", "reader", "radio"]) {
  test(`Pause cancels pending native preparation for ${owner}`, async ({ page }) => {
    await openWithNativeHost(page, { automaticReady: false });
    await expect(page.locator("#playPause")).toBeEnabled();
    await page.evaluate((owner) => {
      window.ZakAudio.claim(owner, "/media/alpha/audio", "Pending track", { stationId: "main" });
      void window.ZakAudio.play();
    }, owner);
    await expect.poll(() => prepareRequested(page)).toBe(true);
    await page.evaluate(() => {
      window.__command("pause");
      window.__readyAll();
    });
    await page.waitForTimeout(100);
    expect(await playedSources(page)).toEqual([]);
    expect(await audioPaused(page)).toBe(true);
    expect(await lastMediaState(page)).toBe("paused");
  });
}

test("same-source explicit Pause cancels pending Reader play", async ({ page }) => {
  await openWithNativeHost(page, { automaticReady: false });
  await expect(page.locator("#playPause")).toBeEnabled();
  await page.evaluate(() => {
    window.ZakAudio.claim("reader", "/media/alpha/audio", "Pending reader");
    void window.ZakAudio.play();
    window.ZakAudio.claim("reader", "/media/alpha/audio", "Pending reader");
    window.ZakAudio.pause();
    window.__readyAll();
  });
  await page.waitForTimeout(100);
  expect(await playedSources(page)).toEqual([]);
  expect(await lastMediaState(page)).toBe("paused");
});
