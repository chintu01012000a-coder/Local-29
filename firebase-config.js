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
  apiKey: "AIzaSyDVbCa4CzJV-O7gJHBkf_DPifUsQJWcHpc",
  authDomain: "local-cc0b6.firebaseapp.com",
  databaseURL: "https://local-cc0b6-default-rtdb.firebaseio.com",
  projectId: "local-cc0b6",
  storageBucket: "local-cc0b6.firebasestorage.app",
  messagingSenderId: "391143435553",
  appId: "1:391143435553:web:fbd91cef38d1ee5581a260",
  measurementId: "G-LY2YHJFV0P"
};

// Initialize the Firebase app once, using the v8 "compat" namespaced API.
firebase.initializeApp(firebaseConfig);

// Shared handles used throughout app.js
const db = firebase.database();
const auth = firebase.auth();
