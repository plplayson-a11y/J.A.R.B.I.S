const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");

// ============================================================
// J.A.R.B.I.S — TELEGRAM SUBSCRIPTION BOT
// БЕЗ РЕГИСТРАЦИИ / БЕЗ SMTP
// ПОКУПКА -> ЧЕК -> АДМИН -> КЛЮЧ -> ВХОД В ПРИЛОЖЕНИЕ
// ============================================================

// ============================================================
// НАСТРОЙКИ
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;

const ADMIN_IDS = [
    8723208814,
    8882462981
];

// ============================================================
// ТЕХ.ПОДДЕРЖКА
// ============================================================

const SUPPORT_APP = "@JARBIS_help";
const SUPPORT_BOT = "@sakuraYTST";

// ============================================================
// КАРТА
// Railway Variables:
// CARD_NUMBER
// CARD_HOLDER
// ============================================================

const CARD_NUMBER =
    process.env.CARD_NUMBER || "2200 1536 2364 5513";

const CARD_HOLDER =
    process.env.CARD_HOLDER || "Получатель: Алексей М.";

// ============================================================
// ПРОВЕРКА TOKEN
// ============================================================

if (!BOT_TOKEN) {
    console.error("❌ TELEGRAM_TOKEN не установлен!");
    process.exit(1);
}

// ============================================================
// ТАРИФЫ
// ============================================================

const TARIFFS = {

    "80": {
        name: "3 дня",
        days: 3,
        price: 80
    },

    "350": {
        name: "1 месяц",
        days: 30,
        price: 350
    },

    "700": {
        name: "3 месяца",
        days: 90,
        price: 700
    },

    "1400": {
        name: "6 месяцев",
        days: 180,
        price: 1400
    },

    "2800": {
        name: "1 год",
        days: 365,
        price: 2800
    },

    "5000": {
        name: "Навсегда",
        days: 36500,
        price: 5000
    }
};

// ============================================================
// DATABASE
// ============================================================

const DB_FILE = fs.existsSync("/data")
    ? "/data/subscriptions.db"
    : "./subscriptions.db";

const db = new Database(DB_FILE);

db.pragma("journal_mode = WAL");

// ============================================================
// DATABASE INIT
// ============================================================

function columnExists(table, column) {

    const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all();

    return columns.some(
        item => item.name === column
    );
}

function addColumn(table, column, definition) {

    if (!columnExists(table, column)) {

        db.exec(
            `ALTER TABLE ${table}
             ADD COLUMN ${column} ${definition}`
        );
    }
}

function initDb() {

    db.exec(`
        CREATE TABLE IF NOT EXISTS users (

            user_id INTEGER PRIMARY KEY,

            username TEXT,

            sub_until TEXT,

            total_paid INTEGER DEFAULT 0,

            app_key TEXT
        );

        CREATE TABLE IF NOT EXISTS payments (

            order_id TEXT PRIMARY KEY,

            user_id INTEGER NOT NULL,

            tariff TEXT NOT NULL,

            amount INTEGER NOT NULL,

            status TEXT NOT NULL,

            created_at TEXT NOT NULL,

            paid_at TEXT,

            name TEXT,

            username TEXT
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
        "username",
        "TEXT"
    );

    addColumn(
        "users",
        "sub_until",
        "TEXT"
    );

    addColumn(
        "users",
        "total_paid",
        "INTEGER DEFAULT 0"
    );

    addColumn(
        "users",
        "app_key",
        "TEXT"
    );

    addColumn(
        "payments",
        "name",
        "TEXT"
    );

    addColumn(
        "payments",
        "username",
        "TEXT"
    );

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

function upsertUser(userId, username = null) {

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

// ============================================================
// KEY
// ============================================================

function generateAppKey() {

    return crypto
        .randomBytes(16)
        .toString("hex")
        .toUpperCase();
}

function getOrCreateAppKey(userId) {

    const user = getUser(userId);

    if (!user) {
        upsertUser(userId);
    }

    const current = getUser(userId);

    if (
        current &&
        current.app_key
    ) {
        return current.app_key;
    }

    const key = generateAppKey();

    db.prepare(`
        UPDATE users
        SET app_key = ?
        WHERE user_id = ?
    `).run(
        key,
        userId
    );

    return key;
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

    const row = db.prepare(`
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
        online: row.online === 1,
        offlineUntil: row.offline_until
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

function setAdminOffline(userId, until) {

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
        id => getAdminStatus(id).online
    ).length;
}

function getStatusText() {

    if (
        getOnlineAdminsCount() > 0
    ) {

        return "🟢 Администратор в онлайне";
    }

    return (
        "🔴 Администратор сейчас " +
        "не может одобрить заявку.\n" +
        "Пожалуйста, подождите."
    );
}

// ============================================================
// ADMIN OFFLINE TIME
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

function formatDuration(seconds) {

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
        result.push(`${days}д`);

    if (hours)
        result.push(`${hours}ч`);

    if (minutes)
        result.push(`${minutes}мин`);

    if (seconds)
        result.push(`${seconds}сек`);

    return result.join(" ");
}

// ============================================================
// SUBSCRIPTION
// ============================================================

function isSubActive(userId) {

    const user = getUser(userId);

    if (
        !user ||
        !user.sub_until
    ) {

        return false;
    }

    return (
        new Date(user.sub_until) >
        new Date()
    );
}

function setSubscription(userId, days) {

    const user = getUser(userId);

    const now = new Date();

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
            days * 86400000
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
    username
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
            username
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

        username
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

    const key =
        getOrCreateAppKey(
            order.user_id
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

        key,

        order
    };
}

function rejectOrder(orderId) {

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
                        text: "🔐 Войти"
                    },

                    {
                        text: "🛒 Купить"
                    }
                ],

                [
                    {
                        text: "ℹ️ Помощь"
                    },

                    {
                        text: "🛠 Тех.поддержка"
                    }
                ]

            ],

            resize_keyboard: true,

            is_persistent: true
        }
    };
}

function buyMenu() {

    return {

        reply_markup: {

            inline_keyboard: [

                [
                    {
                        text: "80 ₽ — 3 дня",
                        callback_data: "buy_80"
                    }
                ],

                [
                    {
                        text: "350 ₽ — 1 месяц",
                        callback_data: "buy_350"
                    }
                ],

                [
                    {
                        text: "700 ₽ — 3 месяца",
                        callback_data: "buy_700"
                    }
                ],

                [
                    {
                        text: "1400 ₽ — 6 месяцев",
                        callback_data: "buy_1400"
                    }
                ],

                [
                    {
                        text: "2800 ₽ — 1 год",
                        callback_data: "buy_2800"
                    }
                ],

                [
                    {
                        text: "5000 ₽ — навсегда",
                        callback_data: "buy_5000"
                    }
                ],

                [
                    {
                        text: "⬅️ Назад",
                        callback_data: "back"
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
                        text: "🟢 Я онлайн",
                        callback_data: "admin_online"
                    }
                ],

                [
                    {
                        text: "🔴 Я не онлайн",
                        callback_data: "admin_offline"
                    }
                ]

            ]
        }
    };
}

function adminOrderButtons(orderId) {

    return {

        reply_markup: {

            inline_keyboard: [

                [

                    {
                        text: "✅ Подтвердить",
                        callback_data:
                            `confirm_${orderId}`
                    },

                    {
                        text: "❌ Отклонить",
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

const userStates = new Map();

const adminWaitingTime = new Set();

// ============================================================
// TELEGRAM
// ============================================================

const bot =
    new TelegramBot(
        BOT_TOKEN,
        {
            polling: true
        }
    );

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

                "👋 Добро пожаловать в J.A.R.V.I.S!\n\n" +

                "Это бот для покупки подписки.\n\n" +

                "Выберите действие.\n\n" +

                getStatusText(),

                mainMenu()
            );

            if (
                isAdmin(msg.from.id)
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
            !isAdmin(msg.from.id)
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
// MESSAGE
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

            // ==================================================
            // ADMIN OFFLINE TIME
            // ==================================================

            if (
                isAdmin(userId) &&
                adminWaitingTime.has(userId)
            ) {

                const seconds =
                    parseOfflineTime(text);

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
                        "5d\n" +
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

            // ==================================================
            // ADMIN ONLINE
            // ==================================================

            if (
                isAdmin(userId) &&
                text === "🟢 Я онлайн"
            ) {

                setAdminOnline(userId);

                await bot.sendMessage(

                    msg.chat.id,

                    "🟢 Вы снова онлайн!\n\n" +
                    getStatusText(),

                    adminMenu()
                );

                return;
            }

            // ==================================================
            // ADMIN OFFLINE
            // ==================================================

            if (
                isAdmin(userId) &&
                text === "🔴 Я не онлайн"
            ) {

                adminWaitingTime.add(userId);

                await bot.sendMessage(

                    msg.chat.id,

                    "⏱ На какое время вы будете не онлайн?\n\n" +

                    "5h — 5 часов\n" +
                    "5m — 5 минут\n" +
                    "5s — 5 секунд\n" +
                    "5d — 5 дней\n\n" +

                    "⚠️ Максимум — 15 дней."
                );

                return;
            }

            // ==================================================
            // ВХОД
            // ==================================================

            if (
                text === "🔐 Войти"
            ) {

                if (
                    !isSubActive(userId)
                ) {

                    await bot.sendMessage(

                        msg.chat.id,

                        "❌ Вход недоступен.\n\n" +

                        "Активной подписки нет.",

                        mainMenu()
                    );

                    return;
                }

                const key =
                    getOrCreateAppKey(
                        userId
                    );

                const user =
                    getUser(userId);

                await bot.sendMessage(

                    msg.chat.id,

                    "✅ Вход разрешён!\n\n" +

                    "🔑 Ваш ключ:\n" +
                    `\`${key}\`\n\n` +

                    "💻 Откройте приложение J.A.R.B.I.S\n" +
                    "и введите этот ключ для входа.\n\n" +

                    "📅 Подписка до:\n" +
                    `${new Date(
                        user.sub_until
                    ).toLocaleString("ru-RU")}`,

                    {
                        parse_mode: "Markdown"
                    }
                );

                return;
            }

            // ==================================================
            // ТЕХ.ПОДДЕРЖКА
            // ==================================================

            if (
                text === "🛠 Тех.поддержка"
            ) {

                await bot.sendMessage(

                    msg.chat.id,

                    "Тех.поддержка\n\n" +

                    `По приложению: ${SUPPORT_APP}\n\n` +

                    "Тех.поддержка по\n" +

                    `боту: ${SUPPORT_BOT}`
                );

                return;
            }

            // ==================================================
            // КУПИТЬ
            // ==================================================

            if (
                text === "🛒 Купить"
            ) {

                await bot.sendMessage(

                    msg.chat.id,

                    "🛒 Выберите тариф:",

                    buyMenu()
                );

                return;
            }

            // ==================================================
            // ПОМОЩЬ
            // ==================================================

            if (
                text === "ℹ️ Помощь"
            ) {

                await bot.sendMessage(

                    msg.chat.id,

                    "ℹ️ Помощь\n\n" +

                    "🔐 Войти — вход в приложение J.A.R.B.I.S.\n\n" +

                    "🛒 Купить — приобрести подписку.\n\n" +

                    "🛠 Тех.поддержка — связь с поддержкой.\n\n" +

                    `💳 Карта: ${CARD_NUMBER}\n` +
                    `${CARD_HOLDER}\n\n` +

                    getStatusText(),

                    mainMenu()
                );

                return;
            }

            // ==================================================
            // BUY STATE
            // ==================================================

            const state =
                userStates.get(userId);

            if (!state)
                return;

            if (
                state.type === "buy"
            ) {

                // NAME

                if (
                    state.step === "name"
                ) {

                    if (
                        text.length < 2 ||
                        text.length > 100
                    ) {

                        await bot.sendMessage(

                            msg.chat.id,

                            "❌ Имя должно содержать " +
                            "от 2 до 100 символов."
                        );

                        return;
                    }

                    state.name = text;

                    state.step = "confirm";

                    userStates.set(
                        userId,
                        state
                    );

                    const tariff =
                        TARIFFS[
                            state.tariffKey
                        ];

                    await bot.sendMessage(

                        msg.chat.id,

                        "🧾 Проверьте данные заказа:\n\n" +

                        `👤 Имя: ${state.name}\n` +

                        `📦 Тариф: ${tariff.name}\n` +

                        `💰 Сумма: ${tariff.price} ₽\n\n` +

                        "Нажмите кнопку ниже для создания заказа.",

                        {
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        {
                                            text: "✅ Создать заказ",
                                            callback_data:
                                                `createorder_${state.tariffKey}`
                                        }
                                    ],
                                    [
                                        {
                                            text: "⬅️ Назад",
                                            callback_data: "back"
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

            // ==================================================
            // ADMIN ONLINE
            // ==================================================

            if (
                data === "admin_online"
            ) {

                if (
                    !isAdmin(userId)
                ) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text: "Нет доступа",
                            show_alert: true
                        }
                    );

                    return;
                }

                setAdminOnline(userId);

                await bot.answerCallbackQuery(

                    query.id,

                    {
                        text: "Вы онлайн 🟢"
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

            // ==================================================
            // ADMIN OFFLINE
            // ==================================================

            if (
                data === "admin_offline"
            ) {

                if (
                    !isAdmin(userId)
                ) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text: "Нет доступа",
                            show_alert: true
                        }
                    );

                    return;
                }

                adminWaitingTime.add(userId);

                await bot.answerCallbackQuery(
                    query.id
                );

                await bot.sendMessage(

                    chatId,

                    "⏱ На какое время вы будете не онлайн?\n\n" +

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

            // ==================================================
            // BACK
            // ==================================================

            if (
                data === "back"
            ) {

                userStates.delete(userId);

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

            // ==================================================
            // BUY
            // ==================================================

            if (
                data.startsWith("buy_")
            ) {

                const tariffKey =
                    data.substring(4);

                const tariff =
                    TARIFFS[tariffKey];

                if (!tariff) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text: "Тариф не найден",
                            show_alert: true
                        }
                    );

                    return;
                }

                upsertUser(
                    userId,
                    query.from.username || null
                );

                userStates.set(

                    userId,

                    {
                        type: "buy",
                        step: "name",
                        tariffKey
                    }
                );

                await bot.answerCallbackQuery(
                    query.id
                );

                await bot.sendMessage(

                    chatId,

                    `📦 Вы выбрали: ${tariff.name}\n` +
                    `💰 Цена: ${tariff.price} ₽\n\n` +

                    "👤 Введите ваше имя:"
                );

                return;
            }

            // ==================================================
            // CREATE ORDER
            // ==================================================

            if (
                data.startsWith("createorder_")
            ) {

                const tariffKey =
                    data.substring(
                        "createorder_".length
                    );

                const state =
                    userStates.get(userId);

                if (
                    !state ||
                    state.type !== "buy" ||
                    state.tariffKey !== tariffKey
                ) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text: "Сессия заказа истекла",
                            show_alert: true
                        }
                    );

                    return;
                }

                const tariff =
                    TARIFFS[tariffKey];

                const orderId =
                    createOrder(

                        userId,

                        tariffKey,

                        state.name,

                        query.from.username || null
                    );

                userStates.delete(userId);

                await bot.answerCallbackQuery(
                    query.id
                );

                await bot.sendMessage(

                    chatId,

                    "🧾 ЗАКАЗ СОЗДАН\n\n" +

                    `№ Заказа: \`${orderId}\`\n\n` +

                    `👤 Имя: ${state.name}\n` +

                    `📦 Тариф: ${tariff.name}\n` +

                    `💰 Сумма: ${tariff.price} ₽\n\n` +

                    "💳 Реквизиты для оплаты:\n\n" +

                    `Карта: \`${CARD_NUMBER}\`\n` +

                    `${CARD_HOLDER}\n\n` +

                    "⚠️ После перевода отправьте чек " +
                    "кнопкой ниже.\n\n" +

                    `Номер заказа: \`${orderId}\``,

                    {

                        parse_mode: "Markdown",

                        reply_markup: {

                            inline_keyboard: [

                                [
                                    {
                                        text: "📷 Я оплатил",
                                        callback_data:
                                            `paid_${orderId}`
                                    }
                                ],

                                [
                                    {
                                        text: "⬅️ Назад",
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

            // ==================================================
            // PAID
            // ==================================================

            if (
                data.startsWith("paid_")
            ) {

                const orderId =
                    data.substring(5);

                const order =
                    getOrder(orderId);

                if (!order) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text: "Заказ не найден",
                            show_alert: true
                        }
                    );

                    return;
                }

                if (
                    Number(order.user_id) !==
                    Number(userId)
                ) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text: "Это не ваш заказ",
                            show_alert: true
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

                    `🧾 Заказ: \`${orderId}\`\n\n` +

                    `👤 Имя: ${order.name}\n` +

                    `📦 Тариф: ` +
                    `${TARIFFS[order.tariff].name}\n\n` +

                    "Отправьте фотографию чека " +
                    "или документ."
                );

                return;
            }

            // ==================================================
            // CONFIRM
            // ==================================================

            if (
                data.startsWith("confirm_")
            ) {

                if (
                    !isAdmin(userId)
                ) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text: "Нет доступа",
                            show_alert: true
                        }
                    );

                    return;
                }

                const orderId =
                    data.substring(8);

                const result =
                    confirmOrder(orderId);

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

                            show_alert: true
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
                            inline_keyboard: []
                        },

                        {
                            chat_id: chatId,
                            message_id: messageId
                        }
                    );

                } catch (_) {}

                await bot.sendMessage(

                    result.userId,

                    "🎉 Оплата подтверждена!\n\n" +

                    "📦 Ваша подписка активирована.\n\n" +

                    "🔑 Ваш ключ:\n" +
                    `\`${result.key}\`\n\n` +

                    "💻 Откройте приложение J.A.R.B.I.S\n" +
                    "и введите этот ключ для входа.",

                    {
                        parse_mode: "Markdown"
                    }
                );

                return;
            }

            // ==================================================
            // REJECT
            // ==================================================

            if (
                data.startsWith("reject_")
            ) {

                if (
                    !isAdmin(userId)
                ) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text: "Нет доступа",
                            show_alert: true
                        }
                    );

                    return;
                }

                const orderId =
                    data.substring(7);

                const result =
                    rejectOrder(orderId);

                if (
                    !result.success
                ) {

                    await bot.answerCallbackQuery(

                        query.id,

                        {
                            text: "Заказ уже обработан",
                            show_alert: true
                        }
                    );

                    return;
                }

                await bot.answerCallbackQuery(

                    query.id,

                    {
                        text: "Заказ отклонён ❌"
                    }
                );

                try {

                    await bot.editMessageReplyMarkup(

                        {
                            inline_keyboard: []
                        },

                        {
                            chat_id: chatId,
                            message_id: messageId
                        }
                    );

                } catch (_) {}

                await bot.sendMessage(

                    result.userId,

                    "❌ Ваша оплата не была подтверждена.\n\n" +

                    "Свяжитесь с тех.поддержкой:\n\n" +

                    `По приложению: ${SUPPORT_APP}\n\n` +

                    "Тех.поддержка по\n" +

                    `боту: ${SUPPORT_BOT}`
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
                        text: "Произошла ошибка",
                        show_alert: true
                    }
                );

            } catch (_) {}
        }
    }
);

// ============================================================
// RECEIPT
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

                "❌ У вас нет ожидающего заказа."
            );

            return;
        }

        await bot.sendMessage(

            msg.chat.id,

            "✅ Чек получен!\n\n" +

            `🧾 Заказ: ${order.order_id}\n\n` +

            "Ожидайте проверки администратора."
        );

        const username =
            msg.from.username
                ? `@${msg.from.username}`
                : "нет";

        const adminText =

            "📩 НОВАЯ ЗАЯВКА\n\n" +

            `🧾 Заказ: \`${order.order_id}\`\n\n` +

            `👤 Имя: ${order.name}\n` +

            `👤 User ID: ${order.user_id}\n` +

            `👤 Username: ${username}\n\n` +

            `📦 Тариф: ` +
            `${TARIFFS[order.tariff].name}\n` +

            `💰 Сумма: ${order.amount} ₽`;

        for (
            const adminId of ADMIN_IDS
        ) {

            try {

                await bot.sendMessage(

                    adminId,

                    adminText,

                    {
                        parse_mode: "Markdown"
                    }
                );

                await bot.forwardMessage(

                    adminId,

                    msg.chat.id,

                    msg.message_id
                );

                await bot.sendMessage(

                    adminId,

                    `Выберите действие с заказом ` +
                    `\`${order.order_id}\`:`,
                    
                    {
                        parse_mode: "Markdown",
                        ...adminOrderButtons(
                            order.order_id
                        )
                    }
                );

            } catch (error) {

                console.error(

                    `Ошибка отправки админу ` +
                    `${adminId}:`,

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

// ============================================================
// RECEIPT EVENTS
// ============================================================

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
    "🤖 J.A.R.B.I.S БОТ ЗАПУЩЕН"
);

console.log(
    "🛠 SUPPORT APP:",
    SUPPORT_APP
);

console.log(
    "🛠 SUPPORT BOT:",
    SUPPORT_BOT
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
    "💳 CARD:",
    CARD_NUMBER
);

console.log(
    "=========================================="
);
