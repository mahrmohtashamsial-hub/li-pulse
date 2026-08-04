const $ = (id) => document.getElementById(id);
let rows = [], results = [];

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

function table(data, container) {
  if (!data.length) { container.innerHTML = ""; return; }
  const headers = Object.keys(data[0]);
  container.innerHTML = `<table><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${data.map((item) => `<tr>${headers.map((header) => `<td class="${header === "activity_tier" ? "tier" : ""}">${escapeHtml(item[header] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function escapeHtml(value) { const node = document.createElement("div"); node.textContent = String(value); return node.innerHTML; }
function toCsv(data) { if (!data.length) return ""; const headers = Object.keys(data[0]), esc = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`; return [headers, ...data.map((item) => headers.map((h) => item[h]))].map((line) => line.map(esc).join(",")).join("\n"); }

$("file").addEventListener("change", async (event) => {
  rows = parseCsv(await event.target.files[0].text());
  const hasColumn = rows.length && Object.hasOwn(rows[0], "linkedin_url");
  $("validation").textContent = hasColumn ? `${rows.length} rows loaded. URL validation runs before provider requests.` : "The CSV must contain a linkedin_url column.";
  table(rows.slice(0, 5), $("preview"));
  $("start").disabled = !hasColumn;
});

$("start").addEventListener("click", async () => {
  if (!window.liPulseTurnstileToken) {
    $("status").textContent = "Please complete the security check before starting.";
    return;
  }
  $("start").disabled = true; $("status").textContent = "Processing profiles…";
  try {
    const response = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      rows, provider: $("provider").value, api_key: $("apiKey").value, max_age_days: +$("maxAge").value,
      active: +$("active").value, occasional: +$("occasional").value, dormant: +$("dormant").value,
      turnstile_token: window.liPulseTurnstileToken,
    }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error || "Run failed");
    results = body.results; $("status").textContent = `Completed ${results.length} profiles; skipped ${body.skipped.length}.`;
    const counts = Object.groupBy(results, (item) => item.activity_tier);
    $("counts").textContent = ["ACTIVE", "OCCASIONAL", "DORMANT", "INACTIVE", "UNKNOWN"].map((tier) => `${tier}: ${counts[tier]?.length || 0}`).join(" · ");
    $("resultsCard").classList.remove("hidden"); renderResults();
  } catch (error) { $("status").textContent = error.message; }
  finally {
    window.liPulseTurnstileToken = "";
    window.turnstile?.reset();
    $("start").disabled = false;
  }
});

function renderResults() { const tier = $("tierFilter").value; const shown = results.filter((item) => tier === "ALL" || item.activity_tier === tier).sort((a, b) => (a.days_since_last_activity ?? 1e9) - (b.days_since_last_activity ?? 1e9)); table(shown, $("results")); }
$("tierFilter").addEventListener("change", renderResults);
$("download").addEventListener("click", () => { const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([toCsv(results)], { type: "text/csv" })); link.download = "li-pulse-activity.csv"; link.click(); URL.revokeObjectURL(link.href); });
