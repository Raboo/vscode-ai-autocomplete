export type RuntimeId = 'llamaServer';

export interface RuntimeEnv {
  platform: NodeJS.Platform;
  home: string;
  pathEnv: string;
  exists(p: string): boolean;
}

export const INSTALL_HINT: Record<RuntimeId, string> = {
  llamaServer: 'Install llama.cpp (macOS: brew install llama.cpp), or set aiAutocomplete.local.llamaServerPath.',
};

const join = (dir: string, name: string): string => `${dir.replace(/[\\/]+$/, '')}/${name}`;

/** Where a runtime's executable may be, best first. An override is the only candidate. */
export function runtimeCandidates(id: RuntimeId, env: RuntimeEnv, override?: string): string[] {
  if (override !== undefined) return [override];
  const win = env.platform === 'win32';
  const exe = 'llama-server' + (win ? '.exe' : '');
  const out = env.pathEnv.split(win ? ';' : ':').filter((d) => d !== '').map((d) => join(d, exe));
  if (!win) out.push(`/opt/homebrew/bin/${exe}`, `/usr/local/bin/${exe}`);
  return out;
}

export function findRuntime(id: RuntimeId, env: RuntimeEnv, override?: string): string | undefined {
  return runtimeCandidates(id, env, override).find((p) => env.exists(p));
}
