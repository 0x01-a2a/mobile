import { useState, useEffect, useCallback } from 'react';
import { NodeModule } from '../native/NodeModule';

export const PERMISSIONS = [
  'READ_CONTACTS',
  'WRITE_CONTACTS',
  'READ_SMS',
  'SEND_SMS',
  'ACCESS_FINE_LOCATION',
  'READ_CALENDAR',
  'WRITE_CALENDAR',
  'READ_CALL_LOG',
  'CAMERA',
  'RECORD_AUDIO',
  'READ_MEDIA_IMAGES',
] as const;

export type PermissionName = typeof PERMISSIONS[number];
export type PermissionMap  = Record<PermissionName, boolean>;

export function usePermissions() {
  const [perms, setPerms] = useState<PermissionMap | null>(null);

  const refresh = useCallback(async () => {
    const result = await NodeModule.checkPermissions();
    setPerms(result as PermissionMap);
  }, []);

  const request = useCallback(async (name: PermissionName): Promise<boolean> => {
    await NodeModule.requestPermission(name);
    // Re-read actual grant state after the dialog returns
    const updated = await NodeModule.checkPermissions();
    setPerms(updated as PermissionMap);
    return (updated as PermissionMap)[name] ?? false;
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { perms, refresh, request };
}
