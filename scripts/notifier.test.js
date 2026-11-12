const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test, mock, beforeEach, afterEach } = require("node:test");

const source = readFileSync(
  path.join(__dirname, "../static/player.js"),
  "utf8",
).replace(
  /from "\.\/(format|artwork|motion)\.js"/g,
  (_, name) =>
    `from "data:text/javascript;base64,${Buffer.from(readFileSync(path.join(__dirname, `../static/${name}.js`), "utf8")).toString("base64")}"`,
);
const playerModule = import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

// Just enough of a document for createNotifier: elements that nest, a
// root style, a page scroller, and timers the test controls.
class FakeElement extends EventTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.textContent = "";
    this.innerHTML = "";
    this.className = "";
    this.offsetHeight = 70;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  append(...nodes) {
    for (const node of nodes) {
      node.remove?.();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    this.append(...nodes);
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(node) {
    for (let at = node; at; at = at.parentElement) if (at === this) return true;
    return false;
  }
  get innerText() {
    return this.children.map((child) => child.textContent).join("\n");
  }
}

function fakePage() {
  const style = new Map();
  const rootStyle = {
    getPropertyValue: (name) => style.get(name) || "",
    setProperty: (name, value) => style.set(name, value),
  };
  const page = { scrollTop: 0, scrollHeight: 2000 };
  const scrolls = [];
  const document = Object.assign(new EventTarget(), {
    documentElement: { style: rootStyle },
    scrollingElement: page,
    activeElement: null,
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll: () => [],
  });
  const window = Object.assign(new EventTarget(), {
    innerHeight: 900,
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (id) => clearTimeout(id),
    requestAnimationFrame: (callback) => setTimeout(callback, 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
    matchMedia: () => ({ matches: true }),
    scrollBy: ({ top }) => {
      scrolls.push(top);
      page.scrollTop += top;
    },
  });
  globalThis.document = document;
  globalThis.window = window;
  // --notice-gap is 16px on wider screens (styles.tailwind.css).
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (name) => (name === "--notice-gap" ? " 16px" : ""),
  });
  const host = new FakeElement("div");
  const announcer = new FakeElement("div");
  return { document, window, host, announcer, style, page, scrolls };
}

let saved;
beforeEach(() => {
  saved = {
    document: globalThis.document,
    window: globalThis.window,
    getComputedStyle: globalThis.getComputedStyle,
  };
  mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => {
  mock.timers.reset();
  Object.assign(globalThis, saved);
});

async function notifier() {
  const { createNotifier } = await playerModule;
  const page = fakePage();
  return { ...page, notify: createNotifier(page) };
}
const shown = (host) => host.children.length;

test("a notification with a way back leaves after 8 seconds and clears the live region", async () => {
  const { notify, host, announcer } = await notifier();
  notify("“Late Night Rotation” is paused by its owner.", {
    action: { label: "Back to “All songs”", run() {} },
  });
  mock.timers.tick(20);
  assert.match(
    announcer.textContent,
    /Back to “All songs” from the notification/,
  );
  mock.timers.tick(7900);
  assert.equal(shown(host), 1);
  mock.timers.tick(200);
  assert.equal(shown(host), 0);
  assert.equal(announcer.textContent, "");
});

test("an Undo stays until the next action, then clears the live region", async () => {
  const { notify, host, announcer, document } = await notifier();
  notify("Paused “All songs” for everyone.", {
    action: { label: "Undo", run() {} },
  });
  mock.timers.tick(60_000);
  assert.equal(shown(host), 1);
  assert.match(
    announcer.textContent,
    /^Paused “All songs” for everyone\. Undo/,
  );
  document.dispatchEvent(new Event("click"));
  assert.equal(shown(host), 0);
  assert.equal(announcer.textContent, "");
});

test("pointing at a notification keeps it until the pointer leaves", async () => {
  const { notify, host } = await notifier();
  notify("Radio paused for Reader.", {
    action: { label: "Listen live", run() {} },
  });
  const [snackbar] = host.children;
  snackbar.dispatchEvent(new Event("pointerenter"));
  mock.timers.tick(20_000);
  assert.equal(shown(host), 1);
  snackbar.dispatchEvent(new Event("pointerleave"));
  mock.timers.tick(8100);
  assert.equal(shown(host), 0);
});

test("a shown notification reserves its height and gaps at the end of the page", async () => {
  const { notify, style, page, scrolls } = await notifier();
  // Scrolled to the end: the page grows by the reserved space and follows.
  page.scrollTop = page.scrollHeight - 900;
  const grow = () => {
    page.scrollHeight =
      2000 + (Number.parseFloat(style.get("--notice-space")) || 0);
  };
  const setProperty = globalThis.document.documentElement.style.setProperty;
  globalThis.document.documentElement.style.setProperty = (name, value) => {
    setProperty(name, value);
    grow();
  };
  const handle = notify("Ended your temporary station. Now playing All songs.");
  assert.equal(style.get("--notice-space"), "102px");
  assert.deepEqual(scrolls, [102]);
  handle.dismiss();
  assert.equal(style.get("--notice-space"), "0px");
});
