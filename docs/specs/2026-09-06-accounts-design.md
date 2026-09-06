# Accounts and cross-device sync — design

**Status:** design agreed. The blocker it was waiting on has cleared: the live
deployment at https://studyguide-luke.vercel.app now has a valid GEMINI_API_KEY
and generation is confirmed working, so this is ready to build on approval.
**Date:** 2026-09-06

## What this is for

Today every deck lives in one browser's `localStorage`. Scan notes on your
phone and they are not on your laptop, and clearing site data destroys
everything. This adds accounts so a person signs in on any device and finds
their own decks, and so their work survives the browser.

## Decisions already made

| Decision | Choice |
|---|---|
| Sign-in | Email and password |
| Who can sign up | Anyone who visits |
| Existing local decks | Uploaded into the account on first sign-in |
| Sequencing | Build only after `GEMINI_API_KEY` works on Vercel |

## Approach

**Supabase**, for auth and Postgres together.

The reason is narrow and important: with email and password, something has to
hash passwords, expire sessions, send reset emails and resist credential
stuffing. Writing that is how real people's credentials leak. Supabase Auth
does it, so this project writes application code and no crypto.

The alternative considered was Vercel Postgres plus a hand-rolled session
layer. Rejected: it means owning password hashing and reset tokens for a study
app, which is not a reasonable trade.

Free tier is sufficient: 50,000 monthly active users and 500 MB of database,
against decks measured in kilobytes.

## Data model

Three tables, all keyed by `user_id`.

```sql
create table categories (
  id          text primary key,          -- client-generated, e.g. cat_x7f2
  user_id     uuid not null references auth.users on delete cascade,
  name        text not null,
  color       text not null,             -- palette key: c1..c8
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz                -- soft delete, so a delete syncs
);

create table decks (
  id          text primary key,
  user_id     uuid not null references auth.users on delete cascade,
  cat         text,
  name        text not null,
  note        text default '',
  cards       jsonb not null default '[]'::jsonb,   -- [[q,a,group,distractors,id], ...]
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- progress, starred, best and streak: small, always written together
create table study_state (
  user_id     uuid primary key references auth.users on delete cascade,
  state       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);
```

Cards stay as the existing tuple in a `jsonb` column rather than becoming a
`cards` table. They are only ever read and written as a whole deck, a deck is a
few kilobytes, and a separate table would buy nothing but joins.

**Soft deletes are required.** With a hard delete, a device that was offline
when you deleted a deck would re-upload it on next sync and the deck would
reappear. `deleted_at` lets the deletion itself propagate. A nightly cleanup of
rows deleted over 30 days ago keeps the table tidy.

## Security

**Row Level Security on every table**, without exception:

```sql
alter table decks enable row level security;
create policy "own decks" on decks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

This is the whole defence. The Supabase anon key ships in the page and is
*designed* to be public — it identifies the project, it does not grant access.
What stops one user reading another's decks is RLS, so the build is not done
until there is a test that signs in as user A and fails to read user B's rows.

Other requirements:

- Email confirmation on, so sign-ups cannot be made with other people's
  addresses.
- `service_role` key never reaches the browser. It bypasses RLS entirely. It
  belongs in a server env var or nowhere.
- Imported share codes stay untrusted and keep their current sanitisation. A
  synced deck is data written by a user, so the same escaping applies on render.

### Open sign-up has two consequences worth stating

**Your Gemini quota becomes shared.** Anyone with an account can scan, and the
free tier is roughly 20 requests per day per model. A handful of users will
exhaust it. Mitigation: a per-user daily scan counter in Postgres, defaulting
to 5 scans a day, checked in `/api/extract`. Without it, the first person to
upload a 24-page note set consumes six requests in one go.

**You become responsible for other people's email addresses.** That is a real
obligation, not a formality. Keep the data minimal — email and decks, nothing
else — and be ready to delete an account on request. `on delete cascade`
already makes deletion a single statement.

## Sync

**Last-write-wins per row**, using `updated_at`.

On sign-in, and on regaining focus:
1. Pull all rows for the user.
2. For each id present in both places, keep whichever `updated_at` is newer.
3. Push anything local that the server does not have or that is newer locally.

Local writes go to `localStorage` first and to Supabase immediately after,
debounced by about a second. `localStorage` stays the source of truth for
rendering, so the app is instant and works offline; the network is a
background concern.

**The honest limitation:** if the same deck is edited on two devices while one
is offline, the older edit is lost when it syncs. Not silently — the app says
"this deck was updated on another device" and offers the newer one. Proper
merging needs per-card CRDTs and is not worth it here. Whole decks are edited
rarely and by one person.

Conflicts are resolved per row, not per account, so editing a Biology deck on
a laptop and a Maths deck on a phone never conflict.

## First sign-in

The chosen behaviour is to move local decks into the account.

```
sign in
  server has no decks and local has decks  -> upload all local decks, keep ids
  server has decks and local has decks     -> merge by id; ids present only
                                              locally are uploaded, ids in both
                                              resolve by updated_at
  server has decks and local is empty      -> download
```

Deck and card ids are already client-generated and stable, which is what makes
merging by id possible. The existing `v3` migration is unchanged: it runs
first, locally, and the result is what gets uploaded.

`localStorage` is never cleared on sign-out. Signing out returns you to the
local decks you had; it does not look like the app deleted your work.

## Using it without an account

Accounts are additive. With no account the app behaves exactly as it does now,
storing everything locally, and every feature except sync works. The sign-in
prompt is an offer, never a wall — a study app that demands an account before
showing a single card is worse than one that does not sync.

## Interface

- **Sign in** in the masthead; once signed in it shows the email and a sign-out
  option.
- Sign-in screen: email, password, "Create an account", "Forgot password".
- A quiet sync indicator: last synced time, and a clear offline state.
- Errors say what to do. "That email is already registered" beats "auth error".

## Files

```
public/index.html          sign-in UI, session handling, sync layer
api/extract.js             per-user daily scan cap
supabase/schema.sql        tables, RLS policies, indexes (committed, applied once)
docs/specs/...             this document
```

Supabase is loaded from its CDN as an ES module. No build step is added; that
remains a deliberate property of this project.

## Configuration

Two public values in the client (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) and
nothing secret. Both are safe in the repo, but they will live in one clearly
marked block rather than scattered.

## Testing

The existing suites must keep passing unchanged, since signed-out behaviour
must not regress.

New tests:

1. **RLS isolation** — sign in as A, attempt to read and write B's rows,
   assert both fail. This is the test that matters most; without it a policy
   typo silently exposes every user's decks.
2. **Merge on first sign-in** — local decks upload, ids preserved, nothing lost.
3. **Conflict** — the same deck edited in two clients resolves to the newer
   `updated_at` and the user is told.
4. **Offline** — with the network refused, the app still renders, still saves
   locally, and syncs when the network returns.
5. **Sign-out** — local decks survive.
6. **Scan cap** — the sixth scan in a day is refused with a clear message.

Tests 1 and 6 need a live Supabase project, so they are opt-in like the
existing live Gemini test.

## What this does not include

- Sharing a deck to another account. Share codes already cover that.
- Realtime multi-device updates. Sync on load and focus is enough.
- Password-less sign-in, social login, or account merging.
- Any per-card conflict resolution.

## Build order

1. ~~`GEMINI_API_KEY` works on Vercel~~ — done, verified 2026-09-06.
2. Supabase project, schema, RLS policies, RLS isolation test passing.
3. Sign-in, sign-up, sign-out, password reset against a local dev server.
4. Sync layer, then first-sign-in migration.
5. Per-user scan cap.
6. Deploy, with the setup steps written out as precisely as the Gemini ones.
