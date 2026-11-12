// Shared pieces of the Add song and API access dialogs: field errors, the
// error box with its actions, and where focus goes when a dialog closes.

const SVG = "http://www.w3.org/2000/svg";

// A field's error sits under it (the element its aria-errormessage names),
// and the field says it is invalid and is described by the error first.
export function setFieldError(input, message) {
  const note = document.getElementById(input.getAttribute("aria-errormessage"));
  input.dataset.hints ??= input.getAttribute("aria-describedby") || "";
  note.textContent = message;
  note.hidden = false;
  input.setAttribute("aria-invalid", "true");
  input.setAttribute(
    "aria-describedby",
    [note.id, input.dataset.hints].filter(Boolean).join(" "),
  );
}

export function clearFieldError(input) {
  if (!input.hasAttribute("aria-invalid")) return;
  const note = document.getElementById(input.getAttribute("aria-errormessage"));
  note.hidden = true;
  note.textContent = "";
  input.removeAttribute("aria-invalid");
  if (input.dataset.hints)
    input.setAttribute("aria-describedby", input.dataset.hints);
  else input.removeAttribute("aria-describedby");
}

export function actionButton(label, onClick, className = "button") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

// What didn't happen and why, then the next steps. The box is an alert
// region, so the sentence is announced once; focus goes to the first action.
export function showProblem(box, message, actions = []) {
  const text = document.createElement("p");
  text.textContent = message;
  box.replaceChildren(text);
  if (actions.length) {
    const row = document.createElement("div");
    row.className = "state-actions";
    row.append(...actions);
    box.append(row);
  }
  box.hidden = false;
}

export function clearProblem(box) {
  box.hidden = true;
  box.replaceChildren();
}

// Opens this page again in a new tab. The full page load passes through
// the sign-in gateway, which asks for a sign-in; this tab keeps the form.
export function signInAgainLink() {
  const link = document.createElement("a");
  link.className = "button";
  link.href = `${window.location.pathname}${window.location.search}`;
  link.target = "_blank";
  link.rel = "noopener";
  link.append("Sign in again");
  const icon = document.createElementNS(SVG, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", "M14 5h5v5M19 5l-8 8M17 14v5H5V7h5");
  icon.append(path);
  const note = document.createElement("span");
  note.className = "sr-only";
  note.textContent = " (opens in a new tab)";
  link.append(icon, note);
  return link;
}

function shown(element) {
  return Boolean(
    element?.isConnected &&
    !element.closest("[hidden]") &&
    element.getClientRects().length,
  );
}

// Back to the button that opened the dialog. A sign-in that expired while
// it was open can hide that button, so the next control in the entry, or
// the Library heading, takes focus instead.
export function returnFocus(opener) {
  const target = [
    opener,
    document.getElementById("songUploadOpen"),
    document.getElementById("songKeysOpen"),
    document.getElementById("songUploadSignIn"),
  ].find(shown);
  (target || document.getElementById("libraryViewTitle"))?.focus({
    preventScroll: true,
  });
}
