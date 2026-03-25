/**
 * Claude Executor — spawns `claude -p` (headless Claude CLI) processes.
 *
 * Simplified standalone version extracted from @claude-flow/cli HeadlessWorkerExecutor.
 * Only keeps what Workflow Studio actually uses: execute(), isAvailable(), cancelAll().
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, relative } from 'path';
import type { ModelType } from './types.js';

export type { ModelType };

// ============================================
// Type Definitions
// ============================================

export type HeadlessWorkerType =
  | 'audit'
  | 'optimize'
  | 'testgaps'
  | 'document'
  | 'ultralearn'
  | 'refactor'
  | 'deepdive'
  | 'predict';

export type SandboxMode = 'strict' | 'permissive' | 'disabled';
export type OutputFormat = 'text' | 'json' | 'markdown';
export type ExecutionMode = 'local' | 'headless';
export type WorkerPriority = 'low' | 'normal' | 'high' | 'critical';

export interface HeadlessOptions {
  promptTemplate: string;
  sandbox: SandboxMode;
  model?: ModelType;
  maxOutputTokens?: number;
  timeoutMs?: number;
  contextPatterns?: string[];
  outputFormat?: OutputFormat;
}

export interface HeadlessExecutorConfig {
  maxConcurrent?: number;
  defaultTimeoutMs?: number;
  maxContextFiles?: number;
  maxCharsPerFile?: number;
  logDir?: string;
  cacheContext?: boolean;
  cacheTtlMs?: number;
}

export interface HeadlessExecutionResult {
  success: boolean;
  output: string;
  parsedOutput?: unknown;
  durationMs: number;
  tokensUsed?: number;
  model: string;
  sandboxMode: SandboxMode;
  workerType: HeadlessWorkerType;
  timestamp: Date;
  error?: string;
  executionId: string;
}

interface PoolEntry {
  process: ChildProcess;
  executionId: string;
  workerType: HeadlessWorkerType;
  startTime: Date;
  timeout: NodeJS.Timeout;
}

interface QueueEntry {
  workerType: HeadlessWorkerType;
  config?: Partial<HeadlessOptions>;
  resolve: (result: HeadlessExecutionResult) => void;
  reject: (error: Error) => void;
  queuedAt: Date;
}

interface CacheEntry {
  content: string;
  timestamp: number;
  patterns: string[];
}

// ============================================
// Worker type (standalone — no import from worker-daemon)
// ============================================

type WorkerType = HeadlessWorkerType | 'map' | 'consolidate' | 'benchmark' | 'preload';

// ============================================
// Constants
// ============================================

const HEADLESS_WORKER_TYPES: HeadlessWorkerType[] = [
  'audit', 'optimize', 'testgaps', 'document', 'ultralearn', 'refactor', 'deepdive', 'predict',
];

const MODEL_IDS: Record<ModelType, string> = {
  sonnet: 'claude-sonnet-4-5-20250929',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

interface HeadlessWorkerConfig {
  type: WorkerType;
  mode: ExecutionMode;
  intervalMs: number;
  priority: WorkerPriority;
  description: string;
  enabled: boolean;
  headless?: HeadlessOptions;
}

const HEADLESS_WORKER_CONFIGS: Record<HeadlessWorkerType, HeadlessWorkerConfig> = {
  audit: {
    type: 'audit', mode: 'headless', intervalMs: 30 * 60 * 1000, priority: 'critical',
    description: 'AI-powered security analysis', enabled: true,
    headless: {
      promptTemplate: `Analyze this codebase for security vulnerabilities:\n- Check for hardcoded secrets\n- Identify SQL injection risks\n- Find XSS vulnerabilities\n- Check for insecure dependencies\n\nProvide a JSON report.`,
      sandbox: 'strict', model: 'haiku', outputFormat: 'json',
      contextPatterns: ['**/*.ts', '**/*.js', '**/.env*', '**/package.json'], timeoutMs: 5 * 60 * 1000,
    },
  },
  optimize: {
    type: 'optimize', mode: 'headless', intervalMs: 60 * 60 * 1000, priority: 'high',
    description: 'AI optimization suggestions', enabled: true,
    headless: {
      promptTemplate: `Analyze this codebase for performance optimizations.`,
      sandbox: 'permissive', model: 'sonnet', outputFormat: 'markdown',
      contextPatterns: ['src/**/*.ts', 'src/**/*.tsx'], timeoutMs: 10 * 60 * 1000,
    },
  },
  testgaps: {
    type: 'testgaps', mode: 'headless', intervalMs: 60 * 60 * 1000, priority: 'normal',
    description: 'AI test gap analysis', enabled: true,
    headless: {
      promptTemplate: `Analyze test coverage and identify gaps.`,
      sandbox: 'permissive', model: 'sonnet', outputFormat: 'markdown',
      contextPatterns: ['src/**/*.ts', 'tests/**/*.ts'], timeoutMs: 10 * 60 * 1000,
    },
  },
  document: {
    type: 'document', mode: 'headless', intervalMs: 120 * 60 * 1000, priority: 'low',
    description: 'AI documentation generation', enabled: false,
    headless: {
      promptTemplate: `Generate documentation for undocumented code.`,
      sandbox: 'permissive', model: 'haiku', outputFormat: 'markdown',
      contextPatterns: ['src/**/*.ts'], timeoutMs: 10 * 60 * 1000,
    },
  },
  ultralearn: {
    type: 'ultralearn', mode: 'headless', intervalMs: 0, priority: 'normal',
    description: 'Deep knowledge acquisition', enabled: false,
    headless: {
      promptTemplate: `Deeply analyze this codebase to learn architectural patterns.`,
      sandbox: 'strict', model: 'opus', outputFormat: 'json',
      contextPatterns: ['**/*.ts', '**/CLAUDE.md', '**/README.md'], timeoutMs: 15 * 60 * 1000,
    },
  },
  refactor: {
    type: 'refactor', mode: 'headless', intervalMs: 0, priority: 'normal',
    description: 'AI refactoring suggestions', enabled: false,
    headless: {
      promptTemplate: `Suggest refactoring opportunities.`,
      sandbox: 'permissive', model: 'sonnet', outputFormat: 'markdown',
      contextPatterns: ['src/**/*.ts'], timeoutMs: 10 * 60 * 1000,
    },
  },
  deepdive: {
    type: 'deepdive', mode: 'headless', intervalMs: 0, priority: 'normal',
    description: 'Deep code analysis', enabled: false,
    headless: {
      promptTemplate: `Perform deep analysis of this codebase.`,
      sandbox: 'strict', model: 'opus', outputFormat: 'markdown',
      contextPatterns: ['src/**/*.ts'], timeoutMs: 15 * 60 * 1000,
    },
  },
  predict: {
    type: 'predict', mode: 'headless', intervalMs: 10 * 60 * 1000, priority: 'low',
    description: 'Predictive preloading', enabled: false,
    headless: {
      promptTemplate: `Based on recent activity, predict what the developer needs.`,
      sandbox: 'strict', model: 'haiku', outputFormat: 'json',
      contextPatterns: ['.workflow-studio/metrics/*.json'], timeoutMs: 2 * 60 * 1000,
    },
  },
};

// ============================================
// HeadlessWorkerExecutor Class
// ============================================

export class HeadlessWorkerExecutor extends EventEmitter {
  private projectRoot: string;
  private config: Required<HeadlessExecutorConfig>;
  private processPool: Map<string, PoolEntry> = new Map();
  private pendingQueue: QueueEntry[] = [];
  private contextCache: Map<string, CacheEntry> = new Map();
  private claudeCodeAvailable: boolean | null = null;
  private claudeCodeVersion: string | null = null;
  private claudeBinaryPath: string | null = null;

  constructor(projectRoot: string, options?: HeadlessExecutorConfig) {
    super();
    this.projectRoot = projectRoot;
    this.config = {
      maxConcurrent: options?.maxConcurrent ?? 2,
      defaultTimeoutMs: options?.defaultTimeoutMs ?? 5 * 60 * 1000,
      maxContextFiles: options?.maxContextFiles ?? 20,
      maxCharsPerFile: options?.maxCharsPerFile ?? 5000,
      logDir: options?.logDir ?? join(projectRoot, '.workflow-studio', 'logs'),
      cacheContext: options?.cacheContext ?? true,
      cacheTtlMs: options?.cacheTtlMs ?? 60000,
    };
    this.ensureLogDir();
  }

  async isAvailable(): Promise<boolean> {
    if (this.claudeCodeAvailable !== null) return this.claudeCodeAvailable;
    const env = this.buildClaudeEnv();
    const candidates = this.getClaudeBinaryCandidates();

    try {
      for (const candidate of candidates) {
        try {
          const output = execSync(`${candidate} --version`, {
            encoding: 'utf-8', stdio: 'pipe', timeout: 5000, windowsHide: true, env,
          });
          this.claudeCodeAvailable = true;
          this.claudeBinaryPath = candidate;
          this.claudeCodeVersion = output.trim();
          this.emit('status', { available: true, version: this.claudeCodeVersion, binaryPath: this.claudeBinaryPath });
          return true;
        } catch { /* try next */ }
      }
      this.claudeCodeAvailable = false;
      this.claudeBinaryPath = null;
      this.emit('status', { available: false, triedPaths: candidates });
      return false;
    } catch {
      this.claudeCodeAvailable = false;
      this.emit('status', { available: false });
      return false;
    }
  }

  async getVersion(): Promise<string | null> {
    await this.isAvailable();
    return this.claudeCodeVersion;
  }

  async execute(
    workerType: HeadlessWorkerType,
    configOverrides?: Partial<HeadlessOptions>
  ): Promise<HeadlessExecutionResult> {
    const baseConfig = HEADLESS_WORKER_CONFIGS[workerType];
    if (!baseConfig) throw new Error(`Unknown headless worker type: ${workerType}`);

    const available = await this.isAvailable();
    if (!available) {
      const result = this.createErrorResult(workerType, 'Claude Code CLI not available. Install with: npm install -g @anthropic-ai/claude-code');
      this.emit('error', result);
      return result;
    }

    if (this.processPool.size >= this.config.maxConcurrent) {
      return new Promise((resolve, reject) => {
        this.pendingQueue.push({ workerType, config: configOverrides, resolve, reject, queuedAt: new Date() });
        this.emit('queued', { workerType, queuePosition: this.pendingQueue.length });
      });
    }

    return this.executeInternal(workerType, configOverrides);
  }

  getActiveCount(): number { return this.processPool.size; }

  cancel(executionId: string): boolean {
    const entry = this.processPool.get(executionId);
    if (!entry) return false;
    clearTimeout(entry.timeout);
    entry.process.kill('SIGTERM');
    this.processPool.delete(executionId);
    this.emit('cancelled', { executionId });
    this.processQueue();
    return true;
  }

  cancelAll(): number {
    let cancelled = 0;
    const entries = Array.from(this.processPool.entries());
    for (const [executionId, entry] of entries) {
      clearTimeout(entry.timeout);
      entry.process.kill('SIGTERM');
      this.emit('cancelled', { executionId });
      cancelled++;
    }
    this.processPool.clear();
    for (const entry of this.pendingQueue) {
      entry.reject(new Error('Executor cancelled all executions'));
    }
    this.pendingQueue = [];
    this.emit('allCancelled', { count: cancelled });
    return cancelled;
  }

  clearContextCache(): void {
    this.contextCache.clear();
    this.emit('cacheClear', {});
  }

  getConfig(workerType: HeadlessWorkerType): HeadlessWorkerConfig | undefined {
    return HEADLESS_WORKER_CONFIGS[workerType];
  }

  getHeadlessWorkerTypes(): HeadlessWorkerType[] { return [...HEADLESS_WORKER_TYPES]; }

  // ============================================
  // Private Methods
  // ============================================

  private ensureLogDir(): void {
    try {
      if (!existsSync(this.config.logDir)) mkdirSync(this.config.logDir, { recursive: true });
    } catch (error) {
      this.emit('warning', { message: 'Failed to create log directory', error });
    }
  }

  private async executeInternal(
    workerType: HeadlessWorkerType,
    configOverrides?: Partial<HeadlessOptions>
  ): Promise<HeadlessExecutionResult> {
    const baseConfig = HEADLESS_WORKER_CONFIGS[workerType];
    const headless = { ...baseConfig.headless!, ...configOverrides };
    const startTime = Date.now();
    const executionId = `${workerType}_${startTime}_${Math.random().toString(36).slice(2, 8)}`;
    this.emit('start', { executionId, workerType, config: headless });

    try {
      const context = await this.buildContext(headless.contextPatterns || []);
      const fullPrompt = this.buildPrompt(headless.promptTemplate, context);
      this.logExecution(executionId, 'prompt', fullPrompt);

      const result = await this.executeClaudeCode(fullPrompt, {
        sandbox: headless.sandbox,
        model: headless.model || 'sonnet',
        timeoutMs: headless.timeoutMs || this.config.defaultTimeoutMs,
        executionId, workerType,
      });

      let parsedOutput: unknown;
      if (headless.outputFormat === 'json' && result.output) parsedOutput = this.parseJsonOutput(result.output);
      else if (headless.outputFormat === 'markdown' && result.output) parsedOutput = this.parseMarkdownOutput(result.output);

      const executionResult: HeadlessExecutionResult = {
        success: result.success, output: result.output, parsedOutput,
        durationMs: Date.now() - startTime, tokensUsed: result.tokensUsed,
        model: headless.model || 'sonnet', sandboxMode: headless.sandbox,
        workerType, timestamp: new Date(), executionId, error: result.error,
      };
      this.logExecution(executionId, 'result', JSON.stringify(executionResult, null, 2));
      this.emit('complete', executionResult);
      return executionResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const executionResult = this.createErrorResult(workerType, errorMessage);
      executionResult.executionId = executionId;
      executionResult.durationMs = Date.now() - startTime;
      this.logExecution(executionId, 'error', errorMessage);
      this.emit('error', executionResult);
      return executionResult;
    } finally {
      this.processQueue();
    }
  }

  private processQueue(): void {
    while (this.pendingQueue.length > 0 && this.processPool.size < this.config.maxConcurrent) {
      const next = this.pendingQueue.shift();
      if (!next) break;
      this.executeInternal(next.workerType, next.config).then(next.resolve).catch(next.reject);
    }
  }

  private async buildContext(patterns: string[]): Promise<string> {
    if (patterns.length === 0) return '';
    const cacheKey = patterns.sort().join('|');
    if (this.config.cacheContext) {
      const cached = this.contextCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.config.cacheTtlMs) return cached.content;
    }

    const files: string[] = [];
    for (const pattern of patterns) files.push(...this.simpleGlob(pattern));
    const uniqueFiles = Array.from(new Set(files)).slice(0, this.config.maxContextFiles);

    const contextParts: string[] = [];
    for (const file of uniqueFiles) {
      try {
        const fullPath = join(this.projectRoot, file);
        if (!existsSync(fullPath)) continue;
        const content = readFileSync(fullPath, 'utf-8');
        const truncated = content.slice(0, this.config.maxCharsPerFile);
        const wasTruncated = content.length > this.config.maxCharsPerFile;
        contextParts.push(`--- ${file}${wasTruncated ? ' (truncated)' : ''} ---\n${truncated}`);
      } catch { /* skip */ }
    }
    const contextContent = contextParts.join('\n\n');
    if (this.config.cacheContext) {
      this.contextCache.set(cacheKey, { content: contextContent, timestamp: Date.now(), patterns });
    }
    return contextContent;
  }

  private simpleGlob(pattern: string): string[] {
    const results: string[] = [];
    if (!pattern.includes('*')) {
      if (existsSync(join(this.projectRoot, pattern))) results.push(pattern);
      return results;
    }
    const parts = pattern.split('/');
    const scanDir = (dir: string, remainingParts: string[]): void => {
      if (remainingParts.length === 0 || results.length >= 100) return;
      try {
        const fullDir = join(this.projectRoot, dir);
        if (!existsSync(fullDir)) return;
        const entries = readdirSync(fullDir, { withFileTypes: true });
        const currentPart = remainingParts[0];
        const isLastPart = remainingParts.length === 1;
        for (const entry of entries) {
          if (['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache'].includes(entry.name)) continue;
          const entryPath = dir ? `${dir}/${entry.name}` : entry.name;
          if (currentPart === '**') {
            if (entry.isDirectory()) { scanDir(entryPath, remainingParts); scanDir(entryPath, remainingParts.slice(1)); }
            else if (entry.isFile() && remainingParts.length > 1 && this.matchesPattern(entry.name, remainingParts[1])) results.push(entryPath);
          } else if (this.matchesPattern(entry.name, currentPart)) {
            if (isLastPart && entry.isFile()) results.push(entryPath);
            else if (!isLastPart && entry.isDirectory()) scanDir(entryPath, remainingParts.slice(1));
          }
        }
      } catch { /* skip */ }
    };
    scanDir('', parts);
    return results;
  }

  private matchesPattern(name: string, pattern: string): boolean {
    if (pattern === '*' || pattern === '**') return true;
    if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1));
    if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
    if (pattern.startsWith('*')) return name.endsWith(pattern.slice(1));
    return name === pattern;
  }

  private buildPrompt(template: string, context: string): string {
    if (!context) return `${template}\n\n## Instructions\n\nIMPORTANT: All relevant code and context has been provided above in the prompt. Do NOT look at or reference the local filesystem or working directory — it is unrelated to the task. Work ONLY with the content provided above.\n\nProvide your response following the format specified in the task.`;
    return `${template}\n\n## Codebase Context\n\n${context}\n\n## Instructions\n\nAnalyze the above codebase context and provide your response following the format specified in the task.`;
  }

  private executeClaudeCode(
    prompt: string,
    options: { sandbox: SandboxMode; model: ModelType; timeoutMs: number; executionId: string; workerType: HeadlessWorkerType }
  ): Promise<{ success: boolean; output: string; tokensUsed?: number; error?: string }> {
    return new Promise((resolve) => {
      const env: Record<string, string> = {
        ...this.buildClaudeEnv(),
        CLAUDE_CODE_HEADLESS: 'true',
        CLAUDE_CODE_SANDBOX_MODE: options.sandbox,
      };

      const claudeBinary = this.claudeBinaryPath || 'claude';
      const child = spawn(claudeBinary, ['-p', '--model', options.model], {
        cwd: this.projectRoot, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      // Pass prompt via stdin to avoid E2BIG when the prompt exceeds OS arg limits
      child.stdin?.write(prompt);
      child.stdin?.end();

      let forceKillHandle: ReturnType<typeof setTimeout> | undefined;
      let watchdogHandle: ReturnType<typeof setTimeout> | undefined;

      const timeoutHandle = setTimeout(() => {
        if (this.processPool.has(options.executionId)) {
          child.kill('SIGTERM');
          forceKillHandle = setTimeout(() => { if (!child.killed) child.kill('SIGKILL'); }, 5000);
          forceKillHandle.unref?.();
        }
      }, options.timeoutMs);
      timeoutHandle.unref?.();

      this.processPool.set(options.executionId, {
        process: child, executionId: options.executionId,
        workerType: options.workerType, startTime: new Date(), timeout: timeoutHandle,
      });

      let stdout = '';
      let stderr = '';
      let resolved = false;

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (forceKillHandle) clearTimeout(forceKillHandle);
        if (watchdogHandle) clearTimeout(watchdogHandle);
        this.processPool.delete(options.executionId);
      };

      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        this.emit('output', { executionId: options.executionId, type: 'stdout', data: chunk });
      });
      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        this.emit('output', { executionId: options.executionId, type: 'stderr', data: chunk });
      });

      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        const closedBySignal = code === null && signal;
        const fallbackError = closedBySignal ? `Process terminated by signal ${signal}` : `Process exited with code ${code}`;
        resolve({
          success: code === 0,
          output: stdout || stderr,
          error: code !== 0 ? (stderr || stdout || fallbackError) : undefined,
        });
      });

      child.on('error', (error: Error) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({ success: false, output: '', error: error.message });
      });

      watchdogHandle = setTimeout(() => {
        if (resolved || !this.processPool.has(options.executionId)) return;
        resolved = true;
        child.kill('SIGTERM');
        cleanup();
        resolve({ success: false, output: stdout || stderr, error: `Execution timed out after ${options.timeoutMs}ms` });
      }, options.timeoutMs + 100);
      watchdogHandle.unref?.();
    });
  }

  private buildClaudeEnv(): Record<string, string> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
    const currentPath = env[pathKey] || env.PATH || '';
    const extraPaths = process.platform === 'win32' ? [] : [
      join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
    ];
    const merged = [...currentPath.split(':'), ...extraPaths].map(s => s.trim()).filter(Boolean);
    env[pathKey] = Array.from(new Set(merged)).join(':');
    env.PATH = env[pathKey];
    return env;
  }

  private getClaudeBinaryCandidates(): string[] {
    if (process.platform === 'win32') return ['claude'];
    return ['claude', join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  }

  private parseJsonOutput(output: string): unknown {
    try {
      const codeBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) return JSON.parse(codeBlockMatch[1].trim());
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
      return JSON.parse(output.trim());
    } catch {
      return { parseError: true, rawOutput: output };
    }
  }

  private parseMarkdownOutput(output: string): { sections: Array<{ title: string; content: string; level: number }>; codeBlocks: Array<{ language: string; code: string }> } {
    const sections: Array<{ title: string; content: string; level: number }> = [];
    const codeBlocks: Array<{ language: string; code: string }> = [];
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    let codeMatch;
    while ((codeMatch = codeBlockRegex.exec(output)) !== null) {
      codeBlocks.push({ language: codeMatch[1] || 'text', code: codeMatch[2].trim() });
    }
    const lines = output.split('\n');
    let currentSection: { title: string; content: string; level: number } | null = null;
    for (const line of lines) {
      const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headerMatch) {
        if (currentSection) sections.push(currentSection);
        currentSection = { title: headerMatch[2].trim(), content: '', level: headerMatch[1].length };
      } else if (currentSection) {
        currentSection.content += line + '\n';
      }
    }
    if (currentSection) { currentSection.content = currentSection.content.trim(); sections.push(currentSection); }
    return { sections, codeBlocks };
  }

  private createErrorResult(workerType: HeadlessWorkerType, error: string): HeadlessExecutionResult {
    return {
      success: false, output: '', durationMs: 0, model: 'unknown', sandboxMode: 'strict',
      workerType, timestamp: new Date(), executionId: `error_${Date.now()}`, error,
    };
  }

  private logExecution(executionId: string, type: 'prompt' | 'result' | 'error', content: string): void {
    try {
      const timestamp = new Date().toISOString();
      const logFile = join(this.config.logDir, `${executionId}_${type}.log`);
      writeFileSync(logFile, `[${timestamp}] ${type.toUpperCase()}\n${'='.repeat(60)}\n${content}\n`);
    } catch { /* ignore */ }
  }
}

export default HeadlessWorkerExecutor;
