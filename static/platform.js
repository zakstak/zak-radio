const storageFallback = new Map();

const NATIVE_SCHEMA = "zakstak.native.v1";
// Unknown until the host replies to hello.
let mediaCapabilities = null;
let capabilitiesArrived = () => {};
let capabilitiesPending = null;
let mediaRequestSequence = 0;
let lastMediaMessage = "";
const mediaPreparations = new Map();

if (window.ZakstakNativeBridge) {
  window.ZakstakNativeBridge.onmessage = (event) => {
    let response;
    try {
      response = JSON.parse(event.data);
    } catch {
      return;
    }
    if (response.schema !== NATIVE_SCHEMA) return;
    if (response.type === "capabilities") {
      mediaCapabilities = response;
      capabilitiesArrived();
    }
    if (response.type === "media.ready") {
      mediaPreparations.get(response.requestId)?.(response.ready === true);
    }
  };
}

function knownCapabilities() {
  if (mediaCapabilities || !window.ZakstakNativeBridge)
    return Promise.resolve(mediaCapabilities || {});
  // Play can race the hello reply. Hosts that predate the reply never send
  // one, so wait briefly, once, and then assume no optional features.
  capabilitiesPending ??= new Promise((resolve) => {
    capabilitiesArrived = resolve;
    window.setTimeout(resolve, 1000);
  }).then(() => (mediaCapabilities ??= {}));
  return capabilitiesPending;
}

function postNative(message) {
  try {
    window.ZakstakNativeBridge?.postMessage(
      JSON.stringify({ schema: NATIVE_SCHEMA, ...message }),
    );
    return Boolean(window.ZakstakNativeBridge);
  } catch {
    return false;
  }
}

window.ZakNativeHost = {
  async prepare({ title, subtitle }) {
    // Old hosts/browsers keep their existing playback path; no new state is sent.
    if (!(await knownCapabilities()).foregroundMediaPreparation) return true;
    // Preparation changes native state even when the last web state was paused.
    lastMediaMessage = "";
    const requestId = `radio-media-${++mediaRequestSequence}`;
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => finish(false), 5500);
      const finish = (ready) => {
        window.clearTimeout(timeout);
        mediaPreparations.delete(requestId);
        resolve(ready);
      };
      mediaPreparations.set(requestId, finish);
      if (
        !postNative({
          type: "media.prepare",
          requestId,
          title: String(title || "Zak Radio").slice(0, 120),
          subtitle: String(subtitle || "Zakstak").slice(0, 160),
        })
      )
        finish(false);
    });
  },
  hello() {
    return postNative({ type: "hello", product: "zak-radio" });
  },
  media({ state, title, subtitle }) {
    if (!["playing", "buffering", "paused", "none"].includes(state))
      return false;
    const message = {
      type: "media",
      state:
        state === "buffering" && !mediaCapabilities?.mediaBuffering
          ? "paused"
          : state,
      title: String(title || "Zak Radio").slice(0, 120),
      subtitle: String(subtitle || "Zakstak").slice(0, 160),
    };
    const encoded = JSON.stringify(message);
    if (encoded === lastMediaMessage) return true;
    // Cache only delivered states so a failed post is retried next time.
    const delivered = postNative(message);
    if (delivered) lastMediaMessage = encoded;
    return delivered;
  },
};

window.ZakNativeHost.hello();

window.ZakStorage = {
  get(key, fallback = "") {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? (storageFallback.get(key) ?? fallback) : value;
    } catch {
      return storageFallback.get(key) ?? fallback;
    }
  },
  set(key, value) {
    storageFallback.set(key, String(value));
    try {
      window.localStorage.setItem(key, String(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    storageFallback.delete(key);
    try {
      window.localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  },
};

// Bound cover concurrency before assigning src. Lazy covers join the queue only
// near the viewport, leaving the shared content budget free for audio and APIs.
const coverJobs = new WeakMap();
const coverQueue = [];
let activeCovers = 0;
const coverObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      coverObserver.unobserve(entry.target);
      const job = coverJobs.get(entry.target);
      if (job) enqueueCover(job);
    }
  },
  { rootMargin: "160px" },
);

function enqueueCover(job) {
  coverQueue.push(job);
  pumpCovers();
}

function pumpCovers() {
  while (activeCovers < 3 && coverQueue.length) {
    const job = coverQueue.shift();
    if (coverJobs.get(job.image) !== job || !job.image.isConnected) continue;
    activeCovers += 1;
    const finish = (failed) => {
      job.image.removeEventListener("load", loaded);
      job.image.removeEventListener("error", errored);
      activeCovers -= 1;
      if (coverJobs.get(job.image) === job) {
        if (failed && job.attempts++ < 2) {
          window.setTimeout(() => enqueueCover(job), 700 * job.attempts);
        } else {
          coverJobs.delete(job.image);
          if (failed) job.onFail?.();
        }
      }
      pumpCovers();
    };
    const loaded = () => finish(false);
    const errored = () => finish(true);
    job.image.addEventListener("load", loaded);
    job.image.addEventListener("error", errored);
    job.image.loading = "eager";
    job.image.src = job.src;
  }
}

window.ZakImage = function loadImage(image, src, onFail) {
  const job = { image, src, onFail, attempts: 0 };
  coverJobs.set(image, job);
  coverObserver.unobserve(image);
  if (image.loading === "lazy") coverObserver.observe(image);
  else window.setTimeout(() => enqueueCover(job));
};

window.ZakAPI = async function api(path, options = {}) {
  const init = { ...options };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers = {
      "Content-Type": "application/json",
      ...init.headers,
    };
  }
  const externalSignal = init.signal;
  const controller = new AbortController();
  const relayAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) relayAbort();
  else externalSignal?.addEventListener("abort", relayAbort, { once: true });
  const requestTimeout = Math.max(
    100,
    Number(window.ZakRequestTimeoutMS) || 15_000,
  );
  const timeout = window.setTimeout(() => {
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, requestTimeout);
  init.signal = controller.signal;
  try {
    const response = await fetch(path, init);
    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`);
      error.status = response.status;
      // Seconds until a retry can succeed, when the server knows (capacity).
      const retryAfter = Number(response.headers.get("Retry-After"));
      error.retryAfter =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0;
      // A full house of stations says how many fit and whose limit it is.
      const limit = Number(response.headers.get("X-Station-Limit"));
      error.limit = Number.isFinite(limit) && limit > 0 ? limit : 0;
      error.limitScope = response.headers.get("X-Station-Limit-Scope") || "";
      error.detail = (await response.text().catch(() => ""))
        .trim()
        .slice(0, 256);
      throw error;
    }
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", relayAbort);
  }
};

window.ZakRandomBrowserHex = function randomBrowserHex(bytes) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
};
