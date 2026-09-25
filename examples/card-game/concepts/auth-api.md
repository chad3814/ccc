---
kind: endpoint
uses: [auth]
interface: |
  import type { Database } from '@ccc/runtime';
  export interface AuthApiDeps {
    readonly db: Database;
    readonly auth: Auth;
  }
  export function createHandler(deps: AuthApiDeps): (request: Request) => Promise<Response>;
---
## Intent
HTTP sign-up and sign-in.

## Rules
- POST /auth/signup with JSON {"email": string, "password": string} → 201 {"token": string, "userId": string}; an email already taken → 409 {"error": string}; a body without both strings → 400 {"error": string}.
- POST /auth/login with the same body → 200 {"token": string, "userId": string}; wrong credentials → 401 {"error": string}.
- Every other route is left to other endpoints (unmatched).

## Examples
- POST /auth/signup {"email": "a@x.io", "password": "pw"} → 201 with a token and a userId
- POST /auth/signup twice with the same email → the second response is 409
- POST /auth/login with the signed-up credentials → 200 with the signup's userId; with a wrong password → 401
- POST /auth/signup {"email": "a@x.io"} → 400
- GET /auth/whoami → 404
