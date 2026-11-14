export async function api<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(30_000) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || data?.message || `Request failed (${response.status})`);
  if (data === null) throw new Error("The server returned an unreadable response.");
  return data as T;
}
