import type { ContextFile, FimTemplateId } from '../types';

export interface TemplateInput { prefix: string; suffix: string; filePath: string; repoName: string; extra: ContextFile[] }
export interface FimTemplate { id: FimTemplateId; suffixFirst: boolean; stop: string[]; render(i: TemplateInput): string }

export const TEMPLATES: Record<FimTemplateId, FimTemplate> = {
  qwen: {
    id: 'qwen',
    suffixFirst: false,
    stop: ['<|endoftext|>', '<|fim_prefix|>', '<|fim_middle|>', '<|fim_suffix|>', '<|fim_pad|>', '<|repo_name|>', '<|file_sep|>', '<|im_start|>', '<|im_end|>'],
    render: i => {
      const fim = `<|fim_prefix|>${i.prefix}<|fim_suffix|>${i.suffix}<|fim_middle|>`;
      if (i.extra.length === 0) return fim;
      const files = i.extra.map(f => `<|file_sep|>${f.path}\n${f.text}\n`).join('');
      return `<|repo_name|>${i.repoName}\n${files}<|file_sep|>${i.filePath}\n${fim}`;
    },
  },
  codestral: {
    id: 'codestral',
    suffixFirst: true,
    stop: ['[PREFIX]', '[SUFFIX]', '</s>', '\n+++++ '],
    render: i => {
      const files = i.extra.map(f => `+++++ ${f.path}\n${f.text}\n\n`).join('');
      const current = i.extra.length === 0 ? '' : `+++++ ${i.filePath}\n`;
      return `[SUFFIX]${i.suffix}[PREFIX]${files}${current}${i.prefix}`;
    },
  },
  deepseek: {
    id: 'deepseek',
    suffixFirst: false,
    stop: ['<｜fim▁begin｜>', '<｜fim▁hole｜>', '<｜fim▁end｜>', '<｜end▁of▁sentence｜>'],
    render: i => `<｜fim▁begin｜>${i.prefix}<｜fim▁hole｜>${i.suffix}<｜fim▁end｜>`,
  },
  starcoder: {
    id: 'starcoder',
    suffixFirst: false,
    stop: ['<fim_prefix>', '<fim_suffix>', '<fim_middle>', '<file_sep>', '<|endoftext|>'],
    render: i => `<fim_prefix>${i.prefix}<fim_suffix>${i.suffix}<fim_middle>`,
  },
  codellama: {
    id: 'codellama',
    suffixFirst: false,
    stop: ['<PRE>', '<SUF>', '<MID>', '<EOT>'],
    render: i => `<PRE> ${i.prefix} <SUF>${i.suffix} <MID>`,
  },
  codegemma: {
    id: 'codegemma',
    suffixFirst: false,
    stop: ['<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|file_separator|>', '<end_of_turn>', '<eos>'],
    render: i => `<|fim_prefix|>${i.prefix}<|fim_suffix|>${i.suffix}<|fim_middle|>`,
  },
  'granite-code': {
    id: 'granite-code',
    suffixFirst: false,
    stop: ['<|endoftext|>', '<fim_prefix>', '<fim_suffix>', '<fim_middle>'],
    render: i => `<fim_prefix>${i.prefix}<fim_suffix>${i.suffix}<fim_middle>`,
  },
  granite4: {
    id: 'granite4',
    suffixFirst: false,
    stop: ['<|end_of_text|>', '<|fim_prefix|>', '<|fim_middle|>', '<|fim_suffix|>', '<|fim_pad|>'],
    render: i => `<|fim_prefix|>${i.prefix}<|fim_suffix|>${i.suffix}<|fim_middle|>`,
  },
  'seed-coder': {
    id: 'seed-coder',
    suffixFirst: true,
    stop: ['<[end▁of▁sentence]>', '<[fim-suffix]>', '<[fim-prefix]>', '<[fim-middle]>', '<[PAD▁TOKEN]>', '<[SEP▁TOKEN]>', '<[begin▁of▁sentence]>'],
    render: i => `<[fim-suffix]>${i.suffix}<[fim-prefix]>${i.prefix}<[fim-middle]>`,
  },
  mellum: {
    id: 'mellum',
    suffixFirst: true,
    stop: ['<|endoftext|>', '<filename>', '<fim_prefix>', '<fim_suffix>', '<fim_middle>', '<fim_pad>'],
    // Mellum-4b-base model card: each file is `<filename>path\ntext\n`, and the current file's own `<filename>path\n` precedes `<fim_suffix>`.
    render: i => {
      const files = i.extra.map(f => `<filename>${f.path}\n${f.text}\n`).join('');
      const current = i.extra.length === 0 ? '' : `<filename>${i.filePath}\n`;
      return `${files}${current}<fim_suffix>${i.suffix}<fim_prefix>${i.prefix}<fim_middle>`;
    },
  },
};
