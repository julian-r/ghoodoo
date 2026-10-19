import { describe, expect, it } from "vitest";
import { parseReferences } from "../src/parser/references.js";

describe("parseReferences", () => {
	it("parses bare ODP references as ref action", () => {
		const result = parseReferences("Working on ODP-123");
		expect(result).toEqual([{ action: "ref", taskId: 123 }]);
	});

	it("parses Closes keyword as close action", () => {
		const result = parseReferences("Closes ODP-456");
		expect(result).toEqual([{ action: "close", taskId: 456 }]);
	});

	it("parses Fixes keyword as close action", () => {
		const result = parseReferences("Fixes ODP-789");
		expect(result).toEqual([{ action: "close", taskId: 789 }]);
	});

	it("parses Resolves keyword as close action", () => {
		const result = parseReferences("Resolves ODP-111");
		expect(result).toEqual([{ action: "close", taskId: 111 }]);
	});

	it("parses Refs keyword as ref action", () => {
		const result = parseReferences("Refs ODP-222");
		expect(result).toEqual([{ action: "ref", taskId: 222 }]);
	});

	it("parses References keyword as ref action", () => {
		const result = parseReferences("References ODP-333");
		expect(result).toEqual([{ action: "ref", taskId: 333 }]);
	});

	it("is case-insensitive", () => {
		const result = parseReferences("CLOSES odp-100\nfixes ODP-200");
		expect(result).toEqual([
			{ action: "close", taskId: 100 },
			{ action: "close", taskId: 200 },
		]);
	});

	it("parses multiple references in one text", () => {
		const result = parseReferences("Closes ODP-1\nrefs ODP-2, and mentions ODP-3");
		expect(result).toEqual([
			{ action: "close", taskId: 1 },
			{ action: "ref", taskId: 2 },
			{ action: "ref", taskId: 3 },
		]);
	});

	it("deduplicates repeated references", () => {
		const result = parseReferences("ODP-123 mentioned again ODP-123");
		expect(result).toEqual([{ action: "ref", taskId: 123 }]);
	});

	it("prioritizes close action when task appears multiple times", () => {
		const result = parseReferences("ODP-123 in title\n\nCloses ODP-123");
		expect(result).toEqual([{ action: "close", taskId: 123 }]);
	});

	it.each([
		"Resolves ODP-872 P2 and P3.",
		"- Resolves ODP-872 findings P2 and P3; the rest stays open.",
		"This resolves ODP-872 partially",
		"Not closes ODP-872",
		"> Closes ODP-872",
		"`Closes ODP-872`",
		"```text\nCloses ODP-872\n```",
		"~~~\nFixes ODP-872\n~~~",
		"prefixes ODP-872",
	])("keeps partial resolutions and examples reference-only: %s", (text) => {
		expect(parseReferences(text)).toEqual([{ action: "ref", taskId: 872 }]);
	});

	it("accepts a standalone directive with punctuation and CRLF", () => {
		expect(parseReferences("Summary\r\n  Resolves ODP-872.\r\n")).toEqual([
			{ action: "close", taskId: 872 },
		]);
	});

	it("returns empty array when no references found", () => {
		const result = parseReferences("No task references here");
		expect(result).toEqual([]);
	});

	it("handles multiline text", () => {
		const result = parseReferences(`
			PR Title: Feature implementation

			Closes ODP-500
			Also refs ODP-501
		`);
		expect(result).toEqual([
			{ action: "close", taskId: 500 },
			{ action: "ref", taskId: 501 },
		]);
	});

	it("handles references in markdown links", () => {
		const result = parseReferences("See [ODP-123](https://example.com) for details");
		expect(result).toEqual([{ action: "ref", taskId: 123 }]);
	});
});
