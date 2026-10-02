'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { auditActions } from '@vhalcha/audit';
import type { UserRole } from '@vhalcha/types';
import { assertRoleChange } from '@vhalcha/auth';
import { getServices, invalidateVirtualKey, permissionError, repositories, requirePermission } from './services';
import { sessionCookieOptions } from './session-cookie';

async function setSessionCookie(token: string) {
  (await cookies()).set('vh_session', token, sessionCookieOptions(getServices().config.VHALCHA_ENV));
}

export async function signIn(formData: FormData) {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  try {
    const result = await getServices().auth.signIn({ email, password });
    await setSessionCookie(result.token);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'The email or password is incorrect.' };
  }
  redirect('/overview');
}

export async function signOut() {
  const session = await getServices().auth.getSession((await cookies()).get('vh_session')?.value ?? '');
  if (session) {
    await getServices().auth.signOut(session.claims.oid, session.sessionId);
  }
  (await cookies()).delete('vh_session');
  redirect('/sign-in');
}

export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get('email') ?? '');
  await getServices().auth.requestPasswordReset(email);
  return {
    message:
      'If an account exists for that email, a reset link has been issued. In development, the link is written to the dashboard server log.',
  };
}

export async function resetPassword(formData: FormData) {
  const token = String(formData.get('token') ?? '');
  const password = String(formData.get('password') ?? '');
  try {
    await getServices().auth.resetPassword(token, password);
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'The password could not be reset.' };
  }
  redirect('/sign-in');
}

export async function registerSystem(formData: FormData) {
  try {
    const session = await requirePermission('ai_systems:write');
    await requirePermission('budgets:write');
    const repos = repositories();
    const registered = await repos.registerAiSystem({
      organisationId: session.claims.oid,
      name: String(formData.get('name') ?? '').trim(),
      description: String(formData.get('description') ?? '').trim(),
      type: String(formData.get('type') ?? 'application'),
      environmentId: String(formData.get('environmentId') ?? ''),
      riskLevel: String(formData.get('riskLevel') ?? 'low'),
      monthlyBudgetUsd: Number(formData.get('monthlyBudgetUsd') ?? 0),
      modelPattern: String(formData.get('modelPattern') ?? '').trim(),
      requestsPerMinute: Number(formData.get('requestsPerMinute') ?? 60),
      ownerUserId: session.claims.uid,
      actorUserId: session.claims.uid,
      generateKey: formData.get('generateKey') === 'on',
    });
    return {
      systemId: registered.system.id,
      rawKey: registered.key?.rawKey ?? null,
    };
  } catch (error) {
    return { error: permissionError(error) };
  }
}

export async function setSystemStatus(aiSystemId: string, status: 'active' | 'disabled') {
  const session = await requirePermission('ai_systems:write');
  const repos = repositories();
  const system = await repos.aiSystems.findById(session.claims.oid, aiSystemId);
  if (!system) {
    return;
  }
  await repos.aiSystems.setStatus(session.claims.oid, aiSystemId, status);
  await repos.audit.create(session.claims.oid, {
    organisationId: session.claims.oid,
    environmentId: system.environmentId,
    actorType: 'user',
    actorId: session.claims.uid,
    action: auditActions.systemStatusChanged,
    resourceType: 'ai_system',
    resourceId: aiSystemId,
    result: 'success',
    severity: 'info',
    metadata: { ai_system_id: aiSystemId, status },
  });
  redirect(`/systems/${aiSystemId}`);
}

export async function createVirtualKey(aiSystemId: string) {
  try {
    const session = await requirePermission('api_keys:write');
    const repos = repositories();
    const system = await repos.aiSystems.findById(session.claims.oid, aiSystemId);
    const environment = system
      ? await repos.environments.findById(session.claims.oid, system.environmentId)
      : null;
    if (!system || !environment) {
      return { error: 'The AI system was not found.' };
    }
    const created = await repos.apiKeys.insert({
      organisationId: session.claims.oid,
      aiSystemId,
      environmentId: system.environmentId,
      name: `${system.name} key`,
      environmentType: environment.type as 'development' | 'staging' | 'production',
    });
    await repos.audit.create(session.claims.oid, {
      organisationId: session.claims.oid,
      environmentId: system.environmentId,
      actorType: 'user',
      actorId: session.claims.uid,
      action: auditActions.keyCreated,
      resourceType: 'virtual_api_key',
      resourceId: created.record.id,
      result: 'success',
      severity: 'info',
      metadata: { ai_system_id: aiSystemId, key_prefix: created.record.keyPrefix },
    });
    return { rawKey: created.rawKey };
  } catch (error) {
    return { error: permissionError(error) };
  }
}

export async function revokeVirtualKey(aiSystemId: string, keyId: string) {
  const session = await requirePermission('api_keys:write');
  const repos = repositories();
  const existing = await repos.apiKeys.revoke(session.claims.oid, keyId);
  if (!existing || existing.aiSystemId !== aiSystemId) {
    return;
  }
  await invalidateVirtualKey(existing.keyHash);
  await repos.audit.create(session.claims.oid, {
    organisationId: session.claims.oid,
    environmentId: existing.environmentId,
    actorType: 'user',
    actorId: session.claims.uid,
    action: auditActions.keyRevoked,
    resourceType: 'virtual_api_key',
    resourceId: keyId,
    result: 'success',
    severity: 'warning',
    metadata: { ai_system_id: aiSystemId, key_prefix: existing.keyPrefix },
  });
  redirect(`/systems/${aiSystemId}?tab=keys`);
}

export async function rotateVirtualKey(aiSystemId: string, keyId: string) {
  try {
    const session = await requirePermission('api_keys:write');
    const repos = repositories();
    const existing = await repos.apiKeys.findById(session.claims.oid, keyId);
    if (!existing || existing.aiSystemId !== aiSystemId) {
      return { error: 'The API key was not found.' };
    }
    await repos.apiKeys.revoke(session.claims.oid, keyId);
    await invalidateVirtualKey(existing.keyHash);
    const environment = await repos.environments.findById(session.claims.oid, existing.environmentId);
    if (!environment) {
      return { error: 'The environment was not found.' };
    }
    const created = await repos.apiKeys.insert({
      organisationId: session.claims.oid,
      aiSystemId,
      environmentId: existing.environmentId,
      name: existing.name,
      environmentType: environment.type as 'development' | 'staging' | 'production',
    });
    await repos.audit.create(session.claims.oid, {
      organisationId: session.claims.oid,
      environmentId: existing.environmentId,
      actorType: 'user',
      actorId: session.claims.uid,
      action: auditActions.keyRotated,
      resourceType: 'virtual_api_key',
      resourceId: created.record.id,
      result: 'success',
      severity: 'warning',
      metadata: { ai_system_id: aiSystemId, key_prefix: created.record.keyPrefix },
    });
    return { rawKey: created.rawKey };
  } catch (error) {
    return { error: permissionError(error) };
  }
}

export async function updateBudget(formData: FormData) {
  try {
    const session = await requirePermission('budgets:write');
    const repos = repositories();
    const budgetId = String(formData.get('budgetId') ?? '');
    const amount = Number(formData.get('amountUsd') ?? '');
    const threshold = Number(formData.get('warningThresholdPercent') ?? 80);
    const action = String(formData.get('action') ?? 'block') === 'notify' ? 'notify' : 'block';
    if (!Number.isFinite(amount) || amount < 0 || threshold < 1 || threshold > 100) {
      return { error: 'Enter a valid budget amount and warning threshold.' };
    }
    const updated = await repos.budgets.update(session.claims.oid, budgetId, {
      amountUsd: amount,
      warningThresholdPercent: threshold,
      hardLimit: action === 'block',
      action,
    });
    if (!updated) {
      return { error: 'The budget was not found.' };
    }
    await repos.audit.create(session.claims.oid, {
      organisationId: session.claims.oid,
      actorType: 'user',
      actorId: session.claims.uid,
      action: auditActions.budgetUpdated,
      resourceType: 'budget',
      resourceId: budgetId,
      result: 'success',
      severity: 'info',
      metadata: { amount_usd: amount, action },
    });
    return { ok: true };
  } catch (error) {
    return { error: permissionError(error) };
  }
}

function settingsPath(section: string, notice?: string) {
  const query = new URLSearchParams({ section });
  if (notice) {
    query.set('notice', notice);
  }
  return `/settings?${query.toString()}`;
}

export async function updateOrganisation(formData: FormData) {
  let notice: string | undefined;
  try {
    const session = await requirePermission('organisations:write');
    const name = String(formData.get('name') ?? '').trim();
    if (!name) {
      notice = 'Organisation name is required.';
    } else {
      await repositories().organisations.update(session.claims.oid, {
        name,
        timezone: String(formData.get('timezone') ?? 'UTC').trim(),
      });
    }
  } catch (error) {
    notice = permissionError(error);
  }
  redirect(settingsPath('organisation', notice));
}

export async function updateUserRole(formData: FormData) {
  let notice: string | undefined;
  try {
    const session = await requirePermission('users:write');
    const repos = repositories();
    const userId = String(formData.get('userId') ?? '');
    const role = String(formData.get('role') ?? '') as UserRole;
    const allowed: UserRole[] = [
      'owner',
      'ai_admin',
      'developer',
      'security_admin',
      'finance_manager',
      'viewer',
    ];
    if (!allowed.includes(role)) {
      notice = 'Unknown role.';
    } else {
      const users = await repos.users.list(session.claims.oid);
      const target = users.find((user) => user.id === userId);
      const owners = users.filter((user) => user.role === 'owner');
      if (!target) {
        notice = 'User was not found.';
      } else {
        assertRoleChange({
          actorRole: session.role,
          targetCurrentRole: target.role as UserRole,
          nextRole: role,
          ownerCount: owners.length,
        });
        if (target.role !== role) {
          await repos.users.updateRole(session.claims.oid, userId, role);
          await repos.audit.create(session.claims.oid, {
            organisationId: session.claims.oid,
            actorType: 'user',
            actorId: session.claims.uid,
            action: auditActions.userRoleChanged,
            resourceType: 'user',
            resourceId: target.id,
            result: 'success',
            severity: 'warning',
            metadata: {
              target_user_id: target.id,
              previous_role: target.role,
              new_role: role,
            },
          });
        }
      }
    }
  } catch (error) {
    notice = permissionError(error);
  }
  redirect(settingsPath('users', notice));
}

export async function createEnvironment(formData: FormData) {
  let notice: string | undefined;
  try {
    const session = await requirePermission('environments:write');
    const type = String(formData.get('type') ?? 'development');
    const name = String(formData.get('name') ?? '').trim();
    if (type !== 'development' && type !== 'staging' && type !== 'production') {
      notice = 'Unknown environment type.';
    } else if (!name) {
      notice = 'Environment name is required.';
    } else {
      await repositories().environments.create({
        organisationId: session.claims.oid,
        name,
        type,
      });
    }
  } catch (error) {
    notice = permissionError(error);
  }
  redirect(settingsPath('environments', notice));
}

export async function createProviderConnection(formData: FormData) {
  let notice: string | undefined;
  try {
    const session = await requirePermission('providers:write');
    const source = String(formData.get('credentialSource') ?? 'platform_env');
    if (source === 'customer_managed') {
      notice = 'Customer-managed credentials require a key management service. That is not available in V1.';
    } else {
      await repositories().providerConnections.create({
        organisationId: session.claims.oid,
        environmentId: String(formData.get('environmentId') ?? ''),
        provider: 'openai',
        name: String(formData.get('name') ?? 'OpenAI').trim(),
        credentialSource: 'platform_env',
        credentialRef: 'OPENAI_API_KEY',
      });
    }
  } catch (error) {
    notice = permissionError(error);
  }
  redirect(settingsPath('providers', notice));
}
