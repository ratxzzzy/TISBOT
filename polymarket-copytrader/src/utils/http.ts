import { retryWithBackoff } from "./helpers";

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12_000
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

export async function fetchJsonWithRetry<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12_000,
  retries = 4
): Promise<T> {
  return retryWithBackoff(async () => {
    const res = await fetchWithTimeout(url, init, timeoutMs);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `HTTP ${res.status} ${res.statusText} url=${url} body=${body.slice(0, 200)}`
      );
    }
    return (await res.json()) as T;
  }, retries);
}
