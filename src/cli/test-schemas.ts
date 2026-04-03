import { z } from "zod";

export const testCaseSchema = z.object({
  query: z.string().min(1),
  expect: z
    .object({
      topResult: z.string().optional(),
      inTop5: z.array(z.string()).min(1).optional(),
      maxResults: z.number().int().nonnegative().optional()
    })
    .refine(
      (e) => e.topResult !== undefined || e.inTop5 !== undefined || e.maxResults !== undefined,
      { message: "expect must contain at least one of topResult, inTop5, or maxResults" }
    )
});

export const testFileSchema = z.array(testCaseSchema).min(1, "test file must contain at least one test case");
