export declare const list: import("convex/server").RegisteredQuery<"public", {}, Promise<{
    _id: import("convex/values").GenericId<"extensions">;
    _creationTime: number;
    config?: ArrayBuffer | undefined;
    bundleBytes?: ArrayBuffer | undefined;
    manifest?: any;
    bundleSha?: string | undefined;
    createdAt: number;
    enabled: boolean;
    createdBy: string;
    moduleId: string;
    updatedAt: number;
    origin: "bundled" | "user";
    sourceLabel: string;
}[]>>;
export declare const upsert: import("convex/server").RegisteredMutation<"public", {
    config?: ArrayBuffer | undefined;
    bundleBytes?: ArrayBuffer | undefined;
    manifest?: any;
    bundleSha?: string | undefined;
    enabled: boolean;
    createdBy: string;
    moduleId: string;
    origin: "bundled" | "user";
    sourceLabel: string;
}, Promise<void>>;
export declare const remove: import("convex/server").RegisteredMutation<"public", {
    moduleId: string;
}, Promise<boolean>>;
//# sourceMappingURL=extensions.d.ts.map