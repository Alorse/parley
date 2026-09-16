# Contributing

Thanks for wanting to pitch in. This is a small project, so the process is
deliberately light.

## Your commits stay yours

Commits **you** create keep **your** name and email. Nothing in this repository
changes that: the author of a commit is whatever your own `git config
user.name` / `user.email` says, and neither a fork nor a pull request can alter
it.

The `Co-authored-by: Hermes Agent …` / `Co-authored-by: Claude Code …` trailers
you may see in this history are used **only for the automated agents that work
on the owner's machine**. Human contributions are credited as themselves — do
not add those trailers.

## Workflow

Every change lands through a pull request against `main` — never commit straight
to `main`.

1. Create a branch off `main`: `feat/short-name`, `fix/short-name`,
   `docs/short-name`, `chore/short-name`, `refactor/short-name` (Conventional
   Commit prefixes — no invented ones).
2. Work on that branch, one focused commit at a time, with a
   [Conventional Commit](https://www.conventionalcommits.org/) message
   (`feat: …`, `fix: …`, `chore: …`, `docs: …`, `refactor: …`, `test: …`).
3. Run the tests:

   ```bash
   npm install
   npm test               # fast, no network
   npm run e2e            # hits the real Gemini API — needs GOOGLE_API_KEY
   npm run browser-check  # headless Chrome with a fake microphone
   ```

4. Push the branch and open a pull request against `main`, describing what
   changed and how you verified it. Screenshots welcome for anything visual.

No push access to the repository? Fork it first, then follow the same steps from
your fork — the branch-and-PR flow is identical.

## What this project will not do

**No secret ever goes in the repository.** `.env` is git-ignored, the API key is
server-side only, and a pull request that adds a key, a token, or a credential
of any kind will be rejected — including in commit history, so check
`git status` before you commit.

## A note on the licence

There is no `LICENSE` file yet, which means the default applies: all rights
reserved. If you are planning to reuse or redistribute the code, open an issue
first so it can be sorted out.