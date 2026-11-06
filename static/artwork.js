// Songs without cover art get a tile of their own: a hue and a waveform
// drawn from the song's id. Every placeholder keeps the same look, but ten
// uncovered songs in a row are still tellable apart, and a song's tile is
// the same everywhere it appears.

export function artworkSeed(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function waveform(seed) {
  const bars = [];
  const count = 4 + (seed % 2);
  const width = 10;
  const gap = count === 5 ? 5 : 6;
  const total = count * width + (count - 1) * gap;
  const start = (96 - total) / 2;
  for (let index = 0; index < count; index += 1) {
    // Five bits per bar: heights from 16 to 66 of the 96-unit tile.
    const height = 16 + (((seed >>> (index * 5 + 3)) & 31) * 50) / 31;
    const x = start + index * (width + gap);
    const y = 48 - height / 2;
    bars.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${width}" height="${height.toFixed(1)}" rx="5"></rect>`,
    );
  }
  return `<svg class="no-artwork-icon" viewBox="0 0 96 96" aria-hidden="true">${bars.join("")}</svg>`;
}

// Gives an existing element the placeholder for `seed` (a song id).
export function paintArtworkFallback(target, seed) {
  const value = artworkSeed(seed);
  const hue = value % 360;
  // A neighbouring second hue, so the tile has a gentle direction.
  const shift = 24 + ((value >>> 9) % 48);
  target.classList.add("has-art-seed");
  target.style.setProperty("--art-h", String(hue));
  target.style.setProperty("--art-h2", String((hue + shift) % 360));
  target.innerHTML = waveform(value);
  return target;
}

export function artworkFallback(seed) {
  const fallback = document.createElement("span");
  fallback.className = "track-cover-fallback";
  fallback.setAttribute("aria-hidden", "true");
  return paintArtworkFallback(fallback, seed);
}
