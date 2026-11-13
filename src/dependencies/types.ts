import type { Json } from '../domain/types';

export interface DependencyRequest {
  /** Stable per (request, stage). A well-behaved dependency de-duplicates on it, so retries are safe. */
  idempotencyKey: string;
  input: Record<string, Json>;
}

export interface Dependency {
  readonly name: string;
  readonly description: string;
  call(req: DependencyRequest): Promise<Json>;
}

export class DependencyRegistry {
  private readonly deps = new Map<string, Dependency>();
  register(dep: Dependency): this { this.deps.set(dep.name, dep); return this; }
  get(name: string): Dependency | undefined { return this.deps.get(name); }
  names(): string[] { return [...this.deps.keys()]; }
  all(): Dependency[] { return [...this.deps.values()]; }
}
