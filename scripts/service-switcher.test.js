const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = readFileSync(
  path.join(__dirname, "../static/service-switcher.js"),
  "utf8",
);
const switcher = import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const fleetHref = "https://fleet.home.zakstak.com/";

function entry(overrides = {}) {
  return {
    id: "zak-radio",
    name: "Radio",
    role: "Shared radio and music library",
    href: "https://music.home.zakstak.com/",
    order: 10,
    enabled: true,
    ...overrides,
  };
}

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.classes = new Set();
    this.classList = { add: (name) => this.classes.add(name) };
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  querySelector(selector) {
    assert.equal(selector, `a[href="${fleetHref}"]`);
    return this.children.find(
      (node) => node.tag === "a" && node.href === fleetHref,
    );
  }
}

function launcher() {
  const list = new Element("nav");
  const status = new Element("p");
  const root = {
    dataset: { currentService: "zak-radio" },
    ownerDocument: { createElement: (tag) => new Element(tag) },
    querySelector: (selector) =>
      selector === "[data-zs-service-list]" ? list : status,
  };
  return { root, list, status };
}

async function liveDirectory(services) {
  const { SERVICE_DIRECTORY_SCHEMA } = await switcher;
  return {
    ok: true,
    json: async () => ({ schema: SERVICE_DIRECTORY_SCHEMA, services }),
  };
}

const unavailable = async () => {
  throw new Error("directory offline");
};

test("live directory preserves compact names and disabled/current semantics", async () => {
  const { loadServiceSwitcher } = await switcher;
  const { root, list, status } = launcher();
  assert.equal(
    await loadServiceSwitcher(root, {
      fetchImpl: () =>
        liveDirectory([
          entry(),
          entry({
            id: "reader",
            name: "Reader",
            href: "https://reader.home.zakstak.com/",
            order: 20,
            enabled: false,
          }),
        ]),
    }),
    true,
  );
  assert.equal(root.dataset.directoryState, "current");
  assert.equal(status.hidden, true);
  const [current, disabled] = list.children;
  assert.equal(current.attributes["aria-current"], "page");
  assert.deepEqual(
    current.children[0].children.map((node) => node.textContent),
    ["Radio"],
  );
  assert.equal(disabled.tag, "span");
  assert.equal(disabled.attributes["aria-disabled"], "true");
  assert.deepEqual(
    disabled.children[0].children.map((node) => node.textContent),
    ["Reader", "Unavailable"],
  );
});

test("failed refresh retains live apps and restores exactly one compact Fleet link", async () => {
  const { loadServiceSwitcher } = await switcher;
  const { root, list, status } = launcher();
  await loadServiceSwitcher(root, {
    fetchImpl: () => liveDirectory([entry()]),
  });
  const radio = list.children[0];
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(
      await loadServiceSwitcher(root, { fetchImpl: unavailable }),
      false,
    );
    assert.equal(list.children[0], radio);
    assert.equal(list.children.length, 2);
    const fleet = list.children[1];
    assert.equal(fleet.href, fleetHref);
    assert.deepEqual(
      fleet.children[0].children.map((node) => node.textContent),
      ["Fleet"],
    );
    assert.equal(root.dataset.directoryState, "fallback");
    assert.equal(status.hidden, false);
  }
});

test("initial fetch failure preserves the authored static Fleet fallback", async () => {
  const { loadServiceSwitcher } = await switcher;
  const { root, list } = launcher();
  const fleet = new Element("a");
  fleet.href = fleetHref;
  list.append(fleet);
  await loadServiceSwitcher(root, { fetchImpl: unavailable });
  assert.deepEqual(list.children, [fleet]);
});

for (const [name, service] of [
  ["foreign origin", entry({ href: "https://fleet.example.com/" })],
  ["URL credentials", entry({ href: "https://user@music.home.zakstak.com/" })],
  ["control characters", entry({ name: "Radio\u0000" })],
]) {
  test(`directory still rejects ${name}`, async () => {
    const { validateServiceDirectory, SERVICE_DIRECTORY_SCHEMA } =
      await switcher;
    assert.throws(() =>
      validateServiceDirectory({
        schema: SERVICE_DIRECTORY_SCHEMA,
        services: [service],
      }),
    );
  });
}
