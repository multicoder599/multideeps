require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');
const { Bot, InlineKeyboard, Keyboard, InputFile } = require('grammy');
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
const APP_URL = process.env.APP_URL || 'https://multideeps.info';
const SMM_API_KEY = process.env.SMMFOLLOWS_API_KEY;
const SMM_API_URL = process.env.SMMFOLLOWS_API_URL || 'https://smmfollows.com/api/v2';
const PEAKER_API_KEY = process.env.PEAKER_API_KEY || '';
const PEAKER_API_URL = process.env.PEAKER_API_URL || 'https://peaker.com/api/v2';

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
    createdAt: { type: Date, default: Date.now }
});

// Provider-specific option embedded in service
const providerOptionSchema = new mongoose.Schema({
    provider: { type: String, enum: ['smmfollows', 'peaker'] },
    providerServiceId: Number,
    rate: Number,
    min: Number,
    max: Number,
    refill: Boolean,
    cancel: Boolean,
    deliveryMinutes: Number,
    reliabilityScore: { type: Number, default: 100 }
}, { _id: false });

const serviceSchema = new mongoose.Schema({
    serviceId: { type: Number, required: true, unique: true },
    name: String,
    displayName: { type: String, default: '' },
    type: String,
    category: String,
    platform: String,
    options: [providerOptionSchema],
    banned: { type: Boolean, default: false },
    banReason: String,
    updatedAt: { type: Date, default: Date.now }
});

const pricingTierSchema = new mongoose.Schema({
    label: String,
    minQty: Number,
    maxQty: Number,
    multiplier: Number
}, { _id: false });

const botInstanceSchema = new mongoose.Schema({
    isDefault: { type: Boolean, default: false },
    botToken: { type: String, required: true },
    botUsername: String,
    botId: Number,
    status: { type: String, enum: ['active', 'suspended', 'expired'], default: 'active' },
    businessName: { type: String, default: 'My SMM Store' },
    welcomeMessage: { type: String, default: 'Welcome! Boost your social media presence. Choose a platform below.' },
    welcomePhoto: { type: String, default: '' },
    bannerImage: { type: String, default: '' },
    adminAlertChatId: String,
    supportLink: { type: String, default: '' },
    megapayApiKey: { type: String, default: '' },
    megapayEmail: { type: String, default: '' },
    megapayWebhookUrl: { type: String, default: '' },
    pricingConfig: {
        exchangeRate: { type: Number, default: 130 },
        markupMultiplier: { type: Number, default: 1.5 },
        tiers: { type: [pricingTierSchema], default: () => [
            { label: '🔰 Starter', minQty: 50, maxQty: 500, multiplier: 1.15 },
            { label: '🚀 Growth', minQty: 501, maxQty: 2000, multiplier: 1.0 },
            { label: '⚡ Bulk', minQty: 2001, maxQty: 5000, multiplier: 0.92 },
            { label: '💎 Mega', minQty: 5001, maxQty: 10000, multiplier: 0.85 },
            { label: '👑 Supreme', minQty: 10001, maxQty: 50000, multiplier: 0.78 }
        ]}
    },
    enabledServices: [{
        serviceId: Number,
        customPrice: { type: Number, default: 0 },
        isEnabled: { type: Boolean, default: false }
    }],
    createdAt: { type: Date, default: Date.now },
    expiresAt: Date
});

const orderSchema = new mongoose.Schema({
    botId: { type: mongoose.Schema.Types.ObjectId, ref: 'BotInstance', required: true },
    customerTelegramId: { type: Number, required: true },
    customerUsername: String,
    customerChatId: Number,
    serviceId: Number,
    provider: String,
    providerServiceId: Number,
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
    botId: { type: mongoose.Schema.Types.ObjectId, ref: 'BotInstance' },
    customerTelegramId: Number,
    customerChatId: Number,
    serviceId: Number,
    provider: String,
    providerServiceId: Number,
    serviceName: String,
    link: String,
    quantity: Number,
    megapayTransactionId: String,
    megapayMerchantRequestId: String,
    megapayCheckoutRequestId: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 }
});

const webSessionSchema = new mongoose.Schema({
    sessionId: { type: String, required: true, unique: true, index: true },
    phone: String,
    customerName: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 }
});

const Merchant = mongoose.model('Merchant', merchantSchema);
const Service = mongoose.model('Service', serviceSchema);
const BotInstance = mongoose.model('BotInstance', botInstanceSchema);
const Order = mongoose.model('Order', orderSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const PendingTransaction = mongoose.model('PendingTransaction', pendingTxSchema);
const WebSession = mongoose.model('WebSession', webSessionSchema);

// ==========================================
// IN-MEMORY STATE
// ==========================================
const adminUserState = new Map();
const customerPendingInputs = new Map();
const webPendingInputs = new Map(); // sessionId -> state
let defaultStore = null;

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

function btnText(text, max = 58) {
    if (!text) return '...';
    return text.length > max ? text.slice(0, max - 3) + '...' : text;
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

async function getDefaultStore(force = false) {
    if (!defaultStore || force) {
        defaultStore = await BotInstance.findOne({ isDefault: true });
    }
    return defaultStore;
}

function invalidateStoreCache() {
    defaultStore = null;
}

// Platform & Type detection
const PLATFORM_META = {
    instagram: { emoji: '📸', name: 'Instagram' },
    tiktok:    { emoji: '🎵', name: 'TikTok' },
    twitter:   { emoji: '🐦', name: 'Twitter / X' },
    facebook:  { emoji: '📘', name: 'Facebook' },
    youtube:   { emoji: '▶️', name: 'YouTube' },
    telegram:  { emoji: '✈️', name: 'Telegram' },
    reddit:    { emoji: '🔴', name: 'Reddit' },
    snapchat:  { emoji: '👻', name: 'Snapchat' },
    whatsapp:  { emoji: '💬', name: 'WhatsApp' }
};

const SERVICE_TYPES = ['followers', 'subscribers', 'members', 'views', 'likes', 'comments'];

function detectPlatform(service) {
    const text = `${service.category || ''} ${service.name || ''}`.toLowerCase();
    for (const key of Object.keys(PLATFORM_META)) {
        if (text.includes(key)) return key;
    }
    return null;
}

function detectType(service) {
    const text = `${service.category || ''} ${service.name || ''}`.toLowerCase();
    for (const type of SERVICE_TYPES) {
        if (text.includes(type)) return type;
    }
    return 'other';
}

function cleanServiceName(service) {
    const platform = detectPlatform(service);
    const type = detectType(service);
    const platformName = PLATFORM_META[platform]?.name || (platform ? platform.charAt(0).toUpperCase() + platform.slice(1) : '');
    const typeName = type === 'other' ? 'Boost' : type.charAt(0).toUpperCase() + type.slice(1);
    return `${platformName} ${typeName}`.trim();
}

// Delivery time estimator
function estimateDeliveryMinutes(serviceName, category) {
    const text = `${serviceName || ''} ${category || ''}`.toLowerCase();

    // Ultra fast
    if (text.includes('instant') || text.includes('0-1h') || text.includes('0-1 hour') || text.includes('0-30m') || text.includes('immediate')) return 30;
    if (text.includes('fast') || text.includes('speed') || text.includes('quick') || text.includes('rapid') || text.includes('express')) return 60;
    if (text.includes('0-3h') || text.includes('0-3 hour') || text.includes('0-6h') || text.includes('0-6 hour') || text.includes('1-6h')) return 120;
    if (text.includes('0-12h') || text.includes('0-12 hour') || text.includes('1-12h')) return 360;

    // Medium
    if (text.includes('1-24h') || text.includes('1-24 hour') || text.includes('24h')) return 720;
    if (text.includes('slow') || text.includes('drip') || text.includes('gradual') || text.includes('organic')) return 2880;
    if (text.includes('1-3 day') || text.includes('2-3 day') || text.includes('3-5 day')) return 4320;

    // Default
    return 240; // 4 hours default
}

function formatDuration(minutes) {
    if (minutes < 60) return `~${minutes} min`;
    if (minutes < 1440) return `~${Math.round(minutes/60)} hrs`;
    return `~${Math.round(minutes/1440)} days`;
}

function getPlatformKeyboard(services) {
    const platforms = new Set();
    services.forEach(s => {
        if (s.platform) platforms.add(s.platform);
        else {
            const p = detectPlatform(s);
            if (p) platforms.add(p);
        }
    });
    const keyboard = new InlineKeyboard();
    const platformList = Array.from(platforms);
    for (let i = 0; i < platformList.length; i += 2) {
        const row = [];
        const p1 = platformList[i];
        const meta1 = PLATFORM_META[p1];
        row.push({ text: `${meta1.emoji} ${meta1.name}`, callback_data: `plat_${p1}` });
        if (platformList[i + 1]) {
            const p2 = platformList[i + 1];
            const meta2 = PLATFORM_META[p2];
            row.push({ text: `${meta2.emoji} ${meta2.name}`, callback_data: `plat_${p2}` });
        }
        keyboard.row(...row);
    }
    return keyboard;
}

function getTypeKeyboard(services, platform) {
    const types = new Set();
    services.filter(s => (s.platform || detectPlatform(s)) === platform).forEach(s => types.add(detectType(s)));
    const keyboard = new InlineKeyboard();
    const typeList = Array.from(types);
    const typeEmojis = {
        followers: '👥', subscribers: '🔔', members: '👥', views: '👁️', likes: '❤️', comments: '💬', other: '🔧'
    };
    for (const t of typeList) {
        keyboard.text(`${typeEmojis[t] || '🔧'} ${t.charAt(0).toUpperCase() + t.slice(1)}`, `type_${platform}_${t}`).row();
    }
    keyboard.text('🔙 Back to Platforms', 'back_platforms');
    return keyboard;
}

// Pricing engine
function calculateKESPrice(rate, quantity, pricingConfig) {
    const r = parseFloat(rate) || 0;
    if (r <= 0 || quantity <= 0) return 0;
    const exchangeRate = pricingConfig?.exchangeRate || 130;
    const markup = pricingConfig?.markupMultiplier || 1.5;
    const costPer1kInKES = r * exchangeRate;
    const pricePer1kInKES = costPer1kInKES * markup;
    const total = (pricePer1kInKES / 1000) * quantity;
    return Math.max(20, Math.ceil(total / 10) * 10);
}

function getTierDisplayPrice(rate, tierMax, pricingConfig) {
    return calculateKESPrice(rate, tierMax, pricingConfig);
}

// Main Menu Reply Keyboard (like VIP MPESA bot)
function getMainMenuKeyboard() {
    return new Keyboard()
        .text('📊 My Status').text('💎 Plans / Services').row()
        .text('🔄 Renew Plan').text('🔍 Check Payment').row()
        .text('💬 Support').text('👨‍💻 Developer').row()
        .text('❓ Help / FAQ')
        .resized();
}

function getOwnerMenu() {
    return new InlineKeyboard()
        .text("👁️ Preview Store", "preview_store").row()
        .text("🛒 Service Catalog", "owner_services").row()
        .text("📋 View Orders", "owner_orders").row()
        .text("📊 Stats", "owner_stats").row()
        .text("💳 Payment Settings", "owner_payment").row()
        .text("⚙️ Store Settings", "owner_settings").row()
        .text("💰 Pricing Config", "owner_pricing").row()
        .text("📢 Broadcast", "owner_broadcast").row()
        .text("📱 Open Dashboard", "open_dashboard");
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
// MAIN BOT
// ==========================================
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.catch((err) => { console.error(`Bot Error:`, err.message); });

// ==========================================
// CUSTOMER MENU
// ==========================================
async function showCustomerMenu(ctx) {
    const store = await getDefaultStore();
    if (!store || store.status !== 'active') {
        return ctx.reply("⛔ Store is currently offline. Please check back later.", { reply_markup: getMainMenuKeyboard() });
    }

    const enabled = store.enabledServices?.filter(s => s.isEnabled) || [];
    if (enabled.length === 0) {
        return ctx.reply("⏳ Store has no active services yet. Please check back later.", { reply_markup: getMainMenuKeyboard() });
    }

    const services = await Service.find({ serviceId: { $in: enabled.map(s => s.serviceId) }, banned: { $ne: true } });
    const keyboard = getPlatformKeyboard(services);

    const welcomeText = store.welcomeMessage || "Welcome! Boost your social media presence. Choose a platform to get started:";

    // Try sending photo from local filesystem first (more reliable than URL)
    const photoUrl = store.welcomePhoto || '';
    if (photoUrl) {
        const filename = photoUrl.split('/').pop();
        const localPath = path.join(__dirname, 'public', 'uploads', filename);
        try {
            if (fs.existsSync(localPath)) {
                await ctx.replyWithPhoto(new InputFile(localPath), { caption: welcomeText, reply_markup: keyboard });
                return;
            }
        } catch (err) {
            console.log('[showCustomerMenu] Local photo failed:', err.message, '| Path:', localPath);
        }
        // Fallback to URL
        try {
            await ctx.replyWithPhoto(photoUrl, { caption: welcomeText, reply_markup: keyboard });
            return;
        } catch (err) {
            console.log('[showCustomerMenu] URL photo failed:', err.message, '| URL:', photoUrl);
        }
    }

    await ctx.reply(welcomeText, { reply_markup: keyboard });
}

// ==========================================
// /start HANDLER
// ==========================================
async function handleStart(ctx) {
    const isOwner = ADMIN_IDS.includes(ctx.from.id);

    if (isOwner) {
        const welcomeText = `👋 Hello ${escapeMarkdown(ctx.from.first_name || 'Boss')}!

🤖 *SMM Panel Owner*

Manage your store, view orders, and configure services below.`;
        const keyboard = getOwnerMenu();
        try {
            const store = await getDefaultStore();
            if (store && store.welcomePhoto) {
                await ctx.replyWithPhoto(store.welcomePhoto, { caption: welcomeText, parse_mode: "Markdown", reply_markup: keyboard });
            } else {
                await ctx.reply(welcomeText, { parse_mode: "Markdown", reply_markup: keyboard });
            }
        } catch (e) { await ctx.reply(welcomeText, { parse_mode: "Markdown", reply_markup: keyboard }); }
        return;
    }

    // Send welcome with main menu keyboard
    const store = await getDefaultStore();
    const welcomeText = store?.welcomeMessage || "🚀 *Welcome to Multi Social Deeps!*\n\nBoost your social media presence with real engagement.\n\nChoose an option below or tap 💎 Plans to browse services.";
    const photoUrl = store?.welcomePhoto || '';

    if (photoUrl) {
        const filename = photoUrl.split('/').pop();
        const localPath = path.join(__dirname, 'public', 'uploads', filename);
        try {
            if (fs.existsSync(localPath)) {
                await ctx.replyWithPhoto(new InputFile(localPath), { 
                    caption: welcomeText, 
                    parse_mode: "Markdown",
                    reply_markup: getMainMenuKeyboard()
                });
                return;
            }
        } catch (e) {
            console.log('[handleStart] Local photo failed:', e.message);
        }
        try {
            await ctx.replyWithPhoto(photoUrl, { 
                caption: welcomeText, 
                parse_mode: "Markdown",
                reply_markup: getMainMenuKeyboard()
            });
            return;
        } catch (e) {
            console.log('[handleStart] URL photo failed:', e.message);
        }
    }
    await ctx.reply(welcomeText, { parse_mode: "Markdown", reply_markup: getMainMenuKeyboard() });
}

bot.command("start", handleStart);

// Handle main menu text commands
bot.hears(['📊 My Status', '/status'], async (ctx) => {
    const orders = await Order.find({ customerTelegramId: ctx.from.id }).sort({ createdAt: -1 }).limit(10);
    if (orders.length === 0) {
        return ctx.reply("📭 You have no orders yet.\n\nTap 💎 Plans to get started!", { reply_markup: getMainMenuKeyboard() });
    }
    let text = `📊 *Your Order Status*\n\n`;
    orders.forEach((o, i) => {
        text += `${i+1}. #${o.smmOrderId || 'N/A'} — ${escapeMarkdown(o.serviceName)}\n   Status: *${o.status}* | Qty: ${o.quantity.toLocaleString()}\n\n`;
    });
    const keyboard = new InlineKeyboard();
    orders.slice(0, 5).forEach(o => {
        keyboard.text(`🔄 Refresh #${o.smmOrderId?.slice(-6) || 'N/A'}`, `status_${o.smmOrderId}`).row();
    });
    keyboard.text('🔙 Main Menu', 'back_start');
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
});

bot.hears(['💎 Plans / Services', '/plans'], async (ctx) => {
    return showCustomerMenu(ctx);
});

bot.hears(['🔄 Renew Plan', '/renew'], async (ctx) => {
    await ctx.reply("🔄 *Renew Plan*\n\nThis feature is coming soon!\n\nFor now, simply browse services and place a new order.", { parse_mode: "Markdown", reply_markup: getMainMenuKeyboard() });
});

bot.hears(['🔍 Check Payment', '/checkpayment'], async (ctx) => {
    const pending = await PendingTransaction.find({ customerTelegramId: ctx.from.id, status: 'pending' }).sort({ createdAt: -1 }).limit(5);
    if (pending.length === 0) {
        return ctx.reply("✅ No pending payments found.\n\nIf you just paid, please wait 1-2 minutes for confirmation.", { reply_markup: getMainMenuKeyboard() });
    }
    let text = `🔍 *Pending Payments*\n\n`;
    pending.forEach(p => {
        text += `• Ref: \`${p.reference}\`\n  Amount: KES ${p.amount}\n  Status: ⏳ Pending\n\n`;
    });
    text += "_If you completed the M-Pesa prompt, your order will process automatically._";
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: getMainMenuKeyboard() });
});

bot.hears(['💬 Support', '/support'], async (ctx) => {
    const store = await getDefaultStore();
    if (store?.supportLink) {
        await ctx.reply("💬 *Support*\n\nClick below to chat with our support team:", {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard().row({ text: '💬 Open Support Chat', url: store.supportLink })
        });
    } else {
        await ctx.reply("💬 *Support*\n\nPlease contact the admin for assistance.", { reply_markup: getMainMenuKeyboard() });
    }
});

bot.hears(['👨‍💻 Developer', '/developer'], async (ctx) => {
    await ctx.reply("👨‍💻 *Developer*\n\nBot powered by Multi Social Deeps 🚀\nBuilt for fast, reliable social media growth.", { parse_mode: "Markdown", reply_markup: getMainMenuKeyboard() });
});

bot.hears(['❓ Help / FAQ', '/help'], async (ctx) => {
    const text = `❓ *Help & FAQ*\n\n` +
        `*How does it work?*\n` +
        `1️⃣ Choose your platform (Instagram, TikTok, etc.)\n` +
        `2️⃣ Select service type (Followers, Likes, Views)\n` +
        `3️⃣ Pick a speed option (Fast or Standard)\n` +
        `4️⃣ Enter your link and quantity\n` +
        `5️⃣ Pay via M-Pesa\n` +
        `6️⃣ Watch your numbers grow!\n\n` +
        `*Delivery Times:*\n` +
        `• Fast options: ~30 min — 2 hrs\n` +
        `• Standard: ~2 — 12 hrs\n` +
        `• Large orders: Up to 24 hrs\n\n` +
        `*Need help?* Tap 💬 Support`;
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: getMainMenuKeyboard() });
});

bot.command("owner", async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from.id)) return ctx.reply("⛔ Owner only.");
    const store = await getDefaultStore();
    const totalOrders = await Order.countDocuments({ botId: store._id });
    const completedOrders = await Order.countDocuments({ botId: store._id, status: 'Completed' });
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const revenue24h = await Transaction.aggregate([{ $match: { botId: store._id, status: 'completed', createdAt: { $gte: yesterday } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
    const revenueToday = await Transaction.aggregate([{ $match: { botId: store._id, status: 'completed', createdAt: { $gte: todayStart } } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
    const totalRevenue = await Transaction.aggregate([{ $match: { botId: store._id, status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);

    const text = `📋 *Owner Panel — ${escapeMarkdown(store.businessName)}*\n\n` +
        `📦 Orders: *${totalOrders}*\n✅ Completed: *${completedOrders}*\n` +
        `💰 Today: *KES ${revenueToday[0]?.total || 0}*\n💰 24h: *KES ${revenue24h[0]?.total || 0}*\n` +
        `💰 Total: *KES ${totalRevenue[0]?.total || 0}*\n\nTap below:`;
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: getOwnerMenu() });
});

// ==========================================
// CALLBACKS — SINGLE HANDLER
// ==========================================
bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;

    try { await ctx.answerCallbackQuery(); } catch (e) {}

    const store = await getDefaultStore();
    const customerState = customerPendingInputs.get(userId);

    // ---- STATUS CHECK (refreshable) ----
    if (data.startsWith('status_')) {
        const smmOrderId = data.replace('status_', '');
        const order = await Order.findOne({ smmOrderId, customerTelegramId: userId });
        if (!order) {
            await ctx.reply("❌ Order not found.");
            return;
        }

        let msg = `📋 *Order Status*\n\n` +
            `🛒 ${escapeMarkdown(order.serviceName)}\n` +
            `📊 Qty: ${order.quantity.toLocaleString()}\n` +
            `🔗 ${escapeMarkdown(order.link)}\n\n`;

        try {
            const apiUrl = order.provider === 'peaker' ? PEAKER_API_URL : SMM_API_URL;
            const apiKey = order.provider === 'peaker' ? PEAKER_API_KEY : SMM_API_KEY;
            const res = await axios.post(apiUrl, { key: apiKey, action: 'status', order: smmOrderId }, { timeout: 30000 });
            const d = res.data;
            if (d && d.status) {
                order.status = d.status;
                order.startCount = d.start_count || order.startCount;
                order.remains = d.remains || order.remains;
                order.charge = d.charge || order.charge;
                order.currency = d.currency || order.currency;
                order.updatedAt = new Date();
                await order.save();
                msg += `📌 Current: *${d.status}*\n`;
                if (d.start_count) msg += `▶️ Start Count: ${d.start_count}\n`;
                if (d.remains) msg += `⏳ Remains: ${d.remains}\n`;
                if (d.charge) msg += `💵 Charge: ${d.charge} ${d.currency || ''}\n`;
            } else {
                msg += `📌 Status: *${order.status}*\n`;
            }
        } catch (e) {
            msg += `📌 Status: *${order.status}*\n_⚠️ Live refresh failed — showing last known status._\n`;
        }

        msg += `\n_Last updated: ${new Date().toLocaleTimeString()}_`;

        const keyboard = new InlineKeyboard()
            .text('🔄 Refresh Status', `status_${smmOrderId}`).row()
            .text('🔙 Main Menu', 'back_start');

        await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
        return;
    }

    if (data === 'confirm_pay') {
        if (!customerState || customerState.action !== 'awaiting_payment_confirm') {
            await ctx.reply("⚠️ Session expired. Please start over with /start");
            return;
        }
        customerState.action = 'awaiting_payment_phone';
        await ctx.reply(
            `💳 *Payment*\n\nEnter your M-Pesa number:\nFormat: 07XXXXXXXX or 01XXXXXXXX`,
            { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text('🔙 Cancel', 'back_start') }
        );
        return;
    }

    if (ADMIN_IDS.includes(userId)) {
        if (data === 'preview_store') {
            return showCustomerMenu(ctx);
        }
        if (data === 'owner_services') {
            await ctx.reply(`🛒 *Service Catalog*\n\nOpen your dashboard to enable services and set prices 👇`, {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().row({ text: '👇 Open Dashboard', web_app: { url: APP_URL + '/admin' } })
            });
            return;
        }
        if (data === 'owner_orders') {
            const orders = await Order.find({ botId: store._id }).sort({ createdAt: -1 }).limit(15);
            let text = `📋 *Recent Orders*\n\n`;
            if (orders.length === 0) text += `_No orders yet._`;
            else {
                orders.forEach(o => {
                    text += `• #${o.smmOrderId || 'N/A'} — ${escapeMarkdown(o.serviceName)} — ${o.quantity.toLocaleString()} qty — KES ${o.price} — ${o.status}\n`;
                });
            }
            await ctx.reply(text, { parse_mode: "Markdown", reply_markup: getOwnerMenu() });
            return;
        }
        if (data === 'owner_stats') {
            const totalOrders = await Order.countDocuments({ botId: store._id });
            const completedOrders = await Order.countDocuments({ botId: store._id, status: 'Completed' });
            const totalRevenue = await Transaction.aggregate([{ $match: { botId: store._id, status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
            await ctx.reply(
                `📊 *Store Stats*\n\n📦 Total Orders: *${totalOrders}*\n✅ Completed: *${completedOrders}*\n💰 Revenue: *KES ${totalRevenue[0]?.total || 0}*`,
                { parse_mode: "Markdown", reply_markup: getOwnerMenu() }
            );
            return;
        }
        if (data === 'owner_payment') {
            adminUserState.set(userId, { action: 'payment_menu' });
            const hasConfig = store.megapayApiKey && store.megapayEmail;
            const webhookDisplay = `${APP_URL}/api/megapay/webhook`;
            const keyboard = new InlineKeyboard()
                .text("🔑 Set Megapay API Key", "set_megapay_key").row()
                .text("📧 Set Megapay Email", "set_megapay_email").row()
                .text("🔙 Back", "owner_back");
            await ctx.reply(
                `💳 *Payment Settings*\n\nStatus: *${hasConfig ? '✅ Configured' : '❌ Not set'}*\n\nYour Webhook:\n\`${escapeMarkdown(webhookDisplay)}\`\n\nMoney goes directly to YOUR Megapay account.`,
                { parse_mode: "Markdown", reply_markup: keyboard }
            );
            return;
        }
        if (data === 'set_megapay_key') {
            adminUserState.set(userId, { action: 'awaiting_megapay_key' });
            await ctx.reply(`🔑 *Set Megapay API Key*\n\nPaste your key below 👇`, { parse_mode: "Markdown" });
            return;
        }
        if (data === 'set_megapay_email') {
            adminUserState.set(userId, { action: 'awaiting_megapay_email' });
            await ctx.reply(`📧 *Set Megapay Email*\n\nPaste your email below 👇`, { parse_mode: "Markdown" });
            return;
        }
        if (data === 'owner_settings') {
            adminUserState.set(userId, { action: 'settings_menu' });
            const keyboard = new InlineKeyboard()
                .text("📝 Edit Store Name", "edit_name").row()
                .text("💬 Edit Welcome Msg", "edit_welcome").row()
                .text("🔗 Set Support Link", "edit_support").row()
                .text("🖼️ Set Banner", "edit_banner").row()
                .text("🔙 Back", "owner_back");
            await ctx.reply(`⚙️ *Store Settings*`, { parse_mode: "Markdown", reply_markup: keyboard });
            return;
        }
        if (data === 'owner_pricing') {
            const cfg = store.pricingConfig || {};
            const tiers = cfg.tiers || [];
            let text = `💰 *Auto-Pricing Config*\n\nExchange Rate: *${cfg.exchangeRate || 130}* KES per unit\nMarkup: *${((cfg.markupMultiplier || 1.5) * 100 - 100).toFixed(0)}%* profit margin\n\n*Tiers:*\n`;
            tiers.forEach(t => {
                text += `• ${t.label}: ${t.minQty.toLocaleString()} - ${t.maxQty.toLocaleString()} (multiplier: ${t.multiplier}x)\n`;
            });
            text += `\nTap below to open dashboard and edit:`;
            await ctx.reply(text, {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().row({ text: '👇 Open Dashboard', web_app: { url: APP_URL + '/admin' } })
            });
            return;
        }
        if (data === 'edit_name') {
            adminUserState.set(userId, { action: 'awaiting_store_name' });
            await ctx.reply("📝 Enter new store name:");
            return;
        }
        if (data === 'edit_welcome') {
            adminUserState.set(userId, { action: 'awaiting_welcome_msg' });
            await ctx.reply("💬 Enter new welcome message:");
            return;
        }
        if (data === 'edit_support') {
            adminUserState.set(userId, { action: 'awaiting_support_link' });
            await ctx.reply("🔗 Enter support link (e.g. https://t.me/yourusername):");
            return;
        }
        if (data === 'edit_banner') {
            adminUserState.set(userId, { action: 'awaiting_banner' });
            await ctx.reply("🖼️ Send a banner image URL:");
            return;
        }
        if (data === 'owner_broadcast') {
            adminUserState.set(userId, { action: 'awaiting_broadcast_msg' });
            await ctx.reply("📢 *Broadcast to all customers*\n\nType your message:", { parse_mode: "Markdown" });
            return;
        }
        if (data === 'owner_back' || data === 'open_dashboard') {
            return handleStart(ctx);
        }
    }

    if (data === 'back_start') {
        return showCustomerMenu(ctx);
    }

    if (data === 'back_platforms') {
        return showCustomerMenu(ctx);
    }

    if (data.startsWith('plat_')) {
        const platform = data.replace('plat_', '');
        const enabled = store.enabledServices?.filter(s => s.isEnabled) || [];
        const services = await Service.find({ serviceId: { $in: enabled.map(s => s.serviceId) }, banned: { $ne: true } });
        const platformServices = services.filter(s => (s.platform || detectPlatform(s)) === platform);
        if (platformServices.length === 0) {
            return ctx.reply("❌ No services available for this platform right now.");
        }
        const keyboard = getTypeKeyboard(services, platform);
        const meta = PLATFORM_META[platform];
        await ctx.reply(
            `${meta.emoji} *${meta.name}*\n\nChoose the type of service you need:`,
            { parse_mode: "Markdown", reply_markup: keyboard }
        );
        return;
    }

    if (data.startsWith('type_')) {
        const parts = data.replace('type_', '').split('_');
        const platform = parts[0];
        const serviceType = parts[1];
        const enabled = store.enabledServices?.filter(s => s.isEnabled) || [];
        const services = await Service.find({ serviceId: { $in: enabled.map(s => s.serviceId) }, banned: { $ne: true } });
        const filtered = services.filter(s => (s.platform || detectPlatform(s)) === platform && detectType(s) === serviceType);
        if (filtered.length === 0) return ctx.reply("❌ No services found.");

        const keyboard = new InlineKeyboard();
        const cfg = store.pricingConfig || {};

        for (const s of filtered) {
            const displayName = s.displayName || cleanServiceName(s);
            const options = s.options || [];
            let bestRate = parseFloat(s.rate) || 1;
            if (options.length > 0) {
                bestRate = options.sort((a,b) => a.rate - b.rate)[0].rate;
            }
            const startPrice = getTierDisplayPrice(bestRate, (cfg.tiers?.[0]?.maxQty || 500), cfg);
            const rawLabel = `${displayName} — from KES ${startPrice}`;
            keyboard.text(btnText(rawLabel), `svc_${s.serviceId}`).row();
        }
        keyboard.text('🔙 Back', `plat_${platform}`);

        const typeEmojis = { followers: '👥', subscribers: '🔔', members: '👥', views: '👁️', likes: '❤️', comments: '💬', other: '🔧' };
        const typeLabel = serviceType.charAt(0).toUpperCase() + serviceType.slice(1);
        await ctx.reply(
            `${typeEmojis[serviceType] || '🔧'} *${typeLabel}* — ${PLATFORM_META[platform]?.name || platform}\n\nSelect a package:`,
            { parse_mode: "Markdown", reply_markup: keyboard }
        );
        return;
    }

    if (data.startsWith('svc_')) {
        const serviceId = parseInt(data.replace('svc_', ''));
        const svc = await Service.findOne({ serviceId });
        if (!svc) return ctx.reply("❌ Service not found.");

        const cfg = store.pricingConfig || {};
        const tiers = cfg.tiers || [];
        const keyboard = new InlineKeyboard();
        const displayName = svc.displayName || cleanServiceName(svc);

        // Get effective options for pricing reference
        const options = svc.options || [];
        let effectiveOptions = options;
        if (options.length === 0) {
            effectiveOptions = [{
                provider: 'smmfollows',
                providerServiceId: svc.serviceId,
                rate: parseFloat(svc.rate) || 1,
                min: parseInt(svc.min) || 50,
                max: parseInt(svc.max) || 10000,
                refill: svc.refill || false,
                cancel: svc.cancel || false,
                deliveryMinutes: estimateDeliveryMinutes(svc.name, svc.category),
                reliabilityScore: 100
            }];
        }
        const bestRate = effectiveOptions.sort((a,b) => a.rate - b.rate)[0]?.rate || 1;

        // Build tier list like the old version
        let text = `🛒 *${escapeMarkdown(displayName)}*\n\n`;
        text += `Min: ${svc.min || effectiveOptions[0].min} | Max: ${svc.max || effectiveOptions[0].max}\n`;
        text += `Refill: ${(svc.refill || effectiveOptions[0].refill) ? '✅ Yes (30 days)' : '❌ No'}\n\n`;
        text += `*Select your quantity tier:*\n`;

        tiers.forEach(t => {
            const price = getTierDisplayPrice(bestRate, t.maxQty, cfg);
            text += `• ${t.label}: ${t.minQty.toLocaleString()} - ${t.maxQty.toLocaleString()} qty\n`;
        });
        text += `\n_Price shown is for max tier qty. Actual price scales with your quantity._`;

        for (let i = 0; i < tiers.length; i++) {
            const tier = tiers[i];
            const price = getTierDisplayPrice(bestRate, tier.maxQty, cfg);
            const btnLabel = `${tier.label} | ${tier.minQty.toLocaleString()}-${tier.maxQty.toLocaleString()} @ KES ${price}`;
            keyboard.text(btnText(btnLabel), `tier_${serviceId}_${i}`).row();
        }
        keyboard.text('🔙 Back to Types', `type_${detectPlatform(svc)}_${detectType(svc)}`);

        await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
        return;
    }

    if (data.startsWith('provider_')) {
        const idx = parseInt(data.replace('provider_', ''));
        const state = customerPendingInputs.get(userId);
        if (!state || state.action !== 'awaiting_provider_choice') {
            await ctx.reply("⚠️ Session expired. Please start over with /start");
            return;
        }
        const options = state.data.options || [];
        const selectedOpt = options[idx];
        if (!selectedOpt) return ctx.reply("❌ Option not found.");

        state.data.selectedProvider = selectedOpt;
        state.action = 'awaiting_link';

        await ctx.reply(
            `✅ *${selectedOpt.deliveryMinutes <= 60 ? '⚡ Fast' : (selectedOpt.deliveryMinutes <= 360 ? '🔥 Quick' : '💰 Standard')}* selected\n\n` +
            `Now send the link or username to promote:\n` +
            `_Examples:_\n` +
            `• Instagram: \`https://instagram.com/username\`\n` +
            `• TikTok: \`https://tiktok.com/@username\`\n` +
            `• YouTube: \`https://youtube.com/watch?v=xxx\`\n` +
            `• Telegram: \`https://t.me/channelname\``,
            { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text('🔙 Cancel', 'back_start') }
        );
        return;
    }

    if (data.startsWith('opt_')) {
        const match = data.match(/opt_(\d+)_(\d+)/);
        if (!match) return;
        const serviceId = parseInt(match[1]);
        const optionIdx = parseInt(match[2]);
        const svc = await Service.findOne({ serviceId });
        if (!svc) return ctx.reply("❌ Service not found.");

        let options = svc.options || [];
        // Fallback for old data
        if (options.length === 0) {
            options = [{
                provider: 'smmfollows',
                providerServiceId: svc.serviceId,
                rate: parseFloat(svc.rate) || 1,
                min: parseInt(svc.min) || 50,
                max: parseInt(svc.max) || 10000,
                refill: svc.refill || false,
                cancel: svc.cancel || false,
                deliveryMinutes: estimateDeliveryMinutes(svc.name, svc.category),
                reliabilityScore: 100
            }];
        }
        const selectedOpt = options[optionIdx];
        if (!selectedOpt) return ctx.reply("❌ Option not found.");

        const cfg = store.pricingConfig || {};
        const tiers = cfg.tiers || [];
        const displayName = svc.displayName || cleanServiceName(svc);
        const tier = tiers[0]; // Default to first tier for selection

        customerPendingInputs.set(userId, {
            action: 'awaiting_qty_for_option',
            data: { 
                serviceId, 
                optionIdx,
                provider: selectedOpt.provider,
                providerServiceId: selectedOpt.providerServiceId,
                serviceName: displayName, 
                platform: detectPlatform(svc), 
                type: detectType(svc), 
                rate: selectedOpt.rate, 
                min: selectedOpt.min, 
                max: selectedOpt.max,
                deliveryMinutes: selectedOpt.deliveryMinutes,
                refill: selectedOpt.refill
            }
        });

        const priceForMax = getTierDisplayPrice(selectedOpt.rate, tier.maxQty, cfg);
        const duration = formatDuration(selectedOpt.deliveryMinutes);

        await ctx.reply(
            `✅ *${selectedOpt.deliveryMinutes <= 60 ? '⚡ Fast' : (selectedOpt.deliveryMinutes <= 360 ? '🔥 Quick' : '💰 Standard')}* selected\n\n` +
            `Estimated delivery: *${duration}*\n\n` +
            `Enter exact quantity between *${selectedOpt.min.toLocaleString()}* and *${selectedOpt.max.toLocaleString()}*\n\n` +
            `_Price for ${tier.maxQty.toLocaleString()} qty = KES ${priceForMax}_\n` +
            `_Price scales proportionally with quantity_`,
            { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text('🔙 Cancel', 'back_start') }
        );
        return;
    }

    if (data.startsWith('tier_')) {
        const match = data.match(/tier_(\d+)_(\d+)/);
        if (!match) return;
        const serviceId = parseInt(match[1]);
        const tierIdx = parseInt(match[2]);
        const svc = await Service.findOne({ serviceId });
        if (!svc) return ctx.reply("❌ Service not found.");

        const cfg = store.pricingConfig || {};
        const tiers = cfg.tiers || [];
        const tier = tiers[tierIdx];
        if (!tier) return ctx.reply("❌ Tier not found.");

        const displayName = svc.displayName || cleanServiceName(svc);

        // Get rate from options or fallback
        const options = svc.options || [];
        let effectiveRate = parseFloat(svc.rate) || 1;
        let effectiveMin = parseInt(svc.min) || 50;
        let effectiveMax = parseInt(svc.max) || 10000;

        if (options.length > 0) {
            const bestOpt = options.sort((a,b) => a.rate - b.rate)[0];
            effectiveRate = bestOpt.rate;
            effectiveMin = bestOpt.min;
            effectiveMax = bestOpt.max;
        }

        customerPendingInputs.set(userId, {
            action: 'awaiting_qty_in_tier',
            data: { 
                serviceId, tier, serviceName: displayName, 
                platform: detectPlatform(svc), type: detectType(svc), 
                rate: effectiveRate, min: effectiveMin, max: effectiveMax,
                options: options
            }
        });

        const priceForMax = getTierDisplayPrice(effectiveRate, tier.maxQty, cfg);
        await ctx.reply(
            `${tier.label} selected ✅\n\n` +
            `Enter exact quantity between *${tier.minQty.toLocaleString()}* and *${tier.maxQty.toLocaleString()}*\n\n` +
            `_Price for ${tier.maxQty.toLocaleString()} qty = KES ${priceForMax}_\n` +
            `_Price scales proportionally with quantity_`,
            { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text('🔙 Cancel', 'back_start') }
        );
        return;
    }

    if (data.startsWith('cat_')) {
        const category = data.replace('cat_', '');
        const enabled = store.enabledServices?.filter(s => s.isEnabled) || [];
        const services = await Service.find({ serviceId: { $in: enabled.map(s => s.serviceId) }, category, banned: { $ne: true } });
        if (services.length === 0) return ctx.reply("❌ No services in this category.");

        const keyboard = new InlineKeyboard();
        const cfg = store.pricingConfig || {};
        services.forEach(s => {
            const options = s.options || [];
            let bestRate = parseFloat(s.rate) || 1;
            if (options.length > 0) {
                bestRate = options.sort((a,b) => a.rate - b.rate)[0].rate;
            }
            const price = getTierDisplayPrice(bestRate, 500, cfg);
            const displayName = s.displayName || cleanServiceName(s);
            keyboard.text(btnText(`${displayName} — from KES ${price}`), `svc_${s.serviceId}`).row();
        });
        keyboard.text('🔙 Back', 'back_start');

        await ctx.reply(`📂 *${escapeMarkdown(category)}*\n\nSelect a service:`, { parse_mode: "Markdown", reply_markup: keyboard });
        return;
    }
});

// ==========================================
// TEXT INPUTS
// ==========================================
bot.on('message:text', async (ctx) => {
    const state = adminUserState.get(ctx.from.id);
    const customerState = customerPendingInputs.get(ctx.from.id);
    const store = await getDefaultStore();

    console.log(`[TEXT] User ${ctx.from.id} state:`, customerState?.action || 'none', 'Text:', ctx.message.text.substring(0, 30));

    if (state && ADMIN_IDS.includes(ctx.from.id)) {
        const text = ctx.message.text.trim();

        if (state.action === 'awaiting_megapay_key') {
            store.megapayApiKey = text;
            await store.save();
            invalidateStoreCache();
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Megapay API Key updated!`);
            return;
        }
        if (state.action === 'awaiting_megapay_email') {
            store.megapayEmail = text;
            await store.save();
            invalidateStoreCache();
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Megapay Email updated!`);
            return;
        }
        if (state.action === 'awaiting_store_name') {
            store.businessName = text;
            await store.save();
            invalidateStoreCache();
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Store name updated to *${escapeMarkdown(text)}*!`, { parse_mode: "Markdown" });
            return;
        }
        if (state.action === 'awaiting_welcome_msg') {
            store.welcomeMessage = text;
            await store.save();
            invalidateStoreCache();
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Welcome message updated!`);
            return;
        }
        if (state.action === 'awaiting_support_link') {
            store.supportLink = text;
            await store.save();
            invalidateStoreCache();
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Support link updated!`);
            return;
        }
        if (state.action === 'awaiting_banner') {
            store.bannerImage = text;
            await store.save();
            invalidateStoreCache();
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Banner updated!`);
            return;
        }
        if (state.action === 'awaiting_broadcast_msg') {
            adminUserState.delete(ctx.from.id);
            const orders = await Order.find({ botId: store._id });
            const uniqueCustomers = [...new Set(orders.map(o => o.customerTelegramId))];
            let sent = 0, failed = 0;
            for (const cid of uniqueCustomers) {
                try {
                    await bot.api.sendMessage(cid, `📢 *PROMO*\n\n${escapeMarkdown(text)}`, { parse_mode: "Markdown" });
                    sent++; await new Promise(r => setTimeout(r, 50));
                } catch (e) { failed++; }
            }
            await ctx.reply(`✅ Broadcast sent to ${sent} customers (${failed} failed).`);
            return;
        }
    }

    if (customerState) {
        console.log(`[CUSTOMER] Processing state: ${customerState.action} for user ${ctx.from.id}`);

        // === QUANTITY INPUT ===
        if (customerState.action === 'awaiting_qty_in_tier') {
            const rawText = ctx.message.text.trim().replace(/,/g, '');
            const qty = parseInt(rawText);
            const tier = customerState.data?.tier;
            const min = parseInt(customerState.data?.min) || 50;
            const max = parseInt(customerState.data?.max) || 100000;

            console.log(`[QTY] raw="${rawText}" qty=${qty} tier=${JSON.stringify(tier)} min=${min} max=${max}`);

            const tierMin = parseInt(tier?.minQty) || 50;
            const tierMax = parseInt(tier?.maxQty) || 500;

            if (isNaN(qty) || qty < tierMin || qty > tierMax || qty < min || qty > max) {
                await ctx.reply(
                    `❌ Invalid quantity.\n\n` +
                    `• Tier range: *${tierMin.toLocaleString()} - ${tierMax.toLocaleString()}*\n` +
                    `• Service limits: ${min} - ${max}\n\nPlease enter a valid quantity:`,
                    { parse_mode: "Markdown" }
                );
                return;
            }

            const cfg = store.pricingConfig || {};
            const tierMultiplier = parseFloat(tier?.multiplier) || 1.0;
            const rate = parseFloat(customerState.data?.rate) || 1;
            const basePrice = calculateKESPrice(rate, qty, cfg);
            const adjustedPrice = Math.max(20, Math.ceil(basePrice * tierMultiplier / 10) * 10);

            customerState.data.quantity = qty;
            customerState.data.price = adjustedPrice;

            console.log(`[QTY] Success! qty=${qty} price=${adjustedPrice}`);

            // Check for multiple provider options
            const options = customerState.data?.options || [];
            // For old pre-sync data, serviceId WAS the SMM provider ID
            // For new synced data (serviceId >= 1000), we must get providerServiceId from svc.options
            let fallbackProviderId = customerState.data.serviceId;
            if (svc && svc.options && svc.options.length > 0) {
                fallbackProviderId = svc.options[0].providerServiceId;
            }
            const effectiveOptions = options.length > 1 ? options : [{
                provider: 'smmfollows', providerServiceId: fallbackProviderId,
                rate, min, max, refill: false, deliveryMinutes: 240, reliabilityScore: 100
            }];

            if (effectiveOptions.length > 1) {
                customerState.data.options = effectiveOptions;
                customerState.action = 'awaiting_provider_choice';

                let text = `📋 *Choose Delivery Speed*\n\n`;
                text += `Quantity: *${qty.toLocaleString()}*\n`;
                text += `Base Price: *KES ${adjustedPrice}*\n\n`;
                text += `Select your preferred option:\n`;

                const keyboard = new InlineKeyboard();
                effectiveOptions.forEach((opt, idx) => {
                    const optPrice = Math.max(20, Math.ceil(calculateKESPrice(opt.rate, qty, cfg) * tierMultiplier / 10) * 10);
                    const duration = formatDuration(opt.deliveryMinutes);
                    const speedLabel = opt.deliveryMinutes <= 60 ? '⚡ Fast' : (opt.deliveryMinutes <= 360 ? '🔥 Quick' : '💰 Standard');

                    text += `${idx+1}. ${speedLabel}\n`;
                    text += `   KES ${optPrice} | ${duration}\n`;
                    text += `   ${opt.provider === 'peaker' ? 'Premium' : 'Standard'} provider\n\n`;

                    keyboard.text(btnText(`${speedLabel} | KES ${optPrice} | ${duration}`), `provider_${idx}`).row();
                });
                keyboard.text('🔙 Cancel', 'back_start');

                await ctx.reply(text, { parse_mode: "Markdown", reply_markup: keyboard });
                return;
            }

            // Single provider
            customerState.data.selectedProvider = effectiveOptions[0];
            customerState.action = 'awaiting_link';

            await ctx.reply(
                `✅ *Quantity: ${qty.toLocaleString()}*\n` +
                `💰 *Price: KES ${adjustedPrice}*\n\n` +
                `Now send the link or username to promote:\n` +
                `_Examples:_\n` +
                `• Instagram: \`https://instagram.com/username\`\n` +
                `• TikTok: \`https://tiktok.com/@username\`\n` +
                `• YouTube: \`https://youtube.com/watch?v=xxx\`\n` +
                `• Telegram: \`https://t.me/channelname\``,
                { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text('🔙 Cancel', 'back_start') }
            );
            return;
        }

        // === PROVIDER CHOICE ===
        if (customerState.action === 'awaiting_provider_choice') {
            await ctx.reply("⚠️ Please select a delivery speed option from the buttons above.");
            return;
        }

        // === LINK INPUT ===
        if (customerState.action === 'awaiting_link') {
            customerState.data.link = ctx.message.text.trim();
            customerState.action = 'awaiting_payment_confirm';
            const { serviceName, quantity, price, selectedProvider } = customerState.data;
            const duration = selectedProvider ? formatDuration(selectedProvider.deliveryMinutes) : '~2-12 hrs';

            await ctx.reply(
                `📋 *ORDER SUMMARY*\n\n` +
                `🛒 Service: ${escapeMarkdown(serviceName)}\n` +
                `🔗 Link: ${escapeMarkdown(customerState.data.link)}\n` +
                `📊 Quantity: ${quantity.toLocaleString()}\n` +
                `💰 Total: *KES ${price}*\n` +
                `⏱️ Delivery: *${duration}*\n\n` +
                `⏳ *Delivery Notice:* Orders typically start within minutes.\n\n` +
                `Tap *PROCEED TO PAY* to continue 👇`,
                {
                    parse_mode: "Markdown",
                    reply_markup: new InlineKeyboard()
                        .text('💳 PROCEED TO PAY', 'confirm_pay').row()
                        .text('🔙 Cancel', 'back_start')
                }
            );
            return;
        }

        // === PHONE INPUT ===
        if (customerState.action === 'awaiting_payment_phone') {
            let phone = ctx.message.text.trim().replace(/\D/g, '');
            if (phone.startsWith('0')) phone = '254' + phone.slice(1);
            else if (!phone.startsWith('254')) phone = '254' + phone;
            if (phone.length !== 12) { 
                await ctx.reply("❌ Invalid phone. Use format: 07XXXXXXXX"); 
                return; 
            }

            const { serviceId, selectedProvider, serviceName, link, quantity, price } = customerState.data;
            const provider = selectedProvider?.provider || 'smmfollows';
            const providerServiceId = selectedProvider?.providerServiceId || serviceId;
            const reference = `ORD${Date.now()}`;

            const freshStore = await getDefaultStore(true);
            if (!freshStore.megapayApiKey || freshStore.megapayApiKey.length < 10 || !freshStore.megapayEmail || !freshStore.megapayEmail.includes('@')) {
                await ctx.reply("⚠️ Payment not configured. Please contact support.");
                customerPendingInputs.delete(ctx.from.id);
                return;
            }

            try {
                await PendingTransaction.create({
                    reference, type: 'order', phone, amount: price, botId: freshStore._id,
                    customerTelegramId: ctx.from.id, customerChatId: ctx.chat.id,
                    serviceId, provider, providerServiceId, serviceName, link, quantity
                });

                const payload = {
                    api_key: freshStore.megapayApiKey,
                    email: freshStore.megapayEmail,
                    amount: price,
                    msisdn: phone,
                    callback_url: freshStore.megapayWebhookUrl || `${APP_URL}/api/megapay/webhook`,
                    description: `${freshStore.businessName} — ${serviceName} (${quantity})`,
                    reference
                };

                console.log(`[STK-INIT] Order ref=${reference} phone=${phone} amount=${price}`);
                const stkRes = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
                console.log(`[STK-RESPONSE] Order ref=${reference}:`, JSON.stringify(stkRes.data));

                const respCode = stkRes.data?.ResponseCode ?? stkRes.data?.ResultCode ?? 1;
                if (parseInt(respCode) !== 0) {
                    const desc = stkRes.data?.ResponseDescription ?? stkRes.data?.ResultDesc ?? 'Unknown error';
                    await PendingTransaction.updateOne({ reference }, { status: 'failed' });
                    await ctx.reply(`❌ *Payment Failed*\n\nMegapay: ${escapeMarkdown(desc)}`, { parse_mode: "Markdown" });
                    customerPendingInputs.delete(ctx.from.id);
                    return;
                }

                await PendingTransaction.updateOne({ reference }, {
                    megapayTransactionId: stkRes.data?.transaction_request_id || '',
                    megapayMerchantRequestId: stkRes.data?.MerchantRequestID || '',
                    megapayCheckoutRequestId: stkRes.data?.CheckoutRequestID || ''
                });

                customerPendingInputs.delete(ctx.from.id);
                await ctx.reply(
                    `📲 *Check your phone!*\nM-Pesa prompt has been sent.\nEnter your PIN to complete payment.\n\n⏳ Your order will be placed automatically once confirmed.`,
                    { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text('❌ Cancel', 'back_start') }
                );
            } catch (err) {
                console.error('STK Error:', err.message);
                await ctx.reply("❌ Failed to initiate payment. Please try again later.");
            }
            return;
        }
    }    
});

// ==========================================
// WEBHOOK
// ==========================================
app.post('/webhook', async (req, res) => {
    await bot.handleUpdate(req.body);
    res.status(200).send('OK');
});

// ==========================================
// MEGAPAY WEBHOOK
// ==========================================
async function handleMegapayWebhook(req, res) {
    res.status(200).send("OK");
    const raw = req.rawBody || JSON.stringify(req.body);
    console.log(`[WEBHOOK-RAW] ${raw}`);
    const data = req.body;
    if (!data || Object.keys(data).length === 0) { console.error('[WEBHOOK] Empty body'); return; }

    const p = normalizeMegapayPayload(data);
    console.log(`[WEBHOOK] Normalized: code=${p.responseCode}, ref=${p.reference}, receipt=${p.receipt}, amount=${p.amount}, phone=${p.phone}`);

    try {
        if (parseInt(p.responseCode) !== 0) { console.log(`[WEBHOOK] Payment failed`); return; }

        const amount = parseFloat(p.amount || 0);
        const receipt = p.receipt || 'N/A';
        const rawPhone = (p.phone || "").toString();
        let tx = null;

        if (p.reference) { tx = await PendingTransaction.findOne({ reference: p.reference, status: 'pending' }); }
        if (!tx && rawPhone) {
            const last9 = rawPhone.replace(/\D/g, '').slice(-9);
            if (last9.length >= 9) { tx = await PendingTransaction.findOne({ phone: { $regex: last9 + '$' }, status: 'pending' }).sort({ createdAt: -1 }); }
        }
        if (!tx && p.merchantRequestId) tx = await PendingTransaction.findOne({ megapayMerchantRequestId: p.merchantRequestId, status: 'pending' });
        if (!tx && p.checkoutRequestId) tx = await PendingTransaction.findOne({ megapayCheckoutRequestId: p.checkoutRequestId, status: 'pending' });
        if (!tx && p.transactionRequestId) tx = await PendingTransaction.findOne({ megapayTransactionId: p.transactionRequestId, status: 'pending' });
        if (!tx) { console.log(`[WEBHOOK] No pending tx matched`); return; }

        console.log(`[WEBHOOK] Matched: type=${tx.type}, ref=${tx.reference}`);

        const store = await getDefaultStore(true);
        if (!store) { console.log('[WEBHOOK] No default store'); return; }

        if (tx.type === 'order') {
            console.log(`[WEBHOOK] Fulfilling order`);
            const svc = await Service.findOne({ serviceId: tx.serviceId });
            const displayName = svc?.displayName || cleanServiceName(svc) || tx.serviceName || 'Unknown';

            const provider = tx.provider || 'smmfollows';
            const providerServiceId = tx.providerServiceId || tx.serviceId;
            const apiUrl = provider === 'peaker' ? PEAKER_API_URL : SMM_API_URL;
            const apiKey = provider === 'peaker' ? PEAKER_API_KEY : SMM_API_KEY;

            // Resolve the REAL provider service ID — never use internal serviceId as fallback
            let providerServiceId = tx.providerServiceId;

            // If not in tx, look up from Service document options
            if (!providerServiceId && svc && svc.options && svc.options.length > 0) {
                const matchingOpt = svc.options.find(o => o.provider === provider) || svc.options[0];
                providerServiceId = matchingOpt?.providerServiceId;
                console.log(`[WEBHOOK] Resolved providerServiceId from Service.options: ${providerServiceId}`);
            }

            // Last resort: for OLD pre-sync data, serviceId WAS the SMM ID
            if (!providerServiceId && svc && svc.serviceId < 1000) {
                providerServiceId = svc.serviceId;
                console.log(`[WEBHOOK] Using legacy serviceId as providerServiceId: ${providerServiceId}`);
            }

            if (!providerServiceId) {
                console.error(`[WEBHOOK] CRITICAL: Could not resolve providerServiceId for service ${tx.serviceId}`);
            }

            let smmOrderId = null;
            let smmError = null;

            // Attempt 1: JSON payload
            try {
                const payload = {
                    key: apiKey,
                    action: 'add',
                    service: String(providerServiceId),
                    link: tx.link,
                    quantity: Number(tx.quantity)
                };
                console.log(`[SMM-ADD] JSON Request → ${apiUrl}`, JSON.stringify(payload));
                const smmRes = await axios.post(apiUrl, payload, { 
                    timeout: 30000,
                    headers: { 'Content-Type': 'application/json' }
                });
                console.log(`[SMM-ADD] JSON Response ←`, JSON.stringify(smmRes.data));
                if (smmRes.data && smmRes.data.order) {
                    smmOrderId = String(smmRes.data.order);
                    console.log(`[WEBHOOK] SMM order placed: ${smmOrderId}`);
                } else if (smmRes.data && smmRes.data.error) {
                    smmError = `SMM API error: ${smmRes.data.error}`;
                    console.error(`[WEBHOOK] SMM API rejected:`, smmRes.data);
                } else {
                    smmError = `SMM API returned no order. Response: ${JSON.stringify(smmRes.data)}`;
                    console.error(`[WEBHOOK] SMM add failed:`, smmRes.data);
                }
            } catch (smmErr) {
                smmError = `JSON request failed: ${smmErr.message}`;
                console.error(`[WEBHOOK] SMM API error (JSON):`, smmErr.message);
                if (smmErr.response) {
                    console.error(`[WEBHOOK] SMM response status:`, smmErr.response.status);
                    console.error(`[WEBHOOK] SMM response data:`, JSON.stringify(smmErr.response.data));
                }

                // Attempt 2: Form-encoded fallback (many SMM panels require this)
                try {
                    const params = new URLSearchParams();
                    params.append('key', apiKey);
                    params.append('action', 'add');
                    params.append('service', String(providerServiceId));
                    params.append('link', tx.link);
                    params.append('quantity', String(tx.quantity));
                    console.log(`[SMM-ADD] Form-encoded Request → ${apiUrl}`, params.toString());
                    const smmRes2 = await axios.post(apiUrl, params.toString(), {
                        timeout: 30000,
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                    });
                    console.log(`[SMM-ADD] Form-encoded Response ←`, JSON.stringify(smmRes2.data));
                    if (smmRes2.data && smmRes2.data.order) {
                        smmOrderId = String(smmRes2.data.order);
                        smmError = null;
                        console.log(`[WEBHOOK] SMM order placed (form-encoded): ${smmOrderId}`);
                    } else if (smmRes2.data && smmRes2.data.error) {
                        smmError += ` | Form-encoded error: ${smmRes2.data.error}`;
                        console.error(`[WEBHOOK] SMM API rejected (form-encoded):`, smmRes2.data);
                    } else {
                        smmError += ` | Form-encoded also returned no order: ${JSON.stringify(smmRes2.data)}`;
                    }
                } catch (smmErr2) {
                    smmError += ` | Form-encoded failed: ${smmErr2.message}`;
                    console.error(`[WEBHOOK] SMM API error (form-encoded):`, smmErr2.message);
                    if (smmErr2.response) {
                        console.error(`[WEBHOOK] SMM form-encoded response:`, JSON.stringify(smmErr2.response.data));
                    }
                }
            }

            const order = await Order.create({
                botId: store._id,
                customerTelegramId: tx.customerTelegramId,
                customerChatId: tx.customerChatId,
                serviceId: tx.serviceId,
                provider,
                providerServiceId,
                serviceName: displayName,
                link: tx.link,
                quantity: tx.quantity,
                price: amount,
                smmOrderId: smmOrderId || 'PENDING',
                status: smmOrderId ? 'processing' : 'pending',
                refillEligible: svc?.options?.some(o => o.refill) || false
            });

            await Transaction.create({
                botId: store._id,
                serviceId: tx.serviceId,
                serviceName: displayName,
                customerTelegramId: tx.customerTelegramId,
                customerUsername: '',
                phone: tx.phone,
                amount,
                mpesaReceipt: receipt,
                status: 'completed'
            });

            let successText = `🎉 *PAYMENT SUCCESSFUL!*\n\nThank you for your order!\n\n💰 *DETAILS*\n• Service: ${escapeMarkdown(order.serviceName)}\n• Quantity: ${order.quantity.toLocaleString()}\n• Link: ${escapeMarkdown(order.link)}\n• Amount: KES ${amount}\n• Receipt: ${receipt}\n• Order ID: \`${order.smmOrderId}\``;
            if (smmOrderId && smmOrderId !== 'PENDING') {
                successText += `\n\n⏳ *Delivery:* Your order is now processing. Delivery times vary by platform and quantity (usually minutes, occasionally up to 24h for large orders).`;
                successText += `\n\nYou can check your order status anytime below 👇`;
                if (order.refillEligible) successText += `\n\n🔄 *Refill available* for 30 days. Use /refill ${order.smmOrderId} if drops occur.`;
            } else {
                successText += `\n\n⚠️ *Auto-placement failed.*\n\n_Reason: ${escapeMarkdown(smmError || 'Unknown error')}_\n\nAdmin has been notified and will fulfill your order manually. Your payment is secure.`;
            }

            try {
                await bot.api.sendMessage(tx.customerTelegramId, successText, {
                    parse_mode: "Markdown",
                    protect_content: true,
                    reply_markup: new InlineKeyboard()
                        .text(`📋 Check Status`, `status_${order.smmOrderId}`).row()
                        .text(`🔙 Main Menu`, 'back_start')
                });
            } catch (sendErr) { console.error(`[WEBHOOK] Failed to notify customer:`, sendErr.message); }

            if (store.adminAlertChatId) {
                try {
                    let alertText = `✅ *New Sale!*\n\n📦 ${escapeMarkdown(order.serviceName)}\n🔗 ${escapeMarkdown(order.link)}\n📊 ${order.quantity.toLocaleString()} qty\n💵 KES ${amount}\n🧾 ${receipt}\n📱 ${tx.phone}`;
                    if (smmError) {
                        alertText += `\n\n⚠️ *AUTO-PLACEMENT FAILED*\n${escapeMarkdown(smmError)}\n\nProvider: ${provider}\nProviderServiceId: ${providerServiceId}\nServiceId: ${tx.serviceId}`;
                    }
                    await bot.api.sendMessage(store.adminAlertChatId, alertText, { parse_mode: "Markdown" });
                } catch (e) { console.log('[WEBHOOK] Owner alert failed:', e.message); }
            }

            if (ADMIN_CHANNEL_ID) {
                try { await bot.api.sendMessage(ADMIN_CHANNEL_ID, `💰 Sale: KES ${amount} — ${escapeMarkdown(order.serviceName)}`, { parse_mode: "Markdown" }); } catch (e) {}
            }

            console.log(`✅ Order complete: ${order.serviceName} for KES ${amount}`);
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
    res.json({ status: 'alive', message: 'Megapay webhook endpoint reachable.', url: `${APP_URL}/api/megapay/webhook`, timestamp: new Date().toISOString() });
});

// ==========================================
// MINI APP API
// ==========================================

app.post('/api/upload', validateInitData, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    // Ensure APP_URL has no trailing slash
    const baseUrl = APP_URL.replace(/\/$/, '');
    const url = `${baseUrl}/uploads/${req.file.filename}`;
    res.json({ success: true, url, name: req.file.originalname, size: req.file.size });
});

app.get('/api/me', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    res.json({ id: merchant._id, telegramId: merchant.telegramId, username: merchant.username, firstName: merchant.firstName, status: 'active' });
});

app.get('/api/services', validateInitData, async (req, res) => {
    const services = await Service.find({ banned: { $ne: true } }).sort({ category: 1, serviceId: 1 });
    res.json(services);
});

// ==========================================
// DUAL API SYNC
// ==========================================
const BANNED_SERVICES = [
    'nigeria', 'nigerian', '🇳🇬', 'brazil', 'brazilian', '🇧🇷', 'india', 'indian', '🇮🇳',
    'russia', 'russian', '🇷🇺', 'ukraine', 'ukrainian', '🇺🇦', 'usa', 'american', 'united states', '🇺🇸',
    'turkey', 'turkish', '🇹🇷', 'france', 'french', '🇫🇷', 'china', 'chinese', '🇨🇳',
    'japan', 'japanese', '🇯🇵', 'korea', 'korean', '🇰🇷', 'vietnam', 'vietnamese', '🇻🇳',
    'bangladesh', 'indonesia', 'italy', 'italian', 'pakistan', 'pakistani', 'philippines', 'filipino',
    'saudi', 'arabia', 'taiwan', 'thailand', 'uae', 'emirates', 'germany', 'german', 'uk', 'british',
    'spain', 'spanish', 'mexico', 'mexican', 'canada', 'canadian', 'europe', 'european', 'africa', 'asia',
    'shares', 'saves', 'bookmarks', 'retweets', 'impressions', 'poll', 'vote', 'space listeners',
    'trend topic', 'dislikes', 'mass dm', 'bot start', 'boost channel', 'reactions', 'comments likes',
    'comments replay', 'social shares', 'live stream', 'livestream', 'premiere', 'watchtime',
    'watch hours', 'seo', 'adwords', 'monetization', 'monetizable', 'organic discovery', 'keyword',
    'retention', 'ctr', 'concurrent', 'pk battle', 'auto post', 'auto likes', 'auto views', 'emergency',
    'nft', 'gradual tweet', 'interactions', 'other service', 'packages', 'mix seo', 'premium members',
    'premium views', 'shorts', 'community', 'extended', 'native ads', 'rav', 'apv', 'gs', 'mts', 'mms',
    'by gender', 'by niche', 'by retention', 'from referrer', 'search engine', 'shopping', 'forum',
    'news', 'social media', 'by keywords', 'by topic', 'suggest by ai', 'created by ai', 'powerd by ai',
    'ai generated', 'ai smart', 'auto future', 'discussion', 'search ranking', 'online accounts',
    'join from search', 'views from followers', 'paid reactions', 'post shares', 'votes', 'clone',
    'spotify', 'soundcloud', 'twitch', 'linkedin', 'pinterest', 'tumblr', 'vk', 'ok.ru',
    'discord', 'clubhouse', 'kwai', 'likee', 'bigolive', 'trovo', 'dlive', 'vimeo',
    'dailymotion', 'rumble', 'odysee', 'bitchute', 'brighteon', 'bilibili', 'weibo',
    'line', 'kakao', 'naver', 'zalo', 'viber', 'wechat', 'qq',
    'onlyfans', 'fansly', 'patreon', 'cameo', 'gofundme', 'kickstarter',
    'trustpilot', 'sitejabber', 'yelp', 'google maps', 'google review',
    'app install', 'app rating', 'app review', 'ios', 'android', 'apk',
    'website', 'web traffic', 'direct traffic', 'referral', 'bounce',
    'alexa', 'domain', 'backlink', 'guest post', 'press release',
    'coinmarketcap', 'coingecko', 'crypto', 'token', 'nft drop',
    'minecraft', 'roblox', 'steam', 'epic games', 'origin', 'uplay',
    'playstation', 'xbox', 'nintendo', 'game', 'gaming',
    'quora', 'medium', 'substack', 'ghost', 'wordpress', 'blogger',
    'behance', 'dribbble', 'deviantart', 'artstation', 'pixiv',
    'fiverr', 'upwork', 'freelancer', 'peopleperhour',
    'shopee', 'lazada', 'amazon review', 'ebay feedback', 'etsy',
    'alibaba', 'aliexpress', 'daraz', 'jumia', 'konga', 'olx',
    'netflix', 'hulu', 'disney', 'hbo', 'prime video', 'apple tv',
    'only fans', 'fansly', 'justforfans', 'manyvids', 'avn stars',
    // Known broken services
    'fb comment', 'facebook comment', 'comment facebook', 'comments facebook',
    'fb group', 'facebook group', 'group member', 'fb members',
    'instagram comment', 'ig comment', 'twitter comment', 'tweet comment'
];

function isBanned(text) {
    const t = text.toLowerCase();
    return BANNED_SERVICES.some(b => t.includes(b));
}

function scoreService(s) {
    const text = `${s.name || ''} ${s.category || ''}`.toLowerCase();
    let score = 0;
    const rate = parseFloat(s.rate) || 999;
    const minQty = parseInt(s.min) || 999999;
    const maxQty = parseInt(s.max) || 0;

    if (rate < 0.3) score += 30;
    else if (rate < 0.6) score += 20;
    else if (rate < 1.0) score += 15;
    else if (rate < 1.5) score += 10;
    else if (rate < 2.0) score += 5;
    else if (rate > 5.0) score -= 15;
    else if (rate > 10.0) score -= 30;
    else if (rate > 20.0) score -= 50;

    if (maxQty >= 50000) score += 10;
    else if (maxQty >= 10000) score += 7;
    else if (maxQty >= 5000) score += 5;
    else if (maxQty >= 1000) score += 3;
    else if (maxQty < 500) score -= 5;

    if (minQty <= 10) score += 10;
    else if (minQty <= 50) score += 7;
    else if (minQty <= 100) score += 5;
    else if (minQty <= 500) score += 2;
    else if (minQty > 1000) score -= 10;

    if (text.includes('refill')) score += 8;
    if (text.includes('non drop')) score += 8;
    if (text.includes('no drop')) score += 8;
    if (text.includes('real')) score += 3;
    if (text.includes('active')) score += 3;

    if (text.includes('bot')) score -= 5;
    if (text.includes('fake')) score -= 10;
    if (text.includes('proxy')) score -= 5;
    if (text.includes('cracked')) score -= 20;
    if (text.includes('hacked')) score -= 30;

    return score;
}

async function fetchProviderServices(apiUrl, apiKey, providerName) {
    try {
        const res = await axios.post(apiUrl, { key: apiKey, action: 'services' }, { timeout: 60000 });
        if (!Array.isArray(res.data)) return [];
        return res.data.map(s => ({
            provider: providerName,
            providerServiceId: Number(s.service),
            name: s.name,
            category: s.category,
            type: s.type,
            rate: parseFloat(s.rate) || 0,
            min: parseInt(s.min) || 0,
            max: parseInt(s.max) || 0,
            refill: !!s.refill,
            cancel: !!s.cancel,
            deliveryMinutes: estimateDeliveryMinutes(s.name, s.category),
            score: scoreService(s)
        }));
    } catch (e) {
        console.error(`[SYNC] ${providerName} fetch failed:`, e.message);
        return [];
    }
}

app.post('/api/services/sync', validateInitData, async (req, res) => {
    if (!ADMIN_IDS.includes(req.telegramUser.id)) return res.status(403).json({ error: 'Forbidden' });
    try {
        const platforms = ['twitter', 'facebook', 'tiktok', 'instagram', 'youtube', 'telegram', 'reddit', 'snapchat', 'whatsapp'];
        const actions = ['followers', 'subscribers', 'members', 'views', 'likes', 'comments'];

        // Fetch from both APIs (Peaker is optional)
        const smmServices = await fetchProviderServices(SMM_API_URL, SMM_API_KEY, 'smmfollows');
        let peakerServices = [];
        if (PEAKER_API_KEY && PEAKER_API_KEY.length > 5) {
            try {
                peakerServices = await fetchProviderServices(PEAKER_API_URL, PEAKER_API_KEY, 'peaker');
            } catch (e) {
                console.log('[SYNC] Peaker API skipped:', e.message);
            }
        }

        const allRaw = [...smmServices, ...peakerServices];

        // Filter valid services
        const validServices = [];
        for (const s of allRaw) {
            const text = `${s.category || ''} ${s.name || ''}`.toLowerCase();
            const hasPlatform = platforms.some(p => text.includes(p));
            const hasAction = actions.some(a => text.includes(a));
            if (!hasPlatform || !hasAction) continue;
            if (isBanned(text)) continue;
            if (s.score < -50) continue;
            validServices.push(s);
        }

        // Group by (platform, type, provider) and pick best per provider
        const byPlatformTypeProvider = new Map();
        for (const s of validServices) {
            const plat = detectPlatform({ category: s.category, name: s.name });
            const typ = detectType({ category: s.category, name: s.name });
            const key = `${plat}_${typ}_${s.provider}`;
            if (!byPlatformTypeProvider.has(key)) byPlatformTypeProvider.set(key, []);
            byPlatformTypeProvider.get(key).push(s);
        }

        // Pick winner per provider per platform/type
        const providerWinners = [];
        for (const [key, group] of byPlatformTypeProvider) {
            group.sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return a.rate - b.rate;
            });
            providerWinners.push(group[0]);
        }

        // Group by (platform, type) to merge providers
        const byPlatformType = new Map();
        for (const s of providerWinners) {
            const plat = detectPlatform({ category: s.category, name: s.name });
            const typ = detectType({ category: s.category, name: s.name });
            const key = `${plat}_${typ}`;
            if (!byPlatformType.has(key)) byPlatformType.set(key, []);
            byPlatformType.get(key).push(s);
        }

        // Build final services with options array
        const cleanServices = [];
        let serviceIdCounter = 1000;

        for (const [key, group] of byPlatformType) {
            const [plat, typ] = key.split('_');
            const platformName = PLATFORM_META[plat]?.name || plat;
            const typeName = typ === 'other' ? 'Boost' : typ.charAt(0).toUpperCase() + typ.slice(1);
            const displayName = `${platformName} ${typeName}`;

            // Clean name
            let cleanName = group[0].name;
            const noise = ['100% active real', '100% real humans', 'active real', 'real humans', 'real', 'active',
                'hq', 'high quality', 'cheapest', 'cheap', 'fast', 'speed', 'stable', 'new', 'online',
                'instant', 'quick', 'super', 'ultra', 'premium', 'best', 'top', 'guaranteed',
                'non drop', 'no drop', 'drop', 'lifetime', 'permanent', 'organic', 'natural',
                'worldwide', 'global', 'international', 'mixed', 'random', 'targeted',
                'start', '0-1 hour', '0-12 hour', '1-24 hour', 'up to', 'within', 'delivery',
                'daily', 'instantly', 'auto', 'gradual', 'drip feed', 'slow', 'normal', 'express',
                'extra', 'bonus', 'free', 'gift', 'trial', 'test', 'sample', 'demo',
                'refill', 'refillable', '30 days', '90 days', '180 days',
                'working', 'functioning', 'operational', 'updated', 'latest', 'version',
                'server', 'panel', 'api', 'smm', 'reseller', 'provider', 'supplier',
                'max', 'min', 'minimum', 'maximum', 'limit', 'range', 'qty', 'quantity',
                'per day', 'per hour', 'per minute', 'per second', 'hourly', 'daily',
                'source', 'method', 'type', 'category', 'class', 'tier', 'level',
                'bot', 'script', 'software', 'tool', 'program', 'app', 'botting',
                'male', 'female', 'gender', 'age', 'demographic', 'niche', 'interest',
                'arab', 'african', 'asian', 'european', 'american', 'latin',
                'usa', 'uk', 'ca', 'au', 'eu', 'asia', 'africa', 'latam',
                'old', 'aged', 'fresh', 'newly created', 'pva', 'phone verified',
                'non pva', 'email verified', 'verified', 'unverified', 'blank',
                'profile pic', 'bio', 'posts', 'story', 'highlight', 'reel',
                'private', 'public', 'open', 'closed', 'secret', 'hidden',
                'group', 'channel', 'page', 'account', 'profile', 'user',
                'custom', 'personalized', 'tailored', 'bespoke', 'unique',
                'high', 'low', 'medium', 'standard', 'basic', 'advanced', 'pro',
                'vip', 'elite', 'exclusive', 'premium', 'gold', 'silver', 'bronze',
                'starter', 'beginner', 'intermediate', 'expert', 'master', 'legend',
                'package', 'bundle', 'combo', 'deal', 'offer', 'promo', 'sale',
                'discount', 'special', 'limited', 'flash', 'mega', 'super', 'hyper',
                'ultra', 'extreme', 'ultimate', 'supreme', 'max', 'plus', 'extra',
                'lite', 'mini', 'micro', 'nano', 'small', 'medium', 'large', 'xl',
                '1k', '2k', '5k', '10k', '50k', '100k', '1m', 'per 1k', 'per 1000',
                '₹', '$', '€', '£', '¥', 'usd', 'eur', 'gbp', 'inr', 'idr', 'rub',
                'just', 'only', 'merely', 'simply', 'purely', 'exactly', 'precisely',
                'about', 'around', 'approximately', 'roughly', 'nearly', 'almost',
                'more than', 'less than', 'over', 'under', 'below', 'above',
                'from', 'to', 'between', 'and', 'or', 'with', 'without', 'plus',
                'including', 'excluding', 'except', 'besides', 'apart from'];

            noise.forEach(word => {
                const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                cleanName = cleanName.replace(re, '');
            });
            cleanName = cleanName.replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
            cleanName = cleanName.replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '').replace(/\s+/g, ' ').trim();
            cleanName = cleanName.replace(/[\u{1F300}-\u{1F9FF}]/gu, '').replace(/\s+/g, ' ').trim();

            const options = group.map(g => ({
                provider: g.provider,
                providerServiceId: g.providerServiceId,
                rate: g.rate,
                min: g.min,
                max: g.max,
                refill: g.refill,
                cancel: g.cancel,
                deliveryMinutes: g.deliveryMinutes,
                reliabilityScore: 100
            }));

            cleanServices.push({
                serviceId: serviceIdCounter++,
                name: cleanName || displayName,
                displayName: displayName,
                type: typ,
                category: plat,
                platform: plat,
                options: options,
                banned: false
            });
        }

        await Service.deleteMany({});
        if (cleanServices.length > 0) {
            await Service.insertMany(cleanServices, { ordered: false });
        }

        console.log(`[SYNC] ${allRaw.length} raw → ${validServices.length} valid → ${providerWinners.length} provider winners → ${cleanServices.length} unique services`);
        res.json({ success: true, count: cleanServices.length, breakdown: `${allRaw.length} raw → ${cleanServices.length} unique services` });
    } catch (err) {
        console.error('Sync error:', err.message);
        res.status(500).json({ error: 'Sync failed', detail: err.message });
    }
});

app.get('/api/store', validateInitData, async (req, res) => {
    const store = await getDefaultStore();
    if (!store) return res.status(404).json({ error: 'Store not configured' });
    res.json({
        _id: store._id,
        botName: store.businessName,
        botUsername: store.botUsername,
        status: store.status,
        welcomeMessage: store.welcomeMessage,
        welcomePhoto: store.welcomePhoto,
        bannerImageUrl: store.bannerImage,
        adminAlertChatId: store.adminAlertChatId,
        supportLink: store.supportLink,
        megapayApiKey: store.megapayApiKey ? '••••' + store.megapayApiKey.slice(-4) : '',
        megapayEmail: store.megapayEmail,
        megapayWebhookUrl: store.megapayWebhookUrl,
        enabledServices: store.enabledServices || [],
        pricingConfig: store.pricingConfig || {},
        expiresAt: store.expiresAt,
        daysLeft: store.expiresAt ? Math.max(0, Math.ceil((store.expiresAt - new Date()) / (1000 * 60 * 60 * 24))) : 0,
        createdAt: store.createdAt
    });
});

app.put('/api/store', validateInitData, async (req, res) => {
    const updates = { ...req.body };
    delete updates._id; delete updates.botUsername; delete updates.botId;
    if (updates.megapayApiKey === '') delete updates.megapayApiKey;
    if (updates.megapayEmail === '') delete updates.megapayEmail;
    invalidateStoreCache();
    const store = await BotInstance.findOneAndUpdate({ isDefault: true }, updates, { returnDocument: 'after', upsert: true });
    defaultStore = store;
    res.json(store);
});

app.get('/api/pricing/config', validateInitData, async (req, res) => {
    const store = await getDefaultStore();
    if (!store) return res.status(404).json({ error: 'No store' });
    res.json(store.pricingConfig || {});
});

app.put('/api/pricing/config', validateInitData, async (req, res) => {
    if (!ADMIN_IDS.includes(req.telegramUser.id)) return res.status(403).json({ error: 'Forbidden' });
    const { exchangeRate, markupMultiplier, tiers } = req.body;
    const store = await BotInstance.findOneAndUpdate(
        { isDefault: true },
        { pricingConfig: { exchangeRate, markupMultiplier, tiers } },
        { returnDocument: 'after' }
    );
    invalidateStoreCache();
    defaultStore = store;
    res.json({ success: true, pricingConfig: store.pricingConfig });
});

app.get('/api/store/services', validateInitData, async (req, res) => {
    const store = await getDefaultStore();
    if (!store) return res.status(404).json({ error: 'Store not configured' });
    const globalServices = await Service.find({ banned: { $ne: true } }).sort({ category: 1, serviceId: 1 });
    const enabledMap = new Map((store.enabledServices || []).map(s => [s.serviceId, s]));
    const merged = globalServices.map(s => {
        const cfg = enabledMap.get(s.serviceId);
        return {
            serviceId: s.serviceId,
            name: s.displayName || s.name,
            rawName: s.name,
            category: s.category,
            type: s.type,
            platform: s.platform,
            options: s.options || [],
            isEnabled: cfg?.isEnabled || false,
            customPrice: cfg?.customPrice || 0
        };
    });
    res.json(merged);
});

app.put('/api/store/services', validateInitData, async (req, res) => {
    const { enabledServices } = req.body;
    invalidateStoreCache();
    const store = await BotInstance.findOneAndUpdate(
        { isDefault: true },
        { enabledServices: enabledServices || [] },
        { returnDocument: 'after', upsert: true }
    );
    defaultStore = store;
    res.json({ success: true });
});

app.get('/api/orders', validateInitData, async (req, res) => {
    const store = await getDefaultStore();
    if (!store) return res.status(404).json({ error: 'No store' });
    const orders = await Order.find({ botId: store._id }).sort({ createdAt: -1 }).limit(100);
    res.json(orders);
});

app.post('/api/orders/:orderId/refill', validateInitData, async (req, res) => {
    const store = await getDefaultStore();
    if (!store) return res.status(404).json({ error: 'No store' });
    const order = await Order.findOne({ _id: req.params.orderId, botId: store._id });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.refillEligible) return res.status(400).json({ error: 'Not eligible' });
    if (order.refillRequested) return res.status(400).json({ error: 'Already requested' });
    const daysSince = (new Date() - order.createdAt) / (1000 * 60 * 60 * 24);
    if (daysSince > 30) return res.status(400).json({ error: '30-day window expired' });

    try {
        const apiUrl = order.provider === 'peaker' ? PEAKER_API_URL : SMM_API_URL;
        const apiKey = order.provider === 'peaker' ? PEAKER_API_KEY : SMM_API_KEY;
        const smmRes = await axios.post(apiUrl, { key: apiKey, action: 'refill', order: order.smmOrderId }, { timeout: 30000 });
        order.refillRequested = true;
        order.refillStatus = smmRes.data?.refill || smmRes.data?.status || 'Requested';
        await order.save();
        res.json({ success: true, status: order.refillStatus });
    } catch (err) {
        res.status(500).json({ error: 'Refill failed', detail: err.message });
    }
});

app.get('/api/transactions', validateInitData, async (req, res) => {
    const store = await getDefaultStore();
    const txns = await Transaction.find({ botId: store?._id }).sort({ createdAt: -1 }).limit(50);
    res.json(txns);
});

app.get('/api/stats', validateInitData, async (req, res) => {
    const store = await getDefaultStore();
    const now = new Date();
    const totalOrders = await Order.countDocuments({ botId: store?._id });
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayOrders = await Order.countDocuments({ botId: store?._id, createdAt: { $gte: todayStart } });
    const totalSales = await Transaction.aggregate([{ $match: { botId: store?._id, status: 'completed' } }, { $group: { _id: null, total: { $sum: '$amount' } } }]);
    const txnCount = await Transaction.countDocuments({ botId: store?._id, status: 'completed' });
    res.json({
        activeBots: 1,
        activeSubscriptions: store?.status === 'active' ? 1 : 0,
        todayOrders,
        totalOrders,
        revenue: totalSales[0]?.total || 0,
        transactions: txnCount,
        status: store?.status || 'inactive'
    });
});

// ==========================================
// WEB CUSTOMER API (No Telegram Auth)
// ==========================================
app.get('/api/web/services', async (req, res) => {
    const store = await getDefaultStore();
    const enabled = store?.enabledServices?.filter(s => s.isEnabled) || [];
    let services = await Service.find({ serviceId: { $in: enabled.map(s => s.serviceId) }, banned: { $ne: true } }).sort({ platform: 1, type: 1 });

    // Fallback: if services lack platform field (old schema), derive from category/name
    services = services.map(s => {
        if (!s.platform) {
            const text = `${s.category || ''} ${s.name || ''}`.toLowerCase();
            const platforms = ['twitter', 'facebook', 'tiktok', 'instagram', 'youtube', 'telegram', 'reddit', 'snapchat', 'whatsapp'];
            for (const p of platforms) {
                if (text.includes(p)) { s.platform = p; break; }
            }
            if (!s.platform) s.platform = s.category || 'other';
        }
        if (!s.type) {
            const text = `${s.category || ''} ${s.name || ''}`.toLowerCase();
            const types = ['followers', 'subscribers', 'members', 'views', 'likes', 'comments'];
            for (const t of types) {
                if (text.includes(t)) { s.type = t; break; }
            }
            if (!s.type) s.type = 'other';
        }
        return s;
    });

    res.json(services);
});

app.get('/api/web/store', async (req, res) => {
    const store = await getDefaultStore();
    if (!store) return res.status(404).json({ error: 'Store not configured' });
    res.json({
        botName: store.businessName,
        welcomeMessage: store.welcomeMessage,
        welcomePhoto: store.welcomePhoto,
        supportLink: store.supportLink,
        pricingConfig: store.pricingConfig || {}
    });
});

app.post('/api/web/order/init', async (req, res) => {
    const { serviceId, optionIdx, quantity, link, phone, customerName } = req.body;
    if (!serviceId || optionIdx === undefined || !quantity || !link || !phone) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const store = await getDefaultStore();
    if (!store) return res.status(404).json({ error: 'Store not configured' });

    const svc = await Service.findOne({ serviceId });
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const options = svc.options || [];
    const selectedOpt = options[optionIdx];
    if (!selectedOpt) return res.status(404).json({ error: 'Option not found' });

    const cfg = store.pricingConfig || {};
    const price = Math.max(20, Math.ceil(calculateKESPrice(selectedOpt.rate, quantity, cfg) / 10) * 10);
    const reference = `WEB${Date.now()}`;

    // Create web session
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await WebSession.create({ sessionId, phone, customerName: customerName || 'Web Customer' });

    // Create pending tx
    await PendingTransaction.create({
        reference, type: 'order', phone, amount: price, botId: store._id,
        customerTelegramId: 0, // Web customer
        serviceId, provider: selectedOpt.provider, providerServiceId: selectedOpt.providerServiceId,
        serviceName: svc.displayName || cleanServiceName(svc), link, quantity
    });

    webPendingInputs.set(sessionId, {
        reference, serviceId, provider: selectedOpt.provider, providerServiceId: selectedOpt.providerServiceId,
        serviceName: svc.displayName || cleanServiceName(svc), link, quantity, price, phone
    });

    res.json({ success: true, reference, sessionId, price, serviceName: svc.displayName || cleanServiceName(svc) });
});

app.post('/api/web/pay/stk', async (req, res) => {
    const { sessionId, reference } = req.body;
    const state = webPendingInputs.get(sessionId);
    if (!state) return res.status(400).json({ error: 'Session expired' });

    const store = await getDefaultStore(true);
    if (!store.megapayApiKey || !store.megapayEmail) {
        return res.status(400).json({ error: 'Payment not configured' });
    }

    try {
        const payload = {
            api_key: store.megapayApiKey,
            email: store.megapayEmail,
            amount: state.price,
            msisdn: state.phone,
            callback_url: `${APP_URL}/api/megapay/webhook`,
            description: `${store.businessName} — ${state.serviceName} (${state.quantity})`,
            reference
        };

        const stkRes = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload);
        const respCode = stkRes.data?.ResponseCode ?? stkRes.data?.ResultCode ?? 1;

        if (parseInt(respCode) !== 0) {
            return res.status(400).json({ error: stkRes.data?.ResponseDescription || stkRes.data?.ResultDesc || 'Payment failed' });
        }

        await PendingTransaction.updateOne({ reference }, {
            megapayTransactionId: stkRes.data?.transaction_request_id || '',
            megapayMerchantRequestId: stkRes.data?.MerchantRequestID || '',
            megapayCheckoutRequestId: stkRes.data?.CheckoutRequestID || ''
        });

        res.json({ success: true, message: 'STK push sent to your phone' });
    } catch (err) {
        console.error('Web STK Error:', err.message);
        res.status(500).json({ error: 'Failed to initiate payment' });
    }
});

app.get('/api/web/order/status', async (req, res) => {
    const { reference } = req.query;
    if (!reference) return res.status(400).json({ error: 'Missing reference' });

    const tx = await PendingTransaction.findOne({ reference });
    if (!tx) return res.status(404).json({ error: 'Order not found' });

    const order = await Order.findOne({ reference });
    res.json({ 
        status: tx.status, 
        orderStatus: order?.status || 'pending',
        smmOrderId: order?.smmOrderId || null
    });
});

// ==========================================
// ROUTES
// ==========================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', appUrl: APP_URL, timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin route — serves admin.html
app.get('/admin', (req, res) => {
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
cron.schedule('*/15 * * * *', async () => {
    console.log('⏰ Checking SMM order statuses...');
    const store = await getDefaultStore();
    if (!store) return;
    const orders = await Order.find({ botId: store._id, status: { $in: ['pending', 'processing', 'In progress'] } });
    for (const order of orders) {
        if (!order.smmOrderId || order.smmOrderId === 'PENDING') continue;
        try {
            const apiUrl = order.provider === 'peaker' ? PEAKER_API_URL : SMM_API_URL;
            const apiKey = order.provider === 'peaker' ? PEAKER_API_KEY : SMM_API_KEY;
            const res = await axios.post(apiUrl, { key: apiKey, action: 'status', order: order.smmOrderId }, { timeout: 30000 });
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
                    try {
                        let msg = '';
                        if (data.status === 'Completed') {
                            msg = `✅ *ORDER COMPLETED!*\n\n🎉 Your order has been delivered successfully!\n\n` +
                                  `• Service: ${escapeMarkdown(order.serviceName)}\n` +
                                  `• Quantity: ${order.quantity.toLocaleString()}\n` +
                                  `• Order ID: \`${order.smmOrderId}\`\n\n` +
                                  `Thank you for your purchase! 🙏`;
                        } else if (data.status === 'In progress') {
                            msg = `⏳ *ORDER IN PROGRESS*\n\n` +
                                  `• Service: ${escapeMarkdown(order.serviceName)}\n` +
                                  `• Order ID: \`${order.smmOrderId}\`\n` +
                                  `• Status: *Processing*\n\n` +
                                  `Your order is being worked on. You will be notified when complete.`;
                        } else if (data.status === 'Partial') {
                            msg = `⚠️ *ORDER PARTIAL*\n\n` +
                                  `• Service: ${escapeMarkdown(order.serviceName)}\n` +
                                  `• Order ID: \`${order.smmOrderId}\`\n` +
                                  `• Remains: ${data.remains || 'N/A'}\n\n` +
                                  `A partial refund has been applied to your account.`;
                        } else {
                            msg = `📋 *Order Update*\n\nOrder ID: \`${order.smmOrderId}\`\nService: ${escapeMarkdown(order.serviceName)}\nStatus: *${data.status}*`;
                            if (data.remains) msg += `\nRemains: ${data.remains}`;
                        }
                        if (order.customerTelegramId) {
                            await bot.api.sendMessage(order.customerTelegramId, msg, { parse_mode: "Markdown" });
                        }
                    } catch (e) {}
                }
            }
        } catch (err) { console.error(`[CRON] Status check failed for ${order.smmOrderId}:`, err.message); }
    }
});

// ==========================================
// STARTUP
// ==========================================
const PORT = process.env.PORT || 3020;

async function startServer() {
    try {
        await bot.init();
        console.log(`🤖 Bot initialized: @${bot.botInfo.username}`);
    } catch (e) {
        console.error('❌ Bot init failed:', e.message);
        process.exit(1);
    }

    app.listen(PORT, async () => {
        console.log(`🌐 Server listening on port ${PORT}`);
        console.log(`📱 Mini App: ${APP_URL}`);
        console.log(`🌐 Website: ${APP_URL}`);

        let store = await BotInstance.findOne({ isDefault: true });
        if (!store) {
            try {
                store = await BotInstance.create({
                    isDefault: true,
                    botToken: process.env.TELEGRAM_BOT_TOKEN,
                    botUsername: bot.botInfo.username,
                    botId: bot.botInfo.id,
                    status: 'active',
                    businessName: bot.botInfo.first_name,
                    welcomeMessage: `Welcome to ${bot.botInfo.first_name}! Boost your social media presence. Choose a platform below.`,
                    welcomePhoto: `${APP_URL}/welcome-default.jpg`,
                    adminAlertChatId: String(ADMIN_IDS[0] || ''),
                    expiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000)
                });
                console.log(`✅ Default store created: @${bot.botInfo.username}`);
            } catch (e) {
                console.error('❌ Failed to create default store:', e.message);
            }
        } else {
            defaultStore = store;
            console.log(`✅ Default store loaded: @${store.botUsername}`);
        }

        if (APP_URL.startsWith('https://')) {
            try {
                await bot.api.setWebhook(`${APP_URL}/webhook`);
                console.log(`✅ Bot webhook set: ${APP_URL}/webhook`);
            } catch (e) {
                console.log('⚠️ Webhook setup failed:', e.message);
            }
        } else {
            console.log('⚠️ HTTP mode — starting polling...');
            bot.start();
        }
    });
}

startServer();