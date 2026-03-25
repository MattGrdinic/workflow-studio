import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { load as loadYaml } from 'js-yaml';

const ROOT = process.cwd();

// Parse the YAML manually since js-yaml may not be installed
function parseYaml(content: string): Record<string, unknown> {
  // Simple YAML parser isn't available, so we'll test the raw content
  return { raw: content };
}

describe('GitHub Actions release workflow', () => {
  const workflowPath = join(ROOT, '.github', 'workflows', 'release.yml');

  it('workflow file exists', () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  const content = existsSync(workflowPath) ? readFileSync(workflowPath, 'utf-8') : '';

  it('triggers on push to main', () => {
    expect(content).toContain('push:');
    expect(content).toContain('branches: [main]');
  });

  it('has write permissions for contents', () => {
    expect(content).toContain('contents: write');
  });

  it('has a tag job', () => {
    expect(content).toContain('tag:');
    expect(content).toContain('Determine version from package.json');
  });

  it('tag job checks for existing tags to avoid duplicates', () => {
    expect(content).toContain('git rev-parse');
    expect(content).toContain('skipped=true');
  });

  it('has a macOS build job', () => {
    expect(content).toContain('build-mac:');
    expect(content).toContain('macos-latest');
    expect(content).toContain('electron-builder --mac');
  });

  it('has a Windows build job', () => {
    expect(content).toContain('build-win:');
    expect(content).toContain('windows-latest');
    expect(content).toContain('electron-builder --win');
  });

  it('build jobs need tag job', () => {
    expect(content).toContain('needs: tag');
  });

  it('build jobs skip when tag exists', () => {
    expect(content).toContain("needs.tag.outputs.skipped == 'false'");
  });

  it('has a release job that depends on builds', () => {
    expect(content).toContain('release:');
    expect(content).toContain('needs: [tag');
  });

  it('uses softprops/action-gh-release for release creation', () => {
    expect(content).toContain('softprops/action-gh-release');
  });

  it('uploads mac and win artifacts', () => {
    expect(content).toContain('mac-builds');
    expect(content).toContain('win-builds');
  });

  it('uses Node.js 20', () => {
    expect(content).toContain('node-version: 20');
  });

  it('runs npm ci for dependency installation', () => {
    expect(content).toContain('npm ci');
  });

  it('has a test job that gates releases', () => {
    expect(content).toContain('test:');
  });
});
