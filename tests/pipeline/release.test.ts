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

describe('Azure DevOps release pipeline', () => {
  const pipelinePath = join(ROOT, 'azure-pipelines.yml');

  it('pipeline file exists', () => {
    expect(existsSync(pipelinePath)).toBe(true);
  });

  const content = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf-8') : '';

  it('triggers on push to main', () => {
    expect(content).toContain('- main');
  });

  it('has a Test stage', () => {
    expect(content).toContain("stage: Test");
    expect(content).toContain('vitest run --coverage');
  });

  it('has a Tag stage that depends on Test', () => {
    expect(content).toContain("stage: Tag");
    expect(content).toContain('dependsOn: Test');
  });

  it('tag stage checks for existing tags', () => {
    expect(content).toContain('git rev-parse');
    expect(content).toContain('SKIPPED');
  });

  it('has a macOS build stage', () => {
    expect(content).toContain("stage: BuildMac");
    expect(content).toContain('macos-latest');
    expect(content).toContain('electron-builder --mac');
  });

  it('has a Windows build stage', () => {
    expect(content).toContain("stage: BuildWin");
    expect(content).toContain('windows-latest');
    expect(content).toContain('electron-builder --win');
  });

  it('has a Release stage that depends on builds', () => {
    expect(content).toContain("stage: Release");
    expect(content).toContain('- BuildMac');
    expect(content).toContain('- BuildWin');
  });

  it('publishes mac and win artifacts', () => {
    expect(content).toContain('artifact: mac-builds');
    expect(content).toContain('artifact: win-builds');
  });

  it('uses Node.js 20', () => {
    expect(content).toContain("nodeVersion: '20'");
  });

  it('runs npm ci', () => {
    expect(content).toContain('npm ci');
  });

  it('publishes test results and code coverage', () => {
    expect(content).toContain('PublishTestResults@2');
    expect(content).toContain('PublishCodeCoverageResults@2');
  });
});

describe('Azure DevOps PR pipeline', () => {
  const pipelinePath = join(ROOT, 'azure-pipelines-pr.yml');

  it('pipeline file exists', () => {
    expect(existsSync(pipelinePath)).toBe(true);
  });

  const content = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf-8') : '';

  it('triggers on PRs to main', () => {
    expect(content).toContain('pr:');
    expect(content).toContain('- main');
  });

  it('does not trigger on push', () => {
    expect(content).toContain('trigger: none');
  });

  it('runs tests with coverage', () => {
    expect(content).toContain('vitest run --coverage');
  });

  it('publishes test results and coverage', () => {
    expect(content).toContain('PublishTestResults@2');
    expect(content).toContain('PublishCodeCoverageResults@2');
  });
});
