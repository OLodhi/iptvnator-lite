export type ProviderErrorCode = 'PROVIDER_AUTH_FAILED' | 'PROVIDER_UNREACHABLE' | 'PROVIDER_BAD_RESPONSE';

/** Messages must never contain credential-bearing URLs. */
export class ProviderError extends Error {
  code: ProviderErrorCode;
  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}
