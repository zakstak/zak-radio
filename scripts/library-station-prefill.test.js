const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// library.js reads browser globals at load; only this one is needed to
// import its pure helpers.
globalThis.window = { ZakRandomBrowserHex: () => "" };

// Static modules are browser ES modules; load them as data: URLs, with
// their relative imports rewritten the same way.
function moduleURL(name) {
  const source = readFileSync(
    path.join(__dirname, "../static", name),
    "utf8",
  ).replace(/from "\.\/([\w-]+\.js)"/g, (_, dep) => `from "${moduleURL(dep)}"`);
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const libraryModule = import(moduleURL("library.js"));

test("a station filter carries over to a new filter station", async () => {
  const { filterStationPrefill } = await libraryModule;
  assert.deepEqual(
    filterStationPrefill({
      query: "night",
      filter: "liked",
      shownIds: ["a", "b"],
    }),
    { query: "night", mode: "liked", note: "", shownIds: [] },
  );
  assert.deepEqual(filterStationPrefill(), {
    query: "",
    mode: "all",
    note: "",
    shownIds: [],
  });
});

test("Your likes never becomes a filter station's filter", async () => {
  const { filterStationPrefill } = await libraryModule;
  const prefill = filterStationPrefill({
    query: "night",
    filter: "mine",
    shownIds: ["a", "b"],
  });
  assert.equal(prefill.mode, "all");
  assert.equal(prefill.query, "night");
  assert.match(prefill.note, /can’t use Your likes/);
  assert.match(prefill.note, /hand-picked station/);
  // The liked songs on screen back the editor's hand-picked offer.
  assert.deepEqual(prefill.shownIds, ["a", "b"]);

  const empty = filterStationPrefill({ filter: "mine" });
  assert.equal(empty.mode, "all");
  assert.match(empty.note, /can’t use Your likes/);
  assert.doesNotMatch(empty.note, /hand-picked/);
});

test("search words are limited to what a station accepts", async () => {
  const { filterStationPrefill } = await libraryModule;
  assert.equal(
    filterStationPrefill({ query: "x".repeat(200) }).query.length,
    160,
  );
});

test("station filters match the station editor's Include options", async () => {
  const { STATION_FILTERS } = await libraryModule;
  const html = readFileSync(
    path.join(__dirname, "../static/index.html"),
    "utf8",
  );
  const select =
    /<select id="stationEditorMode"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert.ok(select, "index.html has the station editor's Include select");
  const options = [...select[1].matchAll(/<option value="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(options, STATION_FILTERS);
});
