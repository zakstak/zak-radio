export function timeLabel(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n < 0) return "0:00";
  const m = Math.floor(n / 60);
  const s = Math.floor(n % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

// "1 song", "2 songs"; pass the plural form when it is irregular.
export function plural(count, singular, pluralForm = `${singular}s`) {
  const n = Number(count) || 0;
  return `${n.toLocaleString()} ${n === 1 ? singular : pluralForm}`;
}

// Saved stations describe the same selection in the picker, editor and cards.
export function stationSelection(station) {
  if (station.source_type === "list")
    return `Hand-picked · ${plural(station.track_ids?.length || 0, "song")}`;
  const scope =
    {
      all: "all songs",
      liked: "songs liked by listeners",
      covers: "songs with artwork",
      recent: "recently added songs",
    }[station.filter_mode || "all"] || "all songs";
  const query = String(station.filter_query || "").trim();
  return query
    ? `Songs matching “${query}” among ${scope}`
    : `Filter · ${scope}`;
}

export function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

export function radioGroupValue(group) {
  return group.querySelector('input[type="radio"]:checked')?.value || "";
}

export function setRadioGroupValue(group, value) {
  group.querySelectorAll('input[type="radio"]').forEach((input) => {
    input.checked = input.value === value;
  });
}

export function setAttribute(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}
