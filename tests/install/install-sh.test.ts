import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const ROOT = process.cwd();
const INSTALL_SH = join(ROOT, 'install.sh');

describe('install.sh (Mac/Linux)', () => {
  const content = existsSync(INSTALL_SH) ? readFileSync(INSTALL_SH, 'utf-8') : '';

  it('file exists', () => {
    expect(existsSync(INSTALL_SH)).toBe(true);
  });

  it('starts with a shebang', () => {
    expect(content.startsWith('#!/bin/sh')).toBe(true);
  });

  it('uses set -e for error handling', () => {
    expect(content).toContain('set -e');
  });

  it('defines the correct GitHub repo', () => {
    expect(content).toContain('REPO="MattGrdinic/workflow-studio"');
  });

  it('checks for Node.js >= 20', () => {
    expect(content).toContain('check_node');
    expect(content).toContain('NODE_MAJOR');
    expect(content).toContain('-ge 20');
  });

  it('has nvm fallback installation', () => {
    expect(content).toContain('install_node');
    expect(content).toContain('nvm install 20');
  });

  it('checks for required commands', () => {
    expect(content).toContain('need_cmd npm');
    expect(content).toContain('need_cmd curl');
  });

  it('fetches latest release from GitHub API', () => {
    expect(content).toContain('api.github.com/repos');
    expect(content).toContain('releases/latest');
  });

  it('falls back to main branch if no releases', () => {
    expect(content).toContain('archive/refs/heads/main.tar.gz');
  });

  it('downloads and extracts to a temp directory', () => {
    expect(content).toContain('mktemp -d');
    expect(content).toContain('tar -xzf');
  });

  it('cleans up temp files on exit', () => {
    expect(content).toContain("trap 'rm -rf");
  });

  it('installs npm dependencies', () => {
    expect(content).toContain('npm install');
  });

  it('builds from source if dist is missing', () => {
    expect(content).toContain('npm run build');
  });

  it('creates a symlink in /usr/local/bin', () => {
    expect(content).toContain('ln -sf');
    expect(content).toContain('/usr/local/bin/workflow-studio');
  });

  it('saves a version marker', () => {
    expect(content).toContain('.installed-version');
  });

  it('prints success message with getting started instructions', () => {
    expect(content).toContain('installed successfully');
    expect(content).toContain('workflow-studio');
    expect(content).toContain('127.0.0.1:4317');
  });

  it('includes uninstall instructions', () => {
    expect(content).toContain('Uninstall');
    expect(content).toContain('sudo rm -rf');
  });

  it('handles both Darwin and Linux', () => {
    expect(content).toContain('Darwin');
    expect(content).toContain('Linux');
  });

  it('rejects unsupported operating systems', () => {
    expect(content).toContain('Unsupported operating system');
    expect(content).toContain('install.ps1 for Windows');
  });

  // Syntax check (if bash is available)
  it('passes shell syntax check', () => {
    try {
      execSync(`bash -n "${INSTALL_SH}"`, { stdio: 'pipe' });
    } catch (err: unknown) {
      const error = err as { stderr?: Buffer };
      expect.fail(`Shell syntax error: ${error.stderr?.toString()}`);
    }
  });
});
