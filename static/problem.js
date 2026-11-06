import { plural } from "./format.js";

// One diagnosis for each kind of failure, in the listener's terms, and one
// error component that Radio, Library, and Reader all use. The same outage
// reads the same everywhere: the same heading, the same next step.
//
//   offline      this device has no network
//   unreachable  the device is online, but Zak Radio doesn't answer
//   server       Zak Radio answered with an error
//   busy         Zak Radio asked to slow down (429)
//   notfound     the thing asked for doesn't exist (404)
export function problemKind(error) {
  const status = Number(error?.status) || 0;
  if (status === 404) return "notfound";
  if (status === 429) return "busy";
  if (status) return "server";
  if (navigator.onLine === false) return "offline";
  return "unreachable";
}

// Seconds the server asked to wait before trying again, if it said.
export function retryWait(error) {
  const seconds = Number(error?.retryAfter) || 0;
  return seconds > 0 ? Math.ceil(seconds) : 0;
}

export function waitWords(seconds) {
  if (!seconds) return "in a moment";
  if (seconds < 90) return `in ${plural(seconds, "second")}`;
  return `in about ${plural(Math.round(seconds / 60), "minute")}`;
}

const PROBLEMS = {
  offline: {
    title: "You’re offline",
    text: "This device has no network connection. Check Wi-Fi or mobile data, then try again.",
  },
  unreachable: {
    title: "Can’t reach Zak Radio",
    text: "Zak Radio isn’t answering right now. Try again in a moment. If it persists, check your connection.",
  },
  server: {
    title: "Zak Radio is having trouble",
    text: "Zak Radio ran into a problem. Try again in a moment. Audio already loaded on this device can keep playing.",
  },
  busy: {
    title: "Too many requests right now",
    text: "Zak Radio asked this device to slow down. Try again in a moment.",
  },
  notfound: {
    title: "This isn’t available anymore",
    text: "It may have been removed.",
  },
};

// The heading and next step for a failure. Views may name what failed to
// load in the heading ("Your stations didn’t load"), but the explanation
// and the next step stay those of the failure kind.
export function problemCopy(errorOrKind) {
  const kind =
    typeof errorOrKind === "string" ? errorOrKind : problemKind(errorOrKind);
  const copy = PROBLEMS[kind] || PROBLEMS.unreachable;
  if (kind === "busy" && typeof errorOrKind !== "string") {
    const wait = retryWait(errorOrKind);
    return {
      kind,
      title: copy.title,
      text: `Zak Radio asked this device to slow down. Try again ${waitWords(wait)}.`,
    };
  }
  return { kind, ...copy };
}

// One sentence for an action that didn't go through, led by the same
// heading as the error boxes: "Can’t reach Zak Radio, so the skip didn’t
// happen." A rate limit adds when to try again. Every notification about a
// failed change uses it, so the cause is never guessed.
export function failureSentence(
  error,
  outcome = "that change didn’t go through",
) {
  const copy = problemCopy(error);
  const wait =
    copy.kind === "busy"
      ? ` Try again ${waitWords(typeof error === "string" ? 0 : retryWait(error))}.`
      : "";
  return `${copy.title}, so ${outcome}.${wait}`;
}

// The shared error box: a heading, one sentence of explanation, and the
// actions (Try again first). `heading` picks the heading level.
export function problemState({
  error = null,
  kind = "",
  title = "",
  text = "",
  actions = [],
  heading = "h3",
  className = "",
} = {}) {
  const copy = problemCopy(kind || error);
  const box = document.createElement("div");
  box.className = `error-state${className ? ` ${className}` : ""}`;
  box.dataset.problem = copy.kind;
  const head = document.createElement(heading);
  head.className = "error-state-title";
  head.tabIndex = -1;
  head.textContent = title || copy.title;
  const body = document.createElement("p");
  body.textContent = text || copy.text;
  box.append(head, body);
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "state-actions";
    row.append(...actions);
    box.append(row);
  }
  return box;
}
