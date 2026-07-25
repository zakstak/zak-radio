import { expect, test } from "@playwright/test";

test("date-only metadata stays in its catalog month", async ({ page }) => {
  await page.goto("/library");
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.locator('[data-track-id="alpha"]')).toContainText(
    "Jul 2026", { timeout: 15_000 });
  expect(await page.evaluate(() => ({
    catalog: typeof window.ZakCatalog,
    reader: typeof window.ZakReader,
  }))).toEqual({ catalog: "object", reader: "object" });
});

test("Library queues tracks only for private stations", async ({ page }) => {
  await page.goto("/library");
  const audio = page.locator("#audio");
  const queueBefore = await page.evaluate(async () =>
    (await (await fetch("/api/station?station_id=main")).json()).queue);

  await page.getByRole("button", { name: "Choose actions for Alpha Sunrise" }).click();
  expect(await audio.evaluate((element) => element.paused)).toBe(true);
  expect(await page.evaluate(async () =>
    (await (await fetch("/api/station?station_id=main")).json()).queue)).toEqual(queueBefore);

  await expect(page.locator("#libraryStationTarget")).toContainText(
    "Radio stations use saved programming",
  );
  await expect(
    page.getByRole("button", { name: "Add Alpha Sunrise to queue" }),
  ).toBeHidden();

  const created = await page.request.post("/api/stations", {
    data: {
      idempotency_key: "11111111111111111111111111111111",
      owner_token: "222222222222222222222222222222222222222222222222",
      track_id: "alpha",
    },
  });
  expect(created.ok()).toBe(true);
  const privateStation = await created.json();
  await page.evaluate(({ id, token }) => {
    localStorage.setItem(`zak-radio-owner:${id}`, token);
  }, { id: privateStation.station_id, token: privateStation.owner_token });
  await page.goto(`/library?station=${privateStation.station_id}`);
  await page.getByRole("button", { name: "Add Alpha Sunrise to queue" }).click();
  await expect(page.locator(".track-action-status")).toContainText(
    "was added to your private station");
  await expect.poll(() => page.evaluate(async () =>
    window.ZakStation.current().queue.length),
  ).toBe(1);
});

test("Library completes saved station CRUD and list membership", async ({ page }) => {
  await page.goto("/library");

  await page.locator("#librarySearch").fill("Alpha");
  await page.locator("#createFilterStation").click();
  await page.locator("#stationEditorName").fill("Alpha filter");
  await page.locator("#stationEditor").dispatchEvent("submit");
  const filterRow = page.locator(".saved-station", { hasText: "Alpha filter" });
  await expect(filterRow).toContainText("“Alpha”");
  page.once("dialog", (dialog) => dialog.accept());
  await filterRow.getByRole("button", { name: "Delete" }).click();
  await expect(filterRow).toHaveCount(0);

  await page.locator("#createListStation").click();
  await page.locator("#stationEditorName").fill("Favorites deck");
  await page.locator("#stationEditor").dispatchEvent("submit");
  let listRow = page.locator(".saved-station", { hasText: "Favorites deck" });
  await expect(listRow).toContainText("0 songs");

  await page.getByRole("button", {
    name: "Add Alpha Sunrise to a saved station",
  }).click();
  await expect(page.locator("#addToStationDialog")).toBeVisible();
  await page.locator("#confirmAddToStation").click();
  await expect(page.locator("#addToStationDialog")).toBeHidden();

  listRow = page.locator(".saved-station", { hasText: "Favorites deck" });
  await listRow.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator("#stationEditorMembers")).toContainText(
    "Alpha Sunrise",
  );
  await page.locator("#stationEditorName").fill("Favorites renamed");
  await page.locator("#stationEditorMembers").getByRole("button", {
    name: "Remove",
  }).click();
  await page.locator("#stationEditor").dispatchEvent("submit");
  listRow = page.locator(".saved-station", { hasText: "Favorites renamed" });
  await expect(listRow).toContainText("0 songs");

  const stationID = await listRow.getByRole("link", { name: "Listen" })
    .getAttribute("href")
    .then((href) => new URL(href, "http://localhost").searchParams.get("station"));
  await page.goto("/");
  await page.locator("#stationSelect").selectOption(stationID);
  await expect(page).toHaveURL(new RegExp(`station=${stationID}`));
  await expect(page.locator("#stationMode")).toHaveText("Favorites renamed");

  await page.goto(`/library?station=${stationID}`);
  listRow = page.locator(".saved-station", { hasText: "Favorites renamed" });
  page.once("dialog", (dialog) => dialog.accept());
  await listRow.getByRole("button", { name: "Delete" }).click();
  await expect(listRow).toHaveCount(0);
});

test("Radio has cumulative reactions and a reduced transport", async ({ page }) => {
  await page.goto("/");

  for (const selector of [
    "#random",
    "#prev",
    "#back10",
    "#forward10",
    "#repeatOne",
    "#stationProgress",
  ]) {
    await expect(page.locator(selector)).toBeHidden();
  }
  await expect(page.locator("#playPause")).toBeVisible();
  await expect(page.locator("#next")).toBeVisible();
  await expect(page.locator("#like")).toBeVisible();
  await expect(page.locator("#dislike")).toBeVisible();
  await expect(page.locator("#download")).toBeVisible();
  await expect(page.locator("#radioProgramming")).toBeVisible();
  await expect(page.locator("#radioQueue")).toBeVisible();
  await page.locator("#stationRandomMode").selectOption("true_random");
  await expect(page.locator("#radioQueueSummary")).toContainText(
    "repeats can happen",
  );
  await page.locator("#stationSkipDisliked").check();
  await expect.poll(() => page.evaluate(async () =>
    (await (await fetch("/api/station")).json()).skip_disliked)).toBe(true);

  const before = await page.evaluate(() => ({
    likes: Number(window.ZakCatalog.tracks[0].like_count || 0),
    dislikes: Number(window.ZakCatalog.tracks[0].dislike_count || 0),
  }));
  await page.locator("#like").click();
  await page.locator("#like").click();
  await page.locator("#dislike").click();
  await expect(page.locator("#like")).toHaveText(`♡ Like · ${before.likes + 2}`);
  await expect(page.locator("#dislike")).toHaveText(
    `Dislike · ${before.dislikes + 1}`,
  );
  await page.locator("#stationSkipDisliked").uncheck();
  await page.locator("#stationRandomMode").selectOption("deck");

  await page.locator("#createStation").click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.locator("#stationEditor")).toBeVisible();
});

test("weak track metadata falls back to its subject and deliberate no-artwork icon", async ({ page }) => {
  const original = await (await page.request.get("/api/tracks")).json();
  const weakTrack = {
    ...original.tracks[0],
    title: "[Intro]",
    group: "[Intro]",
    summary: "Midnight deployment",
    has_cover: false,
  };
  await page.route("**/api/tracks", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ...original, tracks: [weakTrack] }),
  }));

  await page.goto("/library");
  const card = page.locator(`[data-track-id="${weakTrack.id}"]`);
  await expect(card.locator(".track-card-title")).toHaveText("Midnight deployment");
  await expect(card.locator(".track-cover-fallback .no-artwork-icon")).toBeVisible();
  await expect(card.locator(".track-cover-fallback")).toContainText("No artwork");
  await expect(card).not.toContainText("[Intro]");

  await page.goto("/");
  await expect(page.locator("#title")).toHaveText("Midnight deployment");
  await expect(page.locator("#emptyCover .no-artwork-icon")).toBeVisible();
  await expect(page.locator("#emptyCover")).toContainText("No artwork");
});

test("Polling is an activity state rather than an error state", async ({ page }) => {
  await page.route("**/api/station/events**", (route) => route.abort());
  await page.goto("/library");
  await expect(page.locator("#connectionText")).toHaveText("Polling");
  await expect(page.locator("#connectionDot")).toHaveClass(/is-polling/);
  await expect(page.locator("#connectionDot")).not.toHaveClass(/is-disconnected/);
});

test("timed lyrics follow radio playback, yield to scrolling, and seek the station", async ({ page }) => {
  const catalog = await (await page.request.get("/api/tracks")).json();
  catalog.tracks[0].has_synced_lyrics = true;
  catalog.tracks[0].lyrics_timing_sha256 = "a".repeat(64);
  await page.route("**/api/tracks", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(catalog),
  }));
  await page.route("**/api/track/alpha?kind=timed_lyrics", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      id: "alpha",
      timed_lyrics: {
        version: 1,
        track_id: "alpha",
        duration: 1.5,
        quality: { line_coverage: 1 },
        cues: [
          { start: 0.05, end: 0.45, section: "Verse", text: "First line" },
          { start: 0.55, end: 1.2, section: "Verse", text: "Second line" },
        ],
      },
    }),
  }));
  let seekPosition = null;
  await page.route("**/api/control", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "seek") seekPosition = body.position;
    await route.continue();
  });

  await page.goto("/");
  await expect(page.locator(".synced-lyric-cue")).toHaveCount(2);
  await expect(page.locator(".synced-lyrics-heading")).toHaveCount(0);
  await expect(page.getByText("Verse", { exact: true })).toHaveCount(0);
  await expect(page.locator("#lyricsSyncStatus")).toHaveText("Following the song");
  await expect(page.locator("#lyricsViewport")).toHaveClass(/has-synced-lyrics/);
  await expect.poll(() => page.locator("#detailsPanels").evaluate((lyrics) => {
    const programming = document.getElementById("radioProgramming");
    return Boolean(
      lyrics.compareDocumentPosition(programming)
      & Node.DOCUMENT_POSITION_FOLLOWING
    );
  })).toBe(true);
  await page.locator("#lyricsViewport").evaluate((viewport) => {
    viewport.style.height = "40px";
    viewport.style.maxHeight = "40px";
  });
  await page.locator("#audio").evaluate((audio) => {
    audio.currentTime = 0.7;
    audio.dispatchEvent(new Event("timeupdate"));
  });
  await expect(page.getByRole("button", { name: /Second line/ }))
    .toHaveAttribute("aria-current", "true");
  await expect.poll(() => page.locator("#lyricsViewport").evaluate(
    (viewport) => viewport.scrollTop,
  )).toBeGreaterThan(0);

  await page.locator("#lyricsViewport").dispatchEvent("wheel");
  await expect(page.getByRole("button", { name: "Follow song" })).toBeVisible();
  await expect(page.locator("#lyricsSyncStatus")).toContainText("follow paused");
  await page.getByRole("button", { name: "Follow song" }).click();
  await expect(page.getByRole("button", { name: "Follow song" })).toBeHidden();

  const firstLine = page.getByRole("button", { name: /Seek to .*First line/ });
  await expect(firstLine).toBeDisabled();
  const created = await page.request.post("/api/stations", {
    data: {
      idempotency_key: "abababababababababababababababab",
      owner_token: "cd".repeat(24),
      track_id: "alpha",
    },
  });
  const privateStation = await created.json();
  await page.evaluate(({ id, token }) => {
    localStorage.setItem(`zak-radio-owner:${id}`, token);
  }, { id: privateStation.station_id, token: privateStation.owner_token });
  await page.goto(`/?station=${privateStation.station_id}`);
  await expect(firstLine).toBeEnabled();
  await firstLine.click();
  await expect.poll(() => seekPosition).toBe(0.05);
});

test("warning lyrics stay readable without presenting uncertain timing as exact", async ({ page }) => {
  const catalog = await (await page.request.get("/api/tracks")).json();
  catalog.tracks[0].has_synced_lyrics = false;
  catalog.tracks[0].lyrics_quality_status = "warning";
  await page.route("**/api/tracks", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(catalog),
  }));
  await page.route("**/api/track/alpha?kind=lyrics", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      id: "alpha",
      lyrics: "Clean generated line",
    }),
  }));

  await page.goto("/");
  await expect(page.locator("#lyrics")).toHaveText("Clean generated line");
  await expect(page.locator("#lyricsSyncStatus")).toHaveText(
    "Auto-generated lyrics · timing may be off",
  );
  await expect(page.locator("#lyricsViewport")).not.toHaveClass(
    /has-synced-lyrics/,
  );
});

test("switching stations retires an in-flight update from the prior station", async ({ page }) => {
  const catalog = await (await page.request.get("/api/tracks")).json();
  const authoritative = await (await page.request.get("/api/station")).json();
  const privateStationID = "abcdef123456";
  let catalogRequests = 0;
  let releaseOldStation;
  const oldStationGate = new Promise((resolve) => {
    releaseOldStation = resolve;
  });
  let oldStationWaiting;
  const oldStationEntered = new Promise((resolve) => {
    oldStationWaiting = resolve;
  });

  await page.route("**/api/tracks", async (route) => {
    catalogRequests++;
    if (catalogRequests === 2) {
      oldStationWaiting();
      await oldStationGate;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(catalog),
    }).catch(() => {});
  });
  await page.route("**/api/station/events?*", (route) => route.abort());
  await page.route("**/api/station?*", async (route) => {
    const requested = new URL(route.request().url()).searchParams.get("station_id");
    const station = requested === privateStationID
      ? {
          ...authoritative,
          station_id: privateStationID,
          track_id: catalog.tracks[0].id,
          catalog_revision: catalog.catalog_revision,
          revision: 22,
          queue: ["private-choice"],
        }
      : {
          ...authoritative,
          station_id: "main",
          catalog_revision: "stale-main-catalog",
          revision: 11,
          queue: ["shared-choice"],
        };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(station),
    });
  });

  await page.goto("/");
  await Promise.race([
    oldStationEntered,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("old station did not enter catalog refresh")), 7000)),
  ]);
  await page.evaluate((stationID) => {
    history.pushState({}, "", `/?station=${stationID}`);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, privateStationID);
  await expect.poll(() => page.evaluate(() => window.ZakAudio.stationId))
    .toBe(privateStationID);
  await expect.poll(() => page.evaluate(() => window.ZakStation.current().queue))
    .toEqual(["private-choice"]);

  releaseOldStation();
  await expect.poll(() => page.evaluate(() => ({
    stationId: window.ZakAudio.stationId,
    queue: window.ZakStation.current().queue,
  }))).toEqual({
    stationId: privateStationID,
    queue: ["private-choice"],
  });
});

test("saved-station creation is single-flight in the Library editor", async ({ page }) => {
  await page.goto("/");
  let creates = 0;
  await page.route("**/api/stations", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    creates++;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        station_id: "abcdef123456abcdef123456abcdef12",
        owner_token: "ab".repeat(24),
        station: {
          station_id: "abcdef123456abcdef123456abcdef12",
          name: "Test station",
          source_type: "filter",
        },
      }),
    });
  });

  const create = page.locator("#createStation");
  await create.click();
  await page.locator("#stationEditorName").fill("Test station");
  const editor = page.locator("#stationEditor");
  await editor.dispatchEvent("submit");
  await editor.dispatchEvent("submit");
  await expect(editor).toBeHidden();
  expect(creates).toBe(1);
});

test("saved-station capacity failure stays visible in the editor", async ({ page }) => {
  await page.route("**/api/stations", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({
      status: 429,
      contentType: "text/plain",
      body: "temporary station capacity reached",
    });
  });
  await page.goto("/");
  await page.locator("#createStation").click();
  await page.locator("#stationEditorName").fill("At capacity");
  await page.locator("#stationEditor").dispatchEvent("submit");
  await expect(page.locator("#stationEditorStatus")).toContainText(
    "temporary station capacity reached",
  );
  await expect(page.locator("#stationEditor")).toBeVisible();
});

test("preview dock remains inside the viewport at the former sm breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 720 });
  await page.goto("/library");
  await page.locator("#audio").evaluate((audio) => {
    window.ZakPlaybackEvidence = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("audio did not advance")), 5000);
      const advanced = () => {
        if (audio.currentTime <= 0.05) return;
        window.clearTimeout(timeout);
        audio.removeEventListener("timeupdate", advanced);
        resolve({ currentTime: audio.currentTime, error: audio.error });
      };
      audio.addEventListener("timeupdate", advanced);
    });
  });
  await page.getByRole("button", { name: "Preview Alpha Sunrise" }).click();
  const layout = await page.locator("#libraryPreviewDock").evaluate((dock) => ({
    clientWidth: dock.clientWidth,
    scrollWidth: dock.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    actions: [...dock.querySelectorAll("button:not([hidden]),a:not([hidden])")]
      .filter((element) => getComputedStyle(element).display !== "none")
      .map((element) => element.getBoundingClientRect().right),
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(Math.max(...layout.actions)).toBeLessThanOrEqual(layout.viewportWidth);
  const played = await page.evaluate(() => window.ZakPlaybackEvidence);
  expect(played.currentTime).toBeGreaterThan(0.05);
  expect(played.error).toBeNull();

  await page.locator('a[data-route="/reader"]').first().click();
  await expect(page.locator("#audioOwnerBar")).toBeVisible();
  await expect(page.locator("#audioOwnerLabel")).toHaveText("Alpha Sunrise");
  const offRouteTime = await page.locator("#audio").evaluate((audio) => audio.currentTime);
  await expect.poll(() => page.locator("#audio").evaluate((audio) => audio.currentTime))
    .toBeGreaterThan(offRouteTime);
});

test("Reader announces filtering and clears current-item semantics in library mode", async ({ page }) => {
  const item = {
    id: "item-test",
    title: "Test Reader Item",
    source_url: "https://example.test/item",
    source_type: "html",
    status: "pending",
    voice: "fixture",
    total_duration: 0,
    segment_count: 1,
    audio_bytes: 0,
    uploaded_at: 1_700_000_000,
  };
  await page.route("**/api/reader/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/reader/items") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: [item], next_offset: null }),
      });
    }
    if (url.pathname === "/api/reader/items/item-test") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ item }),
      });
    }
    if (url.pathname === "/api/reader/items/item-test/images") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ images: [] }),
      });
    }
    if (url.pathname === "/api/reader/items/item-test/segments") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          segments: [{
            segment_index: 0,
            heading_path: [],
            kind: "paragraph",
            text: "Pending fixture text.",
            status: "pending",
            duration: 0,
            audio_bytes: 0,
          }],
          next_offset: null,
        }),
      });
    }
    return route.fallback();
  });

  await page.goto("/reader");
  await expect(page.locator("#readerCount")).toHaveAttribute("role", "status");
  await expect(page.locator("#readerCount")).toHaveAttribute("aria-live", "polite");
  await page.locator('[data-item-id="item-test"]').click();
  await expect(page.locator('[data-item-id="item-test"]')).toHaveAttribute("aria-current", "true");
  await page.locator('a[data-route="/reader"]').click();
  await expect(page.locator("#readerLibraryTitle")).toBeFocused();
  await expect(page.locator('[data-item-id="item-test"]')).not.toHaveAttribute("aria-current", "true");
  await expect(page.locator("#readerTime")).toHaveText("0:00");
  await expect(page.locator("#readerDuration")).toHaveText("0:00");
  await page.getByRole("button", { name: "Ready", exact: true }).click();
  await expect(page.locator("#readerCount")).toHaveText("0 reader items");
  await page.getByRole("button", { name: "Processing", exact: true }).click();
  await expect(page.locator("#readerCount")).toHaveText("1 reader items");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.locator("#readerSearch").fill("no match");
  await expect(page.locator("#readerCount")).toHaveText("0 reader items");
});

test("history restores scroll without focusing an offscreen heading", async ({ page }) => {
  await page.goto("/library");
  await page.evaluate(() => {
    document.body.style.minHeight = "3000px";
    window.scrollTo(0, 900);
  });
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(700);
  await page.evaluate(() => window.ZakCommitScrollState());
  await page.evaluate(() => window.ZakNavigate("/"));
  await page.goBack();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(700);
  await expect(page.locator('a[data-route="/library"]').first()).toBeFocused();
});

test("Library keeps loading distinct from an empty archive", async ({ page }) => {
  let releaseCatalog;
  const catalogGate = new Promise((resolve) => {
    releaseCatalog = resolve;
  });
  await page.route("**/api/tracks", async (route) => {
    await catalogGate;
    await route.fallback();
  });
  await page.goto("/");
  await page.locator('a[data-route="/library"]').first().click();
  await expect(page.locator("#libraryTracks")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#libraryTracks")).toContainText("Loading the archive…");
  await expect(page.locator("#libraryTracks")).not.toContainText("No tracks found");
  releaseCatalog();
  await expect(page.locator('[data-track-id="alpha"]')).toBeVisible();
});

test("Reader keeps loading distinct from an empty reading room", async ({ page }) => {
  let releaseReader;
  const readerGate = new Promise((resolve) => {
    releaseReader = resolve;
  });
  await page.route("**/api/reader/items?*", async (route) => {
    await readerGate;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ items: [], next_offset: null }),
    });
  });
  await page.goto("/reader");
  await expect(page.locator("#readerItems")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#readerItems")).toContainText("Loading Reader…");
  await expect(page.locator("#readerItems")).not.toContainText("reading room is quiet");
  releaseReader();
  await expect(page.locator("#readerItems")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#readerItems")).toContainText("reading room is quiet");
});

test("station outage does not invent a paused off-route player", async ({ page }) => {
  await page.route("**/api/station?*", async (route) => {
    await route.fulfill({ status: 503, contentType: "text/plain", body: "offline" });
  });
  await page.route("**/api/station/events?*", async (route) => {
    await route.fulfill({ status: 503, contentType: "text/plain", body: "offline" });
  });
  await page.goto("/library");
  await expect(page.locator("#audioOwnerBar")).toBeHidden();
  expect(await page.evaluate(() => window.ZakAudio.owner)).toBe("");
});

test("Share exposes a selectable fallback when Clipboard access is denied", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
    });
  });
  const created = await page.request.post("/api/stations", {
    data: {
      idempotency_key: "ef".repeat(16),
      owner_token: "12".repeat(24),
      name: "Share me",
      source_type: "list",
      random_mode: "deck",
      track_ids: ["alpha"],
    },
  });
  const station = await created.json();
  await page.goto(`/?station=${station.station_id}`);
  await page.locator("#shareStation").click();
  await expect(page.locator("#stationShareFallback")).toBeVisible();
  await expect(page.locator("#stationShareLink")).toBeFocused();
  await expect(page.locator("#stationShareLink")).toHaveValue(
    new RegExp(`station=${station.station_id}`),
  );
});

test("denied Web Storage does not block Library or Reader boot", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException("denied", "SecurityError");
    };
    Storage.prototype.setItem = () => {
      throw new DOMException("denied", "SecurityError");
    };
    Storage.prototype.removeItem = () => {
      throw new DOMException("denied", "SecurityError");
    };
  });
  await page.goto("/library");
  await expect(page.locator('[data-track-id="alpha"]')).toBeVisible();
  await page.locator('a[data-route="/reader"]').first().click();
  await expect(page.locator("#readerItems")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#readerCount")).toHaveText("0 reader items");
});

test("Library preserves active playback semantics across view rerenders", async ({ page }) => {
  await page.goto("/library");
  await page.getByRole("button", { name: "Preview Alpha Sunrise" }).click();
  await expect(page.getByRole("button", { name: "Pause preview Alpha Sunrise" })).toBeVisible();
  await page.getByRole("button", { name: "List" }).click();
  await expect(page.getByRole("button", { name: "Pause preview Alpha Sunrise" })).toBeVisible();
  await expect(page.locator('[data-track-id="alpha"]')).toHaveClass(/is-playing/);
});

test("Reader audio becomes usable before optional images finish", async ({ page }) => {
  const item = {
    id: "reader-fast-audio",
    title: "Fast audio",
    source_url: "https://example.test/fast",
    source_type: "html",
    status: "ready",
    voice: "fixture",
    total_duration: 1.5,
    segment_count: 1,
    audio_bytes: 25121,
    uploaded_at: 1_700_000_000,
  };
  let releaseImages;
  const imageGate = new Promise((resolve) => {
    releaseImages = resolve;
  });
  await page.route("**/api/reader/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/reader/items") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items: [item], next_offset: null }),
      });
    }
    if (url.pathname === "/api/reader/items/reader-fast-audio") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ item }),
      });
    }
    if (url.pathname.endsWith("/segments")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          segments: [{
            segment_index: 0,
            heading_path: [],
            kind: "paragraph",
            text: "Playable before images.",
            status: "ready",
            duration: 1.5,
            audio_bytes: 25121,
          }],
          next_offset: null,
        }),
      });
    }
    if (url.pathname.endsWith("/images")) {
      await imageGate;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ images: [] }),
      });
    }
    if (url.pathname === "/api/reader/playback") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          item_id: item.id,
          segment_index: 0,
          position: 0,
          playing: false,
          revision: 0,
        }),
      });
    }
    return route.fallback();
  });
  await page.goto("/reader");
  await page.locator('[data-item-id="reader-fast-audio"]').click();
  const segment = page.getByRole("button", { name: "Read: Playable before images." });
  await expect(segment).toBeEnabled();
  await expect(page.locator("#readerText")).toHaveAttribute("aria-busy", "false");
  await segment.focus();
  releaseImages();
  await expect(segment).toBeFocused();
});

test("Reader rapid A-B-A navigation prefers unsaved local progress", async ({ page }) => {
  const mediaResponse = await page.request.get("/media/alpha/audio");
  const media = await mediaResponse.body();
  const items = ["reader-a", "reader-b"].map((id) => ({
    id,
    title: id === "reader-a" ? "Reader A" : "Reader B",
    source_url: `https://example.test/${id}`,
    source_type: "html",
    status: "ready",
    voice: "fixture",
    total_duration: 1.5,
    segment_count: 1,
    audio_bytes: media.length,
    uploaded_at: 1_700_000_000,
  }));
  let releaseSave;
  const saveGate = new Promise((resolve) => {
    releaseSave = resolve;
  });
  let heldSave = false;
  await page.route("**/reader-media/**", async (route) => {
    await route.fulfill({ contentType: "audio/mpeg", body: media });
  });
  await page.route("**/api/reader/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/reader/items") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ items, next_offset: null }),
      });
    }
    const item = items.find((candidate) => url.pathname.includes(candidate.id));
    if (item && url.pathname === `/api/reader/items/${item.id}`) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ item }),
      });
    }
    if (item && url.pathname.endsWith("/segments")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          segments: [{
            segment_index: 0,
            heading_path: [],
            kind: "paragraph",
            text: `${item.title} segment`,
            status: "ready",
            duration: 1.5,
            audio_bytes: media.length,
          }],
          next_offset: null,
        }),
      });
    }
    if (item && url.pathname.endsWith("/images")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ images: [] }),
      });
    }
    if (url.pathname === "/api/reader/playback" && route.request().method() === "GET") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          item_id: url.searchParams.get("item_id"),
          segment_index: 0,
          position: 0,
          playing: false,
          revision: 0,
        }),
      });
    }
    if (url.pathname === "/api/reader/playback" && route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      if (body.item_id === "reader-a" && !heldSave) {
        heldSave = true;
        await saveGate;
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ...body, revision: 1 }),
      });
    }
    return route.fallback();
  });

  await page.goto("/reader");
  await page.locator('[data-item-id="reader-a"]').click();
  await page.getByRole("button", { name: "Read: Reader A segment" }).click();
  await expect.poll(() => page.locator("#audio").evaluate((audio) => audio.currentTime))
    .toBeGreaterThan(0.2);
  await page.locator("#readerLibraryBack").click();
  await page.locator('[data-item-id="reader-b"]').click();
  await expect(page.locator("#readerTitle")).toHaveText("Reader B");
  await page.locator("#readerLibraryBack").click();
  await page.locator('[data-item-id="reader-a"]').click();
  await expect(page.locator("#readerTitle")).toHaveText("Reader A");
  await expect.poll(() => page.locator("#readerProgress").inputValue().then(Number))
    .toBeGreaterThan(0.1);
  releaseSave();
});

test("failed Return live keeps local playback controllable", async ({ page }) => {
  await page.route("**/api/station?*", async (route) => {
    await route.fulfill({ status: 500, contentType: "text/plain", body: "unavailable" });
  });
  await page.route("**/api/station/events?*", async (route) => {
    await route.fulfill({ status: 500, contentType: "text/plain", body: "unavailable" });
  });
  await page.goto("/library");
  await page.getByRole("button", { name: "Preview Alpha Sunrise" }).click();
  await expect.poll(() => page.locator("#audio").evaluate((audio) => audio.currentTime))
    .toBeGreaterThan(0.05);
  await page.locator("#libraryReturnLive").click();
  await expect(page.locator("#libraryPreviewDock")).toBeVisible();
  await expect(page.locator("#libraryPlayPause")).toBeVisible();
  await expect(page.locator("#libraryPlayPause")).toBeEnabled();
  expect(await page.evaluate(() => window.ZakAudio.owner)).toBe("library");
});

test("audio ownership clears stale MediaSession position state", async ({ page }) => {
  await page.addInitScript(() => {
    window.positionStateCalls = [];
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setPositionState = (...args) => {
      window.positionStateCalls.push(args.length ? args[0] : null);
    };
  });
  await page.goto("/library");
  await page.evaluate(() => {
    navigator.mediaSession?.setPositionState({
      duration: 10,
      position: 5,
      playbackRate: 1.15,
    });
    window.ZakAudio.claim("library", "/media/alpha/audio", "Alpha Sunrise");
  });
  const calls = await page.evaluate(() => window.positionStateCalls);
  expect(calls.at(-1)).toBeNull();
});

test("Reader mobile header does not occlude focused segments", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 659 });
  await page.goto("/reader");
  await expect(page.locator(".reader-head")).toHaveCSS("position", "static");
});

test("slash shortcut is scoped to Library", async ({ page }) => {
  await page.goto("/reader");
  const readerCanceled = await page.locator("#readerLibraryTitle").evaluate((heading) => {
    heading.focus();
    const event = new KeyboardEvent("keydown", {
      key: "/",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(readerCanceled).toBe(false);
  await page.locator('a[data-route="/library"]').first().click();
  await page.locator("#libraryViewTitle").focus();
  await page.keyboard.press("/");
  await expect(page.locator("#librarySearch")).toBeFocused();
});

test("failed control recovery supersedes a stale poll", async ({ page }) => {
  const authoritative = await (await page.request.get("/api/station")).json();
  authoritative.playing = false;
  authoritative.position = 0;
  let stationRequests = 0;
  let pollStarted;
  const pollEntered = new Promise((resolve) => {
    pollStarted = resolve;
  });
  let releasePoll;
  const pollGate = new Promise((resolve) => {
    releasePoll = resolve;
  });
  await page.route("**/api/station?*", async (route) => {
    stationRequests++;
    if (stationRequests === 2) {
      pollStarted();
      await pollGate;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(authoritative),
    });
  });
  await page.route("**/api/station/events?*", async (route) => {
    await route.fulfill({ status: 500, contentType: "text/plain", body: "offline" });
  });
  await page.route("**/api/control", async (route) => {
    await route.fulfill({ status: 500, contentType: "text/plain", body: "rejected" });
  });
  await page.goto("/");
  await expect(page.locator("#stationStatus")).toHaveText("Station paused");
  await Promise.race([
    pollEntered,
    new Promise((_, reject) => setTimeout(() => reject(new Error("poll did not start")), 7000)),
  ]);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  releasePoll();
  await expect.poll(() => stationRequests).toBeGreaterThanOrEqual(3);
  await expect(page.locator("#stationStatus")).toHaveText("Station paused");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
});

test("stalled station request times out into an accessible retry", async ({ page }) => {
  await page.addInitScript(() => {
    window.ZakRequestTimeoutMS = 100;
  });
  const authoritative = await (await page.request.get("/api/station")).json();
  let stationRequests = 0;
  await page.route("**/api/station?*", async (route) => {
    stationRequests++;
    if (stationRequests === 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(authoritative),
    }).catch(() => {});
  });
  await page.route("**/api/station/events?*", async (route) => {
    await route.fulfill({ status: 500, contentType: "text/plain", body: "offline" });
  });
  await page.goto("/");
  await expect(page.locator("#radioRetry")).toBeVisible();
  await expect(page.locator("#stationStatus")).toHaveText("Station unavailable");
  await page.locator("#radioRetry").click();
  await expect.poll(() => stationRequests).toBeGreaterThanOrEqual(2);
  await expect(page.locator("#stationStatus")).toHaveText("Station paused");
  await expect(page.locator("#radioRetry")).toBeHidden();
});

test("forced recovery never overwrites a newer station event", async ({ page }) => {
  const stale = await (await page.request.get("/api/station")).json();
  let releaseRecovery;
  const recoveryGate = new Promise((resolve) => {
    releaseRecovery = resolve;
  });
  let recoveryEntered;
  const recoveryStarted = new Promise((resolve) => {
    recoveryEntered = resolve;
  });
  let holdRecovery = false;
  await page.route("**/api/station?*", async (route) => {
    if (holdRecovery) {
      holdRecovery = false;
      recoveryEntered();
      await recoveryGate;
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(stale),
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(stale),
    });
  });
  await page.route("**/api/control", async (route) => {
    holdRecovery = true;
    await route.fulfill({ status: 500, contentType: "text/plain", body: "rejected" });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await recoveryStarted;
  const origin = new URL(page.url()).origin;
  const update = await page.request.post("/api/control", {
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
    },
    data: {
      station_id: "main",
      action: "set_shuffle",
      shuffle: true,
    },
  });
  expect(update.ok()).toBe(true);
  await expect(page.locator("#random")).toHaveAttribute("aria-pressed", "true");
  releaseRecovery();
  await expect(page.locator("#random")).toHaveAttribute("aria-pressed", "true");
});

test("rejected private-station token converges to listen-only", async ({ page }) => {
  const ownerToken = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const created = await page.request.post("/api/stations", {
    data: {
      idempotency_key: "0123456789abcdef0123456789abcdef",
      owner_token: ownerToken,
      track_id: "alpha",
    },
  });
  expect(created.ok()).toBe(true);
  const station = await created.json();
  const staleToken = "ffffffffffffffffffffffffffffffffffffffffffffffff";
  await page.addInitScript(({ id, token }) => {
    localStorage.setItem(`zak-radio-owner:${id}`, token);
  }, { id: station.station_id, token: staleToken });
  await page.goto(`/?station=${station.station_id}`);
  await expect(page.locator("#stationAccess")).toContainText("Only this browser");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator("#stationAccess")).toContainText("Listen-only");
  await expect(page.locator("#next")).toBeDisabled();
  expect(await page.evaluate(
    (id) => localStorage.getItem(`zak-radio-owner:${id}`), station.station_id,
  )).toBeNull();
});

test("catalog replacement updates the active Library preview identity", async ({ page }) => {
  const original = await (await page.request.get("/api/tracks")).json();
  let replacement = false;
  const nextDigest = "f".repeat(64);
  await page.route("**/api/tracks", async (route) => {
    if (!replacement) return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(original),
    });
    const tracks = original.tracks.map((track) => track.id === "alpha"
      ? { ...track, title: "Alpha Remaster", audio_sha256: nextDigest }
      : track);
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...original,
        tracks,
        catalog_revision: "e".repeat(64),
      }),
    });
  });
  await page.goto("/library");
  await page.getByRole("button", { name: "Preview Alpha Sunrise" }).click();
  replacement = true;
  await page.evaluate(() => window.ZakCatalog.load(true));
  await page.getByRole("button", { name: "Preview Alpha Remaster" }).click();
  await expect(page.locator("#libraryDockTitle")).toContainText("Alpha Remaster");
  await expect.poll(() => page.locator("#audio").evaluate((audio) => audio.currentSrc))
    .toContain(`v=${nextDigest}`);
});

test("Recent filtering parses catalog dates linearly", async ({ page }) => {
  const original = await (await page.request.get("/api/tracks")).json();
  const template = original.tracks[0];
  const tracks = Array.from({ length: 5000 }, (_, index) => ({
    ...template,
    id: `track-${index}`,
    title: `Track ${index}`,
    created_at: `2026-07-${String(index % 28 + 1).padStart(2, "0")}`,
  }));
  await page.addInitScript(() => {
    window.dateParseCalls = 0;
    const originalParse = Date.parse;
    Date.parse = (...args) => {
      window.dateParseCalls++;
      return originalParse(...args);
    };
  });
  await page.route("**/api/tracks", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...original, tracks }),
    });
  });
  await page.goto("/library");
  await page.getByRole("button", { name: "Recent" }).click();
  expect(await page.evaluate(() => window.dateParseCalls)).toBeLessThan(11_000);
});

for (const [path, target] of [
  ["/", "#title"],
  ["/library", "#libraryViewTitle"],
  ["/reader", "#readerLibraryTitle"],
]) {
  test(`skip link bypasses application navigation on ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.keyboard.press("Tab");
    await expect(page.locator("#skipToContent")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(target)).toBeFocused();
  });
}
