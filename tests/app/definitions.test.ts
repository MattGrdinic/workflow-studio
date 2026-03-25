import { describe, it, expect } from 'vitest';
import { NODE_DEFINITIONS } from '../../src/definitions.js';

describe('NODE_DEFINITIONS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(NODE_DEFINITIONS)).toBe(true);
    expect(NODE_DEFINITIONS.length).toBeGreaterThan(0);
  });

  it('every definition has required fields', () => {
    for (const def of NODE_DEFINITIONS) {
      expect(def.type).toBeTruthy();
      expect(def.title).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.category).toBeTruthy();
      expect(Array.isArray(def.configSchema)).toBe(true);
    }
  });

  it('every definition type is unique', () => {
    const types = NODE_DEFINITIONS.map(d => d.type);
    const unique = new Set(types);
    expect(unique.size).toBe(types.length);
  });

  it('every configSchema field has key, label, and type', () => {
    for (const def of NODE_DEFINITIONS) {
      for (const field of def.configSchema) {
        expect(field.key, `${def.type} field missing key`).toBeTruthy();
        expect(field.label, `${def.type}.${field.key} field missing label`).toBeTruthy();
        expect(field.type, `${def.type}.${field.key} field missing type`).toBeTruthy();
        expect(['string', 'number', 'boolean', 'json', 'text']).toContain(field.type);
      }
    }
  });

  it('every outputSchema field has key and type', () => {
    for (const def of NODE_DEFINITIONS) {
      if (!def.outputSchema) continue;
      for (const field of def.outputSchema) {
        expect(field.key, `${def.type} output field missing key`).toBeTruthy();
        expect(field.type, `${def.type}.${field.key} output field missing type`).toBeTruthy();
      }
    }
  });

  it('contains expected core node types', () => {
    const types = new Set(NODE_DEFINITIONS.map(d => d.type));
    const expectedTypes = [
      'jira.fetchIssue',
      'jira.searchJql',
      'jira.createIssues',
      'ai.runPrompt',
      'ai.interactiveChat',
      'io.readFile',
      'io.writeFile',
      'transform.template',
      'image.visionExtract',
    ];
    for (const expected of expectedTypes) {
      expect(types.has(expected), `Missing node type: ${expected}`).toBe(true);
    }
  });

  it('categories are from the allowed set', () => {
    const allowed = new Set([
      'jira', 'ai', 'image', 'io', 'transform', 'slack', 'github',
      'logic', 'notification', 'ado', 'azuredevops', 'web', 'spec', 'confluence',
    ]);
    for (const def of NODE_DEFINITIONS) {
      expect(
        allowed.has(def.category),
        `${def.type} has unexpected category "${def.category}"`
      ).toBe(true);
    }
  });

  it('configSchema field keys are unique within each definition', () => {
    for (const def of NODE_DEFINITIONS) {
      const keys = def.configSchema.map(f => f.key);
      const unique = new Set(keys);
      expect(unique.size, `${def.type} has duplicate config keys`).toBe(keys.length);
    }
  });

  it('io.writeFile has outputFormat option with expected values', () => {
    const writeFile = NODE_DEFINITIONS.find(d => d.type === 'io.writeFile');
    expect(writeFile).toBeDefined();
    const formatField = writeFile!.configSchema.find(f => f.key === 'outputFormat');
    expect(formatField).toBeDefined();
    expect(formatField!.options).toEqual(['markdown', 'jira', 'json', 'text']);
  });
});
