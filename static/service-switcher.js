/*
 * Zakstak Service Switcher 1.0.0
 * Canonical source: zakstak/saga-product/design-system/service-switcher.js
 * Consumers vendor this file byte-for-byte and serve it locally.
 */

export const SERVICE_DIRECTORY_SCHEMA = "zakstak.service-directory.v1";
export const SERVICE_DIRECTORY_URL =
  "https://services.home.zakstak.com/v1/services.json";

const MAX_SERVICES = 64;
const ENTRY_KEYS = ["enabled", "href", "id", "name", "order", "role"];
const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.home\.zakstak\.com$/;

function boundedText(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.trim() === value
  );
}

function safeServiceUrl(value) {
  if (!boundedText(value, 256)) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      HOST_PATTERN.test(parsed.hostname) &&
      value.startsWith(`https://${parsed.hostname}`)
    );
  } catch {
    return false;
  }
}

export function validateServiceDirectory(payload) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    payload.schema !== SERVICE_DIRECTORY_SCHEMA ||
    !Array.isArray(payload.services) ||
    payload.services.length < 1 ||
    payload.services.length > MAX_SERVICES ||
    Object.keys(payload).sort().join(",") !== "schema,services"
  ) {
    throw new Error("The Zakstak service directory was not recognized.");
  }

  const ids = new Set();
  const hrefs = new Set();
  const orders = new Set();
  const services = payload.services.map((service) => {
    if (
      !service ||
      typeof service !== "object" ||
      Array.isArray(service) ||
      Object.keys(service).sort().join(",") !== ENTRY_KEYS.join(",") ||
      !ID_PATTERN.test(service.id) ||
      !boundedText(service.name, 48) ||
      !boundedText(service.role, 96) ||
      !safeServiceUrl(service.href) ||
      !Number.isSafeInteger(service.order) ||
      service.order < 0 ||
      service.order > 9_999 ||
      typeof service.enabled !== "boolean" ||
      ids.has(service.id) ||
      hrefs.has(service.href) ||
      orders.has(service.order)
    ) {
      throw new Error(
        "The Zakstak service directory contained an unsafe entry.",
      );
    }
    ids.add(service.id);
    hrefs.add(service.href);
    orders.add(service.order);
    return Object.freeze({ ...service });
  });

  services.sort((left, right) => left.order - right.order);
  return Object.freeze({
    schema: SERVICE_DIRECTORY_SCHEMA,
    services: Object.freeze(services),
  });
}

function serviceLink(documentRef, service, currentService) {
  const current = service.id === currentService;
  const node = documentRef.createElement(service.enabled ? "a" : "span");
  node.className = "zs-service-switcher__link";
  node.dataset.serviceId = service.id;
  if (service.enabled) node.href = service.href;
  else node.setAttribute("aria-disabled", "true");
  if (current) {
    node.classList.add("is-current");
    node.setAttribute("aria-current", "page");
  }

  const identity = documentRef.createElement("span");
  identity.className = "zs-service-switcher__identity";
  const name = documentRef.createElement("strong");
  name.textContent = service.name;
  const role = documentRef.createElement("small");
  role.textContent = service.enabled
    ? service.role
    : `${service.role} · Unavailable`;
  identity.append(name, role);

  const route = documentRef.createElement("span");
  route.className = "zs-service-switcher__route";
  route.textContent = current
    ? "Current"
    : service.enabled
      ? "Open"
      : "Unavailable";
  node.append(identity, route);
  return node;
}

export async function loadServiceSwitcher(
  root,
  { fetchImpl = globalThis.fetch, timeoutMs = 5_000 } = {},
) {
  const list = root.querySelector("[data-zs-service-list]");
  const status = root.querySelector("[data-zs-service-status]");
  if (!list || !status || typeof fetchImpl !== "function") return false;

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  root.dataset.directoryState = "loading";
  status.textContent = "Updating directory…";
  try {
    const response = await fetchImpl(
      root.dataset.directoryUrl || SERVICE_DIRECTORY_URL,
      {
        cache: "no-cache",
        credentials: "omit",
        headers: { Accept: "application/json" },
        mode: "cors",
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error("directory unavailable");
    const directory = validateServiceDirectory(await response.json());
    const currentService = root.dataset.currentService || "";
    list.replaceChildren(
      ...directory.services.map((service) =>
        serviceLink(root.ownerDocument, service, currentService),
      ),
    );
    root.dataset.directoryState = "current";
    status.textContent = "Central directory · navigation only";
    return true;
  } catch {
    root.dataset.directoryState = "fallback";
    status.textContent =
      "Live directory unavailable · Fleet link remains available";
    return false;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function installServiceSwitchers(
  documentRef = globalThis.document,
  options = {},
) {
  if (!documentRef) return [];
  const roots = [...documentRef.querySelectorAll("[data-zs-service-switcher]")];
  roots.forEach((root) => {
    const trigger = root.querySelector("summary");
    root.addEventListener("click", (event) => {
      if (event.target.closest("a")) root.removeAttribute("open");
    });
    documentRef.addEventListener("pointerdown", (event) => {
      if (root.open && !root.contains(event.target))
        root.removeAttribute("open");
    });
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !root.open) return;
      event.preventDefault();
      root.removeAttribute("open");
      trigger?.focus();
    });
    void loadServiceSwitcher(root, options);
  });
  return roots;
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => installServiceSwitchers(document),
      { once: true },
    );
  } else {
    installServiceSwitchers(document);
  }
}
