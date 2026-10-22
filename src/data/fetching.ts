/** Ejecuta tareas asíncronas con un límite de concurrencia. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Descarga una imagen con CORS y la decodifica. Devuelve null si falla. */
export async function loadBitmap(url: string, signal?: AbortSignal): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url, { signal, mode: "cors" });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    return null;
  }
}
