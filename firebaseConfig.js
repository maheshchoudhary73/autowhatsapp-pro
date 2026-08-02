// AutoWhatsApp Pro - Firebase Auth Client Config
const firebaseConfig = {
  apiKey: "AIzaSyA2DxSkMXs4XURIXsQ0l6-3QHZ2AwV3JK4",
  authDomain: "autowhatsapppro.firebaseapp.com",
  projectId: "autowhatsapppro",
  storageBucket: "autowhatsapppro.firebasestorage.app",
  messagingSenderId: "43931998531",
  appId: "1:43931998531:web:13f2908e2a5e01f293b7f6"
};

// Initialize Firebase
if (typeof firebase !== 'undefined') {
  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const googleProvider = new firebase.auth.GoogleAuthProvider();
}
