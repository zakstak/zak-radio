const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = readFileSync(
  path.join(__dirname, "../static/song-upload-checks.js"),
  "utf8",
);
const checks = import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);
const tone = readFileSync(
  path.join(__dirname, "../internal/application/testdata/upload.mp3"),
);

// One MPEG-1 Layer III frame header: 44.1 kHz, 128 kbps, no padding.
function frames(count) {
  const size = Math.floor((144000 * 128) / 44100);
  const data = new Uint8Array(size * count);
  for (let index = 0; index < count; index += 1) {
    data.set([0xff, 0xfb, 0x90, 0x00], index * size);
  }
  return data;
}

test("checkMP3 accepts the upload fixture and measures it like the server", async () => {
  const { checkMP3 } = await checks;
  const result = checkMP3(tone);
  assert.equal(result.ok, true);
  // 15 frames of 1152 samples at 44.1 kHz, as the server's walk counts.
  assert.ok(Math.abs(result.seconds - (15 * 1152) / 44100) < 1e-9);
});

test("checkMP3 accepts ID3v2 and ID3v1 tags around the frames", async () => {
  const { checkMP3 } = await checks;
  const id3v2 = [0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 2, 0, 0];
  const id3v1 = new Uint8Array(128);
  id3v1.set([0x54, 0x41, 0x47]);
  const data = new Uint8Array([...id3v2, ...frames(20), ...id3v1]);
  assert.equal(checkMP3(data).ok, true);
});

test("checkMP3 refuses truncated, foreign, and mixed-rate files", async () => {
  const { checkMP3 } = await checks;
  assert.deepEqual(checkMP3(tone.subarray(0, tone.length - 7)), {
    ok: false,
    reason: "invalid",
  });
  assert.equal(checkMP3(new TextEncoder().encode("not audio")).ok, false);
  assert.equal(checkMP3(new Uint8Array()).ok, false);
  const mixed = frames(20);
  // The last frame switches to 48 kHz.
  mixed[(mixed.length / 20) * 19 + 2] = 0x94;
  assert.equal(checkMP3(mixed).reason, "invalid");
});

test("checkMP3 reports songs longer than the limit", async () => {
  const { checkMP3 } = await checks;
  // 40 frames are about 1.04 seconds.
  assert.deepEqual(checkMP3(frames(40), 1), { ok: false, reason: "too_long" });
  assert.equal(checkMP3(frames(38), 1).ok, true);
});

test("formBytes counts line breaks as the CRLF the form sends", async () => {
  const { formBytes } = await checks;
  assert.equal(formBytes("a\nb"), 4);
  assert.equal(formBytes("a\r\nb"), 4);
  assert.equal(formBytes("é\n"), 4);
});

test("hasControlCharacters allows line breaks and tabs only in lyrics", async () => {
  const { hasControlCharacters } = await checks;
  assert.equal(hasControlCharacters("Verse\n\tline\r\n", true), false);
  assert.equal(hasControlCharacters("Title\tTwo"), true);
  assert.equal(hasControlCharacters("bell\u0007", true), true);
  assert.equal(hasControlCharacters("C1\u0085", true), true);
  assert.equal(hasControlCharacters("Harbor lights"), false);
});

test("characterCount counts code points like the server", async () => {
  const { characterCount } = await checks;
  assert.equal(characterCount("🔥🔥"), 2);
  assert.equal(characterCount("abc"), 3);
});
