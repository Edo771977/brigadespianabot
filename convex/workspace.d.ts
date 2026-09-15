export declare const listPersona: import("convex/server").RegisteredQuery<"public", {
    agentId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"personaFiles">;
    _creationTime: number;
    name: "AGENTS.md" | "SOUL.md" | "IDENTITY.md" | "USER.md" | "TOOLS.md" | "BOOTSTRAP.md" | "MEMORY.md" | "HEARTBEAT.md";
    agentId: string;
    content: ArrayBuffer;
    updatedAt: number;
}[]>>;
export declare const getPersona: import("convex/server").RegisteredQuery<"public", {
    name: "AGENTS.md" | "SOUL.md" | "IDENTITY.md" | "USER.md" | "TOOLS.md" | "BOOTSTRAP.md" | "MEMORY.md" | "HEARTBEAT.md";
    agentId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"personaFiles">;
    _creationTime: number;
    name: "AGENTS.md" | "SOUL.md" | "IDENTITY.md" | "USER.md" | "TOOLS.md" | "BOOTSTRAP.md" | "MEMORY.md" | "HEARTBEAT.md";
    agentId: string;
    content: ArrayBuffer;
    updatedAt: number;
} | null>>;
export declare const writePersona: import("convex/server").RegisteredMutation<"public", {
    name: "AGENTS.md" | "SOUL.md" | "IDENTITY.md" | "USER.md" | "TOOLS.md" | "BOOTSTRAP.md" | "MEMORY.md" | "HEARTBEAT.md";
    agentId: string;
    content: ArrayBuffer;
}, Promise<{
    created: boolean;
}>>;
export declare const deletePersona: import("convex/server").RegisteredMutation<"public", {
    name: "AGENTS.md" | "SOUL.md" | "IDENTITY.md" | "USER.md" | "TOOLS.md" | "BOOTSTRAP.md" | "MEMORY.md" | "HEARTBEAT.md";
    agentId: string;
}, Promise<boolean>>;
export declare const getState: import("convex/server").RegisteredQuery<"public", {
    agentId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"workspaceState">;
    _creationTime: number;
    bootstrapSeededAt?: string | undefined;
    setupCompletedAt?: string | undefined;
    version: number;
    agentId: string;
} | null>>;
export declare const setBootstrapSeeded: import("convex/server").RegisteredMutation<"public", {
    agentId: string;
}, Promise<void>>;
export declare const setSetupCompleted: import("convex/server").RegisteredMutation<"public", {
    agentId: string;
}, Promise<void>>;
//# sourceMappingURL=workspace.d.ts.map