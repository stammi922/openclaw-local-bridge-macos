// Fixture: pre-patch routes.js (contains ONLY the anchor region for patch testing)
export async function handleChatCompletions(req, res) {
    try {
        const body = req.body;
        const cliInput = openaiToCli(body);
        const subprocess = new ClaudeSubprocess();
        await subprocess.start(cliInput, {});
    } catch (err) {
        console.error(err);
    }
}
