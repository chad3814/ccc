---
kind: auth
uses: [user]
interface: |
  import type { Database } from '@ccc/runtime';
  export class EmailTaken extends Error {}
  export class InvalidCredentials extends Error {}
  export interface Session {
    readonly token: string;
    readonly userId: UserId;
  }
  export interface Identity {
    readonly userId: UserId;
  }
  export class Auth {
    constructor(db: Database);
    signup(email: string, password: string): Promise<Session>;
    login(email: string, password: string): Promise<Session>;
    authenticate(request: Request): Promise<Identity | null>;
  }
---
## Intent
Accounts with email and password, and bearer-token sessions.

## Rules
- Emails are compared case-insensitively and stored lowercased.
- Passwords are stored only as PBKDF2-SHA256 hashes (100000 iterations, a 16-byte random salt), computed with Web Crypto (`crypto.subtle`); hashes and salts are stored hex-encoded.
- User ids and session tokens are random UUIDs (`crypto.randomUUID()`).
- authenticate(request) reads `Authorization: Bearer <token>` and returns the session's user, or null for a missing, malformed, or unknown token.

## Schema
```sql
create table users (
  id text primary key,
  email text not null unique,
  password_hash text not null,
  salt text not null
);

create table sessions (
  token text primary key,
  user_id text not null references users (id)
);
```

## Examples
- signup("a@x.io", "pw") → a Session; authenticate(a request with header Authorization: Bearer <that token>) → an Identity with the same userId
- signup("a@x.io", "pw") then signup("A@X.io", "other") → the second throws EmailTaken
- after signup("a@x.io", "pw"), login("a@x.io", "pw") → a Session with a different token and the same userId
- login with a wrong password, or with an unknown email → throws InvalidCredentials
- authenticate(a request with no Authorization header) → null; authenticate(a request with Bearer nonsense) → null
