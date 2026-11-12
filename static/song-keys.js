import { failureSentence, problemCopy, problemState } from "./problem.js";
import {
  actionButton,
  clearFieldError,
  clearProblem,
  returnFocus,
  setFieldError,
  showProblem,
  signInAgainLink,
} from "./song-forms.js";
import { characterCount, hasControlCharacters } from "./song-upload-checks.js";

const NAME_LIMIT = 80;
const DAY_LIMIT = 90;
const SIGN_IN_STEP = " Sign in again in a new tab, then try again.";

const fullDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const shortDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const clock = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

// A page instead of JSON means the sign-in gateway answered: signed out.
function normalize(error) {
  return error instanceof SyntaxError ? { status: 401, code: "" } : error;
}

function signedOut(error) {
  return Number(error?.status) === 401;
}

// "Nov 12" this year, "Nov 12, 2025" before it. Keys with one name made on
// one day also get the time, so no two rows read the same.
function createdLabel(key, keys) {
  const created = new Date(key.created_at * 1000);
  let label = (
    created.getFullYear() === new Date().getFullYear() ? shortDate : fullDate
  ).format(created);
  const twin = keys.some(
    (other) =>
      other !== key &&
      other.name === key.name &&
      new Date(other.created_at * 1000).toDateString() ===
        created.toDateString(),
  );
  if (twin) label += `, ${clock.format(created)}`;
  return label;
}

export function initSongKeys({ onSignedOut = () => {} } = {}) {
  const open = document.getElementById("songKeysOpen");
  const dialog = document.getElementById("songKeysDialog");
  const form = document.getElementById("songKeysForm");
  const nameInput = form.elements.keyName;
  const daysInput = form.elements.keyDays;
  const create = document.getElementById("songKeysCreate");
  const limitNote = document.getElementById("songKeysLimit");
  const count = document.getElementById("songKeysCount");
  const list = document.getElementById("songKeysList");
  const status = document.getElementById("songKeysStatus");
  const problem = document.getElementById("songKeysError");
  const reveal = document.getElementById("songKeysReveal");
  const secret = document.getElementById("songKeysSecret");
  const copy = document.getElementById("songKeysCopy");
  const copyGuide = document.getElementById("songKeysCopyGuide");
  const discard = document.getElementById("songKeysDiscard");
  const discardCopy = document.getElementById("songKeysDiscardCopy");
  const discardConfirm = document.getElementById("songKeysDiscardConfirm");
  let keys = [];
  let maxKeys = 5;
  let creating = false;
  // "shown" until the new key is copied; closing then asks first.
  let secretState = "";
  let closeAnyway = false;
  let confirming = null;

  function atLimit() {
    return keys.length >= maxKeys;
  }

  function syncLimit() {
    const full = atLimit();
    limitNote.hidden = !full;
    limitNote.textContent = `You can have up to ${maxKeys} active upload keys. Revoke one to create another.`;
    if (full) {
      create.setAttribute("aria-disabled", "true");
      create.setAttribute("aria-describedby", limitNote.id);
    } else {
      create.removeAttribute("aria-describedby");
      if (!creating) create.removeAttribute("aria-disabled");
    }
  }

  // ---- The list
  function listProblem(raw) {
    const error = normalize(raw);
    const actions = [
      actionButton("Try again", () => loadKeys({ retry: true })),
    ];
    if (signedOut(error)) {
      actions.unshift(signInAgainLink());
      onSignedOut();
    }
    const item = document.createElement("li");
    item.append(
      problemState({
        error,
        heading: "h4",
        text: signedOut(error)
          ? `Your upload keys didn’t load.${SIGN_IN_STEP}`
          : `Your upload keys didn’t load. ${problemCopy(error).text}`,
        actions,
      }),
    );
    list.replaceChildren(item);
    count.textContent = "";
  }

  function keyRow(key) {
    const created = createdLabel(key, keys);
    const row = document.createElement("li");
    row.className = "song-key-item";
    row.dataset.keyId = key.id;
    const copyBox = document.createElement("div");
    copyBox.className = "song-key-copy";
    const name = document.createElement("strong");
    name.textContent = key.name;
    const expires = fullDate.format(new Date(key.expires_at * 1000));
    const dates = document.createElement("span");
    dates.textContent = `Created ${created} · expires ${expires}`;
    copyBox.append(name, dates);
    const revoke = actionButton("Revoke", () => confirmRevoke(key, row));
    revoke.dataset.control = "revoke";
    revoke.setAttribute(
      "aria-label",
      `Revoke ${key.name}, created ${created}, expires ${expires}`,
    );
    row.append(copyBox, revoke);
    return row;
  }

  function renderKeys() {
    confirming = null;
    count.textContent = `${keys.length} of ${maxKeys} active keys`;
    if (!keys.length) {
      const empty = document.createElement("li");
      empty.className = "song-key-empty";
      empty.textContent = "No active upload keys.";
      list.replaceChildren(empty);
    } else list.replaceChildren(...keys.map(keyRow));
    syncLimit();
  }

  // A retry replaces the button that was pressed, so focus moves on to
  // the list, or to the next Try again.
  async function loadKeys({ retry = false } = {}) {
    try {
      const payload = await window.ZakAPI("/api/song-upload/keys");
      keys = Array.isArray(payload?.keys) ? payload.keys : [];
      maxKeys = Number(payload?.max_keys) || maxKeys;
    } catch (error) {
      listProblem(error);
      if (retry && dialog.open) list.querySelector("a, button")?.focus();
      return false;
    }
    renderKeys();
    if (retry && dialog.open)
      (list.querySelector('[data-control="revoke"]') || nameInput).focus();
    return true;
  }

  // ---- Revoke asks first, in the row
  function closeConfirm({ focus = false } = {}) {
    if (!confirming) return;
    const { row, group } = confirming;
    confirming = null;
    group.remove();
    const revoke = row.querySelector('[data-control="revoke"]');
    revoke.hidden = false;
    if (focus) revoke.focus();
  }

  function confirmRevoke(key, row) {
    closeConfirm();
    clearProblem(problem);
    const created = createdLabel(key, keys);
    const question = document.createElement("p");
    question.id = `songKeyConfirm-${key.id}`;
    question.textContent = `Revoke “${key.name}”, created ${created}? Agents using it stop working right away.`;
    const group = document.createElement("div");
    group.className = "song-key-confirm";
    group.setAttribute("role", "group");
    group.setAttribute("aria-labelledby", question.id);
    const cancel = actionButton("Cancel", () => closeConfirm({ focus: true }));
    const confirm = actionButton(
      "Revoke key",
      () => revokeKey(key, confirm),
      "button is-danger",
    );
    const actions = document.createElement("div");
    actions.className = "editor-discard-actions";
    actions.append(cancel, confirm);
    group.append(question, actions);
    row.querySelector('[data-control="revoke"]').hidden = true;
    row.append(group);
    confirming = { row, group };
    cancel.focus();
  }

  // After a revoke, focus moves to the next key, or the one before it.
  function focusNear(index) {
    const rows = list.querySelectorAll('[data-control="revoke"]');
    const target = rows[Math.min(index, rows.length - 1)] || create;
    target.focus();
  }

  async function revokeKey(key, button) {
    if (button.getAttribute("aria-disabled") === "true") return;
    button.setAttribute("aria-disabled", "true");
    const index = keys.indexOf(key);
    let gone = false;
    try {
      await window.ZakAPI(
        `/api/song-upload/keys/${encodeURIComponent(key.id)}`,
        { method: "DELETE" },
      );
    } catch (raw) {
      const error = normalize(raw);
      // Revoked already, here or elsewhere: the list catches up.
      if (Number(error.status) === 404) gone = true;
      else {
        button.removeAttribute("aria-disabled");
        closeConfirm();
        const again = actionButton("Try again", () => revokeKey(key, again));
        const actions = [again];
        if (signedOut(error)) {
          actions.unshift(signInAgainLink());
          onSignedOut();
        }
        showProblem(
          problem,
          `${failureSentence(error, `“${key.name}” wasn’t revoked`)}${signedOut(error) ? SIGN_IN_STEP : ""}`,
          actions,
        );
        problem.querySelector("a, button")?.focus();
        return;
      }
    }
    clearProblem(problem);
    if (reveal.dataset.keyId === key.id) clearSecret();
    status.textContent = gone
      ? `“${key.name}” was already revoked.`
      : `Revoked “${key.name}”.`;
    if (await loadKeys()) focusNear(index);
  }

  // ---- The new key
  function clearSecret() {
    secret.value = "";
    reveal.hidden = true;
    delete reveal.dataset.keyId;
    secretState = "";
    discard.hidden = true;
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret.value);
      secretState = "copied";
      status.textContent = "Upload key copied.";
      return true;
    } catch {
      secret.focus();
      secret.select();
      status.textContent = "Copy the selected upload key.";
      return false;
    }
  }

  copy.addEventListener("click", copySecret);
  // Copying it by hand counts too.
  secret.addEventListener("copy", () => {
    if (secret.selectionStart !== secret.selectionEnd) secretState = "copied";
  });
  copyGuide.addEventListener("click", async () => {
    const link = new URL("/ai.json", window.location.href).href;
    try {
      await navigator.clipboard.writeText(link);
      status.textContent = "Agent instructions link copied.";
    } catch {
      status.textContent = `Give your agent this link: ${link}`;
    }
  });

  // ---- Closing with an uncopied key asks first
  function showDiscard() {
    discard.hidden = false;
    discard.scrollIntoView({ block: "nearest" });
    discardCopy.focus();
  }

  function keepKey() {
    discard.hidden = true;
    secret.focus();
    secret.select();
  }

  function requestClose() {
    if (secretState === "shown") showDiscard();
    else dialog.close();
  }

  document
    .getElementById("songKeysClose")
    .addEventListener("click", requestClose);
  discardConfirm.addEventListener("click", () => {
    closeAnyway = true;
    dialog.close();
  });
  discardCopy.addEventListener("click", async () => {
    if (!(await copySecret())) {
      discard.hidden = true;
      return;
    }
    dialog.close();
    // The dialog's own status closes with it.
    document.getElementById("songUploadResult").textContent =
      "Upload key copied.";
  });

  // Escape and Back: first step out of a question, then ask before losing
  // an uncopied key.
  dialog.addEventListener("cancel", (event) => {
    if (confirming) {
      event.preventDefault();
      closeConfirm({ focus: true });
    } else if (!discard.hidden) {
      event.preventDefault();
      keepKey();
    } else if (secretState === "shown") {
      event.preventDefault();
      showDiscard();
    }
  });

  dialog.addEventListener("close", () => {
    // Some browsers close on a repeated Escape even when asked not to;
    // bring the uncopied key back instead of dropping it.
    if (secretState === "shown" && !closeAnyway) {
      dialog.showModal();
      showDiscard();
      return;
    }
    closeAnyway = false;
    clearSecret();
    closeConfirm();
    returnFocus(open);
  });

  open.addEventListener("click", () => {
    status.textContent = "";
    clearProblem(problem);
    dialog.showModal();
    loadKeys();
  });

  // ---- Creating a key
  function validate() {
    const name = nameInput.value.trim();
    const days = Number(daysInput.value);
    const nameProblem = !name
      ? "Enter a key name."
      : characterCount(name) > NAME_LIMIT
        ? `Use ${NAME_LIMIT} characters or fewer.`
        : hasControlCharacters(name)
          ? "Remove tabs and other hidden characters."
          : "";
    const daysProblem =
      Number.isInteger(days) && days >= 1 && days <= DAY_LIMIT
        ? ""
        : `Choose from 1 to ${DAY_LIMIT} days.`;
    for (const [input, message] of [
      [nameInput, nameProblem],
      [daysInput, daysProblem],
    ]) {
      if (message) setFieldError(input, message);
      else clearFieldError(input);
    }
    const first = nameProblem ? nameInput : daysProblem ? daysInput : null;
    first?.focus();
    return first ? null : { name, expires_in_days: days };
  }

  nameInput.addEventListener("input", () => clearFieldError(nameInput));
  daysInput.addEventListener("input", () => clearFieldError(daysInput));

  async function createFailure(raw) {
    const error = normalize(raw);
    if (error.code === "key_limit") {
      await loadKeys();
      return {
        message: atLimit()
          ? `You already have ${maxKeys} active upload keys, so the key wasn’t created. Revoke one to create another.`
          : "Zak Radio can’t hold more upload keys right now, so the key wasn’t created. Ask the person who runs Zak Radio to remove unused keys.",
        actions: [],
      };
    }
    if (error.code === "invalid_key_request")
      return {
        message: `Zak Radio couldn’t accept this name or expiry, so the key wasn’t created. Use a name up to ${NAME_LIMIT} characters and 1 to ${DAY_LIMIT} days.`,
        actions: [],
      };
    const actions = [actionButton("Try again", () => form.requestSubmit())];
    if (signedOut(error)) {
      actions.unshift(signInAgainLink());
      onSignedOut();
    }
    return {
      message: `${failureSentence(error, "the key wasn’t created")}${signedOut(error) ? SIGN_IN_STEP : ""}`,
      actions,
    };
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (creating) return;
    // Try again goes with the error it belonged to; focus moves first.
    if (problem.contains(document.activeElement)) create.focus();
    if (atLimit()) {
      create.focus();
      return;
    }
    const body = validate();
    if (!body) return;
    clearProblem(problem);
    closeConfirm();
    // A new attempt replaces the key shown before, so a failure is never
    // read as having made one.
    clearSecret();
    creating = true;
    create.setAttribute("aria-disabled", "true");
    if (form.contains(document.activeElement)) create.focus();
    status.textContent = "Creating upload key…";
    let created;
    try {
      created = await window.ZakAPI("/api/song-upload/keys", {
        method: "POST",
        body,
      });
    } catch (error) {
      const failure = await createFailure(error);
      status.textContent = "";
      showProblem(problem, failure.message, failure.actions);
      if (dialog.open) problem.querySelector("a, button")?.focus();
      return;
    } finally {
      creating = false;
      syncLimit();
    }
    const { key, token } = created;
    // A request can finish after the dialog closes. Never leave its secret
    // in a hidden field; reopen the dialog so the user can copy it once.
    if (!dialog.open) dialog.showModal();
    reveal.hidden = false;
    reveal.dataset.keyId = key.id;
    secret.value = token;
    secretState = "shown";
    status.textContent =
      "Key created. Copy it before closing; it won’t be shown again.";
    secret.focus();
    secret.select();
    if (!(await loadKeys()))
      status.textContent =
        "Key created. Copy it before closing; it won’t be shown again. The key list didn’t refresh.";
  });
}
