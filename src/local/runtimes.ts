export type RuntimeId = 'llamaServer' | 'lms';

export interface RuntimeEnv {
  platform: NodeJS.Platform;
  home: string;
  pathEnv: string;
  exists(p: string): boolean;
  readFile(p: string): string | undefined;
}

export const INSTALL_HINT: Record<RuntimeId, string> = {
  llamaServer: 'Install llama.cpp (macOS: brew install llama.cpp), or set aiAutocomplete.local.llamaServerPath.',
  lms: 'Install LM Studio from https://lmstudio.ai and start it once, or set aiAutocomplete.local.lmsPath.',
};

const join = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}/${name}`;

/** Where a runtime's executable may be, best first. An override is the only candidate. */
export function runtimeCandidates(id: RuntimeId, env: RuntimeEnv, override?: string): string[] {
  if (override !== undefined) return [override];
  const win = env.platform === 'win32';
  const exe = (id === 'llamaServer' ? 'llama-server' : 'lms') + (win ? '.exe' : '');
  const out = env.pathEnv.split(win ? ';' : ':').filter((d) => d !== '').map((d) => join(d, exe));
  if (id === 'llamaServer') {
    if (!win) out.push(`/opt/homebrew/bin/${exe}`, `/usr/local/bin/${exe}`);
    return out;
  }
  out.push(join(`${env.home}/.lmstudio/bin`, exe));
  const pointer = env.readFile(`${env.home}/.lmstudio-home-pointer`)?.trim();
  if (pointer) out.push(join(`${pointer}/bin`, exe));
  out.push(join(`${env.home}/.cache/lm-studio/bin`, exe));
  return out;
}

export function findRuntime(id: RuntimeId, env: RuntimeEnv, override?: string): string | undefined {
  return runtimeCandidates(id, env, override).find((p) => env.exists(p));
}
