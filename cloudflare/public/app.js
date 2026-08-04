const $ = (id) => document.getElementById(id);
let rows = [], results = [], activeJobId = null, pollTimer = null;
const actorLabels = { posts: "Posts + reposts", comments: "Comments", reactions: "Reactions" };

function parseCsv(text) {
  const matrix = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i], next = text[i + 1];
    if (char === '"' && quoted && next === '"') { field += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(field); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && next === "\n") i++; row.push(field); if (row.some(Boolean)) matrix.push(row); row = []; field = ""; }
    else field += char;
  }
  if (field || row.length) { row.push(field); matrix.push(row); }
  const headers = matrix.shift()?.map((value) => value.trim()) || [];
  return matrix.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value).includes("://") ? String(value).trim() : `https://${String(value).trim()}`);
    if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
    let parts = url.pathname.split("/").filter(Boolean);
    if (parts.length > 2 && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0]) && parts[1].toLowerCase() === "in") parts = parts.slice(1);
    if (parts[0]?.toLowerCase() !== "in" || !parts[1]) return null;
    return `https://www.linkedin.com/in/${decodeURIComponent(parts[1]).toLowerCase()}`;
  } catch { return null; }
}

function selectedActors() {
  return [...document.querySelectorAll(".actor-option")].flatMap((row) => {
    const enabled = row.querySelector('input[name="actor"]');
    if (!enabled?.checked) return [];
    const adapter = row.querySelector(".actor-adapter").value;
    const names = { posts: "Posts + reposts", comments: "Comments", reactions: "Reactions" };
    return [{ key: enabled.value, adapter, actor_id: row.querySelector(".actor-id").value.trim(), label: `${names[adapter]} (${enabled.value})`, limit: +row.querySelector(".actor-limit").value, cost_per_result_usd: +row.querySelector(".actor-cost").value / 1000 }];
  });
}
function estimateCost() {
  const validCount = new Set(rows.map((row) => normalizeUrl(row.linkedin_url)).filter(Boolean)).size;
  return selectedActors().reduce((sum, actor) => sum + validCount * actor.limit * actor.cost_per_result_usd, 0);
}
function updateEstimate() {
  const estimate = estimateCost(); const actors = selectedActors();
  $("costEstimate").textContent = rows.length && actors.length ? `Maximum estimate: $${estimate.toFixed(2)} · actual cost depends on returned results` : "Upload a CSV and select at least one actor.";
  $("start").disabled = !rows.length || !actors.length || !!activeJobId;
}

function escapeHtml(value) { const node = document.createElement("div"); node.textContent = String(value); return node.innerHTML; }
function table(data, container) {
  if (!data.length) { container.innerHTML = ""; return; }
  const headers = Object.keys(data[0]);
  container.innerHTML = `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${data.map((item) => `<tr>${headers.map((header) => `<td class="${header === "activity_tier" ? "tier" : ""}">${escapeHtml(item[header] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

$("file").addEventListener("change", async (event) => {
  rows = parseCsv(await event.target.files[0].text());
  const hasColumn = rows.length && Object.hasOwn(rows[0], "linkedin_url");
  if (!hasColumn) { rows = []; $("validation").textContent = "The CSV must contain a linkedin_url column."; }
  else {
    const valid = rows.filter((row) => normalizeUrl(row.linkedin_url)); const invalid = rows.length - valid.length;
    $("validation").textContent = `${valid.length} valid URLs · ${invalid} skipped${invalid ? " (malformed or non-profile URLs)" : ""}`;
  }
  table(rows.slice(0, 5), $("preview")); updateEstimate();
});
$("actorRows").addEventListener("change", updateEstimate);
let nextActor = 4;
$("addActor").addEventListener("click", () => {
  if (document.querySelectorAll(".actor-option").length >= 10) return;
  const row = document.createElement("div"); row.className = "actor-option";
  row.innerHTML = `<input type="checkbox" name="actor" value="actor-${nextActor++}" checked><span><select class="actor-adapter" aria-label="Output adapter"><option value="posts">Posts + reposts</option><option value="comments">Comments</option><option value="reactions">Reactions</option></select><small>Choose the adapter matching this Actor's output</small><input class="actor-id" aria-label="Actor URL or ID" placeholder="https://apify.com/owner/actor"></span><label class="mini-label">Limit<input class="actor-limit" type="number" value="100" min="1" max="10000"></label><label class="mini-label">$/1,000<input class="actor-cost" type="number" value="5" min="0" step="0.01"></label>`;
  $("actorRows").append(row); updateEstimate();
});

function renderResults() {
  const tier = $("tierFilter").value;
  const shown = results.filter((item) => tier === "ALL" || item.activity_tier === tier).sort((a, b) => (a.days_since_last_activity ?? 1e9) - (b.days_since_last_activity ?? 1e9));
  table(shown, $("results"));
  const counts = results.reduce((map, item) => { map[item.activity_tier] = (map[item.activity_tier] || 0) + 1; return map; }, {});
  $("counts").textContent = ["ACTIVE", "OCCASIONAL", "DORMANT", "INACTIVE", "UNKNOWN"].map((tierName) => `${tierName}: ${counts[tierName] || 0}`).join(" · ");
  if (results.length) $("resultsCard").classList.remove("hidden");
}

function elapsed(started, finished) {
  if (!started) return "waiting";
  const seconds = Math.max(0, Math.round((new Date(finished || Date.now()).getTime() - new Date(started).getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function renderProgress(job) {
  $("jobProgress").classList.remove("hidden"); $("jobLabel").textContent = `Job ${job.id}`; $("progressLabel").textContent = `${job.progress}%`;
  $("progressBar").style.width = `${job.progress}%`;
  $("actorStatuses").innerHTML = job.per_actor_status.map((actor) => `<div class="actor-row"><b>${escapeHtml(actorLabels[actor.actor_key] || actor.actor_key)}</b><span>${elapsed(actor.started_at, actor.finished_at)}</span><span class="status-pill ${String(actor.status).toLowerCase()}">${escapeHtml(actor.status)}</span></div>`).join("");
}

async function pollJob(jobId) {
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
    const job = await response.json(); if (!response.ok) throw new Error(job.error || "Unable to load job");
    renderProgress(job); results = job.results || []; renderResults();
    $("status").textContent = `${job.status} · ${results.length}/${job.url_count} rows available${job.error ? ` · ${job.error}` : ""}`;
    if (["COMPLETE", "FAILED", "STALE"].includes(job.status)) {
      activeJobId = null; clearTimeout(pollTimer); pollTimer = null; updateEstimate();
      return;
    }
    pollTimer = setTimeout(() => pollJob(jobId), 3000);
  } catch (error) { $("status").textContent = error.message; pollTimer = setTimeout(() => pollJob(jobId), 5000); }
}

$("start").addEventListener("click", async () => {
  if (!window.liPulseTurnstileToken) { $("status").textContent = "Please complete the security check before starting."; return; }
  const actors = selectedActors(); const maximum = estimateCost();
  if (!confirm(`Start ${actors.length} actor run${actors.length === 1 ? "" : "s"}?\n\nMaximum estimated cost: $${maximum.toFixed(2)}\nActual cost depends on returned results.`)) return;
  $("start").disabled = true; $("status").textContent = "Creating job…";
  try {
    const response = await fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      rows, actors, api_key: $("apiKey").value || undefined,
      active: +$("active").value, occasional: +$("occasional").value, dormant: +$("dormant").value,
      turnstile_token: window.liPulseTurnstileToken,
    }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error || "Job creation failed");
    activeJobId = body.job_id; location.hash = `job=${encodeURIComponent(activeJobId)}`;
    $("status").textContent = `Job created · ${body.valid_count} valid · ${body.skipped.length} skipped · maximum estimate $${body.estimated_max_cost_usd.toFixed(2)}`;
    await pollJob(activeJobId);
  } catch (error) { activeJobId = null; $("status").textContent = error.message; updateEstimate(); }
  finally { window.liPulseTurnstileToken = ""; window.turnstile?.reset(); }
});

$("tierFilter").addEventListener("change", renderResults);
$("download").addEventListener("click", () => { if (activeJobId || location.hash.startsWith("#job=")) location.href = `/api/jobs/${encodeURIComponent(activeJobId || decodeURIComponent(location.hash.slice(5)))}/export?format=csv`; });

const resumed = location.hash.match(/^#job=(.+)$/);
if (resumed) { activeJobId = decodeURIComponent(resumed[1]); $("start").disabled = true; pollJob(activeJobId); }
