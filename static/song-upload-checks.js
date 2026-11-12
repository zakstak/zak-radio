// Checks the Add song form runs before it uploads, so a song the server
// would refuse fails at once with the reason, not after a 32 MB upload.
// The server still checks everything (internal/application/song_upload.go
// and song_mp3.go); keep these in step with it.

const RATES = [44100, 48000, 32000];
const MPEG1_KBPS = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MPEG2_KBPS = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
];

// The server's frame walk: an optional ID3v2 tag, then complete MPEG-1 or
// MPEG-2 Layer III frames at one sample rate, then an optional ID3v1 tag.
// Returns { ok: true, seconds }, or { ok: false, reason } where reason is
// "too_long" (past maxSeconds) or "invalid".
export function checkMP3(bytes, maxSeconds = 1200) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const invalid = { ok: false, reason: "invalid" };
  let offset = 0;
  if (
    data.length >= 10 &&
    data[0] === 0x49 &&
    data[1] === 0x44 &&
    data[2] === 0x33
  ) {
    if ((data[3] !== 3 && data[3] !== 4) || data[4] === 255) return invalid;
    let size = 0;
    for (const byte of data.subarray(6, 10)) {
      if (byte & 0x80) return invalid;
      size = size * 128 + byte;
    }
    offset = size + 10;
    if (data[3] === 4 && data[5] & 0x10) offset += 10;
  }
  let sampleRate = 0;
  let samples = 0;
  while (offset < data.length) {
    const left = data.length - offset;
    if (
      left === 128 &&
      data[offset] === 0x54 &&
      data[offset + 1] === 0x41 &&
      data[offset + 2] === 0x47
    ) {
      offset = data.length;
      break;
    }
    if (left < 4) return invalid;
    const h1 = data[offset + 1];
    const h2 = data[offset + 2];
    const version = (h1 >> 3) & 3;
    const layer = (h1 >> 1) & 3;
    const bitrateIndex = h2 >> 4;
    const rateIndex = (h2 >> 2) & 3;
    if (
      data[offset] !== 255 ||
      (h1 & 0xe0) !== 0xe0 ||
      (version !== 3 && version !== 2) ||
      layer !== 1 ||
      bitrateIndex === 0 ||
      bitrateIndex === 15 ||
      rateIndex === 3
    )
      return invalid;
    let rate = RATES[rateIndex];
    let kbps = MPEG1_KBPS[bitrateIndex];
    let frameSamples = 1152;
    let coefficient = 144000;
    if (version === 2) {
      rate /= 2;
      kbps = MPEG2_KBPS[bitrateIndex];
      frameSamples = 576;
      coefficient = 72000;
    }
    if (sampleRate && sampleRate !== rate) return invalid;
    sampleRate = rate;
    const frameSize = Math.floor((coefficient * kbps) / rate) + ((h2 >> 1) & 1);
    if (frameSize < 4 || frameSize > left) return invalid;
    offset += frameSize;
    samples += frameSamples;
    if (samples > rate * maxSeconds) return { ok: false, reason: "too_long" };
  }
  if (offset !== data.length || !sampleRate || samples < sampleRate * 0.05)
    return invalid;
  return { ok: true, seconds: samples / sampleRate };
}

// The size the form sends: browsers send a textarea's line breaks as CRLF,
// so each one counts twice against the server's byte limit.
export function formBytes(text) {
  return new TextEncoder().encode(String(text).replace(/\r\n|\r|\n/g, "\r\n"))
    .length;
}

// Control characters the server refuses (Go's unicode.IsControl: C0, DEL,
// and C1). Lyrics may keep line breaks and tabs; a title or artist is one
// line.
export function hasControlCharacters(text, multiline = false) {
  for (const character of String(text)) {
    const code = character.codePointAt(0);
    if (code >= 0x20 && (code < 0x7f || code > 0x9f)) continue;
    if (multiline && (code === 0x09 || code === 0x0a || code === 0x0d))
      continue;
    return true;
  }
  return false;
}

// Characters as the server counts them: Unicode code points.
export function characterCount(text) {
  return [...String(text)].length;
}
