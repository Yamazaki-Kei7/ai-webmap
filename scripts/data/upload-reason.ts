/**
 * The short reason of a failed upload, taken from the response body. Only an error code or message field comes
 * through: S3 answers XML that also carries `AWSAccessKeyId`, `StringToSign`, `CanonicalRequest` and similar, and none
 * of that may reach the terminal. Anything else in the body is dropped, and so is anything that looks like a URL or a query string.
 */
import { z } from 'zod';

/** The longest reason that is printed. */
// Long enough for the mock's whole message about a Content-Type that does not match.
const maxReasonChars = 240;

/** An error code is a plain identifier (S3: `SignatureDoesNotMatch`, `AccessDenied`). */
const codePattern = /^[A-Za-z0-9_.-]{1,64}$/;

// The JSON of the local mock and of the Blocks API: a message, or an error object with a name or a message.
const jsonReasonSchema = z.union([
  z.object({ message: z.string() }).transform((body) => body.message),
  z.object({ error: z.object({ message: z.string() }) }).transform((body) => body.error.message),
  z.object({ error: z.string() }).transform((body) => body.error),
]);

/** S3's XML error: the text of the first `<Code>` element, and nothing else of the document. */
const xmlCodePattern = /<Code>([^<]*)<\/Code>/;

/** A token with a query or key=value shape, or with percent-escapes (an encoded URL), is dropped whole. */
const queryLikeToken = /\S*[?=&]\S*/g;
const percentEncodedToken = /\S*%[0-9A-Fa-f]{2}\S*/g;

function clean(reason: string): string | undefined {
  const withoutUrls = reason
    .replace(/https?:\/\/\S*/gi, '<url>')
    .replace(percentEncodedToken, '<redacted>')
    .replace(queryLikeToken, '<redacted>')
    .replace(/\s+/g, ' ')
    .trim();
  if (withoutUrls === '') return undefined;
  return withoutUrls.length > maxReasonChars ? `${withoutUrls.slice(0, maxReasonChars)}...` : withoutUrls;
}

function jsonReason(body: string): string | undefined {
  try {
    const parsed = jsonReasonSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The reason to print for a failed response body, or undefined when the body has none that is safe. */
export function failureReason(body: string): string | undefined {
  const fromJson = jsonReason(body);
  if (fromJson !== undefined) return clean(fromJson);
  const code = xmlCodePattern.exec(body)?.[1];
  return code !== undefined && codePattern.test(code) ? code : undefined;
}
