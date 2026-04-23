export type ReferenceAction = "close" | "ref";

export interface TaskReference {
	action: ReferenceAction;
	taskId: number;
}

const CLOSE_KEYWORDS = ["closes", "fixes", "resolves"];
const REF_KEYWORDS = ["refs", "references"];

const REFERENCE_PATTERN = new RegExp(
	`(?:(${[...CLOSE_KEYWORDS, ...REF_KEYWORDS].join("|")})\\s+)?ODP-(\\d+)`,
	"gi",
);

export function parseReferences(text: string): TaskReference[] {
	const references = new Map<number, TaskReference>();

	for (const match of text.matchAll(REFERENCE_PATTERN)) {
		const keyword = match[1]?.toLowerCase();
		const taskId = Number.parseInt(match[2], 10);
		const action: ReferenceAction = keyword && CLOSE_KEYWORDS.includes(keyword) ? "close" : "ref";
		const existing = references.get(taskId);

		if (!existing) {
			references.set(taskId, { action, taskId });
			continue;
		}

		// Prefer close semantics if the same task appears multiple times
		if (existing.action === "ref" && action === "close") {
			references.set(taskId, { action: "close", taskId });
		}
	}

	return [...references.values()];
}
