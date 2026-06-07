import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			experimentalAstAwareRemapping: true,
			reporter: ["text-summary", "json-summary"],
			reportsDirectory: "./coverage",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts", "src/**/__tests__/**", "src/**/*.d.ts"],
			reportOnFailure: true,
			excludeAfterRemap: true,
			thresholds: {
				statements: 60,
				branches: 60,
				functions: 60,
				lines: 60,
			},
		},
	},
});
