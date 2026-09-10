/**
 * SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   node test/rls.test.js
 *
 * The one test that decides whether it is safe to let other people sign up.
 *
 * The publishable key ships in the page by design, so nothing about it is
 * secret. What stops one person reading another's decks is Row Level Security,
 * and a policy is a piece of SQL that can be wrong in ways nothing else
 * notices: the app would behave perfectly while every deck was world-readable.
 * So this signs in as two real users and checks that one genuinely cannot see
 * or touch the other's rows.
 *
 * It creates and deletes two throwaway accounts, so it needs the service role
 * key and is opt-in. Skips cleanly when the environment is not configured.
 */
const URL = process.env.SUPABASE_URL || "";
const PUB = process.env.SUPABASE_ANON_KEY || "";
const SEC = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!URL || !PUB || !SEC) {
  console.log("RLS test: skipped (needs SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY)");
  process.exit(0);
}

const admin = { apikey: SEC, Authorization: `Bearer ${SEC}`, "Content-Type": "application/json" };
const PASSWORD = "Test-passw0rd!";

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `\n       ${String(detail).slice(0, 200)}` : ""}`); }
};

async function makeUser(email) {
  const created = await fetch(`${URL}/auth/v1/admin/users`, {
    method: "POST", headers: admin,
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const user = await created.json();
  if (!user.id) throw new Error("could not create test user: " + JSON.stringify(user).slice(0, 200));

  const signedIn = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: PUB, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const session = await signedIn.json();
  if (!session.access_token) throw new Error("could not sign in test user");
  return { id: user.id, token: session.access_token };
}

const as = (u) => ({ apikey: PUB, Authorization: `Bearer ${u.token}`, "Content-Type": "application/json" });
const deleteUser = (u) => fetch(`${URL}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });

const stamp = Date.now();
const deckId = `rls-test-${stamp}`;
let A, B;

try {
  A = await makeUser(`rls-a-${stamp}@example.com`);
  B = await makeUser(`rls-b-${stamp}@example.com`);

  console.log("\nA signed-in user and their own rows");
  let r = await fetch(`${URL}/rest/v1/decks`, {
    method: "POST", headers: { ...as(A), Prefer: "return=representation" },
    body: JSON.stringify({ id: deckId, user_id: A.id, name: "A private deck", cat: "biology", cards: [] }),
  });
  ok("can write their own deck", r.status === 201, await r.clone().text());

  r = await fetch(`${URL}/rest/v1/decks?id=eq.${deckId}&select=name`, { headers: as(A) });
  ok("can read it back", (await r.json()).length === 1);

  console.log("\nA different signed-in user");
  r = await fetch(`${URL}/rest/v1/decks?id=eq.${deckId}&select=name`, { headers: as(B) });
  const seen = await r.json();
  ok("cannot read it", Array.isArray(seen) && seen.length === 0, JSON.stringify(seen));

  r = await fetch(`${URL}/rest/v1/decks?select=*`, { headers: as(B) });
  ok("sees no decks at all", (await r.json()).length === 0);

  // without `with check` on the policy, this would succeed and let anyone
  // plant rows in someone else's account
  r = await fetch(`${URL}/rest/v1/decks`, {
    method: "POST", headers: as(B),
    body: JSON.stringify({ id: `evil-${stamp}`, user_id: A.id, name: "planted", cat: "biology", cards: [] }),
  });
  ok("cannot write a row owned by someone else", r.status >= 400, `HTTP ${r.status}`);

  r = await fetch(`${URL}/rest/v1/decks?id=eq.${deckId}`, {
    method: "PATCH", headers: { ...as(B), Prefer: "return=representation" },
    body: JSON.stringify({ name: "hacked" }),
  });
  ok("cannot modify it", (await r.json()).length === 0);

  r = await fetch(`${URL}/rest/v1/decks?id=eq.${deckId}`, {
    method: "DELETE", headers: { ...as(B), Prefer: "return=representation" },
  });
  ok("cannot delete it", (await r.json()).length === 0);

  r = await fetch(`${URL}/rest/v1/decks?id=eq.${deckId}&select=name`, { headers: as(A) });
  const mine = await r.json();
  ok("the owner still has it, unchanged",
     mine.length === 1 && mine[0].name === "A private deck", JSON.stringify(mine));

  console.log("\nAnonymous, holding only the key that ships in the page");
  for (const table of ["decks", "categories", "study_state"]) {
    const anon = await fetch(`${URL}/rest/v1/${table}?select=*`, { headers: { apikey: PUB } });
    const rows = await anon.json();
    ok(`${table}: returns nothing`, Array.isArray(rows) && rows.length === 0, JSON.stringify(rows).slice(0, 80));
  }

  console.log("\nThe scan counter");
  r = await fetch(`${URL}/rest/v1/scan_usage`, {
    method: "POST", headers: as(B), body: JSON.stringify({ user_id: B.id, count: 0 }),
  });
  ok("a user cannot reset their own counter", r.status >= 400, `HTTP ${r.status}`);
} catch (e) {
  fail++;
  console.log("  FAIL harness threw: " + e.message);
} finally {
  for (const u of [A, B]) if (u) await deleteUser(u).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
