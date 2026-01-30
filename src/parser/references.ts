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
	const references: TaskReference[] = [];
	const seen = new Set<number>();

	for (const match of text.matchAll(REFERENCE_PATTERN)) {
		const keyword = match[1]?.toLowerCase();
		const taskId = Number.parseInt(match[2], 10);

		if (seen.has(taskId)) continue;
		seen.add(taskId);

		const action: ReferenceAction = keyword && CLOSE_KEYWORDS.includes(keyword) ? "close" : "ref";

		references.push({ action, taskId });
	}

	return references;
}
