// This entry is created only for a bounded backend analysis request.
const { parentPort } = require('node:worker_threads');
const { join } = require('node:path');
const engine = require(join(__dirname, 'engine', 'stockfish-19-lite-single.js'))();
engine.listener = line => parentPort.postMessage(line);
parentPort.on('message', line => engine.processCommand(line));
