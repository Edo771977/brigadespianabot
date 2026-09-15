export declare const list: import("convex/server").RegisteredQuery<"public", {
    agentId: string;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"execApprovals">;
    _creationTime: number;
    createdAt: number;
    kind: "exact" | "pattern";
    agentId: string;
    value: string;
    ownerId: string;
    valueNormalised: string;
}[]>>;
export declare const insert: import("convex/server").RegisteredMutation<"public", {
    kind: "exact" | "pattern";
    agentId: string;
    value: string;
    ownerId: string;
    valueNormalised: string;
}, Promise<{
    inserted: boolean;
}>>;
export declare const remove: import("convex/server").RegisteredMutation<"public", {
    agentId: string;
    ownerId: string;
    valueNormalised: string;
}, Promise<{
    removedCommands: number;
    removedPatterns: number;
}>>;
//# sourceMappingURL=execApprovals.d.ts.map