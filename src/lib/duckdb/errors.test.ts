import { ApiError } from '@aws-blocks/blocks/client';
import { describe, expect, it } from 'vitest';
import { accessErrors, accessStatus } from '../../../shared/access';
import { engineConfig } from '../../../shared/config';
import { describeEngineError, isRetryableMessage, notAllowedUiMessage } from './errors';

describe('describeEngineError', () => {
  it('says that a refused account may not use the data', () => {
    const refusal = new ApiError('Access denied', accessStatus.forbidden, { name: accessErrors.NotAllowed });
    expect(describeEngineError(refusal)).toBe(notAllowedUiMessage);
  });

  it('leaves out URLs, signed query strings and everything after the first line', () => {
    const message = describeEngineError(new Error('Failed to fetch https://bucket.test/a.parquet?X-Amz-Signature=abc\n    at stack'));
    expect(message).toBe('Failed to fetch [URL]');
  });

  it('cuts a long message', () => {
    const message = describeEngineError('x'.repeat(engineConfig.maxErrorChars + 50));
    expect(message).toHaveLength(engineConfig.maxErrorChars + 1);
  });

  it('has a text for an empty message', () => {
    expect(describeEngineError(new Error(''))).not.toBe('');
  });
});

describe('isRetryableMessage', () => {
  it('offers no retry for the not-allowed message, which a retry cannot fix', () => {
    expect(isRetryableMessage(notAllowedUiMessage)).toBe(false);
    expect(isRetryableMessage('Failed to fetch')).toBe(true);
  });
});
