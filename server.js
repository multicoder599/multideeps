require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');
const { Bot, InlineKeyboard } = require('grammy');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();

// ==========================================
// ENV VALIDATION
// ==========================================
const requiredEnv = ['TELEGRAM_BOT_TOKEN', 'MONGODB_URI', 'MEGAPAY_API_KEY', 'MEGAPAY_EMAIL', 'APP_URL', 'ADMIN_IDS', 'SMMFOLLOWS_API_KEY'];
for (const key of requiredEnv) {
    if (!process.env[key]) {
        console.error(`❌ Missing required env var: ${key}`);
        process.exit(1);
    }
}

const ADMIN_IDS = process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())).filter(Boolean);
const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID;
const APP_URL = process.env.APP_URL;
const SMM_API_KEY = process.env.SMMFOLLOWS_API_KEY;
const SMM_API_URL = process.env.SMMFOLLOWS_API_URL || 'https://smmfollows.com/api';

// ==========================================
// MIDDLEWARE
// ==========================================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-Telegram-Init-Data');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({
    verify: (req, res, buf) => {
        if (req.path === '/api/megapay/webhook') {
            req.rawBody = buf.toString();
        }
    }
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// MULTER
// ==========================================
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log('✅ Created uploads directory:', uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => { cb(null, uploadDir); },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, unique + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP, GIF allowed'), false);
  }
});

// ==========================================
// DATABASE SCHEMAS
// ==========================================
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => { console.error('❌ MongoDB Error:', err); process.exit(1); });

const merchantSchema = new mongoose.Schema({
    telegramId: { type: Number, required: true, unique: true, index: true },
    username: String,
    firstName: String,
    lastName: String,
    phone: String,
    credits: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
    supportUsername: String,
    createdAt: { type: Date, default: Date.now }
});

const creditPackageSchema = new mongoose.Schema({
    name: String,
    credits: Number,
    price: Number,
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

const creditTxSchema = new mongoose.Schema({
    merchantTelegramId: Number,
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditPackage' },
    amountKes: Number,
    credits: Number,
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
    mpesaReceipt: String,
    phone: String,
    reference: String,
    botId: { type: mongoose.Schema.Types.ObjectId, ref: 'BotInstance' },
    createdAt: { type: Date, default: Date.now }
});

const serviceSchema = new mongoose.Schema({
    serviceId: { type: Number, required: true, unique: true },
    name: String,
    type: String,
    category: String,
    rate: String,
    min: String,
    max: String,
    refill: Boolean,
    cancel: Boolean,
    updatedAt: { type: Date, default: Date.now }
});

const botInstanceSchema = new mongoose.Schema({
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
    botToken: { type: String, required: true },
    botUsername: String,
    botId: Number,
    status: { type: String, enum: ['active', 'suspended', 'expired'], default: 'active' },
    businessName: { type: String, default: 'My SMM Store' },
    welcomeMessage: { type: String, default: 'Welcome! Boost your social media presence. Choose a service below.' },
    welcomePhoto: { type: String, default: '' },
    bannerImage: { type: String, default: '' },
    adminAlertChatId: String,
    supportLink: { type: String, default: '' },
    megapayApiKey: { type: String, default: '' },
    megapayEmail: { type: String, default: '' },
    megapayWebhookUrl: { type: String, default: '' },
    markupPercent: { type: Number, default: 50 },
    enabledServices: [{
        serviceId: Number,
        customPrice: { type: Number, default: 0 },
        isEnabled: { type: Boolean, default: false }
    }],
    subscriptionRemindersSent: [{ type: String, date: Date }],
    lastBilled: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    expiresAt: Date
});

const orderSchema = new mongoose.Schema({
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    botId: { type: mongoose.Schema.Types.ObjectId, ref: 'BotInstance', required: true },
    customerTelegramId: { type: Number, required: true },
    customerUsername: String,
    customerChatId: Number,
    serviceId: Number,
    serviceName: String,
    link: String,
    quantity: Number,
    price: Number,
    smmOrderId: String,
    status: { type: String, default: 'pending' },
    startCount: String,
    remains: String,
    charge: String,
    currency: String,
    refillEligible: { type: Boolean, default: false },
    refillRequested: { type: Boolean, default: false },
    refillStatus: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

const transactionSchema = new mongoose.Schema({
    merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Merchant', required: true },
    botId: { type: mongoose.Schema.Types.ObjectId, ref: 'BotInstance', required: true },
    serviceId: Number,
    serviceName: String,
    customerTelegramId: Number,
    customerUsername: String,
    phone: String,
    amount: Number,
    mpesaReceipt: String,
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});

const pendingTxSchema = new mongoose.Schema({
    reference: { type: String, required: true, unique: true, index: true },
    type: { type: String, enum: ['credit', 'order'], required: true },
    phone: String,
    amount: Number,
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
    merchantTelegramId: Number,
    packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditPackage' },
    credits: Number,
    botId: { type: mongoose.Schema.Types.ObjectId, ref: 'BotInstance' },
    customerTelegramId: Number,
    customerChatId: Number,
    serviceId: Number,
    serviceName: String,
    link: String,
    quantity: Number,
    megapayTransactionId: String,
    megapayMerchantRequestId: String,
    megapayCheckoutRequestId: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 }
});

const Merchant = mongoose.model('Merchant', merchantSchema);
const CreditPackage = mongoose.model('CreditPackage', creditPackageSchema);
const CreditTransaction = mongoose.model('CreditTransaction', creditTxSchema);
const Service = mongoose.model('Service', serviceSchema);
const BotInstance = mongoose.model('BotInstance', botInstanceSchema);
const Order = mongoose.model('Order', orderSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const PendingTransaction = mongoose.model('PendingTransaction', pendingTxSchema);

// ==========================================
// FORCE SEED SUBSCRIPTION PACKAGES
// ==========================================
async function seedPackages() {
    await CreditPackage.deleteMany({});
    await CreditPackage.insertMany([
        { name: '1 Week', credits: 7, price: 500, isActive: true },
        { name: '2 Weeks', credits: 14, price: 800, isActive: true },
        { name: '1 Month', credits: 30, price: 1500, isActive: true },
    ]);
    console.log('✅ Subscription packages reset');
}

// ==========================================
// IN-MEMORY STATE
// ==========================================
const activeBots = new Map();
const adminUserState = new Map();
const merchantPendingInputs = new Map();

// ==========================================
// HELPERS
// ==========================================
function escapeMarkdown(text) {
    if (!text) return '';
    return String(text)
        .replace(/_/g, '\\_')
        .replace(/\*/g, '\\*')
        .replace(/\[/g, '\\[')
        .replace(/`/g, '\\`');
}

function daysLeft(endDate) {
    const diff = new Date(endDate) - new Date();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

async function getOrCreateMerchant(ctx) {
    const from = ctx.from;
    let merchant = await Merchant.findOne({ telegramId: from.id });
    if (!merchant) {
        merchant = new Merchant({ telegramId: from.id, username: from.username, firstName: from.first_name, lastName: from.last_name });
        await merchant.save();
    }
    return merchant;
}

function getAdminMenu() {
    return new InlineKeyboard()
        .text("💰 Subscribe Bot", "buy_credits").row()
        .text("➕ Create Bot", "create_bot").row()
        .text("🤖 My Bots", "my_bots").row()
        .text("📊 My Stats", "my_stats").row()
        .text("📱 Open Dashboard", "open_dashboard").row()
        .text("📞 Support", "support");
}

function getBotManagementMenu(botId) {
    return new InlineKeyboard()
        .text("🛒 Service Catalog", `edit_services_${botId}`).row()
        .text("📋 View Orders", `view_orders_${botId}`).row()
        .text("💳 Payment Settings", `payment_settings_${botId}`).row()
        .text("🖼️ Banners & Images", `edit_images_${botId}`).row()
        .text("⚙️ Bot Settings", `bot_settings_${botId}`).row()
        .text("📊 View Stats", `bot_stats_${botId}`).row()
        .text("▶️ Start / ⏸️ Stop", `toggle_bot_${botId}`).row()
        .text("🔙 Back to My Bots", "my_bots");
}

async function safeEdit(ctx, text, keyboard) {
    try {
        await ctx.editMessageCaption({ caption: text, parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
        if (e?.description?.includes('no caption') || e?.description?.includes('message is not modified')) {
            try { await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard }); }
            catch (e2) { await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard }); }
        } else { throw e; }
    }
}

async function setWebhookWithRetry(bot, url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try { await bot.api.setWebhook(url); return; }
        catch (err) {
            if (err?.error_code === 429 && i < retries - 1) {
                const retryAfter = err?.parameters?.retry_after || 2;
                await new Promise(r => setTimeout(r, retryAfter * 1000));
            } else { throw err; }
        }
    }
}

// ==========================================
// MINI APP AUTH MIDDLEWARE
// ==========================================
function validateInitData(req, res, next) {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const params = new URLSearchParams(initData);
        const userJson = params.get('user');
        if (!userJson) return res.status(401).json({ error: 'No user data' });
        req.telegramUser = JSON.parse(userJson);
        next();
    } catch (e) { return res.status(401).json({ error: 'Invalid init data' }); }
}

async function getPartnerFromInit(user) {
    let merchant = await Merchant.findOne({ telegramId: user.id });
    if (!merchant) {
        merchant = new Merchant({ telegramId: user.id, username: user.username, firstName: user.first_name, lastName: user.last_name });
        await merchant.save();
    }
    return merchant;
}

// ==========================================
// NORMALIZE MEGAPAY WEBHOOK PAYLOAD
// ==========================================
function normalizeMegapayPayload(data) {
    if (data?.Body?.stkCallback) {
        const cb = data.Body.stkCallback;
        const meta = {};
        if (cb.CallbackMetadata?.Item) {
            for (const item of cb.CallbackMetadata.Item) {
                if (item.Name && item.Value !== undefined) meta[item.Name] = item.Value;
            }
        }
        return {
            responseCode: cb.ResultCode,
            resultDesc: cb.ResultDesc,
            merchantRequestId: cb.MerchantRequestID,
            checkoutRequestId: cb.CheckoutRequestID,
            reference: null,
            receipt: meta.MpesaReceiptNumber || meta.mpesaReceiptNumber,
            amount: meta.Amount,
            phone: meta.PhoneNumber || meta.phoneNumber,
            _format: 'daraja',
            _raw: data
        };
    }
    return {
        responseCode: data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode,
        resultDesc: data.ResponseDescription || data.ResultDesc,
        merchantRequestId: data.MerchantRequestID,
        checkoutRequestId: data.CheckoutRequestID,
        transactionRequestId: data.transaction_request_id,
        reference: data.reference || data.Reference || data.transactionReference || data.TransactionReference || data.transaction_reference,
        receipt: data.TransactionReceipt || data.MpesaReceiptNumber || data.ReceiptNo || data.mpesaReceiptNumber,
        amount: data.TransactionAmount || data.amount || data.Amount,
        phone: data.Msisdn || data.phone || data.PhoneNumber || data.msisdn || data.MSISDN,
        _format: 'flat',
        _raw: data
    };
}

// ==========================================
// ADMIN BOT SETUP (GRAMMY)
// ==========================================
const adminBot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

adminBot.command("start", async (ctx) => {
    const merchant = await getOrCreateMerchant(ctx);
    const welcomeText = `👋 Hello ${escapeMarkdown(ctx.from.first_name || 'Partner')}!\n\n🤖 *Welcome to SMM Panel Admin*\n\n💡 Create your own Telegram SMM store and sell followers, views & likes!\n⚡ Subscription-based bot hosting\n\nTap below to open your dashboard 👇`;
    const keyboard = new InlineKeyboard().row({ text: '👇 Open Dashboard', web_app: { url: APP_URL } });
    try {
        await ctx.replyWithPhoto(process.env.IMG_MAIN_BANNER || "https://i.imgur.com/iNaOiyf.jpg", { caption: welcomeText, parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) { await ctx.reply(welcomeText, { parse_mode: "Markdown", reply_markup: keyboard }); }
});

adminBot.command("admin", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("⛔ Use /admin on your own bot, not here.");
    const totalMerchants = await Merchant.countDocuments();
    const totalBots = await BotInstance.countDocuments();
    const totalOrders = await Order.countDocuments();
    const totalRevenue = await Transaction.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
    const menu = new InlineKeyboard()
        .text("👥 Merchants", "sa_merchants").row()
        .text("📢 Broadcast Merchants", "sa_broadcast").row()
        .text("📊 Daily Profits", "sa_profits").row()
        .text("🔄 Sync Services", "sa_sync_services").row()
        .text("🔙 Back", "sa_back");
    await ctx.reply(
        `🔧 *SUPER ADMIN PANEL*\n\n👥 Merchants: *${totalMerchants}*\n🤖 Bots: *${totalBots}*\n📦 Orders: *${totalOrders}*\n💰 Total Revenue: *KES ${totalRevenue[0]?.total || 0}*`,
        { parse_mode: "Markdown", reply_markup: menu }
    );
});

adminBot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.answerCallbackQuery("⛔ Unauthorized");
    try {
        if (data === 'sa_back' || data === 'back_admin') {
            const totalMerchants = await Merchant.countDocuments();
            const totalBots = await BotInstance.countDocuments();
            const totalOrders = await Order.countDocuments();
            const totalRevenue = await Transaction.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
            const menu = new InlineKeyboard()
                .text("👥 Merchants", "sa_merchants").row()
                .text("📢 Broadcast Merchants", "sa_broadcast").row()
                .text("📊 Daily Profits", "sa_profits").row()
                .text("🔄 Sync Services", "sa_sync_services").row();
            await safeEdit(ctx,
                `🔧 *SUPER ADMIN PANEL*\n\n👥 Merchants: *${totalMerchants}*\n🤖 Bots: *${totalBots}*\n📦 Orders: *${totalOrders}*\n💰 Total Revenue: *KES ${totalRevenue[0]?.total || 0}*`,
                menu
            );
            return ctx.answerCallbackQuery();
        }

        if (data === 'sa_merchants') {
            const merchants = await Merchant.find().sort({ createdAt: -1 }).limit(20);
            let text = `👥 *Merchants (${merchants.length})*\n\n`;
            const keyboard = new InlineKeyboard();
            for (const m of merchants) {
                const mBots = await BotInstance.find({ merchantId: m._id });
                const botCount = mBots.length;
                const activeSubs = mBots.filter(b => b.status === 'active' && b.expiresAt > new Date()).length;
                const subInfo = mBots.map(b => { const days = b.expiresAt ? daysLeft(b.expiresAt) : 0; return `@${b.botUsername} (${days}d)`; }).join(', ');
                text += `• *${escapeMarkdown(m.firstName || 'Unknown')}* (@${escapeMarkdown(m.username || m.telegramId)})\n  Bots: ${botCount} | Active: ${activeSubs}\n  Subs: ${escapeMarkdown(subInfo || 'None')}\n\n`;
            }
            keyboard.text("🔙 Back", "sa_back");
            await safeEdit(ctx, text, keyboard);
            return ctx.answerCallbackQuery();
        }

        if (data === 'sa_broadcast') {
            adminUserState.set(ctx.from.id, { action: 'sa_broadcast_msg', data: {} });
            await safeEdit(ctx, `📢 *Broadcast to All Merchants*\n\nType your message below.`, new InlineKeyboard().text("🔙 Cancel", "sa_back"));
            return ctx.answerCallbackQuery();
        }

        if (data === 'sa_profits') {
            const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
            const todayStart = new Date(); todayStart.setHours(0,0,0,0);
            const dailyRevenue = await Transaction.aggregate([{ $match: { status: 'completed', createdAt: { $gte: todayStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
            const yesterdayRevenue = await Transaction.aggregate([{ $match: { status: 'completed', createdAt: { $gte: yesterday, $lt: todayStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
            const totalRevenue = await Transaction.aggregate([{ $match: { status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
            const dailyTxns = await Transaction.countDocuments({ status: 'completed', createdAt: { $gte: todayStart } });
            const totalTxns = await Transaction.countDocuments({ status: 'completed' });
            const text = `📊 *Daily Profits Summary*\n\n*Today:*\n💰 KES ${dailyRevenue[0]?.total || 0} | 🧾 ${dailyTxns} txns\n\n*Yesterday:*\n💰 KES ${yesterdayRevenue[0]?.total || 0}\n\n*All Time:*\n💰 KES ${totalRevenue[0]?.total || 0} | 🧾 ${totalTxns} txns`;
            await safeEdit(ctx, text, new InlineKeyboard().text("🔙 Back", "sa_back"));
            return ctx.answerCallbackQuery();
        }

        if (data === 'sa_sync_services') {
            ctx.answerCallbackQuery("⏳ Syncing...").catch(()=>{});
            try {
                const res = await axios.post(SMM_API_URL, { key: SMM_API_KEY, action: 'services' });
                const services = res.data;
                if (!Array.isArray(services)) throw new Error('Invalid response');
                await Service.deleteMany({});
                await Service.insertMany(services.map(s => ({
                    serviceId: s.service,
                    name: s.name,
                    type: s.type,
                    category: s.category,
                    rate: s.rate,
                    min: s.min,
                    max: s.max,
                    refill: s.refill,
                    cancel: s.cancel
                })));
                await ctx.reply(`✅ Synced *${services.length}* services from smmfollows!`, { parse_mode: "Markdown" });
            } catch (e) {
                await ctx.reply(`❌ Sync failed: ${escapeMarkdown(e.message)}`, { parse_mode: "Markdown" });
            }
            return;
        }

        // Fallback to merchant callbacks
        const merchant = await getOrCreateMerchant(ctx);

        if (data === 'buy_credits') {
            const bots = await BotInstance.find({ merchantId: merchant._id }).sort({ createdAt: -1 });
            if (bots.length === 0) {
                await safeEdit(ctx, `💰 *Subscribe Bot*\n\nYou have no bots yet. Create one first!`, getAdminMenu());
                return ctx.answerCallbackQuery();
            }
            const keyboard = new InlineKeyboard();
            bots.forEach(bot => {
                const days = bot.expiresAt ? daysLeft(bot.expiresAt) : 0;
                const status = bot.status === 'active' ? '🟢' : '🔴';
                keyboard.text(`${status} @${escapeMarkdown(bot.botUsername)} (${days}d)`, `sub_bot_${bot._id}`).row();
            });
            keyboard.text("🔙 Back", "back_admin");
            await safeEdit(ctx, `💰 *Select Bot to Subscribe*\n\nChoose a bot to renew subscription:`, keyboard);
            return ctx.answerCallbackQuery();
        }

        if (data.startsWith('sub_bot_')) {
            const botId = data.replace('sub_bot_', '');
            const instance = await BotInstance.findById(botId);
            if (!instance || instance.merchantId.toString() !== merchant._id.toString()) return ctx.answerCallbackQuery("⛔ Not your bot!");
            const packages = await CreditPackage.find({ isActive: true }).sort({ price: 1 });
            const keyboard = new InlineKeyboard();
            packages.forEach(pkg => { keyboard.text(`${pkg.name} — KES ${pkg.price}`, `sub_pkg_${botId}_${pkg._id}`).row(); });
            keyboard.text("🔙 Back", "buy_credits");
            const days = instance.expiresAt ? daysLeft(instance.expiresAt) : 0;
            await safeEdit(ctx, `📅 *@${escapeMarkdown(instance.botUsername)}*\nCurrent expiry: *${days} days* left\n\nSelect plan:`, keyboard);
            return ctx.answerCallbackQuery();
        }

        if (data.startsWith('sub_pkg_')) {
            const parts = data.split('_');
            const botId = parts[2];
            const pkgId = parts[3];
            const instance = await BotInstance.findById(botId);
            const pkg = await CreditPackage.findById(pkgId);
            if (!instance || !pkg) return ctx.answerCallbackQuery("Invalid selection");
            adminUserState.set(ctx.from.id, { action: 'awaiting_sub_phone', data: { botId, package: pkg } });
            await safeEdit(ctx, `📱 *${escapeMarkdown(pkg.name)}*\nPrice: KES ${pkg.price}\nDuration: ${pkg.credits} days\n\nEnter M-Pesa number (07XXXXXXXX):`, new InlineKeyboard().text("🔙 Cancel", `sub_bot_${botId}`));
            return ctx.answerCallbackQuery();
        }

        if (data === 'create_bot') {
            adminUserState.set(ctx.from.id, { action: 'awaiting_bot_token', data: {} });
            await safeEdit(ctx, `➕ *Create New Bot*\n\n1. Go to @BotFather\n2. Create a new bot\n3. Copy the *API Token*\n4. Paste it here\n\n⚠️ First day is FREE. Subscribe to keep running.\n\nPaste your bot token below 👇`, new InlineKeyboard().text("🔙 Cancel", "back_admin"));
            return ctx.answerCallbackQuery();
        }

        if (data === 'my_bots') {
            const bots = await BotInstance.find({ merchantId: merchant._id }).sort({ createdAt: -1 });
            if (bots.length === 0) {
                await safeEdit(ctx, `🤖 *My Bots*\n\nYou have no bots yet.\n\nTap "➕ Create Bot" to get started!`, getAdminMenu());
                return ctx.answerCallbackQuery();
            }
            const keyboard = new InlineKeyboard();
            bots.forEach(bot => {
                const status = bot.status === 'active' ? '🟢' : '🔴';
                keyboard.text(`${status} @${escapeMarkdown(bot.botUsername || 'Unknown')}`, `manage_bot_${bot._id}`).row();
            });
            keyboard.text("🔙 Back", "back_admin");
            await safeEdit(ctx, `🤖 *My Bots (${bots.length})*\n\nTap a bot to manage:`, keyboard);
            return ctx.answerCallbackQuery();
        }

        if (data === 'my_stats') {
            const bots = await BotInstance.find({ merchantId: merchant._id });
            const botIds = bots.map(b => b._id);
            const totalOrders = await Order.countDocuments({ botId: { $in: botIds } });
            const totalRevenue = await Transaction.aggregate([{ $match: { merchantId: merchant._id, status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
            const activeSubs = bots.filter(b => b.status === 'active').length;
            await safeEdit(ctx,
                `📊 *Your Stats*\n\n🤖 Bots: *${bots.length}*\n🟢 Active: *${activeSubs}*\n📦 Total Orders: *${totalOrders}*\n💰 Revenue: *KES ${totalRevenue[0]?.total || 0}*`,
                new InlineKeyboard().text("🔙 Back", "back_admin")
            );
            return ctx.answerCallbackQuery();
        }

        if (data === 'open_dashboard') {
            await ctx.answerCallbackQuery("Opening dashboard...");
            await ctx.reply(`👋 Welcome back!\n\nPartner: @${escapeMarkdown(ctx.from.username || 'unknown')}\nStatus: 🟢 Active\n\nTap below to launch your panel 👇`, {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().row({ text: '👇 Open Dashboard', web_app: { url: APP_URL } })
            });
            return;
        }

        if (data.startsWith('manage_bot_')) {
            const botId = data.replace('manage_bot_', '');
            const instance = await BotInstance.findById(botId);
            if (!instance || instance.merchantId.toString() !== merchant._id.toString()) return ctx.answerCallbackQuery("⛔ Not your bot!");
            const statusText = instance.status === 'active' ? '🟢 Active' : '🔴 Suspended';
            const totalOrders = await Order.countDocuments({ botId: instance._id });
            const days = instance.expiresAt ? daysLeft(instance.expiresAt) : 0;
            await safeEdit(ctx,
                `🤖 *@${escapeMarkdown(instance.botUsername)}*\nStatus: *${statusText}*\n⏳ Expires: *${days} days*\n📦 Orders: *${totalOrders}*`,
                getBotManagementMenu(botId)
            );
            return ctx.answerCallbackQuery();
        }

        if (data.startsWith('edit_services_')) {
            const botId = data.replace('edit_services_', '');
            await ctx.answerCallbackQuery("Open dashboard to manage services");
            await ctx.reply(`🛒 *Service Catalog*\n\nOpen your dashboard to enable services and set prices 👇`, {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().row({ text: '👇 Open Dashboard', web_app: { url: APP_URL } })
            });
            return;
        }

        if (data.startsWith('view_orders_')) {
            const botId = data.replace('view_orders_', '');
            const orders = await Order.find({ botId }).sort({ createdAt: -1 }).limit(10);
            let text = `📋 *Recent Orders*\n\n`;
            if (orders.length === 0) text += `_No orders yet._`;
            else {
                orders.forEach(o => {
                    text += `• #${o.smmOrderId || 'N/A'} — ${escapeMarkdown(o.serviceName)} — ${o.quantity} qty — KES ${o.price} — ${o.status}\n`;
                });
            }
            await safeEdit(ctx, text, new InlineKeyboard().text("🔙 Back", `manage_bot_${botId}`));
            return ctx.answerCallbackQuery();
        }

        if (data.startsWith('payment_settings_')) {
            const botId = data.replace('payment_settings_', '');
            const instance = await BotInstance.findById(botId);
            adminUserState.set(ctx.from.id, { action: 'payment_menu', data: { botId } });
            const hasConfig = instance.megapayApiKey && instance.megapayEmail;
            const webhookDisplay = `${APP_URL}/api/megapay/webhook?id=${instance.botUsername || 'bot'}`;
            const keyboard = new InlineKeyboard()
                .text("🔑 Set Megapay API Key", `set_megapay_key_${botId}`).row()
                .text("📧 Set Megapay Email", `set_megapay_email_${botId}`).row()
                .text("🔗 Set Webhook URL", `set_webhook_${botId}`).row()
                .text("🔙 Back", `manage_bot_${botId}`);
            await safeEdit(ctx,
                `💳 *Payment Settings*\n\nStatus: *${hasConfig ? '✅ Configured' : '❌ Not set'}*\n\nYour Webhook:\n\`${escapeMarkdown(webhookDisplay)}\`\n\nMoney goes directly to YOUR Megapay account.`,
                keyboard
            );
            return ctx.answerCallbackQuery();
        }

        if (data.startsWith('set_megapay_key_')) {
            const botId = data.replace('set_megapay_key_', '');
            adminUserState.set(ctx.from.id, { action: 'awaiting_megapay_key', data: { botId } });
            await safeEdit(ctx, `🔑 *Set Megapay API Key*\n\nPaste your Megapay API key below 👇`, new InlineKeyboard().text("🔙 Cancel", `payment_settings_${botId}`));
            return ctx.answerCallbackQuery();
        }

        if (data.startsWith('set_megapay_email_')) {
            const botId = data.replace('set_megapay_email_', '');
            adminUserState.set(ctx.from.id, { action: 'awaiting_megapay_email', data: { botId } });
            await safeEdit(ctx, `📧 *Set Megapay Email*\n\nPaste your Megapay account email below 👇`, new InlineKeyboard().text("🔙 Cancel", `payment_settings_${botId}`));
            return ctx.answerCallbackQuery();
        }

        if (data.startsWith('set_webhook_')) {
            const botId = data.replace('set_webhook_', '');
            adminUserState.set(ctx.from.id, { action: 'awaiting_webhook_url', data: { botId } });
            await safeEdit(ctx, `🔗 *Set Custom Webhook*\n\nEnter your webhook URL (or type "default" to use platform webhook):`, new InlineKeyboard().text("🔙 Cancel", `payment_settings_${botId}`));
            return ctx.answerCallbackQuery();
        }

        if (data.startsWith('edit_images_')) {
            const botId = data.replace('edit_images_', '');
            const instance = await BotInstance.findById(botId);
            adminUserState.set(ctx.from.id, { action: 'image_menu', data: { botId } });
            await safeEdit(ctx,
                `🖼️ *Banners & Images*\n\nMain Banner: *${instance.bannerImage ? '✅ Set' : '❌ Not set'}*\nWelcome Photo: *${instance.welcomePhoto ? '✅ Set' : '❌ Not set'}*\n\nSend an image URL or upload via dashboard.`,
                new InlineKeyboard()
                    .text("🖼️ Set Main Banner", `set_banner_${botId}`).row()
                    .text("👋 Set Welcome Photo", `set_welcome_photo_${botId}`).row()
                    .text("🔙 Back", `manage_bot_${botId}`)
            );
            return ctx.answerCallbackQuery();
        }

        if (data.startsWith('set_banner_') || data.startsWith('set_welcome_photo_')) {
            const isMain = data.startsWith('set_banner_');
            const botId = isMain ? data.replace('set_banner_', '') : data.replace('set_welcome_photo_', '');
            adminUserState.set(ctx.from.id, { action: isMain ? 'awaiting_banner' : 'awaiting_welcome_photo', data: { botId } });
            await safeEdit(ctx, `🖼️ *Set ${isMain ? 'Main' : 'Welcome'} Image*\n\nPaste an image URL below 👇`, new InlineKeyboard().text("🔙 Cancel", `edit_images_${botId}`));
            return ctx.answerCallbackQuery();
        }

        if (data.startsWith('bot_settings_')) {
            const botId = data.replace('bot_settings_', '');
            const instance = await BotInstance.findById(botId);
            adminUserState.set(ctx.from.id, { action: 'bot_settings_menu', data: { botId } });
            const keyboard = new InlineKeyboard()
                .text("📝 Edit Name", `edit_name_${botId}`).row()
                .text("🔔 Edit Alert Chat", `edit_alert_${botId}`).row()
                .text("💬 Edit Welcome Msg", `edit_welcome_${botId}`).row()
                .text("🔙 Back", `manage_bot_${botId}`);
            await safeEdit(ctx,
                `⚙️ *Bot Settings: @${escapeMarkdown(instance.botUsername)}*\n\nName: ${escapeMarkdown(instance.businessName)}\nAlert: ${instance.adminAlertChatId || 'Not set'}`,
                keyboard
            );
            return ctx.answerCallbackQuery();
        }

        if (data.startsWith('edit_name_')) {
            const botId = data.replace('edit_name_', '');
            adminUserState.set(ctx.from.id, { action: 'awaiting_bot_name', data: { botId } });
            await ctx.reply("📝 Enter new bot display name:");
            return ctx.answerCallbackQuery();
        }
        if (data.startsWith('edit_alert_')) {
            const botId = data.replace('edit_alert_', '');
            adminUserState.set(ctx.from.id, { action: 'awaiting_alert_id', data: { botId } });
            await ctx.reply("🔔 Enter your alert chat ID:");
            return ctx.answerCallbackQuery();
        }
        if (data.startsWith('edit_welcome_')) {
            const botId = data.replace('edit_welcome_', '');
            adminUserState.set(ctx.from.id, { action: 'awaiting_welcome_msg', data: { botId } });
            await ctx.reply("💬 Enter new welcome message:");
            return ctx.answerCallbackQuery();
        }

        if (data.startsWith('toggle_bot_')) {
            const botId = data.replace('toggle_bot_', '');
            const instance = await BotInstance.findById(botId);
            instance.status = instance.status === 'active' ? 'suspended' : 'active';
            await instance.save();
            if (instance.status === 'active') {
                const bot = activeBots.get(botId);
                if (bot) {
                    try { await setWebhookWithRetry(bot, `${APP_URL}/webhook/${botId}`); } catch (e) { console.log('Webhook retry failed:', e.message); }
                }
            }
            await ctx.answerCallbackQuery(instance.status === 'active' ? "🟢 Bot Activated" : "🔴 Bot Suspended");
            const statusText = instance.status === 'active' ? '🟢 Active' : '🔴 Suspended';
            const totalOrders = await Order.countDocuments({ botId: instance._id });
            const days = instance.expiresAt ? daysLeft(instance.expiresAt) : 0;
            await safeEdit(ctx, `🤖 *@${escapeMarkdown(instance.botUsername)}*\nStatus: *${statusText}*\n⏳ Expires: *${days} days*\n📦 Orders: *${totalOrders}*`, getBotManagementMenu(botId));
            return;
        }

        if (data.startsWith('bot_stats_')) {
            const botId = data.replace('bot_stats_', '');
            const instance = await BotInstance.findById(botId);
            const totalOrders = await Order.countDocuments({ botId: instance._id });
            const completedOrders = await Order.countDocuments({ botId: instance._id, status: 'Completed' });
            const revenue = await Transaction.aggregate([{ $match: { botId: instance._id, status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
            const days = instance.expiresAt ? daysLeft(instance.expiresAt) : 0;
            await safeEdit(ctx,
                `📊 *Bot Stats: @${escapeMarkdown(instance.botUsername)}*\n\n📦 Total Orders: *${totalOrders}*\n✅ Completed: *${completedOrders}*\n💰 Revenue: *KES ${revenue[0]?.total || 0}*\n⏳ Expires: *${days} days*`,
                new InlineKeyboard().text("🔙 Back", `manage_bot_${botId}`)
            );
            return ctx.answerCallbackQuery();
        }

        ctx.answerCallbackQuery("Coming soon!");

    } catch (err) {
        console.error('Admin callback error:', err);
        ctx.answerCallbackQuery("❌ Error occurred").catch(() => {});
    }
});

// --- Text Input Handler for Admin Bot ---
adminBot.on('message:text', async (ctx) => {
    const state = adminUserState.get(ctx.from.id);
    if (!state) return;
    const text = ctx.message.text.trim();
    const merchant = await getOrCreateMerchant(ctx);

    try {
        if (state.action === 'sa_broadcast_msg') {
            const merchants = await Merchant.find();
            let sent = 0, failed = 0;
            for (const m of merchants) {
                try { await adminBot.api.sendMessage(m.telegramId, `📢 *Admin Update*\n\n${escapeMarkdown(text)}`, { parse_mode: "Markdown" }); sent++; }
                catch (e) { failed++; }
            }
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Broadcast sent to ${sent} merchants (${failed} failed).`);
            return;
        }

        if (state.action === 'awaiting_sub_phone') {
            let phone = text.replace(/\D/g, '');
            if (phone.startsWith('0')) phone = '254' + phone.slice(1);
            else if (!phone.startsWith('254')) phone = '254' + phone;
            if (phone.length !== 12) { await ctx.reply("❌ Invalid phone. Use format: 07XXXXXXXX"); return; }
            const pkg = state.data.package;
            const botId = state.data.botId;
            const reference = 'SUB' + Date.now();
            const amount = pkg.price;

            await PendingTransaction.create({ reference, type: 'credit', phone, amount, merchantTelegramId: ctx.from.id, packageId: pkg._id, credits: pkg.credits, botId });
            const payload = { api_key: process.env.MEGAPAY_API_KEY, email: process.env.MEGAPAY_EMAIL, amount, msisdn: phone, callback_url: `${APP_URL}/api/megapay/webhook`, description: `Bot Subscription: ${pkg.name}`, reference };
            console.log(`[STK-INIT] Subscription ref=${reference} phone=${phone} amount=${amount}`);
            const stkRes = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
            console.log(`[STK-RESPONSE] Subscription ref=${reference}:`, JSON.stringify(stkRes.data));
            const respCode = stkRes.data?.ResponseCode ?? stkRes.data?.ResultCode ?? 1;
            if (parseInt(respCode) !== 0) {
                const desc = stkRes.data?.ResponseDescription ?? stkRes.data?.ResultDesc ?? 'Unknown error';
                await PendingTransaction.updateOne({ reference }, { status: 'failed' });
                await ctx.reply(`❌ *Payment Failed*\n\nMegapay: ${escapeMarkdown(desc)}`, { parse_mode: "Markdown" });
                adminUserState.delete(ctx.from.id);
                return;
            }
            await PendingTransaction.updateOne({ reference }, { megapayTransactionId: stkRes.data?.transaction_request_id || '', megapayMerchantRequestId: stkRes.data?.MerchantRequestID || '', megapayCheckoutRequestId: stkRes.data?.CheckoutRequestID || '' });
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`⏳ *Payment Initiated*\n\nPackage: ${escapeMarkdown(pkg.name)}\nDuration: ${pkg.credits} days\nAmount: KES ${amount}\n\nCheck your phone for STK push and enter PIN.`, { parse_mode: "Markdown" });
            return;
        }

        if (state.action === 'awaiting_bot_token') {
            const token = text;
            let botInfo;
            try { const testBot = new Bot(token); botInfo = await testBot.api.getMe(); }
            catch (e) { await ctx.reply("❌ Invalid bot token. Please get a valid token from @BotFather and try again."); return; }

            const instance = await BotInstance.create({
                merchantId: merchant._id,
                botToken: token,
                botUsername: botInfo.username,
                botId: botInfo.id,
                status: 'active',
                businessName: botInfo.first_name,
                welcomeMessage: `Welcome to ${escapeMarkdown(botInfo.first_name)}! Boost your social media presence. Choose a service below.`,
                adminAlertChatId: String(ctx.from.id),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            });
            await loadMerchantBot(instance);
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ *Bot Created Successfully!*\n\n🤖 @${escapeMarkdown(botInfo.username)}\n⚡ Status: Active (1 day free)\n\n👉 Now tap "🤖 My Bots" to customize!`, { parse_mode: "Markdown", reply_markup: getAdminMenu() });
            return;
        }

        if (state.action === 'awaiting_megapay_key') {
            const { botId } = state.data;
            await BotInstance.findByIdAndUpdate(botId, { megapayApiKey: text });
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Megapay API Key updated!`, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Back", `payment_settings_${botId}`) });
            return;
        }
        if (state.action === 'awaiting_megapay_email') {
            const { botId } = state.data;
            await BotInstance.findByIdAndUpdate(botId, { megapayEmail: text });
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Megapay Email updated!`, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Back", `payment_settings_${botId}`) });
            return;
        }
        if (state.action === 'awaiting_webhook_url') {
            const { botId } = state.data;
            const webhookUrl = text.toLowerCase() === 'default' ? '' : text;
            await BotInstance.findByIdAndUpdate(botId, { megapayWebhookUrl: webhookUrl });
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Webhook URL updated!`, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Back", `payment_settings_${botId}`) });
            return;
        }
        if (state.action === 'awaiting_bot_name') {
            const { botId } = state.data;
            await BotInstance.findByIdAndUpdate(botId, { businessName: text });
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Bot name updated to *${escapeMarkdown(text)}*!`, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Back", `bot_settings_${botId}`) });
            return;
        }
        if (state.action === 'awaiting_alert_id') {
            const { botId } = state.data;
            await BotInstance.findByIdAndUpdate(botId, { adminAlertChatId: text });
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Alert Chat ID updated!`, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Back", `bot_settings_${botId}`) });
            return;
        }
        if (state.action === 'awaiting_welcome_msg') {
            const { botId } = state.data;
            await BotInstance.findByIdAndUpdate(botId, { welcomeMessage: text });
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Welcome message updated!`, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Back", `bot_settings_${botId}`) });
            return;
        }
        if (state.action === 'awaiting_banner') {
            const { botId } = state.data;
            await BotInstance.findByIdAndUpdate(botId, { bannerImage: text });
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Main banner updated!`, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Back", `edit_images_${botId}`) });
            return;
        }
        if (state.action === 'awaiting_welcome_photo') {
            const { botId } = state.data;
            await BotInstance.findByIdAndUpdate(botId, { welcomePhoto: text });
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Welcome photo updated!`, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Back", `edit_images_${botId}`) });
            return;
        }

    } catch (err) {
        console.error('Admin text handler error:', err);
        await ctx.reply("❌ An error occurred. Please try again.");
    }
});

// ==========================================
// MERCHANT BOT ENGINE
// ==========================================
async function loadMerchantBot(instance) {
    const botId = instance._id.toString();
    try {
        const bot = new Bot(instance.botToken);
        try { await bot.init(); } catch (initErr) { console.log(`⚠️ Bot @${instance.botUsername} init warning: ${initErr.message}. Continuing...`); }
        setupMerchantBotHandlers(bot, botId);
        activeBots.set(botId, bot);
        if (APP_URL.startsWith('https://')) {
            try {
                const webhookUrl = `${APP_URL}/webhook/${botId}`;
                await setWebhookWithRetry(bot, webhookUrl);
                console.log(`🤖 Merchant bot loaded: @${instance.botUsername} → ${webhookUrl}`);
            } catch (webhookErr) { console.log(`⚠️ Bot @${instance.botUsername} loaded but webhook setup failed: ${webhookErr.message}`); }
        } else { console.log(`⚠️ Merchant bot @${instance.botUsername} loaded but NO WEBHOOK (HTTP mode)`); }
        return bot;
    } catch (err) { console.error(`Failed to load bot ${instance.botUsername}:`, err.message); return null; }
}

function setupMerchantBotHandlers(bot, botId) {
    bot.catch((err) => { console.error(`[Bot ${botId}] Error:`, err.message); });

    bot.command('start', async (ctx) => {
        try {
            const instance = await BotInstance.findById(botId);
            if (!instance || instance.status !== 'active') return ctx.reply("⛔ This bot is currently suspended. Please contact the owner.");

            const enabled = instance.enabledServices?.filter(s => s.isEnabled) || [];
            if (enabled.length === 0) {
                const keyboard = new InlineKeyboard();
                if (instance.supportLink) keyboard.row({ text: '💬 Support', url: instance.supportLink });
                return ctx.reply("⏳ This store has no active services yet. Please check back later.", { reply_markup: keyboard });
            }

            const services = await Service.find({ serviceId: { $in: enabled.map(s => s.serviceId) } });
            const categories = [...new Set(services.map(s => s.category))];
            const keyboard = new InlineKeyboard();
            categories.forEach(cat => {
                keyboard.text(`📂 ${escapeMarkdown(cat)}`, `cat_${cat}`).row();
            });
            if (instance.supportLink) keyboard.row({ text: '💬 Support', url: instance.supportLink });

            const welcomeText = instance.welcomeMessage;
            if (instance.welcomePhoto) {
                await ctx.replyWithPhoto(instance.welcomePhoto, { caption: welcomeText, reply_markup: keyboard });
            } else if (instance.bannerImage) {
                await ctx.replyWithPhoto(instance.bannerImage, { caption: welcomeText, reply_markup: keyboard });
            } else {
                await ctx.reply(welcomeText, { reply_markup: keyboard });
            }
        } catch (err) { console.error(`[Bot ${botId}] /start error:`, err.message); }
    });

    bot.command('status', async (ctx) => {
        try {
            const args = ctx.message.text.split(' ');
            const smmOrderId = args[1];
            if (!smmOrderId) return ctx.reply("❌ Usage: /status <order_id>");
            const order = await Order.findOne({ botId, smmOrderId, customerTelegramId: ctx.from.id });
            if (!order) return ctx.reply("❌ Order not found.");
            await ctx.reply(`📋 *Order #${order.smmOrderId}*\nService: ${escapeMarkdown(order.serviceName)}\nStatus: *${order.status}*\nQty: ${order.quantity}\nLink: ${escapeMarkdown(order.link)}\nPrice: KES ${order.price}`, { parse_mode: "Markdown" });
        } catch (err) { console.error(`[Bot ${botId}] status error:`, err.message); }
    });

    bot.command('refill', async (ctx) => {
        try {
            const args = ctx.message.text.split(' ');
            const smmOrderId = args[1];
            if (!smmOrderId) return ctx.reply("❌ Usage: /refill <order_id>");
            const order = await Order.findOne({ botId, smmOrderId, customerTelegramId: ctx.from.id });
            if (!order) return ctx.reply("❌ Order not found.");
            if (!order.refillEligible) return ctx.reply("❌ This order is not eligible for refill.");
            if (order.refillRequested) return ctx.reply("⏳ Refill already requested.");
            const daysSince = (new Date() - order.createdAt) / (1000 * 60 * 60 * 24);
            if (daysSince > 30) return ctx.reply("❌ Refill period (30 days) has expired.");
            
            await ctx.reply("⏳ Requesting refill...");
            try {
                const res = await axios.post(SMM_API_URL, { key: SMM_API_KEY, action: 'refill', order: order.smmOrderId });
                order.refillRequested = true;
                order.refillStatus = res.data?.status || 'Requested';
                await order.save();
                await ctx.reply(`✅ *Refill Requested*\n\nOrder: #${order.smmOrderId}\nStatus: ${order.refillStatus}\n\nYou will be notified once processed.`, { parse_mode: "Markdown" });
            } catch (e) {
                await ctx.reply(`❌ Refill request failed: ${escapeMarkdown(e.message)}`, { parse_mode: "Markdown" });
            }
        } catch (err) { console.error(`[Bot ${botId}] refill error:`, err.message); }
    });

    bot.command('admin', async (ctx) => {
        try {
            const instance = await BotInstance.findById(botId);
            if (!instance) return ctx.reply("⛔ Bot not found.");
            const isOwner = String(ctx.from.id) === String(instance.adminAlertChatId);
            const isSuperAdmin = ADMIN_IDS.includes(ctx.from.id);
            if (!isOwner && !isSuperAdmin) return ctx.reply("⛔ You are not authorized to use this command.");

            const totalOrders = await Order.countDocuments({ botId: instance._id });
            const completedOrders = await Order.countDocuments({ botId: instance._id, status: 'Completed' });
            const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
            const todayStart = new Date(); todayStart.setHours(0,0,0,0);
            const revenue24h = await Transaction.aggregate([{ $match: { botId: instance._id, status: 'completed', createdAt: { $gte: yesterday } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
            const revenueToday = await Transaction.aggregate([{ $match: { botId: instance._id, status: 'completed', createdAt: { $gte: todayStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
            const totalRevenue = await Transaction.aggregate([{ $match: { botId: instance._id, status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
            const days = instance.expiresAt ? daysLeft(instance.expiresAt) : 0;

            const keyboard = new InlineKeyboard()
                .text("📢 Broadcast Promo", `m_broadcast_${botId}`).row()
                .text("📊 24hr Sales Report", `m_report_${botId}`).row()
                .text("📋 View Orders", `m_view_orders_${botId}`).row();

            const text = `📋 *Admin Panel — @${escapeMarkdown(instance.botUsername)}*\n\n` +
                `*Stats Breakdown*\n📦 Orders: *${totalOrders}*\n✅ Completed: *${completedOrders}*\n` +
                `💰 Today: *KES ${revenueToday[0]?.total || 0}*\n💰 24h: *KES ${revenue24h[0]?.total || 0}*\n` +
                `💰 Total: *KES ${totalRevenue[0]?.total || 0}*\n⏳ Bot Expires: *${days} days*\n\nTap below to manage:`;
            await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
        } catch (err) { console.error(`[Bot ${botId}] /admin error:`, err.message); ctx.reply("❌ Error loading admin panel.").catch(()=>{}); }
    });

    bot.callbackQuery(/^m_broadcast_/, async (ctx) => {
        ctx.answerCallbackQuery().catch(()=>{});
        const id = ctx.callbackQuery.data.replace('m_broadcast_', '');
        merchantPendingInputs.set(`${botId}_${ctx.from.id}`, { action: 'awaiting_broadcast', data: { botId: id } });
        await ctx.reply("📢 *Broadcast Promo*\n\nType your promo message to send to ALL customers:", { parse_mode: "Markdown" });
    });

    bot.callbackQuery(/^m_report_/, async (ctx) => {
        ctx.answerCallbackQuery().catch(()=>{});
        try {
            const instance = await BotInstance.findById(botId);
            const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
            const txns = await Transaction.find({ botId: instance._id, status: 'completed', createdAt: { $gte: yesterday } }).sort({ createdAt: -1 });
            const revenue = txns.reduce((sum, t) => sum + t.amount, 0);
            let text = `📊 *24hr Sales Report — @${escapeMarkdown(instance.botUsername)}*\n\n🧾 Transactions: *${txns.length}*\n💰 Revenue: *KES ${revenue}*\n\n`;
            if (txns.length === 0) text += `_No sales in the last 24 hours._`;
            else { txns.slice(0, 10).forEach(t => { text += `• ${escapeMarkdown(t.serviceName)} — KES ${t.amount} — @${escapeMarkdown(t.customerUsername || t.customerTelegramId)}\n`; }); }
            await ctx.reply(text, { parse_mode: "Markdown" });
        } catch (err) { console.error(`[Bot ${botId}] report error:`, err.message); }
    });

    bot.callbackQuery(/^m_view_orders_/, async (ctx) => {
        ctx.answerCallbackQuery().catch(()=>{});
        try {
            const orders = await Order.find({ botId }).sort({ createdAt: -1 }).limit(15);
            if (orders.length === 0) return ctx.reply("📋 *Orders*\n\nNo orders yet.", { parse_mode: "Markdown" });
            let text = `📋 *Recent Orders (${orders.length})*\n\n`;
            orders.forEach(o => {
                text += `• #${o.smmOrderId || 'N/A'} — ${escapeMarkdown(o.serviceName)} — ${o.status} — KES ${o.price}\n`;
            });
            await ctx.reply(text, { parse_mode: "Markdown" });
        } catch (err) { console.error(`[Bot ${botId}] view orders error:`, err.message); }
    });

    bot.on('message:text', async (ctx) => {
        const key = `${botId}_${ctx.from.id}`;
        const pending = merchantPendingInputs.get(key);
        if (!pending) return;

        if (pending.action === 'awaiting_broadcast') {
            const instance = await BotInstance.findById(botId);
            const orders = await Order.find({ botId });
            const uniqueCustomers = [...new Set(orders.map(o => o.customerTelegramId))];
            let sent = 0, failed = 0;
            for (const cid of uniqueCustomers) {
                try {
                    await bot.api.sendMessage(cid, `📢 *PROMO*\n\n${escapeMarkdown(ctx.message.text)}`, { parse_mode: "Markdown" });
                    sent++; await new Promise(r => setTimeout(r, 50));
                } catch (e) { failed++; }
            }
            merchantPendingInputs.delete(key);
            await ctx.reply(`✅ Promo sent to ${sent} users (${failed} failed).`);
            return;
        }

        const instance = await BotInstance.findById(botId);
        if (!instance) return;

        if (pending.action === 'awaiting_link') {
            pending.data.link = ctx.message.text.trim();
            pending.action = 'awaiting_quantity';
            const svc = await Service.findOne({ serviceId: pending.data.serviceId });
            await ctx.reply(`🔗 Link received.\n\nEnter quantity (min: ${svc.min}, max: ${svc.max}):`);
            return;
        }

        if (pending.action === 'awaiting_quantity') {
            const qty = parseInt(ctx.message.text.trim());
            const svc = await Service.findOne({ serviceId: pending.data.serviceId });
            if (isNaN(qty) || qty < parseInt(svc.min) || qty > parseInt(svc.max)) {
                await ctx.reply(`❌ Invalid quantity. Must be between ${svc.min} and ${svc.max}.`);
                return;
            }
            const cfg = instance.enabledServices.find(s => s.serviceId === pending.data.serviceId);
            const pricePer1k = cfg?.customPrice || 0;
            if (pricePer1k <= 0) {
                await ctx.reply("❌ This service is not priced yet. Contact the store owner.");
                merchantPendingInputs.delete(key);
                return;
            }
            const price = Math.ceil((pricePer1k * qty) / 1000);
            pending.data.quantity = qty;
            pending.data.price = price;
            pending.data.serviceName = svc.name;
            pending.action = 'awaiting_payment_phone';
            await ctx.reply(`💰 *Order Summary*\n\nService: ${escapeMarkdown(svc.name)}\nLink: ${escapeMarkdown(pending.data.link)}\nQuantity: ${qty}\nPrice: *KES ${price}*\n\nEnter your M-Pesa number:\nFormat: 07XXXXXXXX or 01XXXXXXXX`, { parse_mode: "Markdown" });
            return;
        }

        if (pending.action === 'awaiting_payment_phone') {
            let phone = ctx.message.text.trim().replace(/\D/g, '');
            if (phone.startsWith('0')) phone = '254' + phone.slice(1);
            else if (!phone.startsWith('254')) phone = '254' + phone;
            if (phone.length !== 12) { await ctx.reply("❌ Invalid phone. Use format: 07XXXXXXXX"); return; }

            const { serviceId, serviceName, link, quantity, price } = pending.data;
            const reference = `ORD${botId.slice(-6)}${Date.now()}`;

            if (!instance.megapayApiKey || !instance.megapayEmail) {
                await ctx.reply("⚠️ Payment not configured by store owner. Please contact support.");
                merchantPendingInputs.delete(key);
                return;
            }

            try {
                await PendingTransaction.create({
                    reference, type: 'order', phone, amount: price, botId,
                    customerTelegramId: ctx.from.id, customerChatId: ctx.chat.id,
                    serviceId, serviceName, link, quantity
                });

                const payload = {
                    api_key: instance.megapayApiKey,
                    email: instance.megapayEmail,
                    amount: price,
                    msisdn: phone,
                    callback_url: instance.megapayWebhookUrl || `${APP_URL}/api/megapay/webhook`,
                    description: `${instance.businessName} — ${serviceName} (${quantity})`,
                    reference
                };

                console.log(`[STK-INIT] Order ref=${reference} bot=${instance.botUsername} phone=${phone} amount=${price}`);
                const stkRes = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
                console.log(`[STK-RESPONSE] Order ref=${reference}:`, JSON.stringify(stkRes.data));

                const respCode = stkRes.data?.ResponseCode ?? stkRes.data?.ResultCode ?? 1;
                if (parseInt(respCode) !== 0) {
                    const desc = stkRes.data?.ResponseDescription ?? stkRes.data?.ResultDesc ?? 'Unknown error';
                    await PendingTransaction.updateOne({ reference }, { status: 'failed' });
                    await ctx.reply(`❌ *Payment Failed*\n\nMegapay: ${escapeMarkdown(desc)}`, { parse_mode: "Markdown" });
                    merchantPendingInputs.delete(key);
                    return;
                }

                await PendingTransaction.updateOne({ reference }, {
                    megapayTransactionId: stkRes.data?.transaction_request_id || '',
                    megapayMerchantRequestId: stkRes.data?.MerchantRequestID || '',
                    megapayCheckoutRequestId: stkRes.data?.CheckoutRequestID || ''
                });

                merchantPendingInputs.delete(key);
                await ctx.reply(
                    `📲 *Check your phone!*\nM-Pesa prompt has been sent.\nEnter your PIN to complete payment.\n\nYour order will be placed automatically once confirmed.`,
                    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text('❌ Cancel', 'back_start') }
                );
            } catch (err) {
                console.error('STK Error:', err.message);
                await ctx.reply("❌ Failed to initiate payment. Please try again later.");
            }
        }
    });

    bot.callbackQuery(/^cat_/, async (ctx) => {
        ctx.answerCallbackQuery().catch(()=>{});
        try {
            const instance = await BotInstance.findById(botId);
            if (!instance || instance.status !== 'active') return ctx.reply("⛔ Bot suspended");
            const category = ctx.callbackQuery.data.replace('cat_', '');
            const enabled = instance.enabledServices?.filter(s => s.isEnabled) || [];
            const services = await Service.find({ serviceId: { $in: enabled.map(s => s.serviceId) }, category });
            if (services.length === 0) return ctx.reply("❌ No services in this category.");

            const keyboard = new InlineKeyboard();
            services.forEach(s => {
                const cfg = enabled.find(e => e.serviceId === s.serviceId);
                const price = cfg?.customPrice || 0;
                keyboard.text(`${escapeMarkdown(s.name)} — KES ${price}/1k`, `svc_${s.serviceId}`).row();
            });
            keyboard.text('🔙 Back', 'back_start');

            await ctx.reply(`📂 *${escapeMarkdown(category)}*\n\nSelect a service:`, { parse_mode: "Markdown", reply_markup: keyboard });
        } catch (err) { console.error(`[Bot ${botId}] cat callback error:`, err.message); }
    });

    bot.callbackQuery(/^svc_/, async (ctx) => {
        ctx.answerCallbackQuery().catch(()=>{});
        try {
            const instance = await BotInstance.findById(botId);
            if (!instance || instance.status !== 'active') return ctx.reply("⛔ Bot suspended");
            const serviceId = parseInt(ctx.callbackQuery.data.replace('svc_', ''));
            const svc = await Service.findOne({ serviceId });
            if (!svc) return ctx.reply("❌ Service not found.");

            merchantPendingInputs.set(`${botId}_${ctx.from.id}`, { action: 'awaiting_link', data: { serviceId } });
            let text = `🛒 *${escapeMarkdown(svc.name)}*\n\nCategory: ${escapeMarkdown(svc.category)}\nType: ${escapeMarkdown(svc.type)}\nMin: ${svc.min} | Max: ${svc.max}\nRefill: ${svc.refill ? '✅ Yes' : '❌ No'}\n\nSend the link or username to promote:`;
            await ctx.reply(text, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text('🔙 Back', 'back_start') });
        } catch (err) { console.error(`[Bot ${botId}] svc callback error:`, err.message); }
    });

    bot.callbackQuery('back_start', async (ctx) => {
        ctx.answerCallbackQuery().catch(()=>{});
        try {
            const instance = await BotInstance.findById(botId);
            const enabled = instance.enabledServices?.filter(s => s.isEnabled) || [];
            const services = await Service.find({ serviceId: { $in: enabled.map(s => s.serviceId) } });
            const categories = [...new Set(services.map(s => s.category))];
            const keyboard = new InlineKeyboard();
            categories.forEach(cat => { keyboard.text(`📂 ${escapeMarkdown(cat)}`, `cat_${cat}`).row(); });
            if (instance.supportLink) keyboard.row({ text: '💬 Support', url: instance.supportLink });
            try { await ctx.editMessageText(instance.welcomeMessage, { reply_markup: keyboard }); }
            catch (e) { await ctx.reply(instance.welcomeMessage, { reply_markup: keyboard }); }
        } catch (err) { console.error(`[Bot ${botId}] back_start error:`, err.message); }
    });
}

// ==========================================
// WEBHOOK ENDPOINTS
// ==========================================
app.post('/webhook/admin', async (req, res) => {
    await adminBot.handleUpdate(req.body);
    res.status(200).send('OK');
});

app.post('/webhook/:botId', async (req, res) => {
    const botId = req.params.botId;
    let bot = activeBots.get(botId);
    if (!bot) {
        console.log(`[WEBHOOK] Bot ${botId} not in memory. Attempting on-demand load...`);
        try {
            const instance = await BotInstance.findById(botId);
            if (instance && instance.status === 'active') {
                bot = await loadMerchantBot(instance);
                if (!bot) bot = activeBots.get(botId);
                if (!bot) return res.status(500).send('Bot load error');
            } else { return res.status(404).send('Bot not found or inactive'); }
        } catch (err) { console.error(`[WEBHOOK] On-demand load failed for ${botId}:`, err.message); return res.status(500).send('Bot load error'); }
    }
    try { await bot.handleUpdate(req.body); res.status(200).send('OK'); }
    catch (err) { console.error(`[WEBHOOK] Error handling update for bot ${botId}:`, err.message); res.status(500).send('Error'); }
});

// ==========================================
// MEGAPAY WEBHOOK
// ==========================================
async function handleMegapayWebhook(req, res) {
    res.status(200).send("OK");
    const raw = req.rawBody || JSON.stringify(req.body);
    console.log(`[WEBHOOK-RAW] ${raw}`);
    const data = req.body;
    if (!data || Object.keys(data).length === 0) { console.error('[WEBHOOK] Empty body after parsing'); return; }

    const p = normalizeMegapayPayload(data);
    console.log(`[WEBHOOK] Normalized: format=${p._format}, code=${p.responseCode}, ref=${p.reference}, receipt=${p.receipt}, amount=${p.amount}, phone=${p.phone}`);

    try {
        if (parseInt(p.responseCode) !== 0) { console.log(`[WEBHOOK] Payment failed: ${p.responseCode} ${p.resultDesc}`); return; }

        const amount = parseFloat(p.amount || 0);
        const receipt = p.receipt || 'N/A';
        const rawPhone = (p.phone || "").toString();
        let tx = null;

        if (p.reference) { tx = await PendingTransaction.findOne({ reference: p.reference, status: 'pending' }); console.log(`[WEBHOOK] Lookup by ref '${p.reference}': ${tx ? 'FOUND' : 'NOT FOUND'}`); }
        if (!tx && rawPhone) {
            const last9 = rawPhone.replace(/\D/g, '').slice(-9);
            if (last9.length >= 9) { tx = await PendingTransaction.findOne({ phone: { $regex: last9 + '$' }, status: 'pending' }).sort({ createdAt: -1 }); console.log(`[WEBHOOK] Fallback phone lookup: ${tx ? 'FOUND' : 'NOT FOUND'}`); }
        }
        if (!tx && p.merchantRequestId) tx = await PendingTransaction.findOne({ megapayMerchantRequestId: p.merchantRequestId, status: 'pending' });
        if (!tx && p.checkoutRequestId) tx = await PendingTransaction.findOne({ megapayCheckoutRequestId: p.checkoutRequestId, status: 'pending' });
        if (!tx && p.transactionRequestId) tx = await PendingTransaction.findOne({ megapayTransactionId: p.transactionRequestId, status: 'pending' });
        if (!tx) { console.log(`[WEBHOOK] No pending transaction matched. Exiting.`); return; }

        console.log(`[WEBHOOK] Matched: type=${tx.type}, ref=${tx.reference}, botId=${tx.botId}`);

        if (tx.type === 'credit') {
            const bot = await BotInstance.findById(tx.botId);
            if (!bot) { console.log(`[WEBHOOK] Subscription: Bot ${tx.botId} not found`); return; }
            const now = new Date();
            const currentExpiry = bot.expiresAt && bot.expiresAt > now ? bot.expiresAt : now;
            const newExpiry = new Date(currentExpiry);
            newExpiry.setDate(newExpiry.getDate() + tx.credits);
            bot.expiresAt = newExpiry;
            bot.status = 'active';
            await bot.save();
            if (!activeBots.get(tx.botId.toString())) await loadMerchantBot(bot);

            await CreditTransaction.create({
                merchantTelegramId: tx.merchantTelegramId, packageId: tx.packageId,
                amountKes: amount, credits: tx.credits, status: 'completed',
                mpesaReceipt: receipt, phone: tx.phone, reference: tx.reference, botId: tx.botId
            });

            await adminBot.api.sendMessage(tx.merchantTelegramId,
                `🎉 *Bot Subscribed!*\n\n🤖 Bot: @${escapeMarkdown(bot.botUsername)}\n📅 Duration: *${tx.credits} days*\n💰 Amount: KES ${amount}\n🧾 Receipt: ${receipt}\n⏳ Expires: *${newExpiry.toLocaleDateString()}*`,
                { parse_mode: "Markdown", reply_markup: getAdminMenu() }
            );
            console.log(`✅ Subscribed bot ${bot.botUsername} for ${tx.credits} days`);

        } else if (tx.type === 'order') {
            console.log(`[WEBHOOK] Starting order fulfillment for bot ${tx.botId}`);
            const instance = await BotInstance.findById(tx.botId);
            if (!instance) { console.log(`[WEBHOOK] Order: BotInstance ${tx.botId} not found`); return; }

            // Place order to smmfollows
            let smmOrderId = null;
            try {
                const smmRes = await axios.post(SMM_API_URL, {
                    key: SMM_API_KEY,
                    action: 'add',
                    service: tx.serviceId,
                    link: tx.link,
                    quantity: tx.quantity
                });
                if (smmRes.data && smmRes.data.order) {
                    smmOrderId = String(smmRes.data.order);
                    console.log(`[WEBHOOK] SMM order placed: ${smmOrderId}`);
                } else {
                    console.error(`[WEBHOOK] SMM add failed:`, smmRes.data);
                }
            } catch (smmErr) {
                console.error(`[WEBHOOK] SMM API error:`, smmErr.message);
            }

            const svc = await Service.findOne({ serviceId: tx.serviceId });
            const order = await Order.create({
                merchantId: instance.merchantId,
                botId: tx.botId,
                customerTelegramId: tx.customerTelegramId,
                customerChatId: tx.customerChatId,
                serviceId: tx.serviceId,
                serviceName: tx.serviceName || svc?.name || 'Unknown',
                link: tx.link,
                quantity: tx.quantity,
                price: amount,
                smmOrderId: smmOrderId || 'PENDING',
                status: smmOrderId ? 'processing' : 'pending',
                refillEligible: svc?.refill || false
            });

            await Transaction.create({
                merchantId: instance.merchantId,
                botId: instance._id,
                serviceId: tx.serviceId,
                serviceName: tx.serviceName || svc?.name,
                customerTelegramId: tx.customerTelegramId,
                customerUsername: '',
                phone: tx.phone,
                amount,
                mpesaReceipt: receipt,
                status: 'completed'
            });

            const botIdStr = tx.botId.toString();
            let merchantBot = activeBots.get(botIdStr);
            if (!merchantBot) merchantBot = await loadMerchantBot(instance);

            if (merchantBot) {
                let successText = `🎉 *PAYMENT SUCCESSFUL!*\n\nThank you for your order!\n\n💰 *DETAILS*\n• Service: ${escapeMarkdown(order.serviceName)}\n• Quantity: ${order.quantity}\n• Link: ${escapeMarkdown(order.link)}\n• Amount: KES ${amount}\n• Receipt: ${receipt}\n• Order ID: \`${order.smmOrderId}\``;
                if (smmOrderId) {
                    successText += `\n\n⏳ Your order is now *processing*.\nUse /status ${order.smmOrderId} to check updates.`;
                    if (order.refillEligible) successText += `\n\n🔄 *Refill available* for 30 days. Use /refill ${order.smmOrderId} if drops occur.`;
                } else {
                    successText += `\n\n⚠️ *Auto-placement failed.* Admin will fulfill manually.`;
                }

                try {
                    await merchantBot.api.sendMessage(tx.customerTelegramId, successText, {
                        parse_mode: "Markdown",
                        protect_content: true,
                        reply_markup: new InlineKeyboard()
                            .text(`📋 Check Status`, `status_${order.smmOrderId}`).row()
                            .text(`🔙 Main Menu`, 'back_start')
                    });
                } catch (sendErr) { console.error(`[WEBHOOK] Failed to send fulfillment:`, sendErr.message); }

                if (instance.adminAlertChatId) {
                    try {
                        await merchantBot.api.sendMessage(instance.adminAlertChatId,
                            `✅ *New Sale!*\n\n📦 Service: ${escapeMarkdown(order.serviceName)}\n🔗 Link: ${escapeMarkdown(order.link)}\n📊 Qty: ${order.quantity}\n💵 Amount: KES ${amount}\n🧾 Receipt: ${receipt}\n📱 Phone: ${tx.phone}\n👤 Customer: ${tx.customerTelegramId}`,
                            { parse_mode: "Markdown" }
                        );
                    } catch (e) { console.log('[WEBHOOK] Merchant alert failed:', e.message); }
                }
            } else { console.error(`[WEBHOOK] CRITICAL: Could not load bot ${botIdStr} for fulfillment.`); }

            if (ADMIN_CHANNEL_ID) {
                try { await adminBot.api.sendMessage(ADMIN_CHANNEL_ID, `💰 Platform Sale\nBot: @${escapeMarkdown(instance.botUsername)}\nAmount: KES ${amount}\nReceipt: ${receipt}`, { parse_mode: "Markdown" }); } catch (e) {}
            }
            for (const adminId of ADMIN_IDS) {
                try {
                    await adminBot.api.sendMessage(adminId,
                        `💰 *Platform Sale Alert*\n\n🤖 Bot: @${escapeMarkdown(instance.botUsername)}\n👤 Merchant: ${escapeMarkdown(instance.businessName)}\n📦 Service: ${escapeMarkdown(order.serviceName)}\n💵 Amount: KES ${amount}\n🧾 Receipt: ${receipt}`,
                        { parse_mode: "Markdown" }
                    );
                } catch (e) { console.log(`[WEBHOOK] Admin notify failed for ${adminId}:`, e.message); }
            }
            console.log(`✅ Order sale complete: ${order.serviceName} for KES ${amount}`);
        }

        tx.status = 'completed';
        await tx.save();

    } catch (err) {
        console.error("[WEBHOOK] Fatal Error:", err.message);
        console.error("[WEBHOOK] Stack:", err.stack);
    }
}

app.post('/api/megapay/webhook', handleMegapayWebhook);
app.put('/api/megapay/webhook', handleMegapayWebhook);
app.get('/api/megapay/webhook', (req, res) => {
    res.json({ status: 'alive', message: 'Megapay webhook endpoint is reachable.', url: `${APP_URL}/api/megapay/webhook`, timestamp: new Date().toISOString() });
});

// ==========================================
// MINI APP API ROUTES
// ==========================================

app.post('/api/upload', validateInitData, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const url = `${APP_URL}/uploads/${req.file.filename}`;
    res.json({ success: true, url, name: req.file.originalname, size: req.file.size });
});

app.get('/api/me', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    res.json({ id: merchant._id, telegramId: merchant.telegramId, username: merchant.username, firstName: merchant.firstName, tokens: 0, totalSpent: merchant.totalSpent, supportUsername: merchant.supportUsername, status: 'active' });
});

app.get('/api/packages', validateInitData, async (req, res) => {
    const packages = await CreditPackage.find({ isActive: true }).sort({ price: 1 });
    res.json(packages.map(p => ({ _id: p._id, name: p.name, durationDays: p.credits, price: p.price })));
});

app.post('/api/credits/initiate', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    const { packageId, phone, botId } = req.body;
    if (!botId) return res.status(400).json({ error: 'Bot ID required' });
    const bot = await BotInstance.findOne({ _id: botId, merchantId: merchant._id });
    if (!bot) return res.status(404).json({ error: 'Bot not found or not yours' });
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) cleanPhone = '254' + cleanPhone.slice(1);
    else if (!cleanPhone.startsWith('254')) cleanPhone = '254' + cleanPhone;
    if (cleanPhone.length !== 12) return res.status(400).json({ error: 'Invalid phone number' });
    const pkg = await CreditPackage.findById(packageId);
    if (!pkg) return res.status(404).json({ error: 'Package not found' });

    const reference = 'SUB' + Date.now();
    await PendingTransaction.create({ reference, type: 'credit', phone: cleanPhone, amount: pkg.price, merchantTelegramId: merchant.telegramId, packageId: pkg._id, credits: pkg.credits, botId: bot._id });

    try {
        const payload = { api_key: process.env.MEGAPAY_API_KEY, email: process.env.MEGAPAY_EMAIL, amount: pkg.price, msisdn: cleanPhone, callback_url: `${APP_URL}/api/megapay/webhook`, description: `Bot Subscription: ${pkg.name}`, reference };
        const stkRes = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
        const respCode = stkRes.data?.ResponseCode ?? stkRes.data?.ResultCode ?? 1;
        if (parseInt(respCode) !== 0) {
            const desc = stkRes.data?.ResponseDescription ?? stkRes.data?.ResultDesc ?? 'Unknown error';
            await PendingTransaction.updateOne({ reference }, { status: 'failed' });
            return res.status(400).json({ error: 'STK initiation failed', detail: desc });
        }
        await PendingTransaction.updateOne({ reference }, { megapayTransactionId: stkRes.data?.transaction_request_id || '', megapayMerchantRequestId: stkRes.data?.MerchantRequestID || '', megapayCheckoutRequestId: stkRes.data?.CheckoutRequestID || '' });
        res.json({ success: true, reference, message: 'STK push sent to your phone' });
    } catch (err) {
        console.error('Subscription STK error:', err.message);
        res.status(500).json({ error: 'Failed to initiate STK push', detail: err.message });
    }
});

// --- Services ---
app.get('/api/services', validateInitData, async (req, res) => {
    const services = await Service.find().sort({ category: 1, serviceId: 1 });
    res.json(services);
});

app.post('/api/services/sync', validateInitData, async (req, res) => {
    if (!ADMIN_IDS.includes(req.telegramUser.id)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const response = await axios.post(SMM_API_URL, { key: SMM_API_KEY, action: 'services' });
        const services = response.data;
        if (!Array.isArray(services)) return res.status(400).json({ error: 'Invalid API response' });
        await Service.deleteMany({});
        await Service.insertMany(services.map(s => ({
            serviceId: s.service, name: s.name, type: s.type, category: s.category,
            rate: s.rate, min: s.min, max: s.max, refill: s.refill, cancel: s.cancel
        })));
        res.json({ success: true, count: services.length });
    } catch (err) {
        console.error('Sync error:', err.message);
        res.status(500).json({ error: 'Sync failed', detail: err.message });
    }
});

// --- Bots ---
app.get('/api/bots', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    const bots = await BotInstance.find({ merchantId: merchant._id });
    const now = new Date();
    res.json(bots.map(b => ({
        _id: b._id,
        botName: b.businessName || b.botUsername,
        botUsername: b.botUsername,
        botToken: b.botToken,
        status: b.status,
        welcomeMessage: b.welcomeMessage,
        welcomePhoto: b.welcomePhoto,
        bannerImageUrl: b.bannerImage,
        adminAlertChatId: b.adminAlertChatId,
        supportLink: b.supportLink,
        megapayApiKey: b.megapayApiKey ? '••••' + b.megapayApiKey.slice(-4) : '',
        megapayEmail: b.megapayEmail,
        megapayWebhookUrl: b.megapayWebhookUrl,
        markupPercent: b.markupPercent,
        enabledServices: b.enabledServices || [],
        expiresAt: b.expiresAt,
        daysLeft: b.expiresAt ? Math.max(0, Math.ceil((b.expiresAt - now) / (1000 * 60 * 60 * 24))) : 0,
        createdAt: b.createdAt
    })));
});

app.delete('/api/bots/:id', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    const bot = await BotInstance.findOneAndDelete({ _id: req.params.id, merchantId: merchant._id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    try { const activeBot = activeBots.get(req.params.id); if (activeBot) { await activeBot.api.deleteWebhook(); activeBots.delete(req.params.id); } } catch (e) {}
    res.json({ success: true, message: 'Bot deleted' });
});

app.post('/api/bots', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    const { botToken, botName, adminAlertChatId, welcomePhoto, bannerImage } = req.body;
    if (!botToken) return res.status(400).json({ error: 'Token required' });
    try {
        const testBot = new Bot(botToken);
        const botInfo = await testBot.api.getMe();
        const instance = await BotInstance.create({
            merchantId: merchant._id,
            botToken,
            botUsername: botInfo.username,
            botId: botInfo.id,
            status: 'active',
            businessName: botName || botInfo.first_name,
            welcomeMessage: `Welcome to ${botName || botInfo.first_name}! Boost your social media presence. Choose a service below.`,
            welcomePhoto: welcomePhoto || '',
            bannerImage: bannerImage || '',
            adminAlertChatId: adminAlertChatId || String(req.telegramUser.id),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
        });
        await loadMerchantBot(instance);
        res.json({ _id: instance._id, botName: instance.businessName, botUsername: botInfo.username, expiresAt: instance.expiresAt });
    } catch (e) { res.status(400).json({ error: 'Invalid bot token or setup failed', detail: e.message }); }
});

app.put('/api/bots/:id', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    const updates = { ...req.body };
    delete updates.botToken; delete updates._id; delete updates.botUsername; delete updates.botId;
    if (updates.megapayApiKey === '') delete updates.megapayApiKey;
    if (updates.megapayEmail === '') delete updates.megapayEmail;
    const bot = await BotInstance.findOneAndUpdate({ _id: req.params.id, merchantId: merchant._id }, updates, { returnDocument: 'after' });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json(bot);
});

// --- Bot Services ---
app.get('/api/bots/:id/services', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    const bot = await BotInstance.findOne({ _id: req.params.id, merchantId: merchant._id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const globalServices = await Service.find().sort({ category: 1, serviceId: 1 });
    const enabledMap = new Map((bot.enabledServices || []).map(s => [s.serviceId, s]));
    const merged = globalServices.map(s => {
        const cfg = enabledMap.get(s.serviceId);
        return {
            serviceId: s.serviceId, name: s.name, category: s.category, type: s.type,
            rate: s.rate, min: s.min, max: s.max, refill: s.refill, cancel: s.cancel,
            isEnabled: cfg?.isEnabled || false,
            customPrice: cfg?.customPrice || 0
        };
    });
    res.json(merged);
});

app.put('/api/bots/:id/services', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    const { enabledServices } = req.body; // array of { serviceId, customPrice, isEnabled }
    const bot = await BotInstance.findOneAndUpdate(
        { _id: req.params.id, merchantId: merchant._id },
        { enabledServices: enabledServices || [] },
        { returnDocument: 'after' }
    );
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    res.json({ success: true });
});

// --- Orders ---
app.get('/api/bots/:id/orders', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    const bot = await BotInstance.findOne({ _id: req.params.id, merchantId: merchant._id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const orders = await Order.find({ botId: bot._id }).sort({ createdAt: -1 }).limit(100);
    res.json(orders);
});

app.post('/api/bots/:botId/orders/:orderId/refill', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    const bot = await BotInstance.findOne({ _id: req.params.botId, merchantId: merchant._id });
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const order = await Order.findOne({ _id: req.params.orderId, botId: bot._id });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.refillEligible) return res.status(400).json({ error: 'Not eligible for refill' });
    if (order.refillRequested) return res.status(400).json({ error: 'Refill already requested' });
    const daysSince = (new Date() - order.createdAt) / (1000 * 60 * 60 * 24);
    if (daysSince > 30) return res.status(400).json({ error: 'Refill period expired (30 days)' });

    try {
        const smmRes = await axios.post(SMM_API_URL, { key: SMM_API_KEY, action: 'refill', order: order.smmOrderId });
        order.refillRequested = true;
        order.refillStatus = smmRes.data?.status || 'Requested';
        await order.save();
        res.json({ success: true, status: order.refillStatus });
    } catch (err) {
        console.error('Refill error:', err.message);
        res.status(500).json({ error: 'Refill request failed', detail: err.message });
    }
});

// --- Transactions / Stats ---
app.get('/api/transactions', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    const txns = await Transaction.find({ merchantId: merchant._id }).sort({ createdAt: -1 }).limit(50);
    res.json(txns);
});

app.get('/api/stats', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    const bots = await BotInstance.find({ merchantId: merchant._id });
    const now = new Date();
    const activeSubs = bots.filter(b => b.expiresAt > now && b.status === 'active').length;
    const botIds = bots.map(b => b._id);
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayOrders = await Order.countDocuments({ botId: { $in: botIds }, createdAt: { $gte: todayStart } });
    const totalSales = await Transaction.aggregate([{ $match: { merchantId: merchant._id, status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
    const txnCount = await Transaction.countDocuments({ merchantId: merchant._id, status: 'completed' });
    res.json({
        tokens: 0,
        activeBots: bots.length,
        activeSubscriptions: activeSubs,
        todayOrders,
        revenue: totalSales[0]?.total || 0,
        transactions: txnCount,
        status: 'active',
        bots: bots.map(b => ({
            _id: b._id,
            botName: b.businessName || b.botUsername,
            botUsername: b.botUsername,
            expiresAt: b.expiresAt,
            status: b.status,
            daysLeft: b.expiresAt ? Math.max(0, Math.ceil((b.expiresAt - now) / (1000 * 60 * 60 * 24))) : 0
        }))
    });
});

app.post('/api/support', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    merchant.supportUsername = req.body.username?.replace('@', '');
    await merchant.save();
    res.json({ success: true });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', appUrl: APP_URL, timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ==========================================
// ERROR HANDLER
// ==========================================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large. Max 5MB allowed.' });
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message });
  next();
});

// ==========================================
// CRON JOBS
// ==========================================

// Daily 9 AM: Bot subscription reminders & expiry suspension
cron.schedule('0 9 * * *', async () => {
    console.log('⏰ Checking bot subscriptions...');
    const now = new Date();
    const expiredBots = await BotInstance.find({ status: 'active', expiresAt: { $lt: now } });
    for (const bot of expiredBots) {
        bot.status = 'suspended';
        await bot.save();
        try { const b = activeBots.get(bot._id.toString()); if (b) await b.api.deleteWebhook(); activeBots.delete(bot._id.toString()); } catch (e) {}
        const merchant = await Merchant.findById(bot.merchantId);
        if (merchant) {
            try { await adminBot.api.sendMessage(merchant.telegramId, `🔴 *Bot Suspended*\n\n🤖 @${escapeMarkdown(bot.botUsername)}\nReason: Subscription expired\n\nRenew now to reactivate!`, { parse_mode: "Markdown" }); } catch (e) {}
        }
        console.log(`🔴 Suspended expired bot ${bot.botUsername}`);
    }
    const reminderDays = [3, 2, 1];
    for (const days of reminderDays) {
        const targetStart = new Date(now); targetStart.setDate(targetStart.getDate() + days); targetStart.setHours(0,0,0,0);
        const targetEnd = new Date(targetStart); targetEnd.setHours(23, 59, 59, 999);
        const botsToRemind = await BotInstance.find({ status: 'active', expiresAt: { $gte: targetStart, $lte: targetEnd } });
        for (const bot of botsToRemind) {
            const alreadySent = bot.subscriptionRemindersSent?.some(r => r.type === `${days}days` && r.date > new Date(now.getTime() - 24 * 60 * 60 * 1000));
            if (alreadySent) continue;
            const merchant = await Merchant.findById(bot.merchantId);
            if (merchant) {
                try {
                    await adminBot.api.sendMessage(merchant.telegramId, `⏰ *Subscription Reminder*\n\n🤖 @${escapeMarkdown(bot.botUsername)}\n⏳ Expires in *${days} day${days > 1 ? 's' : ''}*\n📅 Expiry: ${bot.expiresAt.toLocaleDateString()}\n\nRenew now to avoid interruption!`, { parse_mode: "Markdown" });
                    if (!bot.subscriptionRemindersSent) bot.subscriptionRemindersSent = [];
                    bot.subscriptionRemindersSent.push({ type: `${days}days`, date: new Date() });
                    await bot.save();
                } catch (e) {}
            }
        }
    }
});

// Every 15 min: Check SMM order statuses
cron.schedule('*/15 * * * *', async () => {
    console.log('⏰ Checking SMM order statuses...');
    const orders = await Order.find({ status: { $in: ['pending', 'processing', 'In progress'] } });
    for (const order of orders) {
        if (!order.smmOrderId || order.smmOrderId === 'PENDING') continue;
        try {
            const res = await axios.post(SMM_API_URL, { key: SMM_API_KEY, action: 'status', order: order.smmOrderId });
            const data = res.data;
            if (data && data.status) {
                const oldStatus = order.status;
                order.status = data.status;
                order.startCount = data.start_count || order.startCount;
                order.remains = data.remains || order.remains;
                order.charge = data.charge || order.charge;
                order.currency = data.currency || order.currency;
                order.updatedAt = new Date();
                await order.save();

                if (oldStatus !== data.status) {
                    const bot = activeBots.get(order.botId.toString());
                    if (bot) {
                        try {
                            let msg = `📋 *Order Update*\n\nOrder ID: \`${order.smmOrderId}\`\nService: ${escapeMarkdown(order.serviceName)}\nStatus: *${data.status}*`;
                            if (data.remains) msg += `\nRemains: ${data.remains}`;
                            await bot.api.sendMessage(order.customerTelegramId, msg, { parse_mode: "Markdown" });
                        } catch (e) {}
                    }
                }
            }
        } catch (err) { console.error(`[CRON] Status check failed for order ${order.smmOrderId}:`, err.message); }
    }
});

// ==========================================
// GLOBAL ERROR HANDLERS
// ==========================================
adminBot.catch((err) => { console.error(`Admin Bot Error:`, err); });

// ==========================================
// STARTUP
// ==========================================
const PORT = process.env.PORT || 3018;
const USE_HTTPS = APP_URL.startsWith('https://');

app.listen(PORT, async () => {
    console.log(`🌐 Server listening on port ${PORT}`);
    console.log(`🔒 HTTPS Mode: ${USE_HTTPS ? 'ENABLED' : 'DISABLED (using polling)'}`);
    console.log(`📱 Mini App: ${APP_URL}`);

    await seedPackages();

    const instances = await BotInstance.find({ status: 'active' });
    console.log(`🔄 Loading ${instances.length} merchant bots...`);
    for (const instance of instances) {
        await loadMerchantBot(instance);
        await new Promise(r => setTimeout(r, 1500));
    }

    if (USE_HTTPS) {
        try {
            await adminBot.init();
            await setWebhookWithRetry(adminBot, `${APP_URL}/webhook/admin`);
            console.log(`✅ Admin bot webhook set: ${APP_URL}/webhook/admin`);
        } catch (e) { console.log('⚠️ Could not set admin webhook:', e.message); }
    } else {
        console.log('⚠️ HTTP detected — Admin bot using long-polling.');
        adminBot.start({ onStart: (botInfo) => console.log(`🤖 Admin Bot @${botInfo.username} started via polling!`) });
    }
});