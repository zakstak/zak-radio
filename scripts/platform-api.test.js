const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function apiWithResponse(response) {
  const window = { setTimeout, clearTimeout };
  vm.runInNewContext(
    readFileSync(path.join(__dirname, "../static/platform.js"), "utf8"),
    {
      window,
      AbortController,
      DOMException,
      IntersectionObserver: class {},
      fetch: async () => response,
    },
  );
  return window.ZakAPI;
}

test("API errors expose the JSON message and retain retry metadata", async () => {
  const api = apiWithResponse(
    new Response(
      JSON.stringify({
        error: { code: "upload_busy", message: "Another song is being added." },
      }),
      { status: 429, headers: { "Retry-After": "5" } },
    ),
  );
  await assert.rejects(api("/api/tracks"), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAfter, 5);
    assert.equal(error.detail, "Another song is being added.");
    return true;
  });
});

test("API errors preserve existing text responses and bound their length", async () => {
  for (const message of ["  Request rejected.  ", "x".repeat(300)]) {
    const api = apiWithResponse(new Response(message, { status: 400 }));
    await assert.rejects(api("/api/control"), (error) => {
      assert.equal(error.detail, message.trim().slice(0, 256));
      assert.equal(error.retryAfter, 0);
      return true;
    });
  }
});
