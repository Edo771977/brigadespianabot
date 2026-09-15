export declare const appendSessionEvent: import("convex/server").RegisteredMutation<"public", {
    attempt?: number | undefined;
    role?: string | undefined;
    errorMessage?: string | undefined;
    delayMs?: number | undefined;
    aborted?: boolean | undefined;
    result?: ArrayBuffer | undefined;
    toolName?: string | undefined;
    content?: ArrayBuffer | undefined;
    toolCallId?: string | undefined;
    isError?: boolean | undefined;
    args?: ArrayBuffer | undefined;
    inner?: string | undefined;
    delta?: string | undefined;
    stopReason?: string | undefined;
    maxAttempts?: number | undefined;
    success?: boolean | undefined;
    finalError?: string | undefined;
    willRetry?: boolean | undefined;
    messageCount?: number | undefined;
    type: string;
    agentId: string;
    sessionKey: string;
    ts: string;
    day: string;
    ownerId: string;
}, Promise<void>>;
export declare const readSessionEventTail: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    day?: string | undefined;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"sessionEvents">;
    _creationTime: number;
    attempt?: number | undefined;
    role?: string | undefined;
    errorMessage?: string | undefined;
    delayMs?: number | undefined;
    aborted?: boolean | undefined;
    result?: ArrayBuffer | undefined;
    toolName?: string | undefined;
    content?: ArrayBuffer | undefined;
    toolCallId?: string | undefined;
    isError?: boolean | undefined;
    args?: ArrayBuffer | undefined;
    inner?: string | undefined;
    delta?: string | undefined;
    stopReason?: string | undefined;
    maxAttempts?: number | undefined;
    success?: boolean | undefined;
    finalError?: string | undefined;
    willRetry?: boolean | undefined;
    messageCount?: number | undefined;
    type: string;
    agentId: string;
    sessionKey: string;
    ts: string;
    day: string;
    ownerId: string;
}[]>>;
export declare const findLastError: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"sessionEvents">;
    _creationTime: number;
    attempt?: number | undefined;
    role?: string | undefined;
    errorMessage?: string | undefined;
    delayMs?: number | undefined;
    aborted?: boolean | undefined;
    result?: ArrayBuffer | undefined;
    toolName?: string | undefined;
    content?: ArrayBuffer | undefined;
    toolCallId?: string | undefined;
    isError?: boolean | undefined;
    args?: ArrayBuffer | undefined;
    inner?: string | undefined;
    delta?: string | undefined;
    stopReason?: string | undefined;
    maxAttempts?: number | undefined;
    success?: boolean | undefined;
    finalError?: string | undefined;
    willRetry?: boolean | undefined;
    messageCount?: number | undefined;
    type: string;
    agentId: string;
    sessionKey: string;
    ts: string;
    day: string;
    ownerId: string;
} | null>>;
export declare const appendSubsystemRecord: import("convex/server").RegisteredMutation<"public", {
    fields?: any;
    message: string;
    time: string;
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    subsystem: string;
    day: string;
    ownerId: string;
}, Promise<void>>;
export declare const readSubsystemRecords: import("convex/server").RegisteredQuery<"public", {
    level?: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | undefined;
    subsystem?: string | undefined;
    limit?: number | undefined;
    day?: string | undefined;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"subsystemLog">;
    _creationTime: number;
    fields?: any;
    message: string;
    time: string;
    level: string;
    subsystem: string;
    day: string;
    ownerId: string;
}[]>>;
export declare const pruneSubsystemLogs: import("convex/server").RegisteredMutation<"public", {
    ownerId: string;
    olderThanMs: number;
}, Promise<{
    removed: number;
}>>;
export declare const appendConfigAudit: import("convex/server").RegisteredMutation<"public", {
    pid?: number | undefined;
    bytes: number;
    sha256: string;
    ts: string;
    instanceId: string;
}, Promise<{
    pid?: number | undefined;
    prevHash?: string | undefined;
    instanceId: string;
    ts: string;
    sha256: string;
    bytes: number;
    seq: number;
    lineHash: string;
}>>;
export declare const listConfigAudit: import("convex/server").RegisteredQuery<"public", {
    limit?: number | undefined;
    instanceId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"brigadeConfigAudit">;
    _creationTime: number;
    pid?: number | undefined;
    prevHash?: string | undefined;
    bytes: number;
    sha256: string;
    ts: string;
    instanceId: string;
    lineHash: string;
    seq: number;
}[]>>;
export declare const writeConfigHealth: import("convex/server").RegisteredMutation<"public", {
    bytes: number;
    sha256: string;
    pid: number;
    mtimeMs: number;
    ts: string;
    ownerId: string;
    configPath: string;
}, Promise<void>>;
export declare const readConfigHealth: import("convex/server").RegisteredQuery<"public", {
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"configHealth">;
    _creationTime: number;
    bytes: number;
    sha256: string;
    pid: number;
    mtimeMs: number;
    ts: string;
    ownerId: string;
    configPath: string;
} | null>>;
//# sourceMappingURL=logs.d.ts.map