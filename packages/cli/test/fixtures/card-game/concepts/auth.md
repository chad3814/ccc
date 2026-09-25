---
kind: auth
uses: [user]
interface: |
  import type { Database } from '@ccc/runtime';
  export interface Identity {
    readonly userId: UserId;
  }
  export class Auth {
    constructor(db: Database);
    authenticate(request: Request): Promise<Identity | null>;
  }
---
## Intent
Resolves an incoming request to the user making it.

## Examples
- request with a valid session cookie → Identity for that user
- request with no session cookie → null
