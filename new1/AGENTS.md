# NEW1 engineering guide

## Non-negotiable defaults

- Keep the Ollama path free of API keys, accounts, telemetry, and paid dependencies.
- Never claim feature parity or benchmark wins without reproducible evidence.
- Keep agent writes inside the configured workspace. Do not weaken path checks to make a test pass.
- `.git`, `.env`, and symbolic links remain unavailable to model tools.
- Do not add a general shell tool. Add narrowly scoped, auditable capabilities with consent and isolation.
- Browser code uses relative same-origin API paths; never hard-code a backend localhost URL.

## Development

- Node.js 22+ for NEW1. No runtime npm dependencies are currently required.
- Run `npm run validate` before delivery.
- Tests must use a fake provider; they must not download a model or require Ollama.
- Keep runtime state in `.data/` and user files in `workspace/`; both are ignored by Git.
- Preserve Arabic RTL and keyboard/mobile accessibility when changing the UI.
- Use textContent or DOM creation for model/user content; never inject it as HTML.

## Orca

- `vendor/orca` is an optional independent checkout, not NEW1 source.
- Update `orca.source.json` deliberately and record the tested revision.
- Orca itself uses Node.js 24 and pnpm. Follow `vendor/orca/AGENTS.md` inside that checkout.
- Do not commit the fetched `vendor/orca` directory into NEW1's Git history.

## Definition of done

A task is complete only when its actual tests ran, failures are disclosed, and documentation matches behavior. A fake provider proves orchestration behavior, not model quality.
