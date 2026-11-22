import type { BackendUse } from '../config/settings';

export interface Recipe {
  id: string;
  label: string;
  /** Hugging Face repo, `<owner>/<name>`. */
  repo: string;
  /** Full commit hash the file is pinned to. */
  revision: string;
  file: string;
  bytes: number;
  sha256: string;
  license: string;
  uses: BackendUse[];
  /** Name the server is started with (`--alias`) and the backend's model setting. */
  modelName: string;
  contextTokens: number;
  /** Shown next to the label on the Local Models page, e.g. that a quant is not official. */
  note?: string;
  /** Overrides the Hugging Face URL; test recipes only. */
  url?: string;
}

// Values read from the Hugging Face API on 2026-11-16. The Sweep model name must never contain "v2":
// the extension would pick the Sweep v2 prompt layout for it.
export const RECIPES: readonly Recipe[] = [
  {
    id: 'sweep-1.5b',
    label: 'Sweep Next Edit 1.5B',
    repo: 'sweepai/sweep-next-edit-1.5B',
    revision: '409016591c6c1a94f545f22328a85a3516118f34',
    file: 'sweep-next-edit-1.5b.q8_0.v2.gguf',
    bytes: 1537269856,
    sha256: '1321ea5e5d7529e60f9770c6a0b3a965f89542d16cf4ae51bab267f6a88150da',
    license: 'Apache-2.0',
    uses: ['completions', 'nextEdit'],
    modelName: 'sweep-next-edit-1.5b',
    contextTokens: 8192,
  },
  // Zeta 2.1 has no official GGUF; this is a community quant (read from the Hugging Face API on 2026-11-19). The name matches /zeta/i,
  // so `nextEdit.format: auto` picks the Zeta 2.1 format. Never the first-run default.
  {
    id: 'zeta-2.1',
    label: 'Zeta 2.1 (community quant)',
    repo: 'mradermacher/zeta-2.1-i1-GGUF',
    revision: '92c5ffc501a76d9c92bd04c0022cebfffa461dc8',
    file: 'zeta-2.1.i1-Q4_K_M.gguf',
    bytes: 5071410336,
    sha256: '216ddb5722a49f9ff49b21a050c4db3c801ef6f34e4bd1702d5db43e3325b076',
    license: 'Apache-2.0',
    uses: ['nextEdit'],
    modelName: 'zeta-2.1',
    contextTokens: 8192,
    note: 'community quant, not official',
  },
  // Continue's Instinct (a Qwen2.5-Coder-7B fine-tune), official GGUF; it does Next Edit and, with the qwen template, completions.
  {
    id: 'instinct-7b',
    label: 'Instinct 7B',
    repo: 'continuedev/instinct-GGUF',
    revision: 'c3f24799cc492d3252505628f49760f2fe133f43',
    file: 'instinct-Q4_K_M.gguf',
    bytes: 4683073376,
    sha256: '65eff06597c533456ac031479f31175e894e9e6ff79a562ed4d1f859f154af29',
    license: 'Apache-2.0',
    uses: ['completions', 'nextEdit'],
    modelName: 'instinct',
    contextTokens: 8192,
  },
  {
    id: 'qwen2.5-coder-1.5b',
    label: 'Qwen2.5-Coder 1.5B',
    repo: 'ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF',
    revision: '8be1b8a895a84beea772817caaa71eba6b6e0d07',
    file: 'qwen2.5-coder-1.5b-q8_0.gguf',
    bytes: 1646573056,
    sha256: '29871c94d15727a6e243f79a37113d4ae625a6215b5e800bf41a23af2da32832',
    license: 'Apache-2.0',
    uses: ['completions'],
    modelName: 'qwen2.5-coder-1.5b',
    contextTokens: 8192,
  },
  {
    id: 'qwen2.5-coder-3b',
    label: 'Qwen2.5-Coder 3B',
    repo: 'ggml-org/Qwen2.5-Coder-3B-Q8_0-GGUF',
    revision: '9c1de162ae417c9c3aacde97c729c4128de047d8',
    file: 'qwen2.5-coder-3b-q8_0.gguf',
    bytes: 3285476160,
    sha256: 'a522a906e299ed34db738b9626b2cd0da9e446c14674468a22fc2eae3dbd344d',
    license: 'Apache-2.0',
    uses: ['completions'],
    modelName: 'qwen2.5-coder-3b',
    contextTokens: 8192,
  },
  {
    id: 'qwen2.5-coder-7b',
    label: 'Qwen2.5-Coder 7B',
    repo: 'ggml-org/Qwen2.5-Coder-7B-Q8_0-GGUF',
    revision: 'bca77e0a8c88fc224882bcc404170c3ef17efacc',
    file: 'qwen2.5-coder-7b-q8_0.gguf',
    bytes: 8098525600,
    sha256: '0ef48dc94a3c551a6736ac2601de38413dc9aa9318534b16e8baee08290a4aaf',
    license: 'Apache-2.0',
    uses: ['completions'],
    modelName: 'qwen2.5-coder-7b',
    contextTokens: 8192,
  },
  {
    id: 'mellum-4b',
    label: 'Mellum 4B',
    repo: 'JetBrains/Mellum-4b-base-gguf',
    revision: '7000183cb129702bb2b66485c11f6141771dd6a8',
    file: 'mellum-4b-base.Q8_0.gguf',
    bytes: 4274519360,
    sha256: 'f8a8ae8f8b02cd992716e8849fe0424184bc7a26c2b829131ed558567307c5b2',
    license: 'Apache-2.0',
    uses: ['completions'],
    modelName: 'mellum-4b-base',
    contextTokens: 8192,
  },
];

export function downloadUrl(r: Recipe): string {
  return r.url ?? `https://huggingface.co/${r.repo}/resolve/${r.revision}/${r.file}`;
}

/** False for a file larger than 40% of the machine's memory ("may not fit"). */
export function fitsMemory(r: Recipe, totalMemBytes: number): boolean {
  return r.bytes <= 0.4 * totalMemBytes;
}

const SAFE_SEGMENT = (s: string): boolean => s !== '' && s !== '.' && s !== '..' && !/[\\/:]/.test(s);

/**
 * Where the recipe's file goes under the models folder: `<owner>/<name>/<file>` (the file may sit in subfolders). Undefined when a segment is empty,
 * `.` or `..`, or holds a slash, backslash or colon, so the path can never leave that folder.
 */
export function modelPathSegments(r: Pick<Recipe, 'repo' | 'file'>): string[] | undefined {
  const repo = r.repo.split('/');
  // A file in a repo subfolder (an added model) keeps that relative path.
  const segments = [...repo, ...r.file.split('/')];
  return repo.length === 2 && segments.length >= 3 && segments.every(SAFE_SEGMENT) ? segments : undefined;
}
