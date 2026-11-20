import { describe, it, expect } from 'vitest';
import { extractJson } from '../workers/src/json';

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses fenced ```json block', () => {
    expect(extractJson('here you go:\n```json\n{"a":2}\n```\nthanks')).toEqual({ a: 2 });
  });

  it('parses fenced block without language tag', () => {
    expect(extractJson('```\n{"a":3}\n```')).toEqual({ a: 3 });
  });

  it('extracts first{...last} from prose', () => {
    expect(extractJson('I think {"a":4} is right, ok?')).toEqual({ a: 4 });
  });

  it('handles whitespace and newlines', () => {
    expect(extractJson('\n  {"a":5}  \n')).toEqual({ a: 5 });
  });

  it('throws on unparseable text', () => {
    expect(() => extractJson('sorry, I cannot answer in JSON')).toThrow(/no parseable JSON/);
  });

  it('throws on broken braces', () => {
    expect(() => extractJson('{not json at all')).toThrow(/no parseable JSON/);
  });
});