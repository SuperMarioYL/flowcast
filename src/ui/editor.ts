/**
 * ui/editor — the local, zero-dependency asset editor (m2).
 *
 * `flowcast edit ./login.flow.json` starts a tiny localhost HTTP server, opens
 * a single static page, and lets the user:
 *   - rename the asset,
 *   - turn a hard-coded step value into a `{{param}}` reference,
 *   - declare params (key / default / required / description),
 *   - delete redundant steps,
 * then Save writes the edited asset straight back to the same `.flow.json`.
 *
 * No framework, no bundler: the page is one inlined HTML/JS string served from
 * Node, talking to two JSON endpoints (`GET /api/asset`, `POST /api/asset`).
 * The server validates every save through the same Zod schema replay uses, so
 * the editor can never persist a malformed asset.
 */
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";

import {
  parseFlowAsset,
  readFlowAsset,
  writeFlowAsset,
  type FlowAsset,
} from "../asset.js";

export interface EditOptions {
  /** Port to bind (0 = pick a free one). */
  port?: number;
  /** Host to bind (default 127.0.0.1 — local only). */
  host?: string;
  /** Try to open the system browser at the editor URL (default true). */
  open?: boolean;
  /** Sink for progress lines. */
  log?: (line: string) => void;
}

export interface EditHandle {
  url: string;
  server: Server;
  /** Resolves when the user clicks "Save & close" (or the server is stopped). */
  done: Promise<void>;
  stop: () => void;
}

/** Best-effort open of the default browser; silent if it fails. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* ignore — user can open the URL manually */
  }
}

/**
 * Start the editor server for an on-disk asset. Returns a handle whose `done`
 * promise resolves after the user saves & closes from the UI.
 */
export async function startEditor(
  assetPath: string,
  opts: EditOptions = {},
): Promise<EditHandle> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const host = opts.host ?? "127.0.0.1";

  // Validate up front so we fail fast on a bad asset.
  let current: FlowAsset = await readFlowAsset(assetPath);

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const html = editorHtml();

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    try {
      if (req.method === "GET" && (url === "/" || url.startsWith("/?"))) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.method === "GET" && url === "/api/asset") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ path: assetPath, asset: current }));
        return;
      }
      if (req.method === "POST" && url === "/api/asset") {
        const body = await readBody(req);
        const incoming = parseFlowAsset(JSON.parse(body));
        await writeFlowAsset(assetPath, incoming);
        current = incoming;
        log(`Saved ${incoming.steps.length} step(s) to ${assetPath}.`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.method === "POST" && url === "/api/close") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => stop(), 50);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    }
  });

  await new Promise<void>((resolve) =>
    server.listen(opts.port ?? 0, host, resolve),
  );
  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : (opts.port ?? 0);
  const editorUrl = `http://${host}:${port}/`;

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.close(() => {});
    resolveDone();
  };

  if (opts.open ?? true) openBrowser(editorUrl);
  log(`Editor running at ${editorUrl} — parameterize your steps, then Save & close.`);

  return { url: editorUrl, server, done, stop };
}

function readBody(
  req: import("node:http").IncomingMessage,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The full single-page editor, returned as one HTML string. Plain DOM + fetch,
 * no build step. House-style palette (Apple-clean, light/dark aware).
 */
export function editorHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FlowCast — edit asset</title>
<style>
  :root {
    --bg: #f5f5f7; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7;
    --card: #ffffff; --accent: #5e5ce6; --accent2: #0071e3; --ok: #10a37f;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1d1d1f; --fg:#f5f5f7; --muted:#a1a1a8; --line:#3a3a44;
            --card:#2a2a2e; --accent:#8985ff; --accent2:#4da3ff; --ok:#2dc79a; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; }
  header { padding:18px 24px; border-bottom:1px solid var(--line);
    display:flex; align-items:center; gap:12px; position:sticky; top:0; background:var(--bg); }
  header h1 { font-size:18px; margin:0; font-weight:600; }
  header .dot { width:10px; height:10px; border-radius:50%; background:var(--accent); }
  main { max-width:900px; margin:0 auto; padding:24px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px;
    padding:16px 18px; margin-bottom:16px; }
  h2 { font-size:14px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted);
    margin:0 0 12px; }
  label { display:block; font-size:12px; color:var(--muted); margin:8px 0 4px; }
  input, textarea, select { width:100%; padding:8px 10px; border:1px solid var(--line);
    border-radius:8px; background:var(--bg); color:var(--fg); font:inherit; font-size:13px; }
  .step { border:1px solid var(--line); border-radius:12px; padding:12px; margin-bottom:10px; }
  .step .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .badge { font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px;
    background:color-mix(in srgb, var(--accent) 16%, transparent); color:var(--accent); }
  .grow { flex:1 1 200px; }
  .btn { border:0; border-radius:8px; padding:8px 14px; font:inherit; font-size:13px;
    font-weight:600; cursor:pointer; }
  .btn.primary { background:var(--accent2); color:#fff; }
  .btn.ok { background:var(--ok); color:#fff; }
  .btn.ghost { background:transparent; color:var(--muted); border:1px solid var(--line); }
  .btn.danger { background:transparent; color:#d33; border:1px solid var(--line); }
  .toolbar { display:flex; gap:10px; align-items:center; }
  .params .prow { display:grid; grid-template-columns:1fr 1fr auto 1.4fr auto; gap:8px;
    align-items:center; margin-bottom:8px; }
  .hint { font-size:12px; color:var(--muted); margin-top:6px; }
  .pill { font-size:11px; color:var(--accent); background:color-mix(in srgb,var(--accent) 12%,transparent);
    padding:1px 6px; border-radius:6px; cursor:pointer; }
  #status { font-size:12px; color:var(--muted); margin-left:auto; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
</style>
</head>
<body>
<header>
  <span class="dot"></span>
  <h1>FlowCast · <span id="assetName">asset</span></h1>
  <span id="status"></span>
</header>
<main>
  <div class="card">
    <h2>Asset</h2>
    <label>Name</label>
    <input id="name" />
    <label>Description</label>
    <textarea id="description" rows="2"></textarea>
  </div>

  <div class="card params">
    <h2>Parameters</h2>
    <div id="paramList"></div>
    <button class="btn ghost" id="addParam" type="button">+ Add parameter</button>
    <p class="hint">Reference a parameter from any step value as <code>{{key}}</code>.</p>
  </div>

  <div class="card">
    <h2>Steps</h2>
    <div id="stepList"></div>
  </div>

  <div class="toolbar">
    <button class="btn ok" id="save" type="button">Save</button>
    <button class="btn primary" id="saveClose" type="button">Save &amp; close</button>
    <button class="btn ghost" id="reload" type="button">Reload from disk</button>
  </div>
</main>
<script>
let asset = { version:"1", name:"", params:[], steps:[] };
let assetPath = "";

const $ = (id) => document.getElementById(id);
function setStatus(msg, kind) {
  const s = $("status"); s.textContent = msg || "";
  s.style.color = kind === "err" ? "#d33" : kind === "ok" ? "var(--ok)" : "var(--muted)";
}

async function load() {
  const r = await fetch("/api/asset");
  const data = await r.json();
  asset = data.asset; assetPath = data.path;
  render();
  setStatus("Loaded " + assetPath);
}

function render() {
  $("assetName").textContent = asset.name || "asset";
  $("name").value = asset.name || "";
  $("description").value = asset.description || "";
  renderParams();
  renderSteps();
}

function renderParams() {
  const wrap = $("paramList"); wrap.innerHTML = "";
  (asset.params || []).forEach((p, i) => {
    const row = document.createElement("div"); row.className = "prow";
    row.innerHTML =
      '<input placeholder="key" value="'+esc(p.key||"")+'" data-k="key">' +
      '<input placeholder="default" value="'+esc(p.default||"")+'" data-k="default">' +
      '<label style="margin:0;display:flex;gap:4px;align-items:center;font-size:12px">' +
        '<input type="checkbox" style="width:auto" '+(p.required?"checked":"")+' data-k="required">req</label>' +
      '<input placeholder="description" value="'+esc(p.description||"")+'" data-k="description">' +
      '<button class="btn danger" type="button">✕</button>';
    row.querySelectorAll("input[data-k]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const k = inp.getAttribute("data-k");
        asset.params[i][k] = inp.type === "checkbox" ? inp.checked : inp.value;
      });
    });
    row.querySelector(".danger").addEventListener("click", () => {
      asset.params.splice(i, 1); renderParams();
    });
    wrap.appendChild(row);
  });
}

function renderSteps() {
  const wrap = $("stepList"); wrap.innerHTML = "";
  asset.steps.forEach((s, i) => {
    const el = document.createElement("div"); el.className = "step";
    const tgt = s.target ? (s.target.css || s.target.role || s.target.text || "") : (s.url || "");
    let valueField = "";
    if (s.action === "fill" || s.action === "select") {
      valueField =
        '<div class="grow"><label>value</label>' +
        '<input data-f="value" value="'+esc(s.value||"")+'">' +
        '<span class="pill" data-param="'+i+'">→ parameterize</span></div>';
    }
    el.innerHTML =
      '<div class="row">' +
        '<span class="badge">'+esc(s.action)+'</span>' +
        '<div class="grow"><label>'+esc(s.id)+' · '+esc(s.label||"")+'</label>' +
          '<input value="'+esc(tgt)+'" disabled></div>' +
        valueField +
        '<button class="btn danger" type="button" data-del="'+i+'">delete step</button>' +
      '</div>';
    const valInput = el.querySelector('input[data-f="value"]');
    if (valInput) valInput.addEventListener("input", () => { asset.steps[i].value = valInput.value; });
    const pill = el.querySelector('[data-param]');
    if (pill) pill.addEventListener("click", () => parameterize(i));
    el.querySelector('[data-del]').addEventListener("click", () => {
      asset.steps.splice(i, 1); renderSteps();
    });
    wrap.appendChild(el);
  });
}

// Turn a hard-coded step value into a {{param}} ref, auto-declaring the param.
function parameterize(i) {
  const step = asset.steps[i];
  const suggested = (step.label || step.action || "param").replace(/[^A-Za-z0-9_]/g,"_").replace(/^([0-9])/,"_$1") || "param";
  const key = prompt("Parameter key for this value:", suggested);
  if (!key) return;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { setStatus("Invalid key: "+key, "err"); return; }
  if (!asset.params.some((p) => p.key === key)) {
    asset.params.push({ key, default: step.value || "", required: true, description: "" });
  }
  step.value = "{{" + key + "}}";
  renderParams(); renderSteps();
}

function collect() {
  asset.name = $("name").value.trim();
  asset.description = $("description").value.trim() || undefined;
  asset.params = (asset.params || []).filter((p) => p.key)
    .map((p) => ({ key:p.key, default:p.default||undefined, required:!!p.required,
                   description:p.description||undefined }));
  return asset;
}

async function save() {
  const body = JSON.stringify(collect());
  const r = await fetch("/api/asset", { method:"POST", headers:{"content-type":"application/json"}, body });
  const data = await r.json();
  if (data.ok) { setStatus("Saved ✓", "ok"); render(); return true; }
  setStatus("Save failed: " + (data.error||""), "err"); return false;
}

function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

$("addParam").addEventListener("click", () => {
  asset.params = asset.params || [];
  asset.params.push({ key:"", default:"", required:false, description:"" });
  renderParams();
});
$("save").addEventListener("click", save);
$("reload").addEventListener("click", load);
$("saveClose").addEventListener("click", async () => {
  if (await save()) { await fetch("/api/close", { method:"POST" }); setStatus("Saved — you can close this tab."); }
});
load();
</script>
</body>
</html>`;
}
