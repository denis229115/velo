/**
 * A stream of assistant text. Each value is the full text so far, not a delta.
 * `completeText` is the one-chunk shape used when a caller already has the
 * finished string.
 */
export interface TextStream {
  abort(): void;
  [Symbol.asyncIterator](): AsyncIterator<string>;
}

export function completeText(text: string): TextStream {
  let aborted = false;
  return {
    abort() {
      aborted = true;
    },
    async *[Symbol.asyncIterator]() {
      if (aborted) return;
      yield text;
    },
  };
}

/** Each yield replaces the text so far. Stops when the stream ends or is aborted. */
export async function readTextStream(stream: TextStream, onChunk: (soFar: string) => void): Promise<string> {
  let soFar = "";
  for await (const snapshot of stream) {
    soFar = snapshot;
    onChunk(soFar);
  }
  return soFar;
}
