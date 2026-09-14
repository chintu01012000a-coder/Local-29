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
  apiKey: "AIzaSyDKgkuUHrkBYz7Ze47q35kemuZBupcVB_M",
  authDomain: "callbreak-local.firebaseapp.com",
  projectId: "callbreak-local",
  storageBucket: "callbreak-local.firebasestorage.app",
  messagingSenderId: "697439144169",
  appId: "1:697439144169:web:c7176361df380a07788878"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize the Firebase app once, using the v8 "compat" namespaced API.
firebase.initializeApp(firebaseConfig);

// Shared handles used throughout app.js
const db = firebase.database();
const auth = firebase.auth();
