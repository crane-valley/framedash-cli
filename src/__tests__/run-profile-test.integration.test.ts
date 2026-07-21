import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProfileTest } from "../commands/run-profile-test.js";

describe("run-profile-test process integration", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns after a real child process exits and fresh ingest appears", async () => {
		let buildRequests = 0;
		const server = createServer((request, response) => {
			expect(request.headers["x-api-key"]).toBe("analytics-key");
			expect(request.url).toContain("/api/v1/projects/project-id/builds?");
			buildRequests++;
			const builds = buildRequests === 1 ? [] : [{ build_id: "candidate-build", event_count: "1" }];
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ success: true, data: builds }));
		});

		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test server did not bind");

		try {
			await runProfileTest([
				"--command",
				`"${process.execPath}" -e "process.exit(0)"`,
				"--build-id",
				"candidate-build",
				"--poll-interval",
				"0.01",
				"--ingest-timeout",
				"1",
				"--api-key",
				"analytics-key",
				"--project-id",
				"project-id",
				"--base-url",
				`http://127.0.0.1:${address.port}`,
			]);
			expect(buildRequests).toBe(2);
		} finally {
			server.close();
			await once(server, "close");
		}
	});
});
