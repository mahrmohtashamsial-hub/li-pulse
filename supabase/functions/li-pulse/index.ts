import { createClient } from "npm:@supabase/supabase-js@2.57.4";

type Tier = "ACTIVE" | "OCCASIONAL" | "DORMANT" | "INACTIVE" | "UNKNOWN";
type Provider = "apify" | "brightdata" | "proxycurl" | "mock";
type Thresholds = { active: number; occasional: number; dormant: number };
type RequestRow = Record<string, string> & { linkedin_url: string };

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type",
};

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("missing URL");
  const input = value.includes("://") ? value.trim() : `https://${value.trim()}`;
  const url = new URL(input);
  if (!["linkedin.com", "www.linkedin.com"].includes(url.hostname.toLowerCase())) throw new Error("not a LinkedIn URL");
  let parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length >= 3 && /^[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0]) && parts[1].toLowerCase() === "in") parts = parts.slice(1);
  if (["company", "school", "showcase"].includes((parts[0] || "").toLowerCase())) throw new Error("company page");
  if (parts.length < 2 || parts[0].toLowerCase() !== "in" || !/^[\w%.~-]+$/.test(parts[1])) throw new Error("not a personal profile URL");
  return `https://www.linkedin.com/in/${parts[1]}`;
}

function dates(value: unknown): Date[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = typeof item === "object" && item ? (item as Record<string, unknown>).date : item;
    const parsed = new Date(String(raw));
    return Number.isNaN(parsed.getTime()) ? [] : [parsed];
  });
}

function metrics(raw: Record<string, unknown>, thresholds: Thresholds) {
  const data = (raw.data && typeof raw.data === "object" ? raw.data : raw) as Record<string, unknown>;
  const posts = dates(data.posts), reposts = dates(data.reposts), comments = dates(data.comments), reactions = dates(data.reactions);
  const activityAvailable = [posts, reposts, comments].some((v) => v !== null);
  const activity = [...(posts || []), ...(reposts || []), ...(comments || [])];
  const newest = activity.length ? new Date(Math.max(...activity.map((d) => d.getTime()))) : null;
  const dayMs = 86400000;
  const days = newest ? Math.max(0, Math.floor((Date.now() - newest.getTime()) / dayMs)) : null;
  const within = (values: Date[] | null, period: number) => values === null ? null : values.filter((d) => { const age = Math.floor((Date.now() - d.getTime()) / dayMs); return age >= 0 && age <= period; }).length;
  const p30 = within(posts, 30), p90 = within(posts, 90), p180 = within(posts, 180);
  const r90 = within(reposts, 90), c90 = within(comments, 90), react90 = within(reactions, 90);
  const available = [p90, r90, c90, react90].filter((v): v is number => v !== null);
  let tier: Tier;
  if (!activityAvailable) tier = "UNKNOWN";
  else if (days === null || days > thresholds.dormant) tier = "INACTIVE";
  else if (days <= thresholds.active) tier = "ACTIVE";
  else if (days <= thresholds.occasional) tier = "OCCASIONAL";
  else tier = "DORMANT";
  const note = tier === "UNKNOWN" ? "No activity data returned" : days === null ? `No activity in last ${thresholds.dormant}d` : `${p30 === null ? "" : `Posted ${p30}x in last 30d, `}last active ${days} day${days === 1 ? "" : "s"} ago`;
  return {
    last_activity_date: newest?.toISOString().slice(0, 10) ?? null, days_since_last_activity: days,
    posts_last_30d: p30, posts_last_90d: p90, posts_last_180d: p180,
    reposts_last_90d: r90, comments_last_90d: c90, reactions_last_90d: react90,
    total_activity_last_90d: available.length ? available.reduce((a, b) => a + b, 0) : null,
    follower_count: data.follower_count ?? data.followers ?? null,
    connection_count: data.connection_count ?? data.connections ?? null,
    headline: data.headline ?? null, current_company: data.current_company ?? data.company ?? null,
    current_title: data.current_title ?? data.title ?? null, activity_tier: tier, activity_note: note,
  };
}

async function fetchProvider(provider: Provider, linkedinUrl: string, suppliedKey?: string): Promise<Record<string, unknown>> {
  const envNames: Record<Provider, string> = { apify: "APIFY_API_KEY", brightdata: "BRIGHTDATA_API_KEY", proxycurl: "PROXYCURL_API_KEY", mock: "MOCK_API_KEY" };
  const key = Deno.env.get(envNames[provider]) || suppliedKey;
  if (!key && provider !== "mock") throw new Error(`Missing ${envNames[provider]} secret`);
  let endpoint: string, init: RequestInit;
  if (provider === "apify") {
    const actor = Deno.env.get("APIFY_ACTOR_ID") || "dev_fusion~linkedin-profile-scraper";
    endpoint = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(key || "")}`;
    init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profileUrls: [linkedinUrl] }) };
  } else if (provider === "brightdata") {
    endpoint = `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${encodeURIComponent(Deno.env.get("BRIGHTDATA_DATASET_ID") || "")}&format=json`;
    init = { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ url: linkedinUrl }) };
  } else if (provider === "proxycurl") {
    endpoint = `https://nubela.co/proxycurl/api/v2/linkedin?url=${encodeURIComponent(linkedinUrl)}`;
    init = { headers: { authorization: `Bearer ${key}` } };
  } else {
    const days = linkedinUrl.includes("active") ? 3 : linkedinUrl.includes("occasional") ? 40 : 999;
    return { posts: days < 181 ? [new Date(Date.now() - days * 86400000).toISOString()] : [], reposts: [], comments: [], headline: "Mock profile" };
  }
  let lastError = "Provider request failed";
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(endpoint, init);
    if (response.ok) { const body = await response.json(); return Array.isArray(body) ? (body[0] || {}) : body; }
    lastError = `Provider HTTP ${response.status}`;
    if (response.status !== 429 && response.status < 500) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(retryAfter) ? retryAfter * 1000 : (2 ** attempt * 1000 + Math.random() * 500)));
  }
  throw new Error(lastError);
}

async function processRequest(body: Record<string, unknown>) {
  const inputRows = Array.isArray(body.rows) ? body.rows as RequestRow[] : [];
  const provider = (body.provider || "mock") as Provider;
  const thresholds = { active: Number(body.active ?? 14), occasional: Number(body.occasional ?? 60), dormant: Number(body.dormant ?? 180) };
  if (!(thresholds.active < thresholds.occasional && thresholds.occasional < thresholds.dormant)) throw new Error("Tier thresholds must be strictly increasing");
  const maxAge = Math.max(0, Number(body.max_age_days ?? 14));
  const concurrency = Math.min(20, Math.max(1, Number(body.concurrency ?? 5)));
  const valid: RequestRow[] = [], skipped: Array<Record<string, unknown>> = [], seen = new Set<string>();
  inputRows.forEach((row, index) => { try { const url = normalizeUrl(row.linkedin_url); const key = url.toLowerCase(); if (seen.has(key)) throw new Error("duplicate profile"); seen.add(key); valid.push({ ...row, linkedin_url: url }); } catch (e) { skipped.push({ row_number: index + 2, linkedin_url: row.linkedin_url, reason: e instanceof Error ? e.message : String(e) }); } });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const results: Array<Record<string, unknown>> = [];
  let cursor = 0;
  async function worker() {
    while (cursor < valid.length) {
      const row = valid[cursor++];
      try {
        let raw: Record<string, unknown> | null = null;
        if (!body.force_refresh) {
          const cutoff = new Date(Date.now() - maxAge * 86400000).toISOString();
          const { data } = await admin.from("li_pulse_cache").select("raw").eq("provider", provider).eq("linkedin_url", row.linkedin_url).gte("fetched_at", cutoff).maybeSingle();
          raw = data?.raw || null;
        }
        if (!raw) { raw = await fetchProvider(provider, row.linkedin_url, String(body.api_key || "")); await admin.from("li_pulse_cache").upsert({ provider, linkedin_url: row.linkedin_url, raw, fetched_at: new Date().toISOString() }); }
        results.push({ ...row, ...metrics(raw, thresholds), fetch_error: null });
      } catch (e) { results.push({ ...row, activity_tier: "UNKNOWN", activity_note: "Fetch failed", fetch_error: e instanceof Error ? e.message : String(e) }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, valid.length || 1) }, worker));
  return { results, skipped, valid_count: valid.length, estimated_cost_usd: valid.length * Number(body.cost_per_profile_usd || 0) };
}

const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>li-pulse</title><style>body{font:15px system-ui;margin:0;background:#f5f7fb;color:#172033}main{max-width:1100px;margin:auto;padding:32px}h1{margin-bottom:4px}.card{background:white;padding:22px;border-radius:14px;box-shadow:0 2px 14px #19233c16;margin:18px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}label{display:grid;gap:5px}input,select,button{padding:10px;border:1px solid #ccd3df;border-radius:8px}button{background:#176b50;color:white;font-weight:700;cursor:pointer}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:8px;border-bottom:1px solid #e4e8ef;text-align:left}th{cursor:pointer}.pill{font-weight:700}#status{white-space:pre-wrap}.hidden{display:none}</style></head><body><main><h1>li-pulse</h1><p>LinkedIn activity scoring through third-party provider APIs—no browser scraping or session cookies.</p><div class="card"><label>Prospects CSV<input id="file" type="file" accept=".csv"></label><pre id="validation">Upload a CSV containing linkedin_url.</pre><div class="grid"><label>Provider<select id="provider"><option>mock</option><option>apify</option><option>brightdata</option><option>proxycurl</option></select></label><label>Concurrency<input id="concurrency" type="number" value="5" min="1" max="20"></label><label>Cache max-age<input id="age" type="number" value="14" min="0"></label><label>ACTIVE max<input id="active" type="number" value="14"></label><label>OCCASIONAL max<input id="occasional" type="number" value="60"></label><label>DORMANT max<input id="dormant" type="number" value="180"></label><label>Cost/profile USD<input id="cost" type="number" value="0.01" step="0.001"></label><label>API key (if secret unset)<input id="key" type="password"></label></div><p id="estimate"></p><button id="start" disabled>Start</button><progress id="progress" value="0" max="1" style="width:100%;margin-top:14px"></progress><div id="status"></div></div><div id="resultCard" class="card hidden"><div class="grid"><label>Tier filter<select id="filter"><option>ALL</option><option>ACTIVE</option><option>OCCASIONAL</option><option>DORMANT</option><option>INACTIVE</option><option>UNKNOWN</option></select></label><button id="download">Download CSV</button></div><div style="overflow:auto"><table id="table"></table></div></div></main><script>
let rows=[],results=[];const $=id=>document.getElementById(id);function parseCSV(text){const lines=text.replace(/\r/g,'').split('\n').filter(Boolean),heads=lines[0].split(',').map(x=>x.trim());return lines.slice(1).map(line=>{const vals=line.match(/("(?:[^"]|"")*"|[^,]*)/g).filter((_,i)=>i%2===0).map(x=>x.replace(/^"|"$/g,'').replace(/""/g,'"'));return Object.fromEntries(heads.map((h,i)=>[h,vals[i]||'']))})}function csv(data){if(!data.length)return '';const h=Object.keys(data[0]),esc=v=>'"'+String(v??'').replaceAll('"','""')+'"';return [h.map(esc),...data.map(r=>h.map(k=>esc(r[k])))].map(r=>r.join(',')).join('\n')}function render(){const f=$('filter').value,shown=results.filter(r=>f==='ALL'||r.activity_tier===f).sort((a,b)=>(a.days_since_last_activity??1e9)-(b.days_since_last_activity??1e9));if(!shown.length)return;$('table').innerHTML='<thead><tr>'+Object.keys(shown[0]).map(k=>'<th>'+k+'</th>').join('')+'</tr></thead><tbody>'+shown.map(r=>'<tr>'+Object.values(r).map(v=>'<td>'+String(v??'')+'</td>').join('')+'</tr>').join('')+'</tbody>'}$('file').onchange=async e=>{rows=parseCSV(await e.target.files[0].text());const ok=rows.filter(r=>r.linkedin_url).length;$('validation').textContent=rows.slice(0,5).map(JSON.stringify).join('\n')+'\n\n'+ok+' rows with URLs';$('estimate').textContent='Estimated maximum cost: $'+(ok*Number($('cost').value)).toFixed(2);$('start').disabled=!ok};$('start').onclick=async()=>{$('start').disabled=true;$('status').textContent='Processing…';$('progress').value=.2;try{const response=await fetch(location.href,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({rows,provider:$('provider').value,concurrency:+$('concurrency').value,max_age_days:+$('age').value,active:+$('active').value,occasional:+$('occasional').value,dormant:+$('dormant').value,cost_per_profile_usd:+$('cost').value,api_key:$('key').value})});const data=await response.json();if(!response.ok)throw Error(data.error);results=data.results;$('progress').value=1;$('status').textContent='Completed '+results.length+' profiles; skipped '+data.skipped.length;$('resultCard').classList.remove('hidden');render()}catch(e){$('status').textContent=e.message}finally{$('start').disabled=false}};$('filter').onchange=render;$('download').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv(results)],{type:'text/csv'}));a.download='activity.csv';a.click()};
</script></body></html>`;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (request.method === "GET") return new Response(html, { headers: { ...cors, "content-type": "text/html; charset=utf-8" } });
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers: cors });
  try { return Response.json(await processRequest(await request.json()), { headers: cors }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400, headers: cors }); }
});

