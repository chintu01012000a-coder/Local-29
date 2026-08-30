// ==========================================
// ১. ফায়ারবেস নতুন কনফিগারেশন ইন্টিগ্রেশন
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyDVbCa4CzJV-O7gJHBkf_DPifUsQJWcHpc",
  authDomain: "local-cc0b6.firebaseapp.com",
  databaseURL: "https://local-cc0b6-default-rtdb.firebaseio.com",
  projectId: "local-cc0b6",
  storageBucket: "local-cc0b6.firebasestorage.app",
  messagingSenderId: "391143435553",
  appId: "1:391143435553:web:fbd91cef38d1ee5581a260",
  measurementId: "G-LY2YHJFV0P"
};

// ফায়ারবেস স্টার্ট
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// গ্লোবাল গেম স্টেট ট্র্যাকার
let currentRoomCode = null;
let myPlayerId = null;
let myName = "";
let myRole = ""; 
let myPosition = ""; 
let gameModeSelected = "1H3B"; 

// DOM অবজেক্টস
const lobbyScreen = document.getElementById('lobby-screen');
const waitingScreen = document.getElementById('waiting-screen');
const gameScreen = document.getElementById('game-screen');
const playerNameInput = document.getElementById('player-name');
const roomCodeInput = document.getElementById('room-code-input');
const displayRoomCode = document.getElementById('display-room-code');
const waitingPlayersList = document.getElementById('waiting-players-list');
const connectedCount = document.getElementById('connected-count');
const partnershipPanel = document.getElementById('partnership-panel');

// ==========================================
// ২. হোস্ট এবং জয়েন করার কানেকশন লজিক
// ==========================================

document.getElementById('btn-host').addEventListener('click', () => {
    myName = playerNameInput.value.trim();
    if (!myName) {
        alert("দয়া করে হোস্ট করার আগে আপনার নাম লিখুন!");
        return;
    }
    
    // রেডিও বাটন থেকে মোড রিড করা
    const checkedMode = document.querySelector('input[name="game-mode"]:checked');
    gameModeSelected = checkedMode ? checkedMode.value : "1H3B";

    currentRoomCode = Math.floor(100000 + Math.random() * 900000).toString();
    myPlayerId = "player_0"; 
    myPosition = "South";
    myRole = "Dealer";

    const roomRef = database.ref('rooms/' + currentRoomCode);
    
    let initialPlayers = {
        "player_0": { name: myName, position: "South", role: "Dealer", isBot: false }
    };

    // যদি বটের মোড সিলেক্ট করা থাকে, লবিতেই অটো-ফিল করা
    if (gameModeSelected === "1H3B") {
        initialPlayers["player_1"] = { name: "Bot 1 (AI)", position: "East", role: "Player 1", isBot: true };
        initialPlayers["player_2"] = { name: "Bot 2 (AI)", position: "North", role: "Player 2", isBot: true };
        initialPlayers["player_3"] = { name: "Bot 3 (AI)", position: "West", role: "Player 3", isBot: true };
    } else if (gameModeSelected === "2H2B") {
        initialPlayers["player_2"] = { name: "Bot 1 (AI)", position: "North", role: "Player 2", isBot: true };
        initialPlayers["player_3"] = { name: "Bot 2 (AI)", position: "West", role: "Player 3", isBot: true };
    } else if (gameModeSelected === "3H1B") {
        initialPlayers["player_3"] = { name: "Bot 1 (AI)", position: "West", role: "Player 3", isBot: true };
    }

    roomRef.set({
        room_id: currentRoomCode,
        game_status: "LOBBY",
        game_mode_type: gameModeSelected,
        dealer_id: "player_0",
        current_bid: 0,
        game_multiplier: "NORMAL", // NORMAL, DOUBLE, REDOUBLE
        live_scores: { team_1_score: 0, team_1_sets: 0, team_2_score: 0, team_2_sets: 0 },
        players: initialPlayers,
        log_history: { "init": myName + " গেম হোস্ট করেছেন। রুম কোড: " + currentRoomCode },
        score_history: { "init": "স্কোরবোর্ড শুরু হওয়ার অপেক্ষায়..." }
    }).then(() => {
        setupRoomListener(currentRoomCode);
        switchToScreen('waiting-screen');
    });
});

document.getElementById('btn-join').addEventListener('click', () => {
    myName = playerNameInput.value.trim();
    const enteredCode = roomCodeInput.value.trim();

    if (!myName || !enteredCode) {
        alert("নাম এবং রুম কোড দুটোই দেওয়া বাধ্যতামূলক!");
        return;
    }

    const roomRef = database.ref('rooms/' + enteredCode);
    roomRef.once('value', (snapshot) => {
        if (!snapshot.exists()) {
            alert("ভুল কোড! কোনো রুম পাওয়া যায়নি।");
            return;
        }

        const roomData = snapshot.val();
        const playersList = roomData.players || {};
        
        // রিয়েল (হিউম্যান) প্লেয়ার স্লট চেক করা
        let humanCount = 0;
        for (let p in playersList) {
            if (!playersList[p].isBot) humanCount++;
        }

        let maxHumansAllowed = 4;
        if (roomData.game_mode_type === "1H3B") maxHumansAllowed = 1;
        if (roomData.game_mode_type === "2H2B") maxHumansAllowed = 2;
        if (roomData.game_mode_type === "3H1B") maxHumansAllowed = 3;

        if (humanCount >= maxHumansAllowed) {
            alert("দুঃখিত, এই মোডের জন্য সব রিয়েল প্লেয়ার স্লট ফুল!");
            return;
        }

        // খালি স্লট খুঁজে বসা
        let targetSlot = null;
        const slotsOrder = ["player_0", "player_1", "player_2", "player_3"];
        const positions = ["South", "East", "North", "West"];
        const roles = ["Dealer", "Player 1", "Player 2", "Player 3"];

        for (let i = 0; i < 4; i++) {
            if (!playersList[slotsOrder[i]] || playersList[slotsOrder[i]].isBot) {
                targetSlot = i;
                break;
            }
        }

        myPlayerId = slotsOrder[targetSlot];
        myPosition = positions[targetSlot];
        myRole = roles[targetSlot];
        currentRoomCode = enteredCode;

        roomRef.child('players/' + myPlayerId).set({
            name: myName,
            position: myPosition,
            role: myRole,
            isBot: false
        }).then(() => {
            roomRef.child('log_history').push(myName + " লবি রুমে জয়েন করেছেন।");
            setupRoomListener(currentRoomCode);
            switchToScreen('waiting-screen');
        });
    });
});

document.getElementById('btn-copy').addEventListener('click', () => {
    if (currentRoomCode) {
        navigator.clipboard.writeText(currentRoomCode);
        alert("কোড কপি হয়েছে: " + currentRoomCode);
    }
});

// ==========================================
// ৩. লিসেনার ও পার্টনারশিপ গেম স্টার্ট
// ==========================================
function setupRoomListener(roomCode) {
    const roomRef = database.ref('rooms/' + roomCode);
    
    roomRef.on('value', (snapshot) => {
        if (!snapshot.exists()) return;
        const roomData = snapshot.val();
        
        updateWaitingLobby(roomData);
        
        // যদি ৪ জন স্লট ফুল হয়, হোস্টের স্ক্রিনে পার্টনারশিপ বাটন শো করা
        if (roomData.game_status === "LOBBY" && Object.keys(roomData.players).length === 4) {
            if (myPlayerId === "player_0") {
                partnershipPanel.classList.remove('hidden');
                document.getElementById('client-wait-text').classList.add('hidden');
            }
        }
        
        if (roomData.game_status !== "LOBBY") {
            switchToScreen('game-screen');
            renderGameTable(roomData);
            renderLogAndHistory(roomData);
        }
    });
}

document.getElementById('btn-lock-partnership').addEventListener('click', () => {
    if (myPlayerId === "player_0" && currentRoomCode) {
        const roomRef = database.ref('rooms/' + currentRoomCode);
        roomRef.child('game_status').set("BIDDING_ROUND_1");
        roomRef.child('log_history').push("হোস্ট পার্টনারশিপ লক করেছেন। রাউন্ড ১ বিডিং শুরু!");
    }
});

function switchToScreen(screenId) {
    [lobbyScreen, waitingScreen, gameScreen].forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

function updateWaitingLobby(roomData) {
    displayRoomCode.innerText = roomData.room_id;
    waitingPlayersList.innerHTML = "";
    
    const players = roomData.players || {};
    const count = Object.keys(players).length;
    connectedCount.innerText = count;

    for (let pId in players) {
        const li = document.createElement('li');
        li.innerText = `🔹 ${players[pId].name} (${players[pId].role} - ${players[pId].position})`;
        if (pId === myPlayerId) li.style.color = "#ffcc00"; 
        waitingPlayersList.appendChild(li);
    }
}

function renderGameTable(roomData) {
    document.getElementById('current-room-text').innerText = "#" + roomData.room_id;
    const players = roomData.players;
    
    for (let pId in players) {
        const p = players[pId];
        if (p.position === "South") document.getElementById('name-south').innerText = pId === myPlayerId ? "আপনি (South)" : p.name;
        if (p.position === "North") document.getElementById('name-north').innerText = p.name + " (Partner)";
        if (p.position === "East") document.getElementById('name-east').innerText = p.name;
        if (p.position === "West") document.getElementById('name-west').innerText = p.name;
    }

    const score = roomData.live_scores;
    const team1Text = `Player 1 & 3 ${score.team_1_sets > 0 ? score.team_1_sets + ' সেট ' : ''}♥️${score.team_1_score}`;
    const team2Text = `Dealer & Player 2 ${score.team_2_sets > 0 ? score.team_2_sets + ' সেট ' : ''}♥️${score.team_2_score}`;
    document.getElementById('scoreboard-display').innerText = `${team1Text} | ${team2Text}`;
    
    // বিডিং ও ট্রাম্প স্ট্যাটাস এরিয়া আপডেট
    if(roomData.game_status.includes("BIDDING")) {
        document.getElementById('bid-text').innerText = `বিডিং চলছে... বর্তমান সর্বোচ্চ বিড: ${roomData.current_bid || 0}`;
    } else {
        document.getElementById('bid-text').innerText = `খেলা চলছে | বিড টার্গেট: ${roomData.current_bid}`;
    }
}

function renderLogAndHistory(roomData) {
    const logBox = document.getElementById('log-history-list');
    const scoreBox = document.getElementById('score-history-list');
    
    logBox.innerHTML = "";
    scoreBox.innerHTML = "";

