/* =====================================================================
   ঊনত্রিশ (TWENTY-NINE) — app.js
   -----------------------------------------------------------------------
   HOW THIS APP IS WIRED TOGETHER (read this if you're new to the code)

   1. ARCHITECTURE — "Host is the referee."
      There is no server/backend here beyond Firebase Realtime Database.
      To avoid four browsers fighting over who deals cards / resolves a
      bid / plays a bot's turn, the HOST's browser tab is the single
      "referee": only the host ever writes game-logic results (deals,
      bidding resolution, trump, scoring, trick resolution). Non-host
      players never write game state directly — instead they push a
      small "action" (e.g. "I bid 17" / "I played 9♠") to
      rooms/{code}/actions, the host listens for new actions and applies
      them, then deletes the processed action. Bots are simply seats
      with isBot:true and no browser — the host decides for them too.

      This means: if the HOST closes their tab mid-round, the game
      freezes for everyone else. There's no host hand-off implemented.
      For a couple of friends playing casually this is an acceptable
      trade-off; a production app would want a Cloud Function referee
      instead of a browser tab.

   2. SECURITY — please read before sharing this publicly.
      This project has NO Firebase security rules configured, which
      means (in Firebase's default test-mode) ANY client can read the
      entire room, including every player's cards. The UI only ever
      *displays* your own hand, and non-host clients only *subscribe*
      to their own hand path — but a technically savvy opponent could
      open the browser dev tools / Firebase console and see everything.
      For casual play with friends this is usually fine. If you want
      real anti-cheat guarantees, you'd need Firebase Security Rules
      that restrict rooms/{code}/hands/{seat} to that seat's uid, which
      requires editing rules in the Firebase console (ask me for this
      separately — it's outside what a static GitHub Pages site can do
      on its own).

   3. SEATS vs ROLES.
      The four seats (south/east/north/west) are FIXED to whoever sat
      there in the lobby — partnerships and physical position never
      change. But the DEALER rotates each round, and the bidding roles
      "Player 1 / Player 2 / Player 3" are defined RELATIVE to the
      dealer (Player 1 = seat immediately anti-clockwise of the
      dealer, and so on) — see computeRoles(). Round 1 of dealing was
      always East/North/West/South only because the very first dealer
      is South (fixed in the lobby); from round 2 onward the roles
      shift together with the dealer.

   4. SOME RULES WERE UNDER-SPECIFIED — here's what was assumed:
      - Follow-suit is enforced as a normal trick-taking rule (must
        follow the lead suit if you can) even though it wasn't
        explicitly restated in every prompt — it's implied by the
        "Trump / Don't Trump" mechanic.
      - The Over-Trump rule blocks playing a *lower* trump than the
        best trump already on the table if you hold a higher one, but
        only server-side (host). The hand UI doesn't grey out specific
        illegal over-trump cards — tapping an illegal card is just
        silently ignored by the host. Everything else (follow suit,
        forced-trump, the locked 7th card) IS reflected in the UI.
      - Double/Redouble/Single-Double are decided by whichever
        opponent (or team-mate) responds FIRST — the popup isn't
        asking for a unanimous decision from both players.
      - Bots never request Single Play themselves (only humans can
        start a Single Play round); bots DO respond to Double /
        Redouble / Single-Double prompts and to Trump/Pair choices
        with simple heuristics described inline near each bot function.
      - Dealer rotation moves to the next seat that is a HUMAN player
        (skipping bot seats), per the rotation instruction — except a
        Single Play winner ALWAYS becomes the next dealer regardless.
   ===================================================================== */


/* ----------------------------------------------------------------------
   CONSTANTS
   ---------------------------------------------------------------------- */

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const POINT_VALUES = { J: 3, '9': 2, A: 1, '10': 1, K: 0, Q: 0, '8': 0, '7': 0 };
// Trick-taking strength, STRONGEST first (index 0 beats everything else).
const POWER_ORDER = ['J', '9', 'A', '10', 'K', 'Q', '8', '7'];
const SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_CLASS = { S: 'hand-card-suit--spade', H: 'hand-card-suit--heart', D: 'hand-card-suit--diamond', C: 'hand-card-suit--club' };

const SEATS = ['south', 'east', 'north', 'west'];
// Fixed anti-clockwise seating cycle, used for dealer rotation & role math.
const COMPASS_CYCLE = ['south', 'east', 'north', 'west'];

const SEAT_LABELS_BN = { south: 'দক্ষিণ', east: 'পূর্ব', north: 'উত্তর', west: 'পশ্চিম' };

const MODE_CONFIG = {
  A: { humans: 1, bots: 3, label: 'মোড A · 1 Human vs 3 Bots' },
  B: { humans: 2, bots: 2, label: 'মোড B · 2 Humans + 2 Bots' },
  C: { humans: 3, bots: 1, label: 'মোড C · 3 Humans + 1 Bot' },
  D: { humans: 4, bots: 0, label: 'মোড D · 4 Humans (Pure Online)' }
};


/* ----------------------------------------------------------------------
   GLOBAL STATE (each client's local mirror of the room in Firebase)
   ---------------------------------------------------------------------- */

let myUid = null;
let myName = '';
let myRoomCode = null;
let mySeat = null;
let isHost = false;
let currentMode = 'A';

let players = {};          // { seat: { role, name, uid, isBot, isHost } }
let partnerships = {};     // { seat: 1 | 2 }
let dealerSeat = 'south';
let roles = null;          // { dealer, p1, p2, p3, dealOrder } — see computeRoles()
let handCounts = {};       // { seat: number } — safe to share (no card content)
let latestHands = {};      // HOST ONLY: every seat's actual cards
let pendingSecondHands = {}; // HOST ONLY: the 16 cards reserved for the second deal
let myHand = null;         // THIS client's own cards only

let roomMeta = {};         // meta node mirror
let bidding = null;
let trump = null;          // { suit, revealed, method }
let doubleState = null;    // (kept for completeness / future use)
let pointMultiplier = 1;   // 1 normal, 2 double, 4 redouble
let singlePlayQueueLocal = [];
let singlePlay = null;     // { active, seat, partnerSeat, opponentDoubled }
let trick = null;          // { leaderSeat, cardsPlayed, leadSuit, trumpForcedSeat }
let trickNumber = 1;
let tricksWon = {};        // { seat: count }
let teamPoints = { 1: 0, 2: 0 };   // card points won THIS round
let teamScores = { 1: { points: 0, sets: 0 }, 2: { points: 0, sets: 0 } }; // persistent match score
let pairDeclared = null;   // { seat, suit, byBidWinnerTeam }
let currentTurnSeat = null;
let nextDealerSeat = null; // used to force the next dealer (Single Play winner)

let activeListeners = [];
let bannerTimer = null;
let singlePlayWindowTimer = null;
let lastRenderedStatus = null;
let modalSkippedForStatus = null;


/* ----------------------------------------------------------------------
   SMALL HELPERS
   ---------------------------------------------------------------------- */

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
function toBengaliDigits(str) { return String(str).replace(/[0-9]/g, d => BN_DIGITS[d]); }
function bnNum(n) { return toBengaliDigits(String(n)); }
function bnDigitsOf(code) { return toBengaliDigits(String(code)); }
function formatBnTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return toBengaliDigits(h + ':' + m);
}
function seatLabel(seat) { return SEAT_LABELS_BN[seat] || seat; }
function clampBid(value, min, max) {
  let v = parseInt(value, 10);
  if (isNaN(v)) v = min;
  if (v < min) v = min;
  if (v > max) v = max;
  return v;
}

function isSpotCard(card) { return POINT_VALUES[card.rank] > 0; }
function countSpotCards(hand) { return (hand || []).filter(isSpotCard).length; }
function countStrongCards(hand) { return (hand || []).filter(c => c.rank === 'J' || c.rank === '9').length; }

function buildShuffledDeck() {
  const deck = [];
  SUITS.forEach(suit => RANKS.forEach(rank => deck.push({ suit, rank })));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
  }
  return deck;
}

// Roles rotate WITH the dealer each round — see note #3 at the top of this file.
function computeRoles(dealer) {
  const i = COMPASS_CYCLE.indexOf(dealer);
  const p1 = COMPASS_CYCLE[(i + 1) % 4];
  const p2 = COMPASS_CYCLE[(i + 2) % 4];
  const p3 = COMPASS_CYCLE[(i + 3) % 4];
  return { dealer, p1, p2, p3, dealOrder: [p1, p2, p3, dealer] };
}

function nextSeatInPlay(seat) {
  const idx = COMPASS_CYCLE.indexOf(seat);
  for (let i = 1; i <= 4; i++) {
    const cand = COMPASS_CYCLE[(idx + i) % 4];
    if (singlePlay && singlePlay.active && cand === singlePlay.partnerSeat) continue; // deactivated
    return cand;
  }
  return seat;
}

function nextHumanDealer(fromSeat) {
  const idx = COMPASS_CYCLE.indexOf(fromSeat);
  for (let i = 1; i <= 4; i++) {
    const cand = COMPASS_CYCLE[(idx + i) % 4];
    if (players[cand] && !players[cand].isBot) return cand;
  }
  return fromSeat;
}

function getPartnerSeat(seat) {
  return SEATS.find(s => s !== seat && partnerships[s] === partnerships[seat]);
}


/* ----------------------------------------------------------------------
   INIT
   ---------------------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', () => {
  wireStaticUI();
  auth.onAuthStateChanged(user => {
    if (user) { myUid = user.uid; restoreSessionIfAny(); }
  });
  auth.signInAnonymously().catch(err => {
    console.error('Anonymous sign-in failed:', err);
    alert('সংযোগ স্থাপনে সমস্যা হয়েছে। ইন্টারনেট সংযোগ পরীক্ষা করে পাতাটি রিফ্রেশ করুন।');
  });
});

function wireStaticUI() {
  document.getElementById('btn-host-game').addEventListener('click', handleHostGame);
  document.getElementById('btn-join-game').addEventListener('click', handleJoinGame);
  wireCodeBoxes();
  document.getElementById('btn-copy-code').addEventListener('click', copyRoomCode);
  document.getElementById('btn-leave-lobby').addEventListener('click', leaveRoom);
  document.getElementById('btn-lock-partnerships').addEventListener('click', lockPartnerships);
  document.getElementById('btn-start-game').addEventListener('click', startGame);
  document.getElementById('btn-game-menu').addEventListener('click', leaveRoom);

  document.getElementById('btn-bid').addEventListener('click', () => {
    if (!bidding) return;
    const val = bidding.locked ? Math.min(bidding.currentBid + 1, 28) : 16;
    submitAction('BID', { value: val });
  });
  document.getElementById('btn-achi').addEventListener('click', () => submitAction('ACHI'));
  document.getElementById('btn-pass').addEventListener('click', () => submitAction('PASS'));

  document.getElementById('btn-trump-reveal').addEventListener('click', () => submitAction('TRUMP_REVEAL_CHOICE', { choice: 'TRUMP' }));
  document.getElementById('btn-no-trump').addEventListener('click', () => submitAction('TRUMP_REVEAL_CHOICE', { choice: 'NO_TRUMP' }));
  document.getElementById('btn-declare-pair').addEventListener('click', () => submitAction('DECLARE_PAIR'));
}

function wireCodeBoxes() {
  const boxes = Array.from(document.querySelectorAll('#join-code-boxes .code-box'));
  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
      if (box.value && boxes[i + 1]) boxes[i + 1].focus();
    });
    box.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !box.value && boxes[i - 1]) boxes[i - 1].focus();
    });
  });
}


/* ----------------------------------------------------------------------
   HOST / JOIN / LEAVE / SESSION
   ---------------------------------------------------------------------- */

function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function createUniqueRoomCode() {
  for (let i = 0; i < 8; i++) {
    const code = generateRoomCode();
    const snap = await db.ref('rooms/' + code + '/meta').once('value');
    if (!snap.exists()) return code;
  }
  return null;
}

async function handleHostGame() {
  if (!myUid) { alert('সংযোগ স্থাপন হচ্ছে... একটু পর আবার চেষ্টা করুন।'); return; }
  const name = document.getElementById('player-name').value.trim();
  if (!name) { alert('অনুগ্রহ করে আপনার নাম লিখুন।'); document.getElementById('player-name').focus(); return; }
  const mode = document.querySelector('input[name="game-mode"]:checked').value;

  const hostBtn = document.getElementById('btn-host-game');
  hostBtn.disabled = true;
  try {
    const code = await createUniqueRoomCode();
    if (!code) { alert('রুম কোড তৈরি করা যায়নি। আবার চেষ্টা করুন।'); return; }

    const config = MODE_CONFIG[mode];
    const roster = { south: { role: 'HUMAN', name, uid: myUid, isBot: false, isHost: true } };
    let openHumanSlots = config.humans - 1;
    let botCounter = 1;
    ['east', 'north', 'west'].forEach(seat => {
      if (openHumanSlots > 0) {
        roster[seat] = { role: 'OPEN', name: null, uid: null, isBot: false, isHost: false };
        openHumanSlots--;
      } else {
        roster[seat] = { role: 'BOT', name: 'বট ' + botCounter, uid: null, isBot: true, isHost: false };
        botCounter++;
      }
    });

    await db.ref('rooms/' + code).set({
      meta: { mode, status: 'LOBBY', createdAt: firebase.database.ServerValue.TIMESTAMP, hostUid: myUid, partnershipsLocked: false, round: 1 },
      players: roster,
      dealer: 'south'
    });

    mySeat = 'south'; isHost = true; myRoomCode = code; myName = name;
    saveSession();
    attachRoomListeners();
    await pushLog(`${name} রুম তৈরি করেছেন। রুম কোড: ${bnDigitsOf(code)}`);
    showScreen('screen-lobby');
  } catch (err) {
    console.error(err);
    alert('রুম তৈরিতে সমস্যা হয়েছে। ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।');
  } finally {
    hostBtn.disabled = false;
  }
}

async function handleJoinGame() {
  if (!myUid) { alert('সংযোগ স্থাপন হচ্ছে... একটু পর আবার চেষ্টা করুন।'); return; }
  const name = document.getElementById('join-name').value.trim();
  const boxes = Array.from(document.querySelectorAll('#join-code-boxes .code-box'));
  const code = boxes.map(b => b.value.trim()).join('');

  if (!name) { alert('অনুগ্রহ করে আপনার নাম লিখুন।'); document.getElementById('join-name').focus(); return; }
  if (!/^\d{6}$/.test(code)) { alert('অনুগ্রহ করে সঠিক ৬-সংখ্যার রুম কোড দিন।'); return; }

  const joinBtn = document.getElementById('btn-join-game');
  joinBtn.disabled = true;
  try {
    const snap = await db.ref('rooms/' + code).once('value');
    if (!snap.exists()) { alert('এই কোডে কোনো রুম পাওয়া যায়নি।'); return; }
    const room = snap.val();
    if (room.meta && room.meta.status !== 'LOBBY') { alert('এই রুমের খেলা ইতিমধ্যে শুরু হয়ে গেছে।'); return; }

    const roster = room.players || {};
    const openSeat = ['east', 'north', 'west'].find(s => roster[s] && roster[s].role === 'OPEN');
    if (!openSeat) { alert('এই রুমে আর কোনো খালি আসন নেই।'); return; }

    await db.ref(`rooms/${code}/players/${openSeat}`).set({ role: 'HUMAN', name, uid: myUid, isBot: false, isHost: false });

    mySeat = openSeat; isHost = false; myRoomCode = code; myName = name;
    saveSession();
    attachRoomListeners();
    await pushLog(`${name} (${seatLabel(openSeat)}) টেবিলে যোগ দিয়েছেন।`);
    showScreen('screen-lobby');
  } catch (err) {
    console.error(err);
    alert('রুমে প্রবেশ করা যায়নি। ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।');
  } finally {
    joinBtn.disabled = false;
  }
}

async function copyRoomCode() {
  const codeField = document.getElementById('room-code-value');
  const btn = document.getElementById('btn-copy-code');
  const label = btn.lastChild;
  const original = label.textContent;
  try {
    await navigator.clipboard.writeText(codeField.value);
    label.textContent = ' কপি হয়েছে!';
  } catch (err) {
    alert('রুম কোড: ' + codeField.value);
  }
  setTimeout(() => { label.textContent = original; }, 1500);
}

async function leaveRoom() {
  if (!confirm('আপনি কি রুম ত্যাগ করতে চান?')) return;
  try {
    if (myRoomCode && mySeat) {
      const statusSnap = await db.ref(`rooms/${myRoomCode}/meta/status`).once('value');
      if (statusSnap.val() === 'LOBBY' && mySeat !== 'south') {
        await db.ref(`rooms/${myRoomCode}/players/${mySeat}`).set({ role: 'OPEN', name: null, uid: null, isBot: false, isHost: false });
      }
    }
  } catch (err) { console.error(err); }
  detachRoomListeners();
  clearSession();
  myRoomCode = null; mySeat = null; isHost = false; bidding = null; players = {};
  showScreen('screen-entry');
}

function saveSession() {
  localStorage.setItem('twentynine_session', JSON.stringify({ roomCode: myRoomCode, seat: mySeat, name: myName, isHost }));
}
function clearSession() { localStorage.removeItem('twentynine_session'); }

async function restoreSessionIfAny() {
  const raw = localStorage.getItem('twentynine_session');
  if (!raw) return;
  let session;
  try { session = JSON.parse(raw); } catch (e) { clearSession(); return; }
  if (!session || !session.roomCode || !session.seat) { clearSession(); return; }
  try {
    const snap = await db.ref(`rooms/${session.roomCode}/players/${session.seat}`).once('value');
    const seatData = snap.val();
    if (!seatData || seatData.uid !== myUid) { clearSession(); return; }
    mySeat = session.seat; isHost = !!session.isHost; myRoomCode = session.roomCode; myName = session.name;
    attachRoomListeners();
    const statusSnap = await db.ref(`rooms/${myRoomCode}/meta/status`).once('value');
    showScreen(screenForStatus(statusSnap.val() || 'LOBBY'));
  } catch (err) {
    console.error('Session restore failed', err);
    clearSession();
  }
}


/* ----------------------------------------------------------------------
   FIREBASE LISTENERS
   ---------------------------------------------------------------------- */

function listenOn(ref, eventType, handler) {
  ref.on(eventType, handler);
  activeListeners.push({ ref, eventType, handler });
}
function detachRoomListeners() {
  activeListeners.forEach(l => l.ref.off(l.eventType, l.handler));
  activeListeners = [];
}

function attachRoomListeners() {
  detachRoomListeners();
  const roomRef = db.ref('rooms/' + myRoomCode);

  listenOn(roomRef.child('players'), 'value', snap => { players = snap.val() || {}; renderEverything(); });
  listenOn(roomRef.child('meta'), 'value', snap => { roomMeta = snap.val() || {}; renderEverything(); });
  listenOn(roomRef.child('partnerships'), 'value', snap => { partnerships = snap.val() || {}; renderEverything(); });
  listenOn(roomRef.child('dealer'), 'value', snap => { dealerSeat = snap.val() || 'south'; roles = computeRoles(dealerSeat); renderEverything(); });
  listenOn(roomRef.child('handCounts'), 'value', snap => { handCounts = snap.val() || {}; renderEverything(); });
  listenOn(roomRef.child('bidding'), 'value', snap => { bidding = snap.val() || null; renderEverything(); });
  listenOn(roomRef.child('trump'), 'value', snap => { trump = snap.val() || null; renderEverything(); });
  listenOn(roomRef.child('doubleState'), 'value', snap => { doubleState = snap.val() || null; });
  listenOn(roomRef.child('singlePlayQueue'), 'value', snap => { singlePlayQueueLocal = snap.val() || []; renderEverything(); });
  listenOn(roomRef.child('singlePlay'), 'value', snap => { singlePlay = snap.val() || null; renderEverything(); });
  listenOn(roomRef.child('trick'), 'value', snap => { trick = snap.val() || null; renderEverything(); });
  listenOn(roomRef.child('tricksWon'), 'value', snap => { tricksWon = snap.val() || {}; renderEverything(); });
  listenOn(roomRef.child('teamPoints'), 'value', snap => { teamPoints = snap.val() || { 1: 0, 2: 0 }; renderEverything(); });
  listenOn(roomRef.child('teamScores'), 'value', snap => { teamScores = snap.val() || { 1: { points: 0, sets: 0 }, 2: { points: 0, sets: 0 } }; renderEverything(); });
  listenOn(roomRef.child('pairDeclared'), 'value', snap => { pairDeclared = snap.val() || null; renderEverything(); });
  listenOn(roomRef.child('currentTurnSeat'), 'value', snap => { currentTurnSeat = snap.val() || null; renderEverything(); });
  listenOn(roomRef.child('scoreHistory'), 'value', snap => renderScoreHistory(snap.val()));
  listenOn(roomRef.child('log'), 'child_added', snap => appendLogEntry(snap.val()));

  if (isHost) {
    listenOn(roomRef.child('hands'), 'value', snap => { latestHands = snap.val() || {}; myHand = latestHands[mySeat] || null; renderEverything(); });
    listenOn(roomRef.child('pendingSecondHands'), 'value', snap => { pendingSecondHands = snap.val() || {}; });
    listenOn(roomRef.child('actions'), 'child_added', snap => {
      const a = snap.val();
      if (a) hostProcessAction(a.seat, a.type, a.payload);
      snap.ref.remove();
    });
  } else {
    listenOn(roomRef.child('hands/' + mySeat), 'value', snap => { myHand = snap.val() || null; renderEverything(); });
  }
}

function pushLog(message) {
  if (!myRoomCode) return Promise.resolve();
  return db.ref(`rooms/${myRoomCode}/log`).push({ text: message, ts: firebase.database.ServerValue.TIMESTAMP });
}


/* ----------------------------------------------------------------------
   ACTION DISPATCH (non-host clients push here; host applies directly)
   ---------------------------------------------------------------------- */

function submitAction(type, payload) {
  if (!myRoomCode || !mySeat) return;
  if (isHost) {
    hostProcessAction(mySeat, type, payload || null);
  } else {
    db.ref(`rooms/${myRoomCode}/actions`).push({ seat: mySeat, type, payload: payload || null, ts: firebase.database.ServerValue.TIMESTAMP });
  }
}

function hostProcessAction(seat, type, payload) {
  if (!isHost) return;
  switch (type) {
    case 'BID': hostHandleBidAction(seat, 'BID', payload && payload.value); break;
    case 'PASS': hostHandleBidAction(seat, 'PASS'); break;
    case 'ACHI': hostHandleBidAction(seat, 'ACHI'); break;
    case 'TRUMP_CHOICE': hostHandleTrumpChoice(seat, payload && payload.suit); break;
    case 'DOUBLE_CHOICE': hostHandleDoubleChoice(seat, payload && payload.choice); break;
    case 'REDOUBLE_CHOICE': hostHandleRedoubleChoice(seat, payload && payload.choice); break;
    case 'SINGLE_REQUEST': hostHandleSingleRequest(seat); break;
    case 'SINGLE_DOUBLE_CHOICE': hostHandleSingleDoubleChoice(seat, payload && payload.choice); break;
    case 'PLAY_CARD': hostHandlePlayCard(seat, payload); break;
    case 'TRUMP_REVEAL_CHOICE': hostHandleTrumpRevealChoice(seat, payload && payload.choice); break;
    case 'DECLARE_PAIR': hostHandleDeclarePair(seat); break;
    default: console.warn('Unknown action type:', type);
  }
}


/* ----------------------------------------------------------------------
   LOBBY: seats, partnerships, start
   ---------------------------------------------------------------------- */

function lockPartnerships() {
  const partnershipMap = {};
  SEATS.forEach(seat => {
    const team2 = document.getElementById('partner-' + seat + '-2');
    partnershipMap[seat] = team2 && team2.checked ? 2 : 1;
  });
  const team1 = SEATS.filter(s => partnershipMap[s] === 1).map(seatLabel).join(' + ');
  const team2 = SEATS.filter(s => partnershipMap[s] === 2).map(seatLabel).join(' + ');

  db.ref(`rooms/${myRoomCode}/partnerships`).set(partnershipMap)
    .then(() => db.ref(`rooms/${myRoomCode}/meta/partnershipsLocked`).set(true))
    .then(() => pushLog(`হোস্ট পার্টনারশিপ লক করেছেন: ${team1} বনাম ${team2}।`))
    .catch(err => { console.error(err); alert('পার্টনারশিপ লক করা যায়নি। আবার চেষ্টা করুন।'); });
}

async function startGame() {
  if (!isHost) return;
  const startBtn = document.getElementById('btn-start-game');
  startBtn.disabled = true;
  try {
    teamScores = { 1: { points: 0, sets: 0 }, 2: { points: 0, sets: 0 } };
    dealerSeat = 'south';
    roles = computeRoles(dealerSeat);
    await db.ref(`rooms/${myRoomCode}/teamScores`).set(teamScores);
    await db.ref(`rooms/${myRoomCode}/dealer`).set('south');
    await db.ref(`rooms/${myRoomCode}/meta/round`).set(1);
    await db.ref(`rooms/${myRoomCode}/meta/status`).set('DEALING');
    dealAndCheckCancellation();
  } catch (err) {
    console.error(err);
    alert('খেলা শুরু করা যায়নি। আবার চেষ্টা করুন।');
    startBtn.disabled = false;
  }
}


/* ----------------------------------------------------------------------
   DEALING + CANCELLATION RULE #1 (no spot card for Player 1)
   ---------------------------------------------------------------------- */

function dealAllFromDeck(deck) {
  const first = {}, second = {};
  SEATS.forEach(s => { first[s] = []; second[s] = []; });
  let cursor = 0;
  for (let r = 0; r < 4; r++) { roles.dealOrder.forEach(seat => { first[seat].push(deck[cursor]); cursor++; }); }
  for (let r = 0; r < 4; r++) { roles.dealOrder.forEach(seat => { second[seat].push(deck[cursor]); cursor++; }); }
  return { firstHands: first, secondHands: second };
}

function dealAndCheckCancellation() {
  roles = computeRoles(dealerSeat);
  let hands, secondHands, attempts = 0;

  while (true) {
    attempts++;
    const deck = buildShuffledDeck();
    const dealt = dealAllFromDeck(deck);
    hands = dealt.firstHands;
    secondHands = dealt.secondHands;

    if (countSpotCards(hands[roles.p1]) === 0) {
      pushLog('ডিলারের ডানদিকের প্লেয়ারের হাতে কোনো ফোটা নেই। রাউন্ড বাতিল!');
      showBanner('কোনো ফোটা নেই — রাউন্ড বাতিল, নতুন করে তাস বণ্টন হচ্ছে...', 3500);
      if (attempts > 25) {
        pushLog('বারবার বাতিল হচ্ছে — অনুগ্রহ করে আবার "খেলা শুরু করুন" চাপুন।');
        db.ref(`rooms/${myRoomCode}/meta/status`).set('LOBBY');
        return;
      }
      continue;
    }
    break;
  }

  latestHands = hands;
  pendingSecondHands = secondHands;
  const counts = {}; SEATS.forEach(s => counts[s] = 4);

  db.ref(`rooms/${myRoomCode}/hands`).set(hands);
  db.ref(`rooms/${myRoomCode}/handCounts`).set(counts);
  db.ref(`rooms/${myRoomCode}/pendingSecondHands`).set(secondHands);
  pushLog('তাস বণ্টন করা হয়েছে। প্রত্যেকে ৪টি করে তাস পেয়েছেন।');
  initBiddingRound1();
}


/* ----------------------------------------------------------------------
   BIDDING ENGINE (3 rounds, Achi, 28-cap special rule)
   ---------------------------------------------------------------------- */

function writeBidding() { db.ref(`rooms/${myRoomCode}/bidding`).set(bidding).catch(e => console.error(e)); }

function initBiddingRound1() {
  bidding = { round: 1, defenderSeat: roles.p1, challengerSeat: roles.p2, currentBid: 0, locked: false, turnSeat: roles.p1, biddingClosed: false, finalWinner: null, finalBid: null };
  writeBidding();
  db.ref(`rooms/${myRoomCode}/meta/status`).set('BIDDING_ROUND_1');
  pushLog(`ডাকের পালা শুরু: ${seatLabel(roles.p1)} বনাম ${seatLabel(roles.p2)} (সর্বনিম্ন ডাক ১৬)।`);
  maybeTriggerBotBid();
}

function startRound2(carrySeat, carryBid) {
  if (carrySeat) {
    bidding = { round: 2, defenderSeat: carrySeat, challengerSeat: roles.p3, currentBid: carryBid, locked: true, turnSeat: roles.p3, biddingClosed: false, finalWinner: null, finalBid: null };
    pushLog(`রাউন্ড ২: ${seatLabel(carrySeat)} (ডাক ${bnNum(carryBid)}) বনাম ${seatLabel(roles.p3)}।`);
  } else {
    bidding = { round: 2, defenderSeat: roles.p2, challengerSeat: roles.p3, currentBid: 0, locked: false, turnSeat: roles.p2, biddingClosed: false, finalWinner: null, finalBid: null };
    pushLog(`রাউন্ড ২: ${seatLabel(roles.p2)} বনাম ${seatLabel(roles.p3)} (সর্বনিম্ন ডাক ১৬)।`);
  }
  db.ref(`rooms/${myRoomCode}/meta/status`).set('BIDDING_ROUND_2');
  writeBidding();
  maybeTriggerBotBid();
}

function startRound3(carrySeat, carryBid) {
  if (carrySeat) {
    bidding = { round: 3, defenderSeat: carrySeat, challengerSeat: roles.dealer, currentBid: carryBid, locked: true, turnSeat: roles.dealer, biddingClosed: false, finalWinner: null, finalBid: null };
    pushLog(`রাউন্ড ৩: ${seatLabel(carrySeat)} (ডাক ${bnNum(carryBid)}) বনাম ডিলার।`);
  } else {
    bidding = { round: 3, defenderSeat: roles.p3, challengerSeat: roles.dealer, currentBid: 0, locked: false, turnSeat: roles.p3, biddingClosed: false, finalWinner: null, finalBid: null };
    pushLog(`রাউন্ড ৩: ${seatLabel(roles.p3)} বনাম ডিলার (সর্বনিম্ন ডাক ১৬)।`);
  }
  db.ref(`rooms/${myRoomCode}/meta/status`).set('BIDDING_ROUND_3');
  writeBidding();
  maybeTriggerBotBid();
}

function advanceTurnToChallenger() {
  if (bidding.challengerSeat === roles.dealer && bidding.currentBid >= 28) {
    pushLog(`ডিলার ২৮-এর বেশি ডাকতে পারলেন না। ${seatLabel(bidding.defenderSeat)} ২৮ ডাকে জয়ী।`);
    resolveRoundEnd(bidding.round, bidding.defenderSeat, 28);
    return;
  }
  bidding.turnSeat = bidding.challengerSeat;
  writeBidding();
  maybeTriggerBotBid();
}

function hostHandleBidAction(seat, action, value) {
  if (!isHost || !bidding || bidding.biddingClosed) return;
  if (seat !== bidding.turnSeat) return;
  const round = bidding.round;
  const isDefenderTurn = seat === bidding.defenderSeat;

  if (isDefenderTurn && !bidding.locked) {
    if (action === 'PASS') { pushLog(`${seatLabel(seat)} ডাক না দিয়ে পাস করলেন।`); resolveRoundEnd(round, null, null); return; }
    if (action === 'BID') {
      bidding.currentBid = clampBid(value, 16, 28);
      bidding.locked = true;
      pushLog(`${seatLabel(seat)} ডাক দিলেন ${bnNum(bidding.currentBid)}।`);
      advanceTurnToChallenger();
      return;
    }
    return;
  }

  if (!isDefenderTurn) {
    if (action === 'PASS') {
      if (seat === roles.dealer) return; // dealer can never pass
      pushLog(`${seatLabel(seat)} পাস করলেন। ${seatLabel(bidding.defenderSeat)} ${bnNum(bidding.currentBid)} ডাকে জয়ী।`);
      resolveRoundEnd(round, bidding.defenderSeat, bidding.currentBid);
      return;
    }
    if (action === 'BID') {
      bidding.currentBid = clampBid(value, bidding.currentBid + 1, 28);
      bidding.turnSeat = bidding.defenderSeat;
      pushLog(`${seatLabel(seat)} ডাক বাড়ালেন ${bnNum(bidding.currentBid)}।`);
      writeBidding();
      maybeTriggerBotBid();
      return;
    }
    return;
  }

  // Defender's turn inside an active duel
  if (action === 'PASS') {
    pushLog(`${seatLabel(seat)} পাস করলেন। ${seatLabel(bidding.challengerSeat)} ${bnNum(bidding.currentBid)} ডাকে জয়ী।`);
    resolveRoundEnd(round, bidding.challengerSeat, bidding.currentBid);
    return;
  }
  if (action === 'ACHI') {
    if (bidding.currentBid === 28) { pushLog(`${seatLabel(seat)} আছি বললেন ২৮-এ! বিশেষ নিয়মে সরাসরি জয়ী।`); finalizeBidding(seat, 28, true, false); return; }
    pushLog(`${seatLabel(seat)} আছি বললেন, ডাক থাকলো ${bnNum(bidding.currentBid)}।`);
    advanceTurnToChallenger();
    return;
  }
  if (action === 'BID') {
    if (bidding.currentBid >= 28) return;
    bidding.currentBid = clampBid(value, bidding.currentBid + 1, 28);
    pushLog(`${seatLabel(seat)} ডাক বাড়ালেন ${bnNum(bidding.currentBid)}।`);
    advanceTurnToChallenger();
    return;
  }
}

function resolveRoundEnd(round, winnerSeat, winnerBid) {
  if (winnerSeat && winnerBid === 28) { finalizeBidding(winnerSeat, 28, true, false); return; }
  if (round === 1) { startRound2(winnerSeat, winnerBid); return; }
  if (round === 2) { startRound3(winnerSeat, winnerBid); return; }
  if (round === 3) {
    if (winnerSeat) {
      finalizeBidding(winnerSeat, winnerBid, false, false);
    } else {
      pushLog('সবাই পাস দিয়েছেন, ডিলার বাধ্য হয়ে ১৬ বিড নিলেন।');
      finalizeBidding(roles.dealer, 16, false, true);
    }
  }
}

function finalizeBidding(winnerSeat, bidAmount) {
  bidding.finalWinner = winnerSeat; bidding.finalBid = bidAmount; bidding.biddingClosed = true; bidding.turnSeat = null;
  writeBidding();
  db.ref(`rooms/${myRoomCode}/meta/status`).set('BIDDING_COMPLETE');
  db.ref(`rooms/${myRoomCode}/meta/bidWinnerSeat`).set(winnerSeat);
  db.ref(`rooms/${myRoomCode}/meta/bidWinnerAmount`).set(bidAmount);
  showBanner(`ডাক শেষ! ${seatLabel(winnerSeat)} সর্বোচ্চ ${bnNum(bidAmount)} ডাকে জয়ী হলেন।`, 4000);
  pushLog(`ডাক শেষ হয়েছে। ${seatLabel(winnerSeat)} সর্বোচ্চ ${bnNum(bidAmount)} ডাকে জয়ী।`);
  startTrumpSelection(winnerSeat);
}

function maybeTriggerBotBid() {
  if (!isHost || !bidding || bidding.biddingClosed) return;
  const p = players[bidding.turnSeat];
  if (p && p.isBot) setTimeout(() => runBotBidTurn(bidding.turnSeat), 1100 + Math.random() * 900);
}

// Bot bidding AI: strong cards (J/9) -> bid 16-20; weak hand -> pass;
// as forced Dealer, always raise by 1; as Defender in a duel, Achi below
// 19, otherwise raise with a strong hand or pass.
function runBotBidTurn(seat) {
  if (!isHost || !bidding || bidding.biddingClosed || bidding.turnSeat !== seat) return;
  const hand = latestHands[seat] || [];
  const strong = countStrongCards(hand);
  const spots = countSpotCards(hand);
  const isDefTurn = seat === bidding.defenderSeat;

  if (isDefTurn && !bidding.locked) {
    if (strong >= 1 || spots >= 2) hostHandleBidAction(seat, 'BID', Math.min(16 + strong, 20));
    else hostHandleBidAction(seat, 'PASS');
    return;
  }
  if (!isDefTurn) {
    if (seat === roles.dealer) { hostHandleBidAction(seat, 'BID', bidding.currentBid < 28 ? bidding.currentBid + 1 : 28); return; }
    const wantsRaise = strong >= 1 && bidding.currentBid < (16 + strong + 2) && bidding.currentBid < 28;
    if (wantsRaise) hostHandleBidAction(seat, 'BID', bidding.currentBid + 1);
    else hostHandleBidAction(seat, 'PASS');
    return;
  }
  if (bidding.currentBid < 19) hostHandleBidAction(seat, 'ACHI');
  else if (strong >= 2 && bidding.currentBid < 28) hostHandleBidAction(seat, 'BID', bidding.currentBid + 1);
  else hostHandleBidAction(seat, 'PASS');
}


/* ----------------------------------------------------------------------
   TRUMP SELECTION
   ---------------------------------------------------------------------- */

function startTrumpSelection(winnerSeat) {
  db.ref(`rooms/${myRoomCode}/meta/status`).set('TRUMP_SELECT');
  if (players[winnerSeat] && players[winnerSeat].isBot) setTimeout(() => botChooseTrump(winnerSeat), 1200);
}

// Bot trump AI: pick the suit it holds the most of (2+); otherwise "Second".
function botChooseTrump(seat) {
  const hand = latestHands[seat] || [];
  const counts = { S: 0, H: 0, D: 0, C: 0 };
  hand.forEach(c => counts[c.suit]++);
  let best = null, bestN = 0;
  Object.keys(counts).forEach(s => { if (counts[s] > bestN) { bestN = counts[s]; best = s; } });
  hostHandleTrumpChoice(seat, bestN >= 2 ? best : 'SECOND');
}

function hostHandleTrumpChoice(seat, value) {
  if (!isHost || !roomMeta || roomMeta.status !== 'TRUMP_SELECT' || seat !== roomMeta.bidWinnerSeat) return;

  if (value === 'SECOND') {
    const reserved = pendingSecondHands[seat] || [];
    const thirdCard = reserved[2]; // 3rd of the winner's remaining 4 = 7th card overall
    if (!thirdCard) { console.error('No reserved card for Second option'); return; }
    thirdCard.locked = true;
    trump = { suit: thirdCard.suit, revealed: false, method: 'SECOND' };
    latestHands[seat] = (latestHands[seat] || []).concat([thirdCard]);
    db.ref(`rooms/${myRoomCode}/hands/${seat}`).set(latestHands[seat]);
    db.ref(`rooms/${myRoomCode}/handCounts/${seat}`).set(latestHands[seat].length);
    pushLog(`${seatLabel(seat)} দ্বিতীয় অপশনে ট্রাম্প সেট করেছেন। (রঙ গোপন)`);
  } else {
    trump = { suit: value, revealed: false, method: 'DIRECT' };
    pushLog(`${seatLabel(seat)} ট্রাম্প কালার সেট করেছেন।`);
  }
  db.ref(`rooms/${myRoomCode}/trump`).set(trump);
  startDoubleWindow();
}


/* ----------------------------------------------------------------------
   DOUBLE / REDOUBLE
   ---------------------------------------------------------------------- */

function startDoubleWindow() {
  db.ref(`rooms/${myRoomCode}/meta/status`).set('DOUBLE_WINDOW');
  pointMultiplier = 1;
  db.ref(`rooms/${myRoomCode}/meta/pointMultiplier`).set(1);
  const opps = SEATS.filter(s => partnerships[s] !== partnerships[roomMeta.bidWinnerSeat]);
  opps.forEach(s => { if (players[s] && players[s].isBot) setTimeout(() => botDoubleDecision(s), 1200); });
}

function hostHandleDoubleChoice(seat, choice) {
  if (!isHost || !roomMeta || roomMeta.status !== 'DOUBLE_WINDOW') return;
  if (partnerships[seat] === partnerships[roomMeta.bidWinnerSeat]) return;
  if (choice === 'DOUBLE') {
    pointMultiplier = 2;
    db.ref(`rooms/${myRoomCode}/meta/pointMultiplier`).set(2);
    pushLog('অপোনেন্ট গেম ডবল করেছেন!');
    startRedoubleWindow();
  } else {
    pushLog(`${seatLabel(seat)} ডবল স্কিপ করলেন। খেলা স্বাভাবিক থাকবে।`);
    proceedToSecondDeal();
  }
}

function startRedoubleWindow() {
  db.ref(`rooms/${myRoomCode}/meta/status`).set('REDOUBLE_WINDOW');
  const teamSeats = SEATS.filter(s => partnerships[s] === partnerships[roomMeta.bidWinnerSeat]);
  teamSeats.forEach(s => { if (players[s] && players[s].isBot) setTimeout(() => botRedoubleDecision(s), 1200); });
}

function hostHandleRedoubleChoice(seat, choice) {
  if (!isHost || !roomMeta || roomMeta.status !== 'REDOUBLE_WINDOW') return;
  if (partnerships[seat] !== partnerships[roomMeta.bidWinnerSeat]) return;
  if (choice === 'REDOUBLE') {
    pointMultiplier = 4;
    db.ref(`rooms/${myRoomCode}/meta/pointMultiplier`).set(4);
    pushLog('উইনার টিম রি-ডাবল করেছেন!');
  } else {
    pushLog('উইনার টিম রি-ডাবল করেননি। ডাবল বহাল থাকবে।');
  }
  proceedToSecondDeal();
}

// Bot heuristics: opponents double vs a human winner's high bid (22+);
// winner-team bot redoubles with a strong-looking hand.
function botDoubleDecision(seat) {
  const winnerIsHuman = players[roomMeta.bidWinnerSeat] && !players[roomMeta.bidWinnerSeat].isBot;
  hostHandleDoubleChoice(seat, (winnerIsHuman && bidding.finalBid >= 22) ? 'DOUBLE' : 'SKIP');
}
function botRedoubleDecision(seat) {
  const hand = latestHands[seat] || [];
  hostHandleRedoubleChoice(seat, countStrongCards(hand) >= 2 ? 'REDOUBLE' : 'SKIP');
}


/* ----------------------------------------------------------------------
   SECOND DEAL + CANCELLATION RULES #3, #4, #5
   ---------------------------------------------------------------------- */

function proceedToSecondDeal() {
  db.ref(`rooms/${myRoomCode}/meta/status`).set('SECOND_DEAL');
  SEATS.forEach(seat => {
    const already = latestHands[seat] || [];
    let toAdd = (pendingSecondHands[seat] || []).slice();
    if (seat === roomMeta.bidWinnerSeat && trump.method === 'SECOND') {
      toAdd = toAdd.filter((c, i) => i !== 2); // the 3rd card was already given during trump selection
    }
    latestHands[seat] = already.concat(toAdd);
  });
  db.ref(`rooms/${myRoomCode}/hands`).set(latestHands);
  const counts = {}; SEATS.forEach(s => counts[s] = latestHands[s].length);
  db.ref(`rooms/${myRoomCode}/handCounts`).set(counts);
  pushLog('বাকি তাস বণ্টন করা হয়েছে। সবার কাছে এখন ৮টি করে তাস।');
  runCancellationChecks345();
}

function runCancellationChecks345() {
  for (const seat of SEATS) {
    if ((latestHands[seat] || []).filter(c => c.rank === 'J').length === 4) {
      cancelAndRedeal('একই প্লেয়ারের কাছে ৪টি Jack! রাউন্ড বাতিল।');
      return;
    }
  }
  if (trump.method === 'SECOND') {
    const winnerTrumps = (latestHands[roomMeta.bidWinnerSeat] || []).filter(c => c.suit === trump.suit).length;
    if (winnerTrumps <= 1) { cancelAndRedeal('সেকেন্ড অপশনে মাত্র একটি ট্রাম্প পাওয়ায় রাউন্ড বাতিল!'); return; }
  }
  const oppSeats = SEATS.filter(s => partnerships[s] !== partnerships[roomMeta.bidWinnerSeat]);
  const oppTrumpTotal = oppSeats.reduce((sum, s) => sum + (latestHands[s] || []).filter(c => c.suit === trump.suit).length, 0);
  if (oppTrumpTotal === 0) { cancelAndRedeal('প্রতিপক্ষের কাছে কোনো ট্রাম্প কার্ড নেই। রাউন্ড বাতিল।'); return; }

  startSinglePlayWindow();
}

function cancelAndRedeal(message) {
  pushLog(message);
  showBanner(message, 4000);
  resetRoundState();
  db.ref(`rooms/${myRoomCode}/meta/status`).set('DEALING');
  dealAndCheckCancellation();
}

function resetRoundState() {
  if (singlePlayWindowTimer) { clearTimeout(singlePlayWindowTimer); singlePlayWindowTimer = null; }
  bidding = null; trump = null; doubleState = null; singlePlay = null;
  singlePlayQueueLocal = []; trick = null; tricksWon = {}; teamPoints = { 1: 0, 2: 0 };
  pairDeclared = null; currentTurnSeat = null; pendingSecondHands = {}; pointMultiplier = 1; trickNumber = 1;

  const code = myRoomCode;
  db.ref(`rooms/${code}/bidding`).set(null);
  db.ref(`rooms/${code}/trump`).set(null);
  db.ref(`rooms/${code}/doubleState`).set(null);
  db.ref(`rooms/${code}/singlePlay`).set(null);
  db.ref(`rooms/${code}/singlePlayQueue`).set(null);
  db.ref(`rooms/${code}/trick`).set(null);
  db.ref(`rooms/${code}/tricksWon`).set(null);
  db.ref(`rooms/${code}/teamPoints`).set({ 1: 0, 2: 0 });
  db.ref(`rooms/${code}/pairDeclared`).set(null);
  db.ref(`rooms/${code}/currentTurnSeat`).set(null);
  db.ref(`rooms/${code}/pendingSecondHands`).set(null);
  db.ref(`rooms/${code}/meta/bidWinnerSeat`).set(null);
  db.ref(`rooms/${code}/meta/bidWinnerAmount`).set(null);
  db.ref(`rooms/${code}/meta/pointMultiplier`).set(1);
}


/* ----------------------------------------------------------------------
   SINGLE PLAY — priority queue (bonus rule #3)
   ---------------------------------------------------------------------- */

function startSinglePlayWindow() {
  db.ref(`rooms/${myRoomCode}/meta/status`).set('SINGLE_PLAY_WINDOW');
  singlePlayQueueLocal = [];
  db.ref(`rooms/${myRoomCode}/singlePlayQueue`).set([]);
  if (singlePlayWindowTimer) clearTimeout(singlePlayWindowTimer);
  singlePlayWindowTimer = setTimeout(() => finalizeSinglePlayWindow(), 6000);
}

function hostHandleSingleRequest(seat) {
  if (!isHost || !roomMeta || roomMeta.status !== 'SINGLE_PLAY_WINDOW') return;
  if (singlePlayQueueLocal.includes(seat)) return;
  singlePlayQueueLocal.push(seat);
  db.ref(`rooms/${myRoomCode}/singlePlayQueue`).set(singlePlayQueueLocal);
  pushLog(`${seatLabel(seat)} সিঙ্গেল খেলার আবেদন করেছেন।`);
}

function finalizeSinglePlayWindow() {
  if (!isHost || !roomMeta || roomMeta.status !== 'SINGLE_PLAY_WINDOW') return;
  if (singlePlayQueueLocal.length === 0) { startNormalPlay(); return; }
  trySingleForNextInQueue();
}

// Priority queue: try the first requester; if their Single gets cancelled
// (opponents both void in the led suit), move to the next requester; only
// once the queue is exhausted does play fall back to Normal/Double.
function trySingleForNextInQueue() {
  if (singlePlayQueueLocal.length === 0) {
    pushLog('সব সিঙ্গেল আবেদন বাতিল হওয়ায় স্বাভাবিক খেলা শুরু হচ্ছে।');
    startNormalPlay();
    return;
  }
  const seat = singlePlayQueueLocal.shift();
  db.ref(`rooms/${myRoomCode}/singlePlayQueue`).set(singlePlayQueueLocal);
  startSinglePlayFor(seat);
}

function startSinglePlayFor(seat) {
  singlePlay = { active: true, seat, partnerSeat: getPartnerSeat(seat), opponentDoubled: false, state: 'ACTIVE' };
  db.ref(`rooms/${myRoomCode}/singlePlay`).set(singlePlay);
  db.ref(`rooms/${myRoomCode}/meta/status`).set('SINGLE_PLAY_DOUBLE_WINDOW');
  pushLog(`${seatLabel(seat)} সিঙ্গেল খেলা শুরু করলেন!`);
  const opps = SEATS.filter(s => partnerships[s] !== partnerships[seat]);
  opps.forEach(s => { if (players[s] && players[s].isBot) setTimeout(() => botSingleDoubleDecision(s), 1000); });
}

function hostHandleSingleDoubleChoice(seat, choice) {
  if (!isHost || !roomMeta || roomMeta.status !== 'SINGLE_PLAY_DOUBLE_WINDOW' || !singlePlay) return;
  if (partnerships[seat] === partnerships[singlePlay.seat]) return;
  singlePlay.opponentDoubled = choice === 'DOUBLE';
  db.ref(`rooms/${myRoomCode}/singlePlay`).set(singlePlay);
  pushLog(choice === 'DOUBLE' ? 'অপোনেন্ট সিঙ্গেল ডবল করেছেন! (৬ পয়েন্ট)' : 'অপোনেন্ট ডবল স্কিপ করলেন। (৩ পয়েন্ট)');
  beginTrickPlay();
}
function botSingleDoubleDecision(seat) { hostHandleSingleDoubleChoice(seat, Math.random() < 0.3 ? 'DOUBLE' : 'SKIP'); }

function startNormalPlay() { beginTrickPlay(); }


/* ----------------------------------------------------------------------
   TRICK PLAY: leads, follow-suit, trump-must, over-trump
   ---------------------------------------------------------------------- */

function beginTrickPlay() {
  db.ref(`rooms/${myRoomCode}/meta/status`).set('PLAYING');
  tricksWon = {}; SEATS.forEach(s => tricksWon[s] = 0);
  teamPoints = { 1: 0, 2: 0 };
  db.ref(`rooms/${myRoomCode}/tricksWon`).set(tricksWon);
  db.ref(`rooms/${myRoomCode}/teamPoints`).set(teamPoints);
  trickNumber = 1;
  const leader = (singlePlay && singlePlay.active) ? singlePlay.seat : roomMeta.bidWinnerSeat;
  trick = { leaderSeat: leader, cardsPlayed: {}, leadSuit: null, trumpForcedSeat: null };
  db.ref(`rooms/${myRoomCode}/trick`).set(trick);
  setTurnSeat(leader);
  maybeTriggerBotCardPlay();
}

function setTurnSeat(seat) {
  currentTurnSeat = seat;
  db.ref(`rooms/${myRoomCode}/currentTurnSeat`).set(seat);
}

function hostHandlePlayCard(seat, cardKey) {
  if (!isHost || !roomMeta || roomMeta.status !== 'PLAYING' || !trick) return;
  if (seat !== currentTurnSeat) return;
  if (singlePlay && singlePlay.active && seat === singlePlay.partnerSeat) return; // deactivated

  const hand = latestHands[seat] || [];
  const idx = hand.findIndex(c => c.suit === cardKey.suit && c.rank === cardKey.rank);
  if (idx === -1) return;
  const card = hand[idx];
  if (card.locked && !(trump && trump.revealed)) return; // locked 7th card (Second option)

  const leadSuit = trick.leadSuit;
  if (leadSuit) {
    const hasLead = hand.some(c => c.suit === leadSuit);
    if (trick.trumpForcedSeat === seat) {
      const hasTrump = hand.some(c => c.suit === trump.suit);
      if (hasTrump && card.suit !== trump.suit) return; // Trump Must rule
    } else if (hasLead && card.suit !== leadSuit) {
      return; // must follow suit if able
    }
    if (trump.revealed && card.suit === trump.suit) {
      const trumpsInTrick = Object.values(trick.cardsPlayed).filter(c => c.suit === trump.suit);
      if (trumpsInTrick.length > 0) {
        const bestIdx = Math.min(...trumpsInTrick.map(c => POWER_ORDER.indexOf(c.rank)));
        const higherOwned = hand.some(c => c.suit === trump.suit && POWER_ORDER.indexOf(c.rank) < bestIdx);
        if (higherOwned && POWER_ORDER.indexOf(card.rank) >= bestIdx) return; // Over-Trump rule
      }
    }
  }

  // Legal — commit the play
  hand.splice(idx, 1);
  latestHands[seat] = hand;
  trick.cardsPlayed[seat] = card;

  if (!trick.leadSuit) {
    trick.leadSuit = card.suit;
    if (singlePlay && singlePlay.active && seat === singlePlay.seat) {
      const opps = SEATS.filter(s => partnerships[s] !== partnerships[seat]);
      const anyHasSuit = opps.some(s => (latestHands[s] || []).some(c => c.suit === card.suit));
      if (!anyHasSuit) {
        pushLog('উভয় প্রতিপক্ষের কাছে ঐ স্যুট না থাকায় সিঙ্গেল খেলা বাতিল হলো।');
        latestHands[seat].push(card); // give the led card back
        trick.cardsPlayed = {}; trick.leadSuit = null;
        db.ref(`rooms/${myRoomCode}/hands/${seat}`).set(latestHands[seat]);
        db.ref(`rooms/${myRoomCode}/handCounts/${seat}`).set(latestHands[seat].length);
        cancelSinglePlayAndRevert();
        return;
      }
    }
  }

  db.ref(`rooms/${myRoomCode}/hands/${seat}`).set(latestHands[seat]);
  db.ref(`rooms/${myRoomCode}/handCounts/${seat}`).set(latestHands[seat].length);
  db.ref(`rooms/${myRoomCode}/trick`).set(trick);
  pushLog(`${seatLabel(seat)} খেললেন ${card.rank}${SUIT_SYMBOL[card.suit]}।`);

  const requiredSeats = (singlePlay && singlePlay.active) ? SEATS.filter(s => s !== singlePlay.partnerSeat) : SEATS;
  if (Object.keys(trick.cardsPlayed).length >= requiredSeats.length) {
    resolveTrick();
  } else {
    const next = nextSeatInPlay(seat);
    setTurnSeat(next);
    maybeTriggerBotCardPlay();
  }
}

function cancelSinglePlayAndRevert() {
  singlePlay = null;
  db.ref(`rooms/${myRoomCode}/singlePlay`).set(null);
  db.ref(`rooms/${myRoomCode}/meta/status`).set('SINGLE_PLAY_WINDOW');
  trySingleForNextInQueue();
}

function resolveTrick() {
  const cards = trick.cardsPlayed;
  const leadSuit = trick.leadSuit;
  let winnerSeat = null, best = -1;
  Object.keys(cards).forEach(seat => {
    const c = cards[seat];
    let score;
    if (trump.revealed && c.suit === trump.suit) score = 100 - POWER_ORDER.indexOf(c.rank);
    else if (c.suit === leadSuit) score = 50 - POWER_ORDER.indexOf(c.rank);
    else score = -1;
    if (score > best) { best = score; winnerSeat = seat; }
  });

  const points = Object.values(cards).reduce((s, c) => s + POINT_VALUES[c.rank], 0);
  tricksWon[winnerSeat] = (tricksWon[winnerSeat] || 0) + 1;
  const team = partnerships[winnerSeat];
  teamPoints[team] = (teamPoints[team] || 0) + points;

  db.ref(`rooms/${myRoomCode}/tricksWon`).set(tricksWon);
  db.ref(`rooms/${myRoomCode}/teamPoints`).set(teamPoints);
  pushLog(`${seatLabel(winnerSeat)} এই দান জিতলেন (${bnNum(points)} পয়েন্ট)।`);
  showBanner(`${seatLabel(winnerSeat)} দান জিতলেন!`, 1500);

  trickNumber++;
  if (trickNumber > 8) { finishRound(); return; }

  trick = { leaderSeat: winnerSeat, cardsPlayed: {}, leadSuit: null, trumpForcedSeat: null };
  db.ref(`rooms/${myRoomCode}/trick`).set(trick);
  setTurnSeat(winnerSeat);
  maybeTriggerBotCardPlay();
}

function hostHandleTrumpRevealChoice(seat, choice) {
  if (!isHost || !roomMeta || roomMeta.status !== 'PLAYING' || seat !== currentTurnSeat || !trick) return;
  if (choice === 'TRUMP') {
    trump.revealed = true;
    trick.trumpForcedSeat = seat;
    db.ref(`rooms/${myRoomCode}/trump`).set(trump);
    db.ref(`rooms/${myRoomCode}/trick`).set(trick);
    pushLog(`${seatLabel(seat)} ট্রাম্প ডাকলেন! ট্রাম্প উন্মোচিত হলো।`);
    showBanner(`ট্রাম্প উন্মোচিত: ${SUIT_SYMBOL[trump.suit]}`, 3000);
  }
}

function hostHandleDeclarePair(seat) {
  if (!isHost || !roomMeta || roomMeta.status !== 'PLAYING' || pairDeclared || !trump || !trump.revealed) return;
  const hand = latestHands[seat] || [];
  const hasK = hand.some(c => c.suit === trump.suit && c.rank === 'K');
  const hasQ = hand.some(c => c.suit === trump.suit && c.rank === 'Q');
  if (!hasK || !hasQ) return;
  const teamSeats = SEATS.filter(s => partnerships[s] === partnerships[seat]);
  if (!teamSeats.some(s => (tricksWon[s] || 0) > 0)) return;

  pairDeclared = { seat, suit: trump.suit, byBidWinnerTeam: partnerships[seat] === partnerships[roomMeta.bidWinnerSeat] };
  db.ref(`rooms/${myRoomCode}/pairDeclared`).set(pairDeclared);
  pushLog(`${seatLabel(seat)} কিং-কুইন জোড়া ঘোষণা করলেন! (৪ পয়েন্ট প্রভাব)`);
  showBanner(`${seatLabel(seat)} জোড়া ঘোষণা করলেন!`, 3000);
}


/* ----------------------------------------------------------------------
   BOT CARD PLAY (very simple heuristic AI)
   ---------------------------------------------------------------------- */

function maybeTriggerBotCardPlay() {
  if (!isHost || !currentTurnSeat) return;
  const p = players[currentTurnSeat];
  if (p && p.isBot) setTimeout(() => runBotCardPlay(currentTurnSeat), 1000 + Math.random() * 900);
}

function runBotCardPlay(seat) {
  if (!isHost || currentTurnSeat !== seat || !roomMeta || roomMeta.status !== 'PLAYING' || !trick) return;
  const hand = latestHands[seat] || [];

  if (!pairDeclared && trump && trump.revealed) {
    const hasK = hand.some(c => c.suit === trump.suit && c.rank === 'K');
    const hasQ = hand.some(c => c.suit === trump.suit && c.rank === 'Q');
    const teamSeats = SEATS.filter(s => partnerships[s] === partnerships[seat]);
    if (hasK && hasQ && teamSeats.some(s => (tricksWon[s] || 0) > 0)) hostHandleDeclarePair(seat);
  }

  const leadSuit = trick.leadSuit;
  if (leadSuit && trump && !trump.revealed) {
    const hasLead = hand.some(c => c.suit === leadSuit);
    if (!hasLead) {
      const strongTrump = hand.some(c => c.suit === trump.suit && (c.rank === 'J' || c.rank === '9'));
      hostHandleTrumpRevealChoice(seat, strongTrump ? 'TRUMP' : 'NO_TRUMP');
    }
  }

  let legal = hand.filter(c => !(c.locked && !(trump && trump.revealed)));
  if (leadSuit) {
    const followers = legal.filter(c => c.suit === leadSuit);
    if (followers.length > 0) legal = followers;
    if (trick.trumpForcedSeat === seat) {
      const trumps = legal.filter(c => c.suit === trump.suit);
      if (trumps.length > 0) legal = trumps;
    }
  }
  if (legal.length === 0) legal = hand;

  legal.sort((a, b) => POINT_VALUES[a.rank] - POINT_VALUES[b.rank]);
  const card = legal[0];
  hostHandlePlayCard(seat, { suit: card.suit, rank: card.rank });
}


/* ----------------------------------------------------------------------
   SCORING: target adjustment, sets, all-8-tricks bonus, redouble shutout,
   score history, dealer rotation
   ---------------------------------------------------------------------- */

function computeAdjustedTarget(baseTarget, pairInfo) {
  let target = baseTarget;
  if (pairInfo) {
    if (pairInfo.byBidWinnerTeam) target = Math.max(16, target - 4);
    else target = target + 4;
  }
  return target;
}

// Handles the SET mechanism: reaching 6 points banks a Set and resets to 0;
// dropping below 0 breaks a Set and reverts to (6 + the negative remainder).
function applyTeamScoreChange(team, delta) {
  const t = teamScores[team] || { points: 0, sets: 0 };
  let pts = t.points + delta;
  if (delta > 0) {
    while (pts >= 6) { t.sets += 1; pts -= 6; }
  } else if (pts < 0) {
    if (t.sets > 0) { t.sets -= 1; pts = 6 + pts; }
    else pts = 0;
  }
  t.points = pts;
  teamScores[team] = t;
}

function saveRoundToScoreHistory(winningTeam, delta) {
  const roundId = 'r' + Date.now();
  const t1 = SEATS.filter(s => partnerships[s] === 1).map(s => (players[s] && players[s].name) || seatLabel(s)).join(' ও ');
  const t2 = SEATS.filter(s => partnerships[s] === 2).map(s => (players[s] && players[s].name) || seatLabel(s)).join(' ও ');
  db.ref(`rooms/${myRoomCode}/scoreHistory/${roundId}`).set({
    round: roomMeta.round || 1,
    trump: trump ? SUIT_SYMBOL[trump.suit] : '--',
    team1: teamScores[1].points, team1Sets: teamScores[1].sets, team1Label: t1,
    team2: teamScores[2].points, team2Sets: teamScores[2].sets, team2Label: t2,
    winnerLabel: winningTeam === 1 ? 'দল ১' : 'দল ২', delta
  });
}

function finishRound() {
  db.ref(`rooms/${myRoomCode}/meta/status`).set('ROUND_SCORING');
  const isSingle = !!(singlePlay && singlePlay.active);

  // Bonus rule: Redouble shutout cancellation (Normal/Double redouble path only)
  if (!isSingle && pointMultiplier === 4) {
    const bidTeam = partnerships[roomMeta.bidWinnerSeat];
    const oppTeam = bidTeam === 1 ? 2 : 1;
    const oppSeats = SEATS.filter(s => partnerships[s] === oppTeam);
    const oppTricks = oppSeats.reduce((s, seat) => s + (tricksWon[seat] || 0), 0);
    if (oppTricks === 0) { cancelAndRedeal('রি-ডাবলে প্রতিপক্ষ একটিও দান জিততে পারেননি — রাউন্ড বাতিল।'); return; }
  }

  let winningTeam, losingTeam, delta, bonus = 0;

  if (isSingle) {
    const singleSeat = singlePlay.seat;
    const singleTeam = partnerships[singleSeat];
    const oppTeam = singleTeam === 1 ? 2 : 1;
    const singleWon = (tricksWon[singleSeat] || 0) === 8;
    delta = singlePlay.opponentDoubled ? 6 : 3;
    if (singleWon) {
      winningTeam = singleTeam; losingTeam = oppTeam;
      pushLog(`${seatLabel(singleSeat)} সিঙ্গেলে সবকটি দান জিতে খেলা জিতলেন!`);
      nextDealerSeat = singleSeat;
    } else {
      winningTeam = oppTeam; losingTeam = singleTeam;
      pushLog(`${seatLabel(singleSeat)} সিঙ্গেলে সব দান জিততে পারেননি। প্রতিপক্ষ জয়ী!`);
    }
  } else {
    const bidTeam = partnerships[roomMeta.bidWinnerSeat];
    const oppTeam = bidTeam === 1 ? 2 : 1;
    const target = computeAdjustedTarget(bidding.finalBid, pairDeclared);
    const bidTeamPoints = teamPoints[bidTeam] || 0;
    const biddingWon = bidTeamPoints >= target;
    winningTeam = biddingWon ? bidTeam : oppTeam;
    losingTeam = biddingWon ? oppTeam : bidTeam;
    delta = pointMultiplier;

    // Bonus rule: all-8-tricks +1 (Normal & Double only)
    if (pointMultiplier === 1 || pointMultiplier === 2) {
      const winnerSeats = SEATS.filter(s => partnerships[s] === winningTeam);
      const winnerTricks = winnerSeats.reduce((s, seat) => s + (tricksWon[seat] || 0), 0);
      if (winnerTricks === 8) {
        bonus = 1;
        pushLog(`${winningTeam === 1 ? 'দল ১' : 'দল ২'} সবকটি ৮টি দান জিতে ১ বোনাস পয়েন্ট পেলেন!`);
      }
    }
    pushLog(`রাউন্ড শেষ। ${winningTeam === 1 ? 'দল ১' : 'দল ২'} জয়ী! লক্ষ্য ছিল ${bnNum(target)}, তারা তুলেছেন ${bnNum(bidTeamPoints)}।`);
  }

  const totalDelta = delta + bonus;
  applyTeamScoreChange(winningTeam, totalDelta);
  applyTeamScoreChange(losingTeam, -totalDelta);
  db.ref(`rooms/${myRoomCode}/teamScores`).set(teamScores);

  saveRoundToScoreHistory(winningTeam, totalDelta);
  showBanner(`রাউন্ড শেষ! ${winningTeam === 1 ? 'দল ১' : 'দল ২'} +${bnNum(totalDelta)} পয়েন্ট।`, 4500);
  setTimeout(() => rotateDealerAndStartNextRound(), 3500);
}

function rotateDealerAndStartNextRound() {
  const newDealer = nextDealerSeat || nextHumanDealer(dealerSeat);
  nextDealerSeat = null;
  dealerSeat = newDealer;
  roles = computeRoles(dealerSeat);
  db.ref(`rooms/${myRoomCode}/dealer`).set(dealerSeat);
  db.ref(`rooms/${myRoomCode}/meta/round`).set((roomMeta.round || 1) + 1);
  resetRoundState();
  db.ref(`rooms/${myRoomCode}/meta/status`).set('DEALING');
  pushLog(`পরবর্তী রাউন্ড শুরু হচ্ছে। নতুন ডিলার: ${seatLabel(dealerSeat)}।`);
  dealAndCheckCancellation();
}


/* ----------------------------------------------------------------------
   RENDERING
   ---------------------------------------------------------------------- */

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('screen--active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('screen--active');
}
function screenForStatus(status) { return status === 'LOBBY' ? 'screen-lobby' : 'screen-game'; }

function renderRoomCodeDisplay() {
  if (!myRoomCode) return;
  const container = document.getElementById('room-code-display');
  const valueField = document.getElementById('room-code-value');
  valueField.value = myRoomCode;
  container.innerHTML = '';
  toBengaliDigits(myRoomCode).split('').forEach(d => {
    const span = document.createElement('span');
    span.className = 'rc-digit';
    span.textContent = d;
    container.appendChild(span);
  });
}

function renderLobbySeats() {
  SEATS.forEach(seat => {
    const p = players[seat];
    const card = document.getElementById('lobby-seat-' + seat);
    const avatar = document.getElementById('lobby-avatar-' + seat);
    const nameEl = document.getElementById('lobby-name-' + seat);
    const badge = document.getElementById('lobby-badge-' + seat);
    if (!card) return;
    if (!p || p.role === 'OPEN') {
      card.classList.add('seat-card--empty');
      avatar.className = 'seat-avatar seat-avatar--empty'; avatar.textContent = '?';
      nameEl.className = 'seat-card-name seat-card-name--empty'; nameEl.textContent = 'খালি আসন';
      badge.className = 'seat-card-badge seat-card-badge--waiting'; badge.textContent = 'অপেক্ষমান';
    } else {
      card.classList.remove('seat-card--empty');
      avatar.className = 'seat-avatar seat-avatar--filled'; avatar.textContent = (p.name || '?').charAt(0);
      nameEl.className = 'seat-card-name'; nameEl.textContent = p.name + (p.isHost ? ' (হোস্ট)' : '');
      if (p.isBot) { badge.className = 'seat-card-badge seat-card-badge--bot'; badge.textContent = 'বট'; }
      else if (p.isHost) { badge.className = 'seat-card-badge seat-card-badge--host'; badge.textContent = 'হোস্ট / ডিলার'; }
      else { badge.className = 'seat-card-badge seat-card-badge--host'; badge.textContent = 'খেলোয়াড়'; }
    }
  });

  const allFilled = SEATS.every(seat => players[seat] && players[seat].role !== 'OPEN');
  const note = document.getElementById('lobby-waiting-note');
  const panel = document.getElementById('partnership-panel');
  if (isHost && allFilled) { panel.classList.remove('is-hidden'); note.classList.add('is-hidden'); }
  else {
    panel.classList.add('is-hidden'); note.classList.remove('is-hidden');
    note.textContent = allFilled ? 'হোস্ট পার্টনারশিপ নির্ধারণ করছেন...' : 'সব আসন পূরণ হওয়ার অপেক্ষায়...';
  }
}

function renderPartnershipPanel() {
  SEATS.forEach(seat => {
    const p = players[seat];
    const el = document.getElementById('partnership-name-' + seat);
    if (el) el.textContent = p && p.name ? p.name + (p.isBot ? ' (বট)' : '') : '—';
  });
}

function renderMetaUI() {
  if (!roomMeta || !roomMeta.status) return;
  currentMode = roomMeta.mode || currentMode;
  const modeChip = document.getElementById('lobby-mode-chip');
  if (modeChip && MODE_CONFIG[currentMode]) modeChip.textContent = MODE_CONFIG[currentMode].label;
  document.getElementById('room-chip-game').textContent = 'রুম: ' + bnDigitsOf(myRoomCode || '');
  const roundChip = document.getElementById('round-chip');
  if (roundChip) roundChip.textContent = 'রাউন্ড ' + bnNum(roomMeta.round || 1);
  const startBtn = document.getElementById('btn-start-game');
  if (startBtn) startBtn.disabled = isHost ? !roomMeta.partnershipsLocked : true;
  showScreen(screenForStatus(roomMeta.status));
}

function renderGameSeatMarkers() {
  SEATS.forEach(seat => {
    const p = players[seat];
    if (!p) return;
    const nameEl = document.getElementById('marker-name-' + seat);
    const avatarEl = document.getElementById('marker-avatar-' + seat);
    if (nameEl) nameEl.textContent = seat === mySeat ? 'আপনি' : (p.name || '—');
    if (avatarEl) avatarEl.textContent = (p.name || '?').charAt(0);
  });
  renderHandCounts();
}

function renderHandCounts() {
  SEATS.forEach(seat => {
    const el = document.getElementById('marker-count-' + seat);
    if (!el) return;
    if (seat === mySeat) { el.textContent = myName || 'আপনি'; return; }
    const c = handCounts[seat];
    el.textContent = (c !== undefined ? bnNum(c) : '০') + ' টি কার্ড';
  });
}

function renderDealerBadge() {
  SEATS.forEach(seat => {
    const chip = document.getElementById('dealer-chip-' + seat);
    if (chip) chip.classList.toggle('is-hidden', seat !== dealerSeat);
  });
}

function showBidBadge(seat, amount) {
  const badge = document.getElementById('bid-bubble-' + seat);
  if (badge) { badge.textContent = 'ডাক ' + bnNum(amount); badge.classList.remove('is-hidden'); }
}
function clearBidBadges() {
  SEATS.forEach(seat => { const b = document.getElementById('bid-bubble-' + seat); if (b) b.classList.add('is-hidden'); });
}

function highlightTurnSeat(seat) {
  SEATS.forEach(s => {
    const marker = document.getElementById('seat-marker-' + s);
    if (marker) marker.classList.toggle('seat-marker--turn', !!seat && s === seat);
  });
}

function renderBiddingUI() {
  const panel = document.getElementById('bidding-panel');
  clearBidBadges();
  if (!bidding) { panel.classList.add('is-hidden'); return; }

  if (bidding.biddingClosed) {
    panel.classList.add('is-hidden');
    document.getElementById('turn-indicator').textContent = bidding.finalWinner
      ? `ডাক বিজয়ী: ${seatLabel(bidding.finalWinner)} (${bnNum(bidding.finalBid)})` : 'পালা: —';
    if (bidding.finalWinner) showBidBadge(bidding.finalWinner, bidding.finalBid);
    return;
  }

  panel.classList.remove('is-hidden');
  document.getElementById('bidding-round-label').textContent = 'রাউন্ড ' + bnNum(bidding.round) + ' ডাক';
  document.getElementById('bidding-current-text').textContent = bidding.locked
    ? `সর্বোচ্চ ডাক: ${bnNum(bidding.currentBid)} (${seatLabel(bidding.defenderSeat)})` : 'ডাক শুরু হয়নি';
  document.getElementById('turn-indicator').textContent = 'পালা: ' + seatLabel(bidding.turnSeat);
  if (bidding.locked) showBidBadge(bidding.defenderSeat, bidding.currentBid);

  const myTurn = mySeat === bidding.turnSeat;
  const actionsEl = document.getElementById('bidding-actions');
  const waitEl = document.getElementById('bidding-wait-note');

  if (myTurn) {
    actionsEl.classList.remove('is-hidden'); waitEl.classList.add('is-hidden');
    const isDefTurn = mySeat === bidding.defenderSeat;
    const nextVal = bidding.locked ? Math.min(bidding.currentBid + 1, 28) : 16;
    document.getElementById('btn-bid-value').textContent = bnNum(nextVal);
    document.getElementById('btn-achi').classList.toggle('is-hidden', !(isDefTurn && bidding.locked));
    const isDealerSeat = roles && mySeat === roles.dealer;
    document.getElementById('btn-pass').classList.toggle('is-hidden', isDealerSeat && !isDefTurn);
    const canBid = !bidding.locked || bidding.currentBid < 28;
    document.getElementById('btn-bid').classList.toggle('is-hidden', !canBid);
  } else {
    actionsEl.classList.add('is-hidden'); waitEl.classList.remove('is-hidden');
    waitEl.textContent = seatLabel(bidding.turnSeat) + '-এর পালা...';
  }
}

function renderTrumpUI() {
  const chip = document.getElementById('trump-chip');
  const center = document.getElementById('table-center-trump');
  if (!trump) { chip.textContent = 'তুরুপ: --'; center.textContent = '?'; return; }
  const showSuit = trump.revealed || mySeat === (roomMeta && roomMeta.bidWinnerSeat);
  if (showSuit) {
    chip.textContent = 'তুরুপ: ' + SUIT_SYMBOL[trump.suit];
    center.textContent = trump.revealed ? SUIT_SYMBOL[trump.suit] : '?';
  } else {
    chip.textContent = 'তুরুপ: গোপন';
    center.textContent = '?';
  }
}

function renderTrick() {
  SEATS.forEach(seat => {
    const slot = document.getElementById('trick-slot-' + seat);
    if (!slot) return;
    slot.innerHTML = '';
    const card = trick && trick.cardsPlayed ? trick.cardsPlayed[seat] : null;
    if (card) {
      const div = document.createElement('div');
      div.className = 'played-card';
      div.innerHTML = `<span>${card.rank}</span><span class="${SUIT_CLASS[card.suit]}">${SUIT_SYMBOL[card.suit]}</span>`;
      slot.appendChild(div);
    }
  });
}

function isCardPlayable(card) {
  if (!roomMeta || roomMeta.status !== 'PLAYING') return false;
  if (mySeat !== currentTurnSeat) return false;
  if (card.locked && !(trump && trump.revealed)) return false;
  if (!trick) return true;
  const leadSuit = trick.leadSuit;
  if (!leadSuit) return true;
  const hasLead = (myHand || []).some(c => c.suit === leadSuit);
  if (trick.trumpForcedSeat === mySeat) {
    const hasTrump = (myHand || []).some(c => c.suit === trump.suit);
    if (hasTrump) return card.suit === trump.suit;
    return true;
  }
  if (hasLead) return card.suit === leadSuit;
  return true;
}

function renderMyHand() {
  const dock = document.getElementById('hand-dock');
  dock.innerHTML = '';
  (myHand || []).forEach(card => {
    const playable = isCardPlayable(card);
    const div = document.createElement('div');
    div.className = 'hand-card' + (playable ? ' is-playable' : '') +
      ((!playable && roomMeta && roomMeta.status === 'PLAYING' && mySeat === currentTurnSeat) ? ' is-disabled' : '');
    div.innerHTML = `<span class="hand-card-rank">${card.rank}</span><span class="hand-card-suit ${SUIT_CLASS[card.suit]}">${SUIT_SYMBOL[card.suit]}</span>`;
    if (playable) div.addEventListener('click', () => submitAction('PLAY_CARD', { suit: card.suit, rank: card.rank }));
    dock.appendChild(div);
  });
}

function playerNeedsTrumpChoiceLocal() {
  if (!trick || !trick.leadSuit || !trump || trump.revealed || !myHand) return false;
  return !myHand.some(c => c.suit === trick.leadSuit);
}
function playerCanDeclarePairLocal() {
  if (!trump || !trump.revealed || pairDeclared || !myHand) return false;
  const hasK = myHand.some(c => c.suit === trump.suit && c.rank === 'K');
  const hasQ = myHand.some(c => c.suit === trump.suit && c.rank === 'Q');
  if (!hasK || !hasQ) return false;
  const teamSeats = SEATS.filter(s => partnerships[s] === partnerships[mySeat]);
  return teamSeats.some(s => (tricksWon[s] || 0) > 0);
}

function renderPlayActionsBar() {
  const bar = document.getElementById('play-actions');
  const trumpBtn = document.getElementById('btn-trump-reveal');
  const noTrumpBtn = document.getElementById('btn-no-trump');
  const pairBtn = document.getElementById('btn-declare-pair');

  const myTurn = mySeat === currentTurnSeat;
  const needsTrumpChoice = myTurn && playerNeedsTrumpChoiceLocal();
  const canPair = playerCanDeclarePairLocal();

  trumpBtn.classList.toggle('is-hidden', !needsTrumpChoice);
  noTrumpBtn.classList.toggle('is-hidden', !needsTrumpChoice);
  pairBtn.classList.toggle('is-hidden', !canPair);
  bar.classList.toggle('is-hidden', !(needsTrumpChoice || canPair));
}

function renderTeamScoresLive() {
  [1, 2].forEach(team => {
    const seats = SEATS.filter(s => partnerships[s] === team);
    const names = seats.map(s => (players[s] && players[s].name) || seatLabel(s)).join(' ও ');
    const t = teamScores[team] || { points: 0, sets: 0 };
    document.getElementById('scoreboard-names-' + team).textContent = names || ('দল ' + bnNum(team));
    document.getElementById('scoreboard-score-' + team).textContent = `${bnNum(t.sets)} সেট ♥️${bnNum(t.points)}`;
  });
}

function renderScoreHistory(data) {
  const tbody = document.getElementById('score-tbody');
  if (!data) { tbody.innerHTML = '<tr><td colspan="5" class="score-empty-row">কোনো রাউন্ড এখনো শেষ হয়নি।</td></tr>'; return; }
  const rows = Object.values(data).sort((a, b) => a.round - b.round).map(r => `
    <tr>
      <td>${bnNum(r.round)}</td>
      <td>${r.trump || '--'}</td>
      <td>${r.team1Label || 'দল ১'} ♥️${bnNum(r.team1)}${r.team1Sets ? (' (' + bnNum(r.team1Sets) + ' সেট)') : ''}</td>
      <td>${r.team2Label || 'দল ২'} ♥️${bnNum(r.team2)}${r.team2Sets ? (' (' + bnNum(r.team2Sets) + ' সেট)') : ''}</td>
      <td class="score-winner">${r.winnerLabel || ''}</td>
    </tr>`).join('');
  tbody.innerHTML = rows || '<tr><td colspan="5" class="score-empty-row">কোনো রাউন্ড এখনো শেষ হয়নি।</td></tr>';
}

function appendLogEntry(entry) {
  if (!entry) return;
  const list = document.getElementById('log-list');
  const li = document.createElement('li');
  li.className = 'log-entry';
  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = formatBnTime(entry.ts);
  li.appendChild(time);
  li.appendChild(document.createTextNode(' ' + entry.text));
  list.appendChild(li);
  const body = document.getElementById('panel-log');
  body.scrollTop = body.scrollHeight;
}

function showBanner(message, duration) {
  const el = document.getElementById('game-banner');
  el.textContent = message;
  el.classList.remove('is-hidden');
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.add('is-hidden'), duration || 3200);
}

/* ---- Popup modal (Trump choice / Double / Redouble / Single Play) ---- */

function showModal(title, sub, buttons) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-sub').textContent = sub || '';
  const actions = document.getElementById('modal-actions');
  actions.innerHTML = '';
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ' + (b.className || 'btn--outline') + (b.wide ? ' btn--wide' : '');
    btn.textContent = b.label;
    btn.addEventListener('click', b.onClick);
    actions.appendChild(btn);
  });
  document.getElementById('action-modal').classList.remove('is-hidden');
}
function hideModal() { document.getElementById('action-modal').classList.add('is-hidden'); }

// Wraps a modal button so clicking it immediately suppresses the modal
// from re-appearing on the next render while we wait for Firebase to
// round-trip the status change (prevents a "Skip" flicker back open).
function modalButton(label, className, onSelect) {
  return {
    label, className,
    onClick: () => {
      modalSkippedForStatus = roomMeta && roomMeta.status;
      hideModal();
      if (onSelect) onSelect();
    }
  };
}

function renderPhaseUI() {
  const status = roomMeta && roomMeta.status;
  if (status !== lastRenderedStatus) { lastRenderedStatus = status; modalSkippedForStatus = null; }

  if (!status || status === modalSkippedForStatus) {
    hideModal();
    if (status === 'PLAYING') renderPlayActionsBar();
    else document.getElementById('play-actions').classList.add('is-hidden');
    return;
  }

  if (status === 'TRUMP_SELECT') {
    if (mySeat === roomMeta.bidWinnerSeat) {
      showModal('তুরুপ নির্বাচন করুন', 'আপনি ডাক জিতেছেন! তুরুপ বেছে নিন।', [
        modalButton('♠ স্পেড', 'btn--brass', () => submitAction('TRUMP_CHOICE', { suit: 'S' })),
        modalButton('♥ হার্ট', 'btn--brass', () => submitAction('TRUMP_CHOICE', { suit: 'H' })),
        modalButton('♦ ডায়মন্ড', 'btn--brass', () => submitAction('TRUMP_CHOICE', { suit: 'D' })),
        modalButton('♣ ক্লাব', 'btn--brass', () => submitAction('TRUMP_CHOICE', { suit: 'C' })),
        Object.assign(modalButton('সেকেন্ড', 'btn--outline', () => submitAction('TRUMP_CHOICE', { suit: 'SECOND' })), { wide: true })
      ]);
    } else hideModal();
    document.getElementById('play-actions').classList.add('is-hidden');
    return;
  }

  if (status === 'DOUBLE_WINDOW') {
    if (roomMeta.bidWinnerSeat && partnerships[mySeat] !== partnerships[roomMeta.bidWinnerSeat]) {
      showModal('ডবল খেলবেন?', 'প্রতিপক্ষ দল হিসেবে আপনি চাইলে খেলা ডবল করতে পারেন।', [
        modalButton('ডবল', 'btn--brass', () => submitAction('DOUBLE_CHOICE', { choice: 'DOUBLE' })),
        modalButton('স্কিপ', 'btn--outline', () => submitAction('DOUBLE_CHOICE', { choice: 'SKIP' }))
      ]);
    } else hideModal();
    document.getElementById('play-actions').classList.add('is-hidden');
    return;
  }

  if (status === 'REDOUBLE_WINDOW') {
    if (roomMeta.bidWinnerSeat && partnerships[mySeat] === partnerships[roomMeta.bidWinnerSeat]) {
      showModal('রি-ডাবল খেলবেন?', 'প্রতিপক্ষ ডবল করেছে। চাইলে রি-ডাবল করুন।', [
        modalButton('রি-ডাবল', 'btn--brass', () => submitAction('REDOUBLE_CHOICE', { choice: 'REDOUBLE' })),
        modalButton('স্কিপ', 'btn--outline', () => submitAction('REDOUBLE_CHOICE', { choice: 'SKIP' }))
      ]);
    } else hideModal();
    document.getElementById('play-actions').classList.add('is-hidden');
    return;
  }

  if (status === 'SINGLE_PLAY_WINDOW') {
    const already = singlePlayQueueLocal && singlePlayQueueLocal.includes(mySeat);
    const isBotSeat = players[mySeat] && players[mySeat].isBot;
    if (!already && !isBotSeat) {
      showModal('সিঙ্গেল খেলবেন?', 'একাই পুরো রাউন্ড খেলতে চান?', [
        modalButton('সিঙ্গেল খেলুন', 'btn--brass', () => submitAction('SINGLE_REQUEST')),
        modalButton('স্কিপ', 'btn--outline', null)
      ]);
    } else hideModal();
    document.getElementById('play-actions').classList.add('is-hidden');
    return;
  }

  if (status === 'SINGLE_PLAY_DOUBLE_WINDOW') {
    if (singlePlay && partnerships[mySeat] !== partnerships[singlePlay.seat]) {
      showModal('সিঙ্গেল ডবল করবেন?', `${seatLabel(singlePlay.seat)} সিঙ্গেল খেলছেন।`, [
        modalButton('ডবল (৬ পয়েন্ট)', 'btn--brass', () => submitAction('SINGLE_DOUBLE_CHOICE', { choice: 'DOUBLE' })),
        modalButton('স্কিপ (৩ পয়েন্ট)', 'btn--outline', () => submitAction('SINGLE_DOUBLE_CHOICE', { choice: 'SKIP' }))
      ]);
    } else hideModal();
    document.getElementById('play-actions').classList.add('is-hidden');
    return;
  }

  hideModal();
  if (status === 'PLAYING') renderPlayActionsBar();
  else document.getElementById('play-actions').classList.add('is-hidden');
}

// Single entry point called by every Firebase listener — repaints
// everything from the current in-memory state. Simple and reliable,
// at a small (irrelevant-at-this-scale) performance cost.
function renderEverything() {
  renderRoomCodeDisplay();
  renderLobbySeats();
  renderPartnershipPanel();
  renderMetaUI();
  renderGameSeatMarkers();
  renderDealerBadge();
  renderBiddingUI();
  renderTrumpUI();
  renderTrick();
  renderMyHand();
  renderTeamScoresLive();
  renderPhaseUI();
  highlightTurnSeat(bidding && !bidding.biddingClosed ? bidding.turnSeat : (roomMeta && roomMeta.status === 'PLAYING' ? currentTurnSeat : null));
}
