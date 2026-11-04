/**
 * node test/decks.test.js
 *
 * Drives the deck data model in a real browser: migration, card deletion,
 * share-code round trips, and that an imported deck cannot inject markup.
 *
 * The important one is deletion. starred used to hold array indices, so
 * removing a card silently repointed every star above it at its neighbour.
 * Cards now carry a stable id; this test fails if that ever regresses.
 *
 * Requires Chrome; skips cleanly if none is found.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => existsSync(p));

if (!CHROME) {
  console.log("deck model test: skipped (no Chrome found)");
  process.exit(0);
}

const HARNESS = `
<script>
const ok = (name, cond, extra) => console.log("T|" + (cond ? "ok" : "FAIL") + "|" + name + "|" + (extra || ""));
setTimeout(async () => {
  try {
    ok("migration gives every card a stable id",
       S.decks.length > 0 && S.decks[0].cards.every(c => typeof c[4] === "string" && c[4]));
    ok("default categories exist", S.categories.length >= 2);


    /* The course deck ships with the app, so its data has to be sound: a
       distractor equal to its own answer makes a quiz question unanswerable,
       and a duplicate question wastes a card. */
    for (const starter of STARTER_DECKS) {
      const d = S.decks.find(x => x.id === starter.id);
      const label = starter.id;
      ok(label + ": present", !!d && d.cards.length > 25,
         d ? d.cards.length + " cards" : "missing");
      ok(label + ": shown as a course deck", isCourse(starter.id));
      ok(label + ": every course card has a stable id",
         d.cards.every(c => String(c[4]).startsWith(starter.key + ":")));
      ok(label + ": every card offers four distractors",
         d.cards.every(c => Array.isArray(c[3]) && c[3].length === 4));
      ok(label + ": no distractor repeats its own answer",
         d.cards.every(c => !c[3].some(x => x.trim().toLowerCase() === c[1].trim().toLowerCase())));
      ok(label + ": no distractor is repeated within a card",
         d.cards.every(c => new Set(c[3].map(x => x.trim().toLowerCase())).size === 4));
      ok(label + ": no question appears twice",
         new Set(d.cards.map(c => c[0].trim().toLowerCase())).size === d.cards.length);
      ok(label + ": every card has a group tag",
         d.cards.every(c => typeof c[2] === "string" && c[2].length > 0));

      /* Explanations. The point of the card is understanding, so an
         explanation that merely restates the answer is worse than none. */
      ok(label + ": every card explains itself", d.cards.every(c => !!c[5]),
         d.cards.filter(c => !c[5]).length + " without one");
      const flat = s => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
      ok(label + ": no explanation restates its answer",
         d.cards.every(c => flat(c[5]) !== flat(c[1])));
      ok(label + ": no explanation is too short",
         d.cards.every(c => String(c[5]).length >= 40));
      ok(label + ": ids and distractors intact",
         d.cards.every(c => !!c[4] && Array.isArray(c[3]) && c[3].length === 4));
      ok(label + ": seed recorded so it is never re-added",
         Array.isArray(S.seeded) && S.seeded.includes(starter.seed));
    }


    /* The course as a whole. Unit Test Prep puts every deck together, so a
       question repeated across two topics would be asked twice. */
    {
      const all = STARTER_DECKS.flatMap(s => s.cards.map(c => qkey(c[0])));
      ok("no question appears in two course decks", new Set(all).size === all.length,
         (all.length - new Set(all).size) + " repeated");
      /* the first edition stays on record, or an old copy's retired cards
         would pass for cards its owner wrote */
      const firstCount = id => FIRST_EDITION[id].split(" ").filter(Boolean).length;
      ok("the first edition of Topics 1 and 2 is still on record",
         firstCount("topic1-macromolecules") === 77 && firstCount("topic2-enzymes") === 31);
      ok("the rewritten topics are a new edition, the Liver is not",
         ["topic1-macromolecules", "topic2-enzymes", "topic3-digestion", "topic4-respiration"]
           .every(id => courseOf(id).edition === 2) && !courseOf("liver").edition);
      ok("course decks are in the order taught", STARTER_DECKS.map(s => s.id).join() ===
         "topic1-macromolecules,topic2-enzymes,topic3-digestion,liver,topic4-respiration");
    }

    /* Someone who installed before Topic 3 existed gets it on their next
       visit, stamped as old as possible so that if their account already has
       a copy, with their own changes, that copy wins the sync. */
    {
      const keep = { decks: S.decks.slice(), seeded: S.seeded.slice() };
      S.decks = S.decks.filter(d => d.id !== "topic3-digestion");
      S.seeded = S.seeded.filter(k => k !== "topic3-digestion@1");
      seedStarters();
      const d3 = S.decks.find(d => d.id === "topic3-digestion");
      ok("a new course deck reaches an existing install",
         !!d3 && d3.cards.length === courseOf("topic3-digestion").cards.length);
      ok("a newly seeded course deck never outranks an account's copy", !!d3 && d3.updated_at === COURSE_STAMP,
         d3 ? d3.updated_at : "missing");
      seedStarters();
      ok("a course deck is only ever seeded once",
         S.decks.filter(d => d.id === "topic3-digestion").length === 1);
      S.decks = S.decks.filter(d => d.id !== "topic3-digestion");
      seedStarters();
      ok("a deleted course deck stays deleted", !S.decks.some(d => d.id === "topic3-digestion"));
      S.decks = keep.decks; S.seeded = keep.seeded;
    }

    /* Bringing an old copy up to date. Before course cards had stable ids a
       seeded deck got random ones, and its cards are the first edition, most
       of which the course has since rewritten. Such a copy has to keep its
       stars on cards the course still has, keep what its owner deleted
       deleted, keep what its owner added, lose the retired cards rather than
       mistake them for the owner's, and gain the rest of the course. */
    {
      const saved = JSON.stringify({ decks: S.decks, starred: S.starred, removed: S.courseRemoved });
      const T = "topic1-macromolecules";
      const s = courseOf(T);
      const firstEd = new Set(FIRST_EDITION[T].split(" "));
      const RETIRED = "What is a macromolecule?";                       // first edition, since rewritten
      const KEPT = "Which three elements make up carbohydrates?";       // first edition, still in the course
      const DELETED = "Give three examples of monosaccharides.";        // likewise, deleted by the owner
      ok("the upgrade test uses real first-edition questions",
         [RETIRED, KEPT, DELETED].every(q => firstEd.has(hash36(qkey(q)))) &&
         !s.cards.some(c => qkey(c[0]) === qkey(RETIRED)) &&
         [KEPT, DELETED].every(q => s.cards.some(c => qkey(c[0]) === qkey(q))));
      // the first-edition cards the course still has, minus the deleted one, plus a retired one
      const legacy = s.cards
        .filter(c => firstEd.has(cardId(c).split(":")[1]) && qkey(c[0]) !== qkey(DELETED))
        .map((c, n) => [c[0], "An old answer.", c[2], c[3], "kold" + n, null]);   // random ids, no explanations
      legacy.unshift([RETIRED, "An old answer.", "concept", null, "kretired", null]);
      legacy.push(["My own question", "My own answer", "concept", null, "kmine1", null]);
      const keptOld = legacy.find(c => qkey(c[0]) === qkey(KEPT))[4];
      const d = S.decks.find(x => x.id === T);
      d.cards = legacy.map(c => c.slice());
      S.starred[T] = ["kretired", keptOld];
      S.courseRemoved[T] = [];

      reconcileCourse();

      const idOf = q => cardId(s.cards.find(c => qkey(c[0]) === qkey(q)));
      ok("an old copy's course cards move to stable ids", d.cards
        .filter(c => c[0] !== "My own question").every(c => String(cardId(c)).startsWith("t1:")));
      ok("a star on an old copy follows its card, and one on a retired card goes",
         S.starred[T].join() === idOf(KEPT), S.starred[T].join());
      ok("a retired first-edition card is dropped, not kept as the owner's",
         !d.cards.some(c => qkey(c[0]) === qkey(RETIRED)) && !d.cards.some(c => cardId(c) === "kretired"));
      ok("a card deleted from an old copy stays deleted",
         !d.cards.some(c => qkey(c[0]) === qkey(DELETED)) && S.courseRemoved[T].join() === idOf(DELETED),
         S.courseRemoved[T].join());
      ok("the rest of the course reaches the old copy",
         d.cards.length === s.cards.length - 1 + 1, d.cards.length + " cards");
      ok("the owner's own card is kept, after the course's", cardId(d.cards[d.cards.length - 1]) === "kmine1");
      ok("explanations come back from the course",
         d.cards.filter(c => c[0] !== "My own question").every(c => !!c[5]));
      const once = JSON.stringify(d.cards);
      ok("a second reconcile changes nothing", !reconcileCourse() && JSON.stringify(d.cards) === once);

      const victim = d.cards[0];
      removeCard(T, cardId(victim));
      reconcileCourse();
      ok("a removed course card stays removed", !d.cards.some(c => cardId(c) === cardId(victim)));

      d.cards[1][1] = "an outdated answer";
      reconcileCourse();
      ok("a corrected answer reaches an existing copy", d.cards[1][1] !== "an outdated answer");

      d.cards.push(["Retired?", "Yes.", "concept", null, "t1:zzzzzz", null]);
      S.starred[T].push("t1:zzzzzz");
      reconcileCourse();
      ok("a retired course card is dropped", !d.cards.some(c => cardId(c) === "t1:zzzzzz"));
      ok("a star on a card no longer in the deck is dropped, so it is not counted",
         !S.starred[T].includes("t1:zzzzzz"));
      ok("the owner's card survives every reconcile", d.cards.some(c => cardId(c) === "kmine1"));

      const back = JSON.parse(saved);
      S.decks = back.decks; S.starred = back.starred; S.courseRemoved = back.removed;
    }

    /* Unit Test Prep is assembled from the topic decks, never stored, and
       anything done in it lands on the topic deck the card came from. */
    {
      const p = prepDeck();
      const sum = STARTER_DECKS.reduce((n, s) => n + S.decks.find(d => d.id === s.id).cards.length, 0);
      ok("Unit Test Prep holds every course card", p.cards.length === sum, p.cards.length + " of " + sum);
      ok("Unit Test Prep knows each card's topic", p.src.length === p.cards.length && p.src.every(isCourse));
      ok("Unit Test Prep is never stored as a deck", !S.decks.some(d => d.id === PREP_ID));

      openDeck(PREP_ID, null, "cards");
      const i = queue[0], owner = deck.src[i], id = cardId(deck.cards[i]);
      const had = (S.starred[owner] || []).includes(id);
      toggleStar();
      ok("a star set in Unit Test Prep lands on the topic deck", (S.starred[owner] || []).includes(id) !== had);
      toggleStar();
      ok("cards cannot be added to Unit Test Prep itself", $("btnAddCard").classList.contains("hide"));
      ok("each card is labelled with its topic", $("frontLabel").textContent === topicName(courseOf(owner)));

      openDeck(PREP_ID, null, "mock");
      ok("a mock test is 40 questions", queue.length === 40, "got " + queue.length);
      ok("a mock test never repeats a question", new Set(queue).size === queue.length);
      const per = STARTER_DECKS.map(s => queue.filter(k => deck.src[k] === s.id).length);
      ok("a mock test covers every topic", per.every(n => n > 0), per.join(","));
      ok("even the shortest topic gets four questions", per.every(n => n >= 4), per.join(","));
      ok("the mock test tab shows in Unit Test Prep", !$("segMock").classList.contains("hide"));

      const before = (S.mocks || []).length;
      for (let k = 0; k < 40; k++) {
        const right = deck.cards[queue[k]][1];
        answerQuiz(k < 20 ? curOpts.indexOf(right) : curOpts.findIndex(o => o !== right));
        if (k === 0) ok("a mock answer is not marked until the end",
          !document.querySelector("#opts .right, #opts .wrong") && !!document.querySelector("#opts .picked"));
        nextQuestion();
      }
      await new Promise(r => setTimeout(r, 60));
      const m = S.mocks[S.mocks.length - 1];
      ok("finishing a mock test records it", S.mocks.length === before + 1 && m.score === 20 && m.total === 40,
         m ? m.score + "/" + m.total : "none");
      ok("the mock's topic totals add up", Object.values(m.byTopic).reduce((n, [, t]) => n + t, 0) === 40);
      ok("the result has a bar per topic",
         document.querySelectorAll("#breakdown .brow").length === STARTER_DECKS.length);
      ok("the result lists every missed question", document.querySelectorAll("#missedList .mrow").length === 20);
      ok("the weakest topic is offered for practice", !!document.getElementById("btnWeak"));
      ok("the mark is circled in red pen", !$("finishMark").classList.contains("hide") &&
         $("finishMark").textContent.trim() === "50%");
      ok("a mock test hides the swap-direction button", $("btnFlipMode").classList.contains("hide"));
      openDeck(PREP_ID, null, "cards");
      ok("flashcards bring the swap-direction button back", !$("btnFlipMode").classList.contains("hide"));
    }

    /* The home screen: Unit Test Prep pinned on top, the course as a syllabus. */
    {
      renderHome();
      const prep = document.querySelector("#prep .paper");
      ok("Unit Test Prep is pinned above the decks", !!prep &&
         !!(document.getElementById("prep").compareDocumentPosition($("panels")) & Node.DOCUMENT_POSITION_FOLLOWING));
      const order = [...document.querySelectorAll(".rail [data-deck]")].map(b => b.dataset.deck);
      ok("course decks are listed in the order taught", order.join() === STARTER_DECKS.map(s => s.id).join(),
         order.join(" "));
      ok("the Liver is the smaller stop after Topic 3",
         !!document.querySelector('.deckrow.course.minor [data-deck="liver"]') && order.indexOf("liver") === 3);
      ok("every topic is on the prep card", document.querySelectorAll("#prep .tl").length === STARTER_DECKS.length);
      ok("the prep card shows the last mock mark", document.querySelector("#prep .mark b").textContent === "50%");
      ok("the prep card says what it covers",
         document.querySelector("#prep .sub").textContent.includes("Topics 1 to 4 and the Liver"));
    }

    /* A quiz is a test, like the mock: nothing is marked and no answer is
       shown until the end. Then every miss is listed with what was picked,
       the right answer and why. */
    {
      reverse = false;
      openDeck("topic2-enzymes", null, "quiz");
      const n = queue.length, first = deck.cards[queue[0]][1];
      const wrongAt = () => curOpts.findIndex(o => o !== curCorrect);
      answerQuiz(wrongAt());
      const outside = $("quizWrap").textContent.replace($("opts").textContent, "");
      ok("a quiz answer is not marked right or wrong",
         !document.querySelector("#opts .right, #opts .wrong") && document.querySelectorAll("#opts .picked").length === 1);
      ok("a quiz shows neither the right answer nor a score before the end",
         !outside.includes(first) && !/correct/i.test(outside) && $("tag").textContent === "1 answered",
         $("tag").textContent);
      const other = curOpts.findIndex((o, k) => k !== wrongAt());
      answerQuiz(other);
      ok("a quiz answer can be changed before moving on",
         document.querySelectorAll("#opts .picked").length === 1 && picks[0].pick === curOpts[other] &&
         document.querySelector("#opts .picked").getAttribute("aria-pressed") === "true");
      answerQuiz(curOpts.indexOf(curCorrect));
      nextQuestion();
      const good = 15;                                 // question 1 right, then 14 more, one skipped, the rest wrong
      for (let k = 1; k < n; k++) {
        if (k === 20) { nextQuestion(); continue; }    // skipped
        answerQuiz(k < good ? curOpts.indexOf(curCorrect) : wrongAt());
        if (k === n - 1) ok("the last question's button says it finishes the quiz", $("btnNextQ").textContent === "Finish the quiz");
        nextQuestion();
      }
      await new Promise(r => setTimeout(r, 60));
      const rows = document.querySelectorAll("#missedList .mrow");
      ok("the quiz is marked at the end", $("score").textContent === Math.round(good / n * 100) + "%",
         $("score").textContent);
      ok("every miss is listed, the skipped one too", rows.length === n - good &&
         document.querySelectorAll("#missedList .you.skipped").length === 1, rows.length + " rows");
      ok("each miss shows the pick and the right answer, highlighted, and why",
         [...rows].every(r => r.querySelector("s.you") && r.querySelector("em.ans mark") && r.querySelector(".whyline")));
      ok("the misses can be quizzed again", quizMissed.length === n - good &&
         $("btnMissed").textContent === "Quiz the misses" && !$("btnMissed").classList.contains("hide"));
      ok("the run is saved against the deck's current edition",
         S.progress[scoreKey("topic2-enzymes")].known === good && lastRun("topic2-enzymes") === Math.round(good / n * 100));

      /* the other way round, the right answer is the question */
      reverse = true;
      openDeck("topic2-enzymes", null, "quiz");
      ok("a reversed quiz asks with the answer", $("qq").textContent === deck.cards[queue[0]][1]);
      answerQuiz(curOpts.indexOf(curCorrect));
      $("btnFlipMode").click();                        // swap mid-question: the pick no longer applies
      ok("swapping direction mid-question asks it again, unanswered",
         picks[0].pick === null && picks[0].correct === deck.cards[queue[0]][1] && $("tag").textContent === "0 answered");
      for (let k = 0; k < queue.length; k++) { answerQuiz(curOpts.indexOf(curCorrect)); nextQuestion(); }
      await new Promise(r => setTimeout(r, 60));
      ok("a quiz is marked against the answers as they were asked", $("score").textContent === "100%",
         $("score").textContent);
      reverse = false;
    }

    /* Scores from a deck's first edition must not be shown against its new
       cards, while every other deck keeps its own. */
    {
      const keep = JSON.stringify({ progress: S.progress, best: S.best });
      S.progress["topic1-macromolecules"] = { known: 80, total: 80 };
      delete S.progress[scoreKey("topic1-macromolecules")];
      ok("a rewritten deck starts fresh", lastRun("topic1-macromolecules") === null);
      ok("a deck that was not rewritten keeps its scores where they were", scoreKey("liver") === "liver" &&
         scoreKey("dT") === "dT");
      S.best = { "topic1-macromolecules": 100, [scoreKey("topic2-enzymes")]: 40 };
      renderHome();
      ok("the quiz average leaves out scores from old cards", $("stats").textContent.includes("40%") &&
         !$("stats").textContent.includes("70%"), $("stats").textContent);
      const back = JSON.parse(keep); S.progress = back.progress; S.best = back.best;
    }

    // Deleting a card must not repoint a star at its neighbour.
    const d = { id:"dT", cat:S.categories[0].id, name:"T", cards:[
      withId(["Q1","A1","concept",["a","b","c","d"]]),
      withId(["Q2","A2","concept",["a","b","c","d"]]),
      withId(["Q3","A3","concept",["a","b","c","d"]])]};
    S.decks.push(d);
    const starId = cardId(d.cards[2]);          // star the LAST card
    S.starred.dT = [starId];
    const firstId = cardId(d.cards[0]);
    d.cards = d.cards.filter(c => cardId(c) !== firstId);   // delete the FIRST
    ok("star survives deleting an earlier card",
       S.starred.dT[0] === cardId(d.cards[1]) && d.cards[1][0] === "Q3",
       "star now on " + d.cards.findIndex(c => cardId(c) === S.starred.dT[0]));
    ok("deck shrank by exactly one", d.cards.length === 2);

    // Share code round trip.
    const code = await makeCode("dT");
    ok("code is prefixed", code.startsWith("STUDYDECK1."));
    const back = await decodeShare(code);
    ok("round trip keeps every card", back.cards.length === 2, "got " + back.cards.length);
    ok("round trip keeps question text", back.cards[0][0] === "Q2");
    ok("round trip keeps distractors", (back.cards[0][3] || []).length === 4);
    ok("imported cards get fresh ids", back.cards.every(c => c[4] && c[4] !== cardId(d.cards[0])));

    // Compression should beat plain base64 on a realistic deck.
    const big = S.decks[0];
    const bigCode = await makeCode(big.id);
    const plain = JSON.stringify({ n: big.name, k: big.cards.map(c => [c[0],c[1],c[2],c[3]]) });
    ok("compression beats raw base64 on a real deck",
       bigCode.length < plain.length * 1.34 * 0.6,
       bigCode.length + " vs base64 ~" + Math.round(plain.length * 1.34));

    // Garbage in.
    let rejected = 0;
    for (const bad of ["", "hello", "STUDYDECK1.zzzz", "STUDYDECK1."]) {
      try { await decodeShare(bad); } catch { rejected++; }
    }
    ok("bad codes are rejected with an error", rejected === 4, rejected + "/4");

    // A hostile deck must render as text, never as markup.
    const evil = JSON.stringify({ n:"<img src=x onerror=alert(1)>",
      c:{ n:"<b>c</b>", k:"c1" },
      k:[["<img src=x onerror=alert(2)>","<svg onload=alert(3)>","concept",["<i>x</i>","b","c","d"]]] });
    const cs = new CompressionStream("deflate-raw");
    const buf = await new Response(new Blob([evil]).stream().pipeThrough(cs)).arrayBuffer();
    const evilCode = "STUDYDECK1." + btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
    let fired = 0; const realAlert = window.alert; window.alert = () => { fired++; };
    importPreview(await decodeShare(evilCode));
    await new Promise(r => setTimeout(r, 300));
    window.alert = realAlert;
    const nodes = document.querySelectorAll("#reviewBody img, #reviewBody svg, #reviewBody script, #reviewBody i, #reviewBody b").length;
    ok("hostile import injects no markup and fires no script", fired === 0 && nodes === 0,
       "alerts=" + fired + " nodes=" + nodes);
    ok("hostile text renders literally",
       document.querySelector("#reviewBody .rcard .q").textContent.startsWith("<img"));


    /* The card flip. This broke silently once: the entrance animation used
       animation-fill-mode:both on a transform keyframe, and an animation
       outranks a normal declaration, so .flipped never applied for as long as
       .in was on the element - which is the whole time you are looking at a
       card. Transitions are switched off here so the end state can be read
       immediately rather than mid-animation. */
    {
      const kill = document.createElement("style");
      kill.textContent = "*,*::before,*::after{transition:none !important}";
      document.head.appendChild(kill);

      openDeck(S.decks[0].id, null, "cards");
      await new Promise(r => setTimeout(r, 120));
      const card = document.getElementById("card");

      ok("an unflipped card has no transform",
         getComputedStyle(card).transform === "none",
         getComputedStyle(card).transform);

      card.click();
      const t = getComputedStyle(card).transform;
      const m = t.startsWith("matrix3d") ? t.slice(9, -1).split(",").map(Number) : null;
      ok("clicking the card actually turns it over",
         !!m && Math.round(m[0]) === -1 && Math.round(m[10]) === -1, t);

      card.click();
      ok("clicking again turns it back", getComputedStyle(card).transform === "none");

      // the entrance must never own transform, or it will beat the flip again
      const before = getComputedStyle(card).animationName;
      ok("the entrance animation is still present", before.includes("deal"), before);
      card.classList.add("flipped");
      const both = getComputedStyle(card).transform;
      ok("the entrance cannot override the flip",
         both.startsWith("matrix3d") && Math.round(both.slice(9,-1).split(",").map(Number)[0]) === -1,
         both);
      card.classList.remove("flipped");

      // advance() adds these; the CSS must define them or the swipe is dead
      for (const cls of ["exit-left", "exit-right"]) {
        card.classList.add(cls);
        const name = getComputedStyle(card).animationName;
        ok(cls + " maps to a real animation", name !== "none" && name !== "deal", name);
        card.classList.remove(cls);
      }

      kill.remove();
      renderHome();
    }


    /* The explanation must survive a share code, or a shared deck teaches
       nothing, and it must survive withId, which used to truncate to 5 slots. */
    {
      const wd = { id:"dW", cat:S.categories[0].id, name:"W", cards:[
        withId(["Q1","A1","term",["a","b","c","d"],null,"Because of the reason."])]};
      S.decks.push(wd);
      ok("withId keeps the explanation", wd.cards[0][5] === "Because of the reason.");
      ok("withId still assigns an id", !!wd.cards[0][4]);
      const wc = await makeCode("dW");
      const wb = await decodeShare(wc);
      ok("a share code carries the explanation", wb.cards[0][5] === "Because of the reason.",
         String(wb.cards[0][5]).slice(0, 30));
      S.decks = S.decks.filter(x => x.id !== "dW");
    }

    // Batching: a note set larger than one request must go up in chunks,
    // dedupe repeated headings across pages, and keep what succeeded when a
    // later batch fails rather than throwing the whole scan away.
    {
      const realFetch = window.fetch;
      let calls = 0, failAt = 0;
      window.fetch = async (u, o) => {
        if (!String(u).includes("/api/extract")) return realFetch(u, o);
        calls++;
        if (failAt && calls === failAt)
          return { ok:false, status:429, text: async () => JSON.stringify({ error:"quota" }) };
        return { ok:true, status:200, text: async () => JSON.stringify({
          deckName:"S", subject:"biology", model:"stub",
          cards:[["repeated heading","A","term",["a","b","c","d"]],
                 ["u"+calls,"A","term",["a","b","c","d"]]] }) };
      };
      const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const blob = await (await realFetch(png)).blob();
      const pages = n => Array.from({length:n}, (_,i) => new File([blob], "p"+i+".png", {type:"image/png"}));

      calls = 0; await runScan(pages(10));
      ok("10 pages are sent as 3 batches", calls === 3, "calls=" + calls);
      ok("repeated headings are deduped across batches",
         draft.cards.filter(c => c[0] === "repeated heading").length === 1);
      ok("every unique card is kept", draft.cards.length === 4, "got " + draft.cards.length);

      calls = 0; await runScan(pages(30));
      ok("over the page cap, nothing is uploaded", calls === 0, "calls=" + calls);

      calls = 0; failAt = 2; await runScan(pages(10));
      ok("a failed batch keeps the earlier ones", draft && draft.cards.length === 2,
         "kept " + (draft ? draft.cards.length : 0));
      ok("a partial scan says so", !!draft.partial);

      // Retry: a transient failure should be tried again, a permanent one
      // must not be (retrying burns the daily Gemini quota for nothing).
      calls = 0; failAt = 0;
      let plan = [];
      window.fetch = async (u, o) => {
        if (!String(u).includes("/api/extract")) return realFetch(u, o);
        const p = plan[calls++] || "ok";
        if (p === "soft") return { ok:false, status:503,
          text: async () => JSON.stringify({ error:"busy", retryable:true }) };
        if (p === "hard") return { ok:false, status:429,
          text: async () => JSON.stringify({ error:"quota gone", retryable:false }) };
        return { ok:true, status:200, text: async () => JSON.stringify({
          deckName:"S", subject:"biology", cards:[["q"+calls,"A","term",["a","b","c","d"]]] }) };
      };
      calls = 0; plan = ["soft"];
      await runScan(pages(4));
      ok("a transient failure is retried and then succeeds",
         calls === 2 && draft && draft.cards.length === 1, "calls=" + calls);

      calls = 0; plan = ["hard"];
      await runScan(pages(4));
      ok("a permanent failure is not retried", calls === 1, "calls=" + calls);

      calls = 0; plan = ["soft","soft","soft","soft"];
      await runScan(pages(4));
      ok("retries stop at the cap", calls === 3, "calls=" + calls);
      window.fetch = realFetch;
    }
  } catch (e) {
    console.log("T|FAIL|harness threw|" + e.message);
  }
  console.log("T|END||");
}, 400);
</script>
`;

const page = (await readFile(join(ROOT, "public", "index.html"), "utf8"))
  .replace("</body>", HARNESS + "</body>");

const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(page);
});
await new Promise((r) => server.listen(0, r));

const profile = mkdtempSync(join(tmpdir(), "decks-"));
const child = spawn(CHROME, [
  "--headless", "--disable-gpu", "--no-sandbox",
  `--user-data-dir=${profile}`,
  "--virtual-time-budget=25000",
  "--enable-logging=stderr", "--v=0",
  `http://localhost:${server.address().port}/`,
]);

let out = "";
child.stderr.on("data", (d) => (out += d));
child.stdout.on("data", (d) => (out += d));
await new Promise((r) => child.on("close", r));
server.close();
try { rmSync(profile, { recursive: true, force: true }); } catch {}

const lines = [...out.matchAll(/T\|(ok|FAIL)\|([^|]*)\|([^"]*?)(?:",|\r?\n)/g)];
let pass = 0, fail = 0;
for (const [, status, name, extra] of lines) {
  if (status === "ok") { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra.trim() ? ` — ${extra.trim()}` : ""}`); }
}
if (!lines.length) {
  console.log("  FAIL no assertions ran (page did not load or threw early)");
  console.log(out.split("\n").filter((l) => /CONSOLE|ERROR/.test(l)).slice(0, 6).join("\n"));
  fail = 1;
}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
