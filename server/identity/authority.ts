import type { Context } from "../service";
import type { EmergencyAccess } from "./emergency";

// Only server-created request guard objects can carry this authority. It cannot
// be serialized into a browser body, copied into a credential, or inferred from
// an Owner role. Background/job guards intentionally never register here.
const emergencyGuards = new WeakMap<object, EmergencyAccess>();
export function registerEmergencyGuard<T extends object>(
  guard: T,
  authority: EmergencyAccess,
): T {
  emergencyGuards.set(guard, authority);
  return guard;
}
export function emergencyAuthority(ctx: Context): EmergencyAccess | undefined {
  if (ctx.credentialId || !ctx.authorization) return undefined;
  return emergencyGuards.get(ctx.authorization);
}
