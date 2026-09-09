
// vscode-companion/extension.js
//
// Minimal companion extension for Lily's voice-triggered VSCode edits.
// Separate from Continue — Continue only executes tool calls in response
// to requests it initiates itself, so a voice command reaching in from
// outside has to bypass it. This extension is that bypass: it exposes the
// active editor over a small local HTTP server so Lily's STTS tool
// (edit_active_vscode_file in discord/tools/sttsTools.js) can read the
// currently open file and write an edit back in, applied through
// vscode.workspace.applyEdit so it shows up as a normal, undo-able,
// reviewable change — not a silent disk write.
//
// Must be installed as a real extension (vsce package + code
// --install-extension), NOT run via F5/"Run Extension" — that launches a
// separate Extension Development Host window, which would track the
// active editor in that debug window instead of your real editing window.
const vscode = require('vscode')
const http = require('http')

const PORT = process.env.LILY_COMPANION_PORT
    ? parseInt(process.env.LILY_COMPANION_PORT, 10)
    : 8768

function sendJson(res, status, body) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
    })
    res.end(payload)
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = ''
        req.on('data', chunk => { data += chunk })
        req.on('end', () => resolve(data))
        req.on('error', reject)
    })
}

function activate(context) {
    const server = http.createServer(async (req, res) => {
        try {
            // Only ever bound to localhost (see listen() below), but check
            // the peer address defensively too — this endpoint can write
            // to files and has no auth of its own.
            const remote = req.socket.remoteAddress
            if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
                return sendJson(res, 403, { error: 'forbidden' })
            }

            if (req.method === 'GET' && req.url === '/active-file') {
                const editor = vscode.window.activeTextEditor
                if (!editor) return sendJson(res, 404, { error: 'no active editor' })

                return sendJson(res, 200, {
                    path: editor.document.uri.fsPath,
                    content: editor.document.getText(),
                    languageId: editor.document.languageId,
                    isDirty: editor.document.isDirty,
                })
            }

            if (req.method === 'POST' && req.url === '/apply-edit') {
                const raw = await readBody(req)
                let body
                try { body = JSON.parse(raw) } catch { return sendJson(res, 400, { error: 'invalid json' }) }

                const { path: filePath, content } = body
                if (!filePath || typeof content !== 'string') {
                    return sendJson(res, 400, { error: 'path and content required' })
                }

                const uri = vscode.Uri.file(filePath)
                const doc = await vscode.workspace.openTextDocument(uri)
                const fullRange = new vscode.Range(
                    doc.positionAt(0),
                    doc.positionAt(doc.getText().length)
                )

                const edit = new vscode.WorkspaceEdit()
                edit.replace(uri, fullRange, content)

                const applied = await vscode.workspace.applyEdit(edit)
                if (!applied) return sendJson(res, 500, { error: 'applyEdit failed' })

                // Show it so the change is visible immediately, but don't
                // save automatically — leave it as a reviewable, undo-able
                // (Ctrl+Z) dirty buffer.
                await vscode.window.showTextDocument(doc, { preview: false })

                return sendJson(res, 200, { applied: true })
            }

            sendJson(res, 404, { error: 'not found' })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
    })

    server.listen(PORT, '127.0.0.1', () => {
        console.log(`[Lily Companion] listening on http://127.0.0.1:${PORT}`)
    })

    context.subscriptions.push({ dispose: () => server.close() })
}

function deactivate() { }

module.exports = { activate, deactivate }
// API responses are handled gracefully with consistent JSON status codes and clear error messages for each endpoint.
