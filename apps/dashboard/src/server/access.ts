import { hasPermission, type Permission, type UserRole } from '@vhalcha/auth';

export async function readIfAllowed<T>(
  role: UserRole,
  permission: Permission,
  load: () => Promise<T>,
): Promise<T | null> {
  if (!hasPermission(role, permission)) {
    return null;
  }
  return load();
}
