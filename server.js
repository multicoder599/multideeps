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
    isDefault: { type: Boolean, default: false },
    botToken: { type: String, required: true },
    botUsername: String,
    botId: Number,
    status: { type: String, enum: ['active', 'suspended', 'expired'], default: 'active' },
    businessName: { type: String, default: 'My SMM Store' },
    welcomeMessage: { type: String, default: 'Welcome! Boost your social media presence. Choose a category below.' },
    welcomePhoto: { type: String, default: '' },
    bannerImage: { type: String, default: '' },
    adminAlertChatId: String,
    supportLink: { type: String, default: '' },
    megapayApiKey: { type: String, default: '' },
    megapayEmail: { type: String, default: '' },
    megapayWebhookUrl: { type: String, default: '' },
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
    serviceName: String,
    link: String,
    quantity: Number,
    megapayTransactionId: String,
    megapayMerchantRequestId: String,
    megapayCheckoutRequestId: String,
    createdAt: { type: Date, default: Date.now, expires: 86400 }
});

const Merchant = mongoose.model('Merchant', merchantSchema);
const Service = mongoose.model('Service', serviceSchema);
const BotInstance = mongoose.model('BotInstance', botInstanceSchema);
const Order = mongoose.model('Order', orderSchema);
const Transaction = mongoose.model('Transaction', transactionSchema);
const PendingTransaction = mongoose.model('PendingTransaction', pendingTxSchema);

// ==========================================
// IN-MEMORY STATE
// ==========================================
const adminUserState = new Map();
const customerPendingInputs = new Map();
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

async function getDefaultStore() {
    if (!defaultStore) {
        defaultStore = await BotInstance.findOne({ isDefault: true });
    }
    return defaultStore;
}

function getOwnerMenu() {
    return new InlineKeyboard()
        .text("🛒 Service Catalog", "owner_services").row()
        .text("📋 View Orders", "owner_orders").row()
        .text("📊 Stats", "owner_stats").row()
        .text("💳 Payment Settings", "owner_payment").row()
        .text("⚙️ Store Settings", "owner_settings").row()
        .text("📢 Broadcast", "owner_broadcast").row()
        .text("📱 Open Dashboard", "open_dashboard");
}

function getCustomerMenu(categories, supportUrl) {
    const keyboard = new InlineKeyboard();
    categories.forEach(cat => {
        keyboard.text(`📂 ${escapeMarkdown(cat)}`, `cat_${cat}`).row();
    });
    if (supportUrl) keyboard.row({ text: '💬 Support', url: supportUrl });
    return keyboard;
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
// MAIN BOT (Customer-facing + Owner)
// ==========================================
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

bot.catch((err) => { console.error(`Bot Error:`, err.message); });

bot.command("start", async (ctx) => {
    const store = await getDefaultStore();
    const isOwner = ADMIN_IDS.includes(ctx.from.id);

    if (isOwner) {
        const welcomeText = `👋 Hello ${escapeMarkdown(ctx.from.first_name || 'Boss')}!\n\n🤖 *SMM Panel Owner*\n\nManage your store, view orders, and configure services below.`;
        const keyboard = getOwnerMenu();
        try {
            if (store && store.welcomePhoto) {
                await ctx.replyWithPhoto(store.welcomePhoto, { caption: welcomeText, parse_mode: "Markdown", reply_markup: keyboard });
            } else {
                await ctx.reply(welcomeText, { parse_mode: "Markdown", reply_markup: keyboard });
            }
        } catch (e) { await ctx.reply(welcomeText, { parse_mode: "Markdown", reply_markup: keyboard }); }
        return;
    }

    if (!store || store.status !== 'active') {
        return ctx.reply("⛔ Store is currently offline. Please check back later.");
    }

    const enabled = store.enabledServices?.filter(s => s.isEnabled) || [];
    if (enabled.length === 0) {
        const keyboard = new InlineKeyboard();
        if (store.supportLink) keyboard.row({ text: '💬 Support', url: store.supportLink });
        return ctx.reply("⏳ Store has no active services yet. Please check back later.", { reply_markup: keyboard });
    }

    const services = await Service.find({ serviceId: { $in: enabled.map(s => s.serviceId) } });
    const categories = [...new Set(services.map(s => s.category))];
    const keyboard = getCustomerMenu(categories, store.supportLink);

    const welcomeText = store.welcomeMessage;
    try {
        if (store.welcomePhoto) {
            await ctx.replyWithPhoto(store.welcomePhoto, { caption: welcomeText, reply_markup: keyboard });
        } else if (store.bannerImage) {
            await ctx.replyWithPhoto(store.bannerImage, { caption: welcomeText, reply_markup: keyboard });
        } else {
            await ctx.reply(welcomeText, { reply_markup: keyboard });
        }
    } catch (err) { await ctx.reply(welcomeText, { reply_markup: keyboard }); }
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
// OWNER CALLBACKS
// ==========================================
bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const store = await getDefaultStore();

    if (ADMIN_IDS.includes(ctx.from.id)) {
        if (data === 'owner_services') {
            await ctx.answerCallbackQuery("Open dashboard to manage services");
            await ctx.reply(`🛒 *Service Catalog*\n\nOpen your dashboard to enable services and set prices 👇`, {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().row({ text: '👇 Open Dashboard', web_app: { url: APP_URL } })
            });
            return;
        }
        if (data === 'owner_orders') {
            ctx.answerCallbackQuery().catch(()=>{});
            const orders = await Order.find({ botId: store._id }).sort({ createdAt: -1 }).limit(15);
            let text = `📋 *Recent Orders*\n\n`;
            if (orders.length === 0) text += `_No orders yet._`;
            else {
                orders.forEach(o => {
                    text += `• #${o.smmOrderId || 'N/A'} — ${escapeMarkdown(o.serviceName)} — ${o.quantity} qty — KES ${o.price} — ${o.status}\n`;
                });
            }
            await ctx.reply(text, { parse_mode: "Markdown", reply_markup: getOwnerMenu() });
            return;
        }
        if (data === 'owner_stats') {
            ctx.answerCallbackQuery().catch(()=>{});
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
            adminUserState.set(ctx.from.id, { action: 'payment_menu' });
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
            adminUserState.set(ctx.from.id, { action: 'awaiting_megapay_key' });
            await ctx.reply(`🔑 *Set Megapay API Key*\n\nPaste your key below 👇`, { parse_mode: "Markdown" });
            return ctx.answerCallbackQuery();
        }
        if (data === 'set_megapay_email') {
            adminUserState.set(ctx.from.id, { action: 'awaiting_megapay_email' });
            await ctx.reply(`📧 *Set Megapay Email*\n\nPaste your email below 👇`, { parse_mode: "Markdown" });
            return ctx.answerCallbackQuery();
        }
        if (data === 'owner_settings') {
            adminUserState.set(ctx.from.id, { action: 'settings_menu' });
            const keyboard = new InlineKeyboard()
                .text("📝 Edit Store Name", "edit_name").row()
                .text("💬 Edit Welcome Msg", "edit_welcome").row()
                .text("🔗 Set Support Link", "edit_support").row()
                .text("🖼️ Set Banner", "edit_banner").row()
                .text("🔙 Back", "owner_back");
            await ctx.reply(`⚙️ *Store Settings*`, { parse_mode: "Markdown", reply_markup: keyboard });
            return ctx.answerCallbackQuery();
        }
        if (data === 'edit_name') {
            adminUserState.set(ctx.from.id, { action: 'awaiting_store_name' });
            await ctx.reply("📝 Enter new store name:");
            return ctx.answerCallbackQuery();
        }
        if (data === 'edit_welcome') {
            adminUserState.set(ctx.from.id, { action: 'awaiting_welcome_msg' });
            await ctx.reply("💬 Enter new welcome message:");
            return ctx.answerCallbackQuery();
        }
        if (data === 'edit_support') {
            adminUserState.set(ctx.from.id, { action: 'awaiting_support_link' });
            await ctx.reply("🔗 Enter support link (e.g. https://t.me/yourusername):");
            return ctx.answerCallbackQuery();
        }
        if (data === 'edit_banner') {
            adminUserState.set(ctx.from.id, { action: 'awaiting_banner' });
            await ctx.reply("🖼️ Send a banner image URL:");
            return ctx.answerCallbackQuery();
        }
        if (data === 'owner_broadcast') {
            adminUserState.set(ctx.from.id, { action: 'awaiting_broadcast_msg' });
            await ctx.reply("📢 *Broadcast to all customers*\n\nType your message:", { parse_mode: "Markdown" });
            return ctx.answerCallbackQuery();
        }
        if (data === 'owner_back' || data === 'open_dashboard') {
            ctx.answerCallbackQuery().catch(()=>{});
            return bot.command("start")(ctx);
        }
    }

    // ==========================================
    // CUSTOMER CALLBACKS
    // ==========================================
    if (data.startsWith('cat_')) {
        ctx.answerCallbackQuery().catch(()=>{});
        const category = data.replace('cat_', '');
        const enabled = store.enabledServices?.filter(s => s.isEnabled) || [];
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
        return;
    }

    if (data.startsWith('svc_')) {
        ctx.answerCallbackQuery().catch(()=>{});
        const serviceId = parseInt(data.replace('svc_', ''));
        const svc = await Service.findOne({ serviceId });
        if (!svc) return ctx.reply("❌ Service not found.");

        customerPendingInputs.set(ctx.from.id, { action: 'awaiting_link', data: { serviceId } });
        let text = `🛒 *${escapeMarkdown(svc.name)}*\n\nCategory: ${escapeMarkdown(svc.category)}\nType: ${escapeMarkdown(svc.type)}\nMin: ${svc.min} | Max: ${svc.max}\nRefill: ${svc.refill ? '✅ Yes (30 days)' : '❌ No'}\n\nSend the link or username to promote:`;
        await ctx.reply(text, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text('🔙 Back', 'back_start') });
        return;
    }

    if (data === 'back_start') {
        ctx.answerCallbackQuery().catch(()=>{});
        const enabled = store.enabledServices?.filter(s => s.isEnabled) || [];
        const services = await Service.find({ serviceId: { $in: enabled.map(s => s.serviceId) } });
        const categories = [...new Set(services.map(s => s.category))];
        const keyboard = getCustomerMenu(categories, store.supportLink);
        try { await ctx.editMessageText(store.welcomeMessage, { reply_markup: keyboard }); }
        catch (e) { await ctx.reply(store.welcomeMessage, { reply_markup: keyboard }); }
        return;
    }
});

// ==========================================
// TEXT INPUT HANDLER
// ==========================================
bot.on('message:text', async (ctx) => {
    const state = adminUserState.get(ctx.from.id);
    const customerState = customerPendingInputs.get(ctx.from.id);
    const store = await getDefaultStore();

    // --- OWNER INPUTS ---
    if (state && ADMIN_IDS.includes(ctx.from.id)) {
        const text = ctx.message.text.trim();

        if (state.action === 'awaiting_megapay_key') {
            store.megapayApiKey = text;
            await store.save();
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Megapay API Key updated!`);
            return;
        }
        if (state.action === 'awaiting_megapay_email') {
            store.megapayEmail = text;
            await store.save();
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Megapay Email updated!`);
            return;
        }
        if (state.action === 'awaiting_store_name') {
            store.businessName = text;
            await store.save();
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Store name updated to *${escapeMarkdown(text)}*!`, { parse_mode: "Markdown" });
            return;
        }
        if (state.action === 'awaiting_welcome_msg') {
            store.welcomeMessage = text;
            await store.save();
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Welcome message updated!`);
            return;
        }
        if (state.action === 'awaiting_support_link') {
            store.supportLink = text;
            await store.save();
            adminUserState.delete(ctx.from.id);
            await ctx.reply(`✅ Support link updated!`);
            return;
        }
        if (state.action === 'awaiting_banner') {
            store.bannerImage = text;
            await store.save();
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

    // --- CUSTOMER INPUTS ---
    if (customerState) {
        if (customerState.action === 'awaiting_link') {
            customerState.data.link = ctx.message.text.trim();
            customerState.action = 'awaiting_quantity';
            const svc = await Service.findOne({ serviceId: customerState.data.serviceId });
            await ctx.reply(`🔗 Link received.\n\nEnter quantity (min: ${svc.min}, max: ${svc.max}):`);
            return;
        }

        if (customerState.action === 'awaiting_quantity') {
            const qty = parseInt(ctx.message.text.trim());
            const svc = await Service.findOne({ serviceId: customerState.data.serviceId });
            if (isNaN(qty) || qty < parseInt(svc.min) || qty > parseInt(svc.max)) {
                await ctx.reply(`❌ Invalid quantity. Must be between ${svc.min} and ${svc.max}.`);
                return;
            }
            const cfg = store.enabledServices.find(s => s.serviceId === customerState.data.serviceId);
            const pricePer1k = cfg?.customPrice || 0;
            if (pricePer1k <= 0) {
                await ctx.reply("❌ This service is not priced yet. Contact support.");
                customerPendingInputs.delete(ctx.from.id);
                return;
            }
            const price = Math.ceil((pricePer1k * qty) / 1000);
            customerState.data.quantity = qty;
            customerState.data.price = price;
            customerState.data.serviceName = svc.name;
            customerState.action = 'awaiting_payment_phone';
            await ctx.reply(
                `💰 *Order Summary*\n\nService: ${escapeMarkdown(svc.name)}\nLink: ${escapeMarkdown(customerState.data.link)}\nQuantity: ${qty}\nPrice: *KES ${price}*\n\nEnter your M-Pesa number:\nFormat: 07XXXXXXXX or 01XXXXXXXX`,
                { parse_mode: "Markdown" }
            );
            return;
        }

        if (customerState.action === 'awaiting_payment_phone') {
            let phone = ctx.message.text.trim().replace(/\D/g, '');
            if (phone.startsWith('0')) phone = '254' + phone.slice(1);
            else if (!phone.startsWith('254')) phone = '254' + phone;
            if (phone.length !== 12) { await ctx.reply("❌ Invalid phone. Use format: 07XXXXXXXX"); return; }

            const { serviceId, serviceName, link, quantity, price } = customerState.data;
            const reference = `ORD${Date.now()}`;

            if (!store.megapayApiKey || !store.megapayEmail) {
                await ctx.reply("⚠️ Payment not configured. Please contact support.");
                customerPendingInputs.delete(ctx.from.id);
                return;
            }

            try {
                await PendingTransaction.create({
                    reference, type: 'order', phone, amount: price, botId: store._id,
                    customerTelegramId: ctx.from.id, customerChatId: ctx.chat.id,
                    serviceId, serviceName, link, quantity
                });

                const payload = {
                    api_key: store.megapayApiKey,
                    email: store.megapayEmail,
                    amount: price,
                    msisdn: phone,
                    callback_url: store.megapayWebhookUrl || `${APP_URL}/api/megapay/webhook`,
                    description: `${store.businessName} — ${serviceName} (${quantity})`,
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
                    `📲 *Check your phone!*\nM-Pesa prompt has been sent.\nEnter your PIN to complete payment.\n\nYour order will be placed automatically once confirmed.`,
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
// WEBHOOK ENDPOINT
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

        const store = await getDefaultStore();
        if (!store) { console.log('[WEBHOOK] No default store'); return; }

        if (tx.type === 'order') {
            console.log(`[WEBHOOK] Fulfilling order`);
            const svc = await Service.findOne({ serviceId: tx.serviceId });

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

            const order = await Order.create({
                botId: store._id,
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
                botId: store._id,
                serviceId: tx.serviceId,
                serviceName: tx.serviceName || svc?.name,
                customerTelegramId: tx.customerTelegramId,
                customerUsername: '',
                phone: tx.phone,
                amount,
                mpesaReceipt: receipt,
                status: 'completed'
            });

            let successText = `🎉 *PAYMENT SUCCESSFUL!*\n\nThank you for your order!\n\n💰 *DETAILS*\n• Service: ${escapeMarkdown(order.serviceName)}\n• Quantity: ${order.quantity}\n• Link: ${escapeMarkdown(order.link)}\n• Amount: KES ${amount}\n• Receipt: ${receipt}\n• Order ID: \`${order.smmOrderId}\``;
            if (smmOrderId) {
                successText += `\n\n⏳ Your order is now *processing*.\nUse /status ${order.smmOrderId} to check updates.`;
                if (order.refillEligible) successText += `\n\n🔄 *Refill available* for 30 days. Use /refill ${order.smmOrderId} if drops occur.`;
            } else {
                successText += `\n\n⚠️ *Auto-placement failed.* Admin will fulfill manually.`;
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
                    await bot.api.sendMessage(store.adminAlertChatId,
                        `✅ *New Sale!*\n\n📦 ${escapeMarkdown(order.serviceName)}\n🔗 ${escapeMarkdown(order.link)}\n📊 ${order.quantity} qty\n💵 KES ${amount}\n🧾 ${receipt}\n📱 ${tx.phone}`,
                        { parse_mode: "Markdown" }
                    );
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
// MINI APP API ROUTES
// ==========================================

app.post('/api/upload', validateInitData, upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const url = `${APP_URL}/uploads/${req.file.filename}`;
    res.json({ success: true, url, name: req.file.originalname, size: req.file.size });
});

app.get('/api/me', validateInitData, async (req, res) => {
    const merchant = await getPartnerFromInit(req.telegramUser);
    res.json({ id: merchant._id, telegramId: merchant.telegramId, username: merchant.username, firstName: merchant.firstName, status: 'active' });
});

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
    const store = await BotInstance.findOneAndUpdate({ isDefault: true }, updates, { returnDocument: 'after', upsert: true });
    res.json(store);
});

app.get('/api/store/services', validateInitData, async (req, res) => {
    const store = await getDefaultStore();
    if (!store) return res.status(404).json({ error: 'Store not configured' });
    const globalServices = await Service.find().sort({ category: 1, serviceId: 1 });
    const enabledMap = new Map((store.enabledServices || []).map(s => [s.serviceId, s]));
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

app.put('/api/store/services', validateInitData, async (req, res) => {
    const { enabledServices } = req.body;
    const store = await BotInstance.findOneAndUpdate(
        { isDefault: true },
        { enabledServices: enabledServices || [] },
        { returnDocument: 'after', upsert: true }
    );
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
        const smmRes = await axios.post(SMM_API_URL, { key: SMM_API_KEY, action: 'refill', order: order.smmOrderId });
        order.refillRequested = true;
        order.refillStatus = smmRes.data?.status || 'Requested';
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
cron.schedule('*/15 * * * *', async () => {
    console.log('⏰ Checking SMM order statuses...');
    const store = await getDefaultStore();
    if (!store) return;
    const orders = await Order.find({ botId: store._id, status: { $in: ['pending', 'processing', 'In progress'] } });
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
                    try {
                        let msg = `📋 *Order Update*\n\nOrder ID: \`${order.smmOrderId}\`\nService: ${escapeMarkdown(order.serviceName)}\nStatus: *${data.status}*`;
                        if (data.remains) msg += `\nRemains: ${data.remains}`;
                        await bot.api.sendMessage(order.customerTelegramId, msg, { parse_mode: "Markdown" });
                    } catch (e) {}
                }
            }
        } catch (err) { console.error(`[CRON] Status check failed for ${order.smmOrderId}:`, err.message); }
    }
});

// ==========================================
// STARTUP — bot.init() BEFORE server starts
// ==========================================
const PORT = process.env.PORT || 3020;

async function startServer() {
    // CRITICAL: Initialize bot before accepting webhooks
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

        // Ensure default store exists
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
                    welcomeMessage: `Welcome to ${bot.botInfo.first_name}! Boost your social media presence. Choose a category below.`,
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

        // Set webhook
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