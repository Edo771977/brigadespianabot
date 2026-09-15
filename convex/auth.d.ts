export declare const listProfiles: import("convex/server").RegisteredQuery<"public", {
    agentId: string;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"authProfiles">;
    _creationTime: number;
    metadata?: any;
    alias?: string | undefined;
    expires?: number | undefined;
    keyEnc?: ArrayBuffer | undefined;
    keyRef?: {
        id: string;
        source: string;
        provider: string;
    } | undefined;
    tokenEnc?: ArrayBuffer | undefined;
    tokenRef?: {
        id: string;
        source: string;
        provider: string;
    } | undefined;
    accessEnc?: ArrayBuffer | undefined;
    refreshEnc?: ArrayBuffer | undefined;
    type: "api_key" | "oauth" | "token";
    profileId: string;
    agentId: string;
    provider: string;
    updatedAt: number;
    ownerId: string;
}[]>>;
export declare const getProfile: import("convex/server").RegisteredQuery<"public", {
    profileId: string;
    agentId: string;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"authProfiles">;
    _creationTime: number;
    metadata?: any;
    alias?: string | undefined;
    expires?: number | undefined;
    keyEnc?: ArrayBuffer | undefined;
    keyRef?: {
        id: string;
        source: string;
        provider: string;
    } | undefined;
    tokenEnc?: ArrayBuffer | undefined;
    tokenRef?: {
        id: string;
        source: string;
        provider: string;
    } | undefined;
    accessEnc?: ArrayBuffer | undefined;
    refreshEnc?: ArrayBuffer | undefined;
    type: "api_key" | "oauth" | "token";
    profileId: string;
    agentId: string;
    provider: string;
    updatedAt: number;
    ownerId: string;
} | null>>;
export declare const upsertProfile: import("convex/server").RegisteredMutation<"public", {
    metadata?: any;
    alias?: string | undefined;
    expires?: number | undefined;
    keyEnc?: ArrayBuffer | undefined;
    keyRef?: {
        id: string;
        source: string;
        provider: string;
    } | undefined;
    tokenEnc?: ArrayBuffer | undefined;
    tokenRef?: {
        id: string;
        source: string;
        provider: string;
    } | undefined;
    accessEnc?: ArrayBuffer | undefined;
    refreshEnc?: ArrayBuffer | undefined;
    type: "api_key" | "oauth" | "token";
    profileId: string;
    agentId: string;
    provider: string;
    ownerId: string;
}, Promise<{
    profileId: string;
    updated: boolean;
}>>;
export declare const deleteProfile: import("convex/server").RegisteredMutation<"public", {
    profileId: string;
    agentId: string;
    ownerId: string;
}, Promise<{
    deleted: boolean;
}>>;
export declare const loadState: import("convex/server").RegisteredQuery<"public", {
    agentId: string;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"profileState">;
    _creationTime: number;
    disabledUntil?: number | undefined;
    cooldownUntil?: number | undefined;
    cooldownModel?: string | undefined;
    errorCount?: number | undefined;
    lastUsed?: number | undefined;
    cooldownReason?: string | undefined;
    disabledReason?: string | undefined;
    failureCounts?: any;
    lastFailureAt?: number | undefined;
    explicitOrder?: number | undefined;
    profileId: string;
    agentId: string;
    provider: string;
    ownerId: string;
    isLastGood: boolean;
}[]>>;
export declare const readAuthFile: import("convex/server").RegisteredQuery<"public", {
    kind: "auth-state" | "profile-state" | "models";
    agentId: string;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"authFiles">;
    _creationTime: number;
    kind: "auth-state" | "profile-state" | "models";
    agentId: string;
    payload: ArrayBuffer;
    updatedAt: number;
    ownerId: string;
} | null>>;
export declare const writeAuthFile: import("convex/server").RegisteredMutation<"public", {
    kind: "auth-state" | "profile-state" | "models";
    agentId: string;
    payload: ArrayBuffer;
    ownerId: string;
}, Promise<{
    updated: boolean;
}>>;
export declare const upsertState: import("convex/server").RegisteredMutation<"public", {
    disabledUntil?: number | undefined;
    cooldownUntil?: number | undefined;
    cooldownModel?: string | undefined;
    errorCount?: number | undefined;
    lastUsed?: number | undefined;
    cooldownReason?: string | undefined;
    disabledReason?: string | undefined;
    failureCounts?: any;
    lastFailureAt?: number | undefined;
    explicitOrder?: number | undefined;
    profileId: string;
    agentId: string;
    provider: string;
    ownerId: string;
    isLastGood: boolean;
}, Promise<{
    profileId: string;
    updated: boolean;
}>>;
//# sourceMappingURL=auth.d.ts.map