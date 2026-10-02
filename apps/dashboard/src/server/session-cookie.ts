export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;

export function sessionCookieOptions(environment: string) {
  return {
    httpOnly: true as const,
    sameSite: 'lax' as const,
    secure: environment === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
