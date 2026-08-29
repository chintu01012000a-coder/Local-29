// ==========================================
// ১. ফায়ারবেস কনফিগারেশন এবং ইনিশিয়ালাইজেশন
// ==========================================
const firebaseConfig = {
  apiKey: "AIzaSyDVbCa4CzJV-O7gJHBkf_DPifUsQJWcHpc",
  authDomain: "://firebaseapp.com",
  databaseURL: "https://firebaseio.com",
  projectId: "local-cc0b6",
  storageBucket: "local-cc0b6.firebasestorage.app",
  messagingSenderId: "391143435553",
  appId: "1:391143435553:web:fbd91cef38d1ee5581a260",
  measurementId: "G-LY2YHJFV0P"
};

// ফায়ারবেস শুরু করা
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// গেমের গ্লোবাল ভ্যারিয়েবলসমূহ
let currentRoomCode = null;
let myPlayerId = null;
let myName = "";
let myRole = ""; 
let myPosition = ""; 

// DOM এলিমেন্টস
const lobbyScreen = document.getElementById('lobby-screen');
const waitingScreen = document.getElementById('waiting-screen');
const gameScreen = document.getElementById('game-screen');
const playerNameInput = document.getElementById('player-name');
const roomCodeInput = document.getElementById('room-code-input');
const displayRoomCode = document.getElementById('display-room-code');
const waitingPlayersList = document.getElementById('waiting-players-list');
const connectedCount = document.getElementById('connected-count');

// ==========================================
// ২. হোস্ট এবং জয়েন করার রিয়েল-টাইম লজিক
// ==========================================

document.getElementById('btn-host').addEventListener('click', () => {
    myName = playerNameInput.value.trim();
    if (!myName) {
        alert("দয়া করে হোস্ট করার আগে আপনার নাম লিখুন (বাধ্যতামূলক)!");
        return;
    }
    
    currentRoomCode = Math.floor(100000 + Math.random() * 900000).toString();
    myPlayerId = "player_0"; 
    myPosition = "South";
    myRole = "Dealer";

    const roomRef = database.ref('rooms/' + currentRoomCode);
    
    roomRef.set({
        room_id: currentRoomCode,
        game_status: "LOBBY",
        dealer_id: "player_0",
        current_bid: 0,
        game_mode: "NORMAL",
        live_scores: {
            team_1_score: 0, team_1_sets: 0,
            team_2_score: 0, team_2_sets: 0 
        },
        players: {
            "player_0": { name: myName, position: "South", role: "Dealer" }
        },
        log_history: {
            "init": myName + " গেম হোস্ট করেছেন। রুম কোড: " + currentRoomCode
        },
        score_history: {
            "init": "গেম শুরু হওয়ার অপেক্ষায়..."
        }
    }).then(() => {
        setupRoomListener(currentRoomCode);
        switchToScreen('waiting-screen');
    }).catch((error) => {
        console.error("Firebase Host Error:", error);
    });
});

document.getElementById('btn-join').addEventListener('click', () => {
    myName = playerNameInput.value.trim();
    const enteredCode = roomCodeInput.value.trim();

    if (!myName || !enteredCode) {
        alert("নাম এবং ৬ ডিজিটের রুম কোড দুটোই দেওয়া বাধ্যতামূলক!");
        return;
    }

    const roomRef = database.ref('rooms/' + enteredCode);
    roomRef.once('value', (snapshot) => {
        if (!snapshot.exists()) {
            alert("ভুল কোড! এই আইডি দিয়ে কোনো গেম রুম পাওয়া যায়নি।");
            return;
        }

        const roomData = snapshot.val();
        const playersList = roomData.players || {};
        const currentPlayersCount = Object.keys(playersList).length;

        if (currentPlayersCount >= 4) {
            alert("দুঃখিত! এই রুমটিতে অলরেডি ৪ জন প্লেয়ার ফুল হয়ে গেছে।");
            return;
        }

        myPlayerId = "player_" + currentPlayersCount;
        const positions = ["South", "East", "North", "West"];
        const roles = ["Dealer", "Player 1", "Player 2", "Player 3"];
        
        myPosition = positions[currentPlayersCount];
        myRole = roles[currentPlayersCount];
        currentRoomCode = enteredCode;

        roomRef.child('players/' + myPlayerId).set({
            name: myName,
            position: myPosition,
            role: myRole
        }).then(() => {
            roomRef.child('log_history').push(myName + " গেমে জয়েন করেছেন।");
            setupRoomListener(currentRoomCode);
            switchToScreen('waiting-screen');
        });
    });
});

document.getElementById('btn-copy').addEventListener('click', () => {
    if (currentRoomCode) {
        navigator.clipboard.writeText(currentRoomCode);
        alert("রুম কোড কপি হয়েছে: " + currentRoomCode);
    }
});

// ==========================================
// ৩. রিয়েল-টাইম ডাটাবেজ লিসেনার
// ==========================================
function setupRoomListener(roomCode) {
    const roomRef = database.ref('rooms/' + roomCode);
    
    roomRef.on('value', (snapshot) => {
        if (!snapshot.exists()) return;
        const roomData = snapshot.val();
        
        updateWaitingLobby(roomData);
        
        if (roomData.game_status === "LOBBY" && Object.keys(roomData.players).length === 4) {
            if (myPlayerId === "player_0") {
                roomRef.child('game_status').set("BIDDING_ROUND_1");
                roomRef.child('log_history').push("৪ জন প্লেয়ার পূর্ণ হয়েছে। খেলা শুরু হচ্ছে!");
            }
        }
        
        if (roomData.game_status !== "LOBBY") {
            switchToScreen('game-screen');
            renderGameTable(roomData);
            renderLogAndHistory(roomData);
        }
    });
}

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

// ==========================================
// ৪. টেবিল ডিজাইন ও হিস্টোরি রেন্ডারিং
// ==========================================
function renderGameTable(roomData) {
    document.getElementById('current-room-text').innerText = "#" + roomData.room_id;
    
    const players = roomData.players;
    
    for (let pId in players) {
        const p = players[pId];
        if (p.position === "South") document.getElementById('name-south').innerText = pId === myPlayerId ? "আপনি (ডিলার)" : p.name;
        if (p.position === "North") document.getElementById('name-north').innerText = p.name + " (পার্টনার)";
        if (p.position === "East") document.getElementById('name-east').innerText = p.name;
        if (p.position === "West") document.getElementById('name-west').innerText = p.name;
    }

    const score = roomData.live_scores;
    const team1Text = `Player 1 & 3 ${score.team_1_sets > 0 ? score.team_1_sets + ' সেট ' : ''}♥️${score.team_1_score}`;
    const team2Text = `Dealer & Player 2 ${score.team_2_sets > 0 ? score.team_2_sets + ' সেট ' : ''}♥️${score.team_2_score}`;
    document.getElementById('scoreboard-display').innerText = `${team1Text} | ${team2Text}`;
}

function renderLogAndHistory(roomData) {
    const logBox = document.getElementById('log-history-list');
    const scoreBox = document.getElementById('score-history-list');
    
    logBox.innerHTML = "";
    scoreBox.innerHTML = "";

    if (roomData.log_history) {
        Object.values(roomData.log_history).forEach(logText => {
            const div = document.createElement('div');
            div.innerText = logText;
            logBox.appendChild(div);
        });
        logBox.scrollTop = logBox.scrollHeight; 
    }

    if (roomData.score_history) {
        Object.values(roomData.score_history).forEach(historyText => {
            const div = document.createElement('div');
            div.innerText = historyText;
            scoreBox.appendChild(div);
        });
    }
}
