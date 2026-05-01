// Fixture: pre-patch routes.js (BOTH subprocess.start call sites, post-rotator patch)
        // Start the subprocess (streaming branch)
        subprocess.start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
        }).catch((err) => {
            console.error("[Streaming] Subprocess start error:", err);
            reject(err);
        });
        // Start the subprocess (non-streaming branch — chained-call formatting from upstream bundler)
        subprocess
            .start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
        })
            .catch((error) => {
            res.status(500).json({
                error: {
                    message: `Claude CLI startup failed: ${error.message}`,
                    type: "server_error",
                    code: null,
                },
            });
        });
