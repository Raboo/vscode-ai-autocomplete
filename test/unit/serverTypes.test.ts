import { describe, expect, test } from 'vitest';
import { SERVER_TYPES, serverTypeOf, suggestId } from '../../src/manage/serverTypes';

describe('server types', () => {
  test('table matches the spec', () => {
    expect(SERVER_TYPES.map((t) => t.id)).toEqual(['llamacpp', 'lmstudio', 'ollama', 'vllm', 'sglang', 'mistral', 'deepseek', 'fireworks', 'together', 'other']);
    const by = (id: string) => SERVER_TYPES.find((t) => t.id === id);
    expect(by('lmstudio')).toMatchObject({ kind: 'openai', hostFlavor: 'lmstudio', defaultUrl: 'http://127.0.0.1:1234/v1', key: 'no' });
    expect(by('mistral')).toMatchObject({ kind: 'mistral', defaultModel: 'codestral-latest', defaultUrl: 'https://codestral.mistral.ai', key: 'yes' });
    expect(by('llamacpp')).toMatchObject({ kind: 'llamacpp', defaultUrl: 'http://127.0.0.1:8012', key: 'no' });
    expect(by('vllm')?.key).toBe('optional');
    expect(by('deepseek')).toMatchObject({ defaultUrl: 'https://api.deepseek.com/beta', key: 'yes' });
    expect(by('other')).toMatchObject({ kind: 'openai', hostFlavor: 'generic', defaultUrl: '', key: 'optional' });
  });

  test('serverTypeOf infers LM Studio from port 1234 and maps unlisted pairs to other', () => {
    expect(serverTypeOf({ kind: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' })).toBe('lmstudio');
    expect(serverTypeOf({ kind: 'openai', hostFlavor: 'ollama', baseUrl: 'http://x/v1' })).toBe('ollama');
    expect(serverTypeOf({ kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8012' })).toBe('llamacpp');
    expect(serverTypeOf({ kind: 'mistral', baseUrl: 'https://codestral.mistral.ai' })).toBe('mistral');
    expect(serverTypeOf({ kind: 'openai', baseUrl: 'https://example.com/v1' })).toBe('other');
    expect(serverTypeOf({ kind: 'openai', hostFlavor: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })).toBe('other');
    expect(serverTypeOf({ kind: 'llamacpp', hostFlavor: 'vllm', baseUrl: 'http://x' })).toBe('other');
  });

  test('suggestId', () => {
    expect(suggestId('lmstudio', [])).toBe('lmstudio');
    expect(suggestId('lmstudio', ['lmstudio'])).toBe('lmstudio-2');
    expect(suggestId('lmstudio', ['lmstudio', 'lmstudio-2'])).toBe('lmstudio-3');
    expect(suggestId('mistral', [])).toBe('codestral');
    expect(suggestId('other', [])).toBe('openai');
  });
});
