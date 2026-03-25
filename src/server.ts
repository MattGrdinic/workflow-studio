import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { NODE_DEFINITIONS } from './definitions.js';
import { executeWorkflowGraph, forceStopActiveExecutor, handleChatMessage, setWorkflowDebug } from './runtime.js';
import { getStudioTemplates } from './templates.js';
import type { NodeValue, WorkflowGraph, WorkflowProgressEvent } from './types.js';

// ============================================
// Console output helpers (replaces @claude-flow/cli output module)
// ============================================
const output = {
  printInfo: (msg: string) => console.log(`\x1b[36m${msg}\x1b[0m`),
  printSuccess: (msg: string) => console.log(`\x1b[32m${msg}\x1b[0m`),
  printError: (msg: string) => console.error(`\x1b[31m${msg}\x1b[0m`),
  printWarning: (msg: string) => console.warn(`\x1b[33m${msg}\x1b[0m`),
  writeln: (msg: string) => console.log(msg),
  printJson: (data: unknown) => console.log(JSON.stringify(data, null, 2)),
};

let activeAbortController: AbortController | null = null;

interface StudioRunPayload {
  graph: WorkflowGraph;
  variables?: Record<string, NodeValue>;
}

interface StudioSavePayload {
  path: string;
  graph: WorkflowGraph;
}

interface StudioReadOutputPayload {
  path: string;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        resolvePromise(raw ? JSON.parse(raw) : {});
      } catch (error) {
        rejectPromise(error);
      }
    });
    req.on('error', rejectPromise);
  });
}

const WS_BASE = 'data';

function getWorkflowRoot(cwd: string): string {
  // Prefer new path, fall back to legacy
  const newPath = resolve(cwd, `${WS_BASE}/workflows`);
  const legacyPath = resolve(cwd, 'Jira/workflows');
  if (existsSync(newPath)) return newPath;
  if (existsSync(legacyPath)) return legacyPath;
  return newPath; // default to new for fresh installs
}

function resolveJiraConfigPath(cwd: string): string {
  const newPath = resolve(cwd, `${WS_BASE}/Jira/config/jira.env`);
  const legacyPath = resolve(cwd, 'Jira/config/jira.env');
  if (existsSync(newPath)) return `${WS_BASE}/Jira/config/jira.env`;
  if (existsSync(legacyPath)) return 'Jira/config/jira.env';
  return `${WS_BASE}/Jira/config/jira.env`;
}

function resolveSlackConfigPath(cwd: string): string {
  return `${WS_BASE}/Slack/config/slack.env`;
}

function resolveAdoConfigPath(cwd: string): string {
  return `${WS_BASE}/ADO/config/ado.env`;
}


/* ── Config encryption (AES-256-GCM) ──────────────────────────── */

const ENC_PREFIX = 'ENC:';
const SENSITIVE_KEYS = new Set([
  'JIRA_API_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_WEBHOOK_URL',
  'AZURE_DEVOPS_PAT',
]);

function getOrCreateKeyfile(cwd: string): Buffer {
  const keyDir = resolve(cwd, WS_BASE);
  const keyPath = join(keyDir, '.keyfile');
  if (existsSync(keyPath)) {
    return Buffer.from(readFileSync(keyPath, 'utf-8').trim(), 'hex');
  }
  if (!existsSync(keyDir)) mkdirSync(keyDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600 });
  return key;
}

function encryptValue(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptValue(stored: string, key: Buffer): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const raw = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function parseEnvFile(raw: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const k = trimmed.slice(0, eqIdx).trim();
    let v = trimmed.slice(eqIdx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    entries[k] = v;
  }
  return entries;
}

function readConfigDecrypted(absolute: string, cwd: string): Record<string, string> {
  const raw = readFileSync(absolute, 'utf-8');
  const entries = parseEnvFile(raw);
  const key = getOrCreateKeyfile(cwd);
  for (const k of Object.keys(entries)) {
    if (entries[k].startsWith(ENC_PREFIX)) {
      try { entries[k] = decryptValue(entries[k], key); } catch { entries[k] = ''; }
    }
  }
  return entries;
}

function writeConfigEncrypted(absolute: string, cwd: string, values: Record<string, string>, orderedKeys: string[]): void {
  const dir = dirname(absolute);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const key = getOrCreateKeyfile(cwd);
  const lines: string[] = [];
  for (const k of orderedKeys) {
    if (k in values) {
      const v = SENSITIVE_KEYS.has(k) && values[k] ? encryptValue(values[k], key) : values[k];
      lines.push(`${k}=${v}`);
    }
  }
  for (const [k, val] of Object.entries(values)) {
    if (!orderedKeys.includes(k)) {
      const v = SENSITIVE_KEYS.has(k) && val ? encryptValue(val, key) : val;
      lines.push(`${k}=${v}`);
    }
  }
  writeFileSync(absolute, lines.join('\n') + '\n', 'utf-8');
}

function ensureWorkflowRoot(cwd: string): string {
  const root = getWorkflowRoot(cwd);
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  return root;
}

function resolveWorkflowFilePath(cwd: string, requestedPath: string): string {
  const root = ensureWorkflowRoot(cwd);
  const normalizedRequest = requestedPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const safeRelative = normalizedRequest.endsWith('.json') ? normalizedRequest : `${normalizedRequest}.json`;
  const absolute = resolve(root, safeRelative);

  if (!absolute.startsWith(root)) {
    throw new Error('Invalid workflow path.');
  }

  return absolute;
}

function listWorkflowFiles(cwd: string): Array<{ path: string; name: string }> {
  const root = ensureWorkflowRoot(cwd);
  const files: Array<{ path: string; name: string }> = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.toLowerCase().endsWith('.json')) continue;
      files.push({
        path: relative(root, full).replace(/\\/g, '/'),
        name: entry.replace(/\.json$/i, ''),
      });
    }
  };

  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function findProjectRoot(startDir: string): string {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'data'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return startDir; // reached filesystem root, fall back
    dir = parent;
  }
}

function assertPathWithinRoot(absolutePath: string, root: string): void {
  const normalizedRoot = root.endsWith('/') ? root : `${root}/`;
  if (!(absolutePath === root || absolutePath.startsWith(normalizedRoot))) {
    throw new Error('Path is outside workspace root.');
  }
}

function resolveWorkspaceFilePath(cwd: string, requestedPath: string): string {
  const normalizedRequest = requestedPath.replace(/\\/g, '/').trim();
  if (!normalizedRequest) {
    throw new Error('Missing file path.');
  }

  const absolute = resolve(cwd, normalizedRequest);
  const workspaceRoot = resolve(cwd);
  assertPathWithinRoot(absolute, workspaceRoot);
  return absolute;
}

function buildStudioHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Claude Flow Workflow Studio</title>
  <style>
    :root { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    html, body { height: 100%; }
    body { margin: 0; background: #0f1117; color: #e8eaf0; overflow: hidden; }
    * { scrollbar-width: thin; scrollbar-color: #3a4257 #0f1117; }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: #0f1117; border-radius: 4px; }
    ::-webkit-scrollbar-thumb { background: #3a4257; border-radius: 4px; border: 2px solid #0f1117; }
    ::-webkit-scrollbar-thumb:hover { background: #4f5a73; }
    ::-webkit-scrollbar-corner { background: #0f1117; }
    .layout { display: grid; grid-template-columns: 300px 1fr 360px; height: 100vh; }
    .panel { border-right: 1px solid #272b36; padding: 12px; display: flex; flex-direction: column; overflow: hidden; }
    .panel-right { border-left: 1px solid #272b36; padding: 12px; overflow-y: auto; }
    .main { display: grid; grid-template-rows: auto auto auto auto; grid-auto-rows: auto; align-content: start; gap: 10px; padding: 12px; overflow-y: auto; min-height: 0; }
    .card { background: #151925; border: 1px solid #272b36; border-radius: 8px; padding: 10px; }
    h1, h2, h3 { margin: 0 0 8px; }
    button { background: #4f7cff; color: white; border: 0; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
    button.secondary { background: #2f3442; }
    button.danger { background: #8f2d3a; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    input, select, textarea { width: 100%; background: #0f1117; color: #e8eaf0; border: 1px solid #343a4d; border-radius: 6px; padding: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    textarea { min-height: 140px; resize: vertical; }
    .panel-right textarea { min-height: 160px; }
    .toolbar { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 8px; }
    .toolbar-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .muted { color: #a6adbd; font-size: 12px; }
    .field-label-row { display: flex; align-items: center; gap: 5px; margin-top: 8px; }
    .hint-wrap { position: relative; display: inline-flex; align-items: center; }
    .hint-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; background: #2a3144; color: #8f98af; font-size: 11px; font-weight: 700; cursor: help; flex-shrink: 0; line-height: 1; transition: background 0.15s, color 0.15s; }
    .hint-icon:hover { background: #4f7cff; color: #fff; }
    .hint-tooltip { display: none; position: fixed; width: 280px; background: #1e2436; color: #d0d5e2; border: 1px solid #3a4257; border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.5; box-shadow: 0 8px 24px rgba(0,0,0,0.5); z-index: 10000; pointer-events: none; }
    .hint-tooltip::after { content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%); border: 6px solid transparent; border-top-color: #3a4257; }
    #result details > summary, #varsFormWrap details > summary { list-style: none; }
    #result details > summary::-webkit-details-marker, #varsFormWrap details > summary::-webkit-details-marker { display: none; }
    #result details > summary::before, #varsFormWrap details > summary::before { content: '\\25B6'; font-size: 9px; margin-right: 4px; transition: transform 0.15s; display: inline-block; }
    #result details[open] > summary::before, #varsFormWrap details[open] > summary::before { transform: rotate(90deg); }
    #edgesDetails > summary::-webkit-details-marker { display: none; }
    #edgesDetails[open] .edge-toggle-arrow { transform: rotate(90deg); }
    #nodeDefs details > summary::-webkit-details-marker { display: none; }
    #nodeDefs details > summary { list-style: none; }
    #nodeDefs details[open] > summary .cat-toggle-arrow { transform: rotate(90deg); }
    .prompt-picker-list { list-style:none; padding:0; margin:0; }
    .prompt-picker-list li { padding:10px 14px; border-bottom:1px solid #272b36; cursor:pointer; transition:background 0.12s; }
    .prompt-picker-list li:hover { background:#1e2436; }
    .prompt-picker-list li.selected { background:#2a3556; border-left:3px solid #4f7cff; }
    .prompt-picker-title { font-size:13px; color:#e8eaf0; font-weight:600; }
    .prompt-picker-desc { font-size:11px; color:#8f98af; margin-top:2px; line-height:1.4; }
    .prompt-picker-cat-header { font-size:11px; color:#69a0ff; text-transform:uppercase; letter-spacing:0.5px; padding:8px 14px 4px; background:#0f1117; font-weight:700; position:sticky; top:0; }
    .prompt-picker-preview { background:#0f1117; border:1px solid #343a4d; border-radius:6px; padding:12px; font-size:12px; color:#c5cad6; white-space:pre-wrap; line-height:1.5; overflow-y:auto; max-height:100%; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; }
    .prompt-picker-search { width:100%; background:#0f1117; color:#e8eaf0; border:1px solid #343a4d; border-radius:6px; padding:8px 12px; font-size:13px; font-family:inherit; box-sizing:border-box; }
    .prompt-picker-search::placeholder { color:#6f7a92; }
    .output-tab { padding: 6px 14px; font-size: 12px; border: none; border-radius: 6px 6px 0 0; cursor: pointer; transition: background 0.15s, color 0.15s; }
    .output-tab.active { background: #1b2540; color: #69a0ff; }
    .output-tab:not(.active) { background: transparent; color: #8f98af; }
    .output-tab:hover:not(.active) { background: #1a1f2e; }
    .canvas-wrap { position: relative; height: 560px; border: 1px solid #2a3144; border-radius: 8px; background: #0c1019; overflow: auto; }
    .canvas { position: relative; width: 2200px; height: 1400px; transform-origin: 0 0; }
    .zoom-controls { position: absolute; bottom: 10px; right: 10px; z-index: 10; display: flex; gap: 4px; align-items: center; background: #1b2131; border: 1px solid #3a4257; border-radius: 6px; padding: 4px 6px; }
    .zoom-controls button { padding: 4px 8px; font-size: 14px; min-width: 28px; background: #2f3442; border-radius: 4px; }
    .zoom-controls button:hover { background: #3a4257; }
    .zoom-controls .zoom-label { font-size: 11px; color: #8f98af; min-width: 36px; text-align: center; user-select: none; }
    svg.edges { position: absolute; inset: 0; pointer-events: none; }
    svg.edges > * { pointer-events: none; }
    svg.edges > .edge-hitbox { pointer-events: stroke; }
    .node { position: absolute; width: 220px; border: 1px solid #3a4257; background: #1b2131; border-radius: 8px; padding: 8px; cursor: move; box-shadow: 0 4px 14px rgba(0,0,0,0.35); }
    .node.selected { border-color: #69a0ff; }
    .node.running { border-color: #4f7cff; box-shadow: 0 0 12px rgba(79,124,255,0.4); animation: pulse 1.5s ease-in-out infinite; }
    .node.completed { border-color: #3ddc84; }
    .node.errored { border-color: #ff4444; box-shadow: 0 0 8px rgba(255,68,68,0.3); }
    .node.warning { border-color: #ff9800; box-shadow: 0 0 8px rgba(255,152,0,0.3); }
    .node.skipped { border-color: #666; opacity: 0.6; }
    @keyframes pulse { 0%, 100% { box-shadow: 0 0 8px rgba(79,124,255,0.3); } 50% { box-shadow: 0 0 18px rgba(79,124,255,0.6); } }
    .node .title { font-weight: 600; font-size: 13px; }
    .node .type { font-size: 11px; color: #b4bdd2; margin-top: 4px; }
    .node .id { font-size: 11px; color: #8f98af; margin-top: 3px; }
    .node .status-badge { font-size: 10px; margin-top: 4px; padding: 2px 6px; border-radius: 4px; display: inline-block; }
    .node .status-badge.running { background: #1a2a5c; color: #7da8ff; }
    .node .status-badge.completed { background: #1a3d2a; color: #3ddc84; }
    .node .status-badge.errored { background: #3d1a1a; color: #ff6666; }
    .node .status-badge.warning { background: #3d2e1a; color: #ffb74d; }
    .node .refs-badge { font-size: 10px; color: #8f98af; margin-top: 3px; }
    .node .io-section { margin-top: 5px; padding-top: 4px; border-top: 1px solid #2a3144; }
    .node .io-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: #6f7a92; margin-bottom: 2px; }
    .node .io-fields { display: flex; flex-wrap: wrap; gap: 3px; }
    .node .io-tag { font-size: 9px; padding: 1px 5px; border-radius: 3px; }
    .node .io-tag.input { background: #1a2540; color: #6f96d6; }
    .node .io-tag.output { background: #1a3520; color: #5fc47a; }
    .port { position: absolute; width: 12px; height: 12px; border-radius: 50%; background: #3a4257; border: 2px solid #5a6580; cursor: crosshair; z-index: 2; transition: background 0.15s, border-color 0.15s, transform 0.15s; }
    .port:hover { background: #4f7cff; border-color: #69a0ff; transform: scale(1.3); }
    .port-in { left: -7px; top: 28px; }
    .port-out { right: -7px; top: 28px; }
    .port.active { background: #4f7cff; border-color: #69a0ff; }
    .port.drop-target { background: #3ddc84; border-color: #5fefaa; transform: scale(1.4); }
    .temp-edge { pointer-events: none; }
    .edge-hitbox { stroke: transparent; stroke-width: 16; fill: none; cursor: pointer; pointer-events: stroke; }
    .edge-delete-btn { position: absolute; width: 20px; height: 20px; border-radius: 50%; background: #8f2d3a; color: #fff; font-size: 12px; line-height: 20px; text-align: center; cursor: pointer; display: none; z-index: 10; pointer-events: auto; box-shadow: 0 2px 6px rgba(0,0,0,0.4); }
    .edge-delete-btn:hover { background: #c0394d; }
    .autocomplete-popup { position: absolute; z-index: 100; background: #1b2131; border: 1px solid #4f7cff; border-radius: 6px; max-height: 200px; overflow-y: auto; box-shadow: 0 6px 20px rgba(0,0,0,0.5); min-width: 240px; }
    .autocomplete-item { padding: 6px 10px; cursor: pointer; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; display: flex; justify-content: space-between; gap: 8px; }
    .autocomplete-item:hover, .autocomplete-item.active { background: #2a3556; }
    .autocomplete-item .ref-key { color: #69a0ff; }
    .autocomplete-item .ref-type { color: #8f98af; font-size: 11px; }
    .autocomplete-item .ref-desc { color: #6f7a92; font-size: 10px; display: block; }
    .preflight-item { padding: 8px 12px; border-radius: 6px; margin-bottom: 6px; font-size: 12px; line-height: 1.5; }
    .preflight-item.info { background: #1a2540; border-left: 3px solid #4f7cff; }
    .preflight-item.warn { background: #3d2e1a; border-left: 3px solid #ff9800; }
    .preflight-item.ok { background: #1a3520; border-left: 3px solid #3ddc84; }
    .preflight-node { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; margin-bottom: 4px; background: #151925; }
    .preflight-node .pf-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .preflight-node .pf-label { font-size: 12px; color: #e8eaf0; flex: 1; }
    .preflight-node .pf-type { font-size: 11px; color: #8f98af; }
    .preflight-flag { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; margin-left: 6px; }
    .preflight-flag.flag-warn { background: #3d2e1a; color: #ffb74d; }
    .preflight-flag.flag-info { background: #1a2540; color: #69a0ff; }
    .list-btn { width: 100%; text-align: left; margin-bottom: 6px; }
    .edge-list { max-height: 160px; overflow: auto; border: 1px solid #2a3144; border-radius: 6px; padding: 6px; }
    .edge-item { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center; margin-bottom: 4px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #0f1117; border: 1px solid #2a3144; border-radius: 6px; padding: 10px; max-height: 220px; overflow: auto; }
  </style>
</head>
<body>
  <div class="layout">
    <aside class="panel">
      <div style="display:flex;gap:0;border-bottom:1px solid #272b36;margin-bottom:10px;">
        <button id="panelTabNodes" class="output-tab active" data-panel-tab="nodes" style="font-size:12px;">Nodes</button>
        <button id="panelTabTemplates" class="output-tab" data-panel-tab="templates" style="font-size:12px;">Templates</button>
        <button id="panelTabSaved" class="output-tab" data-panel-tab="saved" style="font-size:12px;">Saved</button>
      </div>
      <div id="panelNodes" style="flex:1;overflow-y:auto;min-height:0;">
        <input id="nodeSearch" type="text" placeholder="Search nodes..." style="margin-bottom:8px;padding:6px 10px;font-size:12px;background:#0c1019;border:1px solid #343a4d;border-radius:6px;width:100%;box-sizing:border-box;color:#e8eaf0;" />
        <div id="nodeDefs" class="card"></div>
      </div>
      <div id="panelTemplates" style="display:none;flex:1;overflow-y:auto;min-height:0;">
        <div id="templates" class="card"></div>
      </div>
      <div id="panelSaved" style="display:none;flex:1;overflow-y:auto;min-height:0;">
        <div id="savedWorkflows" class="card"></div>
      </div>
    </aside>
    <main class="main">
      <div>
        <h1>Workflow Studio</h1>
        <div class="muted">Drag nodes, wire edges explicitly, then save/load and run.</div>
      </div>

      <div class="toolbar">
        <button id="runBtn">Run Workflow</button>
        <button id="stopBtn" class="danger" style="display:none;">Stop</button>
        <button id="saveBtn" class="secondary">Save Workflow</button>
        <button id="reloadBtn" class="secondary">Refresh Saved List</button>
      </div>

      <div class="canvas-wrap card">
        <div id="canvas" class="canvas">
          <svg id="edges" class="edges"></svg>
        </div>
        <div class="zoom-controls">
          <button id="zoomOutBtn" title="Zoom out">−</button>
          <span id="zoomLabel" class="zoom-label">100%</span>
          <button id="zoomInBtn" title="Zoom in">+</button>
          <button id="zoomFitBtn" title="Fit to view" style="font-size:11px;padding:4px 6px;">Fit</button>
          <button id="zoomResetBtn" title="Reset zoom" style="font-size:11px;padding:4px 6px;">1:1</button>
        </div>
      </div>
      <div class="muted" style="display:flex;justify-content:space-between;align-items:center;">
        <span>Tip: drag nodes to move, drag canvas to pan, drag near edges to auto-scroll.</span>
        <span style="color:#6b7394;font-size:11px;"><kbd style="background:#1a1f2e;padding:1px 4px;border-radius:3px;border:1px solid #343a4d;font-size:10px;">Ctrl+K</kbd> Search nodes &nbsp; <kbd style="background:#1a1f2e;padding:1px 4px;border-radius:3px;border:1px solid #343a4d;font-size:10px;">Del</kbd> Delete selected</span>
      </div>

      <div class="card">
        <div style="display:flex;align-items:center;gap:0;border-bottom:1px solid #272b36;margin-bottom:8px;">
          <button id="outputTabBtn" class="output-tab active" data-tab="output">Workflow Output</button>
          <button id="resultTabBtn" class="output-tab" data-tab="result">Execution Results</button>
        </div>

        <div id="outputTabPanel">
          <div id="outputMeta" class="muted">No output loaded yet.</div>
          <div class="toolbar-2" style="margin-top:8px;">
            <button id="previewBtn" class="secondary">Preview</button>
            <button id="rawBtn" class="secondary">Raw</button>
          </div>
          <div id="outputPreview" style="margin-top:8px; padding:10px; border:1px solid #2a3144; border-radius:6px; background:#0f1117; max-height:360px; overflow:auto;"></div>
          <pre id="outputRaw" style="display:none; margin-top:8px;"></pre>
        </div>

        <div id="resultTabPanel" style="display:none;">
          <pre id="result">No run yet.</pre>
        </div>
      </div>
    </main>

    <aside class="panel-right">
      <h2>Inspector</h2>
      <div class="card" style="margin-bottom:10px;">
        <h3>Workflow</h3>
        <input id="workflowName" placeholder="Workflow name" />
        <input id="workflowPath" placeholder="jira-plan-phase2.json" style="margin-top:8px;" />
      </div>

      <div class="card" style="margin-bottom:10px;">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <h3 style="margin:0;">Variables</h3>
          <div style="display:flex;gap:6px;">
            <button id="jiraConfigBtn" class="secondary" style="padding:2px 8px;font-size:11px;background:#2a3556;color:#69a0ff;">Jira</button>
            <button id="adoConfigBtn" class="secondary" style="padding:2px 8px;font-size:11px;background:#1a2d4d;color:#4a9eff;">ADO</button>
            <button id="slackConfigBtn" class="secondary" style="padding:2px 8px;font-size:11px;background:#3d1f2a;color:#e01e5a;">Slack</button>
            <button id="varsToggleBtn" class="secondary" style="padding:2px 8px;font-size:11px;">JSON</button>
          </div>
        </div>
        <div id="varsFormWrap" style="margin-top:8px;"></div>
        <textarea id="variables" style="display:none;"></textarea>
      </div>

      <div class="card">
        <h3>Selected Node</h3>
        <div id="selectedMeta" class="muted">None selected.</div>
        <div id="selectedNodeUseCase" style="display:none; margin-top:6px; padding:6px 8px; background:#1a1f2e; border-radius:6px; border-left:3px solid #a78bfa;"></div>
        <div class="toolbar-2" style="margin-top:8px;">
          <button id="nodeFormTab">Form</button>
          <button id="nodeJsonTab" class="secondary">JSON</button>
        </div>
        <div id="nodeForm" style="margin-top:8px;"></div>
        <textarea id="nodeConfig" style="margin-top:8px; display:none;"></textarea>
        <div id="nodeConfigError" class="muted" style="display:none; margin-top:6px;"></div>
        <div class="toolbar-2" style="margin-top:8px;">
          <button id="applyNodeBtn" class="secondary" style="display:none;" title="Parse the JSON textarea and apply it to this node's config. Only needed when editing via the JSON tab.">Apply JSON</button>
          <button id="deleteNodeBtn" class="danger">Delete Node</button>
        </div>

        <details id="edgesDetails" style="margin-top:10px; border-top:1px solid #272b36; padding-top:8px;">
          <summary style="cursor:pointer;font-size:12px;font-weight:600;color:#8f98af;padding:4px 0;user-select:none;list-style:none;display:flex;align-items:center;gap:4px;">
            <span class="edge-toggle-arrow" style="font-size:9px;transition:transform 0.15s;display:inline-block;">&#9654;</span>
            Edges <span id="edgeCount" style="color:#6b7394;font-size:11px;margin-left:4px;"></span>
          </summary>
          <div style="padding-top:6px;">
            <div class="muted" style="margin-bottom:6px;">Drag from output port (right) to input port (left) to connect. Hover a wire to delete.</div>
            <div id="edgeList" class="edge-list"></div>
          </div>
        </details>
      </div>
    </aside>
  </div>

  <!-- Interactive Chat Modal -->
  <div id="chatModal" style="display:none; position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.7); align-items:center; justify-content:center;">
    <div style="width:700px; max-width:90vw; max-height:85vh; background:#151925; border:1px solid #3a4257; border-radius:12px; display:flex; flex-direction:column; box-shadow:0 16px 48px rgba(0,0,0,0.6);">
      <div style="padding:16px 20px; border-bottom:1px solid #272b36; display:flex; justify-content:space-between; align-items:center;">
        <div style="display:flex; align-items:center; gap:10px;">
          <h3 style="margin:0; color:#e8eaf0; font-size:15px;">Review & Refine</h3>
          <span id="chatPhaseLabel" style="font-size:11px; padding:2px 8px; border-radius:10px; background:#2a3556; color:#69a0ff;">Reviewing</span>
        </div>
        <span id="chatNodeLabel" style="color:#8f98af; font-size:12px;"></span>
      </div>
      <div id="chatMessages" style="flex:1; overflow-y:auto; padding:16px 20px; min-height:300px; max-height:55vh;"></div>
      <div id="chatTyping" style="display:none; padding:4px 20px; color:#8f98af; font-size:12px; font-style:italic;">AI is thinking...</div>
      <div id="chatActionBanner" style="padding:10px 20px; background:#1a2035; border-top:1px solid #272b36; font-size:12px; color:#8f98af; line-height:1.5;">
        Review the generated content above. You can <strong style="color:#3ddc84;">accept it as-is</strong> and continue the workflow, or <strong style="color:#4f7cff;">chat with AI</strong> below to request changes.
      </div>
      <div style="padding:12px 20px; border-top:1px solid #272b36; display:flex; gap:8px;">
        <input id="chatInput" type="text" placeholder="Ask AI to make changes..." style="flex:1; background:#0f1117; border:1px solid #343a4d; border-radius:6px; color:#e8eaf0; padding:8px 12px; font-size:13px; font-family:inherit;" />
        <button id="chatSendBtn" style="padding:8px 16px; border-radius:6px; border:none; background:#4f7cff; color:#fff; cursor:pointer; font-size:13px; font-weight:600;">Send</button>
        <button id="chatApplyBtn" style="display:none; padding:8px 16px; border-radius:6px; border:none; background:#3ddc84; color:#111; cursor:pointer; font-size:13px; font-weight:600;">Use Refined Content</button>
        <button id="chatRevertBtn" style="display:none; padding:8px 16px; border-radius:6px; border:1px solid #6b7280; background:transparent; color:#8f98af; cursor:pointer; font-size:13px; font-weight:600;">Revert to Original</button>
        <button id="chatAcceptBtn" style="padding:8px 16px; border-radius:6px; border:none; background:#3ddc84; color:#111; cursor:pointer; font-size:13px; font-weight:600;">Accept & Continue</button>
      </div>
    </div>
  </div>

  <!-- Preflight Modal -->
  <div id="preflightModal" style="display:none; position:fixed; inset:0; z-index:9997; background:rgba(0,0,0,0.7); align-items:center; justify-content:center;">
    <div style="width:680px; max-width:90vw; max-height:85vh; background:#151925; border:1px solid #3a4257; border-radius:12px; display:flex; flex-direction:column; box-shadow:0 16px 48px rgba(0,0,0,0.6);">
      <div style="padding:16px 20px; border-bottom:1px solid #272b36; display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0; color:#e8eaf0; font-size:15px;">Preflight Check</h3>
        <button id="preflightClose" style="background:none; border:none; color:#8f98af; font-size:18px; cursor:pointer; padding:0 4px;">&times;</button>
      </div>
      <div id="preflightContent" style="flex:1; overflow-y:auto; padding:16px 20px; min-height:200px; max-height:65vh;"></div>
      <div style="padding:12px 20px; border-top:1px solid #272b36; display:flex; justify-content:flex-end; gap:8px;">
        <button id="preflightCancel" class="secondary" style="padding:8px 16px;">Cancel</button>
        <button id="preflightRun" style="padding:8px 16px; background:#3ddc84; color:#111; font-weight:600;">Run Workflow</button>
      </div>
    </div>
  </div>

  <div id="jiraConfigModal" style="display:none; position:fixed; inset:0; z-index:9998; background:rgba(0,0,0,0.7); align-items:center; justify-content:center;">
    <div style="width:560px; max-width:90vw; background:#151925; border:1px solid #3a4257; border-radius:12px; display:flex; flex-direction:column; box-shadow:0 16px 48px rgba(0,0,0,0.6);">
      <div style="padding:16px 20px; border-bottom:1px solid #272b36; display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0; color:#e8eaf0; font-size:15px;">Jira Configuration</h3>
        <button id="jiraConfigClose" style="background:none; border:none; color:#8f98af; font-size:18px; cursor:pointer; padding:0 4px;">&times;</button>
      </div>
      <div style="padding:20px; overflow-y:auto; max-height:70vh;">
        <div id="jiraConfigError" style="display:none; background:#3d1a1a; border:1px solid #ff4444; border-radius:8px; padding:12px 16px; margin-bottom:14px; color:#ff8888; font-size:13px;"></div>
        <div id="jiraConfigSuccess" style="display:none; background:#1a3d2a; border:1px solid #3ddc84; border-radius:8px; padding:12px 16px; margin-bottom:14px; color:#6fefaa; font-size:13px;"></div>
        <div style="background:#1a1f2e; border-radius:8px; padding:12px 16px; margin-bottom:16px; border-left:3px solid #4f7cff;">
          <div style="font-size:12px; color:#8f98af; line-height:1.6;">
            Enter your Atlassian Jira credentials below. You can generate an API token at:<br/>
            <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" style="color:#69a0ff; text-decoration:underline;">https://id.atlassian.com/manage-profile/security/api-tokens</a>
          </div>
        </div>
        <div style="margin-bottom:12px;">
          <label style="font-size:12px; color:#c5cad6; display:block; margin-bottom:4px;">Base URL</label>
          <input id="jiraCfgBaseUrl" type="text" placeholder="https://yoursite.atlassian.net" style="font-size:13px;" />
        </div>
        <div style="margin-bottom:12px;">
          <label style="font-size:12px; color:#c5cad6; display:block; margin-bottom:4px;">Email</label>
          <input id="jiraCfgEmail" type="email" placeholder="you@company.com" style="font-size:13px;" />
        </div>
        <div style="margin-bottom:12px;">
          <label style="font-size:12px; color:#c5cad6; display:block; margin-bottom:4px;">API Token</label>
          <input id="jiraCfgToken" type="password" placeholder="Paste your Jira API token" style="font-size:13px;" />
          <div style="font-size:11px; color:#6f7a92; margin-top:3px;">Leave blank to keep the existing token unchanged.</div>
        </div>
        <div style="margin-bottom:12px;">
          <label style="font-size:12px; color:#c5cad6; display:block; margin-bottom:4px;">CA Certificate Path <span style="color:#6f7a92;">(optional)</span></label>
          <input id="jiraCfgCaCert" type="text" placeholder="/path/to/ca-cert.pem" style="font-size:13px;" />
        </div>
        <div style="margin-bottom:16px;">
          <label style="font-size:12px; color:#c5cad6; display:block; margin-bottom:4px;">AI Model</label>
          <input id="jiraCfgModel" type="text" placeholder="anthropic.claude-sonnet-4-6" style="font-size:13px;" />
        </div>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button id="jiraTestBtn" class="secondary" style="padding:8px 16px; font-size:13px;">Test Connection</button>
          <button id="jiraSaveBtn" style="padding:8px 16px; font-size:13px;">Save</button>
        </div>
      </div>
    </div>
  </div>

  <div id="adoConfigModal" style="display:none; position:fixed; inset:0; z-index:9998; background:rgba(0,0,0,0.7); align-items:center; justify-content:center;">
    <div style="width:560px; max-width:90vw; background:#151925; border:1px solid #3a4257; border-radius:12px; display:flex; flex-direction:column; box-shadow:0 16px 48px rgba(0,0,0,0.6);">
      <div style="padding:16px 20px; border-bottom:1px solid #272b36; display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0; color:#e8eaf0; font-size:15px;">Azure DevOps Configuration</h3>
        <button id="adoConfigClose" style="background:none; border:none; color:#8f98af; font-size:18px; cursor:pointer; padding:0 4px;">&times;</button>
      </div>
      <div style="padding:20px; overflow-y:auto; max-height:70vh;">
        <div id="adoConfigError" style="display:none; background:#3d1a1a; border:1px solid #ff4444; border-radius:8px; padding:12px 16px; margin-bottom:14px; color:#ff8888; font-size:13px;"></div>
        <div id="adoConfigSuccess" style="display:none; background:#1a3d2a; border:1px solid #3ddc84; border-radius:8px; padding:12px 16px; margin-bottom:14px; color:#6fefaa; font-size:13px;"></div>
        <div style="background:#1a1f2e; border-radius:8px; padding:12px 16px; margin-bottom:16px; border-left:3px solid #4a9eff;">
          <div style="font-size:12px; color:#8f98af; line-height:1.6;">
            Enter your Azure DevOps credentials. Generate a PAT at:<br/>
            <a href="https://dev.azure.com" target="_blank" style="color:#4a9eff; text-decoration:underline;">Azure DevOps</a> &gt; User Settings &gt; Personal Access Tokens<br/>
            <span style="color:#6f7a92;">Scopes: "Code (Read)" for repo context. Add "Code (Read &amp; Write)" and "Pull Request Contribute" for PR creation.</span>
          </div>
        </div>
        <div style="margin-bottom:12px;">
          <label style="font-size:12px; color:#c5cad6; display:block; margin-bottom:4px;">Organization URL</label>
          <input id="adoCfgOrgUrl" type="text" placeholder="https://dev.azure.com/yourorg" style="font-size:13px;" />
        </div>
        <div style="margin-bottom:16px;">
          <label style="font-size:12px; color:#c5cad6; display:block; margin-bottom:4px;">Personal Access Token (PAT)</label>
          <input id="adoCfgPat" type="password" placeholder="Paste your Azure DevOps PAT" style="font-size:13px;" />
          <div style="font-size:11px; color:#6f7a92; margin-top:3px;">Leave blank to keep the existing token unchanged.</div>
        </div>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button id="adoTestBtn" class="secondary" style="padding:8px 16px; font-size:13px;">Test Connection</button>
          <button id="adoSaveBtn" style="padding:8px 16px; font-size:13px;">Save</button>
        </div>
      </div>
    </div>
  </div>

  <div id="slackConfigModal" style="display:none; position:fixed; inset:0; z-index:9998; background:rgba(0,0,0,0.7); align-items:center; justify-content:center;">
    <div style="width:560px; max-width:90vw; background:#151925; border:1px solid #3a4257; border-radius:12px; display:flex; flex-direction:column; box-shadow:0 16px 48px rgba(0,0,0,0.6);">
      <div style="padding:16px 20px; border-bottom:1px solid #272b36; display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0; color:#e8eaf0; font-size:15px;">Slack Configuration</h3>
        <button id="slackConfigClose" style="background:none; border:none; color:#8f98af; font-size:18px; cursor:pointer; padding:0 4px;">&times;</button>
      </div>
      <div style="padding:20px; overflow-y:auto; max-height:70vh;">
        <div id="slackConfigError" style="display:none; background:#3d1a1a; border:1px solid #ff4444; border-radius:8px; padding:12px 16px; margin-bottom:14px; color:#ff8888; font-size:13px;"></div>
        <div id="slackConfigSuccess" style="display:none; background:#1a3d2a; border:1px solid #3ddc84; border-radius:8px; padding:12px 16px; margin-bottom:14px; color:#6fefaa; font-size:13px;"></div>
        <div style="background:#1a1f2e; border-radius:8px; padding:12px 16px; margin-bottom:16px; border-left:3px solid #e01e5a;">
          <div style="font-size:12px; color:#8f98af; line-height:1.6;">
            Configure Slack integration below. Create a webhook at:<br/>
            <a href="https://api.slack.com/messaging/webhooks" target="_blank" style="color:#69a0ff; text-decoration:underline;">https://api.slack.com/messaging/webhooks</a><br/>
            For reading channels, create a Slack app with a Bot Token.
          </div>
        </div>
        <div style="margin-bottom:12px;">
          <label style="font-size:12px; color:#c5cad6; display:block; margin-bottom:4px;">Webhook URL</label>
          <input id="slackCfgWebhook" type="text" placeholder="https://hooks.slack.com/services/T.../B.../..." style="font-size:13px;" />
          <div style="font-size:11px; color:#6f7a92; margin-top:3px;">Used by slack.sendMessage nodes to post messages.</div>
        </div>
        <div style="margin-bottom:12px;">
          <label style="font-size:12px; color:#c5cad6; display:block; margin-bottom:4px;">Bot Token <span style="color:#6f7a92;">(optional)</span></label>
          <input id="slackCfgBotToken" type="password" placeholder="xoxb-..." style="font-size:13px;" />
          <div style="font-size:11px; color:#6f7a92; margin-top:3px;">Required for slack.readChannel. Leave blank to keep existing.</div>
        </div>
        <div style="margin-bottom:12px;">
          <label style="font-size:12px; color:#c5cad6; display:block; margin-bottom:4px;">Default Channel <span style="color:#6f7a92;">(optional)</span></label>
          <input id="slackCfgChannel" type="text" placeholder="#general or C1234567890" style="font-size:13px;" />
        </div>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button id="slackTestBtn" class="secondary" style="padding:8px 16px; font-size:13px;">Test Webhook</button>
          <button id="slackSaveBtn" style="padding:8px 16px; font-size:13px;">Save</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Prompt Picker Modal -->
  <div id="promptPickerModal" style="display:none; position:fixed; inset:0; z-index:9998; background:rgba(0,0,0,0.7); align-items:center; justify-content:center;">
    <div style="width:820px; max-width:92vw; height:75vh; max-height:85vh; background:#151925; border:1px solid #3a4257; border-radius:12px; display:flex; flex-direction:column; box-shadow:0 16px 48px rgba(0,0,0,0.6);">
      <div style="padding:16px 20px; border-bottom:1px solid #272b36; display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0; color:#e8eaf0; font-size:15px;">Prompt Library</h3>
        <button id="promptPickerClose" style="background:none; border:none; color:#8f98af; font-size:18px; cursor:pointer; padding:0 4px;">&times;</button>
      </div>
      <div style="padding:10px 20px 0; border-bottom:1px solid #272b36;">
        <input id="promptPickerSearch" class="prompt-picker-search" type="text" placeholder="Search prompts..." />
        <div id="promptPickerTabs" style="display:flex; gap:0; margin-top:10px; overflow-x:auto;"></div>
      </div>
      <div style="flex:1; display:flex; min-height:0;">
        <div id="promptPickerListWrap" style="width:45%; border-right:1px solid #272b36; overflow-y:auto;">
          <ul id="promptPickerList" class="prompt-picker-list"></ul>
        </div>
        <div id="promptPickerPreviewWrap" style="width:55%; padding:14px; overflow-y:auto; display:flex; flex-direction:column;">
          <div id="promptPickerPreviewTitle" style="font-size:14px; font-weight:700; color:#e8eaf0; margin-bottom:4px;"></div>
          <div id="promptPickerPreviewDesc" style="font-size:12px; color:#8f98af; margin-bottom:10px;"></div>
          <div id="promptPickerPreview" class="prompt-picker-preview" style="flex:1;"></div>
        </div>
      </div>
      <div style="padding:12px 20px; border-top:1px solid #272b36; display:flex; justify-content:flex-end; gap:8px;">
        <button id="promptPickerCancel" class="secondary" style="padding:8px 16px;">Cancel</button>
        <button id="promptPickerInsert" style="padding:8px 16px; background:#3ddc84; color:#111; font-weight:600;">Use Prompt</button>
      </div>
    </div>
  </div>

  <script>
    const nodeDefsEl = document.getElementById('nodeDefs');
    const templatesEl = document.getElementById('templates');
    const savedEl = document.getElementById('savedWorkflows');
    const resultEl = document.getElementById('result');
    const canvas = document.getElementById('canvas');
    const edgesSvg = document.getElementById('edges');
    const runBtn = document.getElementById('runBtn');
    const stopBtn = document.getElementById('stopBtn');
    const saveBtn = document.getElementById('saveBtn');
    const reloadBtn = document.getElementById('reloadBtn');
    const previewBtn = document.getElementById('previewBtn');
    const rawBtn = document.getElementById('rawBtn');
    const workflowName = document.getElementById('workflowName');
    const workflowPath = document.getElementById('workflowPath');
    const variablesEl = document.getElementById('variables');
    const varsFormWrap = document.getElementById('varsFormWrap');
    const varsToggleBtn = document.getElementById('varsToggleBtn');
    const edgeList = document.getElementById('edgeList');
    const selectedMeta = document.getElementById('selectedMeta');
    const nodeFormTab = document.getElementById('nodeFormTab');
    const nodeJsonTab = document.getElementById('nodeJsonTab');
    const nodeForm = document.getElementById('nodeForm');
    const nodeConfig = document.getElementById('nodeConfig');
    const nodeConfigError = document.getElementById('nodeConfigError');
    const applyNodeBtn = document.getElementById('applyNodeBtn');
    const deleteNodeBtn = document.getElementById('deleteNodeBtn');
    const outputMeta = document.getElementById('outputMeta');
    const outputPreview = document.getElementById('outputPreview');
    const outputRaw = document.getElementById('outputRaw');

    let nodeDefs = [];
    let templates = [];
    var categoryIcons = { jira: '#4f7cff', ai: '#a78bfa', image: '#f59e0b', io: '#3ddc84', transform: '#f472b6', slack: '#e01e5a', github: '#f0f6fc', logic: '#ff9800', notification: '#00bcd4', ado: '#0078d4', azuredevops: '#0078d4', web: '#ff6b35', spec: '#9c27b0', confluence: '#1868db' };
    let graph = { id: 'workflow', name: 'Workflow', nodes: [], edges: [] };
    let selectedNodeId = null;
    let dragState = null;
    let panState = null;
    let dragHandlersBound = false;
    let outputState = { path: '', content: '', markdown: false };
    let nodeEditorTab = 'form';
    let nodeConfigParseError = '';
    let nodeStates = {};
    let isRunning = false;
    let stopRequested = false;
    let wireDrag = null; // { fromNodeId, startX, startY }
    let hoveredEdgeIdx = null;
    let varsShowJson = false;
    let activeChatSessionId = null;
    let zoomLevel = 1;

    // --- Interactive Chat Modal ---
    var chatHasUserMessages = false;

    function setChatPhase(phase) {
      var phaseLabel = document.getElementById('chatPhaseLabel');
      var banner = document.getElementById('chatActionBanner');
      var acceptBtn = document.getElementById('chatAcceptBtn');
      var applyBtn = document.getElementById('chatApplyBtn');
      var revertBtn = document.getElementById('chatRevertBtn');

      if (phase === 'reviewing') {
        phaseLabel.textContent = 'Reviewing';
        phaseLabel.style.background = '#2a3556';
        phaseLabel.style.color = '#69a0ff';
        banner.innerHTML = 'Review the generated content above. You can <strong style="color:#3ddc84;">accept it as-is</strong> and continue the workflow, or <strong style="color:#4f7cff;">chat with AI</strong> below to request changes.';
        acceptBtn.style.display = '';
        applyBtn.style.display = 'none';
        revertBtn.style.display = 'none';
      } else if (phase === 'refining') {
        phaseLabel.textContent = 'Refining';
        phaseLabel.style.background = '#2a4535';
        phaseLabel.style.color = '#3ddc84';
        banner.innerHTML = 'AI has refined the content based on your feedback. You can <strong style="color:#3ddc84;">use the refined version</strong>, or <strong style="color:#8f98af;">revert to the original</strong> generated content.';
        acceptBtn.style.display = 'none';
        applyBtn.style.display = '';
        revertBtn.style.display = '';
      }
    }

    function showChatModal(sessionId, initialMessage, nodeId, upstreamContent) {
      activeChatSessionId = sessionId;
      chatHasUserMessages = false;
      const modal = document.getElementById('chatModal');
      const messagesDiv = document.getElementById('chatMessages');
      const nodeLabel = document.getElementById('chatNodeLabel');
      const chatInput = document.getElementById('chatInput');
      const chatTyping = document.getElementById('chatTyping');

      modal.style.display = 'flex';
      nodeLabel.textContent = 'Node: ' + nodeId;
      messagesDiv.innerHTML = '';
      chatTyping.style.display = 'none';

      // Show upstream content expanded so user can review
      if (upstreamContent && upstreamContent.trim()) {
        const contentDiv = document.createElement('div');
        contentDiv.style.cssText = 'margin-bottom:12px; border:1px solid #343a4d; border-radius:8px; overflow:hidden;';
        const header = document.createElement('div');
        header.style.cssText = 'padding:8px 14px; background:#1a1f2e; color:#8f98af; font-size:12px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; user-select:none;';
        header.innerHTML = '<span>Generated Output (click to collapse)</span><span class="chatContentToggle">\u25B2</span>';
        const body = document.createElement('div');
        body.style.cssText = 'padding:12px 14px; background:#0f1117; color:#c5d0e8; font-size:12px; line-height:1.5; max-height:400px; overflow-y:auto;';

        // Render with code block formatting
        renderFormattedContent(body, upstreamContent);

        const toggle = header.querySelector('.chatContentToggle');
        header.onclick = () => {
          const isHidden = body.style.display === 'none';
          body.style.display = isHidden ? 'block' : 'none';
          toggle.textContent = isHidden ? '\u25B2' : '\u25BC';
          header.querySelector('span').textContent = isHidden ? 'Generated Output (click to collapse)' : 'Generated Output (click to expand)';
        };
        contentDiv.appendChild(header);
        contentDiv.appendChild(body);
        messagesDiv.appendChild(contentDiv);
      }

      if (initialMessage) {
        appendChatMessage(initialMessage);
      }

      // Start in "reviewing" phase
      setChatPhase('reviewing');
      chatInput.disabled = false;
      document.getElementById('chatSendBtn').disabled = false;
      document.getElementById('chatApplyBtn').disabled = false;
      document.getElementById('chatRevertBtn').disabled = false;
      document.getElementById('chatAcceptBtn').disabled = false;
      chatInput.value = '';
      chatInput.focus();
    }

    function appendChatMessage(msg) {
      const messagesDiv = document.getElementById('chatMessages');
      const div = document.createElement('div');
      div.style.cssText = 'margin-bottom:12px; padding:10px 14px; border-radius:8px; font-size:13px; line-height:1.6; word-break:break-word;';

      if (msg.role === 'assistant') {
        div.style.background = '#1b2540';
        div.style.color = '#c5d0e8';
        div.style.borderLeft = '3px solid #4f7cff';
        // Render formatted content with code blocks for assistant messages
        renderFormattedContent(div, msg.content || '');
      } else if (msg.role === 'user') {
        div.style.background = '#1a3520';
        div.style.color = '#c5e8d0';
        div.style.borderLeft = '3px solid #3ddc84';
        div.style.whiteSpace = 'pre-wrap';
        div.textContent = msg.content;
      } else {
        div.style.background = '#2a2a1a';
        div.style.color = '#e8e0c5';
        div.style.fontStyle = 'italic';
        div.style.whiteSpace = 'pre-wrap';
        div.textContent = msg.content;
      }

      messagesDiv.appendChild(div);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;

      // Hide typing indicator when message arrives
      document.getElementById('chatTyping').style.display = 'none';
    }

    // Render formatted content using DOM APIs (safe from HTML injection)
    function renderFormattedContent(container, raw) {
      var FENCE = String.fromCharCode(96,96,96);
      var NL = String.fromCharCode(10);
      var remaining = raw;

      while (remaining.length > 0) {
        var fStart = remaining.indexOf(FENCE);
        if (fStart === -1) { appendTextLines(container, remaining); break; }
        if (fStart > 0) appendTextLines(container, remaining.slice(0, fStart));
        remaining = remaining.slice(fStart + 3);
        var nlIdx = remaining.indexOf(NL);
        var lang = nlIdx >= 0 ? remaining.slice(0, nlIdx).trim() : '';
        if (nlIdx >= 0) remaining = remaining.slice(nlIdx + 1);
        var fEnd = remaining.indexOf(FENCE);
        var code = fEnd >= 0 ? remaining.slice(0, fEnd) : remaining;
        remaining = fEnd >= 0 ? remaining.slice(fEnd + 3) : '';

        renderCodeBlock(container, code, lang);
      }
    }

    function renderCodeBlock(container, code, lang) {
      // Try to pretty-print JSON
      var displayCode = code;
      var displayLang = lang || 'code';
      if (!lang || lang === 'json') {
        try {
          var trimmed = code.trim();
          if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && (trimmed.endsWith('}') || trimmed.endsWith(']'))) {
            displayCode = JSON.stringify(JSON.parse(trimmed), null, 2);
            displayLang = 'json';
          }
        } catch (_e) { /* not valid JSON, display as-is */ }
      }

      var wrapper = document.createElement('div');
      wrapper.style.cssText = 'margin:8px 0; position:relative;';
      // Header with language label and copy button
      var header = document.createElement('div');
      header.style.cssText = 'padding:4px 10px; background:#1a1f2e; color:#6b7280; font-size:11px; border-radius:6px 6px 0 0; border:1px solid #2a3040; border-bottom:none; display:flex; justify-content:space-between; align-items:center;';
      var langSpan = document.createElement('span');
      langSpan.textContent = displayLang;
      header.appendChild(langSpan);
      var copyBtn = document.createElement('button');
      copyBtn.textContent = 'Copy';
      copyBtn.style.cssText = 'padding:1px 8px; font-size:10px; background:#2a3040; color:#8f98af; border:1px solid #3a4257; border-radius:4px; cursor:pointer;';
      copyBtn.onclick = function() {
        navigator.clipboard.writeText(displayCode.trim()).then(function() {
          copyBtn.textContent = 'Copied!';
          setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1500);
        });
      };
      header.appendChild(copyBtn);
      wrapper.appendChild(header);
      // Code content with line numbers
      var pre = document.createElement('pre');
      pre.style.cssText = 'margin:0; padding:10px 12px; background:#0a0d14; color:#d4d9e8; font-size:12px; line-height:1.5; border:1px solid #2a3040; border-radius:0 0 6px 6px; overflow-x:auto; white-space:pre; tab-size:2;';
      pre.textContent = displayCode;
      wrapper.appendChild(pre);
      container.appendChild(wrapper);
    }

    function appendTextLines(container, text) {
      var NL = String.fromCharCode(10);

      // Check if the entire text block is a JSON object/array (no fences)
      var stripped = text.trim();
      if (stripped.length > 2 && ((stripped.startsWith('{') && stripped.endsWith('}')) || (stripped.startsWith('[') && stripped.endsWith(']')))) {
        try {
          JSON.parse(stripped);
          renderCodeBlock(container, stripped, 'json');
          return;
        } catch (_e) { /* not valid JSON, render as text */ }
      }

      var lines = text.split(NL);
      for (var j = 0; j < lines.length; j++) {
        var trimmed = lines[j].trim();
        if (!trimmed) continue;
        var div = document.createElement('div');
        div.style.cssText = 'color:#c5d0e8; margin:2px 0; line-height:1.5;';
        if (trimmed.startsWith('# ')) {
          div.style.cssText = 'font-weight:700; color:#e8eaf0; font-size:14px; margin:10px 0 4px;';
          div.textContent = trimmed.slice(2);
        } else if (trimmed.startsWith('## ')) {
          div.style.cssText = 'font-weight:600; color:#c5d0e8; font-size:13px; margin:8px 0 4px;';
          div.textContent = trimmed.slice(3);
        } else if (trimmed.startsWith('### ')) {
          div.style.cssText = 'font-weight:600; color:#b4bdd2; font-size:12px; margin:6px 0 3px;';
          div.textContent = trimmed.slice(4);
        } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
          div.style.cssText = 'padding-left:16px; color:#c5d0e8;';
          div.textContent = '\\u2022 ' + trimmed.slice(2);
        } else if (/^\\d+\\.\\s/.test(trimmed)) {
          div.style.cssText = 'padding-left:16px; color:#c5d0e8;';
          div.textContent = trimmed;
        } else if (trimmed.startsWith('File: ') || trimmed.startsWith('file: ')) {
          div.style.cssText = 'font-weight:600; color:#69a0ff; font-size:12px; margin:8px 0 2px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;';
          div.textContent = trimmed;
        } else {
          div.textContent = trimmed;
        }
        container.appendChild(div);
      }
    }

    function closeChatModal() {
      document.getElementById('chatModal').style.display = 'none';
      activeChatSessionId = null;
    }

    document.getElementById('chatSendBtn').onclick = async () => {
      if (!activeChatSessionId) return;
      const input = document.getElementById('chatInput');
      const message = input.value.trim();
      if (!message) return;

      input.value = '';
      input.disabled = true;
      document.getElementById('chatSendBtn').disabled = true;

      // Show user message immediately
      appendChatMessage({ role: 'user', content: message, timestamp: new Date().toISOString() });
      chatHasUserMessages = true;
      // Show typing indicator
      document.getElementById('chatTyping').style.display = 'block';

      try {
        await fetch('/api/run/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: activeChatSessionId, message }),
        });
        // AI response will arrive via SSE 'chat-message' event — transition to refining phase there
      } catch (err) {
        document.getElementById('chatTyping').style.display = 'none';
        appendChatMessage({ role: 'system', content: 'Error sending message: ' + err, timestamp: new Date().toISOString() });
        input.disabled = false;
        document.getElementById('chatSendBtn').disabled = false;
        input.focus();
      }
    };

    async function endChatSession(action) {
      if (!activeChatSessionId) return;
      document.getElementById('chatApplyBtn').disabled = true;
      document.getElementById('chatRevertBtn').disabled = true;
      document.getElementById('chatAcceptBtn').disabled = true;
      document.getElementById('chatSendBtn').disabled = true;
      document.getElementById('chatInput').disabled = true;

      var statusLabel;
      if (action === 'apply') {
        statusLabel = chatHasUserMessages ? 'Applying refined content...' : 'Accepting...';
        document.getElementById(chatHasUserMessages ? 'chatApplyBtn' : 'chatAcceptBtn').textContent = statusLabel;
      } else {
        statusLabel = 'Reverting to original...';
        document.getElementById('chatRevertBtn').textContent = statusLabel;
      }

      try {
        await fetch('/api/run/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: activeChatSessionId, done: true, action }),
        });
      } catch (err) {
        console.error('Error ending chat:', err);
      }

      document.getElementById('chatApplyBtn').textContent = 'Use Refined Content';
      document.getElementById('chatRevertBtn').textContent = 'Revert to Original';
      document.getElementById('chatAcceptBtn').textContent = 'Accept & Continue';
      closeChatModal();
    }

    document.getElementById('chatApplyBtn').onclick = () => endChatSession('apply');
    document.getElementById('chatAcceptBtn').onclick = () => endChatSession('apply');
    document.getElementById('chatRevertBtn').onclick = () => endChatSession('discard');

    document.getElementById('chatInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        document.getElementById('chatSendBtn').click();
      }
    });

    // --- Variables Form System ---
    const VAR_GROUPS = [
      { keys: ['model', 'outputPath', 'guide'], label: 'General' },
      { keys: ['configPath'], label: 'Jira: Connection' },
      { keys: ['projectKey', 'board', 'issueTypeName', 'targetStatus', 'defaultLabels', 'defaultComponents'], label: 'Jira: Team Defaults' },
      { keys: ['ticket', 'relatedLimit', 'updateMode', 'dryRun'], label: 'Jira: Per-Run' },
      { keys: ['adoConfigPath'], label: 'Azure DevOps: Connection' },
      { keys: ['adoRepoUrl', 'azureDevOpsProject', 'azureDevOpsRepository', 'azureDevOpsBranch', 'azureDevOpsPath', 'azureDevOpsMaxFiles', 'azureDevOpsMaxCharsPerFile', 'azureDevOpsFileNameFilter', 'azureDevOpsContentFilter', 'dryRunPR'], label: 'Azure DevOps: Per-Run' },
      { prefix: 'spec', label: 'Specification (Per-Run)' },
      { keys: ['slackConfigPath'], label: 'Slack: Connection' },
      { keys: ['externalUrls', 'adoSearchQuery', 'confluenceSearchQuery', 'confluenceSpaceKey', 'jiraSearchJql'], label: 'Research: Overrides' },
    ];

    const VAR_HINTS = {
      ticket: 'Full Jira ticket URL or key (e.g. https://yourcompany.atlassian.net/browse/PROJ-123 or PROJ-123). Found in the browser address bar when viewing a ticket.',
      configPath: 'Path to a .env file containing JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN. Relative to the working directory. Generate an API token at https://id.atlassian.com/manage-profile/security/api-tokens.',
      guide: 'Path to a process guide markdown file. Provides context to the AI for generating plans or tickets. Relative to the working directory.',
      outputPath: 'File path where workflow results will be written. Relative to the working directory. The directory will be created automatically if needed.',
      relatedLimit: 'Maximum number of related Jira issues to fetch via JQL search. Higher values give the AI more context but increase processing time.',
      model: 'AI model to use for prompt generation. Options: "haiku" (fast, cheap), "sonnet" (balanced), "opus" (most capable). Defaults to sonnet.',
      projectKey: 'Jira project key (e.g. "CEQ", "PROJ"). Visible as the prefix in ticket keys like CEQ-123. Found in Jira under Project Settings > Details.',
      board: 'Jira board name for the prompt context. Found in Jira under Boards in the left sidebar. Optional — if empty, the project default is used.',
      issueTypeName: 'Jira issue type. Common values: "Task", "Story", "Bug", "Epic". Must match an issue type in the target project. Found in Project Settings > Issue types.',
      targetStatus: 'Status column to transition created tickets to (e.g. "To Do", "In Progress"). Leave empty to keep the default (usually Backlog). Must match an available workflow transition.',
      defaultLabels: 'Comma-separated labels applied to all created issues. Jira will auto-create labels that do not already exist. Example: "auto-generated,sprint-5".',
      defaultComponents: 'Comma-separated component names for all created issues. Components must exist in the project. Found in Project Settings > Components.',
      updateMode: '"update" replaces the ticket description with the refined content. "comment" adds the refined content as a comment, preserving the original ticket.',
      dryRun: 'When enabled, tickets are simulated but not created in Jira. Disable to create real tickets. Recommended: test with dry run first.',
      specTitle: 'Title for the specification. Used as the heading in the generated ticket plan.',
      specObjective: 'What the project or feature should achieve. Provide clear, measurable goals.',
      specScope: 'What is in and out of scope. Define boundaries to help the AI generate focused tickets.',
      specConstraints: 'Technical, business, or timeline constraints the implementation must respect.',
      specAcceptanceCriteria: 'How success will be measured. Define clear pass/fail criteria.',
      specDeliverables: 'Concrete artifacts to be produced (code, docs, configs, etc.).',
      specNotes: 'Additional context, links, or references for the AI.',
      adoConfigPath: 'Path to an encrypted .env file containing AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PAT. Click the "ADO Config" button to manage credentials.',
      adoRepoUrl: 'Paste a full ADO repo URL to scope code search to one repo, a project URL for all repos in a project, or a project name. Leave empty to search the entire org. Example: https://org.visualstudio.com/My%20Project/_git/MyRepo',
      azureDevOpsProject: 'Azure DevOps project name (for Read Repo Context and Create PR nodes). From your URL: https://org.visualstudio.com/{Project}/_git/{Repo} — enter the {Project} part.',
      azureDevOpsRepository: 'Repository name within the project. Found under Repos in the left sidebar.',
      azureDevOpsBranch: 'Git branch to read files from. Defaults to "main".',
      azureDevOpsPath: 'Path within the repo to scan. Use "/" for the root or a subfolder like "/src".',
      azureDevOpsMaxFiles: 'Maximum number of files to read from the repo for context. Higher values give more context but increase token usage.',
      azureDevOpsMaxCharsPerFile: 'Maximum characters to read per file. Truncates large files to keep context manageable.',
      azureDevOpsFileNameFilter: 'Comma-separated terms to filter by file path/name. Only files whose path contains at least one term are sampled. Case-insensitive. Example: "email,template". Leave empty to include all files.',
      azureDevOpsContentFilter: 'Comma-separated terms to filter by file content. After name filtering, only files containing at least one term in their source are kept. Example: "sendEmail,SmtpClient". Leave empty to skip.',
      dryRunPR: 'When enabled, simulates PR creation without calling Azure DevOps APIs. Disable to create real branches and pull requests. Recommended: test with dry run first.',
      externalUrls: 'URLs from the ticket to fetch (deprecation notices, release notes, forum posts). One per line or comma-separated. HTTPS only.',
      adoSearchQuery: 'Azure DevOps code search query. Use specific API names, library imports, or class names. Supports AND, OR, NOT. Leave blank to let the AI planning node suggest queries (copy from planSearch output).',
      confluenceSearchQuery: 'Confluence text search query. Focus on architecture docs, runbooks, or integration pages. Leave blank to let the AI planning node suggest queries.',
      confluenceSpaceKey: 'Optional Confluence space key to limit search (e.g. "ENG", "ARCH"). Leave blank to search all spaces.',
      jiraSearchJql: 'JQL query to find related Jira tickets. Example: text ~ "Microsoft Graph" ORDER BY updated DESC. Leave blank to use the AI planning node suggestion.',
      slackConfigPath: 'Path to a .env file containing SLACK_WEBHOOK_URL and optional SLACK_BOT_TOKEN. Relative to the working directory.',
    };

    const VAR_OPTIONS = {
      model: ['haiku', 'sonnet', 'opus'],
      updateMode: ['update', 'comment'],
    };

    function varKeyToLabel(key) {
      // camelCase → Title Case with spaces
      return key
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^./, (c) => c.toUpperCase());
    }

    function varInputType(key, val) {
      if (typeof val === 'boolean') return 'checkbox';
      if (typeof val === 'number') return 'number';
      if (typeof val === 'string' && val.length > 80) return 'textarea';
      return 'text';
    }

    function groupVariables(vars) {
      const groups = [];
      const used = new Set();

      for (const grp of VAR_GROUPS) {
        const keys = grp.keys
          ? grp.keys.filter((k) => k in vars)
          : Object.keys(vars).filter((k) => k.startsWith(grp.prefix));
        if (keys.length > 0) {
          groups.push({ label: grp.label, keys });
          keys.forEach((k) => used.add(k));
        }
      }

      const remaining = Object.keys(vars).filter((k) => !used.has(k));
      if (remaining.length > 0) {
        // Insert after existing General group if present, otherwise prepend
        const generalIdx = groups.findIndex((g) => g.label === 'General');
        if (generalIdx >= 0) {
          groups[generalIdx].keys = groups[generalIdx].keys.concat(remaining);
        } else {
          groups.unshift({ label: 'General', keys: remaining });
        }
      }

      return groups;
    }

    function renderVarsForm() {
      if (varsShowJson) {
        varsFormWrap.style.display = 'none';
        variablesEl.style.display = '';
        varsToggleBtn.textContent = 'Form';
        return;
      }

      variablesEl.style.display = 'none';
      varsFormWrap.style.display = '';
      varsToggleBtn.textContent = 'JSON';

      let vars;
      try {
        vars = JSON.parse(variablesEl.value || '{}');
      } catch {
        varsFormWrap.innerHTML = '<div class="muted">Invalid JSON — switch to JSON view to fix.</div>';
        return;
      }

      const groups = groupVariables(vars);
      let html = '';

      for (const grp of groups) {
        html += '<details style="margin-bottom:6px;">';
        html += '<summary style="cursor:pointer;font-size:12px;font-weight:600;color:#8f98af;padding:4px 0;user-select:none;">' + escapeHtml(grp.label) + '</summary>';
        html += '<div style="padding-left:2px;">';

        for (const key of grp.keys) {
          const val = vars[key];
          const inputType = varInputType(key, val);
          const label = varKeyToLabel(key);
          const id = 'var-' + key;

          const hint = VAR_HINTS[key] || '';
          const hintIcon = hint
            ? ' <span class="hint-wrap"><span class="hint-icon" data-hint="' + escapeHtml(hint) + '">?</span></span>'
            : '';
          html += '<div class="field-label-row" style="margin-top:6px;">';
          html += '<label for="' + id + '" style="font-size:12px;color:#c5cad6;">' + escapeHtml(label) + '</label>' + hintIcon;
          html += '</div>';

          if (inputType === 'checkbox') {
            html += '<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;">';
            html += '<input type="checkbox" id="' + id + '" data-var-key="' + escapeHtml(key) + '" ' + (val ? 'checked' : '') + ' />';
            html += '<span style="color:#8f98af;">' + (val ? 'true' : 'false') + '</span>';
            html += '</label>';
          } else if (VAR_OPTIONS[key]) {
            var optList = VAR_OPTIONS[key];
            html += '<select id="' + id + '" data-var-key="' + escapeHtml(key) + '" style="font-size:12px;">';
            for (var oi = 0; oi < optList.length; oi++) {
              var ov = optList[oi];
              var sel = String(val) === ov ? ' selected' : '';
              html += '<option value="' + escapeHtml(ov) + '"' + sel + '>' + escapeHtml(ov) + '</option>';
            }
            html += '</select>';
          } else if (inputType === 'textarea') {
            html += '<textarea id="' + id + '" data-var-key="' + escapeHtml(key) + '" style="min-height:48px;font-size:12px;">' + escapeHtml(String(val)) + '</textarea>';
          } else if (inputType === 'number') {
            html += '<input type="number" id="' + id + '" data-var-key="' + escapeHtml(key) + '" value="' + escapeHtml(String(val)) + '" style="font-size:12px;" />';
          } else {
            html += '<input type="text" id="' + id + '" data-var-key="' + escapeHtml(key) + '" value="' + escapeHtml(String(val)) + '" style="font-size:12px;" />';
          }
        }

        html += '</div></details>';
      }

      varsFormWrap.innerHTML = html;

      // Bind change handlers to sync back to JSON
      varsFormWrap.querySelectorAll('[data-var-key]').forEach((el) => {
        const handler = () => syncVarFieldToJson(el);
        el.addEventListener('input', handler);
        el.addEventListener('change', handler);
      });

      // Initialize hint tooltips for variable form
      initHintTooltips(varsFormWrap);
    }

    function syncVarFieldToJson(el) {
      const key = el.getAttribute('data-var-key');
      if (!key) return;

      let vars;
      try {
        vars = JSON.parse(variablesEl.value || '{}');
      } catch { return; }

      if (el.type === 'checkbox') {
        vars[key] = el.checked;
        const span = el.parentElement?.querySelector('span');
        if (span) span.textContent = el.checked ? 'true' : 'false';
      } else if (el.type === 'number') {
        vars[key] = el.value === '' ? '' : Number(el.value);
      } else {
        vars[key] = el.value;
      }

      variablesEl.value = JSON.stringify(vars, null, 2);
      // Refresh resolved-value badges in the node config form
      if (nodeEditorTab === 'form' && selectedNodeId) {
        renderNodeFormFields();
      }
    }

    varsToggleBtn.onclick = () => {
      if (varsShowJson) {
        // Switching from JSON → Form: re-render form from current textarea value
        varsShowJson = false;
      } else {
        // Switching from Form → JSON: form already synced, just show textarea
        varsShowJson = true;
      }
      renderVarsForm();
    };

    function ensureNodeDefaults(node, idx) {
      if (!node.position) {
        node.position = { x: 40 + (idx * 40), y: 40 + (idx * 30) };
      }
      if (!node.config) node.config = {};
      if (node.type) {
        const def = nodeDefs.find(d => d.type === node.type);
        if (def) {
          if (!node.label) node.label = def.title;
          // Apply defaultValues for fields not already set in config
          if (Array.isArray(def.configSchema)) {
            for (var fi = 0; fi < def.configSchema.length; fi++) {
              var field = def.configSchema[fi];
              if (field.defaultValue !== undefined && !(field.key in node.config)) {
                node.config[field.key] = field.defaultValue;
              }
            }
          }
        }
      }
      return node;
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function markdownToHtml(md) {
      const codeBlocks = [];
      const fence = String.fromCharCode(96).repeat(3);
      const codeFenceRegex = new RegExp(fence + '([\\\\s\\\\S]*?)' + fence, 'g');
      let text = String(md || '').replace(codeFenceRegex, (_match, code) => {
        const token = '__CODE_BLOCK_' + codeBlocks.length + '__';
        codeBlocks.push('<pre><code>' + escapeHtml(code.trim()) + '</code></pre>');
        return token;
      });

      text = text
        .replace(new RegExp('^### (.*)$', 'gm'), '<h3>$1</h3>')
        .replace(new RegExp('^## (.*)$', 'gm'), '<h2>$1</h2>')
        .replace(new RegExp('^# (.*)$', 'gm'), '<h1>$1</h1>')
        .replace(new RegExp('\\\\*\\\\*(.*?)\\\\*\\\\*', 'g'), '<strong>$1</strong>')
        .replace(new RegExp('\\\\*(.*?)\\\\*', 'g'), '<em>$1</em>')
        .replace(new RegExp(String.fromCharCode(96) + '([^' + String.fromCharCode(96) + ']+)' + String.fromCharCode(96), 'g'), '<code>$1</code>')
        .replace(new RegExp('^\\\\- (.*)$', 'gm'), '<li>$1</li>');

      text = text
        .split(new RegExp('\\\\n\\\\n+'))
        .map((block) => {
          const trimmed = block.trim();
          if (!trimmed) return '';
          if (trimmed.startsWith('<h1>') || trimmed.startsWith('<h2>') || trimmed.startsWith('<h3>') || trimmed.startsWith('<pre>')) {
            return trimmed;
          }
          if (trimmed.includes('<li>')) {
            return '<ul>' + trimmed + '</ul>';
          }
          return '<p>' + trimmed.replace(new RegExp('\\\\n', 'g'), '<br/>') + '</p>';
        })
        .join('\\n');

      codeBlocks.forEach((html, idx) => {
        text = text.replace('__CODE_BLOCK_' + idx + '__', html);
      });

      return text;
    }

    function setOutputView(mode) {
      if (mode === 'raw') {
        outputRaw.style.display = 'block';
        outputPreview.style.display = 'none';
      } else {
        outputRaw.style.display = 'none';
        outputPreview.style.display = 'block';
      }
      if (typeof saveUiState === 'function') saveUiState();
    }

    function showOutput(content, path) {
      const isMarkdown = new RegExp('\\\\.md$', 'i').test(path || '');
      outputState = { path: path || '', content: content || '', markdown: isMarkdown };
      outputMeta.textContent = path ? ('Loaded: ' + path) : 'Loaded output.';
      outputRaw.textContent = content || '';
      outputPreview.innerHTML = isMarkdown
        ? markdownToHtml(content)
        : '<pre style="margin:0; white-space:pre-wrap;">' + escapeHtml(content || '') + '</pre>';
      setOutputView(isMarkdown ? 'preview' : 'raw');
    }

    async function loadOutputFile(path) {
      if (!path) return;
      const res = await fetch('/api/output/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const body = await res.json();
      if (!res.ok || !body?.success) {
        outputMeta.textContent = 'Output load failed.';
        outputRaw.textContent = JSON.stringify(body, null, 2);
        setOutputView('raw');
        return;
      }
      showOutput(String(body.content || ''), String(body.path || path));
    }

    function formatWorkflowResult(result) {
      const ok = result.success;
      const dur = ((result.durationMs || 0) / 1000).toFixed(1);
      const header = '<div style="margin-bottom:8px;font-weight:600;color:' + (ok ? '#4caf50' : '#ef5350') + ';">'
        + (ok ? 'Workflow Completed' : 'Workflow Failed') + ' (' + dur + 's)</div>';

      const nodeEntries = Object.entries(result.nodeResults || {});
      let nodesHtml = '';

      for (const [nodeId, nr] of nodeEntries) {
        const nOk = nr.success;
        const nDur = ((nr.durationMs || 0) / 1000).toFixed(1);
        const statusColor = nOk ? '#4caf50' : '#ef5350';
        const statusIcon = nOk ? '&#10003;' : '&#10007;';

        nodesHtml += '<details style="margin-bottom:6px;border:1px solid #2a3144;border-radius:6px;padding:0;">';
        nodesHtml += '<summary style="cursor:pointer;padding:6px 10px;background:#1a1f2e;border-radius:6px;display:flex;align-items:center;gap:8px;">';
        nodesHtml += '<span style="color:' + statusColor + ';">' + statusIcon + '</span>';
        nodesHtml += '<span style="font-weight:600;">' + escapeHtml(nodeId) + '</span>';
        nodesHtml += '<span style="color:#6b7394;font-size:11px;">(' + escapeHtml(nr.nodeType) + ', ' + nDur + 's)</span>';

        // Show warning/error badges inline
        const output = nr.output || {};
        if (output.warning) {
          nodesHtml += '<span style="background:#ff980020;color:#ff9800;font-size:10px;padding:2px 6px;border-radius:3px;margin-left:auto;">warning</span>';
        }
        if (output.apiErrors && output.apiErrors.length > 0) {
          nodesHtml += '<span style="background:#ef535020;color:#ef5350;font-size:10px;padding:2px 6px;border-radius:3px;margin-left:4px;">' + output.apiErrors.length + ' API error(s)</span>';
        }
        if (nr.error) {
          nodesHtml += '<span style="background:#ef535020;color:#ef5350;font-size:10px;padding:2px 6px;border-radius:3px;margin-left:auto;">error</span>';
        }
        nodesHtml += '</summary>';

        nodesHtml += '<div style="padding:8px 10px;font-size:12px;">';

        // Show error
        if (nr.error) {
          nodesHtml += '<div style="color:#ef5350;margin-bottom:6px;"><strong>Error:</strong> ' + escapeHtml(String(nr.error)) + '</div>';
        }

        // Show warning
        if (output.warning) {
          nodesHtml += '<div style="color:#ff9800;margin-bottom:6px;"><strong>Warning:</strong> ' + escapeHtml(String(output.warning)) + '</div>';
        }

        // Show API errors
        if (output.apiErrors && Array.isArray(output.apiErrors)) {
          for (const ae of output.apiErrors) {
            nodesHtml += '<div style="color:#ef5350;margin-bottom:4px;border-left:3px solid #ef5350;padding-left:8px;">';
            nodesHtml += '<strong>API Error (ticket ' + ae.ticketIndex + '): ' + escapeHtml(ae.summary || '') + '</strong><br>';
            nodesHtml += escapeHtml(String(ae.error || ''));
            if (ae.requestPayload) {
              nodesHtml += '<details style="margin-top:4px;"><summary style="cursor:pointer;color:#8f98af;font-size:11px;">Request payload</summary>';
              nodesHtml += '<pre style="font-size:10px;max-height:200px;overflow:auto;background:#0d1117;padding:6px;border-radius:4px;">' + escapeHtml(JSON.stringify(ae.requestPayload, null, 2)) + '</pre>';
              nodesHtml += '</details>';
            }
            nodesHtml += '</div>';
          }
        }

        // Show _debug section
        if (output._debug) {
          nodesHtml += '<details style="margin-top:6px;"><summary style="cursor:pointer;color:#4f7cff;font-size:11px;font-weight:600;">Debug Info</summary>';
          nodesHtml += '<pre style="font-size:10px;max-height:300px;overflow:auto;background:#0d1117;padding:6px;border-radius:4px;margin-top:4px;white-space:pre-wrap;word-break:break-all;">' + escapeHtml(JSON.stringify(output._debug, null, 2)) + '</pre>';
          nodesHtml += '</details>';
        }

        // Show _resolvedConfig section
        if (output._resolvedConfig) {
          nodesHtml += '<details style="margin-top:6px;"><summary style="cursor:pointer;color:#4f7cff;font-size:11px;font-weight:600;">Resolved Config</summary>';
          nodesHtml += '<pre style="font-size:10px;max-height:300px;overflow:auto;background:#0d1117;padding:6px;border-radius:4px;margin-top:4px;white-space:pre-wrap;word-break:break-all;">' + escapeHtml(JSON.stringify(output._resolvedConfig, null, 2)) + '</pre>';
          nodesHtml += '</details>';
        }

        // Show main output (excluding debug fields)
        const cleanOutput = {};
        for (const [k, v] of Object.entries(output)) {
          if (k !== '_debug' && k !== '_resolvedConfig' && k !== 'apiErrors') cleanOutput[k] = v;
        }
        nodesHtml += '<details style="margin-top:6px;"><summary style="cursor:pointer;color:#8f98af;font-size:11px;">Full Output</summary>';
        nodesHtml += '<pre style="font-size:10px;max-height:400px;overflow:auto;background:#0d1117;padding:6px;border-radius:4px;margin-top:4px;white-space:pre-wrap;word-break:break-all;">' + escapeHtml(JSON.stringify(cleanOutput, null, 2)) + '</pre>';
        nodesHtml += '</details>';

        nodesHtml += '</div></details>';
      }

      // Show errors summary
      let errorsHtml = '';
      if (result.errors && result.errors.length > 0) {
        errorsHtml = '<div style="margin-top:8px;color:#ef5350;"><strong>Errors:</strong><ul style="margin:4px 0;padding-left:20px;">';
        for (const err of result.errors) {
          errorsHtml += '<li>' + escapeHtml(String(err)) + '</li>';
        }
        errorsHtml += '</ul></div>';
      }

      return header + nodesHtml + errorsHtml;
    }

    function findOutputPathFromRunResult(body) {
      const entries = Object.values(body?.nodeResults || {});
      for (let idx = entries.length - 1; idx >= 0; idx -= 1) {
        const item = entries[idx];
        const outputPath = item?.output?.path;
        if (typeof outputPath === 'string' && outputPath.length > 0) {
          return outputPath;
        }
      }
      return '';
    }

    /**
     * Scans all node results in execution order and builds a composite markdown
     * document with sections for each node that produced meaningful output.
     */
    function buildCompositeOutput(result) {
      var order = result.order || [];
      var nodeResults = result.nodeResults || {};
      var sections = [];

      for (var i = 0; i < order.length; i++) {
        var nodeId = order[i];
        var nr = nodeResults[nodeId];
        if (!nr || !nr.success) continue;
        var out = nr.output || {};
        var nodeType = nr.nodeType || '';
        // Find the friendly label from the graph
        var graphNode = graph.nodes.find(function(n) { return n.id === nodeId; });
        var label = (graphNode && graphNode.label) || nodeId;

        if (nodeType === 'ai.runPrompt' || nodeType === 'ai.interactiveChat') {
          var text = String(out.text || '').trim();
          if (text) {
            sections.push({ label: label, content: text, type: 'markdown' });
          }
        } else if (nodeType === 'jira.fetchIssue') {
          var key = out.key || '';
          var summary = out.summary || '';
          var desc = out.description || '';
          if (key) {
            var body = '**' + escapeHtml(key) + '**: ' + escapeHtml(summary);
            if (desc) body += '\\n\\n' + desc;
            sections.push({ label: label, content: body, type: 'markdown' });
          }
        } else if (nodeType === 'jira.searchJql') {
          var issues = out.issues || [];
          if (issues.length > 0) {
            var lines = issues.map(function(iss) {
              var ik = iss.key || '';
              var isummary = (iss.fields && iss.fields.summary) || '';
              return '- **' + escapeHtml(String(ik)) + '**: ' + escapeHtml(String(isummary));
            });
            sections.push({ label: label + ' (' + issues.length + ' results)', content: lines.join('\\n'), type: 'markdown' });
          }
        } else if (nodeType === 'jira.createIssues') {
          var created = out.created || [];
          var dryRun = out.dryRun;
          if (created.length > 0) {
            var prefix = dryRun ? '*(dry run)* ' : '';
            var ticketLines = created.map(function(c) {
              var link = c.url ? '[' + escapeHtml(c.key) + '](' + c.url + ')' : '**' + escapeHtml(c.key || '') + '**';
              return '- ' + prefix + link + ': ' + escapeHtml(c.summary || '');
            });
            sections.push({ label: label + ' (' + created.length + ' ticket' + (created.length !== 1 ? 's' : '') + ')', content: ticketLines.join('\\n'), type: 'markdown' });
          }
        } else if (nodeType === 'azuredevops.createPullRequest') {
          if (out.prUrl || out.branchName) {
            var prLines = [];
            if (out.prUrl) prLines.push('**PR**: [' + escapeHtml(out.prTitle || out.prUrl) + '](' + out.prUrl + ')');
            if (out.branchName) prLines.push('**Branch**: \\x60' + escapeHtml(out.branchName) + '\\x60');
            if (typeof out.filesChanged === 'number') prLines.push('**Files changed**: ' + out.filesChanged);
            if (out.dryRun) prLines.push('*(dry run — no PR was actually created)*');
            sections.push({ label: label, content: prLines.join('\\n'), type: 'markdown' });
          }
        } else if (nodeType === 'jira.addComment') {
          if (out.created && out.issueKey) {
            sections.push({ label: label, content: 'Comment added to **' + escapeHtml(out.issueKey) + '**', type: 'markdown' });
          }
        } else if (nodeType === 'jira.updateIssue') {
          if (out.issueKey) {
            var fields = (out.updatedFields || []).join(', ');
            var modeLabel = out.mode === 'comment' ? 'comment' : 'description update';
            var imgNote = out.imageCount > 0 ? ' (' + out.imageCount + ' image' + (out.imageCount !== 1 ? 's' : '') + ' re-embedded)' : '';
            if (out.dryRun) {
              var dryContent = '*(Dry run — ticket was NOT ' + (out.mode === 'comment' ? 'commented on' : 'updated') + ')*\\n\\n';
              dryContent += '**Ticket**: ' + escapeHtml(out.issueKey) + '\\n';
              dryContent += '**Mode**: ' + escapeHtml(modeLabel) + imgNote + '\\n';
              dryContent += '**Fields**: ' + escapeHtml(fields) + '\\n\\n';
              dryContent += '---\\n\\n';
              dryContent += '### Content that would be sent\\n\\n';
              dryContent += String(out.description || '');
              sections.push({ label: label + ' (dry run)', content: dryContent, type: 'markdown' });
            } else if (out.updated) {
              var actionVerb = out.mode === 'comment' ? 'Added comment to' : 'Updated';
              var updateContent = actionVerb + ' **' + escapeHtml(out.issueKey) + '**' + imgNote + ' — fields: ' + escapeHtml(fields);
              if (out.description) {
                var sectionTitle = out.mode === 'comment' ? '### Comment Added' : '### Updated Description';
                updateContent += '\\n\\n---\\n\\n' + sectionTitle + '\\n\\n' + String(out.description);
              }
              sections.push({ label: label, content: updateContent, type: 'markdown' });
            }
          }
        } else if (nodeType === 'io.writeFile') {
          if (out.path) {
            sections.push({ label: label, content: 'Saved to \\x60' + escapeHtml(String(out.path)) + '\\x60 (' + (out.bytes || 0) + ' bytes)', type: 'markdown' });
          }
        } else if (nodeType === 'image.visionExtract') {
          var analysis = String(out.analysis || '').trim();
          if (analysis && analysis !== 'No ticket images found to analyze.') {
            sections.push({ label: label, content: analysis, type: 'markdown' });
          }
        } else if (nodeType === 'transform.template') {
          var rendered = String(out.content || '').trim();
          if (rendered) {
            sections.push({ label: label, content: rendered, type: 'markdown' });
          }
        } else if (nodeType === 'spec.input') {
          var specText = String(out.specText || '').trim();
          if (specText && !out.empty) {
            sections.push({ label: label, content: specText, type: 'markdown' });
          }
        }
      }

      if (sections.length === 0) return '';

      // Build a single markdown document with clear section headers
      var md = '';
      for (var s = 0; s < sections.length; s++) {
        if (s > 0) md += '\\n\\n---\\n\\n';
        md += '## ' + sections[s].label + '\\n\\n';
        md += sections[s].content;
      }
      return md;
    }

    function getSelectedNode() {
      if (!selectedNodeId) return null;
      return graph.nodes.find((n) => n.id === selectedNodeId) || null;
    }

    function getNodeDefinition(nodeType) {
      return nodeDefs.find((def) => def.type === nodeType) || null;
    }

    // ── Prompt Library ─────────────────────────────────────────────────
    var PROMPT_LIBRARY = [
      // ── Research & Analysis ──────────────────────────────────────────
      {
        id: 'research-summary',
        title: 'Research Summary',
        description: 'Produces a comprehensive research summary from a Jira ticket, image analysis, and related tickets. Outputs context, key findings, risks, and next actions.',
        category: 'Research & Analysis',
        prompt: [
          'You are a senior technical analyst. Produce a comprehensive research summary for the following Jira ticket.',
          '',
          '{{_upstream}}',
          '',
          'Produce a research summary with the following sections:',
          '',
          '## Context',
          'What this ticket is about, incorporating details from the description and any image analysis.',
          '',
          '## Key Findings',
          'Important details, patterns, or insights from the ticket and related tickets.',
          '',
          '## Risks & Dependencies',
          'Potential risks, blockers, or dependencies identified from the ticket content and related work.',
          '',
          '## Next Actions',
          'Concrete recommended next steps, in priority order.',
          '',
          'Be concise. Every claim should be traceable to the ticket content, image analysis, or related tickets.',
        ].join('\\n'),
      },
      {
        id: 'research-with-code',
        title: 'Research + Code Search Summary',
        description: 'Synthesizes Jira ticket research with ADO code search results. Adds an Implementation Notes section with code-level insights.',
        category: 'Research & Analysis',
        prompt: [
          'You are a senior technical analyst. Produce a comprehensive research summary for the following Jira ticket, incorporating code search results.',
          '',
          '{{_upstream}}',
          '',
          'Produce a research summary with the following sections:',
          '',
          '## Context',
          'What this ticket is about, incorporating details from the description and any image analysis.',
          '',
          '## Key Findings',
          'Important details, patterns, or insights from the ticket and related tickets.',
          '',
          '## Implementation Notes',
          'Technical details from the code search results — affected files, patterns found, existing implementations to be aware of.',
          '',
          '## Risks & Dependencies',
          'Potential risks, blockers, or dependencies identified from the ticket content, related work, and code search.',
          '',
          '## Next Actions',
          'Concrete recommended next steps, in priority order.',
          '',
          'Be concise. Every claim should be traceable to ticket content, image analysis, related tickets, or code search results.',
        ].join('\\n'),
      },
      {
        id: 'deep-research-planner',
        title: 'Deep Research — Search Planner',
        description: 'Analyzes a ticket and external content to produce targeted search queries for ADO code, Confluence, and Jira.',
        category: 'Research & Analysis',
        prompt: [
          'You are a senior research analyst. Analyze this ticket and any upstream content to produce a search strategy.',
          '',
          '{{_upstream}}',
          '',
          'YOUR TASK:',
          '1. Summarize the core change/deprecation/issue described.',
          '2. Identify specific technical identifiers to search for: API names, library names, packages, SDK classes, config keys, endpoint URLs, etc.',
          '3. Produce THREE sections:',
          '',
          '## Change Summary',
          'A 2-3 sentence description of what is changing and why it matters.',
          '',
          '## ADO Code Search Queries',
          'Return 1-3 search queries (one per line) optimized for Azure DevOps code search.',
          'Use specific identifiers like class names, method calls, import statements, package names.',
          '',
          '## Confluence Search Queries',
          'Return 1-3 search queries (one per line) optimized for Confluence text search.',
          'Focus on architecture docs, runbooks, integration docs, team pages.',
          '',
          '## Jira Search JQL',
          'Return a JQL query to find related Jira tickets.',
          '',
          'Be specific and technical. The goal is to find every system that might be impacted.',
        ].join('\\n'),
      },
      {
        id: 'deep-research-synthesis',
        title: 'Deep Research — Synthesis Report',
        description: 'Compiles results from ADO code search, Confluence, and Jira into a structured research report with impact assessment and recommendations.',
        category: 'Research & Analysis',
        prompt: [
          'You are a senior research analyst completing a deep research task. Compile your findings into a clear, concise report.',
          '',
          '{{_upstream}}',
          '',
          'Write a research report. Use ONLY what the upstream data supports — do not speculate. Structure your response as:',
          '',
          '## Change Summary',
          'What is changing and why.',
          '',
          '## Impact Assessment',
          'What impact this will have. State "No impact found" if searches returned nothing.',
          '',
          '## Impacted Systems Inventory',
          'A numbered list of impacted systems with:',
          '- Repository / system name',
          '- Specific files (preserve any markdown links)',
          '- Nature of the dependency',
          '- Severity (high/medium/low)',
          '',
          '## Owning Teams',
          'For each impacted system, identify the owning team if available.',
          '',
          '## Recommended Next Steps',
          'Concrete actions to take, in priority order.',
          '',
          '## Search Coverage',
          'What was searched and what was not — so the reader knows the research boundaries.',
          '',
          'Be concise. Every claim must trace back to upstream data.',
        ].join('\\n'),
      },
      {
        id: 'implementation-plan',
        title: 'Implementation Plan',
        description: 'Creates an actionable numbered implementation plan from a Jira ticket with owner roles and done criteria.',
        category: 'Research & Analysis',
        prompt: [
          'Create an actionable implementation plan.',
          '',
          '{{_upstream}}',
          '',
          'Return concise numbered steps with:',
          '- Owner role (e.g. frontend dev, backend dev, QA, devops)',
          '- Done criteria for each step',
          '- Dependencies between steps',
          '',
          'Keep it practical and implementation-ready.',
        ].join('\\n'),
      },
      // ── Code Analysis ───────────────────────────────────────────────
      {
        id: 'technical-code-analysis',
        title: 'Technical Code Analysis',
        description: 'Analyzes code from upstream ADO code search results. Extracts technical details, patterns, dependencies, and architecture insights.',
        category: 'Code Analysis',
        prompt: [
          'You are a senior software engineer. Analyze the code from the upstream search results and produce a detailed technical analysis.',
          '',
          '{{_upstream}}',
          '',
          'Produce a technical analysis with these sections:',
          '',
          '## Code Overview',
          'What the code does, its purpose, and how it fits into the larger system.',
          '',
          '## Key Patterns & Architecture',
          'Design patterns used, architecture decisions, important abstractions.',
          '',
          '## Dependencies',
          'External libraries, services, APIs, and internal modules this code depends on.',
          '',
          '## Entry Points & Interfaces',
          'Public APIs, endpoints, event handlers, or other entry points.',
          '',
          '## Technical Debt & Concerns',
          'Any code smells, potential issues, or areas that need attention.',
          '',
          'Reference specific files and line patterns from the search results. Be precise and technical.',
        ].join('\\n'),
      },
      {
        id: 'code-implementation',
        title: 'Code Implementation',
        description: 'Generates implementation code from requirements and codebase context. Outputs complete file changes with no truncation.',
        category: 'Code Analysis',
        prompt: [
          'You are a senior software engineer. Implement EXACTLY what the upstream requirements ask for.',
          '',
          'CRITICAL RULES:',
          '- Read the requirements carefully. That is the task to implement.',
          '- Codebase context shows existing code for reference only.',
          '- Do NOT fix bugs, refactor, or change anything not explicitly requested.',
          '- ONLY use file paths from the codebase context. NEVER invent file paths.',
          '',
          '{{_upstream}}',
          '',
          'Output your implementation in this format:',
          '',
          '## Summary',
          'A brief description of what was implemented and why.',
          '',
          '## Changes',
          'For each file changed:',
          '',
          'File: relative/path/from/repo/root.ext',
          'Then a fenced code block with the complete file content.',
          '',
          'Code blocks must contain ONLY the final source code. Never use diff format.',
          'CRITICAL — NO TRUNCATION: Output the complete code for every file. NEVER use placeholder comments.',
        ].join('\\n'),
      },
      {
        id: 'migration-guide',
        title: 'Migration Guide',
        description: 'Generates a step-by-step migration guide from code search results, identifying what needs to change and how.',
        category: 'Code Analysis',
        prompt: [
          'You are a senior software engineer creating a migration guide. Analyze the upstream code search results and produce a step-by-step migration plan.',
          '',
          '{{_upstream}}',
          '',
          'Produce a migration guide with these sections:',
          '',
          '## Migration Overview',
          'What is being migrated and why.',
          '',
          '## Affected Files & Systems',
          'A numbered list of every file/system that needs changes, with:',
          '- File path / system name',
          '- What needs to change',
          '- Risk level (high/medium/low)',
          '',
          '## Step-by-Step Migration',
          'Ordered steps to complete the migration. Each step should include:',
          '1. What to do',
          '2. Code changes needed (show before/after)',
          '3. How to verify the step was successful',
          '',
          '## Rollback Plan',
          'How to revert if something goes wrong.',
          '',
          '## Testing Checklist',
          'Tests to run after migration to verify everything works.',
          '',
          'Reference specific files and code from the upstream results.',
        ].join('\\n'),
      },
      // ── Ticket Generation ───────────────────────────────────────────
      {
        id: 'ticket-generator',
        title: 'Generate Jira Tickets',
        description: 'Generates implementation-ready Jira tickets as JSON from a spec and optional codebase context. Each ticket includes summary, description, and full code changes.',
        category: 'Ticket Generation',
        prompt: [
          'You are a senior technical PM. Generate Jira tickets from the provided upstream context.',
          '',
          '{{_upstream}}',
          '',
          'Return STRICT JSON only in one of these formats:',
          '1) {"tickets":[{...}]}',
          '2) [{...}]',
          '',
          'Each ticket object must contain:',
          '- "summary": short title',
          '- "description": detailed implementation-ready description',
          '- "labels": array of strings (optional)',
          '- "components": array of strings (optional)',
          '',
          'Include a technical work section with exact code changes. For each file change:',
          '',
          'File: relative/path/from/repo/root.ext',
          'Then a fenced code block with the complete file content.',
          '',
          'Code blocks must contain ONLY the final source code. Never use diff format.',
          'CRITICAL — NO TRUNCATION: Output complete code for every file.',
          'Tickets should be sequenced logically and split into actionable units.',
        ].join('\\n'),
      },
      {
        id: 'ticket-analysis',
        title: 'Ticket Analysis & Search',
        description: 'Analyzes a Jira ticket to identify gaps and ambiguities, then suggests JQL search queries to find related context.',
        category: 'Ticket Generation',
        prompt: [
          'You are a senior technical analyst reviewing a Jira ticket. Your job is to:',
          '1. Analyze the ticket contents and identify gaps, ambiguities, or areas that need more detail.',
          '2. Output a JQL search query that will find the most relevant related tickets.',
          '3. Provide an initial analysis of the ticket.',
          '',
          '{{_upstream}}',
          '',
          'Output your response in this exact format:',
          '',
          'SEARCH_JQL: project = "PROJECT_KEY" AND text ~ "your search terms here" ORDER BY updated DESC',
          '',
          'INITIAL_ANALYSIS:',
          '(your analysis of the ticket — what it covers, what is missing, what needs clarification)',
        ].join('\\n'),
      },
      {
        id: 'ticket-refinement',
        title: 'Refine Ticket Description',
        description: 'Synthesizes ticket content, AI analysis, image analysis, and related tickets into an improved, comprehensive ticket description.',
        category: 'Ticket Generation',
        prompt: [
          'You are a senior technical analyst. Synthesize all the upstream information into a comprehensive, refined ticket description.',
          '',
          '{{_upstream}}',
          '',
          'Write an improved, thorough ticket description in markdown that:',
          '- Preserves the original intent and requirements',
          '- Fills in gaps identified in the analysis',
          '- Incorporates relevant context from related tickets',
          '- Weaves image/screenshot insights into relevant sections',
          '- Adds acceptance criteria if missing',
          '- Adds technical considerations or dependencies',
          '- Uses clear structure with headers, bullet points, and sections',
          '',
          'Output ONLY the improved description text — no preamble or explanation.',
        ].join('\\n'),
      },
      // ── Incident & Impact ───────────────────────────────────────────
      {
        id: 'incident-response',
        title: 'Incident Response Assessment',
        description: 'Produces a structured incident report with severity assessment, impacted systems, root cause analysis, and remediation steps.',
        category: 'Incident & Impact',
        prompt: [
          'You are an incident response analyst. Assess the following incident and produce a structured incident report.',
          '',
          '{{_upstream}}',
          '',
          'Produce a structured report with these sections:',
          '',
          '## Incident Summary',
          'Brief description of the incident.',
          '',
          '## Severity Assessment',
          'Severity level (P1-P4) with justification based on the evidence.',
          '',
          '## Impacted Systems',
          'Numbered list of affected systems/services with evidence.',
          '',
          '## Root Cause Analysis',
          'Probable root cause based on available evidence. State clearly if this is speculative.',
          '',
          '## Remediation Steps',
          'Numbered priority-ordered steps to resolve the incident.',
          '',
          '## Runbook References',
          'Relevant documentation for responders.',
          '',
          '## Communication Plan',
          'Who needs to be notified and when.',
        ].join('\\n'),
      },
      {
        id: 'change-impact-analysis',
        title: 'Change Impact Analysis',
        description: 'Produces a risk-scored impact matrix from search results, with dependency chains and rollout plan.',
        category: 'Incident & Impact',
        prompt: [
          'You are a change impact analyst. Compile all upstream findings into a comprehensive impact analysis.',
          '',
          '{{_upstream}}',
          '',
          'Produce an impact analysis with:',
          '',
          '## Change Overview',
          'What is being changed and why.',
          '',
          '## Impact Matrix',
          'Table of impacted systems with:',
          '| System | Repository | Impact Type | Risk Level | Details |',
          '',
          '## Risk Assessment',
          'Overall risk level with justification.',
          '',
          '## Dependency Chain',
          'How the change cascades through systems.',
          '',
          '## Recommended Rollout Plan',
          'Phased approach with rollback points.',
          '',
          '## Stakeholder Notifications',
          'Who needs to know, organized by team.',
          '',
          'Base everything on upstream evidence. Mark speculation clearly.',
        ].join('\\n'),
      },
      // ── Reporting ───────────────────────────────────────────────────
      {
        id: 'sprint-report',
        title: 'Sprint Report',
        description: 'Generates a sprint summary from completed and in-progress tickets, with velocity metrics and recommendations.',
        category: 'Reporting',
        prompt: [
          'You are a scrum master generating a sprint report. Analyze the upstream ticket data and produce a comprehensive sprint summary.',
          '',
          '{{_upstream}}',
          '',
          'Generate a sprint report with these sections:',
          '',
          '## Sprint Summary',
          'Overview of what was accomplished vs. planned.',
          '',
          '## Completed Work',
          'Categorized list of completed items grouped by type (feature, bug fix, tech debt, etc.).',
          '',
          '## Velocity & Metrics',
          '- Tickets completed vs. carried over',
          '- Completion rate percentage',
          '- Priority distribution',
          '',
          '## Carry-Over Items',
          'Work that did not finish this sprint with brief reason assessment.',
          '',
          '## Patterns & Observations',
          'Trends, blockers, or recurring themes the team should discuss.',
          '',
          '## Recommendations',
          'Actionable suggestions for the next sprint.',
        ].join('\\n'),
      },
      // ── General Purpose ─────────────────────────────────────────────
      {
        id: 'summarize',
        title: 'Summarize Content',
        description: 'A simple, general-purpose summarizer. Takes any upstream content and produces a concise summary with key takeaways.',
        category: 'General Purpose',
        prompt: [
          'Summarize the following content concisely.',
          '',
          '{{_upstream}}',
          '',
          'Produce:',
          '## Summary',
          'A concise overview of the content.',
          '',
          '## Key Takeaways',
          'Bullet points of the most important points.',
          '',
          '## Open Questions',
          'Any unresolved questions or areas that need further investigation.',
        ].join('\\n'),
      },
      {
        id: 'resource-discovery',
        title: 'Resource Discovery',
        description: 'Generates a curated list of resources, documentation, and learning paths to explore when trying to understand a technical process or system.',
        category: 'General Purpose',
        prompt: [
          'You are a senior technical advisor. Based on the upstream context, generate a curated list of resources and areas to explore.',
          '',
          '{{_upstream}}',
          '',
          'Produce a resource discovery guide with these sections:',
          '',
          '## Topic Overview',
          'Brief description of what we are trying to understand.',
          '',
          '## Key Concepts to Learn',
          'Numbered list of core concepts, with a one-line explanation of each.',
          '',
          '## Documentation to Read',
          'Specific documentation, guides, or reference material that would help. For each:',
          '- What it covers',
          '- Why it is relevant',
          '- What to focus on',
          '',
          '## Code Areas to Explore',
          'If code search results are available, list the specific files/modules to study:',
          '- File/module path',
          '- What it teaches about the system',
          '- Key patterns to observe',
          '',
          '## Suggested Learning Path',
          'Ordered sequence of steps to build understanding, from basics to advanced.',
          '',
          '## People & Teams to Consult',
          'If identifiable from the data, who might have expertise in this area.',
        ].join('\\n'),
      },
      {
        id: 'bug-root-cause',
        title: 'Bug Root Cause Analysis',
        description: 'Analyzes a bug report with code context to identify probable root causes, affected code paths, and suggested fixes.',
        category: 'General Purpose',
        prompt: [
          'You are a senior software engineer debugging an issue. Analyze the upstream bug report and any code context to identify the root cause.',
          '',
          '{{_upstream}}',
          '',
          'Produce a root cause analysis with these sections:',
          '',
          '## Bug Summary',
          'What the bug is and how it manifests.',
          '',
          '## Reproduction Path',
          'Steps to reproduce, based on the description and code analysis.',
          '',
          '## Probable Root Cause',
          'The most likely cause, with evidence from the code. Rank multiple candidates if uncertain.',
          '',
          '## Affected Code Paths',
          'Specific files, functions, and code flows involved.',
          '',
          '## Suggested Fix',
          'Recommended code changes to resolve the issue. Show specific code if possible.',
          '',
          '## Testing Recommendations',
          'How to verify the fix works and prevent regression.',
          '',
          'Be precise. Reference specific code from the upstream data.',
        ].join('\\n'),
      },
      {
        id: 'architecture-summary',
        title: 'Architecture Summary',
        description: 'Produces an architecture overview from code search results, documenting system structure, data flows, and integration points.',
        category: 'Code Analysis',
        prompt: [
          'You are a solutions architect. Analyze the upstream code search results and produce an architecture summary.',
          '',
          '{{_upstream}}',
          '',
          'Produce an architecture summary with these sections:',
          '',
          '## System Overview',
          'High-level description of what this system/service does.',
          '',
          '## Component Structure',
          'Key components/modules and their responsibilities.',
          '',
          '## Data Flow',
          'How data moves through the system — inputs, transformations, outputs.',
          '',
          '## Integration Points',
          'External services, APIs, databases, message queues, or other systems this connects to.',
          '',
          '## Configuration & Environment',
          'Key configuration files, environment variables, and feature flags.',
          '',
          '## Deployment & Infrastructure',
          'How the system is deployed (if discernible from the code).',
          '',
          'Reference specific files and code patterns from the search results.',
        ].join('\\n'),
      },
    ];

    function getPromptLibraryCategories() {
      var cats = [];
      PROMPT_LIBRARY.forEach(function(p) {
        if (cats.indexOf(p.category) === -1) cats.push(p.category);
      });
      return cats;
    }

    // --- Prompt Picker Logic ---
    var promptPickerModal = document.getElementById('promptPickerModal');
    var promptPickerSearch = document.getElementById('promptPickerSearch');
    var promptPickerTabs = document.getElementById('promptPickerTabs');
    var promptPickerList = document.getElementById('promptPickerList');
    var promptPickerPreview = document.getElementById('promptPickerPreview');
    var promptPickerPreviewTitle = document.getElementById('promptPickerPreviewTitle');
    var promptPickerPreviewDesc = document.getElementById('promptPickerPreviewDesc');
    var promptPickerSelectedId = null;
    var promptPickerActiveCategory = 'All';

    function renderPromptPickerTabs(cats) {
      var all = ['All'].concat(cats);
      promptPickerTabs.innerHTML = all.map(function(c) {
        var active = c === promptPickerActiveCategory;
        return '<button type="button" style="padding:6px 12px;font-size:11px;border:none;border-bottom:2px solid ' + (active ? '#4f7cff' : 'transparent') + ';background:transparent;color:' + (active ? '#e8eaf0' : '#8f98af') + ';cursor:pointer;white-space:nowrap;font-weight:' + (active ? '700' : '400') + ';" data-cat="' + c + '">' + c + '</button>';
      }).join('');
      promptPickerTabs.querySelectorAll('button').forEach(function(btn) {
        btn.addEventListener('click', function() {
          promptPickerActiveCategory = btn.getAttribute('data-cat') || 'All';
          renderPromptPickerTabs(cats);
          renderPromptPickerList();
        });
      });
    }

    function renderPromptPickerList() {
      var search = (promptPickerSearch.value || '').toLowerCase();
      var filtered = PROMPT_LIBRARY.filter(function(p) {
        if (promptPickerActiveCategory !== 'All' && p.category !== promptPickerActiveCategory) return false;
        if (search && p.title.toLowerCase().indexOf(search) === -1 && p.description.toLowerCase().indexOf(search) === -1 && p.category.toLowerCase().indexOf(search) === -1) return false;
        return true;
      });
      // Group by category
      var grouped = {};
      filtered.forEach(function(p) {
        if (!grouped[p.category]) grouped[p.category] = [];
        grouped[p.category].push(p);
      });
      var html = '';
      var cats = getPromptLibraryCategories();
      cats.forEach(function(cat) {
        if (!grouped[cat]) return;
        if (promptPickerActiveCategory === 'All') {
          html += '<li class="prompt-picker-cat-header">' + cat + '</li>';
        }
        grouped[cat].forEach(function(p) {
          var sel = p.id === promptPickerSelectedId ? ' selected' : '';
          html += '<li class="' + sel + '" data-prompt-id="' + p.id + '"><div class="prompt-picker-title">' + p.title + '</div><div class="prompt-picker-desc">' + p.description + '</div></li>';
        });
      });
      if (!html) {
        html = '<li style="padding:20px 14px;color:#6f7a92;font-size:13px;">No prompts match your search.</li>';
      }
      promptPickerList.innerHTML = html;
      promptPickerList.querySelectorAll('li[data-prompt-id]').forEach(function(li) {
        li.addEventListener('click', function() {
          promptPickerSelectedId = li.getAttribute('data-prompt-id');
          renderPromptPickerList();
          showPromptPreview(promptPickerSelectedId);
        });
      });
      // Auto-select first if nothing selected
      if (!promptPickerSelectedId && filtered.length > 0) {
        promptPickerSelectedId = filtered[0].id;
        renderPromptPickerList();
        showPromptPreview(promptPickerSelectedId);
      }
    }

    function showPromptPreview(id) {
      var p = PROMPT_LIBRARY.find(function(x) { return x.id === id; });
      if (!p) {
        promptPickerPreviewTitle.textContent = '';
        promptPickerPreviewDesc.textContent = '';
        promptPickerPreview.textContent = '';
        return;
      }
      promptPickerPreviewTitle.textContent = p.title;
      promptPickerPreviewDesc.textContent = p.description;
      promptPickerPreview.textContent = p.prompt;
    }

    function openPromptPicker() {
      promptPickerSelectedId = null;
      promptPickerActiveCategory = 'All';
      promptPickerSearch.value = '';
      var cats = getPromptLibraryCategories();
      renderPromptPickerTabs(cats);
      renderPromptPickerList();
      promptPickerModal.style.display = 'flex';
      promptPickerSearch.focus();
    }

    function closePromptPicker() {
      promptPickerModal.style.display = 'none';
    }

    document.getElementById('promptPickerClose').addEventListener('click', closePromptPicker);
    document.getElementById('promptPickerCancel').addEventListener('click', closePromptPicker);
    promptPickerModal.addEventListener('click', function(e) { if (e.target === promptPickerModal) closePromptPicker(); });

    promptPickerSearch.addEventListener('input', function() {
      promptPickerSelectedId = null;
      renderPromptPickerList();
    });

    document.getElementById('promptPickerInsert').addEventListener('click', function() {
      if (!promptPickerSelectedId) return;
      var p = PROMPT_LIBRARY.find(function(x) { return x.id === promptPickerSelectedId; });
      if (!p) return;
      var node = getSelectedNode();
      if (!node) { closePromptPicker(); return; }
      node.config = node.config || {};
      node.config.prompt = p.prompt;
      var ta = nodeForm.querySelector('textarea[data-field-key="prompt"]');
      if (ta) ta.value = p.prompt;
      syncNodeConfigText();
      closePromptPicker();
    });

    function syncNodeConfigText() {
      const node = getSelectedNode();
      if (!node) {
        nodeConfig.value = '';
        return;
      }
      nodeConfig.value = JSON.stringify(node.config || {}, null, 2);
    }

    function updateNodeConfigError() {
      if (nodeEditorTab !== 'json' || !nodeConfigParseError) {
        nodeConfigError.style.display = 'none';
        nodeConfigError.textContent = '';
        return;
      }
      nodeConfigError.style.display = 'block';
      nodeConfigError.textContent = nodeConfigParseError;
    }

    function setNodeEditorTab(tab) {
      nodeEditorTab = tab === 'json' ? 'json' : 'form';
      const onForm = nodeEditorTab === 'form';
      nodeForm.style.display = onForm ? 'block' : 'none';
      nodeConfig.style.display = onForm ? 'none' : 'block';
      nodeFormTab.className = onForm ? '' : 'secondary';
      nodeJsonTab.className = onForm ? 'secondary' : '';
      applyNodeBtn.style.display = onForm ? 'none' : '';
      updateNodeConfigError();
    }

    function renderNodeFormFields() {
      const node = getSelectedNode();
      if (!node) {
        nodeForm.innerHTML = '<div class="muted">Select a node to edit fields.</div>';
        return;
      }

      const definition = getNodeDefinition(node.type);
      if (!definition || !Array.isArray(definition.configSchema) || definition.configSchema.length === 0) {
        nodeForm.innerHTML = '<div class="muted">No field schema available for this node type. Use JSON tab.</div>';
        return;
      }

      // Helper: resolve {{vars.X}} and {{nodeId.field}} references to show preview
      function resolvedBadge(val) {
        if (val == null) return '';
        var s = String(val);
        var refs = s.match(/\{\{([^}]+)\}\}/g);
        if (!refs || refs.length === 0) return '';
        var currentVars;
        try { currentVars = JSON.parse(variablesEl.value || '{}'); } catch (_) { currentVars = {}; }
        var parts = [];
        for (var ri = 0; ri < refs.length; ri++) {
          var token = refs[ri].slice(2, -2).trim();
          var resolved = '';
          if (token.startsWith('vars.')) {
            var vk = token.slice(5);
            resolved = currentVars[vk] != null ? String(currentVars[vk]) : '';
          } else {
            // nodeId.field — look up in last execution outputs if available
            resolved = '';
          }
          if (resolved) {
            var preview = resolved.length > 80 ? resolved.slice(0, 77) + '...' : resolved;
            parts.push('<span style="color:#6b7394;font-size:10px;" title="' + escapeHtml(resolved) + '">' + escapeHtml(refs[ri]) + '</span> <span style="color:#4f7cff;font-size:10px;">&rarr; ' + escapeHtml(preview) + '</span>');
          }
        }
        if (parts.length === 0) return '';
        return '<div style="margin-top:2px;padding:3px 6px;background:#1a1f2e;border-radius:4px;border:1px solid #272b36;font-size:10px;line-height:1.5;">' + parts.join('<br/>') + '</div>';
      }

      const blocks = definition.configSchema.map((field) => {
        const key = String(field.key || '');
        const fieldType = String(field.type || 'string');
        const rawLabel = String(field.label || key);
        const label = escapeHtml(rawLabel);
        const rawValue = (node.config || {})[key];
        const placeholder = field.placeholder == null ? '' : String(field.placeholder);
        const hasDefault = field.defaultValue !== undefined;
        const helperParts = [];
        helperParts.push('Type: ' + fieldType);
        if (field.required) helperParts.push('Required');
        if (hasDefault) helperParts.push('Default: ' + JSON.stringify(field.defaultValue));
        if (placeholder) helperParts.push('Hint: ' + placeholder);
        const helper = '<div class="muted" style="margin-top:4px;">' + escapeHtml(helperParts.join(' · ')) + '</div>';
        const badge = resolvedBadge(rawValue);
        const requiredBadge = field.required ? ' <span class="muted">*</span>' : '';
        const hintIcon = field.hint
          ? ' <span class="hint-wrap"><span class="hint-icon" data-hint="' + escapeHtml(field.hint) + '">?</span></span>'
          : '';

        if (fieldType === 'boolean') {
          const checked = rawValue ? ' checked' : '';
          return '<div class="field-label-row"><label class="muted">'
            + '<input data-node-field="1" data-field-key="' + escapeHtml(key) + '" data-field-type="boolean" type="checkbox"' + checked + ' /> '
            + label
            + requiredBadge
            + '</label>' + hintIcon + '</div>';
        }

        if (Array.isArray(field.options) && field.options.length > 0) {
          const selValue = rawValue == null ? '' : String(rawValue);
          const opts = field.options.map((o) => {
            const optVal = String(o);
            const selected = selValue === optVal ? ' selected' : '';
            return '<option value="' + escapeHtml(optVal) + '"' + selected + '>' + escapeHtml(optVal) + '</option>';
          }).join('');
          const allowCustom = selValue && !field.options.includes(selValue);
          const customOpt = allowCustom
            ? '<option value="' + escapeHtml(selValue) + '" selected>' + escapeHtml(selValue) + '</option>'
            : '';
          return '<div class="field-label-row"><label class="muted">' + label + requiredBadge + '</label>' + hintIcon + '</div>'
            + '<select data-node-field="1" data-field-key="' + escapeHtml(key) + '" data-field-type="' + escapeHtml(fieldType) + '" style="margin-top:4px;">'
            + opts + customOpt
            + '</select>'
            + badge + helper;
        }

        if (fieldType === 'json') {
          const jsonValue = rawValue == null ? '' : JSON.stringify(rawValue, null, 2);
          return '<div class="field-label-row"><label class="muted">' + label + requiredBadge + '</label>' + hintIcon + '</div>'
            + '<textarea data-node-field="1" data-field-key="' + escapeHtml(key) + '" data-field-type="json" style="margin-top:4px;">'
            + escapeHtml(jsonValue)
            + '</textarea>'
            + badge + helper;
        }

        const isNumber = fieldType === 'number';
        const isMultiline = Boolean(field.multiline);
        const value = rawValue == null ? '' : String(rawValue);
        const placeholderAttr = placeholder ? (' placeholder="' + escapeHtml(placeholder) + '"') : '';

        if (isMultiline && !isNumber) {
          var promptPickerBtn = '';
          if (key === 'prompt' && node.type === 'ai.runPrompt') {
            promptPickerBtn = ' <button type="button" class="secondary prompt-library-btn" style="font-size:10px;padding:2px 8px;margin-left:6px;vertical-align:middle;">Browse Prompts</button>';
          }
          return '<div class="field-label-row"><label class="muted">' + label + requiredBadge + '</label>' + hintIcon + promptPickerBtn + '</div>'
            + '<textarea data-node-field="1" data-field-key="' + escapeHtml(key) + '" data-field-type="' + escapeHtml(fieldType) + '"' + placeholderAttr + ' style="margin-top:4px;" class="autocomplete-field">'
            + escapeHtml(value)
            + '</textarea>'
            + badge + helper;
        }

        const hasTemplateRef = value.indexOf('{{') !== -1;
        const inputType = (isNumber && !hasTemplateRef) ? 'number' : 'text';
        return '<div class="field-label-row"><label class="muted">' + label + requiredBadge + '</label>' + hintIcon + '</div>'
          + '<input data-node-field="1" data-field-key="' + escapeHtml(key) + '" data-field-type="' + escapeHtml(fieldType) + '" type="' + inputType + '" value="' + escapeHtml(value) + '"' + placeholderAttr + ' style="margin-top:4px;" class="autocomplete-field" />'
          + badge + helper;
      });

      nodeForm.innerHTML = blocks.join('');

      nodeForm.querySelectorAll('[data-node-field="1"]').forEach((el) => {
        const fieldType = el.getAttribute('data-field-type') || 'string';
        const isSelect = el.tagName === 'SELECT';
        const eventName = fieldType === 'json' || fieldType === 'boolean' || isSelect ? 'change' : 'input';
        el.addEventListener(eventName, () => {
          const nodeNow = getSelectedNode();
          if (!nodeNow) return;

          const key = el.getAttribute('data-field-key') || '';
          if (!key) return;

          try {
            let parsedValue = null;
            if (fieldType === 'boolean') {
              parsedValue = Boolean(el.checked);
            } else if (fieldType === 'number') {
              const txt = String(el.value || '').trim();
              parsedValue = txt.length === 0 ? null : Number(txt);
            } else if (fieldType === 'json') {
              const txt = String(el.value || '').trim();
              parsedValue = txt.length === 0 ? null : JSON.parse(txt);
            } else {
              parsedValue = String(el.value || '');
            }

            nodeNow.config = nodeNow.config || {};
            nodeNow.config[key] = parsedValue;
            nodeConfigParseError = '';
            syncNodeConfigText();
            updateNodeConfigError();
          } catch (error) {
            nodeConfigParseError = 'Form parse error: ' + String(error);
            updateNodeConfigError();
          }
        });
      });

      initAutocomplete();
      initHintTooltips();

      // Wire Browse Prompts button
      nodeForm.querySelectorAll('.prompt-library-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          openPromptPicker();
        });
      });
    }

    const hintTooltipEl = document.createElement('div');
    hintTooltipEl.className = 'hint-tooltip';
    document.body.appendChild(hintTooltipEl);

    function initHintTooltips(container) {
      (container || nodeForm).querySelectorAll('.hint-icon[data-hint]').forEach((icon) => {
        icon.addEventListener('mouseenter', () => {
          const text = icon.getAttribute('data-hint') || '';
          if (!text) return;
          hintTooltipEl.textContent = text;
          hintTooltipEl.style.display = 'block';
          const rect = icon.getBoundingClientRect();
          const tipWidth = 280;
          let left = rect.left + rect.width / 2 - tipWidth / 2;
          left = Math.max(8, Math.min(left, window.innerWidth - tipWidth - 8));
          let top = rect.top - 8;
          hintTooltipEl.style.left = left + 'px';
          hintTooltipEl.style.width = tipWidth + 'px';
          // measure height then position above
          hintTooltipEl.style.top = '0px';
          const tipH = hintTooltipEl.offsetHeight;
          top = rect.top - tipH - 8;
          if (top < 4) top = rect.bottom + 8; // flip below if no room above
          hintTooltipEl.style.top = top + 'px';
        });
        icon.addEventListener('mouseleave', () => {
          hintTooltipEl.style.display = 'none';
        });
      });
    }

    let activeAutocomplete = null; // { el, popup, activeIndex }

    function getUpstreamNodeIds(nodeId) {
      // Walk edges backward to find all upstream (ancestor) node IDs
      var upstream = new Set();
      var queue = [nodeId];
      while (queue.length > 0) {
        var current = queue.shift();
        (graph.edges || []).forEach(function(e) {
          if (e.to === current && !upstream.has(e.from)) {
            upstream.add(e.from);
            queue.push(e.from);
          }
        });
      }
      return upstream;
    }

    function getDirectUpstreamIds(nodeId) {
      var direct = new Set();
      (graph.edges || []).forEach(function(e) {
        if (e.to === nodeId) direct.add(e.from);
      });
      return direct;
    }

    function getAvailableRefs(forNodeId) {
      const upstream = getUpstreamNodeIds(forNodeId);
      const direct = getDirectUpstreamIds(forNodeId);

      // Collect refs into priority buckets: direct upstream → other upstream → variables → rest
      var directRefs = [];
      var indirectRefs = [];
      var varRefs = [];
      var otherRefs = [];

      for (const node of graph.nodes) {
        if (node.id === forNodeId) continue;
        const def = getNodeDefinition(node.type);
        if (!def || !def.outputSchema) continue;
        const nodeTitle = def.title || node.type;
        const isDirect = direct.has(node.id);
        const isUp = upstream.has(node.id);
        for (const output of def.outputSchema) {
          var entry = {
            ref: node.id + '.' + output.key,
            type: output.type,
            description: output.description || '',
            nodeId: node.id,
            nodeTitle: nodeTitle,
            isUpstream: isUp,
            isDirect: isDirect,
          };
          if (isDirect) directRefs.push(entry);
          else if (isUp) indirectRefs.push(entry);
          else otherRefs.push(entry);
        }
      }

      // Variables last among upstream since they're always available
      try {
        const vars = JSON.parse(variablesEl.value || '{}');
        for (const key of Object.keys(vars)) {
          varRefs.push({ ref: 'vars.' + key, type: typeof vars[key], description: 'Variable', nodeId: 'vars', nodeTitle: 'Variables', isUpstream: true, isDirect: false });
        }
      } catch (_e) { /* ignore parse errors */ }

      return directRefs.concat(indirectRefs).concat(varRefs).concat(otherRefs);
    }

    function showAutocompletePopup(el, filter) {
      closeAutocomplete();
      const node = getSelectedNode();
      if (!node) return;

      const allRefs = getAvailableRefs(node.id);
      const lower = (filter || '').toLowerCase();
      const filtered = lower
        ? allRefs.filter(r => r.ref.toLowerCase().includes(lower) || (r.description || '').toLowerCase().includes(lower))
        : allRefs;

      if (filtered.length === 0) return;

      const popup = document.createElement('div');
      popup.className = 'autocomplete-popup';

      // Show section headers as the priority group changes
      var lastSection = '';

      filtered.forEach((item, idx) => {
        var section = item.isDirect ? 'direct' : item.isUpstream && item.nodeId !== 'vars' ? 'upstream' : item.nodeId === 'vars' ? 'vars' : 'other';
        if (section !== lastSection && lastSection !== '') {
          var sep = document.createElement('div');
          sep.style.cssText = 'padding:2px 8px;font-size:9px;color:#6b7394;border-top:1px solid #272b36;text-transform:uppercase;letter-spacing:0.5px;';
          sep.textContent = section === 'upstream' ? 'Other upstream' : section === 'vars' ? 'Variables' : section === 'other' ? 'Other nodes' : '';
          if (sep.textContent) popup.appendChild(sep);
        }
        lastSection = section;
        const row = document.createElement('div');
        row.className = 'autocomplete-item' + (idx === 0 ? ' active' : '');
        var nodeLabel = item.nodeTitle && item.nodeId !== 'vars' ? '<span style="color:#a78bfa;font-size:10px;">' + escapeHtml(item.nodeTitle) + '</span> ' : '';
        row.innerHTML = '<div>' + nodeLabel + '<span class="ref-key">{{' + escapeHtml(item.ref) + '}}</span> <span class="ref-type">' + escapeHtml(item.type) + '</span>'
          + (item.description ? '<span class="ref-desc">' + escapeHtml(item.description) + '</span>' : '')
          + '</div>';
        row.addEventListener('mousedown', (event) => {
          event.preventDefault();
          insertAutocompleteRef(el, item.ref);
        });
        popup.appendChild(row);
      });

      // Position popup below the field
      const rect = el.getBoundingClientRect();
      const panelRight = el.closest('.panel-right');
      const panelRect = panelRight ? panelRight.getBoundingClientRect() : document.body.getBoundingClientRect();
      popup.style.position = 'fixed';
      popup.style.left = rect.left + 'px';
      popup.style.top = rect.bottom + 'px';
      popup.style.maxWidth = (panelRect.right - rect.left) + 'px';

      document.body.appendChild(popup);
      activeAutocomplete = { el, popup, activeIndex: 0, items: filtered };
    }

    function closeAutocomplete() {
      if (activeAutocomplete) {
        activeAutocomplete.popup.remove();
        activeAutocomplete = null;
      }
    }

    function insertAutocompleteRef(el, ref) {
      const val = el.value || '';
      const cursorPos = el.selectionStart || val.length;

      // Find the start of the {{ before cursor
      const before = val.slice(0, cursorPos);
      const braceStart = before.lastIndexOf('{{');
      if (braceStart < 0) {
        closeAutocomplete();
        return;
      }

      const after = val.slice(cursorPos);
      const insertion = '{{' + ref + '}}';
      // Check if there's already a closing }}
      const closingIdx = after.indexOf('}}');
      const afterSlice = closingIdx >= 0 ? after.slice(closingIdx + 2) : after;

      el.value = val.slice(0, braceStart) + insertion + afterSlice;
      const newPos = braceStart + insertion.length;
      el.setSelectionRange(newPos, newPos);
      el.focus();

      // Trigger input event to save
      el.dispatchEvent(new Event('input', { bubbles: true }));
      closeAutocomplete();
    }

    function handleAutocompleteKeydown(event) {
      if (!activeAutocomplete) return;
      const items = activeAutocomplete.items;
      const rows = activeAutocomplete.popup.querySelectorAll('.autocomplete-item');

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        activeAutocomplete.activeIndex = Math.min(activeAutocomplete.activeIndex + 1, items.length - 1);
        rows.forEach((r, i) => r.classList.toggle('active', i === activeAutocomplete.activeIndex));
        rows[activeAutocomplete.activeIndex]?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        activeAutocomplete.activeIndex = Math.max(activeAutocomplete.activeIndex - 1, 0);
        rows.forEach((r, i) => r.classList.toggle('active', i === activeAutocomplete.activeIndex));
        rows[activeAutocomplete.activeIndex]?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' || event.key === 'Tab') {
        if (items[activeAutocomplete.activeIndex]) {
          event.preventDefault();
          insertAutocompleteRef(activeAutocomplete.el, items[activeAutocomplete.activeIndex].ref);
        }
      } else if (event.key === 'Escape') {
        closeAutocomplete();
      }
    }

    function initAutocomplete() {
      nodeForm.querySelectorAll('.autocomplete-field').forEach((el) => {
        el.addEventListener('input', () => {
          const val = el.value || '';
          const cursorPos = el.selectionStart || val.length;
          const before = val.slice(0, cursorPos);
          const braceStart = before.lastIndexOf('{{');

          if (braceStart >= 0) {
            const between = before.slice(braceStart + 2);
            // Only show if we're still inside an unclosed {{
            if (!between.includes('}}')) {
              showAutocompletePopup(el, between.trim());
              return;
            }
          }
          closeAutocomplete();
        });

        el.addEventListener('keydown', handleAutocompleteKeydown);
        el.addEventListener('blur', () => {
          // Small delay to allow mousedown on popup to fire first
          setTimeout(closeAutocomplete, 150);
        });
      });
    }

    function renderNodeEditor() {
      const node = getSelectedNode();
      const useCaseEl = document.getElementById('selectedNodeUseCase');
      if (!node) {
        selectedMeta.textContent = 'None selected.';
        nodeForm.innerHTML = '<div class="muted">Select a node to edit fields.</div>';
        nodeConfig.value = '';
        nodeConfigParseError = '';
        if (useCaseEl) useCaseEl.style.display = 'none';
        updateNodeConfigError();
        return;
      }

      const refs = extractNodeRefs(node);
      const refsInfo = refs.length > 0
        ? '<br/><span class="muted">Reads from: ' + refs.map(r => '<code>{{' + escapeHtml(r) + '}}</code>').join(', ') + '</span>'
        : '';
      const stateInfo = nodeStates[node.id] ? ' [' + nodeStates[node.id] + ']' : '';
      const def = getNodeDefinition(node.type);
      const outputInfo = def && def.outputSchema && def.outputSchema.length > 0
        ? '<br/><span class="muted">This node outputs: ' + def.outputSchema.map(o => '<code style="cursor:pointer;user-select:all;" title="Click to copy">{{' + escapeHtml(node.id + '.' + o.key) + '}}</code> <span style="color:#6f7a92;">(' + escapeHtml(o.type) + ')</span>').join(', ') + '</span>'
        : '';

      // Build "Available Inputs" from upstream connected nodes
      var upstreamIds = getUpstreamNodeIds(node.id);
      var inputLines = [];
      upstreamIds.forEach(function(uid) {
        var upNode = graph.nodes.find(function(n) { return n.id === uid; });
        if (!upNode) return;
        var upDef = getNodeDefinition(upNode.type);
        if (!upDef || !upDef.outputSchema || upDef.outputSchema.length === 0) return;
        var nodeLabel = upDef.title || upNode.type;
        var outputRefs = upDef.outputSchema.map(function(o) {
          return '<code style="cursor:pointer;user-select:all;" title="Click to copy">{{' + escapeHtml(upNode.id + '.' + o.key) + '}}</code>';
        }).join(', ');
        inputLines.push('<span style="color:#a78bfa;">' + escapeHtml(nodeLabel) + '</span> <span style="color:#6b7394;">(' + escapeHtml(upNode.id) + ')</span>: ' + outputRefs);
      });
      var inputsInfo = inputLines.length > 0
        ? '<br/><details style="margin-top:4px;"><summary style="cursor:pointer;font-size:11px;color:#8f98af;user-select:none;">Available from upstream (' + inputLines.length + ' node' + (inputLines.length === 1 ? '' : 's') + ') — type <code style="font-size:10px;">{{</code> in any field</summary><div style="font-size:11px;line-height:1.6;margin-top:2px;padding:4px 6px;background:#141821;border-radius:4px;border:1px solid #272b36;">' + inputLines.join('<br/>') + '</div></details>'
        : '';

      selectedMeta.innerHTML = escapeHtml(node.id + ' (' + node.type + ')' + stateInfo) + refsInfo + outputInfo + inputsInfo;

      // Show use case hint for the selected node type
      if (useCaseEl) {
        if (def && def.useCase) {
          useCaseEl.style.display = 'block';
          useCaseEl.innerHTML = '<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:#a78bfa;margin-bottom:3px;">Common Use Case</div><div style="font-size:11px;color:#c5cad6;line-height:1.4;">' + escapeHtml(def.useCase) + '</div>';
        } else {
          useCaseEl.style.display = 'none';
        }
      }

      syncNodeConfigText();
      renderNodeFormFields();
      updateNodeConfigError();
    }


    function renderEdges() {
      edgesSvg.innerHTML = '';
      edgesSvg.setAttribute('viewBox', '0 0 2200 1400');
      canvas.querySelectorAll('.edge-delete-btn').forEach(el => el.remove());

      (graph.edges || []).forEach((edge, idx) => {
        const from = graph.nodes.find(n => n.id === edge.from);
        const to = graph.nodes.find(n => n.id === edge.to);
        if (!from || !to) return;
        const x1 = (from.position?.x || 0) + 220;
        const y1 = (from.position?.y || 0) + 34;
        const x2 = (to.position?.x || 0);
        const y2 = (to.position?.y || 0) + 34;
        const d = 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + 60) + ' ' + y1 + ', ' + (x2 - 60) + ' ' + y2 + ', ' + x2 + ' ' + y2;

        const fromState = nodeStates[edge.from] || '';
        const toState = nodeStates[edge.to] || '';
        const edgeColor = (fromState === 'completed' && (toState === 'completed' || toState === 'running')) ? '#3ddc84'
          : (fromState === 'errored' || toState === 'errored') ? '#ff4444'
          : '#6f86b9';

        // Visible edge
        const visPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        visPath.setAttribute('d', d);
        visPath.setAttribute('stroke', hoveredEdgeIdx === idx ? '#ff6b6b' : edgeColor);
        visPath.setAttribute('fill', 'none');
        visPath.setAttribute('stroke-width', hoveredEdgeIdx === idx ? '3' : '2');
        edgesSvg.appendChild(visPath);

        // Invisible wide hitbox for hover detection
        const hitPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hitPath.setAttribute('d', d);
        hitPath.setAttribute('class', 'edge-hitbox');
        hitPath.addEventListener('mouseenter', () => {
          hoveredEdgeIdx = idx;
          renderEdges();
        });
        hitPath.addEventListener('mouseleave', () => {
          if (hoveredEdgeIdx === idx) {
            hoveredEdgeIdx = null;
            renderEdges();
          }
        });
        edgesSvg.appendChild(hitPath);

        // Delete button at midpoint of edge
        if (hoveredEdgeIdx === idx) {
          const mx = (x1 + x2) / 2;
          const my = (y1 + y2) / 2;
          const delBtn = document.createElement('div');
          delBtn.className = 'edge-delete-btn';
          delBtn.style.display = 'block';
          delBtn.style.left = (mx - 10) + 'px';
          delBtn.style.top = (my - 10) + 'px';
          delBtn.textContent = 'X';
          delBtn.title = 'Remove: ' + edge.from + ' -> ' + edge.to;
          delBtn.addEventListener('mousedown', (event) => {
            event.stopPropagation();
            event.preventDefault();
          });
          delBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            graph.edges.splice(idx, 1);
            hoveredEdgeIdx = null;
            render();
          });
          canvas.appendChild(delBtn);
        }
      });

      // Temp wire while dragging
      if (wireDrag) {
        const tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const sx = wireDrag.startX;
        const sy = wireDrag.startY;
        const ex = wireDrag.currentX || sx;
        const ey = wireDrag.currentY || sy;
        tempPath.setAttribute('d', 'M ' + sx + ' ' + sy + ' C ' + (sx + 60) + ' ' + sy + ', ' + (ex - 60) + ' ' + ey + ', ' + ex + ' ' + ey);
        tempPath.setAttribute('stroke', '#69a0ff');
        tempPath.setAttribute('stroke-width', '2');
        tempPath.setAttribute('stroke-dasharray', '6 4');
        tempPath.setAttribute('fill', 'none');
        tempPath.classList.add('temp-edge');
        edgesSvg.appendChild(tempPath);
      }
    }

    function renderEdgeList() {
      edgeList.innerHTML = '';
      const edges = graph.edges || [];
      const edgeCountEl = document.getElementById('edgeCount');
      if (edgeCountEl) edgeCountEl.textContent = '(' + edges.length + ')';
      edges.forEach((edge, idx) => {
        const item = document.createElement('div');
        item.className = 'edge-item';
        item.innerHTML = '<span>' + edge.from + ' \u2192 ' + edge.to + '</span>';
        const btn = document.createElement('button');
        btn.className = 'danger';
        btn.textContent = 'Remove';
        btn.onclick = () => {
          graph.edges.splice(idx, 1);
          render();
        };
        item.appendChild(btn);
        edgeList.appendChild(item);
      });
    }

    function selectNode(nodeId) {
      selectedNodeId = nodeId;
      nodeEditorTab = 'form';
      setNodeEditorTab('form');
      renderNodeEditor();
      render();
      if (typeof saveUiState === 'function') saveUiState();
    }

    function getCanvasPoint(clientX, clientY) {
      const wrap = canvas.parentElement;
      const wrapRect = wrap.getBoundingClientRect();
      return {
        x: Math.round((clientX - wrapRect.left + wrap.scrollLeft) / zoomLevel),
        y: Math.round((clientY - wrapRect.top + wrap.scrollTop) / zoomLevel),
      };
    }

    function maybeAutoScroll(clientX, clientY) {
      const wrap = canvas.parentElement;
      const rect = wrap.getBoundingClientRect();
      const edge = 36;
      const speed = 24;

      if (clientX < rect.left + edge) {
        wrap.scrollLeft = Math.max(0, wrap.scrollLeft - speed);
      } else if (clientX > rect.right - edge) {
        wrap.scrollLeft = wrap.scrollLeft + speed;
      }

      if (clientY < rect.top + edge) {
        wrap.scrollTop = Math.max(0, wrap.scrollTop - speed);
      } else if (clientY > rect.bottom - edge) {
        wrap.scrollTop = wrap.scrollTop + speed;
      }
    }

    function beginDrag(event, nodeId) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const point = getCanvasPoint(event.clientX, event.clientY);
      const pos = node.position || { x: 0, y: 0 };
      dragState = {
        nodeId,
        offsetX: point.x - pos.x,
        offsetY: point.y - pos.y,
      };
      document.body.style.userSelect = 'none';
      selectNode(nodeId);
      event.stopPropagation();
      event.preventDefault();
    }

    function beginPan(event) {
      if (event.button !== 0) return;
      if (event.target && event.target.closest && event.target.closest('.node')) return;
      const wrap = canvas.parentElement;
      panState = {
        startClientX: event.clientX,
        startClientY: event.clientY,
        startScrollLeft: wrap.scrollLeft,
        startScrollTop: wrap.scrollTop,
      };
      document.body.style.userSelect = 'none';
      event.preventDefault();
    }

    function bindDragHandlersOnce() {
      if (dragHandlersBound) return;
      dragHandlersBound = true;

      document.addEventListener('mousemove', (event) => {
        // Wire drag: update temp edge endpoint and highlight drop targets
        if (wireDrag) {
          const point = getCanvasPoint(event.clientX, event.clientY);
          wireDrag.currentX = point.x;
          wireDrag.currentY = point.y;

          // Highlight input ports near cursor
          const targetId = findNodeAtPort(event.clientX, event.clientY, 'in');
          canvas.querySelectorAll('.port-in').forEach(p => {
            if (targetId && p.getAttribute('data-node-id') === targetId && targetId !== wireDrag.fromNodeId) {
              p.classList.add('drop-target');
            } else {
              p.classList.remove('drop-target');
            }
          });

          renderEdges();
          return;
        }

        if (dragState) {
          const node = graph.nodes.find((n) => n.id === dragState.nodeId);
          if (!node) return;

          maybeAutoScroll(event.clientX, event.clientY);
          const point = getCanvasPoint(event.clientX, event.clientY);
          const maxX = Math.max(0, canvas.clientWidth - 220);
          const maxY = Math.max(0, canvas.clientHeight - 80);

          node.position = {
            x: Math.min(maxX, Math.max(0, point.x - dragState.offsetX)),
            y: Math.min(maxY, Math.max(0, point.y - dragState.offsetY)),
          };

          render();
          return;
        }

        if (panState) {
          const wrap = canvas.parentElement;
          wrap.scrollLeft = Math.max(0, panState.startScrollLeft - (event.clientX - panState.startClientX));
          wrap.scrollTop = Math.max(0, panState.startScrollTop - (event.clientY - panState.startClientY));
        }
      });

      document.addEventListener('mouseup', (event) => {
        // Wire drag: complete connection or cancel
        if (wireDrag) {
          const targetId = findNodeAtPort(event.clientX, event.clientY, 'in');
          if (targetId && targetId !== wireDrag.fromNodeId) {
            graph.edges = graph.edges || [];
            if (!graph.edges.some(e => e.from === wireDrag.fromNodeId && e.to === targetId)) {
              graph.edges.push({ from: wireDrag.fromNodeId, to: targetId });
            }
          }
          canvas.querySelectorAll('.port-in').forEach(p => p.classList.remove('drop-target'));
          wireDrag = null;
          document.body.style.userSelect = '';
          render();
          return;
        }

        if (dragState) dragState = null;
        if (panState) panState = null;
        document.body.style.userSelect = '';
      });

      canvas.parentElement.addEventListener('mousedown', beginPan);

      // Zoom with Ctrl+wheel or pinch
      canvas.parentElement.addEventListener('wheel', (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        const delta = event.deltaY > 0 ? -0.1 : 0.1;
        setZoom(Math.round((zoomLevel + delta) * 10) / 10);
      }, { passive: false });
    }

    function setZoom(level) {
      zoomLevel = Math.max(0.2, Math.min(2, level));
      canvas.style.transform = 'scale(' + zoomLevel + ')';
      document.getElementById('zoomLabel').textContent = Math.round(zoomLevel * 100) + '%';
      renderEdges();
    }

    function zoomFit() {
      if (graph.nodes.length === 0) { setZoom(1); return; }
      var wrap = canvas.parentElement;
      var maxX = 0, maxY = 0, minX = Infinity, minY = Infinity;
      graph.nodes.forEach(function(n) {
        var x = n.position?.x || 0, y = n.position?.y || 0;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + 220 > maxX) maxX = x + 220;
        if (y + 100 > maxY) maxY = y + 100;
      });
      var contentW = maxX - minX + 80;
      var contentH = maxY - minY + 80;
      var fitZoom = Math.min(wrap.clientWidth / contentW, wrap.clientHeight / contentH, 2);
      setZoom(Math.round(fitZoom * 10) / 10);
      wrap.scrollLeft = Math.max(0, (minX - 40) * zoomLevel);
      wrap.scrollTop = Math.max(0, (minY - 40) * zoomLevel);
    }

    function getPortPosition(node, side) {
      const x = node.position?.x || 0;
      const y = node.position?.y || 0;
      if (side === 'out') return { x: x + 220, y: y + 34 };
      return { x: x, y: y + 34 };
    }

    function findNodeAtPort(clientX, clientY, side) {
      const point = getCanvasPoint(clientX, clientY);
      for (const node of graph.nodes) {
        const port = getPortPosition(node, side);
        const dx = point.x - port.x;
        const dy = point.y - port.y;
        if (dx * dx + dy * dy < 400) return node.id;
      }
      return null;
    }

    function renderNodes() {
      canvas.querySelectorAll('.node').forEach(el => el.remove());
      graph.nodes.forEach((node) => {
        const el = document.createElement('div');
        const state = nodeStates[node.id] || '';
        let cls = 'node';
        if (selectedNodeId === node.id) cls += ' selected';
        if (state) cls += ' ' + state;
        el.className = cls;
        el.style.left = (node.position?.x || 0) + 'px';
        el.style.top = (node.position?.y || 0) + 'px';

        let badgeHtml = '';
        if (state === 'running') {
          badgeHtml = '<div class="status-badge running">Running...</div>';
        } else if (state === 'completed') {
          badgeHtml = '<div class="status-badge completed">Done</div>';
        } else if (state === 'warning') {
          badgeHtml = '<div class="status-badge warning">Warning</div>';
        } else if (state === 'errored') {
          badgeHtml = '<div class="status-badge errored">Error</div>';
        } else if (state === 'skipped') {
          badgeHtml = '<div class="status-badge">Skipped</div>';
        }

        const refs = extractNodeRefs(node);
        const refsHtml = refs.length > 0 ? '<div class="refs-badge">' + refs.map(r => '{{' + r + '}}').join(', ') + '</div>' : '';

        // Build I/O section from definitions
        const def = getNodeDefinition(node.type);
        let ioHtml = '';
        if (def) {
          const inputKeys = (def.configSchema || []).filter(f => f.required).map(f => f.key);
          const outputKeys = (def.outputSchema || []).map(f => f.key);
          if (inputKeys.length > 0 || outputKeys.length > 0) {
            ioHtml = '<div class="io-section">';
            if (inputKeys.length > 0) {
              ioHtml += '<div class="io-label">In</div><div class="io-fields">'
                + inputKeys.map(k => '<span class="io-tag input">' + escapeHtml(k) + '</span>').join('')
                + '</div>';
            }
            if (outputKeys.length > 0) {
              ioHtml += '<div class="io-label" style="margin-top:3px;">Out</div><div class="io-fields">'
                + outputKeys.map(k => '<span class="io-tag output">' + escapeHtml(k) + '</span>').join('')
                + '</div>';
            }
            ioHtml += '</div>';
          }
        }

        // Category color badge
        var nodeCat = (def && def.category) ? def.category : (node.type.split('.')[0] || 'other');
        var catDotColor = categoryIcons[nodeCat] || '#8f98af';

        el.innerHTML =
          '<div class="port port-in" data-port="in" data-node-id="' + node.id + '"></div>' +
          '<div class="port port-out" data-port="out" data-node-id="' + node.id + '"></div>' +
          '<div class="title">' + (node.label || node.id) + '</div>' +
          '<div class="type"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + catDotColor + ';margin-right:4px;vertical-align:middle;"></span>' + node.type + '</div>' +
          '<div class="id">' + node.id + '</div>' +
          refsHtml +
          badgeHtml +
          ioHtml;
        el.onclick = (event) => {
          if (event.target.classList.contains('port')) return;
          event.stopPropagation();
          selectNode(node.id);
        };
        el.onmousedown = (event) => {
          if (event.target.classList.contains('port')) return;
          beginDrag(event, node.id);
        };

        const portOut = el.querySelector('.port-out');
        if (portOut) {
          portOut.addEventListener('mousedown', (event) => {
            event.stopPropagation();
            event.preventDefault();
            const pos = getPortPosition(node, 'out');
            wireDrag = { fromNodeId: node.id, startX: pos.x, startY: pos.y };
            document.body.style.userSelect = 'none';
          });
        }

        const portIn = el.querySelector('.port-in');
        if (portIn) {
          portIn.addEventListener('mousedown', (event) => {
            event.stopPropagation();
            event.preventDefault();
          });
        }

        canvas.appendChild(el);
      });
    }

    function extractNodeRefs(node) {
      const refs = [];
      const scan = (val) => {
        if (typeof val === 'string') {
          const matches = val.matchAll(/\\{\\{\\s*([^}]+?)\\s*\\}\\}/g);
          for (const m of matches) {
            const token = m[1].trim();
            if (!token.startsWith('vars.')) refs.push(token);
          }
        } else if (Array.isArray(val)) {
          val.forEach(scan);
        } else if (val && typeof val === 'object') {
          Object.values(val).forEach(scan);
        }
      };
      if (node.config) Object.values(node.config).forEach(scan);
      if (node.inputs) Object.values(node.inputs).forEach(scan);
      return refs;
    }

    var _saveTimer = null;
    function debouncedSaveUiState() {
      if (_saveTimer) clearTimeout(_saveTimer);
      _saveTimer = setTimeout(function() { if (typeof saveUiState === 'function') saveUiState(); }, 300);
    }

    function render() {
      renderNodes();
      renderEdges();
      renderEdgeList();
      workflowName.value = graph.name || '';
      debouncedSaveUiState();
    }

    function addNodeFromDefinition(def) {
      const count = graph.nodes.length + 1;
      const idBase = def.type.split('.').pop() || 'node';
      let id = idBase + count;
      while (graph.nodes.some(n => n.id === id)) {
        id = idBase + Math.floor(Math.random() * 10000);
      }

      const config = {};
      (def.configSchema || []).forEach(field => {
        if (field.defaultValue !== undefined) config[field.key] = field.defaultValue;
      });

      // Position new node at the center of the currently visible canvas area
      var wrap = canvas.parentElement;
      var centerX = Math.round(wrap.scrollLeft + wrap.clientWidth / 2 - 80);
      var centerY = Math.round(wrap.scrollTop + wrap.clientHeight / 2 - 20);
      // Stagger slightly so multiple adds don't stack exactly
      var stagger = (count % 5) * 30;

      graph.nodes.push({
        id,
        type: def.type,
        label: def.title,
        position: { x: Math.max(10, centerX + stagger), y: Math.max(10, centerY + stagger) },
        config,
      });
      selectNode(id);
      render();
    }

    function loadTemplate(t) {
      graph = JSON.parse(JSON.stringify(t));
      graph.nodes = (graph.nodes || []).map((n, idx) => ensureNodeDefaults(n, idx));
      graph.edges = graph.edges || [];
      selectedNodeId = null;

      // Merge template variables with current defaults
      if (graph.variables && Object.keys(graph.variables).length > 0) {
        var current = {};
        try { current = JSON.parse(variablesEl.value || '{}'); } catch (_) {}
        var merged = Object.assign({}, current, graph.variables);
        variablesEl.value = JSON.stringify(merged, null, 2);
        renderVarsForm();
      }

      renderNodeEditor();
      render();
      if (typeof saveUiState === 'function') saveUiState();
    }

    async function refreshSavedWorkflows() {
      const res = await fetch('/api/workflows');
      const files = await res.json();
      savedEl.innerHTML = files.map(f =>
        '<div class="edge-item" style="margin-bottom:4px;">'
        + '<button class="list-btn secondary" data-path="' + escapeHtml(f.path) + '" style="margin-bottom:0;">' + escapeHtml(f.path) + '</button>'
        + '<button class="danger" data-delete-path="' + escapeHtml(f.path) + '" style="padding:4px 8px; font-size:11px;">Del</button>'
        + '</div>'
      ).join('') || '<div class="muted">No saved workflows yet.</div>';
      savedEl.querySelectorAll('.list-btn[data-path]').forEach((btn) => {
        btn.onclick = async () => {
          const path = btn.getAttribute('data-path');
          const fileRes = await fetch('/api/workflows/load?path=' + encodeURIComponent(path));
          const payload = await fileRes.json();
          if (!payload.graph) return;
          graph = payload.graph;
          graph.nodes = (graph.nodes || []).map((n, idx) => ensureNodeDefaults(n, idx));
          graph.edges = graph.edges || [];
          // Restore saved variables
          if (graph.variables && Object.keys(graph.variables).length > 0) {
            variablesEl.value = JSON.stringify(graph.variables, null, 2);
            renderVarsForm();
          }
          workflowPath.value = path;
          selectedNodeId = null;
          render();
        };
      });
      savedEl.querySelectorAll('[data-delete-path]').forEach((btn) => {
        btn.onclick = async (event) => {
          event.stopPropagation();
          const path = btn.getAttribute('data-delete-path');
          if (!confirm('Delete workflow "' + path + '"?')) return;
          const delRes = await fetch('/api/workflows/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
          });
          const body = await delRes.json();
          if (delRes.ok && body.success) {
            resultEl.textContent = 'Deleted: ' + path;
          } else {
            resultEl.textContent = 'Delete failed: ' + (body.error || 'Unknown error');
          }
          await refreshSavedWorkflows();
        };
      });
    }

    async function loadMeta() {
      bindDragHandlersOnce();

      const [defsRes, templatesRes] = await Promise.all([
        fetch('/api/node-definitions'),
        fetch('/api/templates'),
      ]);

      nodeDefs = await defsRes.json();
      templates = await templatesRes.json();

      // Group definitions by category
      const defsByCategory = {};
      nodeDefs.forEach((d, idx) => {
        const cat = d.category || 'other';
        if (!defsByCategory[cat]) defsByCategory[cat] = [];
        defsByCategory[cat].push({ def: d, idx });
      });
      const categoryLabels = { jira: 'Jira', ai: 'AI', ado: 'Azure DevOps', confluence: 'Confluence', web: 'Web', spec: 'Specification', image: 'Image', io: 'File I/O', transform: 'Transform', slack: 'Slack', github: 'GitHub', logic: 'Logic', notification: 'Notifications', other: 'Other' };
      const categoryOrder = ['jira', 'ai', 'ado', 'confluence', 'spec', 'image', 'web', 'io', 'transform', 'slack', 'github', 'logic', 'notification', 'other'];
      const sortedCategories = Object.keys(defsByCategory).sort(function(a, b) {
        var ai = categoryOrder.indexOf(a); var bi = categoryOrder.indexOf(b);
        return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
      });
      let nodeDefsHtml = '';
      for (const cat of sortedCategories) {
        const items = defsByCategory[cat];
        const color = categoryIcons[cat] || '#8f98af';
        nodeDefsHtml += '<details style="margin-bottom:8px;">';
        nodeDefsHtml += '<summary style="cursor:pointer;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:' + color + ';padding:4px 0;border-bottom:1px solid #272b36;user-select:none;list-style:none;display:flex;align-items:center;gap:4px;">';
        nodeDefsHtml += '<span style="font-size:9px;transition:transform 0.15s;display:inline-block;" class="cat-toggle-arrow">&#9654;</span>';
        nodeDefsHtml += escapeHtml(categoryLabels[cat] || cat) + ' <span style="color:#6b7394;font-size:10px;">(' + items.length + ')</span>';
        nodeDefsHtml += '</summary>';
        nodeDefsHtml += '<div style="padding-top:4px;">';
        for (const item of items) {
          const d = item.def;
          nodeDefsHtml += '<div class="node-palette-item" data-def-idx="' + item.idx + '" data-hover-color="' + color + '" style="margin-bottom:6px;padding:6px 8px;border:1px solid #272b36;border-radius:6px;cursor:pointer;transition:border-color 0.15s,background 0.15s;">';
          nodeDefsHtml += '<div style="font-size:12px;font-weight:600;color:#e8eaf0;">+ ' + escapeHtml(d.title) + '</div>';
          nodeDefsHtml += '<div style="font-size:11px;color:#8f98af;margin-top:2px;">' + escapeHtml(d.description) + '</div>';
          if (d.useCase) {
            nodeDefsHtml += '<div style="font-size:10px;color:#6b7394;margin-top:3px;padding-top:3px;border-top:1px dashed #272b36;font-style:italic;">' + escapeHtml(d.useCase) + '</div>';
          }
          nodeDefsHtml += '</div>';
        }
        nodeDefsHtml += '</div></details>';
      }
      nodeDefsEl.innerHTML = nodeDefsHtml;
      nodeDefsEl.querySelectorAll('.node-palette-item[data-def-idx]').forEach((item) => {
        item.onclick = () => addNodeFromDefinition(nodeDefs[Number(item.getAttribute('data-def-idx'))]);
        var hoverColor = item.getAttribute('data-hover-color') || '#8f98af';
        item.addEventListener('mouseenter', function() { this.style.borderColor = hoverColor; this.style.background = '#1a1f2e'; });
        item.addEventListener('mouseleave', function() { this.style.borderColor = '#272b36'; this.style.background = 'transparent'; });
      });

      // Node palette search/filter
      var nodeSearchInput = document.getElementById('nodeSearch');
      nodeSearchInput.addEventListener('input', function() {
        var q = this.value.toLowerCase().trim();
        nodeDefsEl.querySelectorAll('.node-palette-item[data-def-idx]').forEach(function(item) {
          var idx = Number(item.getAttribute('data-def-idx'));
          var d = nodeDefs[idx];
          if (!d) return;
          var haystack = (d.title + ' ' + d.type + ' ' + d.description + ' ' + (d.category || '')).toLowerCase();
          item.style.display = (!q || haystack.includes(q)) ? '' : 'none';
        });
        // Show/hide empty categories
        nodeDefsEl.querySelectorAll('details').forEach(function(det) {
          var visible = det.querySelectorAll('.node-palette-item[data-def-idx]:not([style*="display: none"])').length;
          det.style.display = visible > 0 || !q ? '' : 'none';
          if (q && visible > 0) det.open = true;
        });
      });

      // Keyboard shortcut: Ctrl+K / Cmd+K focuses node search
      document.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
          e.preventDefault();
          // Switch to Nodes tab if not active
          document.querySelectorAll('[data-panel-tab]').forEach(function(btn) {
            var tabName = btn.getAttribute('data-panel-tab');
            btn.classList.toggle('active', tabName === 'nodes');
            document.getElementById('panel' + tabName.charAt(0).toUpperCase() + tabName.slice(1)).style.display = tabName === 'nodes' ? '' : 'none';
          });
          nodeSearchInput.focus();
          nodeSearchInput.select();
        }
      });

      // Group templates by category
      var templatesByCategory = {};
      templates.forEach(function(t, idx) {
        var cat = t.category || 'Other';
        if (!templatesByCategory[cat]) templatesByCategory[cat] = [];
        templatesByCategory[cat].push({ template: t, idx: idx });
      });
      var templateCategoryColors = { 'Planning & Research': '#4f7cff', 'Ticket Generation': '#a78bfa', 'End-to-End': '#3ddc84', 'Incident Management': '#ff4444', 'Reporting': '#00bcd4' };
      var templatesHtml = '';
      for (var cat in templatesByCategory) {
        var items = templatesByCategory[cat];
        var catColor = templateCategoryColors[cat] || '#8f98af';
        templatesHtml += '<details open style="margin-bottom:10px;">';
        templatesHtml += '<summary style="cursor:pointer;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:' + catColor + ';padding:4px 0;border-bottom:1px solid #272b36;user-select:none;list-style:none;display:flex;align-items:center;gap:4px;">';
        templatesHtml += '<span style="font-size:9px;transition:transform 0.15s;display:inline-block;" class="cat-toggle-arrow">&#9654;</span>';
        templatesHtml += escapeHtml(cat) + ' <span style="color:#6b7394;font-size:10px;">(' + items.length + ')</span>';
        templatesHtml += '</summary>';
        templatesHtml += '<div style="padding-top:4px;">';
        for (var i = 0; i < items.length; i++) {
          var t = items[i].template;
          var tidx = items[i].idx;
          templatesHtml += '<div class="tmpl-card" data-idx="' + tidx + '" style="margin-bottom:8px;padding:8px 10px;border:1px solid #272b36;border-radius:6px;cursor:pointer;transition:border-color 0.15s,background 0.15s;">';
          templatesHtml += '<div style="font-size:12px;font-weight:600;color:#e8eaf0;">' + escapeHtml(t.name) + '</div>';
          if (t.description) {
            templatesHtml += '<div style="font-size:11px;color:#8f98af;margin-top:4px;line-height:1.4;">' + escapeHtml(t.description) + '</div>';
          }
          templatesHtml += '<div style="font-size:10px;color:#6b7394;margin-top:4px;">' + (t.nodes ? t.nodes.length : 0) + ' nodes</div>';
          templatesHtml += '</div>';
        }
        templatesHtml += '</div></details>';
      }
      templatesEl.innerHTML = templatesHtml;
      templatesEl.querySelectorAll('.tmpl-card[data-idx]').forEach(function(card) {
        card.onclick = function() { loadTemplate(templates[Number(card.getAttribute('data-idx'))]); };
        card.addEventListener('mouseenter', function() { this.style.borderColor = '#4f7cff'; this.style.background = '#1a1f2e'; });
        card.addEventListener('mouseleave', function() { this.style.borderColor = '#272b36'; this.style.background = 'transparent'; });
      });

      if (!variablesEl.value.trim()) {
        variablesEl.value = JSON.stringify({
          model: 'sonnet',
          configPath: 'data/Jira/config/jira.env',
          projectKey: '',
          board: '',
          issueTypeName: 'Task',
          targetStatus: '',
          defaultLabels: '',
          defaultComponents: '',
          ticket: '',
          relatedLimit: 5,
          updateMode: 'update',
          dryRun: true,
          adoConfigPath: 'data/ADO/config/ado.env',
          adoRepoUrl: '',
          azureDevOpsProject: '',
          azureDevOpsRepository: '',
          azureDevOpsBranch: '',
          azureDevOpsPath: '/',
          azureDevOpsMaxFiles: 6,
          azureDevOpsMaxCharsPerFile: 2500,
          azureDevOpsFileNameFilter: '',
          azureDevOpsContentFilter: '',
          dryRunPR: true,
          guide: '',
          outputPath: '',
          slackConfigPath: 'data/Slack/config/slack.env',
        }, null, 2);
      }

      renderVarsForm();

      // Only load default template if no saved session will be restored
      var hasSavedSession = false;
      try {
        var savedRaw = localStorage.getItem(UI_STATE_KEY);
        if (savedRaw) {
          var savedState = JSON.parse(savedRaw);
          hasSavedSession = savedState.graph && Array.isArray(savedState.graph.nodes) && savedState.graph.nodes.length > 0;
        }
      } catch (_) {}
      if (!hasSavedSession && templates[0]) {
        loadTemplate(templates[0]);
      }

      nodeConfig.addEventListener('input', () => {
        const node = getSelectedNode();
        if (!node) return;
        try {
          const parsed = JSON.parse(nodeConfig.value || '{}');
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Node config must be a JSON object.');
          }
          node.config = parsed;
          nodeConfigParseError = '';
          renderNodeFormFields();
          updateNodeConfigError();
        } catch (error) {
          nodeConfigParseError = 'JSON parse error: ' + String(error);
          updateNodeConfigError();
        }
      });

      nodeFormTab.onclick = () => setNodeEditorTab('form');
      nodeJsonTab.onclick = () => setNodeEditorTab('json');

      await refreshSavedWorkflows();
    }

    applyNodeBtn.onclick = () => {
      if (!selectedNodeId) return;
      const node = graph.nodes.find(n => n.id === selectedNodeId);
      if (!node) return;
      try {
        const parsed = JSON.parse(nodeConfig.value || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Node config must be a JSON object.');
        }
        node.config = parsed;
        nodeConfigParseError = '';
        renderNodeFormFields();
        updateNodeConfigError();
        resultEl.textContent = 'JSON applied to node config.';
      } catch (error) {
        nodeConfigParseError = 'JSON parse error: ' + String(error);
        updateNodeConfigError();
        resultEl.textContent = 'Invalid JSON: ' + String(error);
      }
    };

    deleteNodeBtn.onclick = () => {
      if (!selectedNodeId) return;
      graph.nodes = graph.nodes.filter(n => n.id !== selectedNodeId);
      graph.edges = (graph.edges || []).filter(e => e.from !== selectedNodeId && e.to !== selectedNodeId);
      selectedNodeId = null;
      selectNode(null);
      render();
    };

    // Delete key shortcut for selected node
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Don't intercept if user is typing in an input/textarea
        var tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (!selectedNodeId || isRunning) return;
        e.preventDefault();
        graph.nodes = graph.nodes.filter(function(n) { return n.id !== selectedNodeId; });
        graph.edges = (graph.edges || []).filter(function(e2) { return e2.from !== selectedNodeId && e2.to !== selectedNodeId; });
        selectedNodeId = null;
        selectNode(null);
        render();
      }
    });

    function setRunState(running) {
      isRunning = running;
      runBtn.disabled = running;
      stopBtn.style.display = running ? 'inline-block' : 'none';
      stopBtn.textContent = 'Stop';
      stopRequested = false;
    }

    async function executeWorkflow() {
      setRunState(true);
      nodeStates = {};
      let nodeWarnings = null;
      graph.nodes.forEach(n => { nodeStates[n.id] = 'pending'; });
      render();
      resultEl.textContent = 'Starting workflow...';

      try {
        graph.name = workflowName.value || graph.name;
        const variables = JSON.parse(variablesEl.value || '{}');
        const res = await fetch('/api/run/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ graph, variables }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalResult = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6));

              if (event.type === 'node-start') {
                nodeStates[event.nodeId] = 'running';
                resultEl.textContent = 'Running node: ' + event.nodeId + ' (' + event.nodeType + ')';
                render();
              } else if (event.type === 'node-complete') {
                const output = event.result?.output || {};
                // Detect warning conditions:
                // 1. Node has explicit warning field
                // 2. AI node returned empty/blank text
                // 3. Create node produced zero items (createdCount === 0)
                const hasWarning = !!output.warning;
                const emptyAiOutput = (event.result?.nodeType === 'ai.generate' || event.result?.nodeType === 'ai.structured')
                  && typeof output.text === 'string' && output.text.trim() === '';
                const emptyCreated = typeof output.createdCount === 'number' && output.createdCount === 0;

                if (hasWarning || emptyAiOutput || emptyCreated) {
                  nodeStates[event.nodeId] = 'warning';
                  // Store warning detail for the banner
                  if (!nodeWarnings) nodeWarnings = {};
                  nodeWarnings[event.nodeId] = emptyAiOutput
                    ? 'AI returned empty output — the model may not have generated a response for this run.'
                    : (output.warning || 'Node produced no results.');
                } else {
                  nodeStates[event.nodeId] = 'completed';
                }
                const dur = event.result?.durationMs;
                resultEl.textContent = 'Completed: ' + event.nodeId + (dur ? ' (' + (dur / 1000).toFixed(1) + 's)' : '');
                render();
              } else if (event.type === 'node-pause') {
                // Interactive chat node is waiting for user input
                resultEl.textContent = 'Waiting for user input: ' + event.nodeId;
                showChatModal(event.chatSessionId, event.chatMessage, event.nodeId, event.upstreamContent);
                render();
              } else if (event.type === 'chat-message') {
                // AI response in the active chat session
                if (event.chatMessage) {
                  appendChatMessage(event.chatMessage);
                  // Transition to "refining" phase after AI responds to user's changes
                  if (chatHasUserMessages) {
                    setChatPhase('refining');
                  }
                  // Re-enable input after AI responds
                  const chatInput = document.getElementById('chatInput');
                  const chatSendBtn = document.getElementById('chatSendBtn');
                  if (chatInput) chatInput.disabled = false;
                  if (chatSendBtn) chatSendBtn.disabled = false;
                  if (chatInput) chatInput.focus();
                }
              } else if (event.type === 'node-error') {
                nodeStates[event.nodeId] = 'errored';
                var errText = event.result?.error || 'Unknown error';
                resultEl.textContent = 'Error in ' + event.nodeId + ': ' + errText;
                render();
                // Auto-open Jira config modal on auth/permission errors
                if (checkForJiraAuthError(errText)) {
                  showJiraConfigModal('Jira API access error: ' + errText + '\\n\\nPlease check your credentials below.');
                }
              } else if (event.type === 'workflow-complete') {
                finalResult = event.workflowResult;
              }
            } catch (parseErr) {
              // Skip malformed SSE lines
            }
          }
        }

        if (finalResult) {
          resultEl.innerHTML = formatWorkflowResult(finalResult);
          // Check final errors for Jira auth issues
          if (!finalResult.success && finalResult.errors && finalResult.errors.length > 0) {
            var jiraErr = finalResult.errors.find(function(e) { return checkForJiraAuthError(e); });
            if (jiraErr) {
              showJiraConfigModal('Jira API access error: ' + jiraErr + '\\n\\nPlease check your credentials below.');
            }
          }
          // Build composite output from all node results
          var compositeMarkdown = buildCompositeOutput(finalResult);
          if (compositeMarkdown) {
            showOutput(compositeMarkdown, 'workflow-output.md');
            outputMeta.textContent = 'Workflow output — ' + (finalResult.order || []).length + ' node' + ((finalResult.order || []).length !== 1 ? 's' : '') + ' executed';
            switchOutputTab('output');
          } else if (finalResult.success) {
            // Fallback: try to load from an io.writeFile node
            const outputPath = findOutputPathFromRunResult(finalResult);
            if (outputPath) {
              await loadOutputFile(outputPath);
              switchOutputTab('output');
            } else {
              outputMeta.textContent = 'Run completed — no displayable output from nodes.';
              switchOutputTab('result');
            }
          } else {
            // Workflow failed with no composite output — show execution results
            switchOutputTab('result');
          }
          // Mark remaining pending nodes as skipped
          graph.nodes.forEach(n => {
            if (nodeStates[n.id] === 'pending') nodeStates[n.id] = 'skipped';
          });

          // Check for nodes that completed with warnings (e.g. empty AI output, no code changes, zero items created)
          const warningNodes = Object.entries(nodeStates).filter(([_, s]) => s === 'warning');
          if (warningNodes.length > 0) {
            const warningMessages = warningNodes.map(([nid]) => {
              return (nodeWarnings && nodeWarnings[nid]) || ('Node ' + nid + ' completed with a warning.');
            });
            let bannerHtml = '<div style="background:#3d2e1a;border:1px solid #ff9800;border-radius:8px;padding:14px 18px;margin-bottom:12px;">';
            bannerHtml += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">';
            bannerHtml += '<span style="font-size:20px;">&#9888;</span>';
            bannerHtml += '<span style="font-weight:600;color:#ffb74d;font-size:14px;">Workflow completed with warnings</span>';
            bannerHtml += '</div>';
            for (const msg of warningMessages) {
              bannerHtml += '<div style="color:#ffe0b2;font-size:13px;margin-bottom:6px;">' + escapeHtml(msg) + '</div>';
            }
            bannerHtml += '<div style="color:#bfaa8c;font-size:12px;margin-bottom:12px;">One or more nodes produced empty or incomplete output. This can happen due to non-deterministic AI responses. View the output below to inspect results, or re-run to try again.</div>';
            bannerHtml += '<div style="display:flex;gap:8px;">';
            bannerHtml += '<button id="warning-view-output" style="padding:6px 14px;border-radius:6px;border:1px solid #ff9800;background:#2a1f0e;color:#ffb74d;cursor:pointer;font-size:12px;font-weight:600;">View Output</button>';
            bannerHtml += '<button id="warning-rerun" style="padding:6px 14px;border-radius:6px;border:none;background:#ff9800;color:#1a1f2e;cursor:pointer;font-size:12px;font-weight:600;">Re-run Workflow</button>';
            bannerHtml += '</div></div>';
            resultEl.innerHTML = bannerHtml + resultEl.innerHTML;

            // Wire up banner buttons
            const viewBtn = document.getElementById('warning-view-output');
            const rerunBtn = document.getElementById('warning-rerun');
            if (viewBtn) {
              viewBtn.onclick = () => {
                // Expand all detail panels so user can see node outputs
                resultEl.querySelectorAll('details').forEach(d => d.open = true);
                viewBtn.textContent = 'Expanded all outputs';
                viewBtn.disabled = true;
              };
            }
            if (rerunBtn) {
              rerunBtn.onclick = () => {
                rerunBtn.disabled = true;
                rerunBtn.textContent = 'Starting...';
                runBtn.click();
              };
            }
          }

          render();
        }
      } catch (error) {
        resultEl.textContent = 'Run error: ' + String(error);
      } finally {
        setRunState(false);
      }
    }

    var originalRunHandler = executeWorkflow;

    runBtn.onclick = function() {
      showPreflight();
    };

    stopBtn.onclick = async () => {
      if (!isRunning) return;
      const force = stopRequested;
      stopRequested = true;
      stopBtn.textContent = force ? 'Stopping...' : 'Force Stop';

      try {
        await fetch('/api/run/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force }),
        });
        resultEl.textContent = force ? 'Force stopping workflow...' : 'Stop requested (will finish current node)...';
      } catch (error) {
        resultEl.textContent = 'Stop failed: ' + String(error);
      }
    };

    saveBtn.onclick = async () => {
      try {
        graph.name = workflowName.value || graph.name;
        // Persist current variables into the graph before saving
        try {
          graph.variables = JSON.parse(variablesEl.value || '{}');
        } catch (_e) { /* keep existing if JSON invalid */ }
        const path = (workflowPath.value || '').trim() || 'workflow.json';
        const res = await fetch('/api/workflows/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, graph }),
        });
        const body = await res.json();
        if (!res.ok) {
          resultEl.textContent = 'Save failed: ' + JSON.stringify(body, null, 2);
          return;
        }
        workflowPath.value = body.path;
        resultEl.textContent = 'Saved to ' + body.path;
        await refreshSavedWorkflows();
      } catch (error) {
        resultEl.textContent = 'Save failed: ' + String(error);
      }
    };

    reloadBtn.onclick = async () => {
      await refreshSavedWorkflows();
      resultEl.textContent = 'Saved workflow list refreshed.';
    };

    previewBtn.onclick = () => setOutputView('preview');
    rawBtn.onclick = () => setOutputView('raw');

    // --- Output/Result tab switching ---
    const outputTabBtn = document.getElementById('outputTabBtn');
    const resultTabBtn = document.getElementById('resultTabBtn');
    const outputTabPanel = document.getElementById('outputTabPanel');
    const resultTabPanel = document.getElementById('resultTabPanel');

    function switchOutputTab(tab) {
      if (tab === 'output') {
        outputTabBtn.classList.add('active');
        resultTabBtn.classList.remove('active');
        outputTabPanel.style.display = '';
        resultTabPanel.style.display = 'none';
      } else {
        outputTabBtn.classList.remove('active');
        resultTabBtn.classList.add('active');
        outputTabPanel.style.display = 'none';
        resultTabPanel.style.display = '';
      }
      if (typeof saveUiState === 'function') saveUiState();
    }

    outputTabBtn.onclick = () => switchOutputTab('output');
    resultTabBtn.onclick = () => switchOutputTab('result');

    // --- UI State Persistence (localStorage) ---
    var UI_STATE_KEY = 'workflow-studio-ui-state';

    function saveUiState() {
      try {
        var state = {};
        // Active left panel tab
        var activeTab = document.querySelector('.output-tab.active[data-panel-tab]');
        state.panelTab = activeTab ? activeTab.getAttribute('data-panel-tab') : 'nodes';
        // Output tab (output vs result)
        var outputTabActive = document.getElementById('outputTabBtn');
        state.outputTab = (outputTabActive && outputTabActive.classList.contains('active')) ? 'output' : 'result';
        // Output view mode (preview vs raw)
        state.outputView = (outputRaw.style.display === 'block') ? 'raw' : 'preview';
        // Selected node on canvas
        state.selectedNodeId = selectedNodeId || null;
        // Node category details open/closed
        state.nodeCategories = {};
        nodeDefsEl.querySelectorAll('details').forEach(function(d) {
          var label = d.querySelector('summary');
          if (label) {
            var key = label.textContent.trim();
            state.nodeCategories[key] = d.open;
          }
        });
        // Template category details open/closed
        state.templateCategories = {};
        templatesEl.querySelectorAll('details').forEach(function(d) {
          var label = d.querySelector('summary');
          if (label) {
            var key = label.textContent.trim();
            state.templateCategories[key] = d.open;
          }
        });
        // Save full graph, variables, and workflow path
        state.graph = JSON.parse(JSON.stringify(graph));
        try { state.variables = JSON.parse(variablesEl.value || '{}'); } catch (_) { state.variables = null; }
        state.workflowPath = workflowPath.value || '';
        localStorage.setItem(UI_STATE_KEY, JSON.stringify(state));
      } catch (e) { /* localStorage may be unavailable */ }
    }

    function restoreUiState() {
      try {
        var raw = localStorage.getItem(UI_STATE_KEY);
        if (!raw) return false;
        var state = JSON.parse(raw);
        // Restore graph, variables, and workflow path FIRST (before selected node)
        var graphRestored = false;
        if (state.graph && Array.isArray(state.graph.nodes) && state.graph.nodes.length > 0) {
          graph = state.graph;
          graph.nodes = (graph.nodes || []).map(function(n, idx) { return ensureNodeDefaults(n, idx); });
          graph.edges = graph.edges || [];
          if (state.variables) {
            variablesEl.value = JSON.stringify(state.variables, null, 2);
            renderVarsForm();
          }
          if (state.workflowPath) workflowPath.value = state.workflowPath;
          selectedNodeId = null;
          renderNodeEditor();
          render();
          graphRestored = true;
        }
        // Restore left panel tab
        if (state.panelTab) switchPanelTab(state.panelTab);
        // Restore output tab
        if (state.outputTab) switchOutputTab(state.outputTab);
        // Restore output view mode
        if (state.outputView) setOutputView(state.outputView);
        // Restore selected node
        if (state.selectedNodeId && graph.nodes.some(function(n) { return n.id === state.selectedNodeId; })) {
          selectNode(state.selectedNodeId);
        }
        // Restore node category details open/closed
        if (state.nodeCategories) {
          nodeDefsEl.querySelectorAll('details').forEach(function(d) {
            var label = d.querySelector('summary');
            if (label) {
              var key = label.textContent.trim();
              if (key in state.nodeCategories) d.open = state.nodeCategories[key];
            }
          });
        }
        // Restore template category details open/closed
        if (state.templateCategories) {
          templatesEl.querySelectorAll('details').forEach(function(d) {
            var label = d.querySelector('summary');
            if (label) {
              var key = label.textContent.trim();
              if (key in state.templateCategories) d.open = state.templateCategories[key];
            }
          });
        }
        return graphRestored;
      } catch (e) { /* localStorage may be unavailable */ }
      return false;
    }

    // Track details toggle changes for both node and template categories
    function attachDetailsListeners() {
      nodeDefsEl.querySelectorAll('details').forEach(function(d) {
        d.addEventListener('toggle', saveUiState);
      });
      templatesEl.querySelectorAll('details').forEach(function(d) {
        d.addEventListener('toggle', saveUiState);
      });
    }

    // --- Left panel tab switching ---
    function switchPanelTab(tab) {
      var tabs = ['nodes', 'templates', 'saved'];
      tabs.forEach(function(t) {
        var btn = document.getElementById('panelTab' + t.charAt(0).toUpperCase() + t.slice(1));
        var panel = document.getElementById('panel' + t.charAt(0).toUpperCase() + t.slice(1));
        if (btn) btn.classList.toggle('active', t === tab);
        if (panel) {
          if (t === tab) { panel.style.display = ''; panel.style.flex = '1'; }
          else { panel.style.display = 'none'; panel.style.flex = ''; }
        }
      });
      saveUiState();
    }
    document.getElementById('panelTabNodes').onclick = function() { switchPanelTab('nodes'); };
    document.getElementById('panelTabTemplates').onclick = function() { switchPanelTab('templates'); };
    document.getElementById('panelTabSaved').onclick = function() { switchPanelTab('saved'); };

    // --- Jira Config Modal Logic ---
    var jiraConfigModal = document.getElementById('jiraConfigModal');
    var jiraConfigBtn = document.getElementById('jiraConfigBtn');
    var jiraConfigClose = document.getElementById('jiraConfigClose');
    var jiraTestBtn = document.getElementById('jiraTestBtn');
    var jiraSaveBtn = document.getElementById('jiraSaveBtn');
    var jiraConfigError = document.getElementById('jiraConfigError');
    var jiraConfigSuccess = document.getElementById('jiraConfigSuccess');

    function getJiraConfigPath() {
      try {
        var vars = JSON.parse(variablesEl.value || '{}');
        return vars.configPath || 'data/Jira/config/jira.env';
      } catch (_) {
        return 'data/Jira/config/jira.env';
      }
    }

    function showJiraConfigModal(errorMessage) {
      jiraConfigError.style.display = 'none';
      jiraConfigSuccess.style.display = 'none';
      if (errorMessage) {
        jiraConfigError.textContent = errorMessage;
        jiraConfigError.style.display = 'block';
      }
      jiraConfigModal.style.display = 'flex';
      // Load current values
      var cfgPath = getJiraConfigPath();
      fetch('/api/jira-config?path=' + encodeURIComponent(cfgPath))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success && data.values) {
            document.getElementById('jiraCfgBaseUrl').value = data.values.JIRA_BASE_URL || '';
            document.getElementById('jiraCfgEmail').value = data.values.JIRA_EMAIL || '';
            document.getElementById('jiraCfgToken').value = '';
            document.getElementById('jiraCfgToken').placeholder = data.exists && data.values.JIRA_API_TOKEN ? 'Token set (' + data.values.JIRA_API_TOKEN + ') — leave blank to keep' : 'Paste your Jira API token';
            document.getElementById('jiraCfgCaCert').value = data.values.JIRA_CA_CERT_PATH || '';
            document.getElementById('jiraCfgModel').value = data.values.JIRA_AI_MODEL || 'anthropic.claude-sonnet-4-6';
          } else if (data.error) {
            jiraConfigError.textContent = 'Failed to load config: ' + data.error;
            jiraConfigError.style.display = 'block';
          }
        })
        .catch(function(err) {
          jiraConfigError.textContent = 'Failed to load config: ' + (err.message || String(err));
          jiraConfigError.style.display = 'block';
        });
    }

    function closeJiraConfigModal() {
      jiraConfigModal.style.display = 'none';
    }

    jiraConfigBtn.onclick = function() { showJiraConfigModal(null); };
    jiraConfigClose.onclick = closeJiraConfigModal;
    jiraConfigModal.onclick = function(e) { if (e.target === jiraConfigModal) closeJiraConfigModal(); };

    jiraTestBtn.onclick = async function() {
      jiraConfigError.style.display = 'none';
      jiraConfigSuccess.style.display = 'none';
      jiraTestBtn.disabled = true;
      jiraTestBtn.textContent = 'Testing...';

      var baseUrl = document.getElementById('jiraCfgBaseUrl').value.trim();
      var email = document.getElementById('jiraCfgEmail').value.trim();
      var token = document.getElementById('jiraCfgToken').value.trim();
      var caCertPath = document.getElementById('jiraCfgCaCert').value.trim();

      // If token is blank, we need to read the actual token from the config file
      if (!token) {
        jiraConfigError.textContent = 'Enter an API token to test the connection.';
        jiraConfigError.style.display = 'block';
        jiraTestBtn.disabled = false;
        jiraTestBtn.textContent = 'Test Connection';
        return;
      }

      try {
        var res = await fetch('/api/jira-test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseUrl: baseUrl, email: email, apiToken: token, caCertPath: caCertPath }),
        });
        var data = await res.json();
        if (data.success) {
          jiraConfigSuccess.textContent = 'Connection successful!' + (data.displayName ? ' Authenticated as: ' + data.displayName : '');
          jiraConfigSuccess.style.display = 'block';
        } else {
          var errMsg = 'Connection failed';
          if (data.status === 401 || data.status === 403) {
            errMsg += ': Invalid credentials. Check your email and API token.';
          } else if (data.status === 404) {
            errMsg += ': Base URL not found. Check the URL is correct.';
          } else {
            errMsg += ': ' + (data.error || 'Unknown error');
          }
          jiraConfigError.textContent = errMsg;
          jiraConfigError.style.display = 'block';
        }
      } catch (err) {
        jiraConfigError.textContent = 'Request failed: ' + String(err);
        jiraConfigError.style.display = 'block';
      }

      jiraTestBtn.disabled = false;
      jiraTestBtn.textContent = 'Test Connection';
    };

    jiraSaveBtn.onclick = async function() {
      jiraConfigError.style.display = 'none';
      jiraConfigSuccess.style.display = 'none';
      jiraSaveBtn.disabled = true;
      jiraSaveBtn.textContent = 'Saving...';

      var values = {
        JIRA_BASE_URL: document.getElementById('jiraCfgBaseUrl').value.trim(),
        JIRA_EMAIL: document.getElementById('jiraCfgEmail').value.trim(),
        JIRA_API_TOKEN: document.getElementById('jiraCfgToken').value.trim() || '****',
        JIRA_CA_CERT_PATH: document.getElementById('jiraCfgCaCert').value.trim(),
        JIRA_AI_MODEL: document.getElementById('jiraCfgModel').value.trim() || 'anthropic.claude-sonnet-4-6',
      };

      if (!values.JIRA_BASE_URL || !values.JIRA_EMAIL) {
        jiraConfigError.textContent = 'Base URL and email are required.';
        jiraConfigError.style.display = 'block';
        jiraSaveBtn.disabled = false;
        jiraSaveBtn.textContent = 'Save';
        return;
      }

      try {
        var cfgPath = getJiraConfigPath();
        var res = await fetch('/api/jira-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: cfgPath, values: values }),
        });
        var data = await res.json();
        if (data.success) {
          jiraConfigSuccess.textContent = 'Configuration saved to ' + cfgPath;
          jiraConfigSuccess.style.display = 'block';
          setTimeout(closeJiraConfigModal, 1500);
        } else {
          jiraConfigError.textContent = 'Save failed: ' + (data.error || 'Unknown error');
          jiraConfigError.style.display = 'block';
        }
      } catch (err) {
        jiraConfigError.textContent = 'Save request failed: ' + String(err);
        jiraConfigError.style.display = 'block';
      }

      jiraSaveBtn.disabled = false;
      jiraSaveBtn.textContent = 'Save';
    };

    // Detect Jira auth errors from workflow execution and auto-open config modal
    function checkForJiraAuthError(errorText) {
      if (!errorText) return false;
      var str = String(errorText);
      // Match patterns like "Jira API error (401)", "Jira API error (403)", "Jira API error (404)"
      // or "permission" / "unauthorized" / "Missing JIRA_" config errors
      var authPattern = /Jira API error \\((401|403|404)\\)/i;
      var permPattern = /permission|unauthorized|forbidden|Missing JIRA_/i;
      return authPattern.test(str) || permPattern.test(str);
    }

    // --- ADO Config Modal Logic ---
    var adoConfigModal = document.getElementById('adoConfigModal');
    var adoConfigBtn = document.getElementById('adoConfigBtn');
    var adoConfigClose = document.getElementById('adoConfigClose');
    var adoTestBtn = document.getElementById('adoTestBtn');
    var adoSaveBtn = document.getElementById('adoSaveBtn');
    var adoConfigError = document.getElementById('adoConfigError');
    var adoConfigSuccess = document.getElementById('adoConfigSuccess');

    function getAdoConfigPath() {
      try {
        var vars = JSON.parse(variablesEl.value || '{}');
        return vars.adoConfigPath || 'data/ADO/config/ado.env';
      } catch (_) {
        return 'data/ADO/config/ado.env';
      }
    }

    function showAdoConfigModal(errorMessage) {
      adoConfigError.style.display = 'none';
      adoConfigSuccess.style.display = 'none';
      if (errorMessage) {
        adoConfigError.textContent = errorMessage;
        adoConfigError.style.display = 'block';
      }
      adoConfigModal.style.display = 'flex';
      var cfgPath = getAdoConfigPath();
      fetch('/api/ado-config?path=' + encodeURIComponent(cfgPath))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success && data.values) {
            document.getElementById('adoCfgOrgUrl').value = data.values.AZURE_DEVOPS_ORG_URL || '';
            document.getElementById('adoCfgPat').value = '';
            document.getElementById('adoCfgPat').placeholder = data.exists && data.values.AZURE_DEVOPS_PAT ? 'PAT set (' + data.values.AZURE_DEVOPS_PAT + ') — leave blank to keep' : 'Paste your Azure DevOps PAT';
          } else if (data.error) {
            adoConfigError.textContent = 'Failed to load config: ' + data.error;
            adoConfigError.style.display = 'block';
          }
        })
        .catch(function(err) {
          adoConfigError.textContent = 'Failed to load config: ' + (err.message || String(err));
          adoConfigError.style.display = 'block';
        });
    }

    function closeAdoConfigModal() { adoConfigModal.style.display = 'none'; }

    adoConfigBtn.onclick = function() { showAdoConfigModal(null); };
    adoConfigClose.onclick = closeAdoConfigModal;
    adoConfigModal.onclick = function(e) { if (e.target === adoConfigModal) closeAdoConfigModal(); };

    adoTestBtn.onclick = async function() {
      adoConfigError.style.display = 'none';
      adoConfigSuccess.style.display = 'none';
      adoTestBtn.disabled = true;
      adoTestBtn.textContent = 'Testing...';

      var orgUrl = document.getElementById('adoCfgOrgUrl').value.trim();
      var pat = document.getElementById('adoCfgPat').value.trim();

      if (!pat) {
        adoConfigError.textContent = 'Enter a PAT to test the connection.';
        adoConfigError.style.display = 'block';
        adoTestBtn.disabled = false;
        adoTestBtn.textContent = 'Test Connection';
        return;
      }

      try {
        var res = await fetch('/api/ado-test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orgUrl: orgUrl, pat: pat }),
        });
        var data = await res.json();
        if (data.success) {
          adoConfigSuccess.textContent = 'Connection successful!' + (data.displayName ? ' Authenticated as: ' + data.displayName : '');
          adoConfigSuccess.style.display = 'block';
        } else {
          adoConfigError.textContent = 'Connection failed: ' + (data.error || 'Unknown error');
          adoConfigError.style.display = 'block';
        }
      } catch (err) {
        adoConfigError.textContent = 'Test request failed: ' + String(err);
        adoConfigError.style.display = 'block';
      }

      adoTestBtn.disabled = false;
      adoTestBtn.textContent = 'Test Connection';
    };

    adoSaveBtn.onclick = async function() {
      adoConfigError.style.display = 'none';
      adoConfigSuccess.style.display = 'none';
      adoSaveBtn.disabled = true;
      adoSaveBtn.textContent = 'Saving...';

      var values = {
        AZURE_DEVOPS_ORG_URL: document.getElementById('adoCfgOrgUrl').value.trim(),
        AZURE_DEVOPS_PAT: document.getElementById('adoCfgPat').value.trim(),
      };

      try {
        var cfgPath = getAdoConfigPath();
        var res = await fetch('/api/ado-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: cfgPath, values: values }),
        });
        var data = await res.json();
        if (data.success) {
          adoConfigSuccess.textContent = 'ADO configuration saved successfully.';
          adoConfigSuccess.style.display = 'block';
          setTimeout(closeAdoConfigModal, 1500);
        } else {
          adoConfigError.textContent = 'Save failed: ' + (data.error || 'Unknown error');
          adoConfigError.style.display = 'block';
        }
      } catch (err) {
        adoConfigError.textContent = 'Save request failed: ' + String(err);
        adoConfigError.style.display = 'block';
      }

      adoSaveBtn.disabled = false;
      adoSaveBtn.textContent = 'Save';
    };

    // --- Slack Config Modal Logic ---
    var slackConfigModal = document.getElementById('slackConfigModal');
    var slackConfigBtn = document.getElementById('slackConfigBtn');
    var slackConfigClose = document.getElementById('slackConfigClose');
    var slackTestBtn = document.getElementById('slackTestBtn');
    var slackSaveBtn = document.getElementById('slackSaveBtn');
    var slackConfigError = document.getElementById('slackConfigError');
    var slackConfigSuccess = document.getElementById('slackConfigSuccess');

    function getSlackConfigPath() {
      try {
        var vars = JSON.parse(variablesEl.value || '{}');
        return vars.slackConfigPath || 'data/Slack/config/slack.env';
      } catch (_) {
        return 'data/Slack/config/slack.env';
      }
    }

    function showSlackConfigModal() {
      slackConfigError.style.display = 'none';
      slackConfigSuccess.style.display = 'none';
      slackConfigModal.style.display = 'flex';
      var cfgPath = getSlackConfigPath();
      fetch('/api/slack-config?path=' + encodeURIComponent(cfgPath))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success && data.values) {
            document.getElementById('slackCfgWebhook').value = data.values.SLACK_WEBHOOK_URL || '';
            document.getElementById('slackCfgBotToken').value = '';
            document.getElementById('slackCfgBotToken').placeholder = data.exists && data.values.SLACK_BOT_TOKEN ? 'Token set (' + data.values.SLACK_BOT_TOKEN + ') — leave blank to keep' : 'xoxb-...';
            document.getElementById('slackCfgChannel').value = data.values.SLACK_DEFAULT_CHANNEL || '';
          }
        }).catch(function() {});
    }

    function closeSlackConfigModal() {
      slackConfigModal.style.display = 'none';
    }

    slackConfigBtn.onclick = function() { showSlackConfigModal(); };
    slackConfigClose.onclick = closeSlackConfigModal;
    slackConfigModal.onclick = function(e) { if (e.target === slackConfigModal) closeSlackConfigModal(); };

    slackTestBtn.onclick = async function() {
      slackConfigError.style.display = 'none';
      slackConfigSuccess.style.display = 'none';
      slackTestBtn.disabled = true;
      slackTestBtn.textContent = 'Testing...';

      var webhook = document.getElementById('slackCfgWebhook').value.trim();
      if (!webhook) {
        slackConfigError.textContent = 'Enter a webhook URL to test.';
        slackConfigError.style.display = 'block';
        slackTestBtn.disabled = false;
        slackTestBtn.textContent = 'Test Webhook';
        return;
      }

      try {
        var res = await fetch('/api/slack-test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ webhookUrl: webhook }),
        });
        var data = await res.json();
        if (data.success) {
          slackConfigSuccess.textContent = 'Webhook test successful! Message sent.';
          slackConfigSuccess.style.display = 'block';
        } else {
          slackConfigError.textContent = 'Webhook test failed: ' + (data.error || 'Unknown error');
          slackConfigError.style.display = 'block';
        }
      } catch (err) {
        slackConfigError.textContent = 'Request failed: ' + String(err);
        slackConfigError.style.display = 'block';
      }

      slackTestBtn.disabled = false;
      slackTestBtn.textContent = 'Test Webhook';
    };

    slackSaveBtn.onclick = async function() {
      slackConfigError.style.display = 'none';
      slackConfigSuccess.style.display = 'none';
      slackSaveBtn.disabled = true;
      slackSaveBtn.textContent = 'Saving...';

      var values = {
        SLACK_WEBHOOK_URL: document.getElementById('slackCfgWebhook').value.trim(),
        SLACK_BOT_TOKEN: document.getElementById('slackCfgBotToken').value.trim() || '****',
        SLACK_DEFAULT_CHANNEL: document.getElementById('slackCfgChannel').value.trim(),
      };

      try {
        var cfgPath = getSlackConfigPath();
        var res = await fetch('/api/slack-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: cfgPath, values: values }),
        });
        var data = await res.json();
        if (data.success) {
          slackConfigSuccess.textContent = 'Configuration saved to ' + cfgPath;
          slackConfigSuccess.style.display = 'block';
          setTimeout(closeSlackConfigModal, 1500);
        } else {
          slackConfigError.textContent = 'Save failed: ' + (data.error || 'Unknown error');
          slackConfigError.style.display = 'block';
        }
      } catch (err) {
        slackConfigError.textContent = 'Save request failed: ' + String(err);
        slackConfigError.style.display = 'block';
      }

      slackSaveBtn.disabled = false;
      slackSaveBtn.textContent = 'Save';
    };

    // --- Zoom controls ---
    document.getElementById('zoomInBtn').onclick = function() { setZoom(Math.round((zoomLevel + 0.1) * 10) / 10); };
    document.getElementById('zoomOutBtn').onclick = function() { setZoom(Math.round((zoomLevel - 0.1) * 10) / 10); };
    document.getElementById('zoomResetBtn').onclick = function() { setZoom(1); };
    document.getElementById('zoomFitBtn').onclick = function() { zoomFit(); };

    // --- Preflight modal ---
    var preflightModal = document.getElementById('preflightModal');
    var preflightContent = document.getElementById('preflightContent');
    var preflightRunBtn = document.getElementById('preflightRun');

    function closePreflight() { preflightModal.style.display = 'none'; }
    document.getElementById('preflightClose').onclick = closePreflight;
    document.getElementById('preflightCancel').onclick = closePreflight;

    function buildPreflightSummary() {
      var nodes = graph.nodes || [];
      var edges = graph.edges || [];
      var vars = {};
      try { vars = JSON.parse(variablesEl.value || '{}'); } catch(e) {}

      if (nodes.length === 0) return '<div class="preflight-item warn">No nodes in workflow. Add nodes before running.</div>';

      // Topological sort for execution order
      var inDeg = {};
      var adj = {};
      nodes.forEach(function(n) { inDeg[n.id] = 0; adj[n.id] = []; });
      edges.forEach(function(e) {
        if (inDeg[e.to] !== undefined) inDeg[e.to]++;
        if (adj[e.from]) adj[e.from].push(e.to);
      });
      var queue = nodes.filter(function(n) { return inDeg[n.id] === 0; }).map(function(n) { return n.id; });
      var order = [];
      while (queue.length > 0) {
        var id = queue.shift();
        order.push(id);
        (adj[id] || []).forEach(function(to) {
          inDeg[to]--;
          if (inDeg[to] === 0) queue.push(to);
        });
      }
      // Add any remaining (cycles) at the end
      nodes.forEach(function(n) { if (order.indexOf(n.id) < 0) order.push(n.id); });

      var html = '';

      // Workflow overview
      html += '<div style="margin-bottom:12px;"><strong style="color:#e8eaf0;">Workflow:</strong> <span style="color:#8f98af;">' + escapeHtml(graph.name || 'Untitled') + '</span>';
      html += ' &mdash; <span style="color:#8f98af;">' + nodes.length + ' nodes, ' + edges.length + ' edges</span></div>';

      // Execution order
      html += '<div style="margin-bottom:12px;"><strong style="color:#e8eaf0;font-size:13px;">Execution Order</strong></div>';
      var step = 1;
      // Group parallel nodes (same topological depth)
      var depth = {};
      order.forEach(function(id) {
        var maxParent = -1;
        edges.forEach(function(e) { if (e.to === id && depth[e.from] !== undefined && depth[e.from] > maxParent) maxParent = depth[e.from]; });
        depth[id] = maxParent + 1;
      });
      var maxDepth = 0;
      order.forEach(function(id) { if (depth[id] > maxDepth) maxDepth = depth[id]; });

      for (var d = 0; d <= maxDepth; d++) {
        var atDepth = order.filter(function(id) { return depth[id] === d; });
        var parallel = atDepth.length > 1;
        atDepth.forEach(function(id) {
          var n = nodes.find(function(nd) { return nd.id === id; });
          if (!n) return;
          var def = getNodeDefinition(n.type);
          var cat = (def && def.category) ? def.category : (n.type.split('.')[0] || 'other');
          var dotColor = categoryIcons[cat] || '#8f98af';
          var label = (n.label || n.id);
          var desc = def ? def.title : n.type;

          var isDryRun = false;
          if (n.config) {
            var drVal = n.config.dryRun;
            var drPrVal = n.config.dryRunPR;
            // Resolve {{vars.xxx}} references against global variables
            if (typeof drVal === 'string' && /^\{\{vars\.(.+?)\}\}$/.test(drVal)) { drVal = vars[drVal.match(/^\{\{vars\.(.+?)\}\}$/)[1]]; }
            if (typeof drPrVal === 'string' && /^\{\{vars\.(.+?)\}\}$/.test(drPrVal)) { drPrVal = vars[drPrVal.match(/^\{\{vars\.(.+?)\}\}$/)[1]]; }
            isDryRun = drVal === true || drVal === 'true' || drPrVal === true || drPrVal === 'true';
          }

          html += '<div class="preflight-node">';
          html += '<span style="color:#6b7394;font-size:11px;min-width:20px;">' + step + '</span>';
          html += '<span class="pf-dot" style="background:' + dotColor + ';"></span>';
          html += '<span class="pf-label">' + escapeHtml(label) + '</span>';
          html += '<span class="pf-type">' + escapeHtml(desc) + '</span>';
          if (isDryRun) html += '<span class="preflight-flag flag-warn">dry run</span>';
          if (parallel) html += '<span class="preflight-flag flag-info">parallel</span>';
          html += '</div>';
          step++;
        });
      }

      // Flags and warnings
      var flags = [];

      // Check for empty required variables
      var allVarRefs = [];
      nodes.forEach(function(n) {
        var scan = function(val) {
          if (typeof val === 'string') {
            var matches = val.matchAll(/\\{\\{\\s*vars\\.([^}]+?)\\s*\\}\\}/g);
            for (var m of matches) allVarRefs.push(m[1].trim());
          } else if (val && typeof val === 'object') {
            Object.values(val).forEach(scan);
          }
        };
        if (n.config) Object.values(n.config).forEach(scan);
      });
      // Variables with built-in defaults or that are intentionally optional — no warning needed
      var autoDefaultVars = new Set([
        'adoConfigPath', 'configPath', 'slackConfigPath', 'model',
        'externalUrls', 'adoRepoUrl', 'adoSearchQuery',
        'confluenceSearchQuery', 'confluenceSpaceKey', 'jiraSearchJql',
      ]);
      // If adoRepoUrl is set and contains a parseable URL, suppress warnings for azureDevOpsProject/azureDevOpsRepository
      var adoRepoUrlVal = String(vars['adoRepoUrl'] || '').trim();
      var adoRepoUrlHasProject = false;
      var adoRepoUrlHasRepo = false;
      if (adoRepoUrlVal) {
        var lowerUrl = adoRepoUrlVal.toLowerCase();
        if (lowerUrl.indexOf('/_git/') !== -1) {
          // URL contains /_git/ — has both project and repo
          adoRepoUrlHasProject = true;
          adoRepoUrlHasRepo = true;
        } else if (lowerUrl.indexOf('visualstudio.com/') !== -1 || lowerUrl.indexOf('dev.azure.com/') !== -1) {
          // ADO URL without /_git/ — project-only
          adoRepoUrlHasProject = true;
        } else if (!adoRepoUrlVal.startsWith('http')) {
          // Plain project name
          adoRepoUrlHasProject = true;
        }
      }

      var uniqueVarRefs = allVarRefs.filter(function(v, i, arr) { return arr.indexOf(v) === i; });
      uniqueVarRefs.forEach(function(key) {
        if (autoDefaultVars.has(key)) return;
        // Suppress project/repo warnings when adoRepoUrl provides them
        if (key === 'azureDevOpsProject' && adoRepoUrlHasProject) return;
        if (key === 'azureDevOpsRepository' && adoRepoUrlHasRepo) return;
        var val = vars[key];
        if (val === undefined || val === null || String(val).trim() === '') {
          flags.push({ level: 'warn', text: 'Variable <strong>{{vars.' + escapeHtml(key) + '}}</strong> is empty or not set.' });
        }
      });

      // Check for notable config values
      nodes.forEach(function(n) {
        if (!n.config) return;

        // Dry run detection (resolve {{vars.xxx}} references)
        var drFlagVal = n.config.dryRun;
        var drPrFlagVal = n.config.dryRunPR;
        if (typeof drFlagVal === 'string' && /^\{\{vars\.(.+?)\}\}$/.test(drFlagVal)) { drFlagVal = vars[drFlagVal.match(/^\{\{vars\.(.+?)\}\}$/)[1]]; }
        if (typeof drPrFlagVal === 'string' && /^\{\{vars\.(.+?)\}\}$/.test(drPrFlagVal)) { drPrFlagVal = vars[drPrFlagVal.match(/^\{\{vars\.(.+?)\}\}$/)[1]]; }
        if (drFlagVal === true || drFlagVal === 'true') {
          flags.push({ level: 'warn', text: '<strong>' + escapeHtml(n.id) + '</strong> has <strong>dryRun</strong> enabled &mdash; it will simulate but not execute.' });
        }
        if (drPrFlagVal === true || drPrFlagVal === 'true') {
          flags.push({ level: 'warn', text: '<strong>' + escapeHtml(n.id) + '</strong> has <strong>dryRunPR</strong> enabled &mdash; PR creation will be simulated.' });
        }

        // Interactive clarification
        if (n.config.interactiveClarification === true || n.config.interactiveClarification === 'true') {
          flags.push({ level: 'info', text: '<strong>' + escapeHtml(n.id) + '</strong> has interactive clarification &mdash; it will pause for user input before running.' });
        }

        // Max turns / retries that are 0
        if (n.config.maxRetries === 0 || n.config.maxRetries === '0') {
          flags.push({ level: 'info', text: '<strong>' + escapeHtml(n.id) + '</strong> has maxRetries=0 &mdash; no retries on failure.' });
        }
      });

      // Check for disconnected nodes
      var connected = new Set();
      edges.forEach(function(e) { connected.add(e.from); connected.add(e.to); });
      nodes.forEach(function(n) {
        if (nodes.length > 1 && !connected.has(n.id)) {
          flags.push({ level: 'warn', text: '<strong>' + escapeHtml(n.id) + '</strong> is disconnected &mdash; no edges in or out.' });
        }
      });

      if (flags.length > 0) {
        html += '<div style="margin-top:16px;margin-bottom:8px;"><strong style="color:#e8eaf0;font-size:13px;">Flags</strong></div>';
        flags.forEach(function(f) {
          html += '<div class="preflight-item ' + f.level + '">' + f.text + '</div>';
        });
      } else {
        html += '<div class="preflight-item ok" style="margin-top:16px;">No issues detected. Ready to run.</div>';
      }

      return html;
    }

    function showPreflight() {
      preflightContent.innerHTML = buildPreflightSummary();
      preflightModal.style.display = 'flex';
    }

    // Intercept run button to show preflight first
    preflightRunBtn.onclick = function() {
      closePreflight();
      if (originalRunHandler) originalRunHandler();
    };

    loadMeta().then(function() {
      attachDetailsListeners();
      restoreUiState();
    }).catch((error) => {
      resultEl.textContent = 'Failed to load metadata: ' + String(error);
    });
  </script>
</body>
</html>`;
}

async function loadGraphFromFile(cwd: string, graphPath: string): Promise<WorkflowGraph> {
  const absolute = resolve(cwd, graphPath);
  const raw = readFileSync(absolute, 'utf-8');
  const parsed = JSON.parse(raw) as WorkflowGraph;

  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) {
    throw new Error(`Invalid workflow graph file: ${graphPath}`);
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// First-run setup wizard
// ---------------------------------------------------------------------------





async function runGraphOnce(cwd: string, graphPath: string, varsRaw: string): Promise<void> {
  if (!graphPath) {
    output.printError('Graph file is required for --run mode. Use --graph <path>.');
    process.exit(1);
  }

  const graph = await loadGraphFromFile(cwd, graphPath);
  const variables = JSON.parse(varsRaw) as Record<string, NodeValue>;
  const result = await executeWorkflowGraph(graph, { cwd, variables });

  output.printJson(result);
  process.exit(result.success ? 0 : 1);
}

// ============================================
// Public API
// ============================================

export interface StartOptions {
  port?: number;
  host?: string;
  debug?: boolean;
  run?: boolean;
  graph?: string;
  vars?: string;
}

export async function startServer(opts: StartOptions = {}): Promise<void> {
  const cwd = findProjectRoot(process.cwd());

  if (opts.debug || process.env.WORKFLOW_DEBUG === '1') {
    setWorkflowDebug(true);
  }

  // First-run detection
  const jiraEnvPath = resolve(cwd, resolveJiraConfigPath(cwd));
  const adoEnvPath = resolve(cwd, resolveAdoConfigPath(cwd));
  if (!existsSync(jiraEnvPath)) {
    output.printWarning(
      `Jira configuration not found (${resolveJiraConfigPath(cwd)}).\n` +
      '  Jira and AI-powered nodes will not work until configured.\n' +
      '  Configure credentials via the Jira Config button in the browser UI.'
    );
  }
  if (!existsSync(adoEnvPath)) {
    output.printWarning(
      `Azure DevOps configuration not found (${resolveAdoConfigPath(cwd)}).\n` +
      '  ADO-powered nodes (code search, repo context, PR creation) will not work until configured.\n' +
      '  Configure credentials via the ADO Config button in the browser UI.'
    );
  }

  if (opts.run) {
    await runGraphOnce(cwd, opts.graph || '', opts.vars || '{}');
    return;
  }

  const port = opts.port || 4317;
  const host = opts.host || '127.0.0.1';
  const templates = getStudioTemplates();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${host}:${port}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buildStudioHtml());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/node-definitions') {
      sendJson(res, 200, NODE_DEFINITIONS);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/templates') {
      sendJson(res, 200, templates);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/workflows') {
      try {
        const files = listWorkflowFiles(cwd);
        sendJson(res, 200, files);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/workflows/load') {
      try {
        const filePath = String(url.searchParams.get('path') || '').trim();
        if (!filePath) {
          sendJson(res, 400, { success: false, error: 'Missing path query parameter.' });
          return;
        }

        const absolute = resolveWorkflowFilePath(cwd, filePath);
        const raw = readFileSync(absolute, 'utf-8');
        const parsed = JSON.parse(raw) as WorkflowGraph;
        sendJson(res, 200, {
          success: true,
          path: relative(getWorkflowRoot(cwd), absolute).replace(/\\/g, '/'),
          graph: parsed,
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/workflows/save') {
      try {
        const body = await parseJsonBody(req) as StudioSavePayload;
        const relativePath = String(body.path || '').trim();
        const graph = body.graph;

        if (!relativePath) {
          sendJson(res, 400, { success: false, error: 'Missing workflow path.' });
          return;
        }

        if (!graph || !Array.isArray(graph.nodes)) {
          sendJson(res, 400, { success: false, error: 'Invalid graph payload.' });
          return;
        }

        const absolute = resolveWorkflowFilePath(cwd, relativePath);
        const dir = dirname(absolute);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }

        writeFileSync(absolute, JSON.stringify(graph, null, 2), 'utf-8');
        sendJson(res, 200, {
          success: true,
          path: relative(getWorkflowRoot(cwd), absolute).replace(/\\/g, '/'),
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/workflows/delete') {
      try {
        const body = await parseJsonBody(req) as { path?: string };
        const relativePath = String(body.path || '').trim();

        if (!relativePath) {
          sendJson(res, 400, { success: false, error: 'Missing workflow path.' });
          return;
        }

        const absolute = resolveWorkflowFilePath(cwd, relativePath);

        if (!existsSync(absolute)) {
          sendJson(res, 404, { success: false, error: 'Workflow file not found.' });
          return;
        }

        unlinkSync(absolute);
        sendJson(res, 200, { success: true });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      try {
        const body = await parseJsonBody(req) as StudioRunPayload;
        const graph = body.graph;
        const variables = body.variables || {};

        if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
          sendJson(res, 400, { success: false, error: 'Invalid graph payload' });
          return;
        }

        const result = await executeWorkflowGraph(graph, { cwd, variables });
        sendJson(res, result.success ? 200 : 500, result);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/run/stream') {
      try {
        const body = await parseJsonBody(req) as StudioRunPayload;
        const graph = body.graph;
        const variables = body.variables || {};

        if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
          sendJson(res, 400, { success: false, error: 'Invalid graph payload' });
          return;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const sendSSE = (event: WorkflowProgressEvent) => {
          if (res.writableEnded) return;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        };

        const controller = new AbortController();
        activeAbortController = controller;

        try {
          const result = await executeWorkflowGraph(graph, { cwd, variables }, {
            onProgress: sendSSE,
            signal: controller.signal,
          });

          if (!res.writableEnded) {
            sendSSE({ type: 'workflow-complete', workflowResult: result });
            res.end();
          }
        } finally {
          activeAbortController = null;
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
          sendJson(res, 500, { success: false, error: message });
        } else if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'node-error', nodeId: '_system', error: message })}\n\n`);
          res.end();
        }
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/run/stop') {
      try {
        const body = await parseJsonBody(req) as { force?: boolean };
        const force = Boolean(body.force);

        if (!activeAbortController) {
          sendJson(res, 400, { success: false, error: 'No active workflow run.' });
          return;
        }

        activeAbortController.abort();

        if (force) {
          forceStopActiveExecutor();
        }

        sendJson(res, 200, { success: true, force });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/run/chat') {
      try {
        const body = await parseJsonBody(req) as { sessionId: string; message?: string; done?: boolean; action?: 'apply' | 'discard' };
        if (!body.sessionId) {
          sendJson(res, 400, { success: false, error: 'Missing sessionId' });
          return;
        }
        const result = await handleChatMessage(
          body.sessionId,
          body.message || '',
          Boolean(body.done),
          cwd,
          body.action,
        );
        if (body.done) {
          sendJson(res, 200, { success: true, done: true });
          return;
        }
        if (!result) {
          sendJson(res, 404, { success: false, error: 'No active chat session with that ID' });
          return;
        }
        sendJson(res, 200, { success: true, message: result });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/output/read') {
      try {
        const body = await parseJsonBody(req) as StudioReadOutputPayload;
        const requestedPath = String(body.path || '').trim();
        if (!requestedPath) {
          sendJson(res, 400, { success: false, error: 'Missing output file path.' });
          return;
        }

        const absolute = resolveWorkspaceFilePath(cwd, requestedPath);
        if (!existsSync(absolute)) {
          sendJson(res, 404, { success: false, error: 'Output file not found.' });
          return;
        }

        const content = readFileSync(absolute, 'utf-8');
        sendJson(res, 200, {
          success: true,
          path: relative(cwd, absolute).replace(/\\/g, '/'),
          content,
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    /* -- Jira Config endpoints ---------------------------------------- */

    if (req.method === 'GET' && url.pathname === '/api/jira-config') {
      try {
        const configRelPath = String(url.searchParams.get('path') || '').trim();
        if (!configRelPath) {
          sendJson(res, 400, { success: false, error: 'Missing path query parameter.' });
          return;
        }

        const absolute = resolveWorkspaceFilePath(cwd, configRelPath);
        if (!existsSync(absolute)) {
          sendJson(res, 200, {
            success: true,
            exists: false,
            values: { JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '', JIRA_CA_CERT_PATH: '', JIRA_AI_MODEL: 'anthropic.claude-sonnet-4-6' },
          });
          return;
        }

        const entries = readConfigDecrypted(absolute, cwd);
        if (entries.JIRA_API_TOKEN) {
          const tok = entries.JIRA_API_TOKEN;
          entries.JIRA_API_TOKEN = tok.length > 8 ? tok.slice(0, 4) + '****' + tok.slice(-4) : '****';
        }

        sendJson(res, 200, { success: true, exists: true, values: entries });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/jira-config') {
      try {
        const body = await parseJsonBody(req) as { path?: string; values?: Record<string, string> };
        const configRelPath = String(body.path || '').trim();
        const values = body.values || {};

        if (!configRelPath) {
          sendJson(res, 400, { success: false, error: 'Missing config file path.' });
          return;
        }

        const absolute = resolveWorkspaceFilePath(cwd, configRelPath);
        if (values.JIRA_API_TOKEN && values.JIRA_API_TOKEN.includes('****') && existsSync(absolute)) {
          const oldEntries = readConfigDecrypted(absolute, cwd);
          if (oldEntries.JIRA_API_TOKEN) values.JIRA_API_TOKEN = oldEntries.JIRA_API_TOKEN;
        }

        const orderedKeys = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_CA_CERT_PATH', 'JIRA_AI_MODEL'];
        writeConfigEncrypted(absolute, cwd, values, orderedKeys);
        sendJson(res, 200, { success: true });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/jira-test') {
      try {
        const body = await parseJsonBody(req) as { baseUrl?: string; email?: string; apiToken?: string; caCertPath?: string };
        const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
        const email = String(body.email || '').trim();
        const apiToken = String(body.apiToken || '').trim();
        const caCertPath = String(body.caCertPath || '').trim();

        if (!baseUrl || !email || !apiToken) {
          sendJson(res, 400, { success: false, error: 'Base URL, email, and API token are required.' });
          return;
        }

        const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
        const testUrl = new URL(`${baseUrl}/rest/api/3/myself`);

        let caCertPem: string | undefined;
        if (caCertPath) {
          const resolvedCa = resolve(caCertPath);
          if (existsSync(resolvedCa)) caCertPem = readFileSync(resolvedCa, 'utf-8');
        }

        const testResult = await new Promise<{ ok: boolean; status: number; body: string }>((resolveP) => {
          const reqObj = httpsRequest(testUrl, {
            method: 'GET', headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' }, ca: caCertPem,
          }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            resp.on('end', () => {
              const rawBody = Buffer.concat(chunks).toString('utf-8');
              resolveP({ ok: (resp.statusCode || 0) >= 200 && (resp.statusCode || 0) < 300, status: resp.statusCode || 0, body: rawBody });
            });
          });
          reqObj.on('error', (err) => resolveP({ ok: false, status: 0, body: err.message }));
          reqObj.setTimeout(10000, () => { reqObj.destroy(); resolveP({ ok: false, status: 0, body: 'Connection timed out' }); });
          reqObj.end();
        });

        if (testResult.ok) {
          let displayName = '';
          try { const parsed = JSON.parse(testResult.body); displayName = parsed.displayName || parsed.emailAddress || ''; } catch { /* ignore */ }
          sendJson(res, 200, { success: true, displayName });
        } else {
          sendJson(res, 200, { success: false, status: testResult.status, error: testResult.body });
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    /* -- ADO Config endpoints ----------------------------------------- */

    if (req.method === 'GET' && url.pathname === '/api/ado-config') {
      try {
        const configRelPath = String(url.searchParams.get('path') || '').trim();
        if (!configRelPath) {
          sendJson(res, 400, { success: false, error: 'Missing path query parameter.' });
          return;
        }

        const absolute = resolveWorkspaceFilePath(cwd, configRelPath);
        if (!existsSync(absolute)) {
          sendJson(res, 200, {
            success: true,
            exists: false,
            values: { AZURE_DEVOPS_ORG_URL: '', AZURE_DEVOPS_PAT: '' },
          });
          return;
        }

        const entries = readConfigDecrypted(absolute, cwd);
        if (entries.AZURE_DEVOPS_PAT) {
          const tok = entries.AZURE_DEVOPS_PAT;
          entries.AZURE_DEVOPS_PAT = tok.length > 8 ? tok.slice(0, 4) + '****' + tok.slice(-4) : '****';
        }

        sendJson(res, 200, { success: true, exists: true, values: entries });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/ado-config') {
      try {
        const body = await parseJsonBody(req) as { path?: string; values?: Record<string, string> };
        const configRelPath = String(body.path || '').trim();
        const values = body.values || {};

        if (!configRelPath) {
          sendJson(res, 400, { success: false, error: 'Missing config file path.' });
          return;
        }

        const absolute = resolveWorkspaceFilePath(cwd, configRelPath);
        if (values.AZURE_DEVOPS_PAT && values.AZURE_DEVOPS_PAT.includes('****') && existsSync(absolute)) {
          const oldEntries = readConfigDecrypted(absolute, cwd);
          if (oldEntries.AZURE_DEVOPS_PAT) values.AZURE_DEVOPS_PAT = oldEntries.AZURE_DEVOPS_PAT;
        }

        const orderedKeys = ['AZURE_DEVOPS_ORG_URL', 'AZURE_DEVOPS_PAT'];
        writeConfigEncrypted(absolute, cwd, values, orderedKeys);
        sendJson(res, 200, { success: true });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/ado-test') {
      try {
        const body = await parseJsonBody(req) as { orgUrl?: string; pat?: string };
        const orgUrl = String(body.orgUrl || '').trim().replace(/\/+$/, '');
        const pat = String(body.pat || '').trim();

        if (!orgUrl || !pat) {
          sendJson(res, 400, { success: false, error: 'Organization URL and PAT are required.' });
          return;
        }

        const testUrl = new URL(`${orgUrl}/_apis/projects?api-version=7.1-preview&$top=1`);
        const auth = Buffer.from(`:${pat}`).toString('base64');

        const testResult = await new Promise<{ ok: boolean; status: number; body: string }>((resolveP) => {
          const reqObj = httpsRequest(testUrl, {
            method: 'GET', headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
          }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            resp.on('end', () => {
              const rawBody = Buffer.concat(chunks).toString('utf-8');
              resolveP({ ok: (resp.statusCode || 0) >= 200 && (resp.statusCode || 0) < 300, status: resp.statusCode || 0, body: rawBody });
            });
          });
          reqObj.on('error', (err) => resolveP({ ok: false, status: 0, body: err.message }));
          reqObj.setTimeout(10000, () => { reqObj.destroy(); resolveP({ ok: false, status: 0, body: 'Connection timed out' }); });
          reqObj.end();
        });

        if (testResult.ok) {
          let projectCount = 0;
          try { const parsed = JSON.parse(testResult.body); projectCount = parsed.count || 0; } catch { /* ignore */ }
          sendJson(res, 200, { success: true, displayName: `${projectCount} project(s) accessible` });
        } else {
          sendJson(res, 200, { success: false, status: testResult.status, error: testResult.body });
        }
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJson(res, 500, { success: false, error: message });
        return;
      }
    }

    /* -- Slack Config endpoints --------------------------------------- */

    if (req.method === 'GET' && url.pathname === '/api/slack-config') {
      try {
        const configRelPath = String(url.searchParams.get('path') || '').trim();
        if (!configRelPath) { sendJson(res, 400, { success: false, error: 'Missing path query parameter.' }); return; }

        const absolute = resolveWorkspaceFilePath(cwd, configRelPath);
        if (!existsSync(absolute)) {
          sendJson(res, 200, { success: true, exists: false, values: { SLACK_WEBHOOK_URL: '', SLACK_BOT_TOKEN: '', SLACK_DEFAULT_CHANNEL: '' } });
          return;
        }

        const entries = readConfigDecrypted(absolute, cwd);
        if (entries.SLACK_BOT_TOKEN) {
          const tok = entries.SLACK_BOT_TOKEN;
          entries.SLACK_BOT_TOKEN = tok.length > 8 ? tok.slice(0, 4) + '****' + tok.slice(-4) : '****';
        }
        sendJson(res, 200, { success: true, exists: true, values: entries });
        return;
      } catch (error) { sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) }); return; }
    }

    if (req.method === 'POST' && url.pathname === '/api/slack-config') {
      try {
        const body = await parseJsonBody(req) as { path?: string; values?: Record<string, string> };
        const configRelPath = String(body.path || '').trim();
        const values = body.values || {};
        if (!configRelPath) { sendJson(res, 400, { success: false, error: 'Missing config file path.' }); return; }

        const absolute = resolveWorkspaceFilePath(cwd, configRelPath);
        if (values.SLACK_BOT_TOKEN && values.SLACK_BOT_TOKEN.includes('****') && existsSync(absolute)) {
          const oldEntries = readConfigDecrypted(absolute, cwd);
          if (oldEntries.SLACK_BOT_TOKEN) values.SLACK_BOT_TOKEN = oldEntries.SLACK_BOT_TOKEN;
        }

        writeConfigEncrypted(absolute, cwd, values, ['SLACK_WEBHOOK_URL', 'SLACK_BOT_TOKEN', 'SLACK_DEFAULT_CHANNEL']);
        sendJson(res, 200, { success: true });
        return;
      } catch (error) { sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) }); return; }
    }

    if (req.method === 'POST' && url.pathname === '/api/slack-test') {
      try {
        const body = await parseJsonBody(req) as { webhookUrl?: string };
        const webhookUrl = String(body.webhookUrl || '').trim();
        if (!webhookUrl) { sendJson(res, 400, { success: false, error: 'Webhook URL is required.' }); return; }

        let parsedUrl: URL;
        try { parsedUrl = new URL(webhookUrl); } catch { sendJson(res, 400, { success: false, error: 'Invalid webhook URL.' }); return; }

        const payload = JSON.stringify({ text: 'Workflow Studio test message' });
        const testResult = await new Promise<{ ok: boolean; status: number; body: string }>((resolveP) => {
          const reqObj = httpsRequest(parsedUrl, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          }, (resp) => {
            const chunks: Buffer[] = [];
            resp.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            resp.on('end', () => {
              const rawBody = Buffer.concat(chunks).toString('utf-8');
              resolveP({ ok: (resp.statusCode || 0) >= 200 && (resp.statusCode || 0) < 300, status: resp.statusCode || 0, body: rawBody });
            });
          });
          reqObj.on('error', (err) => resolveP({ ok: false, status: 0, body: err.message }));
          reqObj.setTimeout(10000, () => { reqObj.destroy(); resolveP({ ok: false, status: 0, body: 'Connection timed out' }); });
          reqObj.write(payload);
          reqObj.end();
        });

        sendJson(res, 200, testResult.ok ? { success: true } : { success: false, status: testResult.status, error: testResult.body });
        return;
      } catch (error) { sendJson(res, 500, { success: false, error: error instanceof Error ? error.message : String(error) }); return; }
    }

    sendJson(res, 404, { error: 'Not Found' });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => resolvePromise());
  });

  output.printSuccess(`Workflow Studio started at http://${host}:${port}`);
  output.printInfo('Use Ctrl+C to stop the server.');

  await new Promise<void>((resolvePromise) => {
    const close = () => { server.close(() => resolvePromise()); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}
