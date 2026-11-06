export function focusBeside(trigger, backwards, panel) {
  const nodes = [
    ...document.querySelectorAll(
      "a[href], button, input, select, textarea, summary, [tabindex]",
    ),
  ].filter(
    (node) =>
      node.tabIndex >= 0 &&
      !node.disabled &&
      !node.closest("[hidden], [inert]") &&
      node.getClientRects().length &&
      !panel.contains(node),
  );
  const index = nodes.indexOf(trigger);
  const target = nodes[index + (backwards ? -1 : 1)];
  target?.focus();
}

// The window is the only scroll container. navigate() builds the query string
// from scratch: `station` (on Radio, when not main) and Reader's `item`.
// Station state stays out of Library and Reader addresses. Views that keep
// their own parameters (Library, the Reader list) restore them with
// history.replaceState when their route becomes active, and push their own
// entries for drill-downs so Back steps out one level at a time. The
// "zak-route" event says why the route rendered: "initial", "navigate", or
// "history" (Back and Forward), so views can tell a restore from a visit.
// "zak-before-route" fires before navigate() leaves an entry, so views can
// commit what is still pending (a debounced search) to it.
// Unknown addresses render the "Page not found" view.
const VIEW_PATHS = {
  "/": "/",
  "/library": "/library",
  "/library/": "/library",
  "/reader": "/reader",
  "/reader/": "/reader",
};
export function createRouter({
  els,
  stationId,
  selectedReaderId,
  onRender,
  onHistory,
}) {
  // Programmatic heading focus keeps navigation accessible. Only actual
  // keyboard input opts into a visible heading ring.
  document.addEventListener(
    "keydown",
    (event) => {
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      document.documentElement.dataset.keyboard = "true";
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    () => {
      document.documentElement.dataset.keyboard = "false";
    },
    true,
  );
  // Reveal the whole keyboard target and its ring in horizontal browsing
  // rows. Change only horizontal scroll; pointer focus must stay put.
  document.addEventListener("focusin", (event) => {
    if (document.documentElement.dataset.keyboard !== "true") return;
    const row = event.target.closest(".filter-row, .reader-continue-list");
    if (!row || row.scrollWidth <= row.clientWidth) return;
    const box = row.getBoundingClientRect();
    const target = (
      event.target.closest(".reader-continue-item") || event.target
    ).getBoundingClientRect();
    const inset = 6;
    if (target.left < box.left + inset)
      row.scrollLeft -= box.left + inset - target.left;
    else if (target.right > box.right - inset)
      row.scrollLeft += target.right - box.right + inset;
  });
  function setSkipTarget(id) {
    els.skipToContent.href = `#${id}`;
  }
  els.skipToContent.addEventListener("click", (event) => {
    const target = document.querySelector(
      els.skipToContent.getAttribute("href"),
    );
    if (!target || target.closest("[hidden]")) return;
    event.preventDefault();
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  });
  let scrollStateTimer = 0;
  let renderedPath = "";
  let pendingScroll = null;
  // Where each destination was left, by view and Reader item, so returning
  // by its tab puts it back where it was.
  const viewScroll = new Map();
  // The position before the latest change. A drill-down that shortens the
  // page clamps the scroll in the same task, before any scroll event.
  let lastScroll = [window.scrollX, window.scrollY];
  let lastKey = "";

  function routePath() {
    return VIEW_PATHS[window.location.pathname] || "/404";
  }

  function scrollRoute(options) {
    window.scrollTo(options);
  }

  function syncRouteLinks() {
    document.querySelectorAll("[data-route]").forEach((link) => {
      const url = new URL(link.dataset.route, window.location.origin);
      if (url.pathname === "/" && stationId() !== "main")
        url.searchParams.set("station", stationId());
      link.href = `${url.pathname}${url.search}${url.hash}`;
    });
  }

  function viewKey(url = window.location) {
    const path = VIEW_PATHS[url.pathname] || "/404";
    if (path !== "/reader") return path;
    const item = new URLSearchParams(url.search).get("item");
    return item ? `/reader?item=${item}` : path;
  }

  // ---- Layers: sheets and dialogs ----
  // Every open sheet or dialog has a history entry of its own, so Back (and
  // Android's back button, which maps to history) closes the top one before
  // it leaves the page. A layer closed from the page gives its entry back;
  // one that hands over to another (the station sheet opening New station)
  // passes its entry on. History writes wait until given-back entries are
  // gone, so they never land on one.
  const layers = [];
  let releases = 0;
  let ignorePops = 0;
  let closingFromHistory = null;
  let releaseTimer = 0;
  const waiting = [];
  // A view's own history writes made while a sheet is open (a station
  // started from the New station chooser) land under it, once it closes.
  const deferred = [];

  function handleLayerRecords(records) {
    for (const record of records) {
      const dialog = record.target;
      if (dialog.tagName !== "DIALOG") continue;
      if (record.oldValue === null) {
        if (!dialog.open || layers.includes(dialog)) continue;
        layers.push(dialog);
        if (releases > 0) releases -= 1;
        else
          window.history.pushState(
            { ...window.history.state, layer: true },
            "",
          );
      } else {
        const index = layers.indexOf(dialog);
        if (index < 0 || dialog.open) continue;
        layers.splice(index, 1);
        if (closingFromHistory === dialog) closingFromHistory = null;
        else releases += 1;
      }
    }
    if (!layers.length && deferred.length) {
      const writes = deferred.splice(0);
      if (releases > 0 || ignorePops) waiting.push(...writes);
      else writes.forEach((write) => write());
    }
    if (releases > 0) {
      window.clearTimeout(releaseTimer);
      // A closing dialog may reopen or hand over in its close event.
      releaseTimer = window.setTimeout(flushLayers, 40);
    }
  }

  const layerObserver = new MutationObserver(handleLayerRecords);
  layerObserver.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["open"],
    attributeOldValue: true,
  });

  function flushLayers() {
    window.clearTimeout(releaseTimer);
    handleLayerRecords(layerObserver.takeRecords());
    if (!releases) return;
    const count = releases;
    releases = 0;
    ignorePops += 1;
    window.history.go(-count);
  }

  // Runs `write` now, or once given-back layer entries are gone.
  function afterLayers(write) {
    handleLayerRecords(layerObserver.takeRecords());
    if (!releases && !ignorePops) return false;
    waiting.push(write);
    flushLayers();
    return true;
  }

  // The same for a view's history write, which also waits for open layers
  // to close, so it never lands on (and is then taken back with) a layer's
  // entry.
  function underLayers(write) {
    handleLayerRecords(layerObserver.takeRecords());
    if (layers.length) {
      deferred.push(write);
      return true;
    }
    return afterLayers(write);
  }

  function closeTopLayer() {
    const dialog = layers.at(-1);
    closingFromHistory = dialog;
    // The same request as Escape: a sheet with unsaved changes asks first.
    const allowed = dialog.dispatchEvent(
      new Event("cancel", { cancelable: true }),
    );
    if (allowed && dialog.open) dialog.close();
    handleLayerRecords(layerObserver.takeRecords());
    if (dialog.open) {
      closingFromHistory = null;
      window.history.pushState({ ...window.history.state, layer: true }, "");
    }
  }

  function viewHeading(path, readerHasItem) {
    if (path === "/library") return document.getElementById("libraryViewTitle");
    if (path === "/404") return document.getElementById("notFoundTitle");
    if (path === "/reader") {
      return document.getElementById(
        readerHasItem ? "readerTitle" : "readerLibraryTitle",
      );
    }
    return els.title;
  }

  function renderRoute(
    focusView = false,
    preserveScroll = false,
    cause = "initial",
    restoreTop = 0,
  ) {
    const path = routePath();
    const readerHasItem =
      path === "/reader" &&
      new URLSearchParams(window.location.search).has("item");
    document
      .getElementById("readerView")
      .classList.toggle("has-item", readerHasItem);
    renderedPath = path;
    const heading = viewHeading(path, readerHasItem);
    els.skipToContent.href = heading?.id ? `#${heading.id}` : "#main";
    document.querySelectorAll("[data-view]").forEach((view) => {
      view.hidden = view.dataset.view !== path;
    });
    document.querySelectorAll("[data-route]").forEach((link) => {
      if (link.dataset.route === path)
        link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    syncRouteLinks();
    onRender(path);
    if (restoreTop > 0) pendingScroll = [0, restoreTop];
    if (!preserveScroll) scrollRoute({ top: 0 });
    window.dispatchEvent(
      new CustomEvent("zak-route", { detail: { path, cause } }),
    );
    if (restoreTop > 0) {
      // Back where it was left: views have rendered, so the place exists.
      const pending = pendingScroll;
      scrollRoute({ top: restoreTop, behavior: "instant" });
      window.requestAnimationFrame(() => {
        if (pendingScroll === pending)
          scrollRoute({ top: restoreTop, behavior: "instant" });
        // Reader finishes an item's restore itself once its text is in.
        if (pendingScroll === pending && !readerHasItem) pendingScroll = null;
      });
      // Focus goes to the tab that was chosen, which is in view, rather
      // than to a heading scrolled out of sight.
      if (focusView) {
        window.queueMicrotask(() => {
          const routeLink = [
            ...document.querySelectorAll(`[data-route="${path}"]`),
          ].find(
            (link) => link.getClientRects().length && !link.closest("[hidden]"),
          );
          (routeLink || heading)?.focus({ preventScroll: true });
        });
      }
      return;
    }
    const hash = window.location.hash.slice(1);
    if (hash && !preserveScroll) {
      // Views may render their targets asynchronously (Library's station list).
      window.requestAnimationFrame(() => {
        const target = document.getElementById(decodeURIComponent(hash));
        if (!target) return;
        target.scrollIntoView({ block: "start" });
        if (focusView) {
          if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
          target.focus({ preventScroll: true });
        }
      });
      return;
    }
    if (focusView) {
      window.queueMicrotask(() => heading?.focus({ preventScroll: true }));
    }
  }

  function navigate(target) {
    if (afterLayers(() => navigate(target))) return;
    // Views commit what is still pending (a debounced search) to the entry
    // being left, so Back returns to exactly what was on screen.
    window.dispatchEvent(
      new CustomEvent("zak-before-route", { detail: { from: routePath() } }),
    );
    commitScrollState();
    viewScroll.set(viewKey(), window.scrollY);
    const requested = new URL(target, window.location.origin);
    const url = new URL(requested.pathname, window.location.origin);
    if (VIEW_PATHS[requested.pathname] === "/" && stationId() !== "main")
      url.searchParams.set("station", stationId());
    if (requested.pathname.startsWith("/reader")) {
      const item = requested.searchParams.get("item");
      if (item) url.searchParams.set("item", item);
      else if (routePath() !== "/reader" && requested.search === "") {
        // Returning to Reader reopens the item that is still loaded there.
        const selected = selectedReaderId();
        if (selected) url.searchParams.set("item", selected);
      }
    }
    url.hash = requested.hash;
    const sameView = viewKey(url) === viewKey();
    if (
      `${url.pathname}${url.search}${url.hash}` !==
      `${window.location.pathname}${window.location.search}${window.location.hash}`
    ) {
      window.history.pushState({ scroll: [0, 0] }, "", url);
    }
    // Choosing a destination returns to where it was left. A #fragment
    // names a place of its own, and choosing the view already shown goes
    // to its top.
    const restore =
      !url.hash && !sameView ? Number(viewScroll.get(viewKey(url))) || 0 : 0;
    renderRoute(true, false, "navigate", restore);
  }

  // A view's own drill-down (a Library collection, a filter, a Reader list
  // filter) becomes a history entry, so Back returns to where it was. The
  // entry being left keeps its scroll position and what to focus on return.
  function push(url, { focus = "" } = {}) {
    if (underLayers(() => push(url, { focus }))) return true;
    const target = new URL(url, window.location.href);
    if (target.href === window.location.href) return false;
    window.clearTimeout(scrollStateTimer);
    window.history.replaceState(
      {
        ...window.history.state,
        scroll: [...lastScroll],
        focus: focus || window.history.state?.focus || "",
      },
      "",
    );
    window.history.pushState(
      { scroll: [window.scrollX, window.scrollY] },
      "",
      target,
    );
    return true;
  }

  // Keystroke-level edits (search text) replace the current entry.
  function replace(url) {
    if (underLayers(() => replace(url))) return true;
    const target = new URL(url, window.location.href);
    if (target.href === window.location.href) return false;
    window.history.replaceState(window.history.state, "", target);
    return true;
  }

  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[data-route]");
    if (
      !link ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    navigate(link.dataset.route);
  });

  window.addEventListener("popstate", (event) => {
    // The page giving back a closed layer's entry: nothing to show.
    if (ignorePops > 0) {
      ignorePops -= 1;
      if (!ignorePops) waiting.splice(0).forEach((write) => write());
      return;
    }
    // Back closes the top sheet or dialog first.
    if (layers.length) {
      closeTopLayer();
      return;
    }
    if (lastKey) viewScroll.set(lastKey, lastScroll[1]);
    const scroll = Array.isArray(event.state?.scroll)
      ? event.state.scroll
      : [0, 0];
    pendingScroll = [Number(scroll[0]) || 0, Number(scroll[1]) || 0];
    const restoredAwayFromTop = pendingScroll.some((value) => value !== 0);
    const changedView = renderedPath !== routePath();
    onHistory();
    renderRoute(changedView && !restoredAwayFromTop, true, "history");
    window.requestAnimationFrame(() => {
      scrollRoute({
        left: pendingScroll?.[0] || 0,
        top: pendingScroll?.[1] || 0,
        behavior: "instant",
      });
      const hasReaderItem =
        routePath() === "/reader" &&
        new URLSearchParams(location.search).has("item");
      if (changedView && restoredAwayFromTop) {
        const routeLink = [
          ...document.querySelectorAll(`[data-route="${routePath()}"]`),
        ].find(
          (link) => link.getClientRects().length && !link.closest("[hidden]"),
        );
        routeLink?.focus({ preventScroll: true });
      } else if (!changedView && typeof event.state?.focus === "string") {
        // Stepping back out of a drill-down returns focus to what opened it.
        let target = null;
        try {
          target = document.querySelector(event.state.focus);
        } catch {}
        if (target?.getClientRects().length && !target.closest("[hidden]"))
          target.focus({ preventScroll: true });
      }
      if (!hasReaderItem) pendingScroll = null;
    });
  });
  if ("scrollRestoration" in window.history) {
    window.history.scrollRestoration = "manual";
  }
  if (!Array.isArray(window.history.state?.scroll)) {
    window.history.replaceState(
      { ...window.history.state, scroll: [window.scrollX, window.scrollY] },
      "",
    );
  }
  function commitScrollState() {
    window.history.replaceState(
      { ...window.history.state, scroll: [window.scrollX, window.scrollY] },
      "",
    );
  }
  window.addEventListener(
    "scroll",
    () => {
      lastScroll = [window.scrollX, window.scrollY];
      lastKey = viewKey();
      window.clearTimeout(scrollStateTimer);
      scrollStateTimer = window.setTimeout(commitScrollState, 120);
    },
    { passive: true },
  );
  return {
    setSkipTarget,
    path: routePath,
    navigate,
    push,
    replace,
    afterLayers,
    render: renderRoute,
    syncLinks: syncRouteLinks,
    commitScroll: commitScrollState,
    scrollTo: scrollRoute,
    get pendingScroll() {
      return pendingScroll;
    },
    finishRestore(pending) {
      if (pendingScroll === pending) pendingScroll = null;
    },
  };
}
