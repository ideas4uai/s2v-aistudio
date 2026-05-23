/**
 * Manages AbortControllers for active pipelines.
 * This allows us to instantly terminate long-running tasks.
 */
class AbortManager {
  private controllers: Map<string, AbortController> = new Map();

  getOrCreate(projectId: string): AbortSignal {
    let controller = this.controllers.get(projectId);
    if (!controller || controller.signal.aborted) {
      controller = new AbortController();
      this.controllers.set(projectId, controller);
    }
    return controller.signal;
  }

  abort(projectId: string) {
    const controller = this.controllers.get(projectId);
    if (controller) {
      controller.abort();
      this.controllers.delete(projectId);
    }
  }

  remove(projectId: string) {
    this.controllers.delete(projectId);
  }
}

export const abortManager = new AbortManager();
