// src/modules/handlers.js
const { Markup } = require('telegraf');
const ExcelJS = require('exceljs');
const { distance } = require('fastest-levenshtein');
const axios = require('axios');
const db = require('./database');
const ai = require('./ai');

const withFocusedSession = (handler) => async (ctx) => {
    const session = await db.getFocusedSession(ctx.chat.id);
    if (!session) {
        const response = await ai.generateCreativeResponse("Tidak ada sesi yang dipilih. Gunakan /sessions untuk memilih.");
        return ctx.reply(response);
    }
    return handler(ctx, session);
};

const handleNewChatMember = (ctx) => {
    const newMember = ctx.message.new_chat_members[0];
    if (newMember.id === ctx.botInfo.id) {
        ctx.reply("Halo semua! 👋 Saya Split Bill Bot, siap bantu kalian patungan tanpa pusing.\n\nKetik aja nama sesi untuk memulai, contoh: `Makan Bareng`");
    }
};

const handleStart = async (ctx) => ctx.reply(await ai.generateCreativeResponse('Selamat datang! Ketik nama sesi untuk memulai, atau gunakan /sessions untuk melihat sesi yang sudah ada.'));
const handleHelp = (ctx) => ctx.reply('Perintah:\n`[Nama Sesi]` - Membuat sesi baru (contoh: `Nongkrong Malam Ini`)\n/sessions - Lihat & pilih sesi\n/list - Lihat & hapus transaksi\n/split - Rincian tagihan\n/settlement - Siapa bayar siapa\n/end - Akhiri sesi\n/export - Laporan Excel\n\nUntuk mencatat transaksi, cukup ketik biasa (contoh: `Aku bayar parkir 5rb`) atau kirim foto struk.');

const handleStartSession = async (ctx, sessionName) => {
    const { id: chatId } = ctx.chat;
    const { id: userId, username, first_name, last_name } = ctx.from;
    const senderUsername = username || `${first_name} ${last_name || ''}`.trim();
    if (!sessionName) return ctx.reply('Harap berikan nama sesi. Contoh: `Nongkrong di Cafe`');
    try {
        const sessionId = await db.createSession(chatId, userId, senderUsername, sessionName);
        await db.setFocusedSession(chatId, sessionId);
        ctx.reply(await ai.generateCreativeResponse(`Sesi "${sessionName}" berhasil dibuat dan sekarang menjadi sesi aktif.`));
    } catch (error) { console.error(error); ctx.reply('Maaf, terjadi kesalahan saat membuat sesi.'); }
};

const handleSessions = async (ctx) => {
    const chatId = ctx.chat.id;
    const snapshot = await db.getSessionsByChat(chatId);
    if (snapshot.empty) return ctx.reply(await ai.generateCreativeResponse('Belum ada sesi yang dibuat di grup ini.'));
    const focusedSession = await db.getFocusedSession(chatId);
    const buttons = snapshot.docs.map(doc => {
        const session = doc.data();
        const isFocused = focusedSession && focusedSession.id === doc.id;
        const statusIcon = session.status === 'active' ? '🟢' : '🔴';
        const focusIcon = isFocused ? '⭐️ ' : '';
        const buttonText = `${focusIcon}${statusIcon} ${session.name}`;
        return [Markup.button.callback(buttonText, `select_session:${doc.id}`, isFocused)];
    });
    ctx.reply('Pilih sesi untuk dikelola:', Markup.inlineKeyboard(buttons));
};

const handleList = withFocusedSession(async (ctx, session) => {
    const allTransactions = await db.getTransactions(session.ref);
    if (allTransactions.empty) return ctx.reply(await ai.generateCreativeResponse('Belum ada transaksi di sesi ini.'));
    const page = ctx.match ? parseInt(ctx.match[1], 10) : 1;
    const PAGE_SIZE = 10;
    const membersSnapshot = await session.ref.collection('members').get();
    const membersMap = {};
    membersSnapshot.forEach(doc => membersMap[doc.id] = doc.data().username);
    const totalTransactions = allTransactions.size;
    const totalPages = Math.ceil(totalTransactions / PAGE_SIZE) || 1;
    const startIndex = (page - 1) * PAGE_SIZE;
    const transactionsToShow = allTransactions.docs.slice(startIndex, startIndex + PAGE_SIZE);
    let message = `📜 *Transaksi di Sesi: ${session.data.name}* (Hal ${page}/${totalPages})\n\n`;
    const deleteButtons = [];
    transactionsToShow.forEach((doc, index) => {
        const tx = doc.data();
        const payer = membersMap[tx.payerId] || 'Unknown';
        const consumer = membersMap[tx.consumerId] || 'Unknown';
        const formattedAmount = new Intl.NumberFormat('id-ID').format(tx.amount);
        message += `${startIndex + index + 1}. *${payer}* bayar *Rp${formattedAmount}* untuk *${consumer}* (${tx.description})\n`;
        deleteButtons.push(Markup.button.callback(`Hapus No. ${startIndex + index + 1}`, `delete_tx:${doc.id}:${page}`));
    });
    const paginationButtons = [];
    if (page > 1) paginationButtons.push(Markup.button.callback('⬅️ Sebelumnya', `list_page:${page - 1}`));
    if (page < totalPages) paginationButtons.push(Markup.button.callback('Selanjutnya ➡️', `list_page:${page + 1}`));
    const keyboard = [...deleteButtons.map(btn => [btn]), paginationButtons];
    if (ctx.callbackQuery) {
        await ctx.editMessageText(message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
        await ctx.answerCbQuery();
    } else {
        await ctx.replyWithMarkdown(message, Markup.inlineKeyboard(keyboard));
    }
});

const handleSplit = withFocusedSession(async (ctx, session) => {
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    const { summary } = await db.calculateSettlement(session.ref);
    if (!summary || summary.totalExpenses === 0) {
        return ctx.reply(await ai.generateCreativeResponse('Belum ada transaksi untuk dihitung.'));
    }
    let text = `📊 *Ringkasan Sesi: ${session.data.name}*\n\n`;
    text += `Total Pengeluaran: *Rp${new Intl.NumberFormat('id-ID').format(summary.totalExpenses)}*\n\n`;
    text += `*Rincian Pembayaran (Siapa bayar apa):*\n`;
    summary.payments.sort((a, b) => b.paid - a.paid).forEach(p => {
        if (p.paid > 0) {
            text += `- *${p.username}*: membayar Rp${new Intl.NumberFormat('id-ID').format(p.paid)}\n`;
        }
    });
    const keyboard = Markup.inlineKeyboard([Markup.button.callback('💸 Hitung Utang Piutang', 'show_settlement')]);
    if (ctx.callbackQuery) {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    } else {
        await ctx.replyWithMarkdown(text, keyboard);
    }
});

const handleSettlement = withFocusedSession(async (ctx, session) => {
    if (ctx.callbackQuery) await ctx.answerCbQuery();
    const { plan, summary } = await db.calculateSettlement(session.ref);
    if (!summary) return ctx.reply("Tidak ada data untuk dihitung.");
    if (summary.memberCount <= 1 && summary.totalExpenses > 0) return ctx.reply('Hanya ada satu anggota, tidak ada yang perlu dihitung.');
    if (plan.length === 0) {
        return ctx.reply(await ai.generateCreativeResponse('Semua sudah lunas atau belum ada transaksi!'));
    }
    let text = '💸 *Rencana Utang Piutang*\n\n';
    plan.forEach(p => {
        const formattedAmount = new Intl.NumberFormat('id-ID').format(p.amount);
        text += `*${p.from}* harus bayar ke *${p.to}* sebesar *Rp${formattedAmount}*\n`;
    });
    const keyboard = Markup.inlineKeyboard([Markup.button.callback('🧾 Ekspor Laporan', 'show_export')]);
    if (ctx.callbackQuery) {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: keyboard.reply_markup });
    } else {
        await ctx.replyWithMarkdown(text, keyboard);
    }
});

const handleEnd = withFocusedSession(async (ctx, session) => {
    if (session.data.status !== 'active') return ctx.reply(`Sesi "${session.data.name}" memang sudah berakhir.`);
    await db.endSession(session.id);
    await db.clearFocusedSession(ctx.chat.id);
    ctx.reply(await ai.generateCreativeResponse(`Sesi "${session.data.name}" telah diakhiri.`));
});

const handleExport = withFocusedSession(async (ctx, session) => {
    if (ctx.callbackQuery) await ctx.answerCbQuery('Membuat laporan...');
    const { plan, summary } = await db.calculateSettlement(session.ref);
    const transactionsSnapshot = await session.ref.collection('transactions').get();
    const membersSnapshot = await session.ref.collection('members').get();
    const membersMap = {};
    membersSnapshot.forEach(doc => membersMap[doc.id] = doc.data().username);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Laporan');
    sheet.mergeCells('A1:D1'); sheet.getCell('A1').value = `Laporan Sesi: ${session.data.name}`; sheet.getCell('A1').font = { bold: true, size: 16 };
    sheet.getCell('A3').value = 'Total Pengeluaran'; sheet.getCell('B3').value = summary.totalExpenses;
    sheet.getCell('A5').value = 'Pembayar'; sheet.getCell('B5').value = 'Konsumen'; sheet.getCell('C5').value = 'Deskripsi'; sheet.getCell('D5').value = 'Jumlah';
    ['A5', 'B5', 'C5', 'D5'].forEach(cell => sheet.getCell(cell).font = { bold: true });
    let currentRow = 6;
    transactionsSnapshot.forEach(doc => {
        const tx = doc.data();
        sheet.getCell(`A${currentRow}`).value = membersMap[tx.payerId] || 'Unknown';
        sheet.getCell(`B${currentRow}`).value = membersMap[tx.consumerId] || 'Unknown';
        sheet.getCell(`C${currentRow}`).value = tx.description;
        sheet.getCell(`D${currentRow}`).value = tx.amount;
        currentRow++;
    });
    sheet.getCell(`A${currentRow + 1}`).value = 'Dari'; sheet.getCell(`B${currentRow + 1}`).value = 'Ke'; sheet.getCell(`C${currentRow + 1}`).value = 'Jumlah Bayar';
    [`A${currentRow + 1}`, `B${currentRow + 1}`, `C${currentRow + 1}`].forEach(cell => sheet.getCell(cell).font = { bold: true });
    currentRow += 2;
    plan.forEach(p => {
        sheet.getCell(`A${currentRow}`).value = p.from; sheet.getCell(`B${currentRow}`).value = p.to; sheet.getCell(`C${currentRow}`).value = p.amount;
        currentRow++;
    });
    sheet.columns.forEach(column => column.width = 20);
    const buffer = await workbook.xlsx.writeBuffer();
    ctx.replyWithDocument({ source: buffer, filename: `Laporan_${session.data.name.replace(/\s/g, '_')}.xlsx` });
});

const handleSelectSession = async (ctx) => {
    const sessionId = ctx.match[1];
    const sessionData = await db.getSessionById(sessionId);
    if (!sessionData) return ctx.answerCbQuery('Sesi ini tidak ditemukan!', { show_alert: true });
    if (sessionData.data.status === 'active') {
        await db.setFocusedSession(ctx.chat.id, sessionId);
        await ctx.answerCbQuery(`Sesi "${sessionData.data.name}" dipilih.`);
        await ctx.editMessageText(`✅ Sesi *"${sessionData.data.name}"* sekarang aktif.`, { parse_mode: 'Markdown' });
    } else {
        await ctx.answerCbQuery();
        const buttons = [Markup.button.callback('🔄 Buka Kembali', `reopen_session:${sessionId}`), Markup.button.callback('📂 Lihat Laporan', `export_session:${sessionId}`)];
        await ctx.editMessageText(`Sesi *"${sessionData.data.name}"* sudah berakhir. Apa yang ingin Anda lakukan?`, Markup.inlineKeyboard(buttons, { columns: 2 }));
    }
};

const handleReopenSession = async (ctx) => {
    const sessionId = ctx.match[1];
    const sessionData = await db.getSessionById(sessionId);
    if (!sessionData) return ctx.answerCbQuery('Sesi ini tidak ditemukan!', { show_alert: true });
    await db.reopenSession(sessionId);
    await db.setFocusedSession(ctx.chat.id, sessionId);
    await ctx.answerCbQuery(`Sesi "${sessionData.data.name}" dibuka kembali.`);
    await ctx.editMessageText(`✅ Sesi *"${sessionData.data.name}"* telah dibuka kembali dan sekarang aktif.`, { parse_mode: 'Markdown' });
};

const handleDeleteTransaction = async (ctx) => {
    const [transactionId, page] = ctx.match[1].split(':');
    const session = await db.getFocusedSession(ctx.chat.id);
    if (!session) return ctx.answerCbQuery('Sesi tidak ditemukan.', { show_alert: true });
    await db.deleteTransaction(session.ref, transactionId);
    await ctx.answerCbQuery('Transaksi dihapus!');
    ctx.match = ['', page];
    await handleList(ctx);
};

const handleTextMessage = async (ctx) => {
    const text = ctx.message.text;
    const chatId = ctx.chat.id;
    if (text.startsWith('/')) {
        const command = text.split(' ')[0].substring(1);
        const validCommands = ['start', 'help', 'sessions', 'list', 'split', 'settlement', 'end', 'export'];
        if (validCommands.includes(command)) return;
        let closestCommand = '';
        let minDistance = 3;
        for (const validCmd of validCommands) {
            const dist = distance(command, validCmd);
            if (dist < minDistance) {
                minDistance = dist;
                closestCommand = validCmd;
            }
        }
        if (closestCommand) {
            ctx.reply(`Command tidak dikenal. Mungkin maksud Anda /${closestCommand}?`);
        } else {
            ctx.reply('Command tidak dikenal. Ketik /help untuk melihat daftar perintah.');
        }
        return;
    }
    const { id: userId, username, first_name, last_name } = ctx.from;
    const senderUsername = username || `${first_name} ${last_name || ''}`.trim();
    const pendingAction = await db.getPendingAction(chatId);
    if (pendingAction) {
        if (pendingAction.type === 'ocr_allocation') {
            const { sessionId, ocrResult, payer } = pendingAction.data;
            const session = await db.getSessionById(sessionId);
            ctx.telegram.sendChatAction(chatId, 'typing');
            const allocationResult = await ai.allocateReceiptItems(text, ocrResult.items, senderUsername);
            if (allocationResult && allocationResult.allocations.length > 0) {
                for (const item of allocationResult.allocations) {
                    const consumerUsername = item.consumer;
                    let consumer = { type: 'custom', username: consumerUsername };
                    if (consumerUsername === senderUsername) {
                        consumer = { type: 'telegram', id: userId, username: senderUsername };
                    }
                    await db.addTransaction(session, payer, consumer, item.price, item.itemName);
                }
                await db.clearPendingAction(chatId);
                const responseText = await ai.generateCreativeResponse(`Oke, semua item dari struk sudah dialokasikan dan dicatat.`);
                return ctx.reply(responseText, Markup.inlineKeyboard([Markup.button.callback('📊 Lihat Ringkasan', 'show_split')]));
            } else {
                await db.clearPendingAction(chatId);
                return ctx.reply("Waduh, aku bingung alokasiinnya. Kita batalkan dulu ya, coba kirim ulang struknya.");
            }
        } else if (pendingAction.type === 'ocr_confirmation') {
            const payerUsername = text.startsWith('@') ? text.substring(1) : text;
            let payer = { type: 'custom', username: payerUsername };
            if (payerUsername.toLowerCase() === 'gua' || payerUsername.toLowerCase() === 'aku' || payerUsername === senderUsername) {
                payer = { type: 'telegram', id: userId, username: senderUsername };
            }
            await db.setPendingAction(chatId, {
                type: 'ocr_allocation',
                data: { ...pendingAction.data, payer }
            });
            return ctx.reply(`Sip, yang bayar ${payer.username}. Sekarang tolong jelasin siapa makan/minum apa ya? (Contoh: 'gua sate, rio baso, sisanya sharing')`);
        }
    }
    const session = await db.getFocusedSession(chatId);
    ctx.telegram.sendChatAction(chatId, 'typing');
    try {
        const aiResult = await ai.analyzeText(text, senderUsername);
        if (aiResult && aiResult.is_transaction) {
            if (!session || session.data.status !== 'active') {
                return ctx.reply(await ai.generateCreativeResponse("Sepertinya itu transaksi, tapi belum ada sesi yang aktif. Buat sesi dulu ya."));
            }
            let totalAdded = 0;
            let descriptions = [];
            for (const tx of aiResult.transactions) {
                const payerUsername = tx.payer.toLowerCase() === 'gua' || tx.payer.toLowerCase() === 'aku' ? senderUsername : tx.payer;
                const consumerUsername = tx.consumer.toLowerCase() === 'gua' || tx.consumer.toLowerCase() === 'aku' ? senderUsername : tx.consumer;
                let payer = { type: 'custom', username: payerUsername };
                if (payerUsername === senderUsername) {
                    payer = { type: 'telegram', id: userId, username: senderUsername };
                }
                let consumer = { type: 'custom', username: consumerUsername };
                if (consumerUsername === senderUsername) {
                    consumer = { type: 'telegram', id: userId, username: senderUsername };
                }
                await db.addTransaction(session, payer, consumer, tx.amount, tx.description);
                totalAdded += tx.amount;
                descriptions.push(tx.description);
            }
            if (totalAdded > 0) {
                const responseText = await ai.generateCreativeResponse(`Transaksi (${descriptions.join(', ')}) dengan total Rp${new Intl.NumberFormat('id-ID').format(totalAdded)} berhasil dicatat.`);
                ctx.reply(responseText, Markup.inlineKeyboard([Markup.button.callback('📊 Lihat Ringkasan', 'show_split')]));
            }
        } else if (!session) {
            await handleStartSession(ctx, text);
        }
    } catch (error) {
        console.error("Critical error in handleTextMessage:", error);
        ctx.reply("Waduh, sepertinya saya agak bingung. Bisa coba ulangi dengan format yang lebih jelas?");
    }
};

const handlePhotoMessage = withFocusedSession(async (ctx, session) => {
    const chatId = ctx.chat.id;
    await ctx.reply(await ai.generateCreativeResponse("Oke, terima struknya. Coba aku baca dulu ya..."));
    ctx.telegram.sendChatAction(chatId, 'upload_photo');
    try {
        const fileId = ctx.message.photo.pop().file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const response = await axios.get(fileLink.href, { responseType: 'arraybuffer' });
        const imageBase64 = Buffer.from(response.data, 'binary').toString('base64');
        const ocrResult = await ai.analyzeReceipt(imageBase64);
        if (ocrResult && ocrResult.success) {
            await db.setPendingAction(chatId, {
                type: 'ocr_confirmation',
                data: { sessionId: session.id, ocrResult }
            });
            const storeName = ocrResult.store ? ` dari ${ocrResult.store}` : '';
            await ctx.reply(`Struk${storeName} berhasil dibaca, totalnya Rp${new Intl.NumberFormat('id-ID').format(ocrResult.totalAmount)}. Siapa yang bayar struk ini? (Ketik nama atau 'gua')`);
        } else {
            await ctx.reply(await ai.generateCreativeResponse("Waduh, aku nggak bisa baca struknya. Coba foto lagi yang lebih jelas ya."));
        }
    } catch (error) {
        console.error("Error processing photo:", error);
        await ctx.reply("Maaf, terjadi kesalahan saat memproses gambar.");
    }
});

const registerHandlers = (bot) => {
    bot.on('new_chat_members', handleNewChatMember);
    bot.start(handleStart);
    bot.help(handleHelp);
    bot.command('sessions', handleSessions);
    bot.command('list', handleList);
    bot.command('split', handleSplit);
    bot.command('settlement', handleSettlement);
    bot.command('end', handleEnd);
    bot.command('export', handleExport);
    bot.action(/select_session:(.+)/, handleSelectSession);
    bot.action(/reopen_session:(.+)/, handleReopenSession);
    bot.action(/delete_tx:(.+)/, handleDeleteTransaction);
    bot.action(/export_session:(.+)/, async (ctx) => {
        const sessionId = ctx.match[1];
        const sessionData = await db.getSessionById(sessionId);
        if (sessionData) {
            await handleExport(ctx, sessionData);
        } else { await ctx.answerCbQuery('Sesi tidak ditemukan.', { show_alert: true }); }
    });
    bot.action(/list_page:(.+)/, withFocusedSession(handleList));
    bot.action('show_split', withFocusedSession(handleSplit));
    bot.action('show_settlement', withFocusedSession(handleSettlement));
    bot.action('show_export', withFocusedSession(handleExport));
    bot.on('message', async (ctx) => {
        if (ctx.message.text) {
            await handleTextMessage(ctx);
        } else if (ctx.message.photo) {
            await handlePhotoMessage(ctx);
        } else if (ctx.message.new_chat_members) {
            await handleNewChatMember(ctx);
        }
    });
};

module.exports = { registerHandlers };