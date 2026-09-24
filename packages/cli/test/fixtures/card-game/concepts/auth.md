---
kind: auth
uses: [user]
interface: |
  export interface Identity {
    readonly userId: UserId;
  }
  export function authenticate(request: Request): Promise<Identity | null>;
---
## Intent
Resolves an incoming request to the user making it.

## Examples
- request with a valid session cookie → Identity for that user
- request with no session cookie → null
