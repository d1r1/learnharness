import test from "node:test";
import assert from "node:assert/strict";

// After a device lock WebKit leaves the shared context "interrupted"; resume() may resolve without running it.
const created: FakeContext[] = [];
class FakeContext {
	state: string;
	closed = false;
	audioWorklet = { addModule: async () => {} };
	constructor() {
		this.state = created.length === 0 ? "interrupted" : "suspended";
		created.push(this);
	}
	async resume() { if (created.indexOf(this) > 0) this.state = "running"; }
	async close() { this.closed = true; this.state = "closed"; }
}
(globalThis as Record<string, unknown>).AudioContext = FakeContext;
const { runningAudioGraph } = await import("../components/dictation.tsx");

test("an interrupted shared context that will not resume is replaced, and a running one is reused", async () => {
	const ctx = await runningAudioGraph();
	assert.equal(created.length, 2);
	assert.equal(created[0]?.closed, true);
	assert.equal(ctx, created[1]);
	assert.equal(ctx.state, "running");
	assert.equal(await runningAudioGraph(), ctx);
	assert.equal(created.length, 2);
});
