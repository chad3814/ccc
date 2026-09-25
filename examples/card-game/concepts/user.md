---
kind: value
implementation: handwritten
source: handwritten/user.ts
interface: |
  export type UserId = string & { readonly __brand: 'UserId' };
  export function userId(raw: string): UserId;
---
## Intent
Identifies a person across games, independent of how they sign in.

## Examples
- userId("u1") → "u1" (typed as UserId)
- userId("  ") → throws Error "empty user id"
