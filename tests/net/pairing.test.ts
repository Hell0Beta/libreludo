import { describe, expect, it } from 'vitest';
import { buildPairingUrl, readPairingToken } from '../../src/net/pairing';

/*
 * The pairing link is the one place a `pairToken` leaves the screen, so its shape is worth pinning
 * down. Both halves are pure functions over a string, which is why this is a test rather than
 * something checked by eye on a phone.
 */
describe('Test net/pairing', () => {
  describe('buildPairingUrl', () => {
    it('should put the token in the fragment, never the query string', () => {
      const url = buildPairingUrl('ABCD', 'a-secret-token');
      // A fragment is not sent to the server and is not a `Referer`. A query string would be both.
      expect(url).toContain('#pair=a-secret-token');
      expect(url).not.toContain('?');
    });

    it('should point at the join route for the room', () => {
      expect(buildPairingUrl('ABCD', 'tok')).toMatch(/\/join\/ABCD#pair=tok$/);
    });

    it('should encode a token that would otherwise break the URL', () => {
      const url = buildPairingUrl('ABCD', 'a/b+c=d&e');
      // The separator characters must not survive unescaped, or the fragment stops being one value.
      expect(url).toContain('#pair=a%2Fb%2Bc%3Dd%26e');
      expect(readPairingToken(new URL(url, 'https://example.test').hash)).toBe('a/b+c=d&e');
    });
  });

  describe('readPairingToken', () => {
    it('should read back what buildPairingUrl wrote', () => {
      const url = buildPairingUrl('ABCD', '9f1c4e2a-0000-4444-8888-abcdefabcdef');
      const hash = new URL(url, 'https://example.test').hash;
      expect(readPairingToken(hash)).toBe('9f1c4e2a-0000-4444-8888-abcdefabcdef');
    });

    it('should accept the fragment with or without its leading hash', () => {
      expect(readPairingToken('#pair=tok')).toBe('tok');
      expect(readPairingToken('pair=tok')).toBe('tok');
    });

    it('should return null for an ordinary invite, so the seat picker is shown', () => {
      expect(readPairingToken('')).toBeNull();
      expect(readPairingToken('#')).toBeNull();
      expect(readPairingToken('#anything-else')).toBeNull();
      // Not a prefix match: `#pairing=` is a different key that happens to start the same way.
      expect(readPairingToken('#pairing=tok')).toBeNull();
    });

    it('should return null for a fragment that names no token', () => {
      expect(readPairingToken('#pair=')).toBeNull();
    });

    it('should return null rather than throw on a malformed escape', () => {
      // `decodeURIComponent('100%')` throws. An unhandled throw here would take the join screen
      // down over a hand-typed URL.
      expect(readPairingToken('#pair=100%')).toBeNull();
    });

    it('should not truncate a token containing a hash', () => {
      // The reason this parses the fragment by hand instead of handing the URL to `URLSearchParams`:
      // everything after a second `#` is still part of the value.
      expect(readPairingToken('#pair=a#b')).toBe('a#b');
    });
  });
});
