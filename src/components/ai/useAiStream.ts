import { useCallback, useEffect, useRef, useState } from "react";
import { readTextStream, type TextStream } from "@/services/ai/textStream";

export type AiStreamPhase = "idle" | "working" | "success" | "error";

const SUCCESS_MS = 1400;

/**
 * Runs one assistant stream and reports the aura phases around it.
 * Each chunk is the full text so far, the same contract as `completeText`.
 * `null` means the run was stopped and nothing should be committed.
 */
export function useAiStream() {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<AiStreamPhase>("idle");
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const successTimer = useRef<number | null>(null);

  const clearSuccess = () => {
    if (successTimer.current !== null) {
      window.clearTimeout(successTimer.current);
      successTimer.current = null;
    }
  };

  const stop = useCallback(() => {
    clearSuccess();
    abortRef.current?.abort();
    runningRef.current = false;
    setPhase("idle");
  }, []);

  const run = useCallback(async (
    produce: (signal: AbortSignal) => AsyncIterable<string>,
    onChunk?: (soFar: string) => void,
  ): Promise<string | null> => {
    if (runningRef.current) return null;
    clearSuccess();
    const controller = new AbortController();
    abortRef.current = controller;
    runningRef.current = true;
    setText("");
    setPhase("working");
    const stream: TextStream = {
      abort() { controller.abort(); },
      async *[Symbol.asyncIterator]() {
        yield* produce(controller.signal);
      },
    };
    try {
      const result = await readTextStream(stream, (soFar) => {
        if (controller.signal.aborted) return;
        setText(soFar);
        onChunk?.(soFar);
      });
      if (controller.signal.aborted) {
        setPhase("idle");
        return null;
      }
      setText(result);
      setPhase("success");
      successTimer.current = window.setTimeout(() => {
        successTimer.current = null;
        setPhase((current) => (current === "success" ? "idle" : current));
      }, SUCCESS_MS);
      return result;
    } catch (err) {
      if (controller.signal.aborted) {
        setPhase("idle");
        return null;
      }
      setPhase("error");
      throw err;
    } finally {
      // A newer run may already own the flag after stop().
      if (abortRef.current === controller) {
        runningRef.current = false;
        abortRef.current = null;
      }
    }
  }, []);

  useEffect(() => () => {
    clearSuccess();
    abortRef.current?.abort();
  }, []);

  return { text, phase, run, stop };
}
