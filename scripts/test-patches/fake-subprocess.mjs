// Fake ClaudeSubprocess for in-process testing of routes.js.
// Mimics the EventEmitter interface used by routes.js: emits content_delta,
// assistant, result, error, close. start() is a no-op that resolves.
import { EventEmitter } from "node:events";

export class FakeSubprocess extends EventEmitter {
  constructor() {
    super();
    this.startCalls = [];
    this.killCalls = 0;
    this._scripted = [];
  }
  // Test API: queue a sequence of events to emit on next start()
  script(events) { this._scripted = events; }
  start(prompt, options) {
    this.startCalls.push({ prompt, options });
    setImmediate(() => {
      for (const ev of this._scripted) {
        this.emit(ev.type, ev.payload);
      }
    });
    return Promise.resolve();
  }
  kill() { this.killCalls++; }
}
