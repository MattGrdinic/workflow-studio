import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We start a real server instance for integration testing
let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
let baseUrl: string;
const TEST_PORT = 14317;
const TEST_CWD = join(tmpdir(), 'ws-test-' + Date.now());

function httpGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: data }));
    }).on('error', reject);
  });
}

function httpPost(path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let result = '';
      res.on('data', (chunk) => (result += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: result }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

beforeAll(async () => {
  // Create a temp directory with the expected structure
  mkdirSync(join(TEST_CWD, 'data', 'workflows'), { recursive: true });
  mkdirSync(join(TEST_CWD, 'data', 'Jira', 'config'), { recursive: true });
  mkdirSync(join(TEST_CWD, 'data', 'ADO', 'config'), { recursive: true });
  mkdirSync(join(TEST_CWD, 'data', 'Slack', 'config'), { recursive: true });

  // Start the server
  const { spawn } = await import('child_process');
  const cliPath = join(process.cwd(), 'dist', 'cli.js');

  serverProcess = spawn('node', [cliPath, '--port', String(TEST_PORT)], {
    cwd: TEST_CWD,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' },
  });

  baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  // Wait for server to be ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 10000);
    const check = () => {
      http.get(baseUrl, (res) => {
        clearTimeout(timeout);
        res.resume();
        resolve();
      }).on('error', () => setTimeout(check, 200));
    };
    check();
  });
}, 15000);

afterAll(() => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  if (existsSync(TEST_CWD)) {
    rmSync(TEST_CWD, { recursive: true, force: true });
  }
});

describe('Server HTTP API', () => {
  // ─── GET / ─────────────────────────────────────────────

  it('GET / returns HTML', async () => {
    const res = await httpGet('/');
    expect(res.status).toBe(200);
    expect(res.body.toLowerCase()).toContain('<!doctype html>');
    expect(res.body).toContain('Workflow Studio');
  });

  // ─── GET /api/node-definitions ─────────────────────────

  it('GET /api/node-definitions returns array', async () => {
    const res = await httpGet('/api/node-definitions');
    expect(res.status).toBe(200);
    const defs = JSON.parse(res.body);
    expect(Array.isArray(defs)).toBe(true);
    expect(defs.length).toBeGreaterThan(0);
    expect(defs[0].type).toBeTruthy();
    expect(defs[0].title).toBeTruthy();
  });

  // ─── GET /api/templates ────────────────────────────────

  it('GET /api/templates returns array', async () => {
    const res = await httpGet('/api/templates');
    expect(res.status).toBe(200);
    const templates = JSON.parse(res.body);
    expect(Array.isArray(templates)).toBe(true);
    expect(templates.length).toBeGreaterThan(0);
  });

  // ─── Workflow CRUD ─────────────────────────────────────

  it('GET /api/workflows returns empty list initially', async () => {
    const res = await httpGet('/api/workflows');
    expect(res.status).toBe(200);
    const files = JSON.parse(res.body);
    expect(Array.isArray(files)).toBe(true);
  });

  it('POST /api/workflows/save creates a workflow', async () => {
    const graph = { id: 'test-wf', name: 'Test', nodes: [{ id: 'a', type: 'io.readFile' }], edges: [] };
    const res = await httpPost('/api/workflows/save', { path: 'test-wf.json', graph });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.path).toBe('test-wf.json');
  });

  it('GET /api/workflows/load loads the saved workflow', async () => {
    const res = await httpGet('/api/workflows/load?path=test-wf.json');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.graph.name).toBe('Test');
    expect(body.graph.nodes).toHaveLength(1);
  });

  it('GET /api/workflows lists saved workflows', async () => {
    const res = await httpGet('/api/workflows');
    expect(res.status).toBe(200);
    const files = JSON.parse(res.body);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files.some((f: { name: string }) => f.name === 'test-wf')).toBe(true);
  });

  it('POST /api/workflows/delete removes the workflow', async () => {
    const res = await httpPost('/api/workflows/delete', { path: 'test-wf.json' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });

  it('POST /api/workflows/delete returns 404 for missing file', async () => {
    const res = await httpPost('/api/workflows/delete', { path: 'nonexistent.json' });
    expect(res.status).toBe(404);
  });

  // ─── Validation ────────────────────────────────────────

  it('POST /api/workflows/save rejects missing path', async () => {
    const res = await httpPost('/api/workflows/save', { graph: { nodes: [] } });
    expect(res.status).toBe(400);
  });

  it('POST /api/workflows/save rejects invalid graph', async () => {
    const res = await httpPost('/api/workflows/save', { path: 'bad.json', graph: { nodes: 'not-array' } });
    expect(res.status).toBe(400);
  });

  it('GET /api/workflows/load rejects missing path', async () => {
    const res = await httpGet('/api/workflows/load');
    expect(res.status).toBe(400);
  });

  // ─── Claude status ─────────────────────────────────────

  it('GET /api/claude-status returns status object', async () => {
    const res = await httpGet('/api/claude-status');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(typeof body.available).toBe('boolean');
  });
});
