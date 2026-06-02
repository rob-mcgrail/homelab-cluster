// tv — playlist manager UI
// Vanilla JS, no build step. The whole list re-renders on state changes; with
// O(few hundred) channels that's cheap and keeps the code straightforward.

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));

let state = {
  channels: [],
  userAgents: [],
  search: "",
  groupFilter: "",
  statusFilter: "enabled",
  selected: new Set(),
};

// ── fetch helpers ───────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${body || res.statusText}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

function toast(msg, kind = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast " + kind;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3500);
}

// ── data ────────────────────────────────────────────────────
async function loadAll() {
  const data = await api("/api/channels");
  state.channels = data.channels;
  state.userAgents = data.user_agents;
  refreshUserAgentSelects();
  refreshGroupFilter();
  render();
}

function refreshUserAgentSelects() {
  // Populate the bulk-action UA select (per-row selects are built in render()).
  const bulk = $("#bulk-ua-select");
  // Keep the placeholder option.
  bulk.innerHTML = '<option value="">Set UA…</option>' +
    state.userAgents.map(k => `<option value="${k}">${k}</option>`).join("");
}

function refreshGroupFilter() {
  const groups = [...new Set(state.channels.map(c => c.group_title).filter(Boolean))].sort();
  const sel = $("#group-filter");
  const cur = sel.value;
  sel.innerHTML = '<option value="">All groups</option>' +
    groups.map(g => `<option value="${escapeAttr(g)}">${escapeHtml(g)}</option>`).join("");
  if (groups.includes(cur)) sel.value = cur;
}

// ── filtering / rendering ───────────────────────────────────
function visibleChannels() {
  const q = state.search.trim().toLowerCase();
  return state.channels.filter(c => {
    if (state.groupFilter && c.group_title !== state.groupFilter) return false;
    if (state.statusFilter === "enabled" && !c.enabled) return false;
    if (state.statusFilter === "disabled" && c.enabled) return false;
    if (q) {
      const hay = `${c.display_name || ""} ${c.group_title || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function render() {
  const tbody = $("#rows");
  const visible = visibleChannels();
  tbody.innerHTML = visible.map(rowHtml).join("");

  $("#empty").hidden = state.channels.length > 0;

  // Counts
  const total = state.channels.length;
  const enabled = state.channels.filter(c => c.enabled).length;
  $("#counts").textContent = `${enabled}/${total} on  ·  ${visible.length} shown`;

  // Selection bar
  const n = state.selected.size;
  $("#bulkbar").hidden = n === 0;
  $("#sel-n").textContent = n;

  // Sync header checkbox
  const allChecked = visible.length > 0 && visible.every(c => state.selected.has(c.id));
  $("#check-all").checked = allChecked;
  $("#check-all").indeterminate = !allChecked && visible.some(c => state.selected.has(c.id));

  wireRowEvents();
}

function rowHtml(c) {
  const logo = c.tvg_logo
    ? `<img class="logo-img" src="${escapeAttr(c.tvg_logo)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'logo-empty',textContent:'?'}))">`
    : `<div class="logo-empty">∅</div>`;
  const uaOptions = state.userAgents
    .map(k => `<option value="${k}"${k === c.user_agent ? " selected" : ""}>${k}</option>`)
    .join("");
  const checked = state.selected.has(c.id);
  return `
  <tr data-id="${c.id}" class="${c.enabled ? "" : "disabled"}" draggable="true">
    <td class="col-grip grip" aria-hidden="true">⠿</td>
    <td class="col-check"><input type="checkbox" class="row-check" ${checked ? "checked" : ""}></td>
    <td class="col-pos">${c.position}</td>
    <td class="col-logo">${logo}</td>
    <td class="col-name"><input type="text" data-field="display_name" value="${escapeAttr(c.display_name)}"></td>
    <td class="col-group"><input type="text" data-field="group_title" value="${escapeAttr(c.group_title || "")}"></td>
    <td class="col-ua"><select data-field="user_agent">${uaOptions}</select></td>
    <td class="col-en">
      <label class="toggle"><input type="checkbox" data-field="enabled" ${c.enabled ? "checked" : ""}><span class="slider"></span></label>
    </td>
    <td class="col-test"><button class="btn icon" data-action="test" title="Open test player">▶</button></td>
    <td class="col-del"><button class="btn icon danger" data-action="delete" title="Delete">×</button></td>
  </tr>`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ── row interactions ────────────────────────────────────────
function wireRowEvents() {
  // Selection
  $$(".row-check", $("#rows")).forEach(cb => {
    cb.addEventListener("change", e => {
      const id = parseInt(e.target.closest("tr").dataset.id, 10);
      if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
      render();
    });
  });

  // Inline edits (text inputs + ua select): save on change/blur
  $$("input[type=text][data-field], select[data-field]", $("#rows")).forEach(el => {
    const evt = el.tagName === "SELECT" ? "change" : "change";
    el.addEventListener(evt, () => saveField(el));
  });

  // Enabled toggle
  $$('input[type=checkbox][data-field="enabled"]', $("#rows")).forEach(el => {
    el.addEventListener("change", () => saveField(el));
  });

  // Test / delete buttons
  $$('button[data-action]', $("#rows")).forEach(btn => {
    btn.addEventListener("click", async e => {
      const tr = e.target.closest("tr");
      const id = parseInt(tr.dataset.id, 10);
      const c = state.channels.find(x => x.id === id);
      if (!c) return;
      if (btn.dataset.action === "test") {
        const url = `/play?url=${encodeURIComponent(c.stream_url)}&name=${encodeURIComponent(c.display_name)}`;
        window.open(url, "_blank", "noopener");
      } else if (btn.dataset.action === "delete") {
        if (!confirm(`Delete "${c.display_name}"?`)) return;
        try {
          await api(`/api/channels/${id}`, { method: "DELETE" });
          state.channels = state.channels.filter(x => x.id !== id);
          state.selected.delete(id);
          render();
          toast("Deleted", "ok");
        } catch (err) { toast(err.message, "err"); }
      }
    });
  });

  wireDragDrop();
}

async function saveField(el) {
  const tr = el.closest("tr");
  const id = parseInt(tr.dataset.id, 10);
  const c = state.channels.find(x => x.id === id);
  if (!c) return;
  const field = el.dataset.field;
  const value = el.type === "checkbox" ? el.checked : el.value;
  const body = { [field]: value };
  try {
    const updated = await api(`/api/channels/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    Object.assign(c, updated);
    if (field === "enabled") tr.classList.toggle("disabled", !value);
    refreshGroupFilter();
    // Update counts without full re-render to avoid stealing focus mid-edit.
    const total = state.channels.length;
    const enabled = state.channels.filter(x => x.enabled).length;
    $("#counts").textContent = `${enabled}/${total} on  ·  ${visibleChannels().length} shown`;
  } catch (err) {
    toast(`Save failed: ${err.message}`, "err");
  }
}

// ── drag & drop reorder ─────────────────────────────────────
let dragId = null;
function wireDragDrop() {
  $$("#rows tr").forEach(tr => {
    tr.addEventListener("dragstart", e => {
      dragId = parseInt(tr.dataset.id, 10);
      tr.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(dragId));
    });
    tr.addEventListener("dragend", () => {
      tr.classList.remove("dragging");
      $$("#rows tr").forEach(r => r.classList.remove("drop-target"));
      dragId = null;
    });
    tr.addEventListener("dragover", e => {
      if (dragId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      $$("#rows tr").forEach(r => r.classList.remove("drop-target"));
      tr.classList.add("drop-target");
    });
    tr.addEventListener("drop", async e => {
      e.preventDefault();
      if (dragId === null) return;
      const targetId = parseInt(tr.dataset.id, 10);
      if (targetId === dragId) return;
      await reorderInState(dragId, targetId);
    });
  });
}

async function reorderInState(srcId, beforeId) {
  // Move srcId to be positioned at beforeId's slot, shifting the rest down.
  // We operate on the full channel list (not just visible rows) so positions
  // stay coherent under any filter — but the drop target is by row, so we
  // compute the new global index from the source channel's place vs the
  // target's place in the full array.
  const arr = [...state.channels].sort((a, b) => a.position - b.position);
  const srcIdx = arr.findIndex(c => c.id === srcId);
  const dstIdx = arr.findIndex(c => c.id === beforeId);
  if (srcIdx < 0 || dstIdx < 0) return;
  const [moved] = arr.splice(srcIdx, 1);
  arr.splice(dstIdx, 0, moved);
  // Rewrite positions
  arr.forEach((c, i) => { c.position = i + 1; });
  state.channels = arr;
  render();
  try {
    await api("/api/channels/reorder", {
      method: "POST",
      body: JSON.stringify({ order: arr.map(c => c.id) }),
    });
  } catch (err) {
    toast(`Reorder failed: ${err.message}`, "err");
    loadAll();
  }
}

// ── header / search / filter ────────────────────────────────
$("#search").addEventListener("input", e => { state.search = e.target.value; render(); });
$("#group-filter").addEventListener("change", e => { state.groupFilter = e.target.value; render(); });
$("#status-filter").addEventListener("change", e => { state.statusFilter = e.target.value; render(); });

$("#check-all").addEventListener("change", e => {
  const visible = visibleChannels();
  if (e.target.checked) visible.forEach(c => state.selected.add(c.id));
  else visible.forEach(c => state.selected.delete(c.id));
  render();
});

// ── bulk actions ────────────────────────────────────────────
$$("button[data-bulk]").forEach(btn => {
  btn.addEventListener("click", () => doBulk(btn.dataset.bulk));
});
$("#bulk-ua-select").addEventListener("change", e => {
  if (e.target.value) doBulk("set_user_agent", e.target.value);
  e.target.value = "";
});
$("#clear-sel").addEventListener("click", () => { state.selected.clear(); render(); });

async function doBulk(action, value = null) {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (action === "delete" && !confirm(`Delete ${ids.length} channels?`)) return;
  try {
    await api("/api/channels/bulk", {
      method: "POST",
      body: JSON.stringify({ ids, action, value }),
    });
    if (action === "delete") state.selected.clear();
    await loadAll();
    toast(`${action}: ${ids.length} channels`, "ok");
  } catch (err) {
    toast(err.message, "err");
  }
}

// ── import ──────────────────────────────────────────────────
$("#toggle-import").addEventListener("click", () => {
  $("#import-panel").hidden = !$("#import-panel").hidden;
  if (!$("#import-panel").hidden) $("#import-url").focus();
});
$("#close-import").addEventListener("click", () => { $("#import-panel").hidden = true; });

$("#do-import").addEventListener("click", () => doImport({ url: $("#import-url").value.trim() }));
$("#do-paste-import").addEventListener("click", () =>
  doImport({ m3u: $("#import-paste").value, source: "pasted" }));

async function doImport(body) {
  const status = $("#import-status");
  if (!body.url && !body.m3u) { status.textContent = "Provide a URL or pasted M3U."; status.className = "status err"; return; }
  status.textContent = "Importing…"; status.className = "status";
  try {
    const res = await api("/api/import", { method: "POST", body: JSON.stringify(body) });
    status.textContent = `Parsed ${res.parsed} • added ${res.added} • skipped ${res.skipped} (already present)`;
    status.className = "status ok";
    await loadAll();
  } catch (err) {
    status.textContent = err.message;
    status.className = "status err";
  }
}

// ── kick off ────────────────────────────────────────────────
loadAll().catch(err => toast(err.message, "err"));
