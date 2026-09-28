const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");
const nodemailer = require("nodemailer");

// ============================================================
// J.A.R.V.I.S — TELEGRAM SUBSCRIPTION BOT
// РЕГИСТРАЦИЯ + EMAIL ПОДТВЕРЖДЕНИЕ + ПАРОЛЬ + ВХОД
// ============================================================

// ==================== НАСТРОЙКИ ====================

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;

const ADMIN_IDS = [
    8723208814,
    8882462981
];

const SUPPORT_USERNAME = "@JARBIS_help";

const CARD_NUMBER =
    process.env.CARD_NUMBER || "2200 1536 2364 5513";

const CARD_HOLDER =
    process.env.CARD_HOLDER || "Получатель: Алексей М.";

// ==================== ТАРИФЫ ====================

const TARIFFS = {
    "50": {
        name: "3 дня",
        days: 3,
        price: 50
    },

    "200": {
        name: "1 месяц",
        days: 30,
        price: 200
    },

    "600": {
        name: "Навсегда",
        days: 36500,
        price: 600
    }
};

// ==================== SMTP ====================

const SMTP_HOST =
    process.env.SMTP_HOST || "smtp.gmail.com";

const SMTP_PORT =
    Number(process.env.SMTP_PORT || 465);

const SMTP_USER =
    process.env.SMTP_USER;

const SMTP_PASS =
    process.env.SMTP_PASS;

if (!BOT_TOKEN) {
    console.error(
        "❌ TELEGRAM_TOKEN не установлен!"
    );

    process.exit(1);
}

if (!SMTP_USER || !SMTP_PASS) {
    console.error(
        "❌ SMTP_USER и SMTP_PASS должны быть установлены в Railway Variables!"
    );

    process.exit(1);
}

// ==================== MAILER ====================

const mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,

    auth: {
        user: SMTP_USER,
        pass: SMTP_PASS
    }
});

// ==================== TELEGRAM ====================

const bot = new TelegramBot(
    BOT_TOKEN,
    {
        polling: true
    }
);

// ============================================================
// DATABASE
// ============================================================

const DB_FILE = fs.existsSync("/data")
    ? "/data/subscriptions.db"
    : "./subscriptions.db";

const db = new Database(DB_FILE);

db.pragma("journal_mode = WAL");

// ==================== DATABASE HELPERS ====================

function columnExists(table, column) {

    const columns =
        db.prepare(
            `PRAGMA table_info(${table})`
        ).all();

    return columns.some(
        columnInfo =>
            columnInfo.name === column
    );
}

function addColumn(
    table,
    column,
    definition
) {

    if (!columnExists(table, column)) {

        db.exec(
            `ALTER TABLE ${table}
             ADD COLUMN ${column}
             ${definition}`
        );
    }
}

// ==================== INIT DATABASE ====================

function initDb() {

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            name TEXT,
            email TEXT,
            password_hash TEXT,
            email_verified INTEGER DEFAULT 0,
            sub_until TEXT,
            total_paid INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS payments (
            order_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            tariff TEXT NOT NULL,
            amount INTEGER NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            paid_at TEXT
        );

        CREATE TABLE IF NOT EXISTS admins (
            user_id INTEGER PRIMARY KEY,
            online INTEGER DEFAULT 1,
            offline_until TEXT
        );
    `);

    // Совместимость со старой базой

    addColumn(
        "users",
        "name",
        "TEXT"
    );

    addColumn(
        "users",
        "email",
        "TEXT"
    );

    addColumn(
        "users",
        "password_hash",
        "TEXT"
    );

    addColumn(
        "users",
        "email_verified",
        "INTEGER DEFAULT 0"
    );

    addColumn(
        "payments",
        "name",
        "TEXT"
    );

    addColumn(
        "payments",
        "email",
        "TEXT"
    );

    // Добавляем администраторов

    for (const adminId of ADMIN_IDS) {

        db.prepare(`
            INSERT OR IGNORE INTO admins
            (
                user_id,
                online,
                offline_until
            )
            VALUES (?, 1, NULL)
        `).run(adminId);
    }
}

// ============================================================
// USERS
// ============================================================

function upsertUser(
    userId,
    username = null
) {

    db.prepare(`
        INSERT OR IGNORE INTO users
        (
            user_id,
            username
        )
        VALUES (?, ?)
    `).run(
        userId,
        username
    );

    if (username) {

        db.prepare(`
            UPDATE users
            SET username = ?
            WHERE user_id = ?
        `).run(
            username,
            userId
        );
    }
}

function getUser(userId) {

    return db.prepare(`
        SELECT *
        FROM users
        WHERE user_id = ?
    `).get(userId);
}

function getUserByEmail(email) {

    return db.prepare(`
        SELECT *
        FROM users
        WHERE lower(email) = lower(?)
    `).get(email);
}

// ============================================================
// EMAIL AUTH
// ============================================================

const pendingAuth =
    new Map();

function normalizeEmail(email) {

    return email
        .trim()
        .toLowerCase();
}

function validEmail(email) {

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/
        .test(email);
}

function generateCode() {

    return String(
        crypto.randomInt(
            100000,
            1000000
        )
    );
}

// Пароль храним не в открытом виде
function hashPassword(password) {

    return crypto
        .createHash("sha256")
        .update(password)
        .digest("hex");
}

function validPassword(password) {

    return (
        password.length >= 6 &&
        password.length <= 128
    );
}

async function sendVerificationCode(
    email,
    code,
    purpose
) {

    const isRegister =
        purpose === "register";

    const subject =
        isRegister
            ? "Код регистрации J.A.R.B.I.S"
            : "Код восстановления пароля J.A.R.B.I.S";

    const title =
        isRegister
            ? "Подтверждение email"
            : "Восстановление пароля";

    await mailer.sendMail({

        from:
            `J.A.R.B.I.S <${SMTP_USER}>`,

        to:
            email,

        subject:

            subject,

        text:

            `J.A.R.B.I.S

${title}

Ваш код:

${code}

Код действует 10 минут.

Если вы не запрашивали этот код,
просто проигнорируйте письмо.`,

        html:

            `
            <div style="font-family:Arial">

                <h2>J.A.R.B.I.S</h2>

                <p>
                    ${title}
                </p>

                <p>
                    Ваш код:
                </p>

                <h1>
                    ${code}
                </h1>

                <p>
                    Код действует 10 минут.
                </p>

            </div>
            `
    });
}

function clearAuth(userId) {

    pendingAuth.delete(userId);
}

// ============================================================
// ADMINS
// ============================================================

function isAdmin(userId) {

    return ADMIN_IDS.includes(
        Number(userId)
    );
}

function getAdminStatus(userId) {

    const row =
        db.prepare(`
            SELECT *
            FROM admins
            WHERE user_id = ?
        `).get(userId);

    if (!row) {

        return {
            online: false
        };
    }

    if (
        row.online === 0 &&
        row.offline_until
    ) {

        const until =
            new Date(
                row.offline_until
            );

        if (
            until <= new Date()
        ) {

            db.prepare(`
                UPDATE admins
                SET
                    online = 1,
                    offline_until = NULL
                WHERE user_id = ?
            `).run(userId);

            return {
                online: true
            };
        }
    }

    return {

        online:
            row.online === 1,

        offlineUntil:
            row.offline_until
    };
}

function setAdminOnline(userId) {

    db.prepare(`
        UPDATE admins
        SET
            online = 1,
            offline_until = NULL
        WHERE user_id = ?
    `).run(userId);
}

function setAdminOffline(
    userId,
    until
) {

    db.prepare(`
        UPDATE admins
        SET
            online = 0,
            offline_until = ?
        WHERE user_id = ?
    `).run(
        until.toISOString(),
        userId
    );
}

function getOnlineAdminsCount() {

    return ADMIN_IDS.filter(
        id =>
            getAdminStatus(id).online
    ).length;
}

function getStatusText() {

    if (
        getOnlineAdminsCount() > 0
    ) {

        return (
            "🟢 Администратор в онлайне"
        );
    }

    return (
        "🔴 Администратор сейчас " +
        "не может одобрить заявку.\n" +
        "Пожалуйста, подождите."
    );
}

// ============================================================
// TIME
// ============================================================

function parseOfflineTime(text) {

    const value =
        text.toLowerCase().trim();

    const regex =
        /(\d+)\s*(d|h|m|s)/g;

    let match;

    let totalSeconds = 0;

    let found = false;

    while (
        (match = regex.exec(value))
    ) {

        found = true;

        const number =
            Number(match[1]);

        const unit =
            match[2];

        if (unit === "d")
            totalSeconds +=
                number * 86400;

        if (unit === "h")
            totalSeconds +=
                number * 3600;

        if (unit === "m")
            totalSeconds +=
                number * 60;

        if (unit === "s")
            totalSeconds +=
                number;
    }

    const cleaned =
        value
            .replace(
                /(\d+)\s*(d|h|m|s)/g,
                ""
            )
            .trim();

    if (
        !found ||
        cleaned !== "" ||
        totalSeconds < 1
    ) {

        return null;
    }

    if (
        totalSeconds >
        15 * 86400
    ) {

        return "MAX";
    }

    return totalSeconds;
}

function formatDuration(
    seconds
) {

    const result = [];

    const days =
        Math.floor(
            seconds / 86400
        );

    seconds %= 86400;

    const hours =
        Math.floor(
            seconds / 3600
        );

    seconds %= 3600;

    const minutes =
        Math.floor(
            seconds / 60
        );

    seconds %= 60;

    if (days)
        result.push(
            `${days}д`
        );

    if (hours)
        result.push(
            `${hours}ч`
        );

    if (minutes)
        result.push(
            `${minutes}мин`
        );

    if (seconds)
        result.push(
            `${seconds}сек`
        );

    return result.join(" ");
}

// ============================================================
// SUBSCRIPTIONS
// ============================================================

function isSubActive(userId) {

    const user =
        getUser(userId);

    if (
        !user ||
        !user.sub_until
    ) {

        return false;
    }

    return (
        new Date(
            user.sub_until
        ) > new Date()
    );
}

function setSubscription(
    userId,
    days
) {

    const user =
        getUser(userId);

    const now =
        new Date();

    let start = now;

    if (
        user &&
        user.sub_until
    ) {

        const current =
            new Date(
                user.sub_until
            );

        if (
            current > now
        ) {

            start = current;
        }
    }

    const newUntil =
        new Date(
            start.getTime() +
            days *
            86400000
        );

    db.prepare(`
        UPDATE users
        SET sub_until = ?
        WHERE user_id = ?
    `).run(
        newUntil.toISOString(),
        userId
    );

    return newUntil;
}

// ============================================================
// ORDERS
// ============================================================

function createOrder(
    userId,
    tariffKey,
    name,
    email
) {

    const tariff =
        TARIFFS[tariffKey];

    if (!tariff) {

        throw new Error(
            "Тариф не найден"
        );
    }

    const orderId =
        crypto
            .randomBytes(5)
            .toString("hex")
            .toUpperCase();

    db.prepare(`
        INSERT INTO payments
        (
            order_id,
            user_id,
            tariff,
            amount,
            status,
            created_at,
            name,
            email
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        orderId,
        userId,
        tariffKey,
        tariff.price,
        "pending",
        new Date().toISOString(),
        name,
        email
    );

    return orderId;
}

function getOrder(orderId) {

    return db.prepare(`
        SELECT *
        FROM payments
        WHERE order_id = ?
    `).get(orderId);
}

function getPendingOrder(userId) {

    return db.prepare(`
        SELECT *
        FROM payments
        WHERE user_id = ?
        AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1
    `).get(userId);
}

function confirmOrder(orderId) {

    const order =
        getOrder(orderId);

    if (!order) {

        return {
            success: false,
            reason: "not_found"
        };
    }

    if (
        order.status !== "pending"
    ) {

        return {
            success: false,
            reason: "already_processed"
        };
    }

    const tariff =
        TARIFFS[order.tariff];

    if (!tariff) {

        return {
            success: false,
            reason: "tariff_not_found"
        };
    }

    const until =
        setSubscription(
            order.user_id,
            tariff.days
        );

    db.prepare(`
        UPDATE payments
        SET
            status = 'paid',
            paid_at = ?
        WHERE
            order_id = ?
            AND status = 'pending'
    `).run(
        new Date().toISOString(),
        orderId
    );

    db.prepare(`
        UPDATE users
        SET total_paid =
            total_paid + ?
        WHERE user_id = ?
    `).run(
        order.amount,
        order.user_id
    );

    return {

        success: true,

        userId:
            order.user_id,

        until,

        order
    };
}

function rejectOrder(
    orderId
) {

    const order =
        getOrder(orderId);

    if (!order) {

        return {
            success: false,
            reason: "not_found"
        };
    }

    if (
        order.status !== "pending"
    ) {

        return {
            success: false,
            reason: "already_processed"
        };
    }

    db.prepare(`
        UPDATE payments
        SET status = 'rejected'
        WHERE
            order_id = ?
            AND status = 'pending'
    `).run(orderId);

    return {

        success: true,

        userId:
            order.user_id,

        order
    };
}

// ============================================================
// KEYBOARDS
// ============================================================

function mainMenu() {

    return {

        reply_markup: {

            keyboard: [

                [
                    {
                        text:
                            "📝 Регистрация"
                    },

                    {
                        text:
                            "🔐 Войти"
                    }
                ],

                [
                    {
                        text:
                            "🛒 Купить"
                    },

                    {
                        text:
                            "ℹ️ Помощь"
                    }
                ],

                [
                    {
                        text:
                            "🛠 Тех.поддержка"
                    }
                ]

            ],

            resize_keyboard:
                true,

            is_persistent:
                true
        }
    };
}

function buyMenu() {

    return {

        reply_markup: {

            inline_keyboard: [

                [
                    {
                        text:
                            "50 ₽ — 3 дня",

                        callback_data:
                            "buy_50"
                    }
                ],

                [
                    {
                        text:
                            "200 ₽ — 1 месяц",

                        callback_data:
                            "buy_200"
                    }
                ],

                [
                    {
                        text:
                            "600 ₽ — навсегда",

                        callback_data:
                            "buy_600"
                    }
                ],

                [
                    {
                        text:
                            "⬅️ Назад",

                        callback_data:
                            "back"
                    }
                ]

            ]
        }
    };
}

function authMenu() {

    return {

        reply_markup: {

            inline_keyboard: [

                [
                    {
                        text:
                            "🔑 Забыли пароль?",

                        callback_data:
                            "forgot_password"
                    }
                ],

                [
                    {
                        text:
                            "⬅️ Назад",

                        callback_data:
                            "back"
                    }
                ]

            ]
        }
    };
}

function adminMenu() {

    return {

        reply_markup: {

            inline_keyboard: [

                [
                    {
                        text:
                            "🟢 Я онлайн",

                        callback_data:
                            "admin_online"
                    }
                ],

                [
                    {
                        text:
                            "🔴 Я не онлайн",

                        callback_data:
                            "admin_offline"
                    }
                ]

            ]
        }
    };
}

function adminOrderButtons(
    orderId
) {

    return {

        reply_markup: {

            inline_keyboard: [

                [

                    {
                        text:
                            "✅ Подтвердить",

                        callback_data:
                            `confirm_${orderId}`
                    },

                    {
                        text:
                            "❌ Отклонить",

                        callback_data:
                            `reject_${orderId}`
                    }

                ]

            ]
        }
    };
}

// ============================================================
// STATES
// ============================================================

const userStates =
    new Map();

const adminWaitingTime =
    new Set();

// ============================================================
// AUTH START FUNCTIONS
// ============================================================

async function startRegistration(
    chatId,
    userId
) {

    clearAuth(userId);

    userStates.set(
        userId,
        {
            type: "register",
            step: "name"
        }
    );

    await bot.sendMessage(
        chatId,
        "📝 Регистрация\n\n" +
        "Введите ваше имя:"
    );
}

async function startLogin(
    chatId,
    userId
) {

    clearAuth(userId);

    userStates.set(
        userId,
        {
            type: "login",
            step: "email"
        }
    );

    await bot.sendMessage(
        chatId,
        "🔐 Вход\n\n" +
        "Введите email:"
    );
}

async function startForgotPassword(
    chatId,
    userId
) {

    clearAuth(userId);

    userStates.set(
        userId,
        {
            type: "forgot",
            step: "email"
        }
    );

    await bot.sendMessage(
        chatId,
        "🔑 Восстановление пароля\n\n" +
        "Введите email:"
    );
}

// ============================================================
// START
// ============================================================

bot.onText(
    /^\/start$/,
    async msg => {

        try {

            upsertUser(
                msg.from.id,
                msg.from.username || null
            );

            await bot.sendMessage(

                msg.chat.id,

                "👋 Добро пожаловать " +
                "в J.A.R.V.I.S!\n\n" +

                "Это бот для покупки " +
                "подписки.\n\n" +

                "Выберите действие.\n\n" +

                getStatusText(),

                mainMenu()
            );

            if (
                isAdmin(
                    msg.from.id
                )
            ) {

                await bot.sendMessage(

                    msg.chat.id,

                    "👨‍💼 Панель администратора\n\n" +

                    `🟢 Администраторов онлайн: ` +
                    `${getOnlineAdminsCount()}/2`,

                    adminMenu()
                );
            }

        } catch (error) {

            console.error(
                "START ERROR:",
                error
            );
        }
    }
);

// ============================================================
// /id
// ============================================================

bot.onText(
    /^\/id$/,
    async msg => {

        await bot.sendMessage(

            msg.chat.id,

            `🆔 Ваш Telegram ID:\n\n` +
            `${msg.from.id}`
        );
    }
);

// ============================================================
// /admin
// ============================================================

bot.onText(
    /^\/admin$/,
    async msg => {

        if (
            !isAdmin(
                msg.from.id
            )
        ) {

            return;
        }

        await bot.sendMessage(

            msg.chat.id,

            "👨‍💼 Панель администратора\n\n" +

            `🟢 Администраторов онлайн: ` +
            `${getOnlineAdminsCount()}/2`,

            adminMenu()
        );
    }
);

// ============================================================
// TEXT MESSAGES
// ============================================================

bot.on(
    "message",
    async msg => {

        try {

            if (!msg.text)
                return;

            const text =
                msg.text.trim();

            const userId =
                msg.from.id;

            upsertUser(
                userId,
                msg.from.username || null
            );

            // ==========================================
            // ADMIN OFFLINE TIME
            // ==========================================

            if (
                isAdmin(userId) &&
                adminWaitingTime.has(userId)
            ) {

                const seconds =
                    parseOfflineTime(
                        text
                    );

                if (
                    seconds === "MAX"
                ) {

                    await bot.sendMessage(

                        msg.chat.id,

                        "❌ Максимум — 15 дней.\n\n" +

                        "Примеры:\n" +
                        "5h\n" +
                        "5m\n" +
                        "5s\n" +
                        "5d\n" +
                        "2d 5h 30m"
                    );

                    return;
                }

                if (
                    seconds === null
                ) {

                    await bot.sendMessage(

                        msg.chat.id,

                        "❌ Неверный формат.\n\n" +

                        "Используйте:\n" +
                        "5h\n" +
                        "5m\n" +
                        "5s\n" +
                        "5d\n\n" +

                        "Можно:\n" +
                        "2d 5h 30m"
                    );

                    return;
                }

                const until =
                    new Date(
                        Date.now() +
                        seconds * 1000
                    );

                setAdminOffline(
                    userId,
                    until
                );

                adminWaitingTime.delete(
                    userId
                );

                await bot.sendMessage(

                    msg.chat.id,

                    "🔴 Вы теперь не онлайн.\n\n" +

                    `⏱ Время: ` +
                    `${formatDuration(seconds)}\n` +

                    `🕐 До: ` +
                    `${until.toLocaleString("ru-RU")}\n\n` +

                    "Когда вернётесь, " +
                    "нажмите «🟢 Я онлайн».",

                    adminMenu()
                );

                return;
            }

            // ==========================================
            // ADMIN ONLINE
            // ==========================================

            if (
                isAdmin(userId) &&
                text === "🟢 Я онлайн"
            ) {

                setAdminOnline(
                    userId
                );

                await bot.sendMessage(

                    msg.chat.id,

                    "🟢 Вы снова онлайн!\n\n" +
                    getStatusText(),

                    adminMenu()
                );

                return;
            }

            // ==========================================
            // ADMIN OFFLINE
            // ==========================================

            if (
                isAdmin(userId) &&
                text === "🔴 Я не онлайн"
            ) {

                adminWaitingTime.add(
                    userId
                );

                await bot.sendMessage(

                    msg.chat.id,

                    "⏱ На какое время " +
                    "вы будете не онлайн?\n\n" +

                    "5h — 5 часов\n" +
                    "5m — 5 минут\n" +
                    "5s — 5 секунд\n" +
                    "5d — 5 дней\n\n" +

                    "⚠️ Максимум — 15 дней."
                );

                return;
            }

            // ==========================================
            // REGISTRATION BUTTON
            // ==========================================

            if (
                text ===
                "📝 Регистрация"
            ) {

                return startRegistration(
                    msg.chat.id,
                    userId
                );
            }

            // ==========================================
            // LOGIN BUTTON
            // ==========================================

            if (
                text === "🔐 Войти"
            ) {

                return startLogin(
                    msg.chat.id,
                    userId
                );
            }

            // ==========================================
            // SUPPORT
            // ==========================================

            if (
                text ===
                "🛠 Тех.поддержка"
            ) {

                return bot.sendMessage(

                    msg.chat.id,

                    `🛠 Тех.поддержка: ` +
                    `${SUPPORT_USERNAME}`
                );
            }

            // ==========================================
            // BUY
            // ==========================================

            if (
                text === "🛒 Купить"
            ) {

                return bot.sendMessage(

                    msg.chat.id,

                    "🛒 Выберите тариф:",

                    buyMenu()
                );
            }

            // ==========================================
            // HELP
            // ==========================================

            if (
                text === "ℹ️ Помощь"
            ) {

                return bot.sendMessage(

                    msg.chat.id,

                    "ℹ️ Помощь\n\n" +

                    "📝 Регистрация — " +
                    "создать аккаунт.\n\n" +

                    "🔐 Войти — " +
                    "вход по email и паролю.\n\n" +

                    "🛒 Купить — " +
                    "приобрести подписку.\n\n" +

                    "🛠 Тех.поддержка — " +
                    "связаться с поддержкой.\n\n" +

                    `💳 Карта: ${CARD_NUMBER}\n` +
                    `${CARD_HOLDER}\n\n` +

                    getStatusText(),

                    mainMenu()
                );
            }

            // ==================================================
            // CURRENT STATE
            // ==================================================

            const state =
                userStates.get(
                    userId
                );

            if (!state)
                return;

            // ==================================================
            // REGISTRATION
            // ==================================================

            if (
                state.type ===
                "register"
            ) {

                // -------------------------
                // NAME
                // -------------------------

                if (
                    state.step ===
                    "name"
                ) {

                    if (
                        text.length < 2 ||
                        text.length > 100
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Имя должно " +
                            "содержать от 2 " +
                            "до 100 символов."
                        );

                        return;
                    }

                    state.name =
                        text;

                    state.step =
                        "email";

                    userStates.set(
                        userId,
                        state
                    );

                    await bot.sendMessage(

                        msg.chat.id,

                        "📧 Введите ваш email:\n\n" +
                        "Например:\n" +
                        "example@gmail.com"
                    );

                    return;
                }

                // -------------------------
                // EMAIL
                // -------------------------

                if (
                    state.step ===
                    "email"
                ) {

                    const email =
                        normalizeEmail(
                            text
                        );

                    if (
                        !validEmail(
                            email
                        )
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Неверный формат email."
                        );

                        return;
                    }

                    const existing =
                        getUserByEmail(
                            email
                        );

                    if (
                        existing &&
                        existing.email_verified
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Этот email " +
                            "уже зарегистрирован.\n\n" +

                            "Нажмите «🔐 Войти».",

                            mainMenu()
                        );

                        userStates.delete(
                            userId
                        );

                        return;
                    }

                    const code =
                        generateCode();

                    try {

                        await sendVerificationCode(

                            email,

                            code,

                            "register"
                        );

                    } catch (error) {

                        console.error(
                            "MAIL ERROR:",
                            error
                        );

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Не удалось " +
                            "отправить письмо.\n\n" +

                            "Проверьте SMTP-настройки."
                        );

                        return;
                    }

                    pendingAuth.set(

                        userId,

                        {

                            type:
                                "register",

                            email:
                                email,

                            name:
                                state.name,

                            code:
                                code,

                            expiresAt:
                                Date.now() +
                                10 * 60 * 1000,

                            attempts:
                                0
                        }
                    );

                    state.step =
                        "code";

                    userStates.set(
                        userId,
                        state
                    );

                    await bot.sendMessage(

                        msg.chat.id,

                        "📨 Код отправлен на:\n" +
                        `${email}\n\n` +

                        "Введите 6-значный код:"
                    );

                    return;
                }

                // -------------------------
                // CODE
                // -------------------------

                if (
                    state.step ===
                    "code"
                ) {

                    const pending =
                        pendingAuth.get(
                            userId
                        );

                    if (
                        !pending ||
                        pending.type !==
                        "register"
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Сессия регистрации " +
                            "истекла.\n\n" +

                            "Нажмите «📝 Регистрация»."
                        );

                        return;
                    }

                    if (
                        Date.now() >
                        pending.expiresAt
                    ) {

                        clearAuth(
                            userId
                        );

                        userStates.delete(
                            userId
                        );

                        await bot.sendMessage(

                            msg.chat.id,

                            "⌛ Код истёк.\n\n" +
                            "Начните регистрацию заново."
                        );

                        return;
                    }

                    if (
                        !/^\d{6}$/.test(text) ||
                        text !== pending.code
                    ) {

                        pending.attempts++;

                        if (
                            pending.attempts >= 5
                        ) {

                            clearAuth(
                                userId
                            );

                            userStates.delete(
                                userId
                            );

                            await bot.sendMessage(

                                msg.chat.id,

                                "❌ Слишком много " +
                                "неверных попыток.\n\n" +

                                "Начните регистрацию заново."
                            );

                            return;
                        }

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Неверный код.\n\n" +
                            "Попробуйте ещё раз."
                        );

                        return;
                    }

                    state.step =
                        "password";

                    state.email =
                        pending.email;

                    pendingAuth.delete(
                        userId
                    );

                    userStates.set(
                        userId,
                        state
                    );

                    await bot.sendMessage(

                        msg.chat.id,

                        "🔐 Создайте пароль.\n\n" +
                        "Минимум 6 символов:"
                    );

                    return;
                }

                // -------------------------
                // PASSWORD
                // -------------------------

                if (
                    state.step ===
                    "password"
                ) {

                    if (
                        !validPassword(
                            text
                        )
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Пароль должен " +
                            "быть от 6 до 128 символов."
                        );

                        return;
                    }

                    state.passwordHash =
                        hashPassword(
                            text
                        );

                    state.step =
                        "password2";

                    userStates.set(
                        userId,
                        state
                    );

                    await bot.sendMessage(

                        msg.chat.id,

                        "🔐 Повторите пароль:"
                    );

                    return;
                }

                // -------------------------
                // PASSWORD CONFIRM
                // -------------------------

                if (
                    state.step ===
                    "password2"
                ) {

                    if (
                        hashPassword(text) !==
                        state.passwordHash
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Пароли не совпадают.\n\n" +
                            "Введите пароль ещё раз:"
                        );

                        return;
                    }

                    const existing =
                        getUserByEmail(
                            state.email
                        );

                    if (
                        existing &&
                        existing.user_id !== userId
                    ) {

                        userStates.delete(
                            userId
                        );

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Этот email " +
                            "уже используется.",

                            mainMenu()
                        );

                        return;
                    }

                    db.prepare(`
                        UPDATE users
                        SET
                            username = ?,
                            name = ?,
                            email = ?,
                            password_hash = ?,
                            email_verified = 1
                        WHERE user_id = ?
                    `).run(

                        msg.from.username ||
                        null,

                        state.name,

                        state.email,

                        state.passwordHash,

                        userId
                    );

                    userStates.delete(
                        userId
                    );

                    clearAuth(
                        userId
                    );

                    await bot.sendMessage(

                        msg.chat.id,

                        "✅ Регистрация завершена!\n\n" +

                        `👤 Имя: ${state.name}\n` +

                        `📧 Email: ${state.email}\n\n` +

                        "Теперь нажмите «🔐 Войти».",

                        mainMenu()
                    );

                    return;
                }
            }

            // ==================================================
            // LOGIN
            // ==================================================

            if (
                state.type ===
                "login"
            ) {

                // -------------------------
                // LOGIN EMAIL
                // -------------------------

                if (
                    state.step ===
                    "email"
                ) {

                    const email =
                        normalizeEmail(
                            text
                        );

                    if (
                        !validEmail(
                            email
                        )
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Неверный формат email."
                        );

                        return;
                    }

                    const user =
                        getUserByEmail(
                            email
                        );

                    if (
                        !user ||
                        !user.email_verified ||
                        !user.password_hash
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Аккаунт с таким " +
                            "подтверждённым email " +
                            "не найден.\n\n" +

                            "Если аккаунта нет, " +
                            "нажмите «📝 Регистрация».",

                            mainMenu()
                        );

                        userStates.delete(
                            userId
                        );

                        return;
                    }

                    state.email =
                        email;

                    state.step =
                        "password";

                    userStates.set(
                        userId,
                        state
                    );

                    await bot.sendMessage(

                        msg.chat.id,

                        "🔐 Введите пароль:",

                        authMenu()
                    );

                    return;
                }

                // -------------------------
                // LOGIN PASSWORD
                // -------------------------

                if (
                    state.step ===
                    "password"
                ) {

                    const user =
                        getUserByEmail(
                            state.email
                        );

                    if (
                        !user ||
                        hashPassword(text) !==
                        user.password_hash
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Неверный email " +
                            "или пароль.\n\n" +

                            "Попробуйте ещё раз " +
                            "или выберите " +
                            "«Забыли пароль».",

                            authMenu()
                        );

                        return;
                    }

                    userStates.delete(
                        userId
                    );

                    let subscriptionText =
                        "🛒 Активной подписки нет.";

                    if (
                        isSubActive(
                            userId
                        )
                    ) {

                        const until =
                            new Date(
                                user.sub_until
                            ).toLocaleString(
                                "ru-RU"
                            );

                        subscriptionText =
                            "✅ Подписка активна.\n\n" +
                            `📅 До: ${until}\n\n` +
                            "🔑 Ваш ключ:\n" +
                            `\`${userId}\``;
                    }

                    await bot.sendMessage(

                        msg.chat.id,

                        "✅ Вход выполнен!\n\n" +

                        `👤 Имя: ` +
                        `${user.name || "не указано"}\n` +

                        `📧 Email: ` +
                        `${user.email}\n\n` +

                        subscriptionText,

                        {
                            parse_mode:
                                "Markdown",

                            ...mainMenu()
                        }
                    );

                    return;
                }
            }

            // ==================================================
            // FORGOT PASSWORD
            // ==================================================

            if (
                state.type ===
                "forgot"
            ) {

                // -------------------------
                // EMAIL
                // -------------------------

                if (
                    state.step ===
                    "email"
                ) {

                    const email =
                        normalizeEmail(
                            text
                        );

                    if (
                        !validEmail(
                            email
                        )
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Неверный формат email."
                        );

                        return;
                    }

                    const user =
                        getUserByEmail(
                            email
                        );

                    if (
                        !user ||
                        !user.email_verified
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Подтверждённый " +
                            "аккаунт с таким email " +
                            "не найден."
                        );

                        return;
                    }

                    const code =
                        generateCode();

                    try {

                        await sendVerificationCode(

                            email,

                            code,

                            "reset"
                        );

                    } catch (error) {

                        console.error(
                            "MAIL ERROR:",
                            error
                        );

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Не удалось " +
                            "отправить письмо."
                        );

                        return;
                    }

                    pendingAuth.set(

                        userId,

                        {

                            type:
                                "forgot",

                            email:
                                email,

                            code:
                                code,

                            expiresAt:
                                Date.now() +
                                10 * 60 * 1000,

                            attempts:
                                0
                        }
                    );

                    state.step =
                        "code";

                    userStates.set(
                        userId,
                        state
                    );

                    await bot.sendMessage(

                        msg.chat.id,

                        "📨 Код восстановления " +
                        "отправлен на:\n" +

                        `${email}\n\n` +

                        "Введите код:"
                    );

                    return;
                }

                // -------------------------
                // CODE
                // -------------------------

                if (
                    state.step ===
                    "code"
                ) {

                    const pending =
                        pendingAuth.get(
                            userId
                        );

                    if (
                        !pending ||
                        pending.type !==
                        "forgot"
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Сессия истекла."
                        );

                        return;
                    }

                    if (
                        Date.now() >
                        pending.expiresAt
                    ) {

                        clearAuth(
                            userId
                        );

                        userStates.delete(
                            userId
                        );

                        await bot.sendMessage(

                            msg.chat.id,

                            "⌛ Код истёк."
                        );

                        return;
                    }

                    if (
                        !/^\d{6}$/.test(text) ||
                        text !== pending.code
                    ) {

                        pending.attempts++;

                        if (
                            pending.attempts >= 5
                        ) {

                            clearAuth(
                                userId
                            );

                            userStates.delete(
                                userId
                            );

                            await bot.sendMessage(

                                msg.chat.id,

                                "❌ Слишком много " +
                                "неверных попыток."
                            );

                            return;
                        }

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Неверный код."
                        );

                        return;
                    }

                    pendingAuth.delete(
                        userId
                    );

                    state.step =
                        "new_password";

                    userStates.set(
                        userId,
                        state
                    );

                    await bot.sendMessage(

                        msg.chat.id,

                        "🔐 Введите новый пароль.\n\n" +
                        "Минимум 6 символов:"
                    );

                    return;
                }

                // -------------------------
                // NEW PASSWORD
                // -------------------------

                if (
                    state.step ===
                    "new_password"
                ) {

                    if (
                        !validPassword(
                            text
                        )
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Пароль должен " +
                            "быть от 6 до 128 символов."
                        );

                        return;
                    }

                    state.passwordHash =
                        hashPassword(
                            text
                        );

                    state.step =
                        "new_password2";

                    userStates.set(
                        userId,
                        state
                    );

                    await bot.sendMessage(

                        msg.chat.id,

                        "🔐 Повторите новый пароль:"
                    );

                    return;
                }

                // -------------------------
                // CONFIRM NEW PASSWORD
                // -------------------------

                if (
                    state.step ===
                    "new_password2"
                ) {

                    if (
                        hashPassword(text) !==
                        state.passwordHash
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Пароли не совпадают."
                        );

                        return;
                    }

                    db.prepare(`
                        UPDATE users
                        SET password_hash = ?
                        WHERE lower(email) = lower(?)
                    `).run(

                        state.passwordHash,

                        state.email
                    );

                    userStates.delete(
                        userId
                    );

                    clearAuth(
                        userId
                    );

                    await bot.sendMessage(

                        msg.chat.id,

                        "✅ Пароль изменён!\n\n" +
                        "Теперь нажмите «🔐 Войти».",

                        mainMenu()
                    );

                    return;
                }
            }

            // ==================================================
            // BUY ORDER
            // ==================================================

            if (
                state.type ===
                "buy"
            ) {

                // NAME

                if (
                    state.step ===
                    "name"
                ) {

                    if (
                        text.length < 2 ||
                        text.length > 100
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Имя должно " +
                            "содержать от 2 " +
                            "до 100 символов."
                        );

                        return;
                    }

                    state.name =
                        text;

                    state.step =
                        "email";

                    userStates.set(
                        userId,
                        state
                    );

                    await bot.sendMessage(

                        msg.chat.id,

                        "📧 Введите email " +
                        "для заказа:"
                    );

                    return;
                }

                // EMAIL

                if (
                    state.step ===
                    "email"
                ) {

                    const email =
                        normalizeEmail(
                            text
                        );

                    if (
                        !validEmail(
                            email
                        )
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Неверный формат email."
                        );

                        return;
                    }

                    const tariff =
                        TARIFFS[
                            state.tariffKey
                        ];

                    const orderId =
                        createOrder(

                            userId,

                            state.tariffKey,

                            state.name,

                            email
                        );

                    userStates.delete(
                        userId
                    );

                    await bot.sendMessage(

                        msg.chat.id,

                        "🧾 ЗАКАЗ СОЗДАН\n\n" +

                        `№ Заказа: ` +
                        `\`${orderId}\`\n\n` +

                        `👤 Имя: ` +
                        `${state.name}\n` +

                        `📧 Email: ` +
                        `${email}\n\n` +

                        `📦 Тариф: ` +
                        `${tariff.name}\n` +

                        `💰 Сумма: ` +
                        `${tariff.price} ₽\n\n` +

                        "💳 Реквизиты для оплаты:\n\n" +

                        `Карта: ` +
                        `\`${CARD_NUMBER}\`\n` +

                        `${CARD_HOLDER}\n\n` +

                        "⚠️ В комментарии " +
                        "к переводу обязательно " +
                        "укажите номер заказа:\n\n" +

                        `\`${orderId}\`\n\n` +

                        "После оплаты нажмите " +
                        "кнопку ниже и отправьте чек.",

                        {

                            parse_mode:
                                "Markdown",

                            reply_markup: {

                                inline_keyboard: [

                                    [

                                        {
                                            text:
                                                "📷 Я оплатил",

                                            callback_data:
                                                `paid_${orderId}`
                                        }

                                    ],

                                    [

                                        {
                                            text:
                                                "⬅️ Назад",

                                            callback_data:
                                                "back"
                                        }

                                    ]

                                ]
                            }
                        }
                    );

                    return;
                }
            }

        } catch (error) {

            console.error(
                "MESSAGE ERROR:",
                error
            );
        }
    }
);

// ============================================================
// CALLBACKS
// ============================================================

bot.on(
    "callback_query",
    async query => {

        try {

            const data =
                query.data;

            const chatId =
                query.message.chat.id;

            const messageId =
                query.message.message_id;

            const userId =
                query.from.id;

            // ADMIN ONLINE

            if (
                data ===
                "admin_online"
            ) {

                if (
                    !isAdmin(userId)
                ) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text:
                                "Нет доступа",

                            show_alert:
                                true
                        }
                    );

                    return;
                }

                setAdminOnline(
                    userId
                );

                await bot.answerCallbackQuery(

                    query.id,

                    {
                        text:
                            "Вы онлайн 🟢"
                    }
                );

                await bot.sendMessage(

                    chatId,

                    "🟢 Вы онлайн!\n\n" +
                    getStatusText(),

                    adminMenu()
                );

                return;
            }

            // ADMIN OFFLINE

            if (
                data ===
                "admin_offline"
            ) {

                if (
                    !isAdmin(userId)
                ) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text:
                                "Нет доступа",

                            show_alert:
                                true
                        }
                    );

                    return;
                }

                adminWaitingTime.add(
                    userId
                );

                await bot.answerCallbackQuery(
                    query.id
                );

                await bot.sendMessage(

                    chatId,

                    "⏱ На какое время " +
                    "вы будете не онлайн?\n\n" +

                    "5h\n" +
                    "5m\n" +
                    "5s\n" +
                    "5d\n\n" +

                    "Можно:\n" +
                    "2d 5h 30m\n\n" +

                    "⚠️ Максимум — 15 дней."
                );

                return;
            }

            // FORGOT PASSWORD

            if (
                data ===
                "forgot_password"
            ) {

                await bot.answerCallbackQuery(
                    query.id
                );

                return startForgotPassword(
                    chatId,
                    userId
                );
            }

            // BACK

            if (
                data ===
                "back"
            ) {

                clearAuth(
                    userId
                );

                userStates.delete(
                    userId
                );

                await bot.answerCallbackQuery(
                    query.id
                );

                await bot.sendMessage(

                    chatId,

                    "📋 Главное меню.\n\n" +
                    getStatusText(),

                    mainMenu()
                );

                return;
            }

            // BUY

            if (
                data.startsWith(
                    "buy_"
                )
            ) {

                const tariffKey =
                    data.substring(4);

                const tariff =
                    TARIFFS[tariffKey];

                if (!tariff)
                    return;

                upsertUser(
                    userId,
                    query.from.username ||
                    null
                );

                userStates.set(

                    userId,

                    {

                        type:
                            "buy",

                        step:
                            "name",

                        tariffKey:
                            tariffKey
                    }
                );

                await bot.answerCallbackQuery(
                    query.id
                );

                await bot.sendMessage(

                    chatId,

                    `📦 Вы выбрали: ` +
                    `${tariff.name}\n` +

                    `💰 Цена: ` +
                    `${tariff.price} ₽\n\n` +

                    "👤 Введите ваше имя:"
                );

                return;
            }

            // CONFIRM ORDER

            if (
                data.startsWith(
                    "confirm_"
                )
            ) {

                if (
                    !isAdmin(userId)
                ) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text:
                                "Нет доступа",

                            show_alert:
                                true
                        }
                    );

                    return;
                }

                const orderId =
                    data.substring(8);

                const result =
                    confirmOrder(
                        orderId
                    );

                if (
                    !result.success
                ) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text:
                                result.reason ===
                                "already_processed"

                                    ? "Заказ уже обработан"

                                    : "Заказ не найден",

                            show_alert:
                                true
                        }
                    );

                    return;
                }

                await bot.answerCallbackQuery(

                    query.id,

                    {
                        text:
                            "Оплата подтверждена ✅"
                    }
                );

                try {

                    await bot.editMessageReplyMarkup(

                        {
                            inline_keyboard:
                                []
                        },

                        {
                            chat_id:
                                chatId,

                            message_id:
                                messageId
                        }
                    );

                } catch (_) {}

                await bot.sendMessage(

                    result.userId,

                    "🎉 Оплата подтверждена!\n\n" +

                    `👤 Имя: ` +
                    `${result.order.name}\n` +

                    `📧 Email: ` +
                    `${result.order.email}\n\n` +

                    "📅 Подписка до:\n" +

                    `${result.until.toLocaleString(
                        "ru-RU"
                    )}\n\n` +

                    "🔑 Ваш ключ:\n" +

                    `\`${result.userId}\``,

                    {
                        parse_mode:
                            "Markdown"
                    }
                );

                return;
            }

            // REJECT ORDER

            if (
                data.startsWith(
                    "reject_"
                )
            ) {

                if (
                    !isAdmin(userId)
                ) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text:
                                "Нет доступа",

                            show_alert:
                                true
                        }
                    );

                    return;
                }

                const orderId =
                    data.substring(7);

                const result =
                    rejectOrder(
                        orderId
                    );

                if (
                    !result.success
                ) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text:
                                "Заказ уже обработан",

                            show_alert:
                                true
                        }
                    );

                    return;
                }

                await bot.answerCallbackQuery(

                    query.id,

                    {
                        text:
                            "Заказ отклонён ❌"
                    }
                );

                try {

                    await bot.editMessageReplyMarkup(

                        {
                            inline_keyboard:
                                []
                        },

                        {
                            chat_id:
                                chatId,

                            message_id:
                                messageId
                        }
                    );

                } catch (_) {}

                await bot.sendMessage(

                    result.userId,

                    "❌ Ваша оплата " +
                    "не была подтверждена.\n\n" +

                    "Свяжитесь с администратором."
                );

                return;
            }

            // PAID

            if (
                data.startsWith(
                    "paid_"
                )
            ) {

                const orderId =
                    data.substring(5);

                const order =
                    getOrder(
                        orderId
                    );

                if (!order) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text:
                                "Заказ не найден",

                            show_alert:
                                true
                        }
                    );

                    return;
                }

                await bot.answerCallbackQuery(
                    query.id
                );

                await bot.sendMessage(

                    chatId,

                    "📷 Отправьте чек оплаты.\n\n" +

                    `🧾 Заказ: ` +
                    `\`${orderId}\`\n` +

                    `👤 Имя: ` +
                    `${order.name}\n` +

                    `📧 Email: ` +
                    `${order.email}\n\n` +

                    `📦 Тариф: ` +
                    `${TARIFFS[
                        order.tariff
                    ].name}`,

                    {
                        parse_mode:
                            "Markdown"
                    }
                );

                return;
            }

        } catch (error) {

            console.error(
                "CALLBACK ERROR:",
                error
            );

            try {

                await bot.answerCallbackQuery(

                    query.id,

                    {
                        text:
                            "Произошла ошибка",

                        show_alert:
                            true
                    }
                );

            } catch (_) {}
        }
    }
);

// ============================================================
// CHECK / RECEIPT
// ============================================================

async function handleReceipt(msg) {

    try {

        const order =
            getPendingOrder(
                msg.from.id
            );

        if (!order) {

            await bot.sendMessage(

                msg.chat.id,

                "❌ У вас нет " +
                "ожидающего заказа."
            );

            return;
        }

        await bot.sendMessage(

            msg.chat.id,

            "✅ Чек получен!\n\n" +

            `🧾 Заказ: ` +
            `${order.order_id}\n\n` +

            "Ожидайте проверки " +
            "администратора."
        );

        const username =
            msg.from.username
                ? `@${msg.from.username}`
                : "нет";

        const adminText =

            "📩 НОВАЯ ЗАЯВКА\n\n" +

            `🧾 Заказ: ` +
            `\`${order.order_id}\`\n\n` +

            `👤 Имя: ` +
            `${order.name}\n` +

            `📧 Email: ` +
            `${order.email}\n` +

            `👤 User ID: ` +
            `${order.user_id}\n` +

            `👤 Username: ` +
            `${username}\n\n` +

            `📦 Тариф: ` +
            `${TARIFFS[
                order.tariff
            ].name}\n` +

            `💰 Сумма: ` +
            `${order.amount} ₽`;

        for (
            const adminId
            of ADMIN_IDS
        ) {

            try {

                await bot.sendMessage(

                    adminId,

                    adminText,

                    {
                        parse_mode:
                            "Markdown"
                    }
                );

                await bot.forwardMessage(

                    adminId,

                    msg.chat.id,

                    msg.message_id
                );

                await bot.sendMessage(

                    adminId,

                    `Выберите действие ` +
                    `с заказом ` +
                    `\`${order.order_id}\`:`,
                    
                    {
                        parse_mode:
                            "Markdown",

                        ...adminOrderButtons(
                            order.order_id
                        )
                    }
                );

            } catch (error) {

                console.error(

                    `Ошибка отправки ` +
                    `админу ${adminId}:`,

                    error.message
                );
            }
        }

    } catch (error) {

        console.error(
            "RECEIPT ERROR:",
            error
        );
    }
}

bot.on(
    "photo",
    handleReceipt
);

bot.on(
    "document",
    handleReceipt
);

// ============================================================
// START DATABASE
// ============================================================

initDb();

console.log(
    "=========================================="
);

console.log(
    "🤖 J.A.R.V.I.S BOT ЗАПУЩЕН"
);

console.log(
    "🛠 SUPPORT:",
    SUPPORT_USERNAME
);

console.log(
    "💾 DATABASE:",
    DB_FILE
);

console.log(
    "🟢 ONLINE ADMINS:",
    getOnlineAdminsCount()
);

console.log(
    "📧 SMTP:",
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER
);

console.log(
    "=========================================="
);
