// src/modules/ai.js
const { GoogleGenerativeAI } = require('@google/generative-ai');
if (!process.env.GEMINI_API_KEY) { throw new Error('GEMINI_API_KEY tidak ditemukan di .env'); }
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const aiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function analyzeText(text, senderUsername) {
    const prompt = 'Anda adalah AI akuntan super canggih. Tugas Anda adalah memecah pesan user menjadi data JSON transaksi individual.' +
        ' 1. Identifikasi setiap orang yang disebutkan dan apa yang mereka KONSUMSI.' +
        ' 2. Jika seseorang membayar untuk item yang dikonsumsi orang lain, catat itu.' +
        ' 3. Jika tidak ada nama pembayar, asumsikan pengirim (' + senderUsername + ') yang membayar.' +
        ' 4. Set "is_transaction" ke true jika ada aktivitas finansial.' +
        ' Format JSON WAJIB: {"is_transaction": boolean, "transactions": [{"payer": string, "consumer": string, "amount": number, "description": string}]}' +
        ' Contoh:' +
        ' Pesan: "rio makan nasi goreng 20000, gua makan mie ayam baso 24k, minumnya es jeruk 2, 24k"' +
        ' JSON: {"is_transaction": true, "transactions": [{"payer": "rio", "consumer": "rio", "amount": 20000, "description": "nasi goreng"}, {"payer": "' + senderUsername + '", "consumer": "' + senderUsername + '", "amount": 48000, "description": "mie ayam baso dan es jeruk"}]}' +
        ' Pesan: "gua bayarin sate 150rb buat Budi dan Cindy"' +
        ' JSON: {"is_transaction": true, "transactions": [{"payer": "' + senderUsername + '", "consumer": "Budi", "amount": 75000, "description": "sate"}, {"payer": "' + senderUsername + '", "consumer": "Cindy", "amount": 75000, "description": "sate"}]}' +
        ' Pesan: "titip beli rokok buat @PakRT 30rb"' +
        ' JSON: {"is_transaction": true, "transactions": [{"payer": "' + senderUsername + '", "consumer": "PakRT", "amount": 30000, "description": "rokok"}]}' +
        ' Pesan: "thanks ya semua"' +
        ' JSON: {"is_transaction": false, "transactions": []}' +
        ' Pesan: "' + text + '"' +
        ' JSON:';
    try {
        const result = await aiModel.generateContent(prompt);
        const jsonString = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonString);
    } catch (error) {
        console.error("Error dari Gemini API (analyzeText):", error);
        return { is_transaction: false };
    }
}

async function analyzeReceipt(imageBase64) {
    const prompt = 'Anda adalah AI OCR yang sangat akurat. Tugas Anda adalah membaca gambar struk belanja ini.' +
        ' 1. Ekstrak semua item yang dibeli, kuantitas, dan harganya.' +
        ' 2. Cari dan identifikasi TOTAL AKHIR dari struk tersebut.' +
        ' 3. Identifikasi nama toko jika memungkinkan.' +
        ' 4. Abaikan diskon, pajak, atau biaya layanan, fokus hanya pada total akhir.' +
        ' Format JSON WAJIB: {"success": boolean, "store": string|null, "totalAmount": number, "items": [{"name": string, "quantity": number, "price": number}]}' +
        ' Jika gambar bukan struk atau tidak bisa dibaca, set "success" ke false.';
    const imagePart = {
        inlineData: {
            data: imageBase64,
            mimeType: 'image/jpeg'
        }
    };
    try {
        const result = await aiModel.generateContent([prompt, imagePart]);
        const jsonString = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonString);
    } catch (error) {
        console.error("Error dari Gemini API (analyzeReceipt):", error);
        return { success: false };
    }
}

async function allocateReceiptItems(text, ocrItems, senderUsername) {
    const prompt = 'Anda adalah AI alokasi. Tugas Anda adalah mencocokkan daftar item dari struk dengan pesan dari user yang menjelaskan siapa makan apa.' +
        ' - "gua" atau "aku" merujuk pada ' + senderUsername + '.' +
        ' - Jika ada "sisanya sharing", alokasikan item yang tidak disebutkan secara spesifik ke SEMUA nama yang ada di pesan (termasuk pengirim).' +
        ' - Hasilnya HARUS berupa array JSON di mana setiap objek mewakili satu item yang dialokasikan ke satu orang.' +
        ' Konteks:' +
        ' - Pengirim Pesan: ' + senderUsername +
        ' - Pesan User: "' + text + '"' +
        ' - Item dari Struk (JSON): ' + JSON.stringify(ocrItems) +
        ' Format JSON WAJIB: {"allocations": [{"consumer": string, "itemName": string, "price": number}]}' +
        ' Contoh:' +
        ' Pesan User: "gua cumi bakar, kepiting rio, sisanya sharing"' +
        ' Item dari Struk: [{"name": "CUMI BAKAR", "price": 100}, {"name": "KEPITING", "price": 150}, {"name": "ES TEH", "price": 10}]' +
        ' Hasil JSON: {"allocations": [{"consumer": "' + senderUsername + '", "itemName": "CUMI BAKAR", "price": 100}, {"consumer": "rio", "itemName": "KEPITING", "price": 150}, {"consumer": "' + senderUsername + '", "itemName": "ES TEH", "price": 10}, {"consumer": "rio", "itemName": "ES TEH", "price": 10}]}' +
        ' Sekarang, proses data di atas.';
    try {
        const result = await aiModel.generateContent(prompt);
        const jsonString = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonString);
    } catch (error) {
        console.error("Error dari Gemini API (allocateReceiptItems):", error);
        return { allocations: [] };
    }
}

async function generateCreativeResponse(baseMessage) {
    const prompt = 'Anda adalah kepribadian AI dari sebuah bot Telegram. Tugas Anda adalah mengambil pesan sistem yang kaku dan MENGUBAHNYA menjadi satu respon yang natural, ramah, dan efisien. JANGAN memberikan opsi atau penjelasan. Langsung berikan hasilnya. Gunakan bahasa yang santai dan to the point.' +
        ' Contoh:' +
        ' Pesan Sistem: "Transaksi berhasil ditambahkan."' +
        ' Hasil Anda: Oke, sudah tercatat ya.' +
        ' Pesan Sistem: "Sesi berhasil dibuat."' +
        ' Hasil Anda: Sesi baru sudah siap. Silakan mulai catat pengeluaran.' +
        ' Pesan Sistem: "Belum ada transaksi di sesi ini."' +
        ' Hasil Anda: Hmm, sepertinya belum ada transaksi di sesi ini. Mau coba catat yang pertama?' +
        ' Sekarang, proses pesan sistem berikut:' +
        ' Pesan Sistem: "' + baseMessage + '"' +
        ' Hasil Anda:';
    try {
        const result = await aiModel.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        console.error("Error dari Gemini API (generateCreativeResponse):", error);
        return baseMessage;
    }
}

module.exports = { analyzeText, analyzeReceipt, allocateReceiptItems, generateCreativeResponse };