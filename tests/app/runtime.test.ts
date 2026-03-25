import { describe, it, expect } from 'vitest';
import {
  resolveExecutionOrder,
  resolveExecutionLevels,
  extractRefsFromNode,
  getNestedValue,
  renderTemplate,
  markdownToJiraWiki,
  stripMarkdown,
  getNodeExecutor,
  listNodeTypes,
} from '../../src/runtime.js';
import type { WorkflowGraph, WorkflowNode, NodeValue } from '../../src/types.js';

// ─── resolveExecutionOrder ─────────────────────────────────────────

describe('resolveExecutionOrder', () => {
  it('returns nodes in dependency order from edges', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'b', type: 'io.readFile' },
        { id: 'a', type: 'jira.fetchIssue' },
        { id: 'c', type: 'ai.runPrompt' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    };
    expect(resolveExecutionOrder(graph)).toEqual(['a', 'b', 'c']);
  });

  it('returns nodes in dependency order from template refs', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'seed', type: 'jira.fetchIssue', config: { issueKey: 'TEST-1' } },
        { id: 'ai', type: 'ai.runPrompt', config: { prompt: 'Analyze {{seed.summary}}' } },
      ],
      edges: [],
    };
    const order = resolveExecutionOrder(graph);
    expect(order.indexOf('seed')).toBeLessThan(order.indexOf('ai'));
  });

  it('handles independent parallel nodes', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'a', type: 'io.readFile' },
        { id: 'b', type: 'io.readFile' },
        { id: 'c', type: 'ai.runPrompt', config: { prompt: '{{a.text}} {{b.text}}' } },
      ],
      edges: [],
    };
    const order = resolveExecutionOrder(graph);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('throws on circular dependencies', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'a', type: 'io.readFile' },
        { id: 'b', type: 'io.readFile' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    };
    expect(() => resolveExecutionOrder(graph)).toThrow(/circular/i);
  });

  it('handles a single node with no edges', () => {
    const graph: WorkflowGraph = {
      nodes: [{ id: 'solo', type: 'io.readFile' }],
      edges: [],
    };
    expect(resolveExecutionOrder(graph)).toEqual(['solo']);
  });

  it('handles empty graph', () => {
    const graph: WorkflowGraph = { nodes: [], edges: [] };
    expect(resolveExecutionOrder(graph)).toEqual([]);
  });

  it('ignores edges referencing non-existent nodes', () => {
    const graph: WorkflowGraph = {
      nodes: [{ id: 'a', type: 'io.readFile' }],
      edges: [{ from: 'ghost', to: 'a' }],
    };
    expect(resolveExecutionOrder(graph)).toEqual(['a']);
  });

  it('ignores self-referencing edges', () => {
    const graph: WorkflowGraph = {
      nodes: [{ id: 'a', type: 'io.readFile' }],
      edges: [{ from: 'a', to: 'a' }],
    };
    expect(resolveExecutionOrder(graph)).toEqual(['a']);
  });
});

// ─── resolveExecutionLevels ────────────────────────────────────────

describe('resolveExecutionLevels', () => {
  it('groups independent nodes into the same level', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'a', type: 'io.readFile' },
        { id: 'b', type: 'io.readFile' },
        { id: 'c', type: 'ai.runPrompt', config: { prompt: '{{a.text}} {{b.text}}' } },
      ],
      edges: [],
    };
    const levels = resolveExecutionLevels(graph);
    expect(levels.length).toBe(2);
    expect(levels[0]).toContain('a');
    expect(levels[0]).toContain('b');
    expect(levels[1]).toEqual(['c']);
  });

  it('creates sequential levels for linear chains', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'a', type: 'io.readFile' },
        { id: 'b', type: 'transform.template' },
        { id: 'c', type: 'io.writeFile' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    };
    const levels = resolveExecutionLevels(graph);
    expect(levels).toEqual([['a'], ['b'], ['c']]);
  });

  it('throws on circular dependencies', () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: 'x', type: 'io.readFile' },
        { id: 'y', type: 'io.readFile' },
      ],
      edges: [
        { from: 'x', to: 'y' },
        { from: 'y', to: 'x' },
      ],
    };
    expect(() => resolveExecutionLevels(graph)).toThrow(/circular/i);
  });
});

// ─── extractRefsFromNode ───────────────────────────────────────────

describe('extractRefsFromNode', () => {
  it('extracts refs from config strings', () => {
    const node: WorkflowNode = {
      id: 'test',
      type: 'ai.runPrompt',
      config: {
        prompt: 'Look at {{seed.summary}} and {{related.count}}',
      },
    };
    const refs = extractRefsFromNode(node);
    expect(refs).toContain('seed.summary');
    expect(refs).toContain('related.count');
  });

  it('ignores vars references', () => {
    const node: WorkflowNode = {
      id: 'test',
      type: 'ai.runPrompt',
      config: {
        prompt: '{{vars.ticket}} and {{seed.key}}',
      },
    };
    const refs = extractRefsFromNode(node);
    expect(refs).not.toContain('vars.ticket');
    expect(refs).toContain('seed.key');
  });

  it('ignores config references', () => {
    const node: WorkflowNode = {
      id: 'test',
      type: 'ai.runPrompt',
      config: {
        prompt: '{{config.seed.issueKey}} and {{seed.key}}',
      },
    };
    const refs = extractRefsFromNode(node);
    expect(refs).not.toContain('config.seed.issueKey');
    expect(refs).toContain('seed.key');
  });

  it('deduplicates refs', () => {
    const node: WorkflowNode = {
      id: 'test',
      type: 'ai.runPrompt',
      config: {
        prompt: '{{seed.key}} and again {{seed.key}}',
      },
    };
    const refs = extractRefsFromNode(node);
    expect(refs.filter(r => r === 'seed.key')).toHaveLength(1);
  });

  it('extracts refs from nested config objects', () => {
    const node: WorkflowNode = {
      id: 'test',
      type: 'transform.template',
      config: {
        template: '{{a.text}}',
        nested: { deep: '{{b.value}}' } as unknown as NodeValue,
      },
    };
    const refs = extractRefsFromNode(node);
    expect(refs).toContain('a.text');
    expect(refs).toContain('b.value');
  });

  it('returns empty for no refs', () => {
    const node: WorkflowNode = {
      id: 'test',
      type: 'io.readFile',
      config: { path: 'plain-string.txt' },
    };
    expect(extractRefsFromNode(node)).toEqual([]);
  });
});

// ─── getNestedValue ────────────────────────────────────────────────

describe('getNestedValue', () => {
  it('gets a top-level value', () => {
    expect(getNestedValue({ name: 'Alice' }, 'name')).toBe('Alice');
  });

  it('gets a deeply nested value', () => {
    expect(getNestedValue({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined for missing paths', () => {
    expect(getNestedValue({ a: 1 }, 'b')).toBeUndefined();
    expect(getNestedValue({ a: 1 }, 'a.b.c')).toBeUndefined();
  });

  it('returns undefined for null/undefined root', () => {
    expect(getNestedValue(null, 'a')).toBeUndefined();
    expect(getNestedValue(undefined, 'a')).toBeUndefined();
  });

  it('returns undefined for empty path', () => {
    expect(getNestedValue({ a: 1 }, '')).toBeUndefined();
  });
});

// ─── renderTemplate ────────────────────────────────────────────────

describe('renderTemplate', () => {
  it('replaces simple variables', () => {
    expect(renderTemplate('Hello {{name}}', { name: 'World' })).toBe('Hello World');
  });

  it('replaces multiple variables', () => {
    expect(renderTemplate('{{a}} + {{b}} = {{c}}', { a: '1', b: '2', c: '3' })).toBe('1 + 2 = 3');
  });

  it('handles missing variables as empty string', () => {
    expect(renderTemplate('Hello {{name}}', {})).toBe('Hello ');
  });

  it('handles whitespace in template tokens', () => {
    expect(renderTemplate('{{ name }}', { name: 'World' })).toBe('World');
  });

  it('serializes objects as JSON', () => {
    const result = renderTemplate('Data: {{obj}}', { obj: { x: 1 } as unknown as NodeValue });
    expect(result).toContain('"x": 1');
  });

  it('returns string unchanged with no tokens', () => {
    expect(renderTemplate('No tokens here', { a: '1' })).toBe('No tokens here');
  });
});

// ─── markdownToJiraWiki ────────────────────────────────────────────

describe('markdownToJiraWiki', () => {
  it('converts headers', () => {
    expect(markdownToJiraWiki('# Title')).toBe('h1. Title');
    expect(markdownToJiraWiki('## Subtitle')).toBe('h2. Subtitle');
    expect(markdownToJiraWiki('### H3')).toBe('h3. H3');
  });

  it('converts bold', () => {
    expect(markdownToJiraWiki('**bold text**')).toBe('*bold text*');
  });

  it('converts inline code', () => {
    expect(markdownToJiraWiki('use `npm install`')).toBe('use {{npm install}}');
  });

  it('converts links', () => {
    expect(markdownToJiraWiki('[Click](http://example.com)')).toBe('[Click|http://example.com]');
  });

  it('converts code blocks', () => {
    const md = '```js\nconsole.log("hi");\n```';
    const result = markdownToJiraWiki(md);
    expect(result).toContain('{code:language=js}');
    expect(result).toContain('{code}');
  });

  it('converts unordered lists', () => {
    expect(markdownToJiraWiki('- item one')).toBe('* item one');
    expect(markdownToJiraWiki('* item two')).toBe('* item two');
  });

  it('converts ordered lists', () => {
    expect(markdownToJiraWiki('1. first')).toBe('# first');
  });

  it('converts horizontal rules', () => {
    expect(markdownToJiraWiki('---')).toBe('----');
  });

  it('converts blockquotes', () => {
    expect(markdownToJiraWiki('> quoted text')).toBe('{quote}quoted text{quote}');
  });
});

// ─── stripMarkdown ─────────────────────────────────────────────────

describe('stripMarkdown', () => {
  it('strips headers', () => {
    expect(stripMarkdown('## Title')).toBe('Title');
  });

  it('strips bold', () => {
    expect(stripMarkdown('**bold**')).toBe('bold');
  });

  it('strips inline code', () => {
    expect(stripMarkdown('use `code`')).toBe('use code');
  });

  it('strips links (keeps text)', () => {
    expect(stripMarkdown('[Click](http://example.com)')).toBe('Click');
  });

  it('strips italic', () => {
    expect(stripMarkdown('*italic*')).toBe('italic');
  });
});

// ─── Node executor registry ────────────────────────────────────────

describe('node executor registry', () => {
  it('listNodeTypes returns a non-empty array of strings', () => {
    const types = listNodeTypes();
    expect(types.length).toBeGreaterThan(0);
    expect(types).toContain('jira.fetchIssue');
    expect(types).toContain('ai.runPrompt');
    expect(types).toContain('io.readFile');
    expect(types).toContain('io.writeFile');
    expect(types).toContain('transform.template');
  });

  it('getNodeExecutor returns a function for registered types', () => {
    const executor = getNodeExecutor('jira.extractTicketKey');
    expect(typeof executor).toBe('function');
  });

  it('getNodeExecutor returns undefined for unknown types', () => {
    expect(getNodeExecutor('nonexistent.type')).toBeUndefined();
  });

  it('all listed types have an executor', () => {
    const types = listNodeTypes();
    for (const type of types) {
      expect(getNodeExecutor(type)).toBeDefined();
    }
  });
});
