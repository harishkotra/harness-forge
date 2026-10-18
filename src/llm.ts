import type { LLMConfig } from './types.ts';

export interface ChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  ms: number;
}

interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
  signal?: AbortSignal;
  retries?: number;
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

/**
 * Minimal OpenAI compatible chat client. No SDK, no proxy: the browser (or the
 * CLI) talks to whatever endpoint the user configures, and the real upstream
 * error text is surfaced rather than swallowed.
 */
export async function chat(cfg: LLMConfig, messages: { role: string; content: string }[], opts: ChatOptions = {}): Promise<ChatResult> {
  const attempts = (opts.retries ?? 2) + 1;
  let lastError: Error | null = null;
  // Reasoning models spend part of this budget on hidden tokens. If the reply
  // comes back empty because it hit the cap, retry once with more room.
  let maxTokens = opts.maxTokens ?? 1500;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('request timed out after 120s')), 120_000);
    const onAbort = () => controller.abort(new Error('run cancelled'));
    opts.signal?.addEventListener('abort', onAbort);

    try {
      const res = await fetch(endpoint(cfg.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey.trim() ? { Authorization: `Bearer ${cfg.apiKey.trim()}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature: opts.temperature ?? cfg.temperature ?? 0,
          max_tokens: maxTokens,
          stream: false,
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = (await res.text()).slice(0, 400);
        const retryable = res.status === 429 || res.status >= 500;
        lastError = new Error(`${res.status} ${res.statusText}: ${body}`);
        if (retryable && attempt < attempts) {
          await new Promise((r) => setTimeout(r, 900 * attempt));
          continue;
        }
        throw lastError;
      }

      const data = await res.json();
      const choice = data?.choices?.[0];
      const content: string = choice?.message?.content ?? '';
      if (!content.trim()) {
        const reasoning = choice?.message?.reasoning_content ?? '';
        const hitCap = choice?.finish_reason === 'length';
        lastError = new Error(
          `empty completion (finish_reason: ${choice?.finish_reason ?? 'unknown'})` +
            (reasoning ? '; the model spent the whole budget on reasoning' : ''),
        );
        if (hitCap && attempt < attempts) {
          maxTokens *= 3;
          continue;
        }
        throw lastError;
      }

      return {
        content,
        promptTokens: data?.usage?.prompt_tokens ?? 0,
        completionTokens: data?.usage?.completion_tokens ?? 0,
        ms: performance.now() - started,
      };
    } catch (err) {
      lastError = err as Error;
      if ((err as Error).name === 'AbortError' || opts.signal?.aborted) throw new Error('run cancelled');
      if (attempt >= attempts) throw lastError;
      await new Promise((r) => setTimeout(r, 700 * attempt));
    } finally {
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  throw lastError ?? new Error('request failed');
}

/** Parse a JSON object out of a model reply, tolerating fences and preamble. */
export function parseJsonObject(raw: string): Record<string, unknown> {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('editor reply contained no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
