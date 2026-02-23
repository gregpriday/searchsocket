/**
 * Detect whether the current process is running in a serverless environment.
 *
 * Checks well-known environment variables set by major serverless platforms.
 * Used to auto-disable features that don't work in serverless (e.g. in-memory
 * rate limiting) and to provide better error messages.
 */
export function isServerless(): boolean {
  return !!(
    process.env.VERCEL ||
    process.env.NETLIFY ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.FUNCTIONS_WORKER ||
    process.env.CF_PAGES
  );
}
