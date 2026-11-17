import { describe, expect, it } from 'vitest';
import { failureReason } from './upload-reason.js';

// The shape of an S3 error document: the code is safe, the rest is not.
const s3Body =
  '<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code>' +
  '<Message>The request signature we calculated does not match the signature you provided.</Message>' +
  '<AWSAccessKeyId>AKIAEXAMPLEKEY</AWSAccessKeyId><StringToSign>AWS4-HMAC-SHA256 20260101T000000Z secret-string-to-sign</StringToSign>' +
  '<CanonicalRequest>PUT /key?X-Amz-Signature=deadbeef</CanonicalRequest><RequestId>R1</RequestId></Error>';

describe('failureReason', () => {
  it('takes only the code from an S3 XML error', () => {
    expect(failureReason(s3Body)).toBe('SignatureDoesNotMatch');
  });

  it('lets no other field of the S3 document through', () => {
    const reason = failureReason(s3Body) ?? '';
    for (const secret of ['AKIAEXAMPLEKEY', 'secret-string-to-sign', 'deadbeef', 'X-Amz', 'does not match']) {
      expect(reason).not.toContain(secret);
    }
  });

  it('drops an XML code that is not a plain identifier', () => {
    expect(failureReason('<Error><Code>https://host/x?X-Amz-Signature=1</Code></Error>')).toBeUndefined();
    expect(failureReason('<Error><Code>a b</Code></Error>')).toBeUndefined();
  });

  it('reads the message of a JSON error of the mock or the API', () => {
    expect(failureReason(JSON.stringify({ message: 'Content-Type mismatch' }))).toBe('Content-Type mismatch');
    expect(failureReason(JSON.stringify({ error: { message: 'Forbidden' } }))).toBe('Forbidden');
    expect(failureReason(JSON.stringify({ error: 'Forbidden' }))).toBe('Forbidden');
  });

  it('ignores the other fields of a JSON body', () => {
    const body = JSON.stringify({ message: 'Denied', url: 'https://host/key?X-Amz-Signature=deadbeef', cookie: 'session=abc' });
    expect(failureReason(body)).toBe('Denied');
  });

  it('replaces a URL inside a message and cuts a long one', () => {
    expect(failureReason(JSON.stringify({ message: 'Bad https://host/key?X-Amz-Signature=deadbeef end' }))).toBe('Bad <url> end');
    expect(failureReason(JSON.stringify({ message: 'x'.repeat(500) }))?.length).toBeLessThan(300);
  });

  it('redacts a query string without a scheme, a bare key=value pair and a percent-encoded URL', () => {
    const cases = [
      { message: 'failed at /datasets/k?X-Amz-Signature=abc&X-Amz-Credential=AKIAFAKE' },
      { error: 'X-Amz-Credential=AKIAFAKE%2F20260101 X-Amz-Signature=deadbeef' },
      { message: 'see https%3A%2F%2Fbucket.invalid%2Fk%3Ftoken%3Dsecret now' },
    ];
    for (const body of cases) {
      const reason = failureReason(JSON.stringify(body)) ?? '';
      for (const secret of ['X-Amz', 'AKIAFAKE', 'deadbeef', 'abc', 'secret', 'bucket.invalid']) expect(reason).not.toContain(secret);
      expect(reason).toContain('<redacted>');
    }
    expect(failureReason(JSON.stringify({ message: 'failed at /datasets/k?X-Amz-Signature=abc now' }))).toBe('failed at <redacted> now');
  });

  it('keeps the whole message of the mock about a Content-Type that does not match readable', () => {
    const message =
      'SignatureDoesNotMatch: request Content-Type "text/plain" does not match the signed Content-Type "application/vnd.apache.parquet". ' +
      'Send the same Content-Type header that was used to create the upload URL.';
    expect(failureReason(JSON.stringify({ error: message }))).toBe(message);
  });

  it('returns nothing for a body without a safe reason', () => {
    for (const body of ['', 'plain text with a secret', '<html>x</html>', '{}', '[1]', JSON.stringify({ message: '   ' })]) {
      expect(failureReason(body)).toBeUndefined();
    }
  });
});
