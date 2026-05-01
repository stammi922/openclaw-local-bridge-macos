// Fixture: pre-patch routes.js (subprocess.start call site, post-rotator patch)
        // Start the subprocess
        subprocess.start(cliInput.prompt, {
            model: cliInput.model,
            sessionId: cliInput.sessionId,
        }).catch((err) => {
            console.error("[Streaming] Subprocess start error:", err);
            reject(err);
        });
