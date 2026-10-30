export const spaceRoles = [
  "Read",
  "Triage",
  "Write",
  "Maintain",
  "Admin",
] as const;
export type SpaceRole = (typeof spaceRoles)[number];
export interface AccessSpace {
  id: string;
  name: string;
  ownerId: string | null;
  orgId: string | null;
  organization: string | null;
  visibility: "private" | "team";
  role: SpaceRole;
  revision: number;
}
export interface AccessInvitation {
  id: string;
  orgId: string;
  organization: string;
  workspaceId: string | null;
  space: string | null;
  principalId: string;
  role: string;
  expiresAt: string;
  status: string;
}
export interface AccessState {
  managed: boolean;
  bootstrapAllowed: boolean;
  space: AccessSpace | null;
  capabilities: {
    manageSpace: boolean;
    manageOrganization: boolean;
    triage: boolean;
  };
  members: {
    principalId: string;
    name: string;
    role: SpaceRole | null;
    organizationRole: string | null;
    paths: string[];
  }[];
  teams: { id: string; name: string; members: string[] }[];
  grants: {
    id: string;
    principalId: string | null;
    teamId: string | null;
    role: SpaceRole;
    expiresAt: string | null;
  }[];
  reviewers: string[];
  invitations: AccessInvitation[];
  audit: {
    actorId: string;
    operation: string;
    resourceId: string;
    details: Record<string, unknown>;
    at: string;
  }[];
}
