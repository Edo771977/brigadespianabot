export declare const list: import("convex/server").RegisteredQuery<"public", {
    agentId?: string | null | undefined;
    source?: "bundled" | "config" | "managed" | "personal" | "project" | "workspace" | undefined;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"skills">;
    _creationTime: number;
    createdAt: number;
    name: string;
    agentId: string | null;
    source: "bundled" | "config" | "managed" | "personal" | "project" | "workspace";
    description: string;
    body: string;
    updatedAt: number;
    ownerId: string;
    frontmatter: string;
    eligibility: {
        os: string[];
        requiresBins: string[];
        requiresAnyBins: string[];
        requiresEnv: string[];
        requiresConfig: string[];
    };
    disableModelInvocation: boolean;
}[]>>;
export declare const get: import("convex/server").RegisteredQuery<"public", {
    name: string;
    ownerId: string;
}, Promise<{
    _id: import("convex/values").GenericId<"skills">;
    _creationTime: number;
    createdAt: number;
    name: string;
    agentId: string | null;
    source: "bundled" | "config" | "managed" | "personal" | "project" | "workspace";
    description: string;
    body: string;
    updatedAt: number;
    ownerId: string;
    frontmatter: string;
    eligibility: {
        os: string[];
        requiresBins: string[];
        requiresAnyBins: string[];
        requiresEnv: string[];
        requiresConfig: string[];
    };
    disableModelInvocation: boolean;
} | null>>;
export declare const upsert: import("convex/server").RegisteredMutation<"public", {
    name: string;
    agentId: string | null;
    source: "bundled" | "config" | "managed" | "personal" | "project" | "workspace";
    description: string;
    body: string;
    ownerId: string;
    frontmatter: string;
    eligibility: {
        os: string[];
        requiresBins: string[];
        requiresAnyBins: string[];
        requiresEnv: string[];
        requiresConfig: string[];
    };
    disableModelInvocation: boolean;
}, Promise<{
    created: boolean;
}>>;
export declare const remove: import("convex/server").RegisteredMutation<"public", {
    name: string;
    ownerId: string;
}, Promise<boolean>>;
//# sourceMappingURL=skills.d.ts.map