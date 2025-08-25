// src/bot.js
require('dotenv').config();
require('./config/firebase-init');
const { Telegraf } = require('telegraf');
const { registerHandlers } = require('./modules/handlers');

if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('ERROR: TELEGRAM_BOT_TOKEN tidak ditemukan di .env');
    process.exit(1);
}
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

registerHandlers(bot);

bot.launch();
console.log('Bot Split Bill v11.0 (Grand Finale) sedang berjalan...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));