const storageFallback = new Map();

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

window.ZakAPI = async function api(path, options = {}) {
  const init = { ...options };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
  }
  const externalSignal = init.signal;
  const controller = new AbortController();
  const relayAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) relayAbort();
  else externalSignal?.addEventListener("abort", relayAbort, { once: true });
  const requestTimeout = Math.max(100, Number(window.ZakRequestTimeoutMS) || 15_000);
  const timeout = window.setTimeout(() => {
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, requestTimeout);
  init.signal = controller.signal;
  try {
    const response = await fetch(path, init);
    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`);
      error.status = response.status;
      error.detail = (await response.text().catch(() => "")).trim().slice(0, 256);
      throw error;
    }
    return await response.json();
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", relayAbort);
  }
};
