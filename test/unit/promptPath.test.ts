import { describe, expect, test } from 'vitest';
import { promptPath } from '../../src/completion/promptPath';

describe('promptPath', () => {
  test('a project file keeps its workspace-relative path', () => {
    expect(promptPath('/home/u/repo/src/a.ts', 'src/a.ts', true)).toBe('src/a.ts');
  });

  test('a file outside the project is named by its file name only, never its absolute path', () => {
    expect(promptPath('/home/u/secret-client/notes/plan.md', '/home/u/secret-client/notes/plan.md', false)).toBe('plan.md');
    expect(promptPath('/c:/Users/u/Desktop/x.py', 'c:\\Users\\u\\Desktop\\x.py', false)).toBe('x.py');
    expect(promptPath('/', '/', false)).toBe('');
  });
});
