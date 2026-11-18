import { describe, expect, test } from 'vitest';
import { DetectedModels, MISSED_DETECTION_MS } from '../../src/completion/detectedModels';

describe('DetectedModels', () => {
  test('remembers a detected model per backend instance', () => {
    const a = {};
    const b = {};
    const m = new DetectedModels<object>(() => 0);
    m.set(a, 'qwen');
    expect(m.get(a)).toBe('qwen');
    expect(m.get(b)).toBeUndefined();
    m.delete(a);
    expect(m.get(a)).toBeUndefined();
  });

  test('a failed detection is not tried again for 30 s', () => {
    let now = 1000;
    const backend = {};
    const m = new DetectedModels<object>(() => now);
    expect(m.shouldDetect(backend)).toBe(true);
    m.missed(backend);
    expect(m.shouldDetect(backend)).toBe(false);
    now += MISSED_DETECTION_MS - 1;
    expect(m.shouldDetect(backend)).toBe(false);
    now += 1;
    expect(m.shouldDetect(backend)).toBe(true);
    expect(MISSED_DETECTION_MS).toBe(30_000);
  });

  test('another instance (new settings) and forgetMisses detect again', () => {
    const backend = {};
    const m = new DetectedModels<object>(() => 0);
    m.missed(backend);
    expect(m.shouldDetect({})).toBe(true);
    m.forgetMisses();
    expect(m.shouldDetect(backend)).toBe(true);
  });

  test('a detected model clears the miss', () => {
    const backend = {};
    const m = new DetectedModels<object>(() => 0);
    m.missed(backend);
    m.set(backend, 'qwen');
    m.delete(backend);
    expect(m.shouldDetect(backend)).toBe(true);
  });
});
