/**
 * A stream of assistant text. Providers that only return a finished string
 * are wrapped with `completeText`, so the cards can render a caret, Stop and
 * a final result without each provider speaking the streaming protocol yet.
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

/** Appends each chunk and returns the finished text. Stops when the stream ends or is aborted. */
export async function readTextStream(stream: TextStream, onChunk: (soFar: string) => void): Promise<string> {
  let soFar = "";
  for await (const chunk of stream) {
    soFar += chunk;
    onChunk(soFar);
  }
  return soFar;
}
