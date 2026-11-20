import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const wfDir = '.github/workflows';
const workflows = readdirSync(wfDir).filter((f) => f.endsWith('.yml'));

describe('repo automation', () => {
  test('expected workflows exist', () => {
    expect(workflows.sort()).toEqual(['ci.yml', 'codeql.yml', 'dependabot-automerge.yml', 'release-please.yml']);
  });

  test('every workflow action is pinned to a full commit SHA', () => {
    for (const f of workflows) {
      const uses = [...readFileSync(`${wfDir}/${f}`, 'utf8').matchAll(/^\s*-?\s*uses:\s*(.+)$/gm)].map((m) => m[1].trim());
      expect(uses.length, f).toBeGreaterThan(0);
      for (const u of uses) {
        if (u.startsWith('./')) continue;
        expect(u, `${f}: ${u}`).toMatch(/@[0-9a-f]{40}(\s+#.*)?$/);
      }
    }
  });

  test('every workflow declares top-level permissions', () => {
    for (const f of workflows) expect(readFileSync(`${wfDir}/${f}`, 'utf8'), f).toMatch(/^permissions:/m);
  });

  test('every job declares timeout-minutes', () => {
    for (const f of workflows) {
      const text = readFileSync(`${wfDir}/${f}`, 'utf8');
      const jobsPart = text.slice(text.search(/^jobs:/m));
      const jobs = [...jobsPart.matchAll(/^ {2}[\w-]+:$/gm)].length;
      const timeouts = [...jobsPart.matchAll(/^ {4}timeout-minutes: \d+$/gm)].length;
      expect(timeouts, f).toBe(jobs);
    }
  });

  test('CI job ids are check and integration', () => {
    const ci = readFileSync(`${wfDir}/ci.yml`, 'utf8');
    expect(ci).toMatch(/^ {2}check:$/m);
    expect(ci).toMatch(/^ {2}integration:$/m);
    expect(ci).not.toMatch(/^ {4}name:/m);
  });

  test('the check job runs actionlint pinned by version and sha256', () => {
    const ci = readFileSync(`${wfDir}/ci.yml`, 'utf8');
    expect(ci).toMatch(/ACTIONLINT_VERSION: \d+\.\d+\.\d+/);
    expect(ci).toMatch(/ACTIONLINT_SHA256: [0-9a-f]{64}/);
    expect(ci).toContain('sha256sum -c');
  });

  test('release-please manifest matches package.json version', () => {
    expect(JSON.parse(readFileSync('.release-please-manifest.json', 'utf8'))['.']).toBe(pkg.version);
  });

  test('the vsix job publishes to Open VSX with the token only in the environment', () => {
    const rp = readFileSync(`${wfDir}/release-please.yml`, 'utf8');
    const vsix = rp.slice(rp.search(/^ {2}vsix:/m));
    expect(vsix).toContain('npx ovsx publish');
    expect(vsix).toContain('npx ovsx create-namespace raboo');
    expect(vsix).toMatch(/OVSX_PAT: \$\{\{ secrets\.OPEN_VSX_TOKEN \}\}/);
    expect(vsix).toMatch(/if \[ -z "\$OVSX_PAT" \]/);
    for (const line of vsix.split('\n').filter((l) => !/^\s*(OVSX_PAT:|#)/.test(l))) {
      expect(line, line).not.toMatch(/OPEN_VSX_TOKEN|ovsx .*(--pat|-p )|\$OVSX_PAT.*ovsx/);
    }
  });

  test('release-please has a manual workflow_dispatch with a tag input, validated before use', () => {
    const rp = readFileSync(`${wfDir}/release-please.yml`, 'utf8');
    expect(rp).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+tag:\n[\s\S]*?required: true/);
    expect(rp).toContain("github.event_name != 'workflow_dispatch'");
    expect(rp).toContain('grep -Eq');
    const runBlocks = [...rp.matchAll(/^ +run: \|\n((?: {10,}.*\n|\n)+)/gm)].map((m) => m[1]);
    expect(runBlocks.length).toBeGreaterThan(1);
    for (const b of runBlocks) expect(b).not.toContain('${{');
  });

  test('dependabot covers npm and github-actions and holds back pinned packages', () => {
    const d = readFileSync('.github/dependabot.yml', 'utf8');
    expect(d).toMatch(/package-ecosystem: "?npm"?/);
    expect(d).toMatch(/package-ecosystem: "?github-actions"?/);
    const vscodeIgnore = d.match(/dependency-name: "?@types\/vscode"?[\s\S]*?(?=\n\s*- dependency-name|\n\s*- package-ecosystem|$)/);
    expect(vscodeIgnore?.[0]).toContain('version-update:semver-minor');
    expect(vscodeIgnore?.[0]).toContain('version-update:semver-major');
    const tsIgnore = d.match(/dependency-name: "?typescript"?[\s\S]*?(?=\n\s*- dependency-name|\n\s*- package-ecosystem|$)/);
    expect(tsIgnore?.[0]).toMatch(/">=6\.1\.0"/);
  });

  test('setup script dry run prints the expected settings', () => {
    const out = execFileSync('bash', ['scripts/setup-github-repo.sh', '--dry-run', 'o/r'], { encoding: 'utf8' });
    for (const s of ['enable-auto-merge', 'delete-branch-on-merge', 'can_approve_pull_request_reviews', 'vulnerability-alerts', 'automated-security-fixes', '"context": "check"', '"context": "integration"']) {
      expect(out).toContain(s);
    }
  });
});
