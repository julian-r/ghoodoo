export type ReferenceAction = "close" | "ref";

export interface TaskReference {
	action: ReferenceAction;
	taskId: number;
}

// Closing is an explicit whole-task directive, not a keyword in prose.
// In particular, "Resolves ODP-872 P2 and P3" is only a reference.
const CLOSE_DIRECTIVE = /^(?:closes|fixes|resolves)[ \t]+ODP-(\d+)\.?$/i;
const REFERENCE_PATTERN = /ODP-(\d+)/gi;

export function parseReferences(text: string): TaskReference[] {
	const closingIds = new Set<number>();
	let fence: string | undefined;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		const marker = /^(\x60{3,}|~{3,})/.exec(trimmed)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
			continue;
		}
		if (fence) continue;
		const directive = CLOSE_DIRECTIVE.exec(trimmed);
		if (directive) closingIds.add(Number.parseInt(directive[1], 10));
	}

	const references = new Map<number, TaskReference>();
	for (const match of text.matchAll(REFERENCE_PATTERN)) {
		const taskId = Number.parseInt(match[1], 10);
		if (!references.has(taskId)) {
			references.set(taskId, { action: closingIds.has(taskId) ? "close" : "ref", taskId });
		}
	}
	return [...references.values()];
}
