import type { NextEditFormatSetting } from '../../config/settings';
import { chatXtabFormat } from './chatXtab';
import type { FormatId, NextEditFormat } from './format';
import { sweepFormat } from './sweep';

/** The format for a setting: `auto` picks by the model id (Zeta, Sweep, else chatXtab). */
export function formatIdFor(setting: NextEditFormatSetting, model: string | undefined): FormatId {
  if (setting !== 'auto') return setting;
  if (model !== undefined && /zeta/i.test(model)) return 'zeta21';
  if (model !== undefined && /sweep/i.test(model)) return 'sweep';
  return 'chatXtab';
}

/** Sweep's prompt layout: v2 for v2 and 7B models, else v1. */
export function sweepVariant(model: string | undefined): 'v1' | 'v2' {
  return model !== undefined && /v2|7b/i.test(model) ? 'v2' : 'v1';
}

export function pickFormat(setting: NextEditFormatSetting, model: string | undefined): NextEditFormat {
  switch (formatIdFor(setting, model)) {
    case 'sweep':
      return sweepFormat(sweepVariant(model));
    // zeta21 is not registered yet: it runs as chatXtab.
    case 'zeta21':
    case 'chatXtab':
      return chatXtabFormat;
  }
}
