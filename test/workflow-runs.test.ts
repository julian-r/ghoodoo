import { describe, expect, it, vi } from "vitest";
import {
	handleWorkflowRunEvent,
	isTrackedWorkflowFailure,
	isWorkflowRunEvent,
	parseWorkflowFailureConfig,
	type WorkflowRunEvent,
	workflowFailureTaskName,
} from "../src/github/workflow-runs.js";
import type { OdooClient } from "../src/odoo/client.js";

const config = { projectId: 2, workflows: new Set(["owner/repo:CI"]) };

function failedRun(overrides: Partial<WorkflowRunEvent["workflow_run"]> = {}): WorkflowRunEvent {
	return {
		action: "completed",
		workflow_run: {
			id: 4321,
			run_attempt: 1,
			run_number: 77,
			name: "CI",
			event: "schedule",
			conclusion: "failure",
			head_branch: "sprint/current",
			head_sha: "0123456789abcdef",
			html_url: "https://github.com/owner/repo/actions/runs/4321",
			...overrides,
		},
		repository: { full_name: "owner/repo", default_branch: "sprint/current" },
	};
}

/** No note of the run, no task of the workflow, no task that names the run: a first failure. */
function odooMock(overrides: Partial<OdooClient> = {}): OdooClient {
	return {
		findTaskByEffect: vi.fn().mockResolvedValue(null),
		findOpenTask: vi.fn().mockResolvedValue(null),
		findTaskByDescription: vi.fn().mockResolvedValue(null),
		createTask: vi.fn().mockResolvedValue(900),
		addMessage: vi.fn().mockResolvedValue(1),
		...overrides,
	} as unknown as OdooClient;
}

describe("parseWorkflowFailureConfig", () => {
	it("needs a project ID and at least one workflow", () => {
		expect(parseWorkflowFailureConfig(undefined, "owner/repo:CI")).toBeNull();
		expect(parseWorkflowFailureConfig("2", undefined)).toBeNull();
		expect(parseWorkflowFailureConfig("2", " , ")).toBeNull();
		expect(parseWorkflowFailureConfig("x", "owner/repo:CI")).toBeNull();
		expect(parseWorkflowFailureConfig("2", " owner/repo:CI , owner/other:Nightly ")).toEqual({
			projectId: 2,
			workflows: new Set(["owner/repo:CI", "owner/other:Nightly"]),
		});
	});
});

describe("isTrackedWorkflowFailure", () => {
	it("tracks a failed scheduled run of a configured workflow on the default branch", () => {
		expect(isTrackedWorkflowFailure(failedRun(), config)).toBe(true);
		expect(isTrackedWorkflowFailure(failedRun({ conclusion: "timed_out" }), config)).toBe(true);
		expect(isTrackedWorkflowFailure(failedRun({ conclusion: "startup_failure" }), config)).toBe(
			true,
		);
	});

	it.each([
		["a success", { conclusion: "success" }],
		["a cancelled run", { conclusion: "cancelled" }],
		["a pull request run", { event: "pull_request" }],
		["a manual run", { event: "workflow_dispatch" }],
		["another branch", { head_branch: "sprint/old" }],
		["another workflow", { name: "Docs" }],
	])("ignores %s", (_case, overrides) => {
		expect(isTrackedWorkflowFailure(failedRun(overrides), config)).toBe(false);
	});

	it("ignores runs that are not completed", () => {
		expect(isTrackedWorkflowFailure({ ...failedRun(), action: "in_progress" }, config)).toBe(false);
	});
});

describe("isWorkflowRunEvent", () => {
	it("accepts the fields the module reads and rejects malformed payloads", () => {
		expect(isWorkflowRunEvent(failedRun())).toBe(true);
		expect(isWorkflowRunEvent(null)).toBe(false);
		expect(isWorkflowRunEvent({ action: "completed" })).toBe(false);
		expect(isWorkflowRunEvent({ ...failedRun(), repository: undefined })).toBe(false);
		expect(isWorkflowRunEvent(failedRun({ id: "4321" as unknown as number }))).toBe(false);
		expect(isWorkflowRunEvent(failedRun({ head_branch: null, conclusion: null }))).toBe(true);
	});
});

describe("handleWorkflowRunEvent", () => {
	it("creates the workflow's task and notes the run on a first failure", async () => {
		const odoo = odooMock();
		const result = await handleWorkflowRunEvent(failedRun(), odoo, config, { deliveryId: "d1" });

		expect(result).toEqual({ processed: 1, errors: [] });
		expect(odoo.createTask).toHaveBeenCalledWith(
			expect.objectContaining({ project_id: 2, name: workflowFailureTaskName("owner/repo", "CI") }),
		);
		expect(odoo.addMessage).toHaveBeenCalledWith(
			900,
			expect.stringContaining('href="https://github.com/owner/repo/actions/runs/4321"'),
			undefined,
			{ id: expect.stringMatching(/^workflow-failure-[0-9a-f]{16}-run-4321-1$/) },
		);
	});

	it("keys the notes by workflow, so another workflow gets another task", async () => {
		const odoo = odooMock();
		await handleWorkflowRunEvent(failedRun(), odoo, config, { deliveryId: "d1" });
		const tracked = { projectId: 2, workflows: new Set(["owner/repo:Nightly"]) };
		await handleWorkflowRunEvent(failedRun({ name: "Nightly" }), odoo, tracked, {
			deliveryId: "d2",
		});
		const [first, second] = vi.mocked(odoo.findOpenTask).mock.calls;
		expect(first[1]).toMatch(/^workflow-failure-[0-9a-f]{16}-run-$/);
		expect(first[2]).toBe(`[${first[1].slice(0, -"-run-".length)}]`);
		expect(second[1]).not.toBe(first[1]);
	});

	it("notes a later run on the open task of the workflow", async () => {
		const odoo = odooMock({ findOpenTask: vi.fn().mockResolvedValue(555) });
		await handleWorkflowRunEvent(failedRun({ id: 4400, run_attempt: 2 }), odoo, config, {
			deliveryId: "d2",
		});

		expect(odoo.createTask).not.toHaveBeenCalled();
		expect(odoo.addMessage).toHaveBeenCalledWith(
			555,
			expect.stringContaining("attempt 2"),
			undefined,
			{ id: expect.stringMatching(/-run-4400-2$/) },
		);
	});

	it("adds nothing when a retry finds the run noted, also on a task closed since", async () => {
		const odoo = odooMock({ findTaskByEffect: vi.fn().mockResolvedValue(555) });
		const result = await handleWorkflowRunEvent(failedRun(), odoo, config, { deliveryId: "d4" });

		expect(result).toEqual({ processed: 1, errors: [] });
		expect(vi.mocked(odoo.findTaskByEffect).mock.calls[0][1]).toBe("exact");
		expect(odoo.createTask).not.toHaveBeenCalled();
		expect(odoo.addMessage).not.toHaveBeenCalled();
	});

	it("notes the run on the task this attempt created but did not note", async () => {
		const odoo = odooMock({ findTaskByDescription: vi.fn().mockResolvedValueOnce(777) });
		await handleWorkflowRunEvent(failedRun(), odoo, config, { deliveryId: "d5" });

		expect(odoo.findTaskByDescription).toHaveBeenCalledWith(
			expect.stringMatching(/^\[workflow-failure-[0-9a-f]{16}-run-4321-1\]$/),
		);
		expect(odoo.createTask).not.toHaveBeenCalled();
		expect(odoo.addMessage).toHaveBeenCalledWith(777, expect.any(String), undefined, {
			id: expect.any(String),
		});
	});

	it("writes both keys into a new task's description", async () => {
		const odoo = odooMock();
		await handleWorkflowRunEvent(failedRun(), odoo, config, { deliveryId: "d8" });
		const { description } = vi.mocked(odoo.createTask).mock.calls[0][0];
		expect(description).toMatch(
			/\[workflow-failure-[0-9a-f]{16}\] \[workflow-failure-[0-9a-f]{16}-run-4321-1\]/,
		);
	});

	it("reports an Odoo failure as a processing error, so the queue retries", async () => {
		const odoo = odooMock({ createTask: vi.fn().mockRejectedValue(new Error("access denied")) });
		const result = await handleWorkflowRunEvent(failedRun(), odoo, config, { deliveryId: "d6" });

		expect(result.processed).toBe(0);
		expect(result.errors).toEqual([
			`${workflowFailureTaskName("owner/repo", "CI")}: access denied`,
		]);
	});

	it("escapes the workflow name and the run URL", async () => {
		const odoo = odooMock();
		const tracked = { projectId: 2, workflows: new Set(["owner/repo:<b>CI</b>"]) };
		await handleWorkflowRunEvent(
			failedRun({ name: "<b>CI</b>", html_url: 'https://github.com/x"><script>' }),
			odoo,
			tracked,
			{ deliveryId: "d7" },
		);
		const values = vi.mocked(odoo.createTask).mock.calls[0][0];
		expect(values.description).toContain("&lt;b&gt;CI&lt;/b&gt;");
		expect(values.description).not.toContain("<script>");
		const note = vi.mocked(odoo.addMessage).mock.calls[0][1];
		expect(note).toContain("&quot;&gt;&lt;script&gt;");
		expect(note).not.toContain("<script>");
	});
});

/** A small stateful Odoo: tasks with descriptions and open flags, notes with effect IDs. */
class FakeOdoo {
	tasks = new Map<number, { description: string; open: boolean }>();
	notes: Array<{ taskId: number; effect: string }> = [];
	failNextNote = false;
	private nextId = 900;

	findTaskByEffect = async (id: string, match: "exact" | "prefix") => {
		const hits = this.notes.filter((note) =>
			match === "exact" ? note.effect === id : note.effect.startsWith(id),
		);
		return hits.at(-1)?.taskId ?? null;
	};
	// Like Odoo: in any project and also when archived (the task's project or archive flag
	// does not matter for this lookup, so the fake keeps neither).
	findTaskByDescription = async (text: string) =>
		[...this.tasks].filter(([, task]) => task.description.includes(text)).at(-1)?.[0] ?? null;
	findOpenTask = async (_projectId: number, notePrefix: string, descriptionKey: string) =>
		[...this.tasks]
			.reverse()
			.find(
				([id, task]) =>
					task.open &&
					(task.description.includes(descriptionKey) ||
						this.notes.some((note) => note.taskId === id && note.effect.startsWith(notePrefix))),
			)?.[0] ?? null;
	reopen = (taskId: number) => {
		const task = this.tasks.get(taskId);
		if (task) task.open = true;
	};
	close = (taskId: number) => {
		const task = this.tasks.get(taskId);
		if (task) task.open = false;
	};
	createTask = async (values: { description: string }) => {
		const id = this.nextId++;
		this.tasks.set(id, { description: values.description, open: true });
		return id;
	};
	addMessage = async (taskId: number, _body: string, _author: unknown, effect: { id: string }) => {
		if (this.failNextNote) {
			this.failNextNote = false;
			throw new Error("network");
		}
		this.notes.push({ taskId, effect: effect.id });
		return this.notes.length;
	};
}

describe("handleWorkflowRunEvent recovery", () => {
	const deliver = (odoo: FakeOdoo, run: WorkflowRunEvent) =>
		handleWorkflowRunEvent(run, odoo as unknown as OdooClient, config, { deliveryId: "d" });

	it("keeps one task when another run arrives between a failed note and its retry", async () => {
		const odoo = new FakeOdoo();
		odoo.failNextNote = true;
		expect((await deliver(odoo, failedRun({ id: 4321 }))).errors).toHaveLength(1);
		await deliver(odoo, failedRun({ id: 4400 }));
		await deliver(odoo, failedRun({ id: 4321 }));

		expect([...odoo.tasks.keys()]).toEqual([900]);
		expect(odoo.notes.map((note) => note.taskId)).toEqual([900, 900]);
	});

	it("opens a new task for a new attempt after the task was closed", async () => {
		const odoo = new FakeOdoo();
		await deliver(odoo, failedRun({ id: 4321, run_attempt: 1 }));
		odoo.close(900);
		await deliver(odoo, failedRun({ id: 4321, run_attempt: 2 }));

		expect([...odoo.tasks.keys()]).toEqual([900, 901]);
		expect(odoo.notes.map((note) => note.taskId)).toEqual([900, 901]);
	});

	it("does nothing when a retry finds its run noted on a task closed since", async () => {
		const odoo = new FakeOdoo();
		await deliver(odoo, failedRun());
		odoo.close(900);
		await deliver(odoo, failedRun());

		expect(odoo.tasks.size).toBe(1);
		expect(odoo.notes).toHaveLength(1);
	});

	it("collects later runs on the open task and starts a new one after closing", async () => {
		const odoo = new FakeOdoo();
		await deliver(odoo, failedRun({ id: 1 }));
		await deliver(odoo, failedRun({ id: 2 }));
		odoo.close(900);
		await deliver(odoo, failedRun({ id: 3 }));

		expect(odoo.notes.map((note) => note.taskId)).toEqual([900, 900, 901]);
	});

	it("finds a reopened older task when a newer one is closed", async () => {
		const odoo = new FakeOdoo();
		await deliver(odoo, failedRun({ id: 1 }));
		odoo.close(900);
		await deliver(odoo, failedRun({ id: 2 }));
		odoo.close(901);
		odoo.reopen(900);
		await deliver(odoo, failedRun({ id: 3 }));

		expect([...odoo.tasks.keys()]).toEqual([900, 901]);
		expect(odoo.notes.map((note) => note.taskId)).toEqual([900, 901, 900]);
	});
});
