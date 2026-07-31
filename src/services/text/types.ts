/** One text-generation backend. Providers are stateless and interchangeable. */
export interface TextProvider {
  name: string;
  /** Returns generated text, or throws. Throwing with an HTTP `status` lets the chain trip its circuit breaker. */
  generate(prompt: string, options?: TextGenOptions): Promise<string>;
}

export interface TextGenOptions {
  /** Routing hint reused from the existing pipeline (`script` | `planning` | `scenes` | ...). */
  task?: string;
  /** Overrides the provider's configured model. */
  model?: string;
}

/** HTTP status from whichever shape the provider's SDK threw. */
export function statusOf(error: any): number | undefined {
  return error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.httpError?.statusCode;
}
