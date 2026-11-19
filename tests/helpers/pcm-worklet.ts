import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Message = { type: string; buffer?: Int16Array; rms?: number };
type Port = { onmessage?: (event: { data: unknown }) => void; postMessage: (data: unknown) => void };
const source = readFileSync(new URL("../../public/worklets/pcm-capture.js", import.meta.url), "utf8");

/** Run the shipped processor; only the browser's graph and message transport are mocked. */
export class PcmWorklet {
	static all: PcmWorklet[] = [];
	autoStop = true;
	disconnected = false;
	messages: Message[] = [];
	requests: unknown[] = [];
	private processor: { port: Port; process(inputs: Float32Array[][]): boolean };
	port: Port = { postMessage: data => {
		this.requests.push(data);
		if (this.autoStop) this.processor.port.onmessage?.({ data });
	} };
	constructor() {
		const emit = (data: Message, transfer: ArrayBuffer[] = []) => {
			const message = structuredClone(data, { transfer });
			this.messages.push(message); this.port.onmessage?.({ data: message });
		};
		let Processor!: new () => PcmWorklet["processor"];
		runInNewContext(source, {
			AudioWorkletProcessor: class { port = { postMessage: emit }; },
			registerProcessor(_name: string, constructor: typeof Processor) { Processor = constructor; },
		});
		this.processor = new Processor(); PcmWorklet.all.push(this);
	}
	process(samples: Float32Array) { return this.processor.process([[samples]]); }
	completeStop() { this.processor.port.onmessage?.({ data: { type: "stop" } }); }
	connect() {}
	disconnect() { this.disconnected = true; }
}
