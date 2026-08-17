export const CURSOR_AGENT_MODE_ID = 'agent';
export const CURSOR_PLAN_MODE_ID = 'plan';
export const CURSOR_ASK_MODE_ID = 'ask';

export function resolveCursorModeForPermissionMode(permissionMode: unknown): string {
  return permissionMode === 'plan' ? CURSOR_PLAN_MODE_ID : CURSOR_AGENT_MODE_ID;
}

export function resolvePermissionModeForCursorMode(
  modeId: unknown,
  fallback: 'normal' | 'yolo' = 'normal',
): 'normal' | 'plan' | 'yolo' | null {
  if (modeId === CURSOR_PLAN_MODE_ID) {
    return 'plan';
  }
  if (modeId === CURSOR_AGENT_MODE_ID) {
    return fallback;
  }
  if (modeId === CURSOR_ASK_MODE_ID) {
    return 'normal';
  }
  return null;
}
