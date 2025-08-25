// src/config/firebase-init.js
const admin = require('firebase-admin');

try {
    if (process.env.GOOGLE_CREDENTIALS_JSON) {
        // Mode deployment (Railway)
        const serviceAccount = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } else {
        // Mode lokal (membaca dari file)
        admin.initializeApp();
    }
    console.log('Koneksi Firebase berhasil diinisialisasi.');
} catch (error) {
    console.error('ERROR: Gagal inisialisasi Firebase.', error);
    process.exit(1);
}
module.exports = admin;