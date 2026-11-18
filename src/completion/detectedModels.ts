/** How long a backend instance whose model could not be detected (no server, several models) is not asked again. */
export const MISSED_DETECTION_MS = 30_000;

/** Models detected per backend instance, and the instances whose detection recently found nothing. */
export class DetectedModels<B extends object> {
  private models = new WeakMap<B, string>();
  private misses = new WeakMap<B, number>();

  constructor(private readonly now: () => number = Date.now) {}

  get(backend: B): string | undefined {
    return this.models.get(backend);
  }

  set(backend: B, model: string): void {
    this.models.set(backend, model);
    this.misses.delete(backend);
  }

  /** Forgets the model, e.g. after a failure: the server may have restarted with another one. */
  delete(backend: B): void {
    this.models.delete(backend);
  }

  /** Detection found no model for `backend`. */
  missed(backend: B): void {
    this.misses.set(backend, this.now());
  }

  /** Whether to ask the server: not within MISSED_DETECTION_MS of a detection that found nothing. */
  shouldDetect(backend: B): boolean {
    const at = this.misses.get(backend);
    return at === undefined || this.now() - at >= MISSED_DETECTION_MS;
  }

  /** Lets every backend be asked again (a retry, a server that became ready). */
  forgetMisses(): void {
    this.misses = new WeakMap();
  }
}
