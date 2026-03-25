import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

describe('Build output', () => {
  it('dist/cli.js exists', () => {
    const path = join(ROOT, 'dist', 'cli.js');
    expect(existsSync(path), 'dist/cli.js not found — run npm run build first').toBe(true);
  });

  it('dist/cli.js starts with a shebang', () => {
    const content = readFileSync(join(ROOT, 'dist', 'cli.js'), 'utf-8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
  });

  it('dist/cli.js is a reasonable size (> 100KB, bundled)', () => {
    const stat = statSync(join(ROOT, 'dist', 'cli.js'));
    expect(stat.size).toBeGreaterThan(100 * 1024);
  });

  it('dist/package.json exists with type module', () => {
    const path = join(ROOT, 'dist', 'package.json');
    expect(existsSync(path)).toBe(true);
    const pkg = JSON.parse(readFileSync(path, 'utf-8'));
    expect(pkg.type).toBe('module');
  });

  it('dist/package.json version matches root package.json', () => {
    const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
    const distPkg = JSON.parse(readFileSync(join(ROOT, 'dist', 'package.json'), 'utf-8'));
    expect(distPkg.version).toBe(rootPkg.version);
  });
});

describe('package.json', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));

  it('has a valid version string', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('specifies Node >= 20', () => {
    expect(pkg.engines.node).toBe('>=20');
  });

  it('has required scripts', () => {
    expect(pkg.scripts.build).toBeTruthy();
    expect(pkg.scripts.dev).toBeTruthy();
    expect(pkg.scripts.start).toBeTruthy();
  });

  it('bin points to dist/cli.js', () => {
    expect(pkg.bin['workflow-studio']).toBe('./dist/cli.js');
  });

  it('main points to electron/main.cjs', () => {
    expect(pkg.main).toBe('electron/main.cjs');
  });

  it('electron-builder config is present', () => {
    expect(pkg.build).toBeTruthy();
    expect(pkg.build.appId).toBe('com.workflowstudio.app');
    expect(pkg.build.mac).toBeTruthy();
    expect(pkg.build.win).toBeTruthy();
  });

  it('extraResources includes server dist and preload', () => {
    const resources = pkg.build.extraResources;
    expect(resources.some((r: { from: string }) => r.from === 'dist')).toBe(true);
    expect(resources.some((r: { from: string }) => r.from === 'electron/preload.cjs')).toBe(true);
  });
});

describe('Electron files', () => {
  it('electron/main.cjs exists', () => {
    expect(existsSync(join(ROOT, 'electron', 'main.cjs'))).toBe(true);
  });

  it('electron/preload.cjs exists', () => {
    expect(existsSync(join(ROOT, 'electron', 'preload.cjs'))).toBe(true);
  });

  it('electron/entitlements.mac.plist exists', () => {
    expect(existsSync(join(ROOT, 'electron', 'entitlements.mac.plist'))).toBe(true);
  });

  it('preload.cjs exposes electronAPI', () => {
    const content = readFileSync(join(ROOT, 'electron', 'preload.cjs'), 'utf-8');
    expect(content).toContain('contextBridge');
    expect(content).toContain('electronAPI');
    expect(content).toContain('showSaveDialog');
    expect(content).toContain('showNotification');
    expect(content).toContain('isElectron');
  });

  it('main.cjs handles IPC for save dialog and notifications', () => {
    const content = readFileSync(join(ROOT, 'electron', 'main.cjs'), 'utf-8');
    expect(content).toContain("ipcMain.handle('dialog:save'");
    expect(content).toContain("ipcMain.handle('notification:show'");
  });
});

describe('Source files', () => {
  const srcFiles = [
    'src/cli.ts',
    'src/server.ts',
    'src/runtime.ts',
    'src/definitions.ts',
    'src/templates.ts',
    'src/types.ts',
    'src/claude-executor.ts',
  ];

  for (const file of srcFiles) {
    it(`${file} exists`, () => {
      expect(existsSync(join(ROOT, file))).toBe(true);
    });
  }
});

describe('tsconfig.json', () => {
  const tsconfig = JSON.parse(readFileSync(join(ROOT, 'tsconfig.json'), 'utf-8'));

  it('targets ES2022', () => {
    expect(tsconfig.compilerOptions.target).toBe('ES2022');
  });

  it('uses ESNext modules', () => {
    expect(tsconfig.compilerOptions.module).toBe('ESNext');
  });

  it('has strict mode enabled', () => {
    expect(tsconfig.compilerOptions.strict).toBe(true);
  });
});
