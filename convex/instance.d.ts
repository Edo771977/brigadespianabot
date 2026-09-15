export declare const getCoord: import("convex/server").RegisteredQuery<"public", {
    instanceId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"gatewayCoord">;
    _creationTime: number;
    pid?: number | undefined;
    pidAliveAt?: number | undefined;
    heartbeatTs?: number | undefined;
    heartbeatPid?: number | undefined;
    heartbeatUptimeMs?: number | undefined;
    lockPid?: number | undefined;
    lockPort?: number | undefined;
    lockCreatedAt?: string | undefined;
    lockLeaseUntil?: number | undefined;
    updatedAt: number;
    instanceId: string;
} | null>>;
export declare const writePid: import("convex/server").RegisteredMutation<"public", {
    pid: number;
    instanceId: string;
}, Promise<void>>;
export declare const clearPid: import("convex/server").RegisteredMutation<"public", {
    instanceId: string;
}, Promise<void>>;
export declare const writeHeartbeat: import("convex/server").RegisteredMutation<"public", {
    pid: number;
    ts: number;
    uptimeMs: number;
    instanceId: string;
}, Promise<void>>;
export declare const clearHeartbeat: import("convex/server").RegisteredMutation<"public", {
    instanceId: string;
}, Promise<void>>;
//# sourceMappingURL=instance.d.ts.map