import type OpenAI from "openai";
import type { AiCompletionRequest } from "../types";

/** Text deltas from an OpenAI-compatible chat completion stream. */
export async function* chatCompletionDeltas(
  client: OpenAI,
  model: string,
  req: AiCompletionRequest,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const stream = await client.chat.completions.create(
    {
      model,
      max_tokens: req.maxTokens ?? 1024,
      stream: true,
      messages: [
        { role: "system", content: req.systemPrompt },
        { role: "user", content: req.userContent },
      ],
    },
    { signal },
  );
  for await (const part of stream) {
    if (signal.aborted) return;
    const text = part.choices[0]?.delta?.content;
    if (text) yield text;
  }
}
