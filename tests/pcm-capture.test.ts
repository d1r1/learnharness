import assert from "node:assert/strict";
import { test } from "node:test";
import { PcmWorklet } from "./helpers/pcm-worklet.ts";

for (const length of [0, 1, 127, 128, 2047, 2048, 2049, 4105]) {
	test(`stop preserves every captured PCM sample exactly once (${length} samples)`, () => {
		const worklet = new PcmWorklet();
		const samples = Float32Array.from({ length }, (_, i) => (i % 151 - 75) / 60);
		const expected = Array.from(Int16Array.from(samples, value => {
			const sample = Math.max(-1, Math.min(1, value));
			return sample < 0 ? sample * 0x8000 : sample * 0x7fff;
		}));
		for (let i = 0; i < length; i += 128) worklet.process(samples.subarray(i, i + 128));
		worklet.port.postMessage({ type: "stop" });
		const audio = () => worklet.messages.filter(message => message.type === "audio").flatMap(message => Array.from(message.buffer!));
		assert.deepEqual(audio(), expected, "the final partial frame must precede acknowledgement");
		assert.equal(worklet.messages.at(-1)?.type, "stopped");
		assert.equal(worklet.process(new Float32Array([1, -1])), false, "a stopped processor captures no later samples");
		worklet.port.postMessage({ type: "stop" });
		assert.deepEqual(audio(), expected, "repeated stop cannot duplicate the tail");
	});
}
