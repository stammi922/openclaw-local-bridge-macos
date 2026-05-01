// Fixture: pre-patch manager.js (matches live vendored proxy shape, post-rotator/timeout patches)
function buildArgsImpl(prompt, options) {
    const mcp = mcpConfigPath();
    const args = [
        "--print",
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model", options.model,
        "--no-session-persistence",
        ...(mcp ? [
            "--mcp-config", mcp,
            "--strict-mcp-config",
            "--permission-mode", mcpPermissionMode(),
        ] : []),
        prompt,
    ];
    if (options.sessionId) {
        args.push("--session-id", options.sessionId);
    }
    return args;
}
