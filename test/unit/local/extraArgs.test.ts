import { describe, expect, test } from 'vitest';
import { extraArgsToPreset, parseExtraArgs } from '../../../src/local/extraArgs';

describe('parseExtraArgs', () => {
  test('splits like a command line', () => {
    expect(parseExtraArgs('--threads 8 --no-mmap')).toEqual({ args: ['--threads', '8', '--no-mmap'] });
    expect(parseExtraArgs('--temp "0.2"').args).toEqual(['--temp', '0.2']);
    expect(parseExtraArgs("--chat-template 'a b'").args).toEqual(['--chat-template', 'a b']);
    expect(parseExtraArgs('--temp=0.2').args).toEqual(['--temp', '0.2']);
    expect(parseExtraArgs('--min-p -1').args).toEqual(['--min-p', '-1']);
    expect(parseExtraArgs('')).toEqual({ args: [] });
  });
  test.each([
    ['--port 1', '--port'], ['-c 4096', '-c'], ['--ctx-size 1', '--ctx-size'], ['-np 2', '-np'], ['--parallel 2', '--parallel'],
    ['--host 0.0.0.0', '--host'], ['-m x', '-m'], ['--model x', '--model'], ['--alias x', '--alias'], ['-a x', '-a'],
    ['--api-key k', '--api-key'], ['--api-key-file f', '--api-key-file'], ['--hf-repo x', '--hf-repo'], ['-hf x', '-hf'],
    ['--models-max 2', '--models-max'], ['--webui', '--webui'], ['--no-webui', '--no-webui'], ['--ssl-key-file f', '--ssl-key-file'],
    ['--path p', '--path'], ['--mmproj f', '--mmproj'], ['--threads 8 --port=1', '--port'],
  ])('refuses %s naming %s', (line, flag) => {
    expect(parseExtraArgs(line)).toEqual({ args: [], refused: flag });
  });
  test('refuses line breaks, bracket values, odd keys, stray values', () => {
    expect(parseExtraArgs('--threads 8\n--port 1').refused).toBeDefined();
    expect(parseExtraArgs('--threads 8\r').refused).toBeDefined();
    expect(parseExtraArgs('--foo [section]').refused).toBe('[section]');
    expect(parseExtraArgs('--foo=[x]').refused).toBeDefined();
    expect(parseExtraArgs('--a;b 1').refused).toBe('--a;b');
    expect(parseExtraArgs('8 --x').refused).toBe('8');
    expect(parseExtraArgs('--x "open').refused).toBeDefined();
  });
});

test('extraArgsToPreset', () => {
  expect(extraArgsToPreset(['--threads', '8', '--no-mmap'])).toEqual([['threads', '8'], ['no-mmap', 'true']]);
});
