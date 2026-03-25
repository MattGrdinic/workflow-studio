import { describe, it, expect, beforeAll } from 'vitest';
import http from 'http';

// These tests verify the HTML/JS output of the server's buildStudioHtml function
// by fetching the page and inspecting its content. They share the server from server.test.ts
// via a consistent port.

const TEST_PORT = 14317;
const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

function httpGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: data }));
    }).on('error', reject);
  });
}

let html: string;

beforeAll(async () => {
  // Wait for server to be available (it may already be running from server.test.ts)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server not available')), 10000);
    const check = () => {
      http.get(baseUrl, (res) => {
        clearTimeout(timeout);
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          html = data;
          resolve();
        });
      }).on('error', () => setTimeout(check, 200));
    };
    check();
  });
}, 15000);

describe('UI HTML structure', () => {
  it('renders a valid HTML5 document', () => {
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  it('has the correct title', () => {
    expect(html).toContain('<title>Workflow Studio</title>');
  });

  it('contains the canvas element', () => {
    expect(html).toContain('id="canvas"');
    expect(html).toContain('class="canvas"');
  });

  it('contains the SVG edges layer', () => {
    expect(html).toContain('id="edges"');
    expect(html).toContain('class="edges"');
  });

  it('contains the toolbar buttons', () => {
    expect(html).toContain('id="runBtn"');
    expect(html).toContain('id="stopBtn"');
    expect(html).toContain('id="saveBtn"');
    expect(html).toContain('id="reloadBtn"');
  });

  it('contains the notification settings button', () => {
    expect(html).toContain('id="notifSettingsBtn"');
  });

  it('contains zoom controls', () => {
    expect(html).toContain('id="zoomInBtn"');
    expect(html).toContain('id="zoomOutBtn"');
    expect(html).toContain('id="zoomFitBtn"');
    expect(html).toContain('id="zoomResetBtn"');
    expect(html).toContain('id="zoomLabel"');
  });

  it('contains the node editor panel', () => {
    expect(html).toContain('id="nodeForm"');
    expect(html).toContain('id="nodeFormTab"');
  });

  it('contains output tabs', () => {
    expect(html).toContain('id="outputTabBtn"');
    expect(html).toContain('id="resultTabBtn"');
    expect(html).toContain('id="outputTabPanel"');
    expect(html).toContain('id="resultTabPanel"');
  });

  it('contains the download button', () => {
    expect(html).toContain('id="downloadOutputBtn"');
  });

  it('contains the toast container', () => {
    expect(html).toContain('id="toastContainer"');
  });

  it('contains the preflight modal', () => {
    expect(html).toContain('id="preflightModal"');
    expect(html).toContain('id="preflightRun"');
    expect(html).toContain('id="preflightCancel"');
  });

  it('contains the notification settings modal', () => {
    expect(html).toContain('id="notifModal"');
    expect(html).toContain('id="notifEnabled"');
    expect(html).toContain('id="notifOnlyBackground"');
    expect(html).toContain('id="notifPerNode"');
    expect(html).toContain('id="notifThreshold"');
    expect(html).toContain('id="notifSave"');
  });

  it('contains Jira config modal', () => {
    expect(html).toContain('id="jiraConfigModal"');
  });

  it('contains the welcome banner', () => {
    expect(html).toContain('id="welcomeBanner"');
  });
});

describe('UI CSS', () => {
  it('includes canvas dot grid background', () => {
    expect(html).toContain('radial-gradient');
    expect(html).toContain('background-size');
  });

  it('includes node styles', () => {
    expect(html).toContain('.node {');
    expect(html).toContain('.node.selected');
  });

  it('includes hover fix for selected nodes', () => {
    expect(html).toContain(':not(.selected)');
  });

  it('includes toast animation', () => {
    expect(html).toContain('@keyframes toastIn');
    expect(html).toContain('@keyframes toastOut');
  });

  it('includes port styles', () => {
    expect(html).toContain('.port');
    expect(html).toContain('.port-in');
    expect(html).toContain('.port-out');
  });

  it('includes edge styles', () => {
    expect(html).toContain('.edge-hitbox');
    expect(html).toContain('.edge-delete-btn');
  });
});

describe('UI JavaScript', () => {
  it('includes showToast function', () => {
    expect(html).toContain('function showToast');
  });

  it('includes undo/redo system', () => {
    expect(html).toContain('undoStack');
    expect(html).toContain('redoStack');
    expect(html).toContain('pushUndo');
  });

  it('includes render function', () => {
    expect(html).toContain('function render()');
  });

  it('includes executeWorkflow function', () => {
    expect(html).toContain('async function executeWorkflow');
  });

  it('includes notification settings logic', () => {
    expect(html).toContain('notifSettings');
    expect(html).toContain('fireNotification');
    expect(html).toContain('document.hasFocus');
  });

  it('includes title bar progress updates', () => {
    expect(html).toContain("document.title = '");
    expect(html).toContain('Running...');
  });

  it('includes per-node notification logic', () => {
    expect(html).toContain('nodeStartTimes');
    expect(html).toContain('thresholdSec');
  });

  it('includes keyboard shortcut handlers', () => {
    expect(html).toContain('Ctrl+Z');
    expect(html).toContain('Ctrl+Shift+Z');
  });

  it('includes context menu with search', () => {
    expect(html).toContain('contextmenu');
    expect(html).toContain('searchInput');
  });

  it('includes Notification permission request', () => {
    expect(html).toContain('Notification.requestPermission');
  });

  it('includes electronAPI detection', () => {
    expect(html).toContain('window.electronAPI');
  });

  it('includes workflow name input', () => {
    expect(html).toContain('id="workflowName"');
  });

  it('includes variables editor', () => {
    expect(html).toContain('id="variables"');
  });

  it('includes output preview and raw views', () => {
    expect(html).toContain('id="outputPreview"');
    expect(html).toContain('id="outputRaw"');
  });
});
