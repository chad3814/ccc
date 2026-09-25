# Concept schema reference

A ccc project is a directory with a `concepts/` folder. Every `.md` file under it is one concept. Concepts are the source of truth: you edit them, and ccc generates the code.

## Files, IDs, and containment

- The ID comes from the path: `concepts/game/player/hand.md` is `game.player.hand`. Never write an `id` field.
- Names are lowercase kebab-case (`game-store`, not `GameStore` or `game_store`).
- A directory is the inside of the concept with the same name: `concepts/game/` holds the children of `concepts/game.md`. Every directory needs that parent file.
- Dotfiles are ignored. Other non-`.md` files produce a warning.

## File layout

```markdown
---
kind: collection          # required
of: card                  # kind-specific fields
uses: [user]              # dependencies (see Visibility)
interface: |              # TypeScript declarations this concept exports
  export class Hand {
    add(card: Card): void;
  }
---
## Intent
What this concept is for. (required)

## Rules
- Invariants, in prose.

## Examples
- One behavior per bullet. These become tests.
- Longer examples can continue
  on indented lines.

## Decisions
- Why things are the way they are.
```

## Kinds

| Kind | Use for | Extra fields |
|---|---|---|
| `value` | Data with no identity (a Card) | — |
| `entity` | Something with identity and a lifecycle (a Player) | — |
| `collection` | A structure of other concepts (a Hand of Cards) | `of: <id>` |
| `aggregate` | A root that owns its children and enforces rules across them (a Game) | — |
| `store` | Persists one aggregate | `persists: <id>`; requires a `## Schema` section with a ```` ```sql ```` block; must export its primary class with `constructor(db: Database)` |
| `endpoint` | HTTP routes | must export `createHandler(deps)` returning `(request: Request) => Promise<Response>` |
| `auth` | Turns a request into an identity | must export its primary class with `constructor(db: Database)` and `authenticate(request)` |
| `sync` | When an action happens on one concept, invoke actions on others | `when`, `then`; no `interface` |

The first four are **domain** kinds. `store`, `endpoint`, and `auth` are **adapter** kinds. Domain concepts can never depend on adapters; connect them with a sync instead.

## Fields

| Field | Meaning |
|---|---|
| `kind` | One of the kinds above |
| `interface` | TypeScript declarations (classes, functions, types, error classes). Write methods without bodies. Never write `import`: types from dependencies listed in `uses` are imported automatically when the interface mentions them. The one exception is `import type { ... } from '@ccc/runtime'` (for `Database` and friends). |
| `uses` | Concepts whose interfaces this one depends on. An aggregate automatically uses its direct children (except syncs). |
| `implementation` | `generated` (default) or `handwritten` |
| `source` | For `handwritten` only: path to the module, relative to the project root |

## Sections

- `## Intent` (required), `## Rules`, `## Examples`, `## Decisions`. Stores also require `## Schema`.
- Any other `##` heading is an error; that catches typos like `## Example`.
- `## ...` lines inside code fences are ignored.
- `ccc check` warns when `## Examples` is missing or empty; `ccc build` will require it.

## Visibility

A concept can reference: its ancestors, its own children, its siblings, and its ancestors' siblings (which includes every top-level concept). Anything nested deeper is private to its parent.

`game.player.hand` is visible to `game.player` and its other children, but not to `game` or `game-api`.

Put an invariant on the lowest concept that can see everything it mentions. Put a sync in the lowest directory that contains everything it connects.

## Syncs

```markdown
---
kind: sync
when: game.players#join
then: [game#deal]
---
## Intent
Start the round automatically once the table fills.

## Examples
- given 3 of 4 seats taken, join(user) → deal() called once
```

A sync's `when` must be a method (it is wired by patching the class). An action is written `<concept-id>#<member>`. It resolves to an exported function named `<member>`, or else a method named `<member>` on the concept's primary class: the class named after the ID's last segment in PascalCase (`game.players` → `Players`, `game-store` → `GameStore`).

Syncs can't form cycles: a sync must not directly or transitively re-trigger its own `when` action.

## `ccc check`

```bash
ccc check            # in the project root
ccc check -C path    # or point at it
```

It makes no LLM calls. Exit code 1 if there are errors. It checks:

1. Every file parses; frontmatter matches its kind; required sections exist; no unknown sections.
2. Names are kebab-case; every directory has its parent concept file.
3. Every referenced concept exists and is visible, and isn't referenced by itself.
4. Domain concepts don't depend on adapters; nothing references a sync; `persists` targets an aggregate.
5. No dependency cycles.
6. Handwritten `source` files exist.
7. Sync actions exist, and syncs have no cycles.
8. Interfaces are self-contained: no `import`, no `declare global` or `declare module`, and at least one export. A name an interface uses must not come from two dependencies (only referenced names are imported, and a concept's own exports take precedence).
9. All interfaces type-check together with TypeScript 7 (only when 1–8 pass). Web types such as `Request` and `Response` are available.
10. Adapter conventions (see [runtime.md](runtime.md)); sync triggers are methods; `server`, `main`, `wiring`, and `schema` are reserved top-level names.
