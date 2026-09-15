/* =====================================================================
   FIREBASE CONFIG
   -----------------------------------------------------------------------
   This file must be loaded BEFORE app.js (see index.html). It connects
   this web app to your Firebase project and creates two objects that
   app.js uses everywhere:

     db   -> a reference to your Realtime Database (firebase.database())
     auth -> the Firebase Authentication service (firebase.auth())

   If you ever create a new Firebase project, just replace the values
   inside firebaseConfig below with the new project's values (Firebase
   Console -> Project settings -> General -> Your apps -> SDK setup).
   ===================================================================== */

const firebaseConfig = {
  apiKey: "AIzaSyD80SHFncZzbNOHmUPgE_3wyW4f8uUtymY",
  authDomain: "twentynine-game-5b68d.firebaseapp.com",
  databaseURL: "https://twentynine-game-5b68d-default-rtdb.firebaseio.com",
  projectId: "twentynine-game-5b68d",
  storageBucket: "twentynine-game-5b68d.firebasestorage.app",
  messagingSenderId: "143674788167",
  appId: "1:143674788167:web:277c10f5dbac11e9f16462"
};

// Initialize the Firebase app once, using the v8 "compat" namespaced API.
firebase.initializeApp(firebaseConfig);

// Shared handles used throughout app.js
const db = firebase.database();
const auth = firebase.auth();
