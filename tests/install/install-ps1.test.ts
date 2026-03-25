import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const INSTALL_PS1 = join(ROOT, 'install.ps1');

describe('install.ps1 (Windows)', () => {
  const content = existsSync(INSTALL_PS1) ? readFileSync(INSTALL_PS1, 'utf-8') : '';

  it('file exists', () => {
    expect(existsSync(INSTALL_PS1)).toBe(true);
  });

  it('requires PowerShell 5.1+', () => {
    expect(content).toContain('#Requires -Version 5.1');
  });

  it('has ErrorActionPreference Stop', () => {
    expect(content).toContain('$ErrorActionPreference = "Stop"');
  });

  it('defines the correct GitHub repo', () => {
    expect(content).toContain('$Repo = "MattGrdinic/workflow-studio"');
  });

  it('installs to LOCALAPPDATA by default', () => {
    expect(content).toContain('$env:LOCALAPPDATA');
    expect(content).toContain('workflow-studio');
  });

  it('supports custom install directory via env var', () => {
    expect(content).toContain('WORKFLOW_STUDIO_INSTALL_DIR');
  });

  it('checks for Node.js >= 20', () => {
    expect(content).toContain('Test-Node');
    expect(content).toContain('-ge 20');
  });

  it('has winget as primary Node.js installer', () => {
    expect(content).toContain('winget install');
    expect(content).toContain('OpenJS.NodeJS.LTS');
  });

  it('falls back to direct MSI download', () => {
    expect(content).toContain('nodejs.org/dist');
    expect(content).toContain('.msi');
  });

  it('checks for npm', () => {
    expect(content).toContain('Get-Command npm');
  });

  it('fetches latest release from GitHub API', () => {
    expect(content).toContain('api.github.com/repos');
    expect(content).toContain('releases/latest');
  });

  it('falls back to main branch if no releases', () => {
    expect(content).toContain('archive/refs/heads/main.zip');
  });

  it('uses Expand-Archive for extraction', () => {
    expect(content).toContain('Expand-Archive');
  });

  it('installs npm dependencies', () => {
    expect(content).toContain('npm install');
  });

  it('builds from source if dist is missing', () => {
    expect(content).toContain('npm run build');
  });

  it('creates a launcher CMD script', () => {
    expect(content).toContain('workflow-studio.cmd');
    expect(content).toContain('node');
    expect(content).toContain('dist\\cli.js');
  });

  it('adds to user PATH', () => {
    expect(content).toContain('SetEnvironmentVariable');
    expect(content).toContain('"PATH"');
    expect(content).toContain('"User"');
  });

  it('cleans up temp files', () => {
    expect(content).toContain('Remove-Item');
    expect(content).toContain('$tmpZip');
    expect(content).toContain('$tmpDir');
  });

  it('saves a version marker', () => {
    expect(content).toContain('.installed-version');
  });

  it('prints success message', () => {
    expect(content).toContain('installed successfully');
  });

  it('prints uninstall instructions', () => {
    expect(content).toContain('Uninstall');
    expect(content).toContain('Remove-Item -Recurse -Force');
  });

  it('notes about restarting terminal for PATH changes', () => {
    expect(content).toContain('restart your terminal');
  });

  it('refreshes PATH after Node.js install', () => {
    expect(content).toContain('GetEnvironmentVariable("PATH", "Machine")');
  });
});
