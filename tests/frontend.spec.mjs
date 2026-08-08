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
  const trueRandom = page.getByRole("radio", { name: /True random/ });
  const noRepeats = page.getByRole("radio", { name: /No repeats/ });
  const skipDisliked = page.getByRole("checkbox", {
    name: /Skip disliked/,
  });
  await trueRandom.check();
  await expect(trueRandom).toBeChecked();
  await expect(page.locator("#radioQueueSummary")).toContainText(
    "repeats can happen",
  );
  await skipDisliked.check();
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
  await skipDisliked.uncheck();
  await noRepeats.check();
  await expect(noRepeats).toBeChecked();

  await page.locator("#createStation").click();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.locator("#stationEditor")).toBeVisible();
  await expect(page.locator("#stationEditorName")).toBeFocused();
  const editorNameBounds = await page.locator("#stationEditorName").evaluate(
    (input) => {
      const rect = input.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
    },
  );
  expect(editorNameBounds.top).toBeGreaterThanOrEqual(0);
  expect(editorNameBounds.bottom).toBeLessThanOrEqual(editorNameBounds.viewport);
});

test("shared radio skips require an explicit second tap", async ({ page }) => {
  const controls = [];
  await page.route("**/api/control", async (route) => {
    controls.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.goto("/");
  const next = page.locator("#next");

  await next.click();
  expect(controls).toEqual([]);
  await expect(next).toHaveAttribute(
    "aria-label",
    "Confirm skip for everyone",
  );
  await expect(page.locator("#toast")).toContainText(
    "skip this song for everyone listening",
  );

  await next.click();
  await expect.poll(() => controls.length).toBe(1);
  expect(controls[0].action).toBe("next");
  await expect(next).toHaveAttribute("aria-label", "Next track");
});

test("radio refreshes and resynchronizes as soon as connectivity returns", async ({ page }) => {
  const authoritative = await (await page.request.get("/api/station")).json();
  authoritative.playing = true;
  authoritative.position = 0;
  authoritative.server_time = Date.now() / 1000;
  let stationRequests = 0;
  await page.route("**/api/station?*", async (route) => {
    stationRequests++;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...authoritative,
        server_time: Date.now() / 1000,
      }),
    });
  });
  await page.route("**/api/station/events?*", async (route) => {
    await route.fulfill({ status: 500, body: "offline" });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Join live", exact: true }).click();
  const beforeRecovery = stationRequests;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => stationRequests).toBeGreaterThan(beforeRecovery);
  await expect(page.locator("#audio")).toHaveAttribute("preload", "auto");
  await expect(page.locator("#audio")).toHaveAttribute("playsinline", "");
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

test("station polling is scoped instead of implying whole-product failure", async ({ page }) => {
  await page.route("**/api/station/events**", (route) => route.abort());
  await page.goto("/library");
  await expect(page.locator("#connectionText")).toHaveText(
    "Station updates polling",
  );
  await expect(page.locator("#connection")).toHaveAttribute(
    "aria-label",
    /live station stream is reconnecting; station state is still refreshing/,
  );
  await expect(page.locator("#libraryCount")).toContainText("matching tracks");
  await expect(page.locator("#connectionDot")).toHaveClass(/is-polling/);
  await expect(page.locator("#connectionDot")).not.toHaveClass(/is-disconnected/);
});

test("unchanged station capability does not retrigger its live region", async ({ page }) => {
  await page.goto("/");
  const stableNodes = await page.evaluate(() => {
    const label = document.querySelector("#stationCapabilityLabel");
    const detail = document.querySelector("#stationCapabilityDetail");
    const labelNode = label.firstChild;
    const detailNode = detail.firstChild;
    window.dispatchEvent(
      new CustomEvent("zak-audio-owner", {
        detail: { owner: window.ZakAudio.owner, label: window.ZakAudio.label },
      }),
    );
    return {
      label: label.firstChild === labelNode,
      detail: detail.firstChild === detailNode,
    };
  });
  expect(stableNodes).toEqual({ label: true, detail: true });
});

test("Library discovery precedes saved-station administration", async ({ page }) => {
  await page.goto("/library");
  await expect(page.locator("#libraryTracks")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const order = await page.evaluate(() => {
    const tools = document.querySelector(".library-tools");
    const tracks = document.querySelector("#libraryTracks");
    const stations = document.querySelector("#stationManager");
    return {
      toolsBeforeTracks: Boolean(
        tools.compareDocumentPosition(tracks) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      tracksBeforeStations: Boolean(
        tracks.compareDocumentPosition(stations) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
      tracksTop: tracks.getBoundingClientRect().top,
      stationsTop: stations.getBoundingClientRect().top,
    };
  });
  expect(order.toolsBeforeTracks).toBe(true);
  expect(order.tracksBeforeStations).toBe(true);
  expect(order.stationsTop).toBeGreaterThan(order.tracksTop);
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
        quality: {
          line_coverage: 1,
          alternate_vocals_detected: true,
          alternate_vocals_unresolved: true,
        },
        cues: [
          {
            start: 0.05,
            end: 0.45,
            section: "Verse",
            text: "First line",
            secondary_text: "Second singer",
            quality_status: "warning",
          },
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
  await expect(page.locator(".synced-lyric-cue").first()).toHaveClass(/is-uncertain/);
  await expect(page.locator(".synced-lyric-secondary")).toHaveText("Second singer");
  await expect(page.locator(".synced-lyrics-heading")).toHaveCount(0);
  await expect(page.getByText("Verse", { exact: true })).toHaveCount(0);
  await expect(page.locator("#lyricsSyncStatus")).toHaveText(
    "Alternate vocals detected · exact words need review",
  );
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

test("product identity and route semantics persist at every required width", async ({ page }) => {
  for (const [width, height] of [
    [1440, 1000],
    [900, 900],
    [390, 844],
    [320, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const [path, name] of [
      ["/", "Radio"],
      ["/library", "Library"],
      ["/reader", "Reader"],
    ]) {
      await page.goto(path);
      await expect(page.locator(".brand-mark")).toBeVisible();
      await expect(page.locator(".brand-family")).toHaveText("Zakstak");
      await expect(page.locator(".brand-title")).toBeVisible();
      await expect(page.locator(".brand-title")).toHaveText("Zak Radio");
      await expect(
        page.getByRole("navigation", { name: "Zak Radio destinations" })
          .getByRole("link", { name }),
      ).toHaveAttribute("aria-current", "page");
      await expect(page.locator("#connectionText")).toHaveText(
        /Station updates (live|polling|reconnecting)/,
      );
      expect(await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }))).toEqual({ viewport: width, scroll: width });
    }
  }
});

test("phone navigation and station controls follow playback without becoming persistent chrome", async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/");
    await expect(page.locator("#stationStatus")).not.toHaveText("Connecting…");

    const layout = await page.evaluate(() => {
      const rail = document.querySelector(".app-rail");
      const station = document.querySelector("#stationCard");
      const transport = document.querySelector("#transport");
      const visibleControls = [
        ...rail.querySelectorAll(".primary-nav-link"),
        ...station.querySelectorAll("#stationSelect, .station-action"),
      ].filter((element) => {
        const style = getComputedStyle(element);
        return !element.hidden && style.display !== "none"
          && element.getClientRects().length > 0;
      });
      return {
        position: getComputedStyle(rail).position,
        railHeight: rail.getBoundingClientRect().height,
        identityRows: getComputedStyle(
          rail.querySelector(".app-rail-inner"),
        ).gridTemplateRows,
        stationTop: station.getBoundingClientRect().top,
        transportBottom: transport.getBoundingClientRect().bottom,
        viewportWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        controls: visibleControls.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            height: rect.height,
            left: rect.left,
            right: rect.right,
          };
        }),
      };
    });

    expect(layout.position).toBe("static");
    expect(layout.identityRows.split(" ")[0]).toBe("56px");
    expect(layout.stationTop).toBeGreaterThanOrEqual(layout.transportBottom);
    expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.controls.length).toBeGreaterThanOrEqual(5);
    for (const control of layout.controls) {
      expect(control.height).toBeGreaterThanOrEqual(44);
      expect(control.left).toBeGreaterThanOrEqual(0);
      expect(control.right).toBeLessThanOrEqual(layout.viewportWidth);
    }

    await page.evaluate((distance) => window.scrollTo(0, distance), layout.railHeight + 48);
    await expect.poll(() => page.locator(".app-rail").evaluate(
      (rail) => rail.getBoundingClientRect().bottom,
    )).toBeLessThanOrEqual(0);
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator(".app-rail").evaluate(
    (rail) => getComputedStyle(rail).position,
  )).toBe("sticky");
  await expect(page.locator(".app-rail")).toHaveCSS("height", "64px");
});

test("canonical control, focus, dialog, and mobile function geometry stays available", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/");
  await expect(page.locator("#stationStatus")).not.toHaveText("Connecting…");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(page.locator('[data-route="/"]')).toBeFocused();

  for (const selector of [
    "#playPause",
    "#next",
    "#like",
    "#dislike",
    "#download",
    "#addCurrentToStation",
    "#stationSelect",
    "#createStation",
    "#radioProgramming",
    "#radioQueue",
  ]) {
    await expect(page.locator(selector)).toBeVisible();
  }

  const geometry = await page.evaluate(() => {
    const control = document.querySelector("#createStation");
    const select = document.querySelector("#stationSelect");
    const route = document.querySelector('[data-route="/"]');
    const root = getComputedStyle(document.documentElement);
    const routeStyle = getComputedStyle(route);
    return {
      signal: root.getPropertyValue("--zs-signal").trim(),
      readable: root.getPropertyValue("--zs-signal-readable").trim(),
      controlHeight: control.getBoundingClientRect().height,
      controlRadius: getComputedStyle(control).borderRadius,
      selectHeight: select.getBoundingClientRect().height,
      outlineColor: routeStyle.outlineColor,
      outlineWidth: routeStyle.outlineWidth,
      overflow: document.documentElement.scrollWidth
        - document.documentElement.clientWidth,
    };
  });
  expect(geometry).toEqual({
    signal: "#8983e8",
    readable: "#d7d3ff",
    controlHeight: 44,
    controlRadius: "2px",
    selectHeight: 44,
    outlineColor: "rgb(215, 211, 255)",
    outlineWidth: "2px",
    overflow: 0,
  });

  await page.locator("#addToStationDialog").evaluate((dialog) => {
    dialog.showModal();
  });
  const dialog = page.locator("#addToStationDialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  const dialogBounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      backdropFilter: getComputedStyle(element, "::backdrop").backdropFilter,
    };
  });
  expect(dialogBounds.left).toBeGreaterThanOrEqual(16);
  expect(dialogBounds.right).toBeLessThanOrEqual(304);
  expect(dialogBounds.top).toBeGreaterThanOrEqual(16);
  expect(dialogBounds.bottom).toBeLessThanOrEqual(828);
  expect(dialogBounds.backdropFilter).toBe("none");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  await page.goto("/library");
  for (const selector of [
    "#createFilterStation",
    "#createListStation",
    "#librarySearch",
    "#librarySort",
    "[data-library-view='grid']",
    "[data-library-filter='all']",
    ".track-card-actions",
  ]) {
    await expect(page.locator(selector).first()).toBeVisible();
  }
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth
      - document.documentElement.clientWidth)).toBe(0);

  await page.goto("/reader");
  for (const selector of [
    "#readerSearch",
    "#readerSort",
    "[data-reader-filter='all']",
    "[data-reader-filter='ready']",
    "[data-reader-filter='processing']",
  ]) {
    await expect(page.locator(selector)).toBeVisible();
  }
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth
      - document.documentElement.clientWidth)).toBe(0);
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

test("mobile audio owner stays compact and reserves its measured inset", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/reader");
  const ownerBar = page.locator("#audioOwnerBar");
  await expect(ownerBar).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/has-audio-owner/);
  await expect(page.locator("#audioOwnerPlayPause")).toBeVisible();
  await expect(page.locator("#returnLive")).toHaveAttribute(
    "aria-label",
    "Open Radio controls",
  );
  const geometry = await page.evaluate(() => {
    const bar = document.querySelector("#audioOwnerBar");
    const view = document.querySelector("#readerView");
    const shell = document.querySelector(".app-shell");
    const barRect = bar.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    return {
      barHeight: barRect.height,
      barBottom: barRect.bottom,
      shellBottom: shellRect.bottom,
      barTop: barRect.top,
      viewPaddingBottom: Number.parseFloat(getComputedStyle(view).paddingBottom),
      controlHeights: [...bar.querySelectorAll("button")].map(
        (button) => button.getBoundingClientRect().height,
      ),
      viewportHeight: window.innerHeight,
      viewportWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  expect(geometry.barHeight).toBeLessThanOrEqual(72);
  expect(geometry.barBottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.shellBottom).toBeLessThanOrEqual(geometry.barTop);
  expect(geometry.viewPaddingBottom).toBeGreaterThanOrEqual(
    geometry.barHeight + 20,
  );
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  for (const height of geometry.controlHeights) {
    expect(height).toBeGreaterThanOrEqual(44);
  }
});

test("mobile audio-owner transitions preserve the active route scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/library");
  await expect(page.locator("body")).toHaveClass(/has-audio-owner/);
  await expect(page.locator("#libraryTracks")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect
    .poll(() =>
      page.locator(".app-shell").evaluate(
        (shell) => shell.scrollHeight - shell.clientHeight,
      ),
    )
    .toBeGreaterThan(500);
  const initial = await page.evaluate(() => {
    const shell = document.querySelector(".app-shell");
    shell.scrollTo({ top: 420 });
    return shell.scrollTop;
  });
  expect(initial).toBeGreaterThan(300);

  await page.evaluate(() => {
    window.ZakAudio.claim(
      "library",
      "/media/alpha/audio",
      "Alpha Sunrise",
    );
  });
  await expect(page.locator("body")).not.toHaveClass(/has-audio-owner/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(
    initial,
    -1,
  );

  const windowPosition = await page.evaluate(() => {
    window.scrollTo({ top: 520 });
    return window.scrollY;
  });
  expect(windowPosition).toBeGreaterThan(400);
  await page.evaluate(() => window.ZakAudio.returnLive(false));
  await expect(page.locator("body")).toHaveClass(/has-audio-owner/);
  await expect
    .poll(() =>
      page.locator(".app-shell").evaluate((shell) => shell.scrollTop),
    )
    .toBeCloseTo(windowPosition, -1);
});

test("audio-owner scroll survives crossing the mobile breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/library");
  await expect(page.locator("body")).toHaveClass(/has-audio-owner/);
  await expect(page.locator("#libraryTracks")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const mobilePosition = await page.locator(".app-shell").evaluate((shell) => {
    document.querySelector("#libraryView").style.minHeight = "3000px";
    shell.scrollTo({ top: 420 });
    return shell.scrollTop;
  });
  expect(mobilePosition).toBeGreaterThan(300);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );

  await page.setViewportSize({ width: 900, height: 844 });
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeCloseTo(mobilePosition, -1);

  const desktopPosition = await page.evaluate(() => {
    window.scrollTo({ top: 520 });
    return window.scrollY;
  });
  expect(desktopPosition).toBeGreaterThan(400);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.locator(".app-shell").evaluate((shell) => shell.scrollTop),
    )
    .toBeCloseTo(desktopPosition, -1);
});

test("Reader deferred restoration uses the active mobile scroller", async ({ page }) => {
  const item = {
    id: "reader-scroll",
    title: "Long Reader Item",
    source_url: "https://example.test/reader-scroll",
    source_type: "html",
    status: "ready",
    voice: "fixture",
    total_duration: 0,
    segment_count: 20,
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
    if (url.pathname === `/api/reader/items/${item.id}`) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ item }),
      });
    }
    if (url.pathname.endsWith("/images")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ images: [] }),
      });
    }
    if (url.pathname.endsWith("/segments")) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          segments: Array.from({ length: 20 }, (_, index) => ({
            segment_index: index,
            heading_path: [],
            kind: "paragraph",
            text: `Reader scroll fixture paragraph ${index}. `.repeat(12),
            status: "ready",
            duration: 0,
            audio_bytes: 0,
          })),
          next_offset: null,
        }),
      });
    }
    if (
      url.pathname === "/api/reader/playback" &&
      route.request().method() === "GET"
    ) {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    }
    return route.fallback();
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/reader");
  await expect(page.locator("body")).toHaveClass(/has-audio-owner/);
  await page.evaluate(() => {
    window.ZakPendingRouteScroll = [0, 420];
  });
  await page.locator(`[data-item-id="${item.id}"]`).click();
  await expect(page.locator("#readerText")).toHaveAttribute("aria-busy", "false");
  await expect
    .poll(() =>
      page.locator(".app-shell").evaluate((shell) => shell.scrollTop),
    )
    .toBeGreaterThan(350);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("Space toggles owner-control disclosure without controlling playback", async ({ page }) => {
  let controlRequests = 0;
  page.on("request", (request) => {
    if (
      new URL(request.url()).pathname === "/api/control" &&
      request.method() === "POST"
    ) {
      controlRequests++;
    }
  });
  await page.goto("/");
  const disclosure = page.locator("#radioOwnerControls");
  const summary = disclosure.locator("summary");
  await expect(disclosure).toHaveAttribute("open", "");
  await summary.focus();
  await page.keyboard.press("Space");
  await expect(disclosure).not.toHaveAttribute("open", "");
  expect(controlRequests).toBe(0);
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
  await expect(page.locator("#radioView")).toHaveClass(/is-listen-only/);
  await expect(page.locator("#stationCapabilityLabel")).toHaveText(
    "Listen-only private station",
  );
  await expect(page.locator("#stationCapabilityDetail")).toContainText(
    "Join live, follow lyrics, react, and download",
  );
  await expect(page.locator("#next")).toBeDisabled();
  await expect(page.locator("#next")).toBeVisible();
  await expect(page.locator("#like")).toBeEnabled();
  await expect(page.locator("#download")).toBeVisible();
  expect(await page.evaluate(
    (id) => localStorage.getItem(`zak-radio-owner:${id}`), station.station_id,
  )).toBeNull();
});

test("listen-only saved stations put owner programming behind a capability boundary", async ({ page }) => {
  const created = await page.request.post("/api/stations", {
    data: {
      idempotency_key: "abcdefabcdefabcdefabcdefabcdefab",
      owner_token: "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
      name: "Listener deck",
      source_type: "filter",
      filter_mode: "all",
      filter_query: "",
      random_mode: "deck",
      skip_disliked: false,
      track_ids: [],
    },
  });
  expect(created.ok()).toBe(true);
  const station = await created.json();
  await page.goto(`/?station=${station.station_id}`);
  await expect(page.locator("#stationCapabilityLabel")).toHaveText(
    "Listen-only saved station",
  );
  await expect(page.locator("#radioOwnerControls")).toBeVisible();
  await expect(page.locator("#radioOwnerControls")).not.toHaveAttribute("open");
  await expect(page.locator("#radioOwnerControlsSummary")).toHaveText(
    "Station owner controls these settings",
  );
  await expect(page.locator("#radioProgramming")).toBeHidden();
  await expect(
    page.locator('#stationRandomMode input[value="deck"]'),
  ).toBeDisabled();
  await expect(page.locator("#like")).toBeEnabled();
  await expect(page.locator("#download")).toBeVisible();
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
