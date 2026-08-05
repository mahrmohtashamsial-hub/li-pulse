const $ = (id) => document.getElementById(id);
let rows = [], results = [], activeJobId = null, pollTimer = null;
let emailResults = [];
const actorLabels = { posts: "Posts + reposts", comments: "Comments", reactions: "Reactions" };

function selectWorkflow(workflow) {
  document.body.dataset.workflow = workflow;
  document.querySelectorAll("[data-workflow-target]").forEach((button) => { const selected = button.dataset.workflowTarget === workflow; button.classList.toggle("active", selected); button.setAttribute("aria-selected", String(selected)); });
  $("uploadHeading").textContent = workflow === "email" ? "Upload contacts" : "Upload prospects";
  $("uploadRequirement").innerHTML = workflow === "email" ? 'CSV containing an <code>email</code> column, or select another column below' : 'CSV containing a <code>linkedin_url</code> column';
  const cta = document.querySelector(".nav-cta"); cta.textContent = workflow === "email" ? "Verify emails" : "Analyze profiles"; cta.href = workflow === "email" ? "#emailVerification" : "#configure";
  if (workflow === "email") refreshEmailColumns();
}
document.querySelectorAll("[data-workflow-target]").forEach((button) => button.addEventListener("click", () => { selectWorkflow(button.dataset.workflowTarget); location.hash = button.dataset.workflowTarget; window.scrollTo({ top: 0, behavior: "smooth" }); }));

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
  const estimate = estimateCost(); const actors = selectedActors(); const linkedinCount = rows.filter((row) => normalizeUrl(row.linkedin_url)).length;
  $("costEstimate").textContent = linkedinCount && actors.length ? `Maximum estimate: $${estimate.toFixed(2)} · actual cost depends on returned results` : "Upload LinkedIn profile URLs and select at least one actor.";
  $("start").disabled = !linkedinCount || !actors.length || !!activeJobId;
}

function escapeHtml(value) { const node = document.createElement("div"); node.textContent = String(value); return node.innerHTML; }
function table(data, container) {
  if (!data.length) { container.innerHTML = ""; return; }
  const headers = Object.keys(data[0]);
  container.innerHTML = `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${data.map((item) => `<tr>${headers.map((header) => `<td class="${header === "activity_tier" ? "tier" : ""}">${escapeHtml(item[header] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

$("file").addEventListener("change", async (event) => {
  rows = parseCsv(await event.target.files[0].text());
  const hasLinkedIn = rows.length && Object.hasOwn(rows[0], "linkedin_url");
  if (!rows.length) { $("validation").textContent = "The CSV contains no data rows."; }
  else if (document.body.dataset.workflow === "email") {
    const emailColumn = Object.keys(rows[0]).find((header) => header.toLowerCase() === "email");
    $("validation").textContent = `${rows.length} rows loaded · ${emailColumn ? `email column detected: ${emailColumn}` : "select the email column in the verification panel"}`;
  }
  else if (hasLinkedIn) {
    const valid = rows.filter((row) => normalizeUrl(row.linkedin_url)); const invalid = rows.length - valid.length;
    $("validation").textContent = `${valid.length} valid LinkedIn URLs · ${invalid} skipped${invalid ? " (malformed or non-profile URLs)" : ""}`;
  } else $("validation").textContent = `${rows.length} rows loaded · no linkedin_url column (email verification is still available)`;
  table(rows.slice(0, 5), $("preview")); updateEstimate(); refreshEmailColumns();
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
  refreshEmailColumns();
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
else if (location.hash === "#email") selectWorkflow("email");

const emailRates = { millionverifier: 0.001, debounce: 0.0008, neverbounce: 0.001, zerobounce: 0.009 };
function emailSourceRows() { return $("useActivityResults").checked && results.length ? results : rows; }
function refreshEmailColumns() {
  const source = emailSourceRows(); const headers = source.length ? Object.keys(source[0]) : [];
  const previous = $("emailColumn").value; $("emailColumn").innerHTML = headers.map((header) => `<option value="${escapeHtml(header)}">${escapeHtml(header)}</option>`).join("") || '<option value="">Upload a CSV first</option>';
  $("emailColumn").value = headers.includes(previous) ? previous : (headers.find((header) => header.toLowerCase() === "email") || headers[0] || ""); updateEmailEstimate();
}
function updateEmailEstimate() {
  const column = $("emailColumn").value; const count = emailSourceRows().filter((row) => String(row[column] || "").trim()).length; const provider = $("emailProvider").value;
  const low = provider === "zerobounce" ? count * 0.006 : count * emailRates[provider]; const high = count * emailRates[provider];
  $("emailCost").textContent = count ? `Estimated ${count} emails · ~$${low.toFixed(2)}${high !== low ? `–$${high.toFixed(2)}` : ""} · estimate only; provider rates change` : "Select a populated email column to estimate cost.";
  $("verifyEmails").disabled = !count || !$("emailApiKey").value.trim();
}
function renderEmailResults() {
  const filter = $("emailFilter").value.toLowerCase(); const shown = emailResults.filter((row) => filter === "all" || row.email_status === filter);
  table(shown, $("emailResults")); const counts = emailResults.reduce((map, row) => { map[row.email_status] = (map[row.email_status] || 0) + 1; return map; }, {});
  $("emailCounts").textContent = ["valid", "invalid", "risky", "unknown"].map((status) => `${status.toUpperCase()}: ${counts[status] || 0}`).join(" · ");
  if (emailResults.length) $("emailResultsCard").classList.remove("hidden");
}
function csvText(data) {
  if (!data.length) return ""; const headers = Object.keys(data[0]); const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [headers.map(quote).join(","), ...data.map((row) => headers.map((header) => quote(row[header])).join(","))].join("\r\n");
}
$("emailProvider").addEventListener("change", updateEmailEstimate); $("emailColumn").addEventListener("change", updateEmailEstimate); $("emailApiKey").addEventListener("input", updateEmailEstimate);
$("useActivityResults").addEventListener("change", refreshEmailColumns); $("emailFilter").addEventListener("change", renderEmailResults);
$("verifyEmails").addEventListener("click", async () => {
  const source = emailSourceRows(), column = $("emailColumn").value, candidates = source.map((row, index) => ({ row, index, email: String(row[column] || "").trim() })).filter((item) => item.email);
  const estimate = candidates.length * emailRates[$("emailProvider").value]; if (!confirm(`Verify ${candidates.length} emails?\n\nEstimated maximum cost: $${estimate.toFixed(2)}\nProvider pricing may change.`)) return;
  $("verifyEmails").disabled = true; emailResults = source.map((row) => ({ ...row, email_status: "", email_status_reason: "" })); let completed = 0;
  try {
    for (let offset = 0; offset < candidates.length; offset += 40) {
      const batch = candidates.slice(offset, offset + 40); const response = await fetch("/api/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: $("emailProvider").value, api_key: $("emailApiKey").value, emails: batch.map((item) => item.email), max_age_days: +$("emailMaxAge").value }) });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Email verification batch failed");
      payload.results.forEach((verification, index) => { const target = emailResults[batch[index].index]; target.email_status = verification.status; target.email_status_reason = verification.reason; });
      completed += batch.length; $("emailProgress").textContent = `${completed} / ${candidates.length} verified`; renderEmailResults();
    }
  } catch (error) { $("emailProgress").textContent = `${completed} / ${candidates.length} verified · ${error.message}`; }
  finally { updateEmailEstimate(); }
});
$("downloadEmails").addEventListener("click", () => { const blob = new Blob([csvText(emailResults)], { type: "text/csv;charset=utf-8" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "li-pulse-email-verification.csv"; link.click(); URL.revokeObjectURL(link.href); });
