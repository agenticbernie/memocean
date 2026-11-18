import canonicalize from 'canonicalize';

const serializeCanonicalJson = canonicalize as unknown as (input: unknown) => string | undefined;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** RFC 8785 JSON Canonicalization Scheme serialized as UTF-8-compatible text. */
export function canonicalizeJson(value: JsonValue): string {
  const result = serializeCanonicalJson(value);
  if (typeof result !== 'string') {
    throw new TypeError('Value cannot be represented as canonical JSON');
  }
  return result;
}

export function canonicalizeJsonBytes(value: JsonValue): Buffer {
  return Buffer.from(canonicalizeJson(value), 'utf8');
}
