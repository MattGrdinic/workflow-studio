import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname as pathDirname, join, resolve } from 'path';
import { execSync } from 'child_process';
import { createDecipheriv } from 'crypto';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { HeadlessWorkerExecutor, type ModelType } from './claude-executor.js';
import type {
  ChatMessage,
  ChatResolution,
  ChatSessionState,
  NodeExecutionContext,
  NodeExecutionResult,
  NodeExecutor,
  NodeValue,
  WorkflowExecutionContext,
  WorkflowExecutionResult,
  WorkflowGraph,
  WorkflowNode,
  WorkflowProgressCallback,
  WorkflowRunOptions,
} from './types.js';

let activeExecutor: HeadlessWorkerExecutor | null = null;
const activeChatSessions = new Map<string, ChatSessionState>();

// --- Debug logging ---
// Toggle via: WORKFLOW_DEBUG=1 environment variable, or set debugEnabled = true below.
let debugEnabled = process.env.WORKFLOW_DEBUG === '1' || process.env.WORKFLOW_DEBUG === 'true';
export function setWorkflowDebug(enabled: boolean): void { debugEnabled = enabled; }
function dbg(tag: string, ...args: unknown[]): void {
  if (!debugEnabled) return;
  console.log(`[WF:${tag}]`, ...args);
}
function truncate(s: string, max = 300): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `... (${s.length} chars total)`;
}
function summarizeOutput(output: unknown): string {
  if (output == null) return '(null)';
  if (typeof output === 'string') return truncate(output);
  if (typeof output !== 'object') return String(output);
  const obj = output as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => k !== '_resolvedConfig' && k !== 'raw');
  const parts: string[] = [];
  for (const k of keys.slice(0, 8)) {
    const v = obj[k];
    if (typeof v === 'string') parts.push(`${k}: ${truncate(v, 120)}`);
    else if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}: ${v}`);
    else if (Array.isArray(v)) parts.push(`${k}: Array(${v.length})`);
    else if (v && typeof v === 'object') parts.push(`${k}: {${Object.keys(v as object).slice(0, 4).join(',')}...}`);
    else parts.push(`${k}: ${String(v)}`);
  }
  if (keys.length > 8) parts.push(`...+${keys.length - 8} more keys`);
  return parts.join(' | ');
}

export function getActiveChatSession(sessionId: string): ChatSessionState | undefined {
  return activeChatSessions.get(sessionId);
}

export function forceStopActiveExecutor(): boolean {
  if (activeExecutor) {
    activeExecutor.cancelAll();
    activeExecutor = null;
    return true;
  }
  return false;
}

/** Node types that use HeadlessWorkerExecutor (claude -p) and need auth preflight. */
const CLAUDE_CLI_NODE_TYPES = new Set(['ai.runPrompt', 'ai.interactiveChat']);

/**
 * Fast preflight check: verifies that the Claude CLI can reach the model backend.
 * Sends a tiny probe prompt with a short timeout so we fail in ~20s instead of 4min
 * when Bedrock auth (aws sso login) or API key is missing.
 */
async function preflightAiCheck(cwd: string): Promise<void> {
  const executor = new HeadlessWorkerExecutor(cwd, {
    maxConcurrent: 1,
    defaultTimeoutMs: 20_000,
  });

  const available = await executor.isAvailable();
  if (!available) {
    throw new Error(
      'Claude CLI is not installed or not on PATH. AI prompt nodes require the `claude` binary.\n' +
      'Install it or add it to PATH (e.g. export PATH="$HOME/.local/bin:$PATH").'
    );
  }

  const probe = await executor.execute('document', {
    promptTemplate: 'Reply with exactly: OK',
    model: 'sonnet' as ModelType,
    sandbox: 'permissive',
    outputFormat: 'text',
    contextPatterns: [],
    timeoutMs: 20_000,
  });

  if (!probe.success || !probe.output?.trim()) {
    const hint = (probe.error || '').toString();
    const isTimeout = hint.includes('timeout') || hint.includes('SIGTERM') || hint.includes('code 143') || !hint;
    const isNotLoggedIn = hint.toLowerCase().includes('not logged in') || hint.includes('/login');
    throw new Error(
      'AI model preflight check failed — the Claude CLI did not respond in time.\n' +
      (isNotLoggedIn
        ? 'Claude CLI reports not logged in. Run `claude auth login` on the host and mount ~/.claude + ~/.claude.json into the container.'
        : isTimeout
          ? 'The probe timed out (20s). This can happen on first run or if Bedrock SSO has expired.\n' +
            'Try running the workflow again — the CLI may just need a cold-start.\n' +
            'If it persists, run `aws sso login` to refresh credentials.'
          : `Error detail: ${hint}`) +
      '\nIf you use an Anthropic API key instead of Bedrock, ensure ANTHROPIC_API_KEY is set.'
    );
  }
}

/** Node types that require an Azure DevOps PAT. */
const ADO_PAT_NODE_TYPES = new Set(['azuredevops.readRepoContext', 'azuredevops.createPullRequest', 'ado.codeSearch', 'ado.deepCodeSearch']);
/** Node types that require a Jira/Atlassian config. */
const JIRA_CONFIG_NODE_TYPES = new Set([
  'jira.fetchIssue', 'jira.searchJql', 'jira.collectImageRefs', 'jira.createIssues',
  'jira.addComment', 'jira.updateIssue', 'confluence.search',
]);

/**
 * Pre-execution credential check.
 * Scans the graph for nodes that need ADO PAT or Jira config and validates
 * that the credentials are available *before* any node runs.
 * Returns an array of human-readable issue strings (empty = all good).
 */
function preflightCredentialCheck(
  graph: WorkflowGraph,
  context: WorkflowExecutionContext,
): string[] {
  const issues: string[] = [];
  const vars = context.variables || {};

  const needsAdoPat = graph.nodes.some((n) => ADO_PAT_NODE_TYPES.has(n.type));
  const needsJiraConfig = graph.nodes.some((n) => JIRA_CONFIG_NODE_TYPES.has(n.type));

  if (needsAdoPat) {
    // Try ADO config file first (like Jira configPath pattern)
    const adoNode = graph.nodes.find((n) => ADO_PAT_NODE_TYPES.has(n.type));
    let adoConfigPath = '';
    const rawCfgPath = adoNode?.config?.adoConfigPath;
    if (typeof rawCfgPath === 'string' && rawCfgPath.startsWith('{{vars.')) {
      const varKey = rawCfgPath.slice(7, -2);
      adoConfigPath = String(vars[varKey] || '').trim();
    } else if (typeof rawCfgPath === 'string') {
      adoConfigPath = rawCfgPath.trim();
    }
    const adoCfg = loadAdoConfig(context.cwd, adoConfigPath);

    // Fall back to patEnvVar resolution
    const rawPatVar = adoNode?.config?.patEnvVar;
    let patEnvVar = 'AZURE_DEVOPS_PAT';
    if (typeof rawPatVar === 'string' && rawPatVar.startsWith('{{vars.')) {
      const varKey = rawPatVar.slice(7, -2);
      const resolved = vars[varKey];
      if (typeof resolved === 'string' && resolved.trim()) patEnvVar = resolved.trim();
    } else if (typeof rawPatVar === 'string' && rawPatVar.trim()) {
      patEnvVar = rawPatVar.trim();
    }

    const pat = adoCfg.pat || process.env[patEnvVar] || loadEnvValue(context.cwd, patEnvVar) || loadAdoConfigValue(context.cwd, patEnvVar);
    if (!pat) {
      const adoNodeNames = graph.nodes.filter((n) => ADO_PAT_NODE_TYPES.has(n.type)).map((n) => n.id);
      issues.push(
        `Azure DevOps PAT not found — nodes [${adoNodeNames.join(', ')}] require it.\n` +
        `Checked: ADO config file (data/ADO/config/ado.env), process.env.${patEnvVar}, .env file.\n\n` +
        'To fix:\n' +
        `  1. Click the "ADO Config" button in the Variables pane to set your credentials\n` +
        `  2. Or run: node dist/cli.js --setup\n` +
        `  3. Or set it in your shell: export ${patEnvVar}=your-token-here`,
      );
    }
  }

  if (needsJiraConfig) {
    // Resolve the configPath from the first Jira node
    const jiraNode = graph.nodes.find((n) => JIRA_CONFIG_NODE_TYPES.has(n.type));
    const rawConfigPath = jiraNode?.config?.configPath;
    let configPath = '';
    if (typeof rawConfigPath === 'string' && rawConfigPath.startsWith('{{vars.')) {
      const varKey = rawConfigPath.slice(7, -2);
      const resolved = vars[varKey];
      if (typeof resolved === 'string') configPath = resolved.trim();
    } else if (typeof rawConfigPath === 'string') {
      configPath = rawConfigPath.trim();
    }

    if (configPath) {
      try {
        loadJiraConfig(resolveConfigPath(context.cwd, configPath));
      } catch {
        const jiraNodeNames = graph.nodes.filter((n) => JIRA_CONFIG_NODE_TYPES.has(n.type)).map((n) => n.id);
        issues.push(
          `Jira/Atlassian config not found or incomplete — nodes [${jiraNodeNames.join(', ')}] require it.\n` +
          `Checked path: ${configPath}\n\n` +
          'To fix:\n' +
          `  1. Create the config file at: ${configPath}\n` +
          '  2. Add these required values:\n' +
          '       JIRA_BASE_URL=https://yourcompany.atlassian.net\n' +
          '       JIRA_EMAIL=your-email@company.com\n' +
          '       JIRA_API_TOKEN=your-api-token\n' +
          '  3. Generate an API token at:\n' +
          '       https://id.atlassian.com/manage-profile/security/api-tokens',
        );
      }
    }
  }

  return issues;
}

/**
 * Resolve a relative config path by trying multiple base directories:
 * 1. The provided cwd (project root)
 * 2. Walk up parent directories from cwd looking for the file
 */
function resolveConfigPath(cwd: string, relativePath: string): string {
  if (!relativePath) return relativePath;

  // Already absolute — use as-is
  const fromCwd = resolve(cwd, relativePath);
  if (existsSync(fromCwd)) return fromCwd;

  // Legacy paths like "ProjectName/Jira/config/jira.env" → try under data/Jira/config/jira.env
  const jiraEnvMatch = relativePath.match(/Jira\/config\/jira\.env$/);
  if (jiraEnvMatch) {
    const dataPath = resolve(cwd, 'data/Jira/config/jira.env');
    if (existsSync(dataPath)) return dataPath;
  }

  // Walk up parent directories from cwd
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    const parent = pathDirname(dir);
    if (parent === dir) break; // reached filesystem root
    const candidate = resolve(parent, relativePath);
    if (existsSync(candidate)) return candidate;
    dir = parent;
  }

  // Fall back to the cwd-based path (will fail with a clear error message)
  return fromCwd;
}

interface JiraConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  caCertPem?: string;
  aiModel: string;
}

/**
 * Build the `_upstream` text block from all upstream node results.
 * Sections are labeled REQUIREMENTS / CODEBASE CONTEXT / PRIOR AI OUTPUT
 * so downstream AI prompts know which content defines "what to do" vs "code for context."
 * Used by both `transform.template` and `ai.runPrompt`.
 */
function buildUpstreamText(previousResults: Record<string, NodeExecutionResult>): string {
  const requirementTypes = new Set(['jira.fetchIssue', 'spec.input', 'jira.searchJql']);
  const contextTypes = new Set(['azuredevops.readRepoContext', 'io.readFile', 'image.visionExtract', 'web.fetchUrl', 'ado.codeSearch', 'ado.deepCodeSearch', 'confluence.search', 'github.codeSearch']);
  const generatedTypes = new Set(['ai.runPrompt', 'ai.structured', 'ai.interactiveChat', 'transform.template']);

  const primaryFields: Record<string, string> = {
    'ai.runPrompt': 'text', 'ai.structured': 'text', 'ai.interactiveChat': 'text',
    'transform.template': 'content', 'io.readFile': 'content', 'spec.input': 'specText',
    'ado.deepCodeSearch': 'summary',
    'image.visionExtract': 'analysis', 'azuredevops.readRepoContext': 'summary',
    'jira.fetchIssue': 'description', 'jira.searchJql': 'issues',
    'jira.createIssues': 'created',
    'web.fetchUrl': 'content', 'ado.codeSearch': 'summary', 'confluence.search': 'summary',
    'slack.sendMessage': 'sent', 'slack.readChannel': 'content',
    'github.codeSearch': 'summary', 'conditional.gate': 'text',
    'transform.jsonExtract': 'text', 'notification.email': 'sent',
  };

  const requirementParts: string[] = [];
  const contextParts: string[] = [];
  const generatedParts: string[] = [];

  dbg('template', 'Building _upstream from:', Object.keys(previousResults).join(', '));
  for (const [nodeId, result] of Object.entries(previousResults)) {
    dbg('template', `  ${nodeId}: type=${result.nodeType} success=${result.success} output=${typeof result.output}`);
    if (!result.success || !result.output || typeof result.output !== 'object') continue;
    const out = result.output as Record<string, unknown>;
    const nType = result.nodeType;
    const pf = primaryFields[nType];

    if (nType === 'jira.fetchIssue') {
      dbg('template', `  -> jira.fetchIssue keys: ${Object.keys(out).filter(k => k !== 'raw' && k !== '_resolvedConfig').join(', ')}`);
      const key = typeof out.key === 'string' ? out.key : nodeId;
      const summary = typeof out.summary === 'string' ? out.summary : '';
      const desc = typeof out.description === 'string' ? out.description : '';
      if (summary || desc) {
        requirementParts.push(
          '### Jira Ticket: ' + key + '\n'
          + (summary ? 'Summary: ' + summary + '\n' : '')
          + (desc ? 'Description:\n' + desc : ''),
        );
      }
      continue;
    }

    if (nType === 'spec.input') {
      const specText = typeof out.specText === 'string' ? out.specText : '';
      if (specText.trim()) {
        requirementParts.push('### Specification\n' + specText);
      }
      continue;
    }

    if (nType === 'azuredevops.readRepoContext') {
      dbg('template', `  -> readRepoContext keys: ${Object.keys(out).filter(k => k !== '_resolvedConfig').join(', ')}`);
      const files = out.files as Array<{ path?: string; content?: string }> | undefined;
      const summary = typeof out.summary === 'string' ? out.summary : '';
      const repo = typeof out.repository === 'string' ? out.repository : '';
      const proj = typeof out.project === 'string' ? out.project : '';
      const filePaths = files?.map((f) => f.path).filter(Boolean) || [];
      const parts: string[] = [];
      const repoLabel = [proj, repo].filter(Boolean).join('/');
      parts.push('### Repository Context' + (repoLabel ? ' (' + repoLabel + ')' : ''));
      parts.push('**This code comes from the Azure DevOps repository' + (repoLabel ? ' "' + repoLabel + '"' : '') + ', NOT from the local filesystem. Work only with this code.**');
      if (filePaths.length) {
        parts.push('**Files found in repository (ONLY these files exist — do NOT invent other file paths):**');
        for (const fp of filePaths) parts.push('- ' + fp);
      }
      if (summary.trim()) parts.push('\n' + summary);
      contextParts.push(parts.join('\n'));
      continue;
    }

    const candidates = pf ? [pf, 'text', 'content', 'summary', 'specText'] : ['text', 'content', 'summary', 'specText', 'description'];
    for (const field of candidates) {
      const val = out[field];
      if (val == null) continue;
      const asStr = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
      if (asStr.trim()) {
        const label = typeof out.key === 'string' ? nodeId + ' [' + out.key + ']' : nodeId;
        const part = '### ' + label + ' (' + nType + ')\n' + asStr;
        if (requirementTypes.has(nType)) requirementParts.push(part);
        else if (contextTypes.has(nType)) contextParts.push(part);
        else if (generatedTypes.has(nType)) generatedParts.push(part);
        else contextParts.push(part);
        break;
      }
    }
  }

  dbg('template', `_upstream parts: req=${requirementParts.length} ctx=${contextParts.length} gen=${generatedParts.length}`);
  const sections: string[] = [];
  if (requirementParts.length) {
    sections.push('## REQUIREMENTS (implement exactly what is described here)\n\n' + requirementParts.join('\n\n'));
  }
  if (contextParts.length) {
    sections.push('## CODEBASE CONTEXT (reference only — do NOT fix or refactor unrelated code)\nIMPORTANT: Only reference files that are explicitly listed below. NEVER invent, guess, or assume file paths that are not shown here.\n\n' + contextParts.join('\n\n'));
  }
  if (generatedParts.length) {
    sections.push('## PRIOR AI OUTPUT\n\n' + generatedParts.join('\n\n'));
  }
  if (sections.length === 0) {
    dbg('template', '_upstream empty — building fallback');
    const fallbackParts: string[] = [];
    for (const [nodeId, result] of Object.entries(previousResults)) {
      if (!result.success || !result.output) continue;
      const out = result.output;
      if (typeof out === 'object' && out !== null) {
        const obj = out as Record<string, unknown>;
        const displayFields: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k === '_resolvedConfig' || k === 'raw') continue;
          displayFields[k] = v;
        }
        fallbackParts.push('### ' + nodeId + ' (' + result.nodeType + ')\n' + JSON.stringify(displayFields, null, 2));
      } else if (typeof out === 'string' && out.trim()) {
        fallbackParts.push('### ' + nodeId + ' (' + result.nodeType + ')\n' + out);
      }
    }
    if (fallbackParts.length) {
      sections.push('## ALL UPSTREAM DATA\n\n' + fallbackParts.join('\n\n'));
    }
  }
  const upstreamValue = sections.join('\n\n');
  dbg('template', `_upstream: ${sections.length} sections, ${upstreamValue.length} chars`);
  return upstreamValue;
}

const executorRegistry: Record<string, NodeExecutor> = {
  'jira.extractTicketKey': async (ctx) => {
    const ticket = String(ctx.resolvedConfig.ticket || '').trim();
    const key = extractTicketKey(ticket);
    return { key, ticketInput: ticket };
  },

  'jira.fetchIssue': async (ctx) => {
    const configPath = resolveConfigPath(ctx.runContext.cwd, String(ctx.resolvedConfig.configPath || ''));
    const rawInput = String(ctx.resolvedConfig.issueKey || '').trim();
    // Auto-extract key from URL or raw key input (absorbs extractTicketKey logic)
    const issueKey = extractTicketKey(rawInput);
    const fields = String(
      ctx.resolvedConfig.fields || 'summary,description,status,priority,issuetype,project,comment,attachment'
    );

    const jiraConfig = loadJiraConfig(configPath);
    const raw = await jiraApiRequest<Record<string, unknown>>(jiraConfig, `issue/${encodeURIComponent(issueKey)}`, {
      fields,
    });

    const descriptionAdf = (raw.fields as Record<string, unknown> | undefined)?.description;
    const extractedUrls = adfExtractUrls(descriptionAdf)
      .filter(u => /^https?:\/\//.test(u));
    // Deduplicate while preserving order
    const uniqueUrls = [...new Set(extractedUrls)];

    return {
      key: issueKey,
      raw,
      summary: String(((raw.fields as Record<string, unknown> | undefined)?.summary) || ''),
      description: adfToText(descriptionAdf),
      urls: uniqueUrls.join('\n'),
      urlCount: uniqueUrls.length,
    };
  },

  'jira.searchJql': async (ctx) => {
    const configPath = resolveConfigPath(ctx.runContext.cwd, String(ctx.resolvedConfig.configPath || ''));
    const jiraConfig = loadJiraConfig(configPath);
    let jql = String(ctx.resolvedConfig.jql || '').trim();
    const fields = String(ctx.resolvedConfig.fields || 'summary,description,status,priority,issuetype,project');
    const maxResults = Number(ctx.resolvedConfig.maxResults || 10);
    const searchContext = String(ctx.resolvedConfig.searchContext || '').trim();
    const retryModel = normalizeModel(ctx.resolvedConfig.model || 'haiku');

    console.error(`[jira.searchJql] jql="${jql.slice(0, 150)}" fields="${fields}" maxResults=${maxResults} searchContext=${searchContext.length} chars`);

    if (!jql && searchContext) {
      console.error('[jira.searchJql] JQL is empty but searchContext available — generating initial JQL via AI');
      const generated = await aiGenerateInitialQuery(ctx.runContext.cwd, searchContext, 'jira', retryModel);
      if (generated) {
        jql = generated;
        console.error(`[jira.searchJql] AI generated initial JQL: "${jql.slice(0, 150)}"`);
      }
    }
    if (!jql) {
      console.error('[jira.searchJql] SKIP — JQL is empty and no searchContext to generate from');
      return { jql: '', count: 0, issues: [], warning: 'No JQL query provided and no research context to generate one.' };
    }

    const result = await jiraApiRequest<{ issues?: Array<Record<string, unknown>> }>(jiraConfig, 'search/jql', {
      jql,
      maxResults,
      fields,
    });

    const issueCount = Array.isArray(result.issues) ? result.issues.length : 0;
    console.error(`[jira.searchJql] returned ${issueCount} issue(s)`);

    return {
      jql,
      count: issueCount,
      issues: result.issues || [],
    };
  },

  'jira.collectImageRefs': async (ctx) => {
    const raw = (ctx.resolvedConfig.issueRaw || {}) as { fields?: Record<string, unknown> };
    const refs = collectIssueImageRefs(raw);
    const attachments = collectImageAttachmentMeta(raw);
    return { count: refs.length, refs, attachments };
  },

  'spec.input': async (ctx) => {
    const title = String(ctx.resolvedConfig.title || '').trim();
    const objective = String(ctx.resolvedConfig.objective || '').trim();
    const scope = String(ctx.resolvedConfig.scope || '').trim();
    const constraints = String(ctx.resolvedConfig.constraints || '').trim();
    const acceptanceCriteria = String(ctx.resolvedConfig.acceptanceCriteria || '').trim();
    const deliverables = String(ctx.resolvedConfig.deliverables || '').trim();
    const notes = String(ctx.resolvedConfig.notes || '').trim();

    const specText = [
      title ? `Title: ${title}` : '',
      objective ? `Objective: ${objective}` : '',
      scope ? `Scope: ${scope}` : '',
      constraints ? `Constraints: ${constraints}` : '',
      acceptanceCriteria ? `Acceptance Criteria: ${acceptanceCriteria}` : '',
      deliverables ? `Deliverables: ${deliverables}` : '',
      notes ? `Notes: ${notes}` : '',
    ].filter(Boolean).join('\n');

    return {
      title,
      objective,
      scope,
      constraints,
      acceptanceCriteria,
      deliverables,
      notes,
      specText,
      empty: specText.length === 0,
    };
  },

  'azuredevops.readRepoContext': async (ctx) => {
    const adoConfigPath = String(ctx.resolvedConfig.adoConfigPath || '').trim();
    const adoCfg = loadAdoConfig(ctx.runContext.cwd, adoConfigPath);
    const organizationUrl = String(ctx.resolvedConfig.organizationUrl || adoCfg.orgUrl || '').trim();
    const scope = parseAdoScope(String(ctx.resolvedConfig.repoUrl || ''));
    const project = scope.project || String(ctx.resolvedConfig.project || '').trim();
    const repository = scope.repository || String(ctx.resolvedConfig.repository || '').trim();
    const branch = String(ctx.resolvedConfig.branch || 'main').trim() || 'main';
    const scopePath = String(ctx.resolvedConfig.path || '/').trim() || '/';
    const fileNameFilter = String(ctx.resolvedConfig.fileNameFilter || ctx.resolvedConfig.searchFilter || '').trim();
    const contentFilter = String(ctx.resolvedConfig.contentFilter || '').trim();
    const maxFiles = Math.max(1, Math.min(50, Number(ctx.resolvedConfig.maxFiles || 6)));
    const maxCharsPerFile = Math.max(200, Math.min(12000, Number(ctx.resolvedConfig.maxCharsPerFile || 2500)));
    const patEnvVar = String(ctx.resolvedConfig.patEnvVar || 'AZURE_DEVOPS_PAT').trim() || 'AZURE_DEVOPS_PAT';
    const patInline = String(ctx.resolvedConfig.pat || '').trim();

    // Try: config file → inline pat → process.env → .env file → encrypted ADO config
    let pat = adoCfg.pat || patInline || process.env[patEnvVar] || '';
    if (!pat) {
      pat = loadEnvValue(ctx.runContext.cwd, patEnvVar);
    }
    if (!pat) {
      pat = loadAdoConfigValue(ctx.runContext.cwd, patEnvVar);
    }

    if (!organizationUrl || !project || !repository) {
      return {
        connected: false,
        skipped: true,
        reason: 'organizationUrl, project, or repository not provided; continuing without repo context.',
        summary: 'No Azure DevOps repository context was provided.',
      };
    }

    if (!pat) {
      return {
        connected: false,
        skipped: true,
        reason: `PAT not provided. Checked: (1) inline "pat" config, (2) process.env.${patEnvVar}, (3) .env file in working directory. Set ${patEnvVar} in your shell environment or add it to a .env file in the project root.`,
        summary: 'Azure DevOps repository context unavailable (missing PAT).',
      };
    }

    const context = await fetchAzureDevOpsRepoContext({
      organizationUrl,
      project,
      repository,
      branch,
      path: scopePath,
      pat,
      maxFiles,
      maxCharsPerFile,
      fileNameFilter,
      contentFilter,
    });

    return {
      connected: true,
      skipped: false,
      ...context,
    };
  },

  'ai.runPrompt': async (ctx) => {
    const model = normalizeModel(ctx.resolvedConfig.model);
    let prompt = String(ctx.resolvedConfig.prompt || '');
    const timeoutMs = Number(ctx.resolvedConfig.timeoutMs || 240000);

    // Resolve {{_upstream}} if present — builds the same structured upstream text
    // that transform.template provides, so AI prompts can use it directly.
    if (prompt.includes('{{_upstream}}')) {
      const upstreamText = buildUpstreamText(ctx.previousResults);
      prompt = prompt.replace(/\{\{\s*_upstream\s*\}\}/g, upstreamText);
    }

    dbg('ai.runPrompt', `node=${ctx.node.id} prompt=${prompt.length} chars`);
    dbg('ai.runPrompt', `prompt preview: ${truncate(prompt, 500)}`);
    const interactiveClarification = ctx.resolvedConfig.interactiveClarification === true
      || ctx.resolvedConfig.interactiveClarification === 'true';

    // If interactive clarification is enabled, run a chat session before the prompt
    if (interactiveClarification) {
      const onProgress = (ctx as any)._onProgress as WorkflowProgressCallback | undefined;
      const signal = (ctx as any)._signal as AbortSignal | undefined;

      if (onProgress) {
        const sessionId = `clarify-${ctx.node.id}-${Date.now()}`;
        const greetingText = 'Before I run this AI prompt, I\'d like to gather some clarifying information. What additional context or specific requirements should I consider?';
        const messages: ChatMessage[] = [
          { role: 'assistant', content: greetingText, timestamp: new Date().toISOString() },
        ];

        const resolution = await new Promise<ChatResolution>((resolveChat) => {
          const session: ChatSessionState = {
            sessionId,
            nodeId: ctx.node.id,
            messages,
            resolve: resolveChat,
            systemPrompt: 'You are gathering clarifying information before running an AI prompt. Ask relevant follow-up questions to understand requirements. Be concise.',
            maxTurns: 10,
            turnCount: 0,
            onProgress,
          };
          activeChatSessions.set(sessionId, session);

          if (signal) {
            signal.addEventListener('abort', () => {
              if (activeChatSessions.has(sessionId)) {
                activeChatSessions.delete(sessionId);
                resolveChat({ transcript: messages, action: 'discard' });
              }
            }, { once: true });
          }

          onProgress({
            type: 'node-pause',
            nodeId: ctx.node.id,
            nodeType: ctx.node.type,
            chatSessionId: sessionId,
            chatMessage: messages[0],
          });
        });

        activeChatSessions.delete(sessionId);

        // Prepend the chat transcript to the prompt
        const transcriptText = resolution.transcript
          .filter((m) => m.role !== 'system')
          .map((m) => `[${m.role}]: ${m.content}`)
          .join('\n');
        if (transcriptText.trim()) {
          prompt = `--- Clarification Chat ---\n${transcriptText}\n\n--- Original Prompt ---\n${prompt}`;
        }
      }
    }

    const executor = new HeadlessWorkerExecutor(ctx.runContext.cwd, {
      maxConcurrent: 2,
      defaultTimeoutMs: timeoutMs,
    });
    activeExecutor = executor;

    try {
      const available = await executor.isAvailable();
      if (!available) {
        throw new Error('Claude CLI is not available for ai.runPrompt');
      }

      const result = await executor.execute('document', {
        promptTemplate: prompt,
        model,
        sandbox: 'permissive',
        outputFormat: 'text',
        contextPatterns: [],
        timeoutMs,
      });

      const initialText = String(result.output || '').trim();
      dbg('ai.runPrompt', `result: success=${result.success} outputLen=${initialText.length} error=${result.error || 'none'}`);

      if (!result.success && initialText.length === 0) {
        dbg('ai.runPrompt', `first attempt failed with no output, retrying with full prompt (${prompt.length} chars)`);
        // Retry with the full prompt — don't truncate, as that destroys upstream context
        const retryPrompt = prompt.length > 100000
          ? prompt.slice(0, 100000) + '\n\n[Content truncated for retry — provide the best response you can with the available context.]'
          : prompt;

        const retry = await executor.execute('document', {
          promptTemplate: retryPrompt,
          model,
          sandbox: 'permissive',
          outputFormat: 'text',
          contextPatterns: [],
          timeoutMs: Math.min(timeoutMs, 120000),
        });

        const retryText = String(retry.output || '').trim();
        dbg('ai.runPrompt', `retry: success=${retry.success} outputLen=${retryText.length} error=${retry.error || 'none'}`);
        if (!retry.success && retryText.length === 0) {
          const detail = (retry.error || result.error || 'ai.runPrompt failed').toString();
          throw new Error(`ai.runPrompt failed: ${detail}`);
        }

        return {
          model,
          text: retryText,
          durationMs: retry.durationMs,
          warning: retry.success ? undefined : (retry.error || result.error || 'Recovered from non-zero exit with output'),
        };
      }

      return {
        model,
        text: initialText,
        durationMs: result.durationMs,
        warning: result.success ? undefined : (result.error || 'Recovered from non-zero exit with output'),
      };
    } finally {
      activeExecutor = null;
    }
  },

  'image.visionExtract': async (ctx) => {
    const model = normalizeModel(ctx.resolvedConfig.model);
    const imagePathInput = ctx.resolvedConfig.imagePath;
    const jiraConfigPath = String(ctx.resolvedConfig.jiraConfigPath || '').trim();
    const seedSummary = String(ctx.resolvedConfig.seedSummary || '');
    const timeoutMs = Number(ctx.resolvedConfig.timeoutMs || 240000);

    const imagePaths = normalizeImageInputs(imagePathInput);
    if (imagePaths.length === 0) {
      return {
        model,
        imageCount: 0,
        imagePath: '',
        sourceUrl: undefined,
        images: [],
        analysis: 'No ticket images found to analyze.',
        warning: 'No image references were available from Jira ticket data.',
      };
    }

    const analyses: Array<{
      sourcePath: string;
      localPath: string;
      analysis: string;
      warning?: string;
    }> = [];

    let jiraConfigCache: JiraConfig | undefined;

    for (const pathCandidate of imagePaths) {
      let sourceUrl: string | undefined;
      let effectiveImagePath = pathCandidate;

      if (/^https?:\/\//i.test(pathCandidate)) {
        sourceUrl = pathCandidate;
        if (!jiraConfigPath) {
          throw new Error('image.visionExtract received URL imagePath but jiraConfigPath is missing for authenticated fetch.');
        }

        jiraConfigCache = jiraConfigCache || loadJiraConfig(resolveConfigPath(ctx.runContext.cwd, jiraConfigPath));
        const downloadDir = resolve(ctx.runContext.cwd, 'data/Output/Ticket-Research/seed-images');
        effectiveImagePath = await downloadBinaryUrlToTempFile(pathCandidate, jiraConfigCache, downloadDir);
      }

      // Read image file and encode as base64 for the Anthropic Vision API
      if (!existsSync(effectiveImagePath)) {
        analyses.push({
          sourcePath: pathCandidate,
          localPath: effectiveImagePath,
          analysis: `Image file not found: ${effectiveImagePath}`,
          warning: 'File not found after download',
        });
        continue;
      }

      const imageBuffer = readFileSync(effectiveImagePath);
      const base64Data = imageBuffer.toString('base64');
      // Detect media type from magic bytes (more reliable than extension)
      const detectedExt = detectImageExtFromBytes(imageBuffer);
      let mediaType = 'image/png'; // default
      if (detectedExt === '.jpeg') mediaType = 'image/jpeg';
      else if (detectedExt === '.gif') mediaType = 'image/gif';
      else if (detectedExt === '.webp') mediaType = 'image/webp';
      else if (detectedExt === '.png') mediaType = 'image/png';

      const promptText = [
        'You are an OCR + visual analysis assistant. Analyze this image thoroughly.',
        sourceUrl ? `Original source: ${sourceUrl}` : '',
        seedSummary ? `Context — ticket summary: ${seedSummary}` : '',
        '',
        'Provide a detailed analysis including:',
        '- Any text visible in the image (OCR)',
        '- UI elements, buttons, forms, error messages if it is a screenshot',
        '- Diagram content, flow, or architecture if it is a diagram',
        '- Data or tables if present',
        '- Any other relevant visual information',
        '',
        'Return your analysis as plain text, not JSON. Be thorough but concise.',
      ].filter(Boolean).join('\n');

      try {
        const text = await callAnthropicVision(base64Data, mediaType, promptText, model, timeoutMs, ctx.runContext.cwd);
        analyses.push({
          sourcePath: pathCandidate,
          localPath: effectiveImagePath,
          analysis: text,
        });
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Fallback: try HeadlessWorkerExecutor with the Read tool (it can view images)
        try {
          const executor = new HeadlessWorkerExecutor(ctx.runContext.cwd, {
            maxConcurrent: 1,
            defaultTimeoutMs: timeoutMs,
          });
          const available = await executor.isAvailable();
          if (available) {
            const fallbackPrompt = [
              `Read and analyze this image file: ${effectiveImagePath}`,
              seedSummary ? `Context: ${seedSummary}` : '',
              'Describe all visible text, UI elements, and visual content in detail.',
            ].filter(Boolean).join('\n');
            const result = await executor.execute('document', {
              promptTemplate: fallbackPrompt,
              model,
              sandbox: 'permissive',
              outputFormat: 'text',
              contextPatterns: [],
              timeoutMs,
            });
            const fallbackText = String(result.output || '').trim();
            if (fallbackText) {
              analyses.push({
                sourcePath: pathCandidate,
                localPath: effectiveImagePath,
                analysis: fallbackText,
                warning: `Anthropic API failed (${errMsg}), used CLI fallback`,
              });
              continue;
            }
          }
        } catch { /* ignore fallback errors */ }

        analyses.push({
          sourcePath: pathCandidate,
          localPath: effectiveImagePath,
          analysis: `Vision analysis failed: ${errMsg}`,
          warning: errMsg,
        });
      }
    }

    const mergedAnalysis = analyses
      .map((item, index) => `Image ${index + 1}: ${item.sourcePath}\n${item.analysis}`)
      .join('\n\n');

    return {
      model,
      imageCount: analyses.length,
      imagePath: analyses[0]?.localPath || '',
      sourceUrl: analyses[0]?.sourcePath,
      images: analyses,
      analysis: mergedAnalysis,
      warning: analyses.some((item) => Boolean(item.warning)) ? 'One or more images completed with warnings.' : undefined,
    };
  },

  'transform.template': async (ctx) => {
    const template = String(ctx.resolvedConfig.template || '');
    const upstreamValue = buildUpstreamText(ctx.previousResults);

    const templateVars = {
      ...ctx.runContext.variables,
      ...collectFlatOutputs(ctx.previousResults),
      _upstream: upstreamValue,
    };
    dbg('template', `template: ${template.length} chars, has {{_upstream}}: ${template.includes('{{_upstream}}')}`);
    const rendered = renderTemplate(template, templateVars);
    dbg('template', `rendered: ${rendered.length} chars, has REQUIREMENTS: ${rendered.includes('## REQUIREMENTS')}`);
    dbg('template', `rendered preview: ${truncate(rendered, 400)}`);
    return { content: rendered };
  },

  'io.readFile': async (ctx) => {
    const inputPath = String(ctx.resolvedConfig.path || '').trim();
    if (!inputPath) {
      throw new Error('io.readFile requires a path.');
    }

    const absolutePath = resolve(ctx.runContext.cwd, inputPath);
    if (!existsSync(absolutePath)) {
      throw new Error(`io.readFile path not found: ${absolutePath}`);
    }

    const content = readFileSync(absolutePath, 'utf-8');
    return {
      path: absolutePath,
      content,
      bytes: Buffer.byteLength(content, 'utf-8'),
    };
  },

  'jira.createIssues': async (ctx) => {
    const configPath = resolveConfigPath(ctx.runContext.cwd, String(ctx.resolvedConfig.configPath || ''));
    const projectKey = String(ctx.resolvedConfig.projectKey || '').trim();
    const board = String(ctx.resolvedConfig.board || '').trim();
    const issueTypeName = String(ctx.resolvedConfig.issueTypeName || 'Task').trim() || 'Task';
    const dryRun = toBoolean(ctx.resolvedConfig.dryRun, true);
    const targetStatus = String(ctx.resolvedConfig.targetStatus || '').trim();
    const labels = normalizeStringArray(ctx.resolvedConfig.labels);
    const components = normalizeStringArray(ctx.resolvedConfig.components);

    // --- Debug: capture raw tickets value before parsing ---
    const rawTicketsValue = ctx.resolvedConfig.tickets;
    const rawTicketsType = rawTicketsValue === null ? 'null'
      : rawTicketsValue === undefined ? 'undefined'
      : Array.isArray(rawTicketsValue) ? 'array'
      : typeof rawTicketsValue;
    const rawTicketsPreview = rawTicketsValue == null ? '(empty)'
      : typeof rawTicketsValue === 'string' ? rawTicketsValue.slice(0, 500)
      : JSON.stringify(rawTicketsValue).slice(0, 500);

    const tickets = parseTicketDrafts(rawTicketsValue);

    const debug: Record<string, unknown> = {
      ticketsConfigType: rawTicketsType,
      ticketsConfigPreview: rawTicketsPreview,
      ticketsParsedCount: tickets.length,
      resolvedConfigKeys: Object.keys(ctx.resolvedConfig),
    };

    if (!projectKey) {
      throw new Error('jira.createIssues requires projectKey.');
    }

    if (tickets.length === 0) {
      // Try to surface why parsing failed
      debug.parsingHint = rawTicketsValue == null
        ? 'The "tickets" config field resolved to null/undefined. Check that the upstream node reference (e.g. {{generateTickets.text}}) is correct and the upstream node produced output.'
        : typeof rawTicketsValue === 'string' && rawTicketsValue.length > 0
          ? 'The "tickets" config is a non-empty string but no ticket objects could be extracted. The AI response may not contain valid JSON, or the JSON structure does not match the expected format ({tickets:[{summary,description}]} or [{summary,description}]).'
          : 'The "tickets" config is present but could not be parsed into ticket drafts. Expected an array of objects with at least a "summary" field.';

      return {
        dryRun,
        projectKey,
        board,
        issueTypeName,
        createdCount: 0,
        created: [],
        warning: 'No ticket drafts were produced by upstream nodes.',
        _debug: debug,
      };
    }

    if (dryRun) {
      return {
        dryRun: true,
        projectKey,
        board,
        issueTypeName,
        createdCount: tickets.length,
        created: tickets.map((ticket, index) => ({
          index: index + 1,
          summary: ticket.summary,
          description: ticket.description,
          labels: dedupeStrings([...(ticket.labels || []), ...labels, board ? `board-${slugify(board)}` : ''].filter(Boolean)),
        })),
        _debug: debug,
      };
    }

    const jiraConfig = loadJiraConfig(configPath);
    const created: Array<Record<string, unknown>> = [];
    const apiErrors: Array<Record<string, unknown>> = [];

    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const payload = {
        fields: {
          project: { key: projectKey },
          summary: ticket.summary,
          description: markdownToAdf(ticket.description),
          issuetype: { name: issueTypeName },
          labels: dedupeStrings([...(ticket.labels || []), ...labels, board ? `board-${slugify(board)}` : ''].filter(Boolean)),
          components: dedupeStrings([...(ticket.components || []), ...components]).map((name) => ({ name })),
        },
      };

      try {
        const result = await jiraApiPost<Record<string, unknown>>(jiraConfig, 'issue', payload);
        const issueKey = String(result.key || '');
        const entry: Record<string, unknown> = {
          key: issueKey,
          id: String(result.id || ''),
          self: String(result.self || ''),
          summary: ticket.summary,
          description: ticket.description,
        };

        // Transition to target status if specified
        if (targetStatus && issueKey) {
          try {
            const transitions = await jiraApiRequest<{ transitions: Array<{ id: string; name: string }> }>(
              jiraConfig, `issue/${issueKey}/transitions`
            );
            const match = transitions.transitions.find(
              (t) => t.name.toLowerCase() === targetStatus.toLowerCase()
            );
            if (match) {
              await jiraApiPost(jiraConfig, `issue/${issueKey}/transitions`, {
                transition: { id: match.id },
              });
              entry.transitioned = true;
              entry.status = match.name;
            } else {
              entry.transitioned = false;
              entry.transitionWarning = `No transition named "${targetStatus}" found. Available: ${transitions.transitions.map((t) => t.name).join(', ')}`;
            }
          } catch (transErr) {
            entry.transitioned = false;
            entry.transitionError = transErr instanceof Error ? transErr.message : String(transErr);
          }
        }

        created.push(entry);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        apiErrors.push({
          ticketIndex: i,
          summary: ticket.summary,
          error: errMsg,
          requestPayload: payload,
        });
      }
    }

    return {
      dryRun: false,
      projectKey,
      board,
      issueTypeName,
      createdCount: created.length,
      created,
      ...(apiErrors.length > 0 ? {
        failedCount: apiErrors.length,
        apiErrors,
      } : {}),
      _debug: debug,
    };
  },

  'jira.addComment': async (ctx) => {
    const configPath = resolveConfigPath(ctx.runContext.cwd, String(ctx.resolvedConfig.configPath || ''));
    const issueKey = String(ctx.resolvedConfig.issueKey || '').trim();
    const commentText = String(ctx.resolvedConfig.comment || '').trim();
    const delayMs = Math.max(0, Number(ctx.resolvedConfig.delayMs || 3000));

    if (!issueKey || !commentText) {
      throw new Error('jira.addComment requires issueKey and comment.');
    }

    // Brief delay to allow Jira to index the newly created issue
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    const jiraConfig = loadJiraConfig(configPath);
    const fmt = String(ctx.resolvedConfig.outputFormat || 'adf').trim().toLowerCase();
    const commentBody = fmt === 'plain'
      ? { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: commentText }] }] }
      : markdownToAdf(commentText);

    // Retry once after a short delay if the issue is not found (eventual consistency)
    let result: Record<string, unknown>;
    try {
      result = await jiraApiPost<Record<string, unknown>>(
        jiraConfig,
        `issue/${encodeURIComponent(issueKey)}/comment`,
        { body: commentBody }
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('404')) {
        await new Promise((r) => setTimeout(r, 5000));
        result = await jiraApiPost<Record<string, unknown>>(
          jiraConfig,
          `issue/${encodeURIComponent(issueKey)}/comment`,
          { body: commentBody }
        );
      } else {
        throw err;
      }
    }

    return {
      issueKey,
      commentId: String(result.id || ''),
      self: String(result.self || ''),
      created: true,
    };
  },

  'jira.updateIssue': async (ctx) => {
    const configPath = resolveConfigPath(ctx.runContext.cwd, String(ctx.resolvedConfig.configPath || ''));
    const rawInput = String(ctx.resolvedConfig.issueKey || '').trim();
    const summary = String(ctx.resolvedConfig.summary || '').trim();
    let description = String(ctx.resolvedConfig.description || '').trim();
    const dryRun = ctx.resolvedConfig.dryRun === true || ctx.resolvedConfig.dryRun === 'true';
    const mode = String(ctx.resolvedConfig.mode || 'update').toLowerCase().trim();

    if (!rawInput) {
      throw new Error('jira.updateIssue requires issueKey.');
    }

    if (!summary && !description) {
      throw new Error('jira.updateIssue requires at least summary or description to update.');
    }

    const issueKey = extractTicketKey(rawInput);

    // Parse image attachment metadata for ADF media nodes
    const imageAttachments = parseImageAttachments(ctx.resolvedConfig.imageAttachments);

    if (dryRun) {
      return {
        issueKey,
        updated: false,
        dryRun: true,
        mode,
        description,
        summary: summary || undefined,
        imageCount: imageAttachments.length,
        updatedFields: [summary ? 'summary' : '', description ? 'description' : ''].filter(Boolean),
      };
    }

    const jiraConfig = loadJiraConfig(configPath);

    if (mode === 'comment') {
      // Add as a comment instead of replacing the description
      const adfBody = buildAdfWithImages(description, imageAttachments);
      const result = await jiraApiPost<Record<string, unknown>>(
        jiraConfig,
        `issue/${encodeURIComponent(issueKey)}/comment`,
        { body: adfBody }
      );
      return {
        issueKey,
        updated: true,
        dryRun: false,
        mode: 'comment',
        description,
        commentId: String(result.id || ''),
        imageCount: imageAttachments.length,
        updatedFields: ['comment'],
      };
    }

    // Default: update the description
    const fields: Record<string, unknown> = {};
    if (summary) {
      fields.summary = summary;
    }
    if (description) {
      fields.description = buildAdfWithImages(description, imageAttachments);
    }

    await jiraApiPut(jiraConfig, `issue/${encodeURIComponent(issueKey)}`, { fields });

    return {
      issueKey,
      updated: true,
      dryRun: false,
      mode: 'update',
      description,
      imageCount: imageAttachments.length,
      updatedFields: Object.keys(fields),
    };
  },

  'azuredevops.createPullRequest': async (ctx) => {
    const adoConfigPath = String(ctx.resolvedConfig.adoConfigPath || '').trim();
    const adoCfg = loadAdoConfig(ctx.runContext.cwd, adoConfigPath);
    const organizationUrl = String(ctx.resolvedConfig.organizationUrl || adoCfg.orgUrl || '').trim();
    const prScope = parseAdoScope(String(ctx.resolvedConfig.repoUrl || ''));
    const project = prScope.project || String(ctx.resolvedConfig.project || '').trim();
    const repository = prScope.repository || String(ctx.resolvedConfig.repository || '').trim();
    const sourceBranch = String(ctx.resolvedConfig.sourceBranch || 'main').trim() || 'main';
    const patEnvVar = String(ctx.resolvedConfig.patEnvVar || 'AZURE_DEVOPS_PAT').trim() || 'AZURE_DEVOPS_PAT';
    const patInline = String(ctx.resolvedConfig.pat || '').trim();
    const ticketKey = String(ctx.resolvedConfig.ticketKey || '').trim();
    const ticketSummary = String(ctx.resolvedConfig.ticketSummary || '').trim();
    const ticketDescription = String(ctx.resolvedConfig.ticketDescription || '').trim();
    const dryRun = ctx.resolvedConfig.dryRun === true || ctx.resolvedConfig.dryRun === 'true';

    // Resolve PAT: config file → inline → process.env → .env file → encrypted ADO config
    let pat = adoCfg.pat || patInline || process.env[patEnvVar] || '';
    if (!pat) {
      pat = loadEnvValue(ctx.runContext.cwd, patEnvVar);
    }
    if (!pat) {
      pat = loadAdoConfigValue(ctx.runContext.cwd, patEnvVar);
    }

    if (!organizationUrl || !project || !repository) {
      return { created: false, skipped: true, reason: 'organizationUrl, project, or repository not provided.' };
    }
    if (!pat) {
      return { created: false, skipped: true, reason: `PAT not provided. Checked: inline, process.env.${patEnvVar}, .env file.` };
    }
    if (!ticketKey) {
      return { created: false, skipped: true, reason: 'ticketKey not provided.' };
    }

    // Extract code changes from ticket description
    const codeChanges = extractCodeChangesFromMarkdown(ticketDescription);
    const branchName = `feature/${ticketKey}-${slugify(ticketSummary || 'update')}`;

    if (codeChanges.length === 0) {
      return {
        created: false,
        dryRun,
        branchName,
        filesChanged: 0,
        warning: 'No code changes found in ticket description. Expected "File: path" followed by a code block.',
      };
    }

    if (dryRun) {
      return {
        dryRun: true,
        created: false,
        branchName,
        filesChanged: codeChanges.length,
        files: codeChanges.map((c) => ({ path: c.filePath, language: c.language, chars: c.content.length })),
        prUrl: `(dry run) ${organizationUrl}/${project}/_git/${repository}/pullrequest/new?sourceRef=${encodeURIComponent(branchName)}&targetRef=${encodeURIComponent(sourceBranch)}`,
        prTitle: `${ticketKey}: ${ticketSummary}`,
      };
    }

    const base = organizationUrl.replace(/\/+$/, '');
    const encodedProject = encodeURIComponent(project);
    const encodedRepo = encodeURIComponent(repository);
    const auth = Buffer.from(`:${pat}`).toString('base64');
    const adoHeaders = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'User-Agent': 'claude-flow-workflow-studio/1.0',
    };

    // Step 1: Get source branch commit SHA
    const refsUrl = new URL(`${base}/${encodedProject}/_apis/git/repositories/${encodedRepo}/refs`);
    refsUrl.searchParams.set('filter', `heads/${sourceBranch}`);
    refsUrl.searchParams.set('api-version', '7.1');

    const refsResult = await httpJsonRequest<{ value?: Array<{ objectId: string }> }>(refsUrl, {
      method: 'GET',
      headers: adoHeaders,
    });

    const sourceCommitId = refsResult.value?.[0]?.objectId;
    if (!sourceCommitId) {
      throw new Error(`Could not find branch "${sourceBranch}" in repository "${repository}".`);
    }

    // Step 2: Create feature branch
    const createRefUrl = new URL(`${base}/${encodedProject}/_apis/git/repositories/${encodedRepo}/refs`);
    createRefUrl.searchParams.set('api-version', '7.1');

    await httpJsonPost<unknown>(createRefUrl, {
      headers: adoHeaders,
      body: [{
        name: `refs/heads/${branchName}`,
        oldObjectId: '0000000000000000000000000000000000000000',
        newObjectId: sourceCommitId,
      }],
    });

    // Step 3: Push file changes
    const pushUrl = new URL(`${base}/${encodedProject}/_apis/git/repositories/${encodedRepo}/pushes`);
    pushUrl.searchParams.set('api-version', '7.1');

    const changes = codeChanges.map((entry) => ({
      changeType: 'edit',
      item: { path: `/${entry.filePath.replace(/^\/+/, '')}` },
      newContent: {
        content: Buffer.from(entry.content, 'utf-8').toString('base64'),
        contentType: 'base64encoded',
      },
    }));

    const pushResult = await httpJsonPost<Record<string, unknown>>(pushUrl, {
      headers: adoHeaders,
      body: {
        refUpdates: [{ name: `refs/heads/${branchName}`, oldObjectId: sourceCommitId }],
        commits: [{
          comment: `${ticketKey}: ${ticketSummary}`,
          changes,
        }],
      },
    });

    // Step 4: Create pull request
    const prUrl = new URL(`${base}/${encodedProject}/_apis/git/repositories/${encodedRepo}/pullrequests`);
    prUrl.searchParams.set('api-version', '7.1');

    // Build rich PR description with code change summary and Jira link
    let prDescription = `Implements ${ticketKey}: ${ticketSummary}\n\n`;
    prDescription += `### Files Changed (${codeChanges.length})\n`;
    for (const change of codeChanges) {
      prDescription += `- \`${change.filePath}\`\n`;
    }

    // Include Jira ticket link if config path is available
    const jiraConfigPath = String(ctx.resolvedConfig.jiraConfigPath || '').trim();
    if (jiraConfigPath) {
      try {
        const jiraCfg = loadJiraConfig(resolveConfigPath(ctx.runContext.cwd, jiraConfigPath));
        prDescription += `\n### Jira Ticket\n[${ticketKey}: ${ticketSummary}](${jiraCfg.baseUrl}/browse/${ticketKey})\n`;
      } catch { /* jira config not available — skip link */ }
    }

    const prResult = await httpJsonPost<Record<string, unknown>>(prUrl, {
      headers: adoHeaders,
      body: {
        sourceRefName: `refs/heads/${branchName}`,
        targetRefName: `refs/heads/${sourceBranch}`,
        title: `${ticketKey}: ${ticketSummary}`,
        description: prDescription,
      },
    });

    const prId = Number(prResult.pullRequestId || 0);
    // Always construct the human-readable web URL (API returns REST URL with GUIDs)
    const prWebUrl = `${base}/${encodedProject}/_git/${encodeURIComponent(repository)}/pullrequest/${prId}`;

    return {
      created: true,
      dryRun: false,
      branchName,
      prId,
      prUrl: prWebUrl,
      prTitle: `${ticketKey}: ${ticketSummary}`,
      filesChanged: codeChanges.length,
      pushId: pushResult.pushId || null,
    };
  },

  'io.writeFile': async (ctx) => {
    const outputPath = resolve(ctx.runContext.cwd, String(ctx.resolvedConfig.path || 'output.txt'));
    const content = ctx.resolvedConfig.content;
    const prettyJson = Boolean(ctx.resolvedConfig.prettyJson);

    const text = typeof content === 'string'
      ? content
      : JSON.stringify(content, null, prettyJson ? 2 : 0);

    writeFileSync(outputPath, text, 'utf-8');

    return {
      path: outputPath,
      bytes: Buffer.byteLength(text, 'utf-8'),
      written: true,
    };
  },

  // ---------------------------------------------------------------------------
  // web.fetchUrl — fetch one or more public web pages and return their content
  // ---------------------------------------------------------------------------
  'web.fetchUrl': async (ctx) => {
    const urlsRaw = String(ctx.resolvedConfig.urls || '').trim();
    const timeoutMs = Number(ctx.resolvedConfig.timeoutMs || 30000);

    console.error(`[web.fetchUrl] urls raw value: "${urlsRaw.slice(0, 200)}"`);

    // Parse URLs — newline or comma separated
    const urls = urlsRaw
      .split(/[\n,]+/)
      .map((u: string) => u.trim())
      .filter((u: string) => /^https?:\/\//i.test(u));

    console.error(`[web.fetchUrl] parsed ${urls.length} valid URL(s): ${urls.join(', ')}`);

    if (urls.length === 0) {
      console.error('[web.fetchUrl] SKIP — no valid URLs found in input');
      return { pages: [], count: 0, content: 'No valid URLs provided.' };
    }

    const pages: Array<{ url: string; content: string; error?: string }> = [];

    for (const rawUrl of urls) {
      try {
        console.error(`[web.fetchUrl] fetching: ${rawUrl}`);
        const fetched = await httpFetchPage(rawUrl, timeoutMs);
        // Strip HTML to rough plain text / markdown
        const text = htmlToPlainText(fetched);
        const trimmed = text.slice(0, 15000); // cap per page
        console.error(`[web.fetchUrl] OK — ${trimmed.length} chars extracted from ${rawUrl}`);
        pages.push({ url: rawUrl, content: trimmed });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[web.fetchUrl] FAIL — ${rawUrl}: ${msg}`);
        pages.push({ url: rawUrl, content: '', error: msg });
      }
    }

    const combinedContent = pages
      .filter((p) => p.content)
      .map((p) => `### ${p.url}\n${p.content}`)
      .join('\n\n---\n\n');

    return {
      pages,
      count: pages.filter((p) => p.content && !p.error).length,
      content: combinedContent || 'No content was retrieved from the provided URLs.',
    };
  },

  // ---------------------------------------------------------------------------
  // ado.codeSearch — search Azure DevOps code with auto-retry via AI refinement
  // ---------------------------------------------------------------------------
  'ado.codeSearch': async (ctx) => {
    const adoConfigPath = String(ctx.resolvedConfig.adoConfigPath || '').trim();
    const adoCfg = loadAdoConfig(ctx.runContext.cwd, adoConfigPath);
    const organizationUrl = String(ctx.resolvedConfig.organizationUrl || adoCfg.orgUrl || '').trim().replace(/\/+$/, '');
    const scope = parseAdoScope(String(ctx.resolvedConfig.repoUrl || ''));
    const project = scope.project || String(ctx.resolvedConfig.project || '').trim();
    let query = String(ctx.resolvedConfig.query || '').trim();
    const repository = scope.repository || String(ctx.resolvedConfig.repository || '').trim();
    const patEnvVar = String(ctx.resolvedConfig.patEnvVar || 'AZURE_DEVOPS_PAT').trim();
    const maxResults = Math.min(100, Math.max(1, Number(ctx.resolvedConfig.maxResults || 25)));
    const maxRetries = Math.max(0, Math.min(5, Number(ctx.resolvedConfig.maxRetries ?? 2)));
    const searchContext = String(ctx.resolvedConfig.searchContext || '').trim().slice(0, 3000);
    const retryModel = normalizeModel(ctx.resolvedConfig.model || 'haiku');

    const pat = adoCfg.pat
      || String(ctx.resolvedConfig.pat || '').trim()
      || process.env[patEnvVar]
      || loadEnvValue(ctx.runContext.cwd, patEnvVar)
      || loadAdoConfigValue(ctx.runContext.cwd, patEnvVar);

    const scopeLabel = repository ? `project="${project}" repo="${repository}"` : project ? `project="${project}"` : 'org-wide';
    console.error(`[ado.codeSearch] orgUrl="${organizationUrl}" ${scopeLabel} query="${query.slice(0, 100)}" pat=${pat ? 'SET' : 'MISSING'}`);
    console.error(`[ado.codeSearch] maxResults=${maxResults} maxRetries=${maxRetries} searchContext=${searchContext.length} chars`);

    if (!organizationUrl) {
      console.error('[ado.codeSearch] SKIP — organizationUrl is empty');
      return { results: [], count: 0, queries: [query], summary: 'ADO organization URL not provided — skipping code search.' };
    }
    if (!pat) {
      console.error(`[ado.codeSearch] SKIP — PAT not found. Checked: process.env.${patEnvVar}, .env file, data/ADO/config/ado.env`);
      return { results: [], count: 0, queries: [query], summary: `ADO PAT not found. Checked process.env.${patEnvVar}, .env file, and data/ADO/config/ado.env. Set the PAT and retry.` };
    }
    if (!query && searchContext) {
      console.error('[ado.codeSearch] query is empty but searchContext available — generating initial query via AI');
      const generated = await aiGenerateInitialQuery(ctx.runContext.cwd, searchContext, 'code', retryModel);
      if (generated) {
        query = generated;
        console.error(`[ado.codeSearch] AI generated initial query: "${query.slice(0, 100)}"`);
      }
    }
    if (!query) {
      console.error('[ado.codeSearch] SKIP — query is empty and no searchContext to generate from');
      return { results: [], count: 0, queries: [], summary: 'No search query provided and no research context to generate one.' };
    }

    const auth = Buffer.from(`:${pat}`).toString('base64');
    const caCert = loadCaCert(ctx.runContext.cwd, String(ctx.resolvedConfig.configPath || ''));
    if (caCert) console.error('[ado.codeSearch] CA cert loaded for SSL');
    const queriesTried: string[] = [];
    const allResults: Array<{ filePath: string; repository: string; snippet: string; url: string }> = [];

    let currentQuery = query;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      queriesTried.push(currentQuery);
      console.error(`[ado.codeSearch] attempt ${attempt + 1}/${maxRetries + 1}: query="${currentQuery}"`);
      dbg('ado.codeSearch', `attempt ${attempt + 1}: "${currentQuery}"`);

      try {
        // Extract org name from various ADO URL formats:
        //   https://dev.azure.com/myorg  →  myorg
        //   https://myorg.visualstudio.com  →  myorg
        //   myorg  →  myorg
        let orgName = organizationUrl;
        const devAzureMatch = orgName.match(/^https?:\/\/dev\.azure\.com\/([^/]+)/i);
        const vsMatch = orgName.match(/^https?:\/\/([^.]+)\.visualstudio\.com/i);
        if (devAzureMatch) orgName = devAzureMatch[1];
        else if (vsMatch) orgName = vsMatch[1];
        else orgName = orgName.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

        const pathSegment = project
          ? `${encodeURIComponent(orgName)}/${encodeURIComponent(project)}`
          : encodeURIComponent(orgName);
        const searchUrl = new URL(`https://almsearch.dev.azure.com/${pathSegment}/_apis/search/codesearchresults`);
        searchUrl.searchParams.set('api-version', '7.0');

        const filters: Record<string, string[]> = {};
        if (project) filters.Project = [project];
        if (repository) {
          if (!project) {
            console.error('[ado.codeSearch] WARNING: repository filter requires a project — ignoring repository filter');
          } else {
            filters.Repository = [repository];
          }
        }
        const body: Record<string, unknown> = {
          searchText: currentQuery,
          $top: maxResults,
          filters,
        };

        const response = await httpJsonPost<{
          count?: number;
          results?: Array<{
            fileName?: string;
            path?: string;
            repository?: { name?: string };
            matches?: Record<string, Array<{ charOffset?: number; length?: number }>>;
            contentId?: string;
          }>;
        }>(searchUrl, {
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
            'User-Agent': 'claude-flow-workflow-studio/1.0',
          },
          body,
          ca: caCert,
        });

        const hits = response.results || [];
        console.error(`[ado.codeSearch] API returned ${hits.length} hit(s) (response.count=${response.count})`);
        for (const hit of hits) {
          const filePath = hit.path || hit.fileName || 'unknown';
          const repoName = hit.repository?.name || repository || 'unknown';
          allResults.push({
            filePath,
            repository: repoName,
            snippet: `${filePath} (${repoName})`,
            url: `${organizationUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}?path=${encodeURIComponent(filePath)}`,
          });
        }

        if (allResults.length > 0) {
          console.error(`[ado.codeSearch] found ${allResults.length} total result(s), stopping retries`);
          break;
        }
        console.error('[ado.codeSearch] 0 results from API, will retry if attempts remain');
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[ado.codeSearch] API ERROR: ${errMsg}`);
        dbg('ado.codeSearch', `search error: ${errMsg}`);
        // Bail immediately on fatal errors that won't resolve with different queries
        if (errMsg.includes('ProjectDoesNotExistWithNameException') || errMsg.includes('does not exist')) {
          const fatalMsg = `Project "${project}" not found. Paste the full repo URL in the Scope field (e.g. https://org.visualstudio.com/Project/_git/Repo) — the project and repo are extracted automatically.`;
          console.error(`[ado.codeSearch] FATAL: ${fatalMsg}`);
          return { results: [], count: 0, queries: queriesTried, summary: fatalMsg };
        }
        if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('Unauthorized') || errMsg.includes('Forbidden')) {
          const fatalMsg = `Authentication failed. Check your ADO PAT has Code (Read) scope.`;
          console.error(`[ado.codeSearch] FATAL: ${fatalMsg}`);
          return { results: [], count: 0, queries: queriesTried, summary: fatalMsg };
        }
      }

      // No results — ask AI for a refined query if retries remain
      if (attempt < maxRetries && allResults.length === 0) {
        try {
          const refinedQuery = await aiRefineSearchQuery(ctx.runContext.cwd, currentQuery, searchContext, retryModel);
          if (refinedQuery && refinedQuery !== currentQuery) {
            currentQuery = refinedQuery;
          } else {
            break; // AI couldn't produce a different query
          }
        } catch {
          break; // AI refinement failed
        }
      }
    }

    const summary = allResults.length > 0
      ? allResults.map((r) => `- ${r.filePath} (${r.repository})`).join('\n')
      : `No code matches found after ${queriesTried.length} attempt(s). Queries tried: ${queriesTried.map((q) => `"${q}"`).join(', ')}`;

    return { results: allResults, count: allResults.length, queries: queriesTried, summary };
  },

  // ---------------------------------------------------------------------------
  // ado.deepCodeSearch — exhaustive multi-query code search across all repos
  // ---------------------------------------------------------------------------
  'ado.deepCodeSearch': async (ctx) => {
    const adoConfigPath = String(ctx.resolvedConfig.adoConfigPath || '').trim();
    const adoCfg = loadAdoConfig(ctx.runContext.cwd, adoConfigPath);
    const organizationUrl = String(ctx.resolvedConfig.organizationUrl || adoCfg.orgUrl || '').trim().replace(/\/+$/, '');
    const scope = parseAdoScope(String(ctx.resolvedConfig.repoUrl || ''));
    const project = scope.project || String(ctx.resolvedConfig.project || '').trim();
    const repository = scope.repository || '';
    const patEnvVar = String(ctx.resolvedConfig.patEnvVar || 'AZURE_DEVOPS_PAT').trim();
    const searchContext = String(ctx.resolvedConfig.searchContext || '').trim();
    const maxResultsPerQuery = Math.min(50, Math.max(1, Number(ctx.resolvedConfig.maxResultsPerQuery || 10)));
    const maxRounds = Math.max(1, Math.min(5, Number(ctx.resolvedConfig.maxRounds ?? 2)));
    const model = normalizeModel(ctx.resolvedConfig.model || 'haiku');

    const pat = adoCfg.pat
      || String(ctx.resolvedConfig.pat || '').trim()
      || process.env[patEnvVar]
      || loadEnvValue(ctx.runContext.cwd, patEnvVar)
      || loadAdoConfigValue(ctx.runContext.cwd, patEnvVar);

    const scopeLabel = repository ? `project="${project}" repo="${repository}"` : project ? `project="${project}"` : 'org-wide';
    console.error(`[ado.deepCodeSearch] org="${organizationUrl}" ${scopeLabel} pat=${pat ? 'SET' : 'MISSING'} maxRounds=${maxRounds} context=${searchContext.length} chars`);

    if (!organizationUrl) {
      return { results: [], count: 0, queries: [], rounds: 0, summary: 'ADO organization URL not provided.' };
    }
    if (!pat) {
      return { results: [], count: 0, queries: [], rounds: 0, summary: `ADO PAT not found. Set ${patEnvVar} and retry.` };
    }
    if (!searchContext) {
      return { results: [], count: 0, queries: [], rounds: 0, summary: 'No research context provided to generate search queries from.' };
    }

    // Extract org name for almsearch API
    let orgName = organizationUrl;
    const devAzureMatch = orgName.match(/^https?:\/\/dev\.azure\.com\/([^/]+)/i);
    const vsMatch = orgName.match(/^https?:\/\/([^.]+)\.visualstudio\.com/i);
    if (devAzureMatch) orgName = devAzureMatch[1];
    else if (vsMatch) orgName = vsMatch[1];
    else orgName = orgName.replace(/^https?:\/\//i, '').replace(/\/+$/, '');

    const auth = Buffer.from(`:${pat}`).toString('base64');
    const caCert = loadCaCert(ctx.runContext.cwd);

    type CodeHit = { filePath: string; repository: string; project: string; snippet: string; url: string; query: string };
    const allResults: CodeHit[] = [];
    const seenFiles = new Set<string>(); // dedup key: repo/filePath
    const allQueries: string[] = [];

    // Track fatal errors to bail early instead of repeating the same 404 dozens of times
    let fatalError = '';

    // Helper: run a single ADO code search query
    async function runQuery(q: string): Promise<CodeHit[]> {
      if (fatalError) return []; // skip if we already hit a fatal error

      // When project is provided, scope search to that project; otherwise search the whole org
      const pathSegment = project
        ? `${encodeURIComponent(orgName)}/${encodeURIComponent(project)}`
        : encodeURIComponent(orgName);
      const searchUrl = new URL(`https://almsearch.dev.azure.com/${pathSegment}/_apis/search/codesearchresults`);
      searchUrl.searchParams.set('api-version', '7.0');
      const filters: Record<string, string[]> = {};
      if (project) filters.Project = [project];
      if (repository && project) filters.Repository = [repository];
      try {
        const response = await httpJsonPost<{
          count?: number;
          results?: Array<{
            fileName?: string;
            path?: string;
            repository?: { name?: string };
            project?: { name?: string };
          }>;
        }>(searchUrl, {
          headers: { Authorization: `Basic ${auth}`, Accept: 'application/json', 'User-Agent': 'claude-flow-workflow-studio/1.0' },
          body: { searchText: q, $top: maxResultsPerQuery, filters },
          ca: caCert,
        });
        const hits = response.results || [];
        console.error(`[ado.deepCodeSearch] query="${q.slice(0, 80)}" → ${hits.length} hit(s)`);
        const results: CodeHit[] = [];
        for (const hit of hits) {
          const filePath = hit.path || hit.fileName || 'unknown';
          const repoName = hit.repository?.name || 'unknown';
          const hitProject = hit.project?.name || project || '';
          const dedupKey = `${hitProject}::${repoName}::${filePath}`;
          if (!seenFiles.has(dedupKey)) {
            seenFiles.add(dedupKey);
            const projectSegment = hitProject ? `/${encodeURIComponent(hitProject)}` : '';
            results.push({
              filePath,
              repository: repoName,
              project: hitProject,
              snippet: `${filePath} (${hitProject ? hitProject + '/' : ''}${repoName})`,
              url: `${organizationUrl}${projectSegment}/_git/${encodeURIComponent(repoName)}?path=${encodeURIComponent(filePath)}`,
              query: q,
            });
          }
        }
        return results;
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[ado.deepCodeSearch] query="${q.slice(0, 80)}" ERROR: ${errMsg}`);
        // Detect fatal errors that won't resolve by retrying with different queries
        if (errMsg.includes('ProjectDoesNotExistWithNameException') || errMsg.includes('does not exist')) {
          fatalError = `Project "${project}" not found. Paste the full repo URL in the Scope field (e.g. https://org.visualstudio.com/Project/_git/Repo) — the project and repo are extracted automatically.`;
          console.error(`[ado.deepCodeSearch] FATAL: ${fatalError}`);
        } else if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('Unauthorized') || errMsg.includes('Forbidden')) {
          fatalError = `Authentication failed (${errMsg.includes('401') ? '401' : '403'}). Check your ADO PAT has Code (Read) scope.`;
          console.error(`[ado.deepCodeSearch] FATAL: ${fatalError}`);
        }
        return [];
      }
    }

    // Helper: ask AI to generate a list of search queries
    async function generateQueries(prompt: string): Promise<string[]> {
      const executor = new HeadlessWorkerExecutor(ctx.runContext.cwd, { maxConcurrent: 1, defaultTimeoutMs: 45_000 });
      if (!(await executor.isAvailable())) return [];
      const result = await executor.execute('document', {
        promptTemplate: prompt,
        model,
        sandbox: 'permissive',
        outputFormat: 'text',
        contextPatterns: [],
        timeoutMs: 45_000,
      });
      if (!result.success || !result.output?.trim()) return [];
      // Parse one query per line, strip numbering and noise
      return result.output
        .split('\n')
        .map((line) => stripAiQueryNoise(line.replace(/^\d+[\.\)]\s*/, '').trim()))
        .filter((q) => q.length >= 3 && q.length < 200 && !looksLikeProse(q));
    }

    // ROUND 1: Generate initial batch of targeted search terms from context
    console.error(`[ado.deepCodeSearch] Round 1: generating initial search queries from context...`);
    const round1Queries = await generateQueries([
      'You are generating targeted code search queries for Azure DevOps code search.',
      'Based on the research context below, generate 8-12 specific search queries.',
      'Think about the FULL DEPENDENCY CHAIN — from the specific change all the way to infrastructure code:',
      '',
      'LAYER 1 — Exact strings from the change:',
      '- Exact API version strings, SDK version pins, deprecated identifiers',
      '',
      'LAYER 2 — SDK / package references:',
      '- Package/module names (e.g. "Microsoft.Azure.Management.Sql")',
      '- NuGet/npm/pip package names (e.g. "azure-mgmt-sql")',
      '- Import statements or using directives',
      '',
      'LAYER 3 — Infrastructure-as-Code (BROAD searches):',
      '- Terraform provider blocks: provider "azurerm" (this catches ALL Azure Terraform usage)',
      '- Terraform resource types: azurerm_sql_database, azurerm_mssql_database',
      '- ARM template / Bicep resource types: Microsoft.Sql/servers',
      '- Pulumi, CloudFormation, or other IaC references',
      '',
      'LAYER 4 — Configuration and connection strings:',
      '- Connection string patterns (e.g. "Server=tcp:" for SQL)',
      '- Environment variable names, .env file patterns',
      '- Config file keys (.json, .yaml, .config)',
      '',
      'IMPORTANT: Include at least 2-3 BROAD queries (e.g. just "azurerm" or "provider azurerm")',
      'alongside specific ones. Broad queries catch things specific ones miss.',
      '',
      'CONTEXT:',
      searchContext.slice(0, 4000),
      '',
      'Return ONE search query per line. No numbering, no explanation, no markdown.',
      'Each line should be a short keyword or exact string — NOT a sentence.',
    ].join('\n'));

    console.error(`[ado.deepCodeSearch] Round 1: AI generated ${round1Queries.length} queries: ${round1Queries.map((q) => `"${q.slice(0, 50)}"`).join(', ')}`);

    // Execute round 1 queries
    for (const q of round1Queries) {
      if (fatalError) break;
      allQueries.push(q);
      const hits = await runQuery(q);
      allResults.push(...hits);
    }

    if (fatalError) {
      console.error(`[ado.deepCodeSearch] ABORTED after fatal error: ${fatalError}`);
      return { results: [], count: 0, queries: allQueries, rounds: 1, summary: fatalError };
    }

    console.error(`[ado.deepCodeSearch] After round 1: ${allResults.length} unique file(s) across ${round1Queries.length} queries`);

    // ROUND 2+: Review findings and generate follow-up queries
    for (let round = 2; round <= maxRounds; round++) {
      const foundSummary = allResults.length > 0
        ? `Files found so far:\n${allResults.slice(0, 30).map((r) => `- ${r.filePath} (${r.repository}) [query: "${r.query}"]`).join('\n')}`
        : 'No files found yet.';

      console.error(`[ado.deepCodeSearch] Round ${round}: reviewing findings and generating follow-up queries...`);

      const noResultsYet = allResults.length === 0;
      const followUpQueries = await generateQueries([
        'You are reviewing code search results and generating follow-up queries.',
        'We are searching Azure DevOps for code related to this research context:',
        '',
        searchContext.slice(0, 2000),
        '',
        `Queries already tried: ${allQueries.map((q) => `"${q}"`).join(', ')}`,
        '',
        foundSummary,
        '',
        noResultsYet
          ? [
            'IMPORTANT: All previous queries returned ZERO results. This means the queries were too specific.',
            'Try MUCH BROADER searches:',
            '- Single common keywords (e.g. just "azurerm", "terraform", "SqlConnection", "sql")',
            '- Provider/framework names without version specifics',
            '- Broad infrastructure patterns (e.g. "provider", "connection_string", "Server=tcp")',
            '- File extension searches (e.g. "*.tf" patterns, ".bicep")',
            '',
          ].join('\n')
          : '',
        'Generate 3-5 NEW search queries we have NOT tried yet.',
        'Think about:',
        '- Different naming conventions (camelCase vs snake_case vs PascalCase)',
        '- Related but different APIs or packages',
        '- Configuration files (.json, .yaml, .config, .tf, .bicep)',
        '- Connection strings or environment variable names',
        '- Broader single-keyword queries that cast a wider net',
        '',
        'Return ONE search query per line. No numbering, no explanation, no markdown.',
        'If you think we have exhausted all reasonable queries, return "DONE" on a single line.',
      ].join('\n'));

      // Check for DONE signal
      if (followUpQueries.length === 0 || (followUpQueries.length === 1 && followUpQueries[0].toUpperCase() === 'DONE')) {
        console.error(`[ado.deepCodeSearch] Round ${round}: AI signaled DONE — no more queries needed`);
        break;
      }

      console.error(`[ado.deepCodeSearch] Round ${round}: AI generated ${followUpQueries.length} follow-up queries: ${followUpQueries.map((q) => `"${q.slice(0, 50)}"`).join(', ')}`);

      for (const q of followUpQueries) {
        if (fatalError) break;
        if (allQueries.includes(q)) continue; // skip duplicates
        allQueries.push(q);
        const hits = await runQuery(q);
        allResults.push(...hits);
      }

      if (fatalError) {
        console.error(`[ado.deepCodeSearch] ABORTED after fatal error: ${fatalError}`);
        return { results: [], count: 0, queries: allQueries, rounds: round, summary: fatalError };
      }

      console.error(`[ado.deepCodeSearch] After round ${round}: ${allResults.length} unique file(s) across ${allQueries.length} queries`);
    }

    // Build summary grouped by repository, with markdown links and clear labels
    const byRepo = new Map<string, CodeHit[]>();
    for (const r of allResults) {
      // Group key: "project/repo" when project is known, otherwise just "repo"
      const groupKey = r.project ? `${r.project}/${r.repository}` : r.repository;
      const existing = byRepo.get(groupKey) || [];
      existing.push(r);
      byRepo.set(groupKey, existing);
    }

    let summary: string;
    if (allResults.length > 0) {
      const parts: string[] = [];
      for (const [, hits] of byRepo.entries()) {
        const first = hits[0];
        const repoLabel = first.project
          ? `Repository: **${first.repository}** (ADO Project: ${first.project})`
          : `Repository: **${first.repository}**`;
        parts.push(`## ${repoLabel} — ${hits.length} file(s)`);
        for (const h of hits) {
          parts.push(`- [${h.filePath}](${h.url}) (matched query: "${h.query}")`);
        }
      }
      summary = parts.join('\n');
    } else {
      summary = `No code matches found after ${allQueries.length} queries across ${maxRounds} round(s). Queries tried: ${allQueries.map((q) => `"${q}"`).join(', ')}`;
    }

    console.error(`[ado.deepCodeSearch] COMPLETE: ${allResults.length} unique files, ${allQueries.length} queries, ${maxRounds} rounds`);
    return { results: allResults, count: allResults.length, queries: allQueries, rounds: maxRounds, summary };
  },

  // ---------------------------------------------------------------------------
  // confluence.search — search Confluence with auto-retry via AI refinement
  // ---------------------------------------------------------------------------
  'confluence.search': async (ctx) => {
    const configPath = resolveConfigPath(ctx.runContext.cwd, String(ctx.resolvedConfig.configPath || ''));
    let query = String(ctx.resolvedConfig.query || '').trim();
    const spaceKey = String(ctx.resolvedConfig.spaceKey || '').trim();
    const maxResults = Math.min(50, Math.max(1, Number(ctx.resolvedConfig.maxResults || 15)));
    const maxRetries = Math.max(0, Math.min(5, Number(ctx.resolvedConfig.maxRetries ?? 2)));
    const searchContext = String(ctx.resolvedConfig.searchContext || '').trim();
    const retryModel = normalizeModel(ctx.resolvedConfig.model || 'haiku');

    console.error(`[confluence.search] configPath="${configPath}" query="${query.slice(0, 100)}" spaceKey="${spaceKey}" maxResults=${maxResults} maxRetries=${maxRetries}`);

    if (!query && searchContext) {
      console.error('[confluence.search] query is empty but searchContext available — generating initial query via AI');
      const generated = await aiGenerateInitialQuery(ctx.runContext.cwd, searchContext, 'confluence', retryModel);
      if (generated) {
        query = generated;
        console.error(`[confluence.search] AI generated initial query: "${query.slice(0, 100)}"`);
      }
    }
    if (!query) {
      console.error('[confluence.search] SKIP — query is empty and no searchContext to generate from');
      return { results: [], count: 0, queries: [], summary: 'No search query provided and no research context to generate one.' };
    }

    let jiraConfig: JiraConfig;
    try {
      jiraConfig = loadJiraConfig(configPath);
      console.error(`[confluence.search] Jira config loaded: baseUrl="${jiraConfig.baseUrl}" email="${jiraConfig.email}"`);
    } catch (cfgErr: unknown) {
      const cfgMsg = cfgErr instanceof Error ? cfgErr.message : String(cfgErr);
      console.error(`[confluence.search] SKIP — config load failed: ${cfgMsg}`);
      return { results: [], count: 0, queries: [query], summary: 'Jira/Atlassian config not found or invalid. Confluence search requires the same config as Jira.' };
    }

    // Derive Confluence base from Jira base — Atlassian Cloud uses the same domain
    const atlassianBase = jiraConfig.baseUrl.replace(/\/+$/, '');
    const auth = Buffer.from(`${jiraConfig.email}:${jiraConfig.apiToken}`).toString('base64');
    const caCert = jiraConfig.caCertPem;
    if (caCert) console.error('[confluence.search] CA cert loaded for SSL');
    const queriesTried: string[] = [];
    const allResults: Array<{ title: string; spaceKey: string; excerpt: string; url: string }> = [];

    let currentQuery = query;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      queriesTried.push(currentQuery);
      console.error(`[confluence.search] attempt ${attempt + 1}/${maxRetries + 1}: query="${currentQuery}"`);
      dbg('confluence.search', `attempt ${attempt + 1}: "${currentQuery}"`);

      try {
        let cql = `text ~ "${currentQuery.replace(/"/g, '\\"')}"`;
        if (spaceKey) cql += ` AND space = "${spaceKey}"`;
        cql += ' ORDER BY lastModified DESC';

        const searchUrl = new URL(`${atlassianBase}/wiki/rest/api/content/search`);
        searchUrl.searchParams.set('cql', cql);
        searchUrl.searchParams.set('limit', String(maxResults));
        searchUrl.searchParams.set('expand', 'body.view');

        const response = await httpJsonRequest<{
          results?: Array<{
            title?: string;
            _links?: { webui?: string };
            space?: { key?: string };
            body?: { view?: { value?: string } };
            excerpt?: string;
          }>;
        }>(searchUrl, {
          method: 'GET',
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
            'User-Agent': 'claude-flow-workflow-studio/1.0',
          },
          ca: caCert,
        });

        const pages = response.results || [];
        console.error(`[confluence.search] API returned ${pages.length} page(s)`);
        for (const page of pages) {
          const title = page.title || '(untitled)';
          const space = page.space?.key || spaceKey || '?';
          const webUrl = page._links?.webui
            ? `${atlassianBase}/wiki${page._links.webui}`
            : '';
          // Extract a text excerpt from the body HTML, or use the provided excerpt
          let excerpt = page.excerpt || '';
          if (!excerpt && page.body?.view?.value) {
            excerpt = htmlToPlainText(page.body.view.value).slice(0, 500);
          }
          allResults.push({ title, spaceKey: space, excerpt, url: webUrl });
        }

        if (allResults.length > 0) {
          console.error(`[confluence.search] found ${allResults.length} total result(s), stopping retries`);
          break;
        }
        console.error('[confluence.search] 0 results from API, will retry if attempts remain');
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[confluence.search] API ERROR: ${errMsg}`);
        dbg('confluence.search', `search error: ${errMsg}`);
      }

      // No results — ask AI for a refined query
      if (attempt < maxRetries && allResults.length === 0) {
        try {
          const refinedQuery = await aiRefineSearchQuery(ctx.runContext.cwd, currentQuery, searchContext, retryModel);
          if (refinedQuery && refinedQuery !== currentQuery) {
            currentQuery = refinedQuery;
          } else {
            break;
          }
        } catch {
          break;
        }
      }
    }

    const summary = allResults.length > 0
      ? allResults.map((r) => `- [${r.title}] (${r.spaceKey}) — ${r.excerpt.slice(0, 200)}`).join('\n')
      : `No Confluence pages found after ${queriesTried.length} attempt(s). Queries tried: ${queriesTried.map((q) => `"${q}"`).join(', ')}`;

    return { results: allResults, count: allResults.length, queries: queriesTried, summary };
  },

  'ai.interactiveChat': async (ctx) => {
    const userSystemPrompt = String(ctx.resolvedConfig.systemPrompt || '').trim();
    const userGreeting = String(ctx.resolvedConfig.greeting || '').trim();
    const maxTurns = Math.max(1, Math.min(50, Number(ctx.resolvedConfig.maxTurns || 20)));
    const model = normalizeModel(ctx.resolvedConfig.model);
    const onProgress = (ctx as any)._onProgress as WorkflowProgressCallback | undefined;
    const signal = (ctx as any)._signal as AbortSignal | undefined;

    // --- Topology-aware context ---
    // Inspect graph edges to find direct upstream and downstream node types
    const edges = ctx.graph.edges || [];
    const upstreamIds = edges.filter((e) => e.to === ctx.node.id).map((e) => e.from);
    const downstreamIds = edges.filter((e) => e.from === ctx.node.id).map((e) => e.to);
    const nodeById = (id: string) => ctx.graph.nodes.find((n) => n.id === id);

    const upstreamNodes = upstreamIds.map(nodeById).filter(Boolean) as WorkflowNode[];
    const downstreamNodes = downstreamIds.map(nodeById).filter(Boolean) as WorkflowNode[];

    const upstreamTypes = upstreamNodes.map((n) => n.type);
    const downstreamTypes = downstreamNodes.map((n) => n.type);

    // --- Node type metadata ---
    // Defines primary output field, whether the output is refinable, and descriptions for the chat UI.
    // `primaryField` is the field the chat node extracts, shows to the user, and mutates on apply.
    // `refinable` means it makes sense to refine this node's output via chat (text/content nodes).
    const nodeTypeMeta: Record<string, {
      primaryField: string;
      refinable: boolean;
      verb: string;
      outputDesc: string;
      reviewFocus: string;
    }> = {
      'ai.runPrompt':                 { primaryField: 'text',      refinable: true,  verb: 'generated AI content',          outputDesc: 'AI-generated text',                     reviewFocus: 'accuracy, completeness, and relevance of the generated content' },
      'ai.structured':                { primaryField: 'text',      refinable: true,  verb: 'generated structured data',     outputDesc: 'structured AI output',                  reviewFocus: 'data structure correctness and completeness' },
      'ai.interactiveChat':           { primaryField: 'text',      refinable: false, verb: 'ran an interactive chat',       outputDesc: 'chat transcript and refined output',    reviewFocus: 'chat decisions and refined content' },
      'transform.template':           { primaryField: 'content',   refinable: true,  verb: 'rendered a template',           outputDesc: 'rendered template text',                reviewFocus: 'template output correctness and formatting' },
      'io.readFile':                  { primaryField: 'content',   refinable: true,  verb: 'read a file',                   outputDesc: 'file content',                          reviewFocus: 'file content relevance and completeness' },
      'io.writeFile':                 { primaryField: 'path',      refinable: false, verb: 'will write output to file',     outputDesc: 'file output',                           reviewFocus: 'output format and content' },
      'spec.input':                   { primaryField: 'specText',  refinable: true,  verb: 'captured a specification',      outputDesc: 'specification text',                    reviewFocus: 'requirements coverage and clarity' },
      'image.visionExtract':          { primaryField: 'analysis',  refinable: true,  verb: 'extracted content from images',  outputDesc: 'vision/OCR output',                    reviewFocus: 'extraction accuracy and completeness' },
      'jira.fetchIssue':              { primaryField: 'description', refinable: false, verb: 'fetched a Jira issue',        outputDesc: 'Jira issue details',                    reviewFocus: 'requirements and acceptance criteria from the ticket' },
      'jira.searchJql':               { primaryField: 'issues',    refinable: false, verb: 'searched Jira',                 outputDesc: 'Jira search results',                   reviewFocus: 'search result relevance' },
      'jira.createIssues':            { primaryField: 'created',   refinable: false, verb: 'created Jira tickets',          outputDesc: 'Jira ticket drafts with descriptions',  reviewFocus: 'ticket scope, descriptions, code changes, and acceptance criteria' },
      'jira.addComment':              { primaryField: 'issueKey',  refinable: false, verb: 'will add a Jira comment',       outputDesc: 'comment text',                          reviewFocus: 'comment content and formatting' },
      'jira.updateIssue':             { primaryField: 'issueKey',  refinable: false, verb: 'will update or comment on a Jira issue', outputDesc: 'updated issue fields or comment', reviewFocus: 'updated summary and description accuracy' },
      'jira.collectImageRefs':        { primaryField: 'refs',      refinable: false, verb: 'collected image references',    outputDesc: 'image URLs',                            reviewFocus: 'image reference completeness' },
      'azuredevops.readRepoContext':   { primaryField: 'summary',   refinable: true,  verb: 'read repository context',      outputDesc: 'repository file structure and content',  reviewFocus: 'relevant files, patterns, and dependencies' },
      'azuredevops.createPullRequest': { primaryField: 'prUrl',     refinable: false, verb: 'will create a pull request',   outputDesc: 'code changes for a PR',                  reviewFocus: 'code quality, file changes, branch naming, and PR scope' },
      'web.fetchUrl':                  { primaryField: 'content',   refinable: false, verb: 'fetched web pages',            outputDesc: 'web page content',                       reviewFocus: 'relevance of extracted content' },
      'ado.codeSearch':                { primaryField: 'summary',   refinable: false, verb: 'searched ADO code',            outputDesc: 'code search results',                    reviewFocus: 'match relevance and completeness' },
      'ado.deepCodeSearch':            { primaryField: 'summary',   refinable: false, verb: 'deep-searched ADO code',      outputDesc: 'multi-round code search results',        reviewFocus: 'search coverage and match relevance across repos' },
      'confluence.search':             { primaryField: 'summary',   refinable: false, verb: 'searched Confluence',          outputDesc: 'Confluence page matches',                reviewFocus: 'page relevance and completeness' },
      'slack.sendMessage':             { primaryField: 'sent',      refinable: false, verb: 'sent a Slack message',         outputDesc: 'Slack message status',                   reviewFocus: 'message content and delivery' },
      'slack.readChannel':             { primaryField: 'content',   refinable: false, verb: 'read Slack channel messages',  outputDesc: 'Slack channel messages',                 reviewFocus: 'message relevance and context' },
      'github.codeSearch':             { primaryField: 'summary',   refinable: false, verb: 'searched GitHub code',         outputDesc: 'GitHub code search results',             reviewFocus: 'search result relevance' },
      'conditional.gate':              { primaryField: 'text',      refinable: false, verb: 'evaluated a condition',        outputDesc: 'conditional output',                     reviewFocus: 'condition evaluation correctness' },
      'transform.jsonExtract':         { primaryField: 'text',      refinable: false, verb: 'extracted JSON fields',        outputDesc: 'extracted data',                         reviewFocus: 'extraction accuracy' },
      'notification.email':            { primaryField: 'sent',      refinable: false, verb: 'sent an email notification',   outputDesc: 'email delivery status',                  reviewFocus: 'email content and recipients' },
    };

    // --- Extract the primary upstream content ---
    // Uses the primaryField from nodeTypeMeta to find the right field for each upstream node type.
    let primaryUpstreamText = '';
    let primaryUpstreamNodeId = '';
    let primaryUpstreamField = '';
    for (const upId of upstreamIds) {
      const upResult = ctx.previousResults[upId];
      if (!upResult?.success || !upResult.output || typeof upResult.output !== 'object') continue;
      const meta = nodeTypeMeta[upResult.nodeType];
      const field = meta?.primaryField || 'text';
      const val = (upResult.output as Record<string, unknown>)[field];
      if (val != null) {
        const asStr = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
        if (asStr.trim()) {
          primaryUpstreamText = asStr;
          primaryUpstreamNodeId = upId;
          primaryUpstreamField = field;
          break;
        }
      }
    }
    // Fallback: try all previous results, preferring refinable nodes
    if (!primaryUpstreamText) {
      for (const [nodeId, result] of Object.entries(ctx.previousResults)) {
        if (!result.success || !result.output || typeof result.output !== 'object') continue;
        const meta = nodeTypeMeta[result.nodeType];
        if (meta && !meta.refinable) continue; // skip non-refinable in fallback
        const field = meta?.primaryField || 'text';
        const val = (result.output as Record<string, unknown>)[field];
        if (val != null) {
          const asStr = typeof val === 'string' ? val : JSON.stringify(val, null, 2);
          if (asStr.trim()) {
            primaryUpstreamText = asStr;
            primaryUpstreamNodeId = nodeId;
            primaryUpstreamField = field;
          }
        }
      }
    }

    // Build a topology-aware greeting if user didn't provide a custom one
    let autoGreeting = '';
    let autoSystemPrompt = '';

    // Determine if the primary upstream is refinable
    const primaryUpstreamMeta = primaryUpstreamNodeId
      ? nodeTypeMeta[ctx.previousResults[primaryUpstreamNodeId]?.nodeType]
      : undefined;
    const isRefinable = primaryUpstreamMeta?.refinable !== false && !!primaryUpstreamText;

    if (upstreamTypes.length > 0 || downstreamTypes.length > 0) {
      // Describe what just happened (upstream)
      const upstreamDescParts: string[] = [];
      for (const n of upstreamNodes) {
        const meta = nodeTypeMeta[n.type];
        upstreamDescParts.push(meta ? meta.verb : `completed "${n.id}"`);
      }

      // Describe what's coming next (downstream)
      const downstreamDescParts: string[] = [];
      const reviewFocusParts: string[] = [];
      for (const n of downstreamNodes) {
        const meta = nodeTypeMeta[n.type];
        if (meta) {
          downstreamDescParts.push(meta.outputDesc);
          reviewFocusParts.push(meta.reviewFocus);
        } else {
          downstreamDescParts.push(`"${n.id}" (${n.type})`);
        }
      }

      const upstreamSummary = upstreamDescParts.length > 0
        ? `The previous step ${upstreamDescParts.join(' and ')}.`
        : '';
      const nextStepDesc = downstreamDescParts.length > 0
        ? `This output will be used by the next step (${downstreamDescParts[0]}).`
        : '';

      if (isRefinable) {
        // Build an actionable greeting for refinable content
        autoGreeting = [
          upstreamSummary,
          'The output is shown above.',
          nextStepDesc,
          '',
          'You can:',
          '  - Click **Accept & Continue** to pass the content through as-is',
          '  - Or type a message below to request changes — after the AI responds, you can **Use Refined Content** or **Revert to Original**',
        ].filter(Boolean).join('\n');
      } else {
        // Non-refinable: read-only context, user can still ask questions
        autoGreeting = [
          upstreamSummary,
          nextStepDesc,
          '',
          'This output is read-only. You can ask questions about it in the chat, then click **Accept & Continue** to proceed.',
        ].filter(Boolean).join('\n');
      }

      // Build the system prompt with review focus
      const focusItems = reviewFocusParts.length > 0
        ? `\n\nYour review should focus on: ${reviewFocusParts.join('; ')}.`
        : '';
      autoSystemPrompt = `You are an interactive review assistant in a workflow automation tool. The user is reviewing output from a previous step before it is passed downstream.${isRefinable ? ' Help them refine the content based on their requests. When the user asks for changes, describe specifically what you would modify.' : ' This output is not directly modifiable, but you can answer questions about it.'}${focusItems}\n\nBe specific — reference file names, ticket keys, code patterns, or data from the upstream outputs. Keep the conversation focused and actionable.`;
    }

    // Use user-provided values if set, otherwise use auto-generated ones
    const systemPrompt = userSystemPrompt || autoSystemPrompt || 'You are a helpful assistant gathering clarifying information.';
    const greeting = userGreeting || autoGreeting || 'Hello! I have some clarifying questions before we proceed.';

    // Build context from ALL previous node results so the AI has full awareness
    let upstreamContext = '';
    for (const [nodeId, result] of Object.entries(ctx.previousResults)) {
      if (!result.success || !result.output) continue;
      const out = result.output;
      if (typeof out === 'object' && out !== null && 'text' in out && typeof (out as any).text === 'string') {
        const text = (out as any).text as string;
        if (text.trim()) {
          upstreamContext += `\n--- Output from "${nodeId}" (${result.nodeType}) ---\n${text.slice(0, 8000)}\n`;
        }
      } else {
        const serialized = JSON.stringify(out, null, 2);
        if (serialized.length > 10) {
          upstreamContext += `\n--- Output from "${nodeId}" (${result.nodeType}) ---\n${serialized.slice(0, 4000)}\n`;
        }
      }
    }

    const enrichedSystemPrompt = upstreamContext
      ? `${systemPrompt}\n\nYou have access to the following workflow context from previous steps:${upstreamContext}`
      : systemPrompt;

    const sessionId = `chat-${ctx.node.id}-${Date.now()}`;
    const messages: ChatMessage[] = [
      { role: 'assistant', content: greeting, timestamp: new Date().toISOString() },
    ];

    // Block the executor until the user clicks "Apply Changes" or "Discard Changes"
    const resolution = await new Promise<ChatResolution>((resolveChat) => {
      const session: ChatSessionState = {
        sessionId,
        nodeId: ctx.node.id,
        messages,
        resolve: resolveChat,
        systemPrompt: enrichedSystemPrompt,
        maxTurns,
        turnCount: 0,
        onProgress,
      };
      activeChatSessions.set(sessionId, session);

      if (signal) {
        signal.addEventListener('abort', () => {
          if (activeChatSessions.has(sessionId)) {
            activeChatSessions.delete(sessionId);
            resolveChat({ transcript: messages, action: 'discard' });
          }
        }, { once: true });
      }

      onProgress?.({
        type: 'node-pause',
        nodeId: ctx.node.id,
        nodeType: ctx.node.type,
        chatSessionId: sessionId,
        chatMessage: messages[0],
        upstreamContent: primaryUpstreamText.slice(0, 60000),
      });
    });

    activeChatSessions.delete(sessionId);

    const transcript = resolution.transcript;
    const transcriptText = transcript
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n\n');

    const originalText = primaryUpstreamText;
    let refinedText = originalText;

    const userMessages = transcript.filter((m) => m.role === 'user');

    if (resolution.action === 'apply' && originalText && userMessages.length > 0) {
      // Run AI refinement pass: apply chat instructions to the original content
      console.log(`[ai.interactiveChat] Running refinement pass — action=${resolution.action}, userMsgs=${userMessages.length}, originalLen=${originalText.length}`);
      onProgress?.({
        type: 'chat-message',
        nodeId: ctx.node.id,
        chatSessionId: sessionId,
        chatMessage: { role: 'system', content: 'Applying changes...', timestamp: new Date().toISOString() },
      });
      try {
        const refineExecutor = new HeadlessWorkerExecutor(ctx.runContext.cwd, {
          maxConcurrent: 1,
          defaultTimeoutMs: 240000,
        });
        activeExecutor = refineExecutor;
        const refineResult = await refineExecutor.execute('document', {
          promptTemplate: [
            'You are a precise content editor. Apply the user\'s requested changes to the original content below.',
            'Return ONLY the complete updated content — no explanations, no preamble, no summaries.',
            'If the user asked for code changes, return the full updated code.',
            '',
            'CRITICAL — PRESERVE FORMAT: The original content may use a specific format with file path headers like "File: path/to/file.ext" or "File 1: path/to/file.ext" followed by code. You MUST preserve this exact format structure including the file path headers. The downstream system parses these headers to know which files to update.',
            '',
            'CRITICAL — NO TRUNCATION: Output the COMPLETE content. NEVER abbreviate, omit, or truncate. NEVER use placeholder comments like "// ... rest of implementation" or "// existing code remains". Every line of every file must be present.',
            '',
            '--- ORIGINAL CONTENT ---',
            originalText.slice(0, 60000),
            '',
            '--- USER REQUESTED CHANGES ---',
            userMessages.map((m) => m.content).join('\n'),
            '',
            '--- OUTPUT THE COMPLETE UPDATED CONTENT BELOW ---',
          ].join('\n'),
          model,
          sandbox: 'permissive',
          outputFormat: 'text',
          contextPatterns: [],
          timeoutMs: 240000,
        });
        activeExecutor = null;
        if (refineResult.success && refineResult.output) {
          const refined = String(refineResult.output).trim();
          console.log(`[ai.interactiveChat] Refinement succeeded — refinedLen=${refined.length}`);
          refinedText = refined;
        } else {
          console.log(`[ai.interactiveChat] Refinement returned no output — success=${refineResult.success}, error=${refineResult.error}`);
        }
      } catch (err) {
        activeExecutor = null;
        console.log(`[ai.interactiveChat] Refinement error:`, err);
        // On error, fall back to original text
      }
    } else if (resolution.action === 'apply') {
      // User clicked Apply but didn't chat — pass original through unchanged
      console.log(`[ai.interactiveChat] Apply with no user messages — passing original through`);
    } else {
      console.log(`[ai.interactiveChat] Discard — passing original through unchanged`);
    }

    let summary = transcriptText.slice(0, 500);
    if (transcript.filter((m) => m.role === 'user').length >= 2) {
      try {
        const summaryExecutor = new HeadlessWorkerExecutor(ctx.runContext.cwd, {
          maxConcurrent: 1,
          defaultTimeoutMs: 60000,
        });
        activeExecutor = summaryExecutor;
        const summaryResult = await summaryExecutor.execute('document', {
          promptTemplate: `Summarize the key decisions and clarifications from this chat transcript into 2-3 concise bullet points:\n\n${transcriptText.slice(0, 4000)}`,
          model,
          sandbox: 'permissive',
          outputFormat: 'text',
          contextPatterns: [],
          timeoutMs: 60000,
        });
        activeExecutor = null;
        if (summaryResult.success && summaryResult.output) {
          summary = String(summaryResult.output).trim();
        }
      } catch {
        activeExecutor = null;
      }
    }

    // --- Transparent upstream mutation ---
    // When changes are applied, update the upstream node's primary output field so any
    // downstream node referencing e.g. {{generateTickets.text}} or {{repoContext.summary}}
    // automatically gets the refined version. No rewiring needed.
    if (refinedText !== originalText && primaryUpstreamNodeId && primaryUpstreamField) {
      const upResult = ctx.previousResults[primaryUpstreamNodeId];
      if (upResult?.output && typeof upResult.output === 'object') {
        (upResult.output as Record<string, unknown>)[primaryUpstreamField] = refinedText;
        console.log(`[ai.interactiveChat] Updated upstream "${primaryUpstreamNodeId}".${primaryUpstreamField} with refined content (${refinedText.length} chars)`);
      }
    }

    return {
      transcript,
      transcriptText,
      turnCount: transcript.filter((m) => m.role === 'user').length,
      summary,
      action: resolution.action,
      refinedText,
      originalText,
      text: refinedText, // alias so downstream {{refineChat.text}} works like other AI nodes
      model: String(model),
    };
  },

  // ── Slack ──────────────────────────────────────────────────────────────────

  'slack.sendMessage': async (ctx) => {
    const webhookUrl = String(ctx.resolvedConfig.webhookUrl || '').trim();
    if (!webhookUrl) return { success: false, error: 'Webhook URL is required.' };

    const message = String(ctx.resolvedConfig.message || '').trim();
    if (!message) return { success: false, error: 'Message body is required.' };

    const payload: Record<string, unknown> = { text: message };
    const channel = String(ctx.resolvedConfig.channel || '').trim();
    if (channel) payload.channel = channel;
    const username = String(ctx.resolvedConfig.username || '').trim();
    if (username) payload.username = username;
    const iconEmoji = String(ctx.resolvedConfig.iconEmoji || '').trim();
    if (iconEmoji) payload.icon_emoji = iconEmoji;

    const url = new URL(webhookUrl);
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const body = JSON.stringify(payload);

    const result = await new Promise<{ ok: boolean; status: number; body: string }>((res) => {
      const req = requester(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        resp.on('end', () => res({ ok: (resp.statusCode || 0) >= 200 && (resp.statusCode || 0) < 300, status: resp.statusCode || 0, body: Buffer.concat(chunks).toString('utf-8') }));
      });
      req.on('error', (err) => res({ ok: false, status: 0, body: err.message }));
      req.setTimeout(15000, () => { req.destroy(); res({ ok: false, status: 0, body: 'Timeout' }); });
      req.write(body);
      req.end();
    });

    if (!result.ok) throw new Error(`Slack webhook failed (HTTP ${result.status}): ${result.body}`);
    return { sent: true, channel: channel || '(webhook default)', messageLength: message.length };
  },

  'slack.readChannel': async (ctx) => {
    const botToken = String(ctx.resolvedConfig.botToken || '').trim();
    if (!botToken) return { success: false, error: 'Bot token is required.' };

    const channelId = String(ctx.resolvedConfig.channelId || '').trim();
    if (!channelId) return { success: false, error: 'Channel ID is required.' };

    const limit = Math.min(Math.max(parseInt(String(ctx.resolvedConfig.limit || '20'), 10) || 20, 1), 100);

    const url = new URL('https://slack.com/api/conversations.history');
    url.searchParams.set('channel', channelId);
    url.searchParams.set('limit', String(limit));

    const result = await new Promise<{ ok: boolean; body: string }>((res) => {
      const req = httpsRequest(url, { method: 'GET', headers: { Authorization: `Bearer ${botToken}` } }, (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        resp.on('end', () => res({ ok: (resp.statusCode || 0) >= 200 && (resp.statusCode || 0) < 300, body: Buffer.concat(chunks).toString('utf-8') }));
      });
      req.on('error', (err) => res({ ok: false, body: err.message }));
      req.setTimeout(15000, () => { req.destroy(); res({ ok: false, body: 'Timeout' }); });
      req.end();
    });

    if (!result.ok) throw new Error(`Slack API error: ${result.body}`);
    const parsed = JSON.parse(result.body);
    if (!parsed.ok) throw new Error(`Slack API error: ${parsed.error || 'unknown'}`);

    const messages = (parsed.messages || []).map((m: any) => ({
      user: m.user || 'unknown',
      text: m.text || '',
      ts: m.ts,
    }));

    const content = messages.map((m: any) => `[${m.user}] ${m.text}`).join('\n');
    return { messages, count: messages.length, content, channelId };
  },

  // ── GitHub ─────────────────────────────────────────────────────────────────

  'github.codeSearch': async (ctx) => {
    const query = String(ctx.resolvedConfig.query || '').trim();
    const tokenEnvVar = String(ctx.resolvedConfig.tokenEnvVar || 'GITHUB_TOKEN').trim();
    const maxResults = parseInt(String(ctx.resolvedConfig.maxResults || '30'), 10) || 30;
    const token = process.env[tokenEnvVar] || '';

    if (!query) return { results: [], count: 0, summary: 'No search query provided.' };

    const searchUrl = new URL('https://api.github.com/search/code');
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('per_page', String(Math.min(maxResults, 100)));

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'claude-flow-workflow-studio',
    };
    if (token) headers.Authorization = `token ${token}`;

    const result = await new Promise<{ ok: boolean; status: number; body: string }>((res) => {
      const req = httpsRequest(searchUrl, { method: 'GET', headers }, (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        resp.on('end', () => res({ ok: (resp.statusCode || 0) >= 200 && (resp.statusCode || 0) < 300, status: resp.statusCode || 0, body: Buffer.concat(chunks).toString('utf-8') }));
      });
      req.on('error', (err) => res({ ok: false, status: 0, body: err.message }));
      req.setTimeout(30000, () => { req.destroy(); res({ ok: false, status: 0, body: 'Timeout' }); });
      req.end();
    });

    if (!result.ok) throw new Error(`GitHub API error (HTTP ${result.status}): ${result.body.slice(0, 300)}`);
    const parsed = JSON.parse(result.body);

    const items = (parsed.items || []).slice(0, maxResults).map((item: any) => ({
      path: item.path,
      repository: item.repository?.full_name || '',
      url: item.html_url || '',
      score: item.score,
    }));

    const grouped: Record<string, typeof items> = {};
    for (const item of items) {
      const repo = item.repository || 'unknown';
      if (!grouped[repo]) grouped[repo] = [];
      grouped[repo].push(item);
    }

    const summaryParts: string[] = [`## GitHub Code Search — ${items.length} result(s) for: \`${query}\`\n`];
    for (const [repo, hits] of Object.entries(grouped)) {
      summaryParts.push(`### Repository: **${repo}** — ${hits.length} file(s)`);
      for (const h of hits) {
        summaryParts.push(`- [${h.path}](${h.url})`);
      }
      summaryParts.push('');
    }

    return { results: items, count: items.length, query, summary: summaryParts.join('\n'), totalCount: parsed.total_count || 0 };
  },

  // ── Conditional / Transform ────────────────────────────────────────────────

  'conditional.gate': async (ctx) => {
    const field = ctx.resolvedConfig.field;
    const operator = String(ctx.resolvedConfig.operator || 'isNotEmpty').trim();
    const compareValue = String(ctx.resolvedConfig.value ?? '');
    const passThrough = ctx.resolvedConfig.passThrough;

    const fieldStr = field == null ? '' : String(field);
    const fieldNum = Number(fieldStr);

    let passes = false;
    switch (operator) {
      case 'equals': passes = fieldStr === compareValue; break;
      case 'notEquals': passes = fieldStr !== compareValue; break;
      case 'contains': passes = fieldStr.includes(compareValue); break;
      case 'notContains': passes = !fieldStr.includes(compareValue); break;
      case 'greaterThan': passes = !isNaN(fieldNum) && fieldNum > Number(compareValue); break;
      case 'lessThan': passes = !isNaN(fieldNum) && fieldNum < Number(compareValue); break;
      case 'isEmpty': passes = !fieldStr || fieldStr === '0' || fieldStr === 'null' || fieldStr === 'undefined'; break;
      case 'isNotEmpty': passes = !!fieldStr && fieldStr !== '0' && fieldStr !== 'null' && fieldStr !== 'undefined'; break;
      case 'matches': try { passes = new RegExp(compareValue).test(fieldStr); } catch { passes = false; } break;
      default: passes = !!fieldStr;
    }

    const output = passes ? (passThrough != null ? String(passThrough) : fieldStr) : '';
    return { passed: passes, operator, fieldValue: fieldStr, compareValue, output, text: output };
  },

  'transform.jsonExtract': async (ctx) => {
    const inputRaw = String(ctx.resolvedConfig.input || '').trim();
    const pathsRaw = String(ctx.resolvedConfig.paths || '').trim();
    const outputFormat = String(ctx.resolvedConfig.outputFormat || 'object').trim();

    if (!inputRaw) return { extracted: {}, text: '', error: 'No input provided.' };

    let parsed: unknown;
    try { parsed = JSON.parse(inputRaw); } catch { parsed = inputRaw; }

    const paths = pathsRaw.split(',').map((p) => p.trim()).filter(Boolean);
    const extracted: Record<string, unknown> = {};

    for (const dotPath of paths) {
      const segments = dotPath.replace(/\[(\d+)\]/g, '.$1').split('.');
      let current: unknown = parsed;
      for (const seg of segments) {
        if (current == null || typeof current !== 'object') { current = undefined; break; }
        current = (current as Record<string, unknown>)[seg];
      }
      extracted[dotPath] = current;
    }

    const textParts = Object.entries(extracted).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v ?? '(not found)')}`);
    return { extracted, text: outputFormat === 'text' ? textParts.join('\n') : JSON.stringify(extracted, null, 2), paths };
  },

  // ── Notification ───────────────────────────────────────────────────────────

  'notification.email': async (ctx) => {
    const to = String(ctx.resolvedConfig.to || '').trim();
    const subject = String(ctx.resolvedConfig.subject || '').trim();
    const body = String(ctx.resolvedConfig.body || '').trim();

    if (!to || !subject) return { sent: false, error: 'To and subject are required.' };

    const smtpHost = process.env[String(ctx.resolvedConfig.smtpHostEnvVar || 'SMTP_HOST')] || '';
    const smtpPort = parseInt(process.env[String(ctx.resolvedConfig.smtpPortEnvVar || 'SMTP_PORT')] || '587', 10);
    const smtpUser = process.env[String(ctx.resolvedConfig.smtpUserEnvVar || 'SMTP_USER')] || '';
    const smtpPass = process.env[String(ctx.resolvedConfig.smtpPassEnvVar || 'SMTP_PASS')] || '';
    const from = String(ctx.resolvedConfig.from || smtpUser || 'workflow-studio@localhost').trim();

    if (!smtpHost) {
      console.log(`[notification.email] SMTP not configured — would send to: ${to}, subject: "${subject}", body length: ${body.length}`);
      return { sent: false, dryRun: true, to, subject, bodyLength: body.length, reason: 'SMTP_HOST not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS environment variables.' };
    }

    // Use Node.js net + tls for basic SMTP
    const { createConnection } = await import('net');
    const { connect: tlsConnect } = await import('tls');

    const result = await new Promise<{ sent: boolean; response: string }>((resolveP) => {
      const timeout = setTimeout(() => resolveP({ sent: false, response: 'SMTP connection timeout' }), 30000);
      try {
        const sock = createConnection(smtpPort, smtpHost, () => {
          const lines: string[] = [];
          const send = (cmd: string) => { sock.write(cmd + '\r\n'); };
          let step = 0;
          sock.on('data', (data) => {
            const response = data.toString();
            lines.push(response);
            step++;
            if (step === 1) send(`EHLO localhost`);
            else if (step === 2 && smtpUser) send(`AUTH LOGIN`);
            else if (step === 2) send(`MAIL FROM:<${from}>`);
            else if (step === 3 && smtpUser) send(Buffer.from(smtpUser).toString('base64'));
            else if (step === 3) send(`RCPT TO:<${to.split(',')[0].trim()}>`);
            else if (step === 4 && smtpUser) send(Buffer.from(smtpPass).toString('base64'));
            else if (step === 4) send('DATA');
            else if (step === 5 && smtpUser) send(`MAIL FROM:<${from}>`);
            else if (step === 5) { send(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n${body}\r\n.`); }
            else if (step === 6 && smtpUser) send(`RCPT TO:<${to.split(',')[0].trim()}>`);
            else if (step === 7 && smtpUser) send('DATA');
            else if (step === 8 && smtpUser) { send(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\n\r\n${body}\r\n.`); }
            else if (response.startsWith('250 ') && step > 6) {
              send('QUIT');
              clearTimeout(timeout);
              resolveP({ sent: true, response: lines.join('') });
            }
          });
          sock.on('error', (err) => { clearTimeout(timeout); resolveP({ sent: false, response: err.message }); });
        });
        sock.on('error', (err) => { clearTimeout(timeout); resolveP({ sent: false, response: err.message }); });
      } catch (err: any) {
        clearTimeout(timeout);
        resolveP({ sent: false, response: err.message || String(err) });
      }
    });

    return { sent: result.sent, to, subject, bodyLength: body.length, smtpResponse: result.response.slice(0, 200) };
  },
};

export function getNodeExecutor(type: string): NodeExecutor | undefined {
  return executorRegistry[type];
}

export function listNodeTypes(): string[] {
  return Object.keys(executorRegistry).sort((a, b) => a.localeCompare(b));
}

/**
 * Handle an incoming chat message from the UI during an interactive chat session.
 * Called by the HTTP server when POST /api/run/chat arrives.
 */
export async function handleChatMessage(
  sessionId: string,
  userMessage: string,
  done: boolean,
  cwd: string,
  action?: 'apply' | 'discard',
): Promise<ChatMessage | null> {
  const session = activeChatSessions.get(sessionId);
  if (!session) return null;

  if (done) {
    // User clicked "Apply Changes" or "Discard Changes" — resolve with action
    activeChatSessions.delete(sessionId);
    session.resolve({ transcript: session.messages, action: action || 'discard' });
    return null;
  }

  // Add user message
  const userMsg: ChatMessage = {
    role: 'user',
    content: userMessage,
    timestamp: new Date().toISOString(),
  };
  session.messages.push(userMsg);
  session.turnCount++;

  // Check max turns
  if (session.turnCount >= session.maxTurns) {
    const sysMsg: ChatMessage = { role: 'system', content: 'Maximum turns reached. Chat session ending.', timestamp: new Date().toISOString() };
    session.messages.push(sysMsg);
    session.onProgress?.({ type: 'chat-message', nodeId: session.nodeId, chatSessionId: sessionId, chatMessage: sysMsg });
    activeChatSessions.delete(sessionId);
    session.resolve({ transcript: session.messages, action: 'apply' });
    return sysMsg;
  }

  // Generate AI response
  const conversationContext = session.messages
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');

  const prompt = `${session.systemPrompt}\n\n--- Conversation ---\n${conversationContext}\n\nassistant:`;

  const executor = new HeadlessWorkerExecutor(cwd, { maxConcurrent: 1, defaultTimeoutMs: 120000 });
  try {
    activeExecutor = executor;
    const result = await executor.execute('document', {
      promptTemplate: prompt,
      model: 'sonnet' as ModelType,
      sandbox: 'permissive',
      outputFormat: 'text',
      contextPatterns: [],
      timeoutMs: 120000,
    });
    activeExecutor = null;

    const responseText = String(result.output || 'I could not generate a response. Please try again.').trim();
    const assistantMsg: ChatMessage = { role: 'assistant', content: responseText, timestamp: new Date().toISOString() };
    session.messages.push(assistantMsg);

    // Send via SSE so the modal updates in real-time
    session.onProgress?.({ type: 'chat-message', nodeId: session.nodeId, chatSessionId: sessionId, chatMessage: assistantMsg });
    return assistantMsg;
  } catch {
    activeExecutor = null;
    const errorMsg: ChatMessage = { role: 'assistant', content: 'Sorry, there was an error generating a response. Please try again.', timestamp: new Date().toISOString() };
    session.messages.push(errorMsg);
    session.onProgress?.({ type: 'chat-message', nodeId: session.nodeId, chatSessionId: sessionId, chatMessage: errorMsg });
    return errorMsg;
  }
}

export async function executeWorkflowGraph(
  graph: WorkflowGraph,
  context: WorkflowExecutionContext,
  options?: WorkflowRunOptions
): Promise<WorkflowExecutionResult> {
  const startedAt = new Date();
  const levels = resolveExecutionLevels(graph);
  const order = levels.flat();
  const nodeResults: Record<string, NodeExecutionResult> = {};
  const errors: string[] = [];
  const onProgress = options?.onProgress;
  const signal = options?.signal;

  // Log execution plan with parallel levels
  const edgeMap = new Map<string, string[]>();
  for (const e of (graph.edges || [])) {
    if (!edgeMap.has(e.from)) edgeMap.set(e.from, []);
    edgeMap.get(e.from)!.push(e.to);
  }
  dbg('exec', `=== Workflow: ${graph.name || graph.id} ===`);
  dbg('exec', `Execution levels: ${levels.map((l, i) => `L${i}[${l.join(',')}]`).join(' → ')}`);
  for (const nid of order) {
    const n = graph.nodes.find((item) => item.id === nid);
    const downstream = edgeMap.get(nid) || [];
    dbg('exec', `  ${nid} (${n?.type}) → [${downstream.join(', ') || 'end'}]`);
  }

  // Optional: call pre-task hook for the overall workflow
  tryCallHook(context.cwd, 'pre-task', `--description "workflow:${graph.name || graph.id}"`);

  // Preflight: if the graph contains any AI nodes that use claude -p, verify auth upfront.
  const hasCliAiNodes = graph.nodes.some((n) => CLAUDE_CLI_NODE_TYPES.has(n.type));
  if (hasCliAiNodes) {
    onProgress?.({ type: 'node-start', nodeId: '__preflight', nodeType: 'ai.preflight' });
    try {
      await preflightAiCheck(context.cwd);
      dbg('exec', 'AI preflight check passed');
      onProgress?.({ type: 'node-complete', nodeId: '__preflight', nodeType: 'ai.preflight', result: { nodeId: '__preflight', nodeType: 'ai.preflight', success: true, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0 } });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`[AI Preflight] ${msg}`);
      onProgress?.({ type: 'node-error', nodeId: '__preflight', nodeType: 'ai.preflight', result: { nodeId: '__preflight', nodeType: 'ai.preflight', success: false, error: msg, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0 } });

      const finishedAt = new Date();
      return {
        graphId: graph.id,
        graphName: graph.name,
        success: false,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        order,
        nodeResults,
        errors,
      };
    }
  }

  // Preflight: check credentials for ADO / Jira / Confluence nodes before any node runs
  const credentialIssues = preflightCredentialCheck(graph, context);
  if (credentialIssues.length > 0) {
    const issueText = credentialIssues.join('\n\n');
    onProgress?.({
      type: 'node-error',
      nodeId: '__credentials',
      nodeType: 'preflight.credentials',
      result: {
        nodeId: '__credentials',
        nodeType: 'preflight.credentials',
        success: false,
        error: issueText,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
      },
    });
    errors.push(`[Credential Check] ${issueText}`);
    const finishedAt = new Date();
    return {
      graphId: graph.id,
      graphName: graph.name,
      success: false,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      order,
      nodeResults,
      errors,
    };
  }

  for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
    const level = levels[levelIdx];

    if (signal?.aborted) {
      errors.push(`Workflow aborted by user at level ${levelIdx}.`);
      break;
    }

    const isParallel = level.length > 1;
    if (isParallel) {
      dbg('exec', `\n=== Level ${levelIdx}: PARALLEL [${level.join(', ')}] ===`);
    }

    // Interactive node types that must run sequentially (they pause for user input)
    const interactiveTypes = new Set(['ai.interactiveChat']);

    // Split level into interactive (must be sequential) and non-interactive (can be parallel)
    const interactiveNodes: string[] = [];
    const parallelNodes: string[] = [];
    for (const nodeId of level) {
      const node = graph.nodes.find((item) => item.id === nodeId);
      if (node && interactiveTypes.has(node.type)) {
        interactiveNodes.push(nodeId);
      } else {
        parallelNodes.push(nodeId);
      }
    }

    // Execute non-interactive nodes in parallel
    if (parallelNodes.length > 0) {
      const parallelPromises = parallelNodes.map((nodeId) =>
        executeOneNode(nodeId, graph, nodeResults, context, onProgress, signal)
      );

      const results = await Promise.all(parallelPromises);

      for (const result of results) {
        nodeResults[result.nodeId] = result;
        if (result.success) {
          onProgress?.({ type: 'node-complete', nodeId: result.nodeId, nodeType: result.nodeType, result });
        } else {
          errors.push(`[${result.nodeId}] ${result.error || 'Unknown error'}`);
          onProgress?.({ type: 'node-error', nodeId: result.nodeId, nodeType: result.nodeType, result });
        }
      }

      // If any parallel node failed, stop the workflow
      if (results.some((r) => !r.success)) break;
    }

    // Execute interactive nodes sequentially (they need user input)
    for (const nodeId of interactiveNodes) {
      if (signal?.aborted) {
        errors.push(`[${nodeId}] Workflow aborted by user.`);
        break;
      }

      const result = await executeOneNode(nodeId, graph, nodeResults, context, onProgress, signal);
      nodeResults[result.nodeId] = result;

      if (result.success) {
        onProgress?.({ type: 'node-complete', nodeId: result.nodeId, nodeType: result.nodeType, result });
      } else {
        errors.push(`[${result.nodeId}] ${result.error || 'Unknown error'}`);
        onProgress?.({ type: 'node-error', nodeId: result.nodeId, nodeType: result.nodeType, result });
        break;
      }
    }

    if (errors.length > 0) break;
  }

  // Optional: call post-task hook
  const success = errors.length === 0;
  tryCallHook(context.cwd, 'post-task', `--task-id "workflow:${graph.id}" --success ${success}`);

  const finishedAt = new Date();

  const workflowResult: WorkflowExecutionResult = {
    graphId: graph.id,
    graphName: graph.name,
    success,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    order,
    nodeResults,
    errors,
  };

  onProgress?.({ type: 'workflow-complete', workflowResult: workflowResult });

  return workflowResult;
}

/**
 * Execute a single node and return its result.
 * Extracted to enable parallel execution via Promise.all.
 */
async function executeOneNode(
  nodeId: string,
  graph: WorkflowGraph,
  nodeResults: Record<string, NodeExecutionResult>,
  context: WorkflowExecutionContext,
  onProgress?: WorkflowProgressCallback,
  signal?: AbortSignal,
): Promise<NodeExecutionResult> {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) {
    return {
      nodeId,
      nodeType: 'unknown',
      success: false,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      error: `Node ${nodeId} not found in graph`,
    };
  }

  onProgress?.({ type: 'node-start', nodeId: node.id, nodeType: node.type });

  const started = Date.now();
  const startedIso = new Date(started).toISOString();

  dbg('exec', `\n--- [${node.id}] ${node.type} ---`);
  try {
    const resolvedConfig = resolveNodeValueObject(node.config || {}, nodeResults, context.variables || {}, graph.nodes);
    const resolvedInputs = resolveNodeValueObject(node.inputs || {}, nodeResults, context.variables || {}, graph.nodes);

    for (const [ck, cv] of Object.entries(resolvedConfig)) {
      const val = cv == null ? '(null)' : typeof cv === 'string' ? truncate(cv, 200) : typeof cv === 'object' ? `{${Object.keys(cv as object).slice(0, 5).join(',')}}` : String(cv);
      dbg('exec', `  config.${ck} = ${val}`);
    }

    const executor = getNodeExecutor(node.type);

    if (!executor) {
      throw new Error(`Unknown node type: ${node.type}`);
    }

    const execCtx: NodeExecutionContext & { _onProgress?: WorkflowProgressCallback; _signal?: AbortSignal } = {
      graph,
      node,
      resolvedConfig,
      resolvedInputs,
      previousResults: nodeResults,
      runContext: context,
    };
    if (onProgress) (execCtx as any)._onProgress = onProgress;
    if (signal) (execCtx as any)._signal = signal;

    const output = await executor(execCtx);

    const debugOutput = (output && typeof output === 'object' && !Array.isArray(output))
      ? { ...output as Record<string, unknown>, _resolvedConfig: sanitizeConfigForDebug(resolvedConfig) }
      : output;

    const finished = Date.now();
    const nodeResult: NodeExecutionResult = {
      nodeId: node.id,
      nodeType: node.type,
      success: true,
      startedAt: startedIso,
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      output: debugOutput,
    };

    dbg('exec', `  ✓ ${node.id} completed in ${nodeResult.durationMs}ms`);
    dbg('exec', `  output: ${summarizeOutput(output)}`);

    return nodeResult;
  } catch (error) {
    const finished = Date.now();
    const message = error instanceof Error ? error.message : String(error);
    dbg('exec', `  ✗ ${node.id} FAILED: ${truncate(message, 300)}`);

    return {
      nodeId: node.id,
      nodeType: node.type,
      success: false,
      startedAt: startedIso,
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      error: message,
    };
  }
}

/**
 * Hook call stub — standalone version has no external hook system.
 * Kept as a no-op so call sites don't need changing.
 */
function tryCallHook(_cwd: string | undefined, hook: string, _args: string): void {
  dbg('hooks', `hook ${hook} skipped (standalone — no external hook system)`);
}

export function resolveExecutionOrder(graph: WorkflowGraph): string[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();

  for (const node of graph.nodes) {
    incoming.set(node.id, new Set());
    outgoing.set(node.id, new Set());
  }

  for (const node of graph.nodes) {
    const refs = extractRefsFromNode(node);
    for (const ref of refs) {
      const sourceId = ref.split('.')[0];
      if (!sourceId || !nodesById.has(sourceId) || sourceId === node.id) continue;
      incoming.get(node.id)?.add(sourceId);
      outgoing.get(sourceId)?.add(node.id);
    }
  }

  for (const edge of graph.edges || []) {
    if (!edge?.from || !edge?.to) continue;
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue;
    if (edge.from === edge.to) continue;
    incoming.get(edge.to)?.add(edge.from);
    outgoing.get(edge.from)?.add(edge.to);
  }

  const queue: string[] = graph.nodes
    .filter((node) => (incoming.get(node.id)?.size || 0) === 0)
    .map((node) => node.id)
    .sort((a, b) => a.localeCompare(b));

  const sorted: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    sorted.push(current);

    const targets = Array.from(outgoing.get(current) || []);
    for (const target of targets) {
      const deps = incoming.get(target);
      if (!deps) continue;
      deps.delete(current);
      if (deps.size === 0 && !queue.includes(target)) {
        queue.push(target);
      }
    }

    queue.sort((a, b) => a.localeCompare(b));
  }

  if (sorted.length !== graph.nodes.length) {
    throw new Error('Workflow graph contains circular dependencies.');
  }

  return sorted;
}

/**
 * Group nodes into dependency levels for parallel execution.
 * Nodes at the same level have no dependencies on each other
 * and can safely run concurrently.
 */
export function resolveExecutionLevels(graph: WorkflowGraph): string[][] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const deps = new Map<string, Set<string>>();

  for (const node of graph.nodes) {
    deps.set(node.id, new Set());
  }

  // Build dependency set from refs
  for (const node of graph.nodes) {
    const refs = extractRefsFromNode(node);
    for (const ref of refs) {
      const sourceId = ref.split('.')[0];
      if (!sourceId || !nodesById.has(sourceId) || sourceId === node.id) continue;
      deps.get(node.id)?.add(sourceId);
    }
  }

  // Build dependency set from explicit edges
  for (const edge of graph.edges || []) {
    if (!edge?.from || !edge?.to) continue;
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) continue;
    if (edge.from === edge.to) continue;
    deps.get(edge.to)?.add(edge.from);
  }

  const levels: string[][] = [];
  const placed = new Set<string>();

  while (placed.size < graph.nodes.length) {
    const level: string[] = [];
    for (const node of graph.nodes) {
      if (placed.has(node.id)) continue;
      const nodeDeps = deps.get(node.id) || new Set();
      const allDepsMet = [...nodeDeps].every((d) => placed.has(d));
      if (allDepsMet) level.push(node.id);
    }
    if (level.length === 0) {
      throw new Error('Workflow graph contains circular dependencies.');
    }
    level.sort((a, b) => a.localeCompare(b));
    levels.push(level);
    for (const id of level) placed.add(id);
  }

  return levels;
}

function resolveNodeValueObject(
  input: Record<string, NodeValue>,
  nodeResults: Record<string, NodeExecutionResult>,
  variables: Record<string, NodeValue>,
  graphNodes?: WorkflowNode[]
): Record<string, NodeValue> {
  const result: Record<string, NodeValue> = {};

  for (const [key, value] of Object.entries(input)) {
    result[key] = resolveNodeValue(value, nodeResults, variables, graphNodes);
  }

  return result;
}

function resolveNodeValue(
  value: NodeValue,
  nodeResults: Record<string, NodeExecutionResult>,
  variables: Record<string, NodeValue>,
  graphNodes?: WorkflowNode[]
): NodeValue {
  if (typeof value === 'string') {
    const wholeRef = value.match(/^\{\{\s*([^}]+?)\s*\}\}$/);
    if (wholeRef?.[1]) {
      const token = wholeRef[1].trim();
      // Preserve _-prefixed references for executor-time resolution
      if (token.startsWith('_')) return value;
      if (token.startsWith('vars.')) {
        const variableValue = getNestedValue(variables, token.slice(5));
        return (variableValue as NodeValue) ?? null;
      }

      if (token.startsWith('config.')) {
        const resolved = resolveConfigRef(graphNodes, token.slice(7));
        return (resolved as NodeValue) ?? null;
      }

      const resolved = resolveRef(nodeResults, token);
      return (resolved as NodeValue) ?? null;
    }

    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, ref: string) => {
      const trimmed = ref.trim();

      // Preserve _-prefixed references — these are internal/computed variables
      // that executors inject at runtime (e.g. {{_upstream}} in transform.template).
      if (trimmed.startsWith('_')) return _match;

      if (trimmed.startsWith('vars.')) {
        const variableKey = trimmed.slice(5);
        const variableValue = getNestedValue(variables, variableKey);
        return variableValue == null ? '' : String(variableValue);
      }

      if (trimmed.startsWith('config.')) {
        const configValue = resolveConfigRef(graphNodes, trimmed.slice(7));
        if (configValue == null) return '';
        return typeof configValue === 'string' ? configValue : JSON.stringify(configValue);
      }

      const refValue = resolveRef(nodeResults, trimmed);
      if (refValue == null) return '';
      return typeof refValue === 'string' ? refValue : JSON.stringify(refValue);
    }) as NodeValue;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveNodeValue(item, nodeResults, variables, graphNodes));
  }

  if (value && typeof value === 'object') {
    const output: Record<string, NodeValue> = {};
    for (const [k, v] of Object.entries(value)) {
      output[k] = resolveNodeValue(v as NodeValue, nodeResults, variables, graphNodes);
    }
    return output;
  }

  return value;
}

function extractRefsFromNode(node: WorkflowNode): string[] {
  const refs = new Set<string>();

  const scan = (value: NodeValue): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
        const token = match[1]?.trim();
        if (token && !token.startsWith('vars.') && !token.startsWith('config.')) {
          refs.add(token);
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) scan(item);
      return;
    }

    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) {
        scan(child as NodeValue);
      }
    }
  };

  for (const entry of Object.values(node.config || {})) scan(entry);
  for (const entry of Object.values(node.inputs || {})) scan(entry);

  return Array.from(refs);
}

function resolveRef(
  nodeResults: Record<string, NodeExecutionResult>,
  ref: string
): unknown {
  const [nodeId, ...pathParts] = ref.split('.');
  if (!nodeId) return undefined;

  const nodeOutput = nodeResults[nodeId]?.output;
  if (!pathParts.length) return nodeOutput;

  return getNestedValue(nodeOutput as Record<string, unknown> | undefined, pathParts.join('.'));
}

/** Resolve a raw config value from a graph node: config.nodeId.field */
function resolveConfigRef(
  graphNodes: WorkflowNode[] | undefined,
  ref: string
): unknown {
  if (!graphNodes) return undefined;
  const [nodeId, ...pathParts] = ref.split('.');
  if (!nodeId || !pathParts.length) return undefined;

  const node = graphNodes.find((n) => n.id === nodeId);
  if (!node?.config) return undefined;

  return getNestedValue(node.config as Record<string, unknown>, pathParts.join('.'));
}

function getNestedValue(root: unknown, path: string): unknown {
  if (!root || !path) return undefined;

  const parts = path.split('.');
  let current: unknown = root;

  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function collectFlatOutputs(
  nodeResults: Record<string, NodeExecutionResult>
): Record<string, NodeValue> {
  const flat: Record<string, NodeValue> = {};
  for (const [nodeId, result] of Object.entries(nodeResults)) {
    flat[nodeId] = (result.output ?? null) as NodeValue;
  }
  return flat;
}

function renderTemplate(template: string, variables: Record<string, NodeValue>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, token: string) => {
    const key = token.trim();
    const value = getNestedValue(variables, key);
    if (value == null) return '';
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  });
}

function tryDecryptValue(stored: string, configDir: string): string {
  if (!stored.startsWith('ENC:')) return stored;
  try {
    const wsBase = 'data';
    // Walk up from configDir to find the data root with .keyfile
    let dir = configDir;
    let keyPath = '';
    for (let i = 0; i < 6; i++) {
      const candidate = join(dir, wsBase, '.keyfile');
      if (existsSync(candidate)) { keyPath = candidate; break; }
      const candidate2 = join(dir, '.keyfile');
      if (existsSync(candidate2)) { keyPath = candidate2; break; }
      dir = resolve(dir, '..');
    }
    if (!keyPath) return stored;
    const key = Buffer.from(readFileSync(keyPath, 'utf-8').trim(), 'hex');
    const raw = Buffer.from(stored.slice(4), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return stored;
  }
}

function parseKeyValueFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    throw new Error(`Config file not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const entries: Record<string, string> = {};
  const fileDir = resolve(filePath, '..');

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;

    const key = trimmed.slice(0, separator).trim();
    let val = trimmed.slice(separator + 1).trim();

    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    entries[key] = val.startsWith('ENC:') ? tryDecryptValue(val, fileDir) : val;
  }

  return entries;
}

function loadJiraConfig(configPath: string): JiraConfig {
  const env = parseKeyValueFile(configPath);
  const baseUrl = env.JIRA_BASE_URL;
  const email = env.JIRA_EMAIL;
  const apiToken = env.JIRA_API_TOKEN;
  const caCertPath = env.JIRA_CA_CERT_PATH;
  const aiModel = env.JIRA_AI_MODEL || 'anthropic.claude-sonnet-4-6';

  if (!baseUrl || !email || !apiToken) {
    throw new Error('Missing JIRA_BASE_URL, JIRA_EMAIL, or JIRA_API_TOKEN in Jira config.');
  }

  let caCertPem: string | undefined;
  if (caCertPath) {
    const resolvedCa = resolve(caCertPath);
    if (existsSync(resolvedCa)) {
      caCertPem = readFileSync(resolvedCa, 'utf-8');
    }
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    email,
    apiToken,
    caCertPem,
    aiModel,
  };
}

/**
 * Load CA certificate PEM for corporate proxies (e.g. Zscaler).
 * Checks CA_CERT_PATH env var, then falls back to JIRA_CA_CERT_PATH from a Jira config file.
 */
function loadCaCert(cwd: string, jiraConfigPath?: string): string | undefined {
  // Check generic env var first
  const envCaPath = process.env.CA_CERT_PATH || process.env.NODE_EXTRA_CA_CERTS;
  if (envCaPath) {
    const resolved = resolve(envCaPath);
    if (existsSync(resolved)) return readFileSync(resolved, 'utf-8');
  }
  // Fall back to Jira config which commonly has the Zscaler cert
  if (jiraConfigPath) {
    try {
      const cfg = loadJiraConfig(jiraConfigPath);
      return cfg.caCertPem;
    } catch { /* ignore */ }
  }
  // Try common Jira config locations
  for (const candidate of ['data/Jira/config/jira.env', 'Jira/config/jira.env', 'jira.env', 'config/jira.env']) {
    try {
      const cfg = loadJiraConfig(resolve(cwd, candidate));
      if (cfg.caCertPem) return cfg.caCertPem;
    } catch { /* ignore */ }
  }
  return undefined;
}

function extractTicketKey(ticketInput: string): string {
  const keyPattern = /([A-Z][A-Z0-9]+-\d+)/i;

  if (/^[A-Z][A-Z0-9]+-\d+$/i.test(ticketInput)) {
    return ticketInput.toUpperCase();
  }

  const urlMatch = ticketInput.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i);
  if (urlMatch?.[1]) {
    return urlMatch[1].toUpperCase();
  }

  const genericMatch = ticketInput.match(keyPattern);
  if (genericMatch?.[1]) {
    return genericMatch[1].toUpperCase();
  }

  throw new Error(`Could not extract Jira ticket key from input: ${ticketInput}`);
}

async function jiraApiRequest<T>(
  config: JiraConfig,
  endpoint: string,
  query?: Record<string, string | number>
): Promise<T> {
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
  const url = new URL(`${config.baseUrl}/rest/api/3/${endpoint.replace(/^\//, '')}`);

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
  }

  return new Promise<T>((resolvePromise, rejectPromise) => {
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
        },
        ca: config.caCertPem,
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf-8');
          const statusCode = res.statusCode || 0;

          if (statusCode < 200 || statusCode >= 300) {
            rejectPromise(new Error(`Jira API error (${statusCode}): ${rawBody || res.statusMessage || 'Unknown error'}`));
            return;
          }

          try {
            const parsed = rawBody ? JSON.parse(rawBody) as T : {} as T;
            resolvePromise(parsed);
          } catch (parseError) {
            rejectPromise(new Error(`Failed to parse Jira API response JSON: ${(parseError as Error).message}`));
          }
        });
      }
    );

    req.on('error', (error) => rejectPromise(error));
    req.end();
  });
}

async function jiraApiPost<T>(
  config: JiraConfig,
  endpoint: string,
  body: Record<string, unknown>
): Promise<T> {
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
  const url = new URL(`${config.baseUrl}/rest/api/3/${endpoint.replace(/^\//, '')}`);
  const payload = JSON.stringify(body);

  return new Promise<T>((resolvePromise, rejectPromise) => {
    const req = httpsRequest(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload).toString(),
        },
        ca: config.caCertPem,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf-8');
          const statusCode = res.statusCode || 0;

          if (statusCode < 200 || statusCode >= 300) {
            rejectPromise(new Error(`Jira API POST error (${statusCode}): ${rawBody || res.statusMessage || 'Unknown error'}`));
            return;
          }

          try {
            const parsed = rawBody ? JSON.parse(rawBody) as T : {} as T;
            resolvePromise(parsed);
          } catch (parseError) {
            rejectPromise(new Error(`Failed to parse Jira API POST response JSON: ${(parseError as Error).message}`));
          }
        });
      }
    );

    req.on('error', (error) => rejectPromise(error));
    req.write(payload);
    req.end();
  });
}

async function jiraApiPut(
  config: JiraConfig,
  endpoint: string,
  body: Record<string, unknown>
): Promise<void> {
  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
  const url = new URL(`${config.baseUrl}/rest/api/3/${endpoint.replace(/^\//, '')}`);
  const payload = JSON.stringify(body);

  return new Promise<void>((resolvePromise, rejectPromise) => {
    const req = httpsRequest(
      url,
      {
        method: 'PUT',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload).toString(),
        },
        ca: config.caCertPem,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf-8');
          const statusCode = res.statusCode || 0;

          if (statusCode < 200 || statusCode >= 300) {
            rejectPromise(new Error(`Jira API PUT error (${statusCode}): ${rawBody || res.statusMessage || 'Unknown error'}`));
            return;
          }

          resolvePromise();
        });
      }
    );

    req.on('error', (error) => rejectPromise(error));
    req.write(payload);
    req.end();
  });
}

function loadEnvValue(cwd: string, key: string): string {
  const candidates = [
    resolve(cwd, '.env'),
    resolve(cwd, '.env.local'),
  ];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const eqIdx = trimmed.indexOf('=');
        const k = trimmed.slice(0, eqIdx).trim();
        if (k === key) {
          let v = trimmed.slice(eqIdx + 1).trim();
          // Strip surrounding quotes
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (v) return v;
        }
      }
    } catch { /* ignore read errors */ }
  }
  return '';
}

/**
 * Load a value from the encrypted ADO config file at data/ADO/config/ado.env.
 * The setup wizard always saves the PAT as AZURE_DEVOPS_PAT, but workflow nodes
 * may use a different env var name (e.g. ADO_PAT). This function maps any
 * PAT-like key to the canonical AZURE_DEVOPS_PAT entry in the config file.
 */
function loadAdoConfigValue(cwd: string, key: string): string {
  const adoConfigPath = resolve(cwd, 'data/ADO/config/ado.env');
  if (!existsSync(adoConfigPath)) return '';
  try {
    const entries = parseKeyValueFile(adoConfigPath);
    // Try the requested key first, then fall back to the canonical name
    return entries[key] || entries['AZURE_DEVOPS_PAT'] || '';
  } catch {
    return '';
  }
}

/** Load ADO config values from a config file path (like Jira's configPath pattern). */
function loadAdoConfig(cwd: string, configPath: string): { orgUrl: string; pat: string } {
  const result = { orgUrl: '', pat: '' };
  const relPath = (configPath || '').trim() || 'data/ADO/config/ado.env';
  const absolute = resolve(cwd, relPath);
  if (!existsSync(absolute)) return result;
  try {
    const entries = parseKeyValueFile(absolute);
    result.orgUrl = entries['AZURE_DEVOPS_ORG_URL'] || '';
    result.pat = entries['AZURE_DEVOPS_PAT'] || '';
  } catch { /* ignore */ }
  return result;
}

/**
 * Parse an ADO repo URL, project URL, or plain project name into { project, repository }.
 * Supports:
 *   https://org.visualstudio.com/Project/_git/Repo  → { project: "Project", repository: "Repo" }
 *   https://dev.azure.com/org/Project/_git/Repo     → { project: "Project", repository: "Repo" }
 *   https://org.visualstudio.com/Project             → { project: "Project" }
 *   https://dev.azure.com/org/Project                → { project: "Project" }
 *   "My Project"                                     → { project: "My Project" }
 *   ""                                               → {}
 */
function parseAdoScope(repoUrl: string): { project: string; repository: string } {
  const raw = (repoUrl || '').trim();
  if (!raw) return { project: '', repository: '' };

  // Try URL patterns
  // visualstudio.com: https://org.visualstudio.com/Project/_git/Repo
  const vsGitMatch = raw.match(/^https?:\/\/[^/]+\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)/i);
  if (vsGitMatch) return { project: decodeURIComponent(vsGitMatch[1]), repository: decodeURIComponent(vsGitMatch[2]) };

  // dev.azure.com: https://dev.azure.com/org/Project/_git/Repo
  const devGitMatch = raw.match(/^https?:\/\/dev\.azure\.com\/[^/]+\/([^/]+)\/_git\/([^/?#]+)/i);
  if (devGitMatch) return { project: decodeURIComponent(devGitMatch[1]), repository: decodeURIComponent(devGitMatch[2]) };

  // Project-only URL: https://org.visualstudio.com/Project (no /_git/)
  const vsProjMatch = raw.match(/^https?:\/\/[^/]+\.visualstudio\.com\/([^/?#]+)$/i);
  if (vsProjMatch) return { project: decodeURIComponent(vsProjMatch[1]), repository: '' };

  // Project-only URL: https://dev.azure.com/org/Project
  const devProjMatch = raw.match(/^https?:\/\/dev\.azure\.com\/[^/]+\/([^/?#]+)$/i);
  if (devProjMatch) return { project: decodeURIComponent(devProjMatch[1]), repository: '' };

  // Not a URL — treat as plain project name
  if (!raw.startsWith('http')) return { project: raw, repository: '' };

  // Unrecognized URL format — return empty
  return { project: '', repository: '' };
}

async function fetchAzureDevOpsRepoContext(input: {
  organizationUrl: string;
  project: string;
  repository: string;
  branch: string;
  path: string;
  pat: string;
  maxFiles: number;
  maxCharsPerFile: number;
  fileNameFilter?: string;
  contentFilter?: string;
}): Promise<Record<string, unknown>> {
  const base = input.organizationUrl.replace(/\/+$/, '');
  const encodedProject = encodeURIComponent(input.project);
  const encodedRepo = encodeURIComponent(input.repository);
  const auth = Buffer.from(`:${input.pat}`).toString('base64');

  const itemsUrl = `${base}/${encodedProject}/_apis/git/repositories/${encodedRepo}/items`;
  const listUrl = new URL(itemsUrl);
  listUrl.searchParams.set('scopePath', input.path);
  listUrl.searchParams.set('recursionLevel', 'Full');
  listUrl.searchParams.set('includeContentMetadata', 'true');
  listUrl.searchParams.set('versionDescriptor.version', input.branch);
  listUrl.searchParams.set('api-version', '7.1-preview.1');

  const listing = await httpJsonRequest<{ value?: Array<Record<string, unknown>> }>(listUrl, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'User-Agent': 'claude-flow-workflow-studio/1.0',
    },
  });

  const nameTerms = (input.fileNameFilter || '')
    .split(',')
    .map((t: string) => t.trim().toLowerCase())
    .filter(Boolean);

  const contentTerms = (input.contentFilter || '')
    .split(',')
    .map((t: string) => t.trim().toLowerCase())
    .filter(Boolean);

  // Fetch more candidates when content filtering is active so we have enough after filtering
  const fetchLimit = contentTerms.length > 0 ? input.maxFiles * 5 : input.maxFiles;

  const candidates = (listing.value || [])
    .filter((item) => !item.isFolder)
    .map((item) => String(item.path || ''))
    .filter((path) => /\.(ts|tsx|js|jsx|json|md|yml|yaml|py|java|cs|go|rs|sql|tf|bicep|html|css|sh|cfg|ini|toml|xml|csproj|sln)$/i.test(path))
    .filter((path) => {
      if (nameTerms.length === 0) return true;
      const lower = path.toLowerCase();
      return nameTerms.some((term: string) => lower.includes(term));
    })
    .slice(0, fetchLimit);

  const files: Array<Record<string, unknown>> = [];
  for (const filePath of candidates) {
    if (files.length >= input.maxFiles) break;

    const fileUrl = new URL(itemsUrl);
    fileUrl.searchParams.set('path', filePath);
    fileUrl.searchParams.set('includeContent', 'true');
    fileUrl.searchParams.set('resolveLfs', 'true');
    fileUrl.searchParams.set('versionDescriptor.version', input.branch);
    fileUrl.searchParams.set('api-version', '7.1-preview.1');

    const text = await httpTextRequest(fileUrl, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'text/plain,application/octet-stream;q=0.9,*/*;q=0.8',
        'User-Agent': 'claude-flow-workflow-studio/1.0',
      },
    });

    // Apply content filter: skip files that do not contain any content term
    if (contentTerms.length > 0) {
      const lowerContent = text.toLowerCase();
      const matches = contentTerms.some((term: string) => lowerContent.includes(term));
      if (!matches) continue;
    }

    files.push({
      path: filePath,
      content: text.slice(0, input.maxCharsPerFile),
      truncated: text.length > input.maxCharsPerFile,
      chars: text.length,
    });
  }

  const summary = files.length === 0
    ? 'No repository files were sampled from Azure DevOps.'
    : files.map((file, index) => {
      const path = String(file.path || '');
      const content = String(file.content || '');
      return `File ${index + 1}: ${path}\n${content}`;
    }).join('\n\n');

  return {
    organizationUrl: input.organizationUrl,
    project: input.project,
    repository: input.repository,
    branch: input.branch,
    path: input.path,
    sampledFileCount: files.length,
    files,
    summary,
  };
}

function httpJsonRequest<T>(url: URL, options: { method: 'GET'; headers: Record<string, string>; ca?: string }): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const requestFactory = url.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = requestFactory(url, { ...options, ...(options.ca ? { ca: options.ca } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        const statusCode = res.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          rejectPromise(new Error(`HTTP JSON request failed (${statusCode}): ${rawBody || res.statusMessage || 'Unknown error'}`));
          return;
        }
        try {
          resolvePromise(rawBody ? JSON.parse(rawBody) as T : {} as T);
        } catch (parseError) {
          rejectPromise(new Error(`Failed to parse JSON response: ${(parseError as Error).message}`));
        }
      });
    });

    req.on('error', (error) => rejectPromise(error));
    req.end();
  });
}

function httpTextRequest(url: URL, options: { method: 'GET'; headers: Record<string, string>; ca?: string }): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const requestFactory = url.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = requestFactory(url, { ...options, ...(options.ca ? { ca: options.ca } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        const statusCode = res.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          rejectPromise(new Error(`HTTP text request failed (${statusCode}): ${rawBody || res.statusMessage || 'Unknown error'}`));
          return;
        }
        resolvePromise(rawBody);
      });
    });

    req.on('error', (error) => rejectPromise(error));
    req.end();
  });
}

function httpJsonPost<T>(url: URL, options: { headers: Record<string, string>; body: unknown; ca?: string }): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const payload = JSON.stringify(options.body);
    const requestFactory = url.protocol === 'http:' ? httpRequest : httpsRequest;
    const req = requestFactory(url, {
      method: 'POST',
      headers: {
        ...options.headers,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(payload, 'utf-8')),
      },
      ...(options.ca ? { ca: options.ca } : {}),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf-8');
        const statusCode = res.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          rejectPromise(new Error(`HTTP POST failed (${statusCode}): ${rawBody || res.statusMessage || 'Unknown error'}`));
          return;
        }
        try {
          resolvePromise(rawBody ? JSON.parse(rawBody) as T : {} as T);
        } catch (parseError) {
          rejectPromise(new Error(`Failed to parse POST response: ${(parseError as Error).message}`));
        }
      });
    });

    req.on('error', (error) => rejectPromise(error));
    req.write(payload);
    req.end();
  });
}

/** Fetch a web page via HTTPS GET, returning raw HTML body. */
function httpFetchPage(rawUrl: string, timeoutMs = 30000): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const parsedUrl = new URL(rawUrl.replace(/^http:\/\//i, 'https://'));
    const timer = setTimeout(() => rejectPromise(new Error(`Timeout fetching ${rawUrl}`)), timeoutMs);
    const req = httpsRequest(parsedUrl, { method: 'GET', headers: { 'User-Agent': 'claude-flow-workflow-studio/1.0', Accept: 'text/html,application/xhtml+xml,*/*' } }, (res) => {
      // Follow redirects (3xx)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        httpFetchPage(res.headers.location, timeoutMs).then(resolvePromise, rejectPromise);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        clearTimeout(timer);
        const body = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          rejectPromise(new Error(`HTTP ${res.statusCode} fetching ${rawUrl}`));
          return;
        }
        resolvePromise(body);
      });
    });
    req.on('error', (err) => { clearTimeout(timer); rejectPromise(err); });
    req.end();
  });
}

/** Strip HTML tags and decode common entities to produce rough plain text. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Ask AI to refine a search query that returned no results.
 * Returns a single alternative query string, or null if it can't improve.
 */
/**
 * Strip markdown code fences, surrounding quotes, and preamble sentences from AI-generated queries.
 * AI models often wrap output in ```jql / ```sql / ``` blocks despite instructions not to.
 */
function stripAiQueryNoise(raw: string): string {
  let cleaned = raw.trim();
  // Remove code fences: ```jql\n...\n``` or ```\n...\n```
  cleaned = cleaned.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  // Remove surrounding quotes
  cleaned = cleaned.replace(/^["']|["']$/g, '');
  // Remove multi-line AI preamble — everything up to and including "here is the query/JQL:" or similar
  cleaned = cleaned.replace(/^[\s\S]*?(?:here\s+(?:is|are)\s+(?:the\s+)?(?:search\s+)?(?:query|queries|JQL)[:\s]*\n?)/i, '');
  // Remove single-line preamble like "The search query is:" or "The JQL query is:"
  cleaned = cleaned.replace(/^(?:the\s+)?(?:search\s+)?(?:query|JQL)\s+(?:is|would\s+be)[:\s]*/i, '');
  // Strip lines starting with obvious AI prose starters (first-person, hedging, etc.)
  cleaned = cleaned.replace(/^(?:based\s+on|i'?ll|i\s+will|i\s+would|let\s+me|the\s+following|sure|note)[^\n]*\n/gi, '');
  return cleaned.trim();
}

/** Returns true if a line looks like AI prose rather than a search query. */
function looksLikeProse(line: string): boolean {
  // Lines starting with obvious AI prose starters
  if (/^(?:i'?ll|i\s+will|i\s+would|let\s+me|here|based\s+on|sure|the\s+following|note:|please|to\s+find|these|this|we|you|they|it\s)/i.test(line)) return true;
  // Lines containing contractions or prose verbs are sentences, not search queries
  if (/(?:haven'?t|hasn'?t|isn'?t|won'?t|shouldn'?t|aren'?t|wasn'?t|don'?t|doesn'?t|can'?t|wouldn'?t)/i.test(line)) return true;
  // Lines ending with common sentence endings (past participles, gerunds, etc.)
  if (/(?:searched|targeted|explored|checked|tried|found|needed|required|covered|examined|investigated)\s*\.?$/i.test(line)) return true;
  // More than 7 words is likely a sentence, not a search query
  if (line.split(/\s+/).length > 7) return true;
  return false;
}

/**
 * Generate an initial search query from upstream AI context when user hasn't provided one.
 * Returns a short keyword-based search string suitable for code/doc search APIs.
 */
async function aiGenerateInitialQuery(
  cwd: string,
  searchContext: string,
  searchType: 'code' | 'confluence' | 'jira',
  model: ModelType,
): Promise<string | null> {
  if (!searchContext.trim()) return null;
  const executor = new HeadlessWorkerExecutor(cwd, { maxConcurrent: 1, defaultTimeoutMs: 30_000 });
  const available = await executor.isAvailable();
  if (!available) return null;

  const typeHints: Record<string, string> = {
    code: 'Extract 3-6 keywords for a code search (API names, class names, config keys, package names). Example output: azure sql management api-version 2014-04-01',
    confluence: 'Extract 3-6 keywords for a Confluence wiki search (service names, feature names, technology terms). Example output: Azure SQL Database migration deployment',
    jira: 'Generate a JQL query for Jira. Use text ~ for keyword search. Example: text ~ "Azure SQL Database API deprecation" ORDER BY updated DESC',
  };

  const prompt = [
    `TASK: ${typeHints[searchType]}`,
    '',
    'CONTEXT:',
    searchContext.slice(0, 3000),
    '',
    searchType === 'jira'
      ? 'OUTPUT: Return ONLY a valid JQL query. Nothing else — no explanation, no markdown, no surrounding quotes.'
      : 'OUTPUT: Return ONLY the keywords separated by spaces. Nothing else — no explanation, no markdown, no sentences, no surrounding quotes.',
  ].join('\n');

  const result = await executor.execute('document', {
    promptTemplate: prompt,
    model,
    sandbox: 'permissive',
    outputFormat: 'text',
    contextPatterns: [],
    timeoutMs: 30_000,
  });

  if (!result.success || !result.output?.trim()) return null;
  let generated = stripAiQueryNoise(result.output);
  // For JQL, if there's still multi-line output, take the first line that looks like JQL
  if (searchType === 'jira' && generated.includes('\n')) {
    const jqlLine = generated.split('\n').find((l) => /^[\s(]*(?:text|summary|description|project|labels|status|issuetype|assignee)\s*[~=!]/i.test(l.trim()));
    if (jqlLine) generated = jqlLine.trim();
  }
  console.error(`[aiGenerateInitialQuery] type=${searchType} generated="${generated.slice(0, 150)}"`);
  return generated.length > 0 && generated.length < 1000 ? generated : null;
}

async function aiRefineSearchQuery(
  cwd: string,
  failedQuery: string,
  searchContext: string,
  model: ModelType,
): Promise<string | null> {
  const executor = new HeadlessWorkerExecutor(cwd, { maxConcurrent: 1, defaultTimeoutMs: 30_000 });
  const available = await executor.isAvailable();
  if (!available) return null;

  const prompt = [
    'A code/document search query returned ZERO results. Suggest ONE alternative search query.',
    '',
    `Failed query: "${failedQuery}"`,
    searchContext ? `Research context: ${searchContext.slice(0, 2000)}` : '',
    '',
    'Think about synonyms, alternative API names, library names, config keys, or broader/narrower terms.',
    'Return ONLY the new search query string — nothing else. No explanation, no quotes, no prefixes.',
  ].filter(Boolean).join('\n');

  const result = await executor.execute('document', {
    promptTemplate: prompt,
    model,
    sandbox: 'permissive',
    outputFormat: 'text',
    contextPatterns: [],
    timeoutMs: 30_000,
  });

  if (!result.success || !result.output?.trim()) return null;
  const refined = stripAiQueryNoise(result.output);
  return refined.length > 0 && refined.length < 500 ? refined : null;
}

interface CodeChangeEntry {
  filePath: string;
  content: string;
  language: string;
}

/**
 * Extract file-path + code-block pairs from AI-generated markdown.
 * Looks for patterns like:
 *   File: /path/to/file.cs
 *   ```csharp
 *   code
 *   ```
 */
function extractCodeChangesFromMarkdown(text: string): CodeChangeEntry[] {
  const results: CodeChangeEntry[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    // Look for file path markers: "File: path", "**File:** path", "File 1: path", etc.
    const fileMatch = line.match(/^(?:\*\*)?(?:File|Path)(?:\s*\d+)?(?:\*\*)?:\s*`?([^`\n]+)`?\s*$/i);
    if (fileMatch) {
      const filePath = fileMatch[1].trim().replace(/^\/+/, '');
      i++;
      // Skip blank lines between file marker and code fence
      while (i < lines.length && lines[i].trim() === '') i++;
      // Look for code block
      const fenceMatch = lines[i]?.trim().match(/^```(\w*)/);
      if (fenceMatch) {
        const lang = fenceMatch[1] || '';
        i++;
        const codeLines: string[] = [];
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // skip closing ```
        if (codeLines.length > 0) {
          results.push({ filePath, content: codeLines.join('\n'), language: lang });
        }
      }
      continue;
    }
    i++;
  }

  return results;
}

/**
 * Convert a markdown-ish description string to Atlassian Document Format (ADF).
 * Handles paragraphs, **bold**, bullet lists (- item), and headings (##).
 */
function markdownToAdf(text: string): Record<string, unknown> {
  const lines = text.split('\n');
  const content: Array<Record<string, unknown>> = [];
  let listItems: Array<Record<string, unknown>> = [];

  function flushList() {
    if (listItems.length > 0) {
      content.push({ type: 'bulletList', content: listItems });
      listItems = [];
    }
  }

  function inlineNodes(raw: string): Array<Record<string, unknown>> {
    const nodes: Array<Record<string, unknown>> = [];
    // Match: **bold**, ![alt](url) images, [link text](url), or bare https:// URLs
    // Bare URL: try balanced (...) groups FIRST, then normal non-special chars.
    // This ensures (Enablement) is consumed as a unit before ) can terminate the match.
    const re = /\*\*(.+?)\*\*|!\[([^\]]*)\]\((https?:\/\/[^)]+)\)|\[([^\]]+)\]\((https?:\/\/[^)]+)\)|(https?:\/\/(?:\([^)]*\)|[^\s<>\])])+)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) {
        nodes.push({ type: 'text', text: raw.slice(last, m.index) });
      }
      if (m[1]) {
        // **bold**
        nodes.push({ type: 'text', text: m[1], marks: [{ type: 'strong' }] });
      } else if (m[2] != null && m[3]) {
        // ![alt](url) — render as a linked image label (ADF doesn't support inline external images)
        const altText = m[2] || 'Image';
        nodes.push({ type: 'text', text: '\uD83D\uDDBC ' + altText, marks: [{ type: 'link', attrs: { href: m[3] } }] });
      } else if (m[4] && m[5]) {
        // [link text](url)
        nodes.push({ type: 'text', text: m[4], marks: [{ type: 'link', attrs: { href: m[5] } }] });
      } else if (m[6]) {
        // bare URL
        nodes.push({ type: 'text', text: m[6], marks: [{ type: 'link', attrs: { href: m[6] } }] });
      }
      last = re.lastIndex;
    }
    if (last < raw.length) {
      nodes.push({ type: 'text', text: raw.slice(last) });
    }
    return nodes.length > 0 ? nodes : [{ type: 'text', text: raw }];
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Blank line — flush
    if (trimmed === '') {
      flushList();
      i++;
      continue;
    }

    // Fenced code block (``` with optional language)
    const codeOpenMatch = trimmed.match(/^```(\w*)/);
    if (codeOpenMatch) {
      flushList();
      const lang = codeOpenMatch[1] || null;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      const codeAttrs: Record<string, unknown> = {};
      if (lang) codeAttrs.language = lang;
      content.push({
        type: 'codeBlock',
        attrs: codeAttrs,
        content: [{ type: 'text', text: codeLines.join('\n') }],
      });
      continue;
    }

    // Heading (## or ###)
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      flushList();
      const level = Math.min(headingMatch[1].length, 6);
      content.push({
        type: 'heading',
        attrs: { level },
        content: inlineNodes(headingMatch[2].trim()),
      });
      i++;
      continue;
    }

    // Bullet list item (- or *)
    const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      // Check for checkbox-style [ ] or [x]
      const checkMatch = bulletMatch[1].match(/^\[([x ])\]\s*(.*)/i);
      const itemText = checkMatch ? checkMatch[2] : bulletMatch[1];
      listItems.push({
        type: 'listItem',
        content: [{
          type: 'paragraph',
          content: inlineNodes(itemText),
        }],
      });
      i++;
      continue;
    }

    // Numbered list item (1. 2. etc)
    const numMatch = trimmed.match(/^\d+\.\s+(.+)/);
    if (numMatch) {
      // Treat numbered items as bullet items for simplicity in ADF
      listItems.push({
        type: 'listItem',
        content: [{
          type: 'paragraph',
          content: inlineNodes(numMatch[1]),
        }],
      });
      i++;
      continue;
    }

    // Markdown table (| col | col | ...)
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      flushList();
      // Collect all consecutive pipe-delimited lines
      const tableLines: string[] = [trimmed];
      i++;
      while (i < lines.length) {
        const next = lines[i].trimStart();
        if (!next.startsWith('|') || !next.endsWith('|')) break;
        tableLines.push(next);
        i++;
      }

      // Parse rows, skip separator rows (|---|---|)
      const rows: string[][] = [];
      for (const tl of tableLines) {
        const cells = tl.slice(1, -1).split('|').map(c => c.trim());
        if (cells.every(c => /^[-:]+$/.test(c))) continue;
        rows.push(cells);
      }

      if (rows.length > 0) {
        const colCount = Math.max(...rows.map(r => r.length));
        const adfRows = rows.map((row, rowIdx) => {
          const cellType = rowIdx === 0 ? 'tableHeader' : 'tableCell';
          const adfCells: Array<Record<string, unknown>> = [];
          for (let ci = 0; ci < colCount; ci++) {
            const cellText = ci < row.length ? row[ci] : '';
            adfCells.push({
              type: cellType,
              content: [{ type: 'paragraph', content: inlineNodes(cellText) }],
            });
          }
          return { type: 'tableRow', content: adfCells };
        });

        content.push({ type: 'table', content: adfRows });
      }
      continue;
    }

    // Regular paragraph — collect consecutive non-empty, non-special lines
    flushList();
    const paraLines: string[] = [trimmed];
    i++;
    while (i < lines.length) {
      const next = lines[i].trimStart();
      if (next === '' || next.match(/^[-*#]\s/) || next.match(/^\d+\.\s/) || next.match(/^```/) || (next.startsWith('|') && next.endsWith('|'))) break;
      paraLines.push(next);
      i++;
    }
    content.push({
      type: 'paragraph',
      content: inlineNodes(paraLines.join('\n')),
    });
  }

  flushList();

  // Ensure at least one content node
  if (content.length === 0) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: text || '(empty)' }] });
  }

  return { type: 'doc', version: 1, content };
}

function sanitizeConfigForDebug(config: Record<string, NodeValue>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && value.length > 300) {
      result[key] = value.slice(0, 300) + `... (${value.length} chars)`;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parseTicketDrafts(value: NodeValue): Array<{ summary: string; description: string; labels?: string[]; components?: string[] }> {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeTicketDraft(item))
      .filter((item): item is { summary: string; description: string; labels?: string[]; components?: string[] } => Boolean(item));
  }

  if (value && typeof value === 'object') {
    const maybeArray = (value as Record<string, unknown>).tickets;
    if (Array.isArray(maybeArray)) {
      return maybeArray
        .map((item) => normalizeTicketDraft(item as NodeValue))
        .filter((item): item is { summary: string; description: string; labels?: string[]; components?: string[] } => Boolean(item));
    }

    const single = normalizeTicketDraft(value as NodeValue);
    return single ? [single] : [];
  }

  const text = String(value || '').trim();
  if (!text) return [];

  const parsed = parseJsonFromText(text);
  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => normalizeTicketDraft(item as NodeValue))
      .filter((item): item is { summary: string; description: string; labels?: string[]; components?: string[] } => Boolean(item));
  }

  if (parsed && typeof parsed === 'object') {
    const asObject = parsed as Record<string, unknown>;
    if (Array.isArray(asObject.tickets)) {
      return asObject.tickets
        .map((item) => normalizeTicketDraft(item as NodeValue))
        .filter((item): item is { summary: string; description: string; labels?: string[]; components?: string[] } => Boolean(item));
    }

    const single = normalizeTicketDraft(parsed as NodeValue);
    return single ? [single] : [];
  }

  return [];
}

function normalizeTicketDraft(value: NodeValue): { summary: string; description: string; labels?: string[]; components?: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const summary = String(obj.summary || '').trim();
  if (!summary) return null;
  const description = String(obj.description || obj.details || '').trim();
  const labels = normalizeStringArray(obj.labels as NodeValue);
  const components = normalizeStringArray(obj.components as NodeValue);
  return {
    summary,
    description,
    labels: labels.length > 0 ? labels : undefined,
    components: components.length > 0 ? components : undefined,
  };
}

function parseJsonFromText(text: string): unknown {
  // Strategy 1: Extract from markdown code fence
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch?.[1]) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch { /* fall through */ }
  }

  // Strategy 2: Parse the raw text directly
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through */ }

  // Strategy 3: Find substring starting at first { or [ and ending at last } or ]
  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  if (firstObj >= 0) {
    const lastBrace = trimmed.lastIndexOf('}');
    if (lastBrace > firstObj) {
      try { return JSON.parse(trimmed.slice(firstObj, lastBrace + 1)); } catch { /* fall through */ }
    }
  }
  if (firstArr >= 0) {
    const lastBracket = trimmed.lastIndexOf(']');
    if (lastBracket > firstArr) {
      try { return JSON.parse(trimmed.slice(firstArr, lastBracket + 1)); } catch { /* fall through */ }
    }
  }

  return null;
}

function normalizeStringArray(value: NodeValue): string[] {
  if (Array.isArray(value)) {
    return dedupeStrings(value.map((item) => String(item || '').trim()).filter(Boolean));
  }

  const text = String(value || '').trim();
  if (!text) return [];
  return dedupeStrings(text.split(/[\n,]/g).map((item) => item.trim()).filter(Boolean));
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

function toBoolean(value: NodeValue, defaultValue: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return defaultValue;
  if (['true', '1', 'yes', 'y', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(text)) return false;
  return defaultValue;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function downloadBinaryUrlToTempFile(urlValue: string, config: JiraConfig, outputDir: string): Promise<string> {
  const url = new URL(urlValue);
  const extensionMatch = url.pathname.match(/\.([A-Za-z0-9]{2,6})$/);
  let ext = extensionMatch?.[1] ? `.${extensionMatch[1].toLowerCase()}` : '';

  mkdirSync(outputDir, { recursive: true });
  const data = await downloadBinaryWithRedirects(url, config, 0);

  // Detect actual image type from magic bytes when URL has no extension
  if (!ext || ext === '.bin') {
    ext = detectImageExtFromBytes(data);
  }

  const fileName = `jira-vision-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const localPath = join(outputDir, fileName);
  writeFileSync(localPath, data);
  return localPath;
}

/** Detect image file extension from magic bytes */
function detectImageExtFromBytes(data: Buffer): string {
  if (data.length < 4) return '.bin';
  // PNG: 89 50 4E 47
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return '.png';
  // JPEG: FF D8 FF
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return '.jpeg';
  // GIF: 47 49 46 38
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return '.gif';
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 && data.length >= 12
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return '.webp';
  // BMP: 42 4D
  if (data[0] === 0x42 && data[1] === 0x4D) return '.bmp';
  return '.bin';
}

async function downloadBinaryWithRedirects(url: URL, config: JiraConfig, depth: number): Promise<Buffer> {
  if (depth > 5) {
    throw new Error('Failed to download image: too many redirects.');
  }

  const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const req = httpsRequest(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: '*/*',
        },
        ca: config.caCertPem,
      },
      (res) => {
        const statusCode = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(statusCode)) {
          const location = res.headers.location;
          if (!location) {
            rejectPromise(new Error(`Failed to download image (${statusCode}) from Jira URL (missing redirect location).`));
            return;
          }

          const nextUrl = new URL(location, url);
          downloadBinaryWithRedirects(nextUrl, config, depth + 1)
            .then(resolvePromise)
            .catch(rejectPromise);
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          if (statusCode < 200 || statusCode >= 300) {
            rejectPromise(new Error(`Failed to download image (${statusCode}) from Jira URL.`));
            return;
          }
          resolvePromise(Buffer.concat(chunks));
        });
      }
    );

    req.on('error', (error) => rejectPromise(error));
    req.end();
  });
}

interface ImageAttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  contentUrl: string;
}

function collectIssueImageRefs(issueRaw: { fields?: Record<string, unknown> }): string[] {
  const refs = new Set<string>();
  const fields = issueRaw.fields || {};

  const attachments = Array.isArray(fields.attachment) ? fields.attachment : [];
  for (const item of attachments) {
    const typed = item as { content?: unknown; thumbnail?: unknown; filename?: unknown; mimeType?: unknown; contentType?: unknown };
    const mime = String(typed.mimeType || typed.contentType || '').toLowerCase();
    const filename = String(typed.filename || '').toLowerCase();
    const isImage = mime.startsWith('image/') || /(png|jpe?g|gif|bmp|webp|svg|heic|heif|tiff?)$/.test(filename);

    if (!isImage) continue;
    // Prefer full content URL; only use thumbnail if no content URL exists
    if (typeof typed.content === 'string') {
      refs.add(typed.content);
    } else if (typeof typed.thumbnail === 'string') {
      refs.add(typed.thumbnail);
    }
  }

  const summaryText = typeof fields.summary === 'string' ? fields.summary : '';
  const descriptionText = adfToText(fields.description);
  for (const found of extractImageUrlsFromText(summaryText)) refs.add(found);
  for (const found of extractImageUrlsFromText(descriptionText)) refs.add(found);

  const commentContainer = fields.comment as { comments?: Array<{ body?: unknown }> } | undefined;
  const comments = Array.isArray(commentContainer?.comments) ? commentContainer.comments : [];
  for (const comment of comments) {
    for (const found of extractImageUrlsFromText(adfToText(comment.body))) refs.add(found);
  }

  return Array.from(refs);
}

/** Extract structured attachment metadata for image attachments (id, filename, mimeType) */
function collectImageAttachmentMeta(issueRaw: { fields?: Record<string, unknown> }): ImageAttachmentMeta[] {
  const fields = issueRaw.fields || {};
  const attachments = Array.isArray(fields.attachment) ? fields.attachment : [];
  const results: ImageAttachmentMeta[] = [];

  for (const item of attachments) {
    const typed = item as { id?: unknown; content?: unknown; filename?: unknown; mimeType?: unknown; contentType?: unknown };
    const mime = String(typed.mimeType || typed.contentType || '').toLowerCase();
    const filename = String(typed.filename || '').toLowerCase();
    const isImage = mime.startsWith('image/') || /(png|jpe?g|gif|bmp|webp|svg|heic|heif|tiff?)$/.test(filename);
    if (!isImage) continue;
    if (!typed.id || !typed.content) continue;

    results.push({
      id: String(typed.id),
      filename: String(typed.filename || ''),
      mimeType: mime || 'image/png',
      contentUrl: String(typed.content),
    });
  }

  return results;
}

function extractImageUrlsFromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s)\]"']+/g) || [];
  return matches.filter((candidate) => /\.(png|jpe?g|gif|bmp|webp|svg|heic|heif|tiff?)(\?|$)/i.test(candidate));
}

function normalizeImageInputs(value: NodeValue): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0);
  }

  const single = String(value || '').trim();
  if (!single) return [];
  return [single];
}

function adfToText(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node;

  if (typeof node === 'object') {
    const value = node as { text?: string; content?: unknown[]; type?: string; attrs?: Record<string, unknown>; marks?: Array<{ type: string; attrs?: Record<string, unknown> }> };
    const parts: string[] = [];

    // Extract URL from inlineCard nodes (Jira smart links)
    if (value.type === 'inlineCard' && value.attrs?.url) {
      parts.push(String(value.attrs.url));
    }

    if (typeof value.text === 'string') {
      parts.push(value.text);
      // Also extract URLs from link marks on text nodes
      if (Array.isArray(value.marks)) {
        for (const mark of value.marks) {
          if (mark.type === 'link' && mark.attrs?.href) {
            parts.push(String(mark.attrs.href));
          }
        }
      }
    }

    if (Array.isArray(value.content)) {
      for (const child of value.content) {
        const text = adfToText(child);
        if (text) parts.push(text);
      }
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  return '';
}

/** Extract all URLs from an ADF document tree */
function adfExtractUrls(node: unknown): string[] {
  const urls: string[] = [];
  if (!node || typeof node !== 'object') return urls;

  const value = node as { type?: string; attrs?: Record<string, unknown>; marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; content?: unknown[]; text?: string };

  // inlineCard (Jira smart links)
  if (value.type === 'inlineCard' && value.attrs?.url) {
    urls.push(String(value.attrs.url));
  }

  // link marks on text nodes
  if (Array.isArray(value.marks)) {
    for (const mark of value.marks) {
      if (mark.type === 'link' && mark.attrs?.href) {
        urls.push(String(mark.attrs.href));
      }
    }
  }

  // media nodes with external URLs
  if (value.type === 'media' && value.attrs?.url) {
    urls.push(String(value.attrs.url));
  }

  // Recurse into children
  if (Array.isArray(value.content)) {
    for (const child of value.content) {
      urls.push(...adfExtractUrls(child));
    }
  }

  return urls;
}

/** Parse image attachment metadata from node config (may be array of objects or JSON string) */
function parseImageAttachments(value: unknown): ImageAttachmentMeta[] {
  if (!value) return [];
  let arr: unknown[];
  if (Array.isArray(value)) {
    arr = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return [];
    try { arr = JSON.parse(trimmed); } catch { return []; }
    if (!Array.isArray(arr)) return [];
  } else {
    return [];
  }
  return arr.filter((item): item is ImageAttachmentMeta => {
    if (!item || typeof item !== 'object') return false;
    const obj = item as Record<string, unknown>;
    return typeof obj.id === 'string' && typeof obj.filename === 'string';
  });
}

/**
 * Build ADF document from markdown text, then append mediaSingle nodes
 * for each original image attachment so images are preserved inline.
 */
function buildAdfWithImages(markdown: string, attachments: ImageAttachmentMeta[]): Record<string, unknown> {
  const adf = markdownToAdf(markdown);
  if (attachments.length === 0) return adf;

  const content = (adf.content || []) as Array<Record<string, unknown>>;

  // Add a horizontal rule separator
  content.push({ type: 'rule' });

  // Add heading for the images section
  content.push({
    type: 'heading',
    attrs: { level: 2 },
    content: [{ type: 'text', text: 'Original Attachments' }],
  });

  // Add each image as a mediaSingle node
  for (const att of attachments) {
    content.push({
      type: 'mediaSingle',
      attrs: { layout: 'center' },
      content: [{
        type: 'media',
        attrs: {
          type: 'file',
          id: att.id,
          collection: '',
        },
      }],
    });
  }

  return { ...adf, content };
}

function normalizeModel(model: NodeValue): ModelType {
  const value = String(model || 'sonnet').toLowerCase();
  if (value.includes('opus')) return 'opus';
  if (value.includes('haiku')) return 'haiku';
  return 'sonnet';
}

/** Map short model names to full Anthropic API model IDs */
function modelToApiId(model: ModelType): string {
  switch (model) {
    case 'opus': return 'claude-opus-4-6-20250612';
    case 'haiku': return 'claude-haiku-4-5-20251001';
    default: return 'claude-sonnet-4-6-20250514';
  }
}

/**
 * Call the Anthropic Messages API with a base64-encoded image for vision analysis.
 * Tries ANTHROPIC_API_KEY from: process.env, then .env files in cwd.
 */
async function callAnthropicVision(
  base64Data: string,
  mediaType: string,
  prompt: string,
  model: ModelType,
  timeoutMs: number,
  cwd?: string,
): Promise<string> {
  let apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey && cwd) {
    apiKey = loadEnvValue(cwd, 'ANTHROPIC_API_KEY');
  }
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set. Required for image vision analysis.');
  }

  const modelId = modelToApiId(model);
  const body = JSON.stringify({
    model: modelId,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Data,
          },
        },
        {
          type: 'text',
          text: prompt,
        },
      ],
    }],
  });

  return new Promise<string>((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      rejectP(new Error(`Anthropic vision API timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = httpsRequest(
      'https://api.anthropic.com/v1/messages',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          const rawBody = Buffer.concat(chunks).toString('utf-8');
          const statusCode = res.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            rejectP(new Error(`Anthropic API returned ${statusCode}: ${rawBody.slice(0, 500)}`));
            return;
          }
          try {
            const parsed = JSON.parse(rawBody) as {
              content?: Array<{ type: string; text?: string }>;
              error?: { message?: string };
            };
            if (parsed.error?.message) {
              rejectP(new Error(`Anthropic API error: ${parsed.error.message}`));
              return;
            }
            const textBlocks = (parsed.content || [])
              .filter((b) => b.type === 'text' && b.text)
              .map((b) => b.text!);
            resolveP(textBlocks.join('\n\n') || 'No analysis returned from vision API.');
          } catch (parseErr) {
            rejectP(new Error(`Failed to parse Anthropic response: ${String(parseErr)}`));
          }
        });
      },
    );

    req.on('error', (err) => {
      clearTimeout(timer);
      rejectP(new Error(`Anthropic API request failed: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
}
