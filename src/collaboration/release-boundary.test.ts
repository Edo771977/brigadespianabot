import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

interface PackageManifest {
	files?: string[];
}

describe("Team Mode release boundary", () => {
	it("ships the headless runtime without product UI assets", async () => {
		const manifestUrl = new URL("../../package.json", import.meta.url);
		const manifest = JSON.parse(await readFile(manifestUrl, "utf8")) as PackageManifest;
		const shippedFiles = manifest.files ?? [];

		assert.equal(
			shippedFiles.some((entry) => entry.startsWith("examples/")),
			false,
			"Team Mode UI assets must not enter the headless npm artifact",
		);
		assert.ok(shippedFiles.includes("dist/**/*"), "the compiled Team Mode runtime must remain in the npm artifact");
		assert.ok(shippedFiles.includes("docs/team-mode.md"), "the Team Mode protocol documentation must ship");
	});
});
