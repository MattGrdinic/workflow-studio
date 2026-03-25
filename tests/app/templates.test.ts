import { describe, it, expect } from 'vitest';
import { getStudioTemplates } from '../../src/templates.js';
import type { WorkflowGraph } from '../../src/types.js';

describe('getStudioTemplates', () => {
  let templates: WorkflowGraph[];

  // Load once
  templates = getStudioTemplates();

  it('returns a non-empty array', () => {
    expect(Array.isArray(templates)).toBe(true);
    expect(templates.length).toBeGreaterThan(0);
  });

  it('every template has required fields', () => {
    for (const t of templates) {
      expect(t.id, 'template missing id').toBeTruthy();
      expect(t.name, `${t.id} missing name`).toBeTruthy();
      expect(t.description, `${t.id} missing description`).toBeTruthy();
      expect(t.category, `${t.id} missing category`).toBeTruthy();
      expect(Array.isArray(t.nodes), `${t.id} nodes is not an array`).toBe(true);
      expect(t.nodes.length, `${t.id} has no nodes`).toBeGreaterThan(0);
    }
  });

  it('every template id is unique', () => {
    const ids = templates.map(t => t.id!);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('every template node has id and type', () => {
    for (const t of templates) {
      for (const node of t.nodes) {
        expect(node.id, `${t.id} has a node without an id`).toBeTruthy();
        expect(node.type, `${t.id}:${node.id} has no type`).toBeTruthy();
      }
    }
  });

  it('every template node id is unique within its template', () => {
    for (const t of templates) {
      const ids = t.nodes.map(n => n.id);
      const unique = new Set(ids);
      expect(unique.size, `${t.id} has duplicate node ids`).toBe(ids.length);
    }
  });

  it('edges reference valid node ids', () => {
    for (const t of templates) {
      const nodeIds = new Set(t.nodes.map(n => n.id));
      for (const edge of (t.edges || [])) {
        expect(nodeIds.has(edge.from), `${t.id} edge from="${edge.from}" references non-existent node`).toBe(true);
        expect(nodeIds.has(edge.to), `${t.id} edge to="${edge.to}" references non-existent node`).toBe(true);
      }
    }
  });

  it('contains Getting Started templates', () => {
    const gettingStarted = templates.filter(t => t.category === 'Getting Started');
    expect(gettingStarted.length).toBeGreaterThanOrEqual(3);
  });

  it('all nodes have position coordinates', () => {
    for (const t of templates) {
      for (const node of t.nodes) {
        expect(node.position, `${t.id}:${node.id} missing position`).toBeDefined();
        expect(typeof node.position!.x).toBe('number');
        expect(typeof node.position!.y).toBe('number');
      }
    }
  });
});
