import { createHash, randomBytes } from 'node:crypto';
import { createRepositories, type AppDatabase } from '@vhalcha/database';
import { hashPassword, verifyPassword } from '@vhalcha/security';
import type { UserRole } from '@vhalcha/types';
import { signSession, verifySession, type AuthProvider, type SessionClaims } from './index';

const SESSION_SECONDS = 60 * 60 * 12;

function hashToken(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function createLocalAuthProvider(input: {
  db: AppDatabase;
  secret: string;
  onResetIssued?: (details: { email: string; resetPath: string }) => void;
}): AuthProvider {
  const repos = createRepositories(input.db);
  let dummyHash: Promise<string> | null = null;
  const paddingHash = () => {
    dummyHash ??= hashPassword('vhalcha-timing-pad');
    return dummyHash;
  };

  return {
    async signIn({ email, password }) {
      const matches = await repos.users.findByEmail(email);
      const user = matches.length === 1 ? matches[0] : null;
      const comparison = user?.passwordHash ?? (await paddingHash());
      const valid = await verifyPassword(password, comparison);
      if (!user || !user.passwordHash || user.status !== 'active' || !valid) {
        throw new Error('The email or password is incorrect.');
      }
      const sid = randomBytes(32).toString('base64url');
      const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
      const session = await repos.sessions.create({
        userId: user.id,
        organisationId: user.organisationId,
        tokenHash: hashToken(sid),
        expiresAt: new Date(exp * 1000),
      });
      await repos.audit.create(user.organisationId, {
        organisationId: user.organisationId,
        actorType: 'user',
        actorId: user.id,
        action: 'user.signed_in',
        resourceType: 'session',
        resourceId: session.id,
        result: 'success',
        severity: 'info',
      });
      const claims: SessionClaims = { sid, uid: user.id, oid: user.organisationId, exp };
      return { token: signSession(claims, input.secret), claims };
    },
    async signOut(organisationId: string, sessionId: string) {
      await repos.sessions.revoke(organisationId, sessionId);
    },
    async getSession(token: string) {
      const claims = verifySession(token, input.secret);
      if (!claims) {
        return null;
      }
      const session = await repos.sessions.findActiveByHash(hashToken(claims.sid));
      if (!session || session.userId !== claims.uid || session.organisationId !== claims.oid) {
        return null;
      }
      const user = await repos.users.findById(claims.oid, claims.uid);
      if (!user || user.status !== 'active') {
        return null;
      }
      return {
        claims,
        sessionId: session.id,
        role: user.role as UserRole,
        email: user.email,
        name: user.name,
      };
    },
    async requestPasswordReset(email) {
      const matches = await repos.users.findByEmail(email);
      const user = matches.length === 1 ? matches[0] : null;
      if (!user || user.status !== 'active') {
        return;
      }
      const raw = randomBytes(32).toString('base64url');
      await repos.passwordResets.create({
        organisationId: user.organisationId,
        userId: user.id,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      });
      await repos.audit.create(user.organisationId, {
        organisationId: user.organisationId,
        actorType: 'user',
        actorId: user.id,
        action: 'user.password_reset_requested',
        resourceType: 'user',
        resourceId: user.id,
        result: 'success',
        severity: 'info',
      });
      input.onResetIssued?.({ email: user.email, resetPath: `/reset-password?token=${raw}` });
    },
    async resetPassword(token, password) {
      if (password.length < 12) {
        throw new Error('Use at least 12 characters.');
      }
      const reset = await repos.passwordResets.findValid(hashToken(token));
      if (!reset) {
        throw new Error('This reset link is invalid or has expired.');
      }
      const user = await repos.users.findByPrimaryKey(reset.userId);
      if (!user) {
        throw new Error('This reset link is invalid or has expired.');
      }
      await repos.users.updatePassword(user.organisationId, user.id, await hashPassword(password));
      await repos.passwordResets.markUsed(user.organisationId, reset.id);
    },
  };
}
