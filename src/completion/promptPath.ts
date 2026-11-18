/**
 * The path prompts name a document by: workspace-relative for project files; only the file name for a file outside the
 * project, so its absolute path (user name, folders) never reaches a backend. `uriPath` is the URI's `/`-separated path.
 */
export function promptPath(uriPath: string, relative: string, inProject: boolean): string {
  if (inProject) return relative;
  return uriPath.slice(uriPath.lastIndexOf('/') + 1);
}
