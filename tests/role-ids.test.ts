/**
 * parseRoleIds -- shared parsing for every `*_role_ids` JSON column.
 *
 * codex review finding on PR #38: a corrupted eligibility_role_ids blob must
 * not silently collapse to the same empty list a genuinely unrestricted
 * pickup produces -- that would flip a restricted pickup open. failClosed
 * substitutes a sentinel role nobody can ever hold instead.
 */

import { describe, expect, it, vi } from 'vitest';
import { CORRUPTED_ROLE_SENTINEL, parseRoleIds } from '../src/db/repositories/role-ids.js';

describe('parseRoleIds', () => {
  it('parses a normal array of role IDs', () => {
    expect(parseRoleIds('["a","b"]')).toEqual(['a', 'b']);
  });

  it('parses an empty array as an empty array', () => {
    expect(parseRoleIds('[]')).toEqual([]);
  });

  it('drops nothing when every entry is a string', () => {
    expect(parseRoleIds('["only-one"]')).toEqual(['only-one']);
  });

  describe('without failClosed', () => {
    it('treats malformed JSON as an empty list', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(parseRoleIds('not json')).toEqual([]);
      errorSpy.mockRestore();
    });

    it('treats a non-array JSON value as an empty list', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(parseRoleIds('{"not": "an array"}')).toEqual([]);
      errorSpy.mockRestore();
    });

    it('treats an array with a non-string entry as an empty list', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(parseRoleIds('["a", 123, "b"]')).toEqual([]);
      errorSpy.mockRestore();
    });
  });

  describe('with failClosed: true', () => {
    it('substitutes the sentinel for malformed JSON instead of an empty (unrestricted) list', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(parseRoleIds('not json', { failClosed: true })).toEqual([CORRUPTED_ROLE_SENTINEL]);
      errorSpy.mockRestore();
    });

    it('substitutes the sentinel for a non-array JSON value', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(parseRoleIds('42', { failClosed: true })).toEqual([CORRUPTED_ROLE_SENTINEL]);
      errorSpy.mockRestore();
    });

    it('still returns a genuinely empty list as empty -- "unset" and "corrupt" are different facts', () => {
      expect(parseRoleIds('[]', { failClosed: true })).toEqual([]);
    });

    it('still parses a valid array normally', () => {
      expect(parseRoleIds('["real-role"]', { failClosed: true })).toEqual(['real-role']);
    });
  });
});
