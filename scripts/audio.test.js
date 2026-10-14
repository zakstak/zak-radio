const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = readFileSync(path.join(__dirname, "../static/audio.js"), "utf8");
const audioModule = import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function player() {
  const { createAudioController } = await audioModule;
  global.window = {
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
    ZakNativeHost: { prepare: async () => true },
  };
  global.HTMLMediaElement = { NETWORK_NO_SOURCE: 3 };
  const starts = [];
  const element = Object.assign(new EventTarget(), {
    src: "",
    paused: true,
    currentTime: 0,
    pause() {
      this.paused = true;
      this.dispatchEvent(new Event("pause"));
    },
    load() {},
    removeAttribute(name) {
      this[name] = "";
    },
    play() {
      const start = deferred();
      starts.push(start);
      this.paused = false;
      return start.promise;
    },
  });
  const errors = [];
  let blocked = 0;
  const controller = createAudioController({
    element,
    shouldPlayRadio: () => true,
    onPause() {},
    onOwnerChange() {},
    onPlaybackChange() {},
    onRadioBlocked: () => blocked++,
    onError: (error) => errors.push(error),
  });
  return { controller, starts, errors, blocked: () => blocked };
}

// prepare() resolves in a microtask before the controller calls element.play().
async function start(controller) {
  const result = controller.play();
  await Promise.resolve();
  return { result };
}

test("a previous owner's rejected start cannot suspend Radio", async () => {
  const { controller, starts, errors, blocked } = await player();
  controller.claim("library", "/library.mp3", "Preview");
  const old = await start(controller);
  controller.claim("radio", "/radio.mp3", "Radio");
  const current = await start(controller);
  starts[1].resolve();
  assert.equal(await current.result, true);
  starts[0].reject(new DOMException("Previous source", "NotAllowedError"));
  assert.equal(await old.result, false);
  assert.equal(blocked(), 0);
  assert.deepEqual(errors, []);
});

test("a replaced start cannot block a newer start of the same Radio source", async () => {
  const { controller, starts, errors, blocked } = await player();
  controller.claim("radio", "/radio.mp3", "Radio");
  const old = await start(controller);
  const current = await start(controller);
  starts[1].resolve();
  assert.equal(await current.result, true);
  starts[0].reject(new DOMException("Older attempt", "NotAllowedError"));
  assert.equal(await old.result, false);
  assert.equal(blocked(), 0);
  assert.deepEqual(errors, []);
});

test("an old abort cannot clear Reader's pending segment resume", async () => {
  const { controller, starts } = await player();
  controller.claim("reader", "/segment.mp3", "Reader", { resume: true });
  const old = await start(controller);
  const current = await start(controller);
  starts[0].reject(new DOMException("Older attempt", "AbortError"));
  assert.equal(await old.result, false);
  const resuming = controller.resuming;
  starts[1].resolve();
  assert.equal(await current.result, true);
  assert.equal(resuming, true);
});

test("Pause invalidates the result of an already pending element start", async () => {
  const { controller, starts } = await player();
  controller.claim("library", "/library.mp3", "Preview");
  const old = await start(controller);
  controller.pause();
  starts[0].resolve();
  assert.equal(await old.result, false);
});

test("the current Radio start still reports and suspends a rejected play", async () => {
  const { controller, starts, errors, blocked } = await player();
  controller.claim("radio", "/radio.mp3", "Radio");
  const current = await start(controller);
  const error = new DOMException("Tap required", "NotAllowedError");
  starts[0].reject(error);
  assert.equal(await current.result, false);
  assert.equal(blocked(), 1);
  assert.deepEqual(errors, [error]);
});
