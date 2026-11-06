const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

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

function node() {
  return Object.assign(new EventTarget(), {
    value: "40",
    max: "180",
    style: {},
    hidden: false,
    textContent: "",
    attributes: new Map(),
    setAttribute(key, value) {
      this.attributes.set(key, value);
    },
    getAttribute(key) {
      return this.attributes.get(key);
    },
    removeAttribute(key) {
      this.attributes.delete(key);
    },
  });
}
function key(input, type, name) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "key", { value: name });
  input.dispatchEvent(event);
  return event;
}
async function rail(seekable = true) {
  const { bindProgress } = await playerModule;
  const parts = Object.fromEntries(
    ["row", "elapsed", "track", "fill", "thumb", "input", "end"].map((name) => [
      name,
      node(),
    ]),
  );
  const seeks = [];
  bindProgress(
    parts,
    () => ({ duration: 180, position: 40, seekable }),
    (position) => seeks.push(position),
  );
  return { parts, seeks };
}

test("a held seek key previews five-second steps and commits once on release", async () => {
  const { parts, seeks } = await rail();
  for (let count = 0; count < 3; count++)
    key(parts.input, "keydown", "ArrowRight");
  assert.equal(parts.input.value, "55");
  assert.equal(parts.input.getAttribute("aria-valuetext"), "0:55 of 3:00");
  assert.deepEqual(seeks, []);
  key(parts.input, "keyup", "ArrowRight");
  assert.deepEqual(seeks, [55]);
  parts.input.dispatchEvent(new Event("change"));
  assert.deepEqual(seeks, [55]);
});

test("PageUp seeks thirty seconds; losing focus commits and clamps to duration", async () => {
  const { parts, seeks } = await rail();
  key(parts.input, "keydown", "PageUp");
  assert.equal(parts.input.value, "70");
  key(parts.input, "keydown", "End");
  parts.input.dispatchEvent(new Event("blur"));
  assert.deepEqual(seeks, [180]);
  key(parts.input, "keyup", "End");
  assert.deepEqual(seeks, [180]);
});

test("a listen-only progress rail never sends a seek", async () => {
  const { parts, seeks } = await rail(false);
  assert.equal(
    key(parts.input, "keydown", "ArrowRight").defaultPrevented,
    false,
  );
  parts.input.dispatchEvent(new Event("input"));
  parts.input.dispatchEvent(new Event("change"));
  assert.deepEqual(seeks, []);
});
