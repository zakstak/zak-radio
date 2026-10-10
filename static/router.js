export function createRouter({
  els,
  stationId,
  selectedReaderId,
  onRender,
  onHistory,
}) {
  let scrollStateTimer = 0;
  let renderedPath = "";
  let pendingScroll = null;
  function routePath() {
    if (window.location.pathname.startsWith("/library")) return "/library";
    if (window.location.pathname.startsWith("/reader")) return "/reader";
    return "/";
  }

  function routeScrollContainer() {
    return document.body.classList.contains("has-audio-owner") &&
      window.matchMedia("(max-width: 767px)").matches
      ? els.appShell
      : null;
  }

  function routeScrollPosition() {
    const container = routeScrollContainer();
    return container
      ? [container.scrollLeft, container.scrollTop]
      : [window.scrollX, window.scrollY];
  }

  function scrollPositionFor(container) {
    return container
      ? [container.scrollLeft, container.scrollTop]
      : [window.scrollX, window.scrollY];
  }

  function transferRouteScroll(
    previousContainer,
    nextContainer,
    previousPosition = scrollPositionFor(previousContainer),
  ) {
    if (previousContainer === nextContainer) return;
    const options = {
      left: previousPosition[0],
      top: previousPosition[1],
      behavior: "instant",
    };
    if (nextContainer) nextContainer.scrollTo(options);
    else window.scrollTo(options);
  }

  function scrollRoute(options) {
    const container = routeScrollContainer();
    if (container) container.scrollTo(options);
    else window.scrollTo(options);
  }

  let activeRouteScrollContainer = routeScrollContainer();
  let activeRouteScrollPosition = routeScrollPosition();

  function rememberActiveRouteScrollPosition(container) {
    if (
      container !== activeRouteScrollContainer ||
      container !== routeScrollContainer()
    )
      return;
    activeRouteScrollPosition = scrollPositionFor(container);
  }

  window.addEventListener(
    "scroll",
    () => rememberActiveRouteScrollPosition(null),
    { passive: true },
  );
  els.appShell.addEventListener(
    "scroll",
    () => rememberActiveRouteScrollPosition(els.appShell),
    { passive: true },
  );

  function setOwnerBarHidden(hidden) {
    const previousContainer = routeScrollContainer();
    const previousPosition = scrollPositionFor(previousContainer);
    const visibilityChanged = els.ownerBar.hidden !== hidden;
    els.ownerBar.hidden = hidden;
    document.body.classList.toggle("has-audio-owner", !hidden);
    if (!visibilityChanged) {
      activeRouteScrollContainer = routeScrollContainer();
      activeRouteScrollPosition = scrollPositionFor(activeRouteScrollContainer);
      syncOwnerBarInset();
      return;
    }
    const nextContainer = routeScrollContainer();
    transferRouteScroll(previousContainer, nextContainer, previousPosition);
    activeRouteScrollContainer = nextContainer;
    activeRouteScrollPosition = previousPosition;
    syncOwnerBarInset();
    window.requestAnimationFrame(syncOwnerBarInset);
  }

  function syncOwnerBarInset() {
    const height = els.ownerBar.hidden
      ? 0
      : Math.ceil(els.ownerBar.getBoundingClientRect().height);
    document.documentElement.style.setProperty(
      "--audio-owner-height",
      `${height}px`,
    );
  }

  if ("ResizeObserver" in window) {
    const ownerBarResizeObserver = new ResizeObserver(syncOwnerBarInset);
    ownerBarResizeObserver.observe(els.ownerBar);
  }
  let routeResizeFrame = 0;
  window.addEventListener(
    "resize",
    () => {
      syncOwnerBarInset();
      if (routeResizeFrame) return;
      const previousContainer = activeRouteScrollContainer;
      const previousPosition = activeRouteScrollPosition;
      routeResizeFrame = window.requestAnimationFrame(() => {
        routeResizeFrame = 0;
        const nextContainer = routeScrollContainer();
        transferRouteScroll(previousContainer, nextContainer, previousPosition);
        activeRouteScrollContainer = nextContainer;
        activeRouteScrollPosition = previousPosition;
        syncOwnerBarInset();
      });
    },
    { passive: true },
  );

  function syncRouteLinks() {
    document.querySelectorAll("[data-route]").forEach((link) => {
      const url = new URL(link.dataset.route, window.location.origin);
      if (stationId() !== "main") url.searchParams.set("station", stationId());
      link.href = `${url.pathname}${url.search}`;
    });
  }

  function renderRoute(focusView = false, preserveScroll = false) {
    const path = routePath();
    const readerHasItem =
      path === "/reader" &&
      new URLSearchParams(window.location.search).has("item");
    renderedPath = path;
    els.skipToContent.href =
      path === "/library"
        ? "#libraryViewTitle"
        : path === "/reader"
          ? readerHasItem
            ? "#readerTitle"
            : "#readerLibraryTitle"
          : "#title";
    document.querySelectorAll("[data-view]").forEach((view) => {
      view.hidden = view.dataset.view !== path;
    });
    document.querySelectorAll("[data-route]").forEach((link) => {
      if (link.dataset.route === path)
        link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    els.stationCard.hidden = path !== "/";
    syncRouteLinks();
    onRender(path);
    if (!preserveScroll) scrollRoute({ top: 0 });
    window.dispatchEvent(new CustomEvent("zak-route", { detail: { path } }));
    if (focusView) {
      const heading =
        path === "/library"
          ? document.getElementById("libraryViewTitle")
          : path === "/reader"
            ? document.getElementById(
                readerHasItem ? "readerTitle" : "readerLibraryTitle",
              )
            : els.title;
      window.queueMicrotask(() => heading?.focus({ preventScroll: true }));
    }
  }

  function navigate(path) {
    commitScrollState();
    const url = new URL(window.location.href);
    url.pathname = path;
    if (stationId() !== "main") url.searchParams.set("station", stationId());
    else url.searchParams.delete("station");
    if (path !== "/reader") url.searchParams.delete("item");
    else if (routePath() === "/reader") url.searchParams.delete("item");
    else {
      const item = selectedReaderId();
      if (item) url.searchParams.set("item", item);
    }
    if (
      `${url.pathname}${url.search}` !==
      `${window.location.pathname}${window.location.search}`
    ) {
      window.history.pushState({ scroll: [0, 0] }, "", url);
    }
    renderRoute(true);
  }

  document.querySelectorAll("[data-route]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      event.preventDefault();
      navigate(link.dataset.route);
    });
  });
  window.addEventListener("popstate", (event) => {
    const scroll = Array.isArray(event.state?.scroll)
      ? event.state.scroll
      : [0, 0];
    pendingScroll = [Number(scroll[0]) || 0, Number(scroll[1]) || 0];
    const restoredAwayFromTop = pendingScroll.some((value) => value !== 0);
    const changedView = renderedPath !== routePath();
    onHistory();
    renderRoute(changedView && !restoredAwayFromTop, true);
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
      }
      if (!hasReaderItem) pendingScroll = null;
    });
  });
  if ("scrollRestoration" in window.history) {
    window.history.scrollRestoration = "manual";
  }
  if (!Array.isArray(window.history.state?.scroll)) {
    const routeScroll = routeScrollPosition();
    window.history.replaceState(
      {
        ...(window.history.state || {}),
        scroll: routeScroll,
      },
      "",
    );
  }
  function commitScrollState() {
    const routeScroll = routeScrollPosition();
    window.history.replaceState(
      {
        ...(window.history.state || {}),
        scroll: routeScroll,
      },
      "",
    );
  }
  function scheduleScrollStateCommit() {
    window.clearTimeout(scrollStateTimer);
    scrollStateTimer = window.setTimeout(() => {
      commitScrollState();
    }, 120);
  }
  window.addEventListener("scroll", scheduleScrollStateCommit, {
    passive: true,
  });
  els.appShell.addEventListener("scroll", scheduleScrollStateCommit, {
    passive: true,
  });
  return {
    path: routePath,
    navigate,
    render: renderRoute,
    syncLinks: syncRouteLinks,
    setOwnerBarHidden,
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
