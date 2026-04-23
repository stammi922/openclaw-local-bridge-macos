// Fixture: pre-patch manager.js (post-idleTimeout shape)
export class ClaudeSubprocess {
    async start(prompt, options) {
        return new Promise((resolve, reject) => {
            try {
                this.process = spawn("claude", args, {
                    cwd: options.cwd || process.cwd(),
                    env: { ...process.env },
                    stdio: ["pipe", "pipe", "pipe"],
                });
                const armIdleTimeout = () => {};
                armIdleTimeout();
                this.process.stderr?.on("data", (chunk) => {
                    armIdleTimeout();
                    const errorText = chunk.toString().trim();
                    if (errorText) {
                        // Don't emit as error unless it's actually an error
                        // Claude CLI may write debug info to stderr
                        console.error("[Subprocess stderr]:", errorText.slice(0, 200));
                    }
                });
            } catch (err) { reject(err); }
        });
    }
}
