// Demo driver for screenshots: runs inside the test VS Code's extension host.
const vscode = require('vscode');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const SIG = process.env.DEMO_SIG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function scene(name) {
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(300);
  fs.writeFileSync(path.join(SIG, `${name}.ready`), '');
  for (let i = 0; i < 600 && !fs.existsSync(path.join(SIG, `${name}.done`)); i++) await sleep(100);
}
const COMPLETION = 'return users\n    .filter((u) => u.age > age)\n    .sort((a, b) => a.name.localeCompare(b.name));';
const RENAMED = ['import math', '', '', 'def circle_area(radius):', '    return math.pi * radius ** 2', '', '', 'def circle_circumference(radius):', '    return 2 * math.pi * radius', '', '', 'def circle_diameter(r):', '    return 2 * r'];
function server() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const url = req.url.split('?')[0];
        const json = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
        if (url === '/props') return json({ model_alias: 'qwen2.5-coder-3b' });
        if (url === '/health') return json({ status: 'ok' });
        if (url.endsWith('/models')) return json({ object: 'list', data: [{ id: 'qwen2.5-coder-3b', object: 'model' }] });
        if (url === '/infill' || url === '/completion') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ content: COMPLETION })}\n\n`);
          return res.end(`data: ${JSON.stringify({ content: '', stop: true, stop_type: 'eos' })}\n\n`);
        }
        if (url.endsWith('/chat/completions')) {
          const ne = body.includes('code_to_edit');
          const text = ne ? '```\n' + RENAMED.join('\n') + '\n```\n' : '<COMPLETION></COMPLETION>';
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
          return res.end('data: [DONE]\n\n');
        }
        res.writeHead(404).end();
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
exports.run = async function () {
  const s = await server();
  const base = `http://127.0.0.1:${s.address().port}`;
  const cfg = vscode.workspace.getConfiguration('aiAutocomplete');
  const G = vscode.ConfigurationTarget.Global;
  await cfg.update('backends', [
    { id: 'llama-cpp', kind: 'llamacpp', baseUrl: base, fimModel: 'qwen2.5-coder-3b', use: ['completions'] },
    { id: 'strata', kind: 'openai', hostFlavor: 'strata', baseUrl: `${base}/v1`, nextEditModel: 'qwen3.8-flash-next', use: ['nextEdit'] },
  ], G);
  await cfg.update('fim.backend', 'llama-cpp', G);
  await cfg.update('nextEdit.backend', '', G);
  for (const k of ['enabled', 'fim.enabled', 'nextEdit.display']) await cfg.update(k, undefined, G);
  await sleep(800);
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await vscode.commands.executeCommand('workbench.action.closePanel');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  const root = vscode.workspace.workspaceFolders[0].uri;

  // Scene 1: ghost text completion.
  const ts = await vscode.window.showTextDocument(vscode.Uri.joinPath(root, 'users.ts'));
  ts.selection = new vscode.Selection(8, 2, 8, 2);
  for (let i = 0; i < 3; i++) {
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    await sleep(1500);
  }
  await scene('completion');

  // Scene 2: status bar menu.
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  void vscode.commands.executeCommand('aiAutocomplete.menu');
  await sleep(1500);
  await scene('menu');
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');

  // Scene 3: Next Edit after a rename (decorations without the native UI).
  await cfg.update('fim.enabled', false, G);
  await cfg.update('nextEdit.backend', 'strata', G);
  await cfg.update('nextEdit.display', 'decorations', G);
  await sleep(800);
  const py = await vscode.window.showTextDocument(vscode.Uri.joinPath(root, 'circle.py'));
  const line = py.document.lineAt(3).text;
  const at = line.indexOf('(r)') + 1;
  py.selection = new vscode.Selection(3, at, 3, at + 1);
  for (const k of 'radius') await vscode.commands.executeCommand('type', { text: k });
  py.selection = new vscode.Selection(4, 21, 4, 22);
  for (const k of 'radius') await vscode.commands.executeCommand('type', { text: k });
  await sleep(3500);
  await scene('nextedit');

  // Scene 4: the Backends page.
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('aiAutocomplete.manageBackends');
  await sleep(2500);
  await scene('backends');
  s.close();
};
