export function initSongKeys() {
  const open = document.getElementById("songKeysOpen");
  const dialog = document.getElementById("songKeysDialog");
  const form = document.getElementById("songKeysForm");
  const create = document.getElementById("songKeysCreate");
  const list = document.getElementById("songKeysList");
  const status = document.getElementById("songKeysStatus");
  const secret = document.getElementById("songKeysSecret");
  const reveal = document.getElementById("songKeysReveal");
  const copy = document.getElementById("songKeysCopy");
  let creating = false;

  function showError(error) {
    status.setAttribute("role", "alert");
    status.textContent =
      error.detail ||
      error.message ||
      "Upload keys are unavailable. Try again.";
  }
  async function loadKeys() {
    const { keys } = await window.ZakAPI("/api/song-upload/keys");
    list.replaceChildren();
    for (const key of keys) {
      const row = document.createElement("li");
      row.className = "song-key-item";
      const name = document.createElement("span");
      name.textContent = `${key.name} · expires ${new Date(key.expires_at * 1000).toLocaleDateString()}`;
      const revoke = document.createElement("button");
      revoke.className = "button";
      revoke.type = "button";
      revoke.textContent = "Revoke";
      revoke.setAttribute("aria-label", `Revoke ${key.name}`);
      revoke.addEventListener("click", async () => {
        revoke.disabled = true;
        try {
          await window.ZakAPI(
            `/api/song-upload/keys/${encodeURIComponent(key.id)}`,
            { method: "DELETE" },
          );
          if (reveal.dataset.keyId === key.id) {
            secret.value = "";
            reveal.hidden = true;
          }
          await loadKeys();
          if (dialog.open) create.focus();
          status.setAttribute("role", "status");
          status.textContent = `Revoked ${key.name}.`;
        } catch (error) {
          showError(error);
          revoke.disabled = false;
        }
      });
      row.append(name, revoke);
      list.append(row);
    }
    if (!keys.length) {
      const empty = document.createElement("li");
      empty.textContent = "No active upload keys.";
      list.append(empty);
    }
  }
  open.addEventListener("click", () => {
    status.textContent = "";
    dialog.showModal();
    loadKeys().catch(showError);
  });
  document
    .getElementById("songKeysClose")
    .addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    secret.value = "";
    reveal.hidden = true;
    open.focus({ preventScroll: true });
  });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(secret.value);
      status.setAttribute("role", "status");
      status.textContent = "Upload key copied.";
    } catch {
      secret.focus();
      secret.select();
      status.textContent = "Copy the selected upload key.";
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (creating || !form.reportValidity()) return;
    creating = true;
    create.disabled = true;
    status.setAttribute("role", "status");
    status.textContent = "Creating upload key…";
    try {
      const { key, token } = await window.ZakAPI("/api/song-upload/keys", {
        method: "POST",
        body: {
          name: form.elements.keyName.value,
          expires_in_days: Number(form.elements.keyDays.value),
        },
      });
      // A request can finish after the dialog closes. Never leave its secret
      // in a hidden field; reopen the dialog so the user can copy it once.
      if (!dialog.open) dialog.showModal();
      reveal.hidden = false;
      reveal.dataset.keyId = key.id;
      secret.value = token;
      status.textContent =
        "Key created. Copy it before closing; it will not be shown again.";
      secret.focus();
      secret.select();
      try {
        await loadKeys();
      } catch {
        status.textContent =
          "Key created. Copy it before closing. The key list could not refresh.";
      }
    } catch (error) {
      showError(error);
    } finally {
      creating = false;
      create.disabled = false;
    }
  });
}
