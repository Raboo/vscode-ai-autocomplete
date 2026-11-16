import type { NextEditFormatSetting } from '../../config/settings';
import { chatXtabFormat } from './chatXtab';
import type { FormatId, NextEditFormat } from './format';
import { sweepFormat } from './sweep';
import { zeta21Format } from './zeta21';

/** The format for a setting: `auto` picks by the model id (Zeta, Sweep, else chatXtab). */
export function formatIdFor(setting: NextEditFormatSetting, model: string | undefined): FormatId {
  if (setting !== 'auto') return setting;
  if (model !== undefined && /zeta/i.test(model)) return 'zeta21';
  if (model !== undefined && /sweep/i.test(model)) return 'sweep';
  return 'chatXtab';
}

/** The Next Edit format a model id belongs to when only Next Edit can use it: Zeta and Sweep models, which cannot do ghost-text completions. */
export function nextEditOnlyModel(model: string | undefined): 'Zeta 2.1' | 'Sweep' | undefined {
  switch (formatIdFor('auto', model)) {
    case 'zeta21':
      return 'Zeta 2.1';
    case 'sweep':
      return 'Sweep';
    case 'chatXtab':
      return undefined;
  }
}

/** The warning for a Next Edit-only model used for completions: `text` names the model, `hint` says what to change. */
export function nextEditOnlyNote(model: string | undefined): { text: string; hint: string } | undefined {
  const name = nextEditOnlyModel(model);
  if (name === undefined || model === undefined) return undefined;
  return { text: `${model} is a ${name} Next Edit model; it cannot do completions`, hint: 'untick Completions, or choose a completion model' };
}

/** Sweep's prompt layout: v2 for v2 and 7B models, else v1. */
export function sweepVariant(model: string | undefined): 'v1' | 'v2' {
  return model !== undefined && /v2|7b/i.test(model) ? 'v2' : 'v1';
}

/** What the Backends page calls the format a setting and model id pick. */
export function nextEditFormatLabel(setting: NextEditFormatSetting, model: string | undefined): string {
  switch (formatIdFor(setting, model)) {
    case 'sweep':
      return `Sweep ${sweepVariant(model)} format`;
    case 'zeta21':
      return 'Zeta 2.1 format';
    case 'chatXtab':
      return 'chat prompt (chatXtab)';
  }
}

export function pickFormat(setting: NextEditFormatSetting, model: string | undefined): NextEditFormat {
  switch (formatIdFor(setting, model)) {
    case 'sweep':
      return sweepFormat(sweepVariant(model));
    case 'zeta21':
      return zeta21Format;
    case 'chatXtab':
      return chatXtabFormat;
  }
}
