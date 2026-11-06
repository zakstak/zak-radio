const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function setup() {
  const timers = [];
  const starts = [];
  let observer;
  const window = { setTimeout: (fn) => timers.push(fn) };
  class Observer {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observer = this;
    }
    observe(image) {
      this.targets.add(image);
    }
    unobserve(image) {
      this.targets.delete(image);
    }
    reveal(image) {
      this.callback([{ target: image, isIntersecting: true }]);
    }
  }
  vm.runInNewContext(
    readFileSync(path.join(__dirname, "../static/platform.js"), "utf8"),
    {
      window,
      IntersectionObserver: Observer,
    },
  );
  const image = (loading = "eager") => {
    const target = Object.assign(new EventTarget(), {
      loading,
      isConnected: true,
    });
    Object.defineProperty(target, "src", {
      set(value) {
        this.requested = value;
        starts.push(value);
      },
    });
    return target;
  };
  return {
    load: window.ZakImage,
    image,
    starts,
    reveal: (target) => observer.reveal(target),
    tick() {
      const pending = timers.splice(0);
      pending.forEach((fn) => fn());
    },
  };
}

test("covers wait near the viewport and use at most three request slots", () => {
  const s = setup();
  const images = Array.from({ length: 8 }, () => s.image("lazy"));
  images.forEach((image, index) => s.load(image, `cover-${index}`));
  s.tick();
  assert.deepEqual(s.starts, []);
  images.slice(0, 6).forEach(s.reveal);
  assert.equal(s.starts.length, 3);
  images[0].dispatchEvent(new Event("load"));
  assert.equal(s.starts.length, 4);
  images[1].dispatchEvent(new Event("load"));
  images[2].dispatchEvent(new Event("load"));
  assert.equal(s.starts.length, 6);
});

test("failed covers release a slot, retry twice, then show a fallback", () => {
  const s = setup();
  const image = s.image();
  let failed = 0;
  s.load(image, "cover", () => failed++);
  s.tick();
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(s.starts.length, attempt + 1);
    image.dispatchEvent(new Event("error"));
    s.tick();
  }
  assert.equal(failed, 1);
  assert.equal(s.starts.length, 3);
});

test("replaced and detached queued covers do not start stale requests", () => {
  const s = setup();
  const image = s.image();
  s.load(image, "old");
  s.load(image, "new");
  const detached = s.image();
  detached.isConnected = false;
  s.load(detached, "detached");
  s.tick();
  assert.deepEqual(s.starts, ["new"]);
});
