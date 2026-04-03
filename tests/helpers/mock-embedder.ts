import { vi } from "vitest";
import type { GeminiEmbedder } from "../../src/vector/gemini";

/**
 * Creates a mock GeminiEmbedder that returns zero vectors of the specified dimension.
 * Used in pipeline and search engine tests to avoid hitting the real Gemini API.
 */
export function createMockEmbedder(dimensions = 1024): GeminiEmbedder {
  return {
    embedTexts: vi.fn(async (texts: string[], _taskType?: string, _titles?: string[]) => {
      return texts.map(() => new Array(dimensions).fill(0));
    }),
    embedQuery: vi.fn(async () => {
      return new Array(dimensions).fill(0);
    }),
    embedImage: vi.fn(async () => {
      return new Array(dimensions).fill(0);
    })
  } as unknown as GeminiEmbedder;
}
