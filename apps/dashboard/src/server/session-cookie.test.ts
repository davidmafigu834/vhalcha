import { describe, expect, it } from 'vitest';
import { SESSION_MAX_AGE_SECONDS, sessionCookieOptions } from './session-cookie';

describe('session cookies', () => {
  it('keeps the production cookie httpOnly, secure, and lax', () => {
    expect(sessionCookieOptions('production')).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    expect(SESSION_MAX_AGE_SECONDS).toBe(60 * 60 * 12);
  });

  it('leaves local development cookies usable without Secure', () => {
    expect(sessionCookieOptions('development').secure).toBe(false);
  });
});