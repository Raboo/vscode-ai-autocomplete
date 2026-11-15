import { describe, expect, test } from 'vitest';
import { Capabilities, isRouteMissing, usableRoutes } from '../../src/models/capabilities';
import { HttpError } from '../../src/backends/http';

describe('Capabilities', () => {
  test('learns per backend and model, reports only what is new, and clears', () => {
    const c = new Capabilities();
    expect(c.get('a', 'm')).toEqual({ rejected: new Set(), failedRoutes: new Set(), thinks: false });
    expect(c.reject('a', 'm', ['top_k', 'thinking'])).toEqual(['top_k', 'thinking']);
    expect(c.reject('a', 'm', ['top_k', 'reasoning'])).toEqual(['reasoning']);
    expect(c.get('a', 'm').rejected).toEqual(new Set(['top_k', 'thinking', 'reasoning']));
    expect(c.get('a', 'other').rejected.size).toBe(0);
    expect(c.get('b', 'm').rejected.size).toBe(0);
    expect(c.get('a', undefined).rejected.size).toBe(0);
    expect(c.failRoute('a', 'm', 'native')).toBe(true);
    expect(c.failRoute('a', 'm', 'native')).toBe(false);
    expect(c.get('a', 'm').failedRoutes).toEqual(new Set(['native']));
    c.clear();
    expect(c.get('a', 'm')).toEqual({ rejected: new Set(), failedRoutes: new Set(), thinks: false });
  });
  test('forgetLearned clears thinks and failed routes, keeps rejected fields', () => {
    const c = new Capabilities();
    c.failRoute('a', 'm', 'native');
    c.failRoute('a', undefined, 'template');
    c.failRoute('b', 'm', 'native');
    c.reject('a', 'm', ['top_k']);
    c.sawThinking('a', 'm');
    c.sawThinking('b', 'm');
    c.forgetLearned('a');
    expect(c.get('a', 'm').failedRoutes.size).toBe(0);
    expect(c.get('a', undefined).failedRoutes.size).toBe(0);
    expect(c.get('a', 'm').thinks).toBe(false);
    expect(c.get('a', 'm').rejected).toEqual(new Set(['top_k']));
    expect(c.get('b', 'm').failedRoutes).toEqual(new Set(['native']));
    expect(c.get('b', 'm').thinks).toBe(true);
  });
  test('sawThinking is true once', () => {
    const c = new Capabilities();
    expect(c.sawThinking('a', 'm')).toBe(true);
    expect(c.sawThinking('a', 'm')).toBe(false);
    expect(c.get('a', 'm').thinks).toBe(true);
  });
  test('usableRoutes drops failed routes', () => {
    const caps = { native: true, template: true, chat: true, nativeChatModels: true };
    expect(usableRoutes(caps, new Set(['native', 'chat']))).toEqual({ native: false, template: true, chat: false, nativeChatModels: true });
  });
});

describe('isRouteMissing', () => {
  const http = (status: number, body = ''): HttpError => new HttpError(status, body, 'http://x');
  test('404, 405 and 501', () => {
    for (const s of [404, 405, 501]) expect(isRouteMissing(http(s))).toBe(true);
  });
  test('an Ollama 400 that names insert', () => {
    expect(isRouteMissing(http(400, 'qwen3 does not support insert'))).toBe(true);
    expect(isRouteMissing(http(400, 'exceed_context_size_error'))).toBe(false);
  });
  test('other errors are not', () => {
    expect(isRouteMissing(new TypeError('fetch failed'))).toBe(false);
    expect(isRouteMissing(http(500))).toBe(false);
  });
  test('a 404 that mentions a model is a missing model, not a missing route', () => {
    expect(isRouteMissing(http(404, 'model "x" not found, try pulling it first'))).toBe(false);
    expect(isRouteMissing(http(404, '{"error":{"message":"not found"}}'))).toBe(true);
  });
});
