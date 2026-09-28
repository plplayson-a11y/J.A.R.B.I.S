const TelegramBot = require("node-telegram-bot-api");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");

// ================= НАСТРОЙКИ =================

const BOT_TOKEN = process.env.TELEGRAM_TOKEN;

const ADMIN_IDS = [
    8723208814,
    8882462981
];

const SUPPORT = "@JARBIS_help";

const CARD_NUMBER =
    process.env.CARD_NUMBER || "2200 1536 2364 5513";

const CARD_HOLDER =
    process.env.CARD_HOLDER || "Получатель: Алексей М.";

// ================= ТАРИФЫ =================

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

if (!BOT_TOKEN) {
    console.error("❌ Не найдена переменная TELEGRAM_TOKEN");
    process.exit(1);
}

// ================= БОТ =================

const bot = new TelegramBot(BOT_TOKEN, {
    polling: true
});

// ================= БАЗА =================

const DB_FILE = fs.existsSync("/data")
    ? "/data/subscriptions.db"
    : "./subscriptions.db";

const db = new Database(DB_FILE);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
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
    paid_at TEXT,
    name TEXT,
    email TEXT
);

CREATE TABLE IF NOT EXISTS admins (
    user_id INTEGER PRIMARY KEY,
    online INTEGER DEFAULT 1,
    offline_until TEXT
);
`);

// ================= АДМИНЫ =================

for (const id of ADMIN_IDS) {
    db.prepare(`
        INSERT OR IGNORE INTO admins
        (user_id, online, offline_until)
        VALUES (?, 1, NULL)
    `).run(id);
}

function isAdmin(id) {
    return ADMIN_IDS.includes(Number(id));
}

function adminOnline(id) {

    const row = db.prepare(`
        SELECT *
        FROM admins
        WHERE user_id = ?
    `).get(id);

    if (!row) return false;

    if (
        row.online === 0 &&
        row.offline_until
    ) {
        if (
            new Date(row.offline_until) <= new Date()
        ) {

            db.prepare(`
                UPDATE admins
                SET online = 1,
                    offline_until = NULL
                WHERE user_id = ?
            `).run(id);

            return true;
        }
    }

    return row.online === 1;
}

function anyAdminOnline() {
    return ADMIN_IDS.some(id => adminOnline(id));
}

function onlineCount() {
    return ADMIN_IDS.filter(id => adminOnline(id)).length;
}

function setOnline(id) {

    db.prepare(`
        UPDATE admins
        SET online = 1,
            offline_until = NULL
        WHERE user_id = ?
    `).run(id);
}

function setOffline(id, until) {

    db.prepare(`
        UPDATE admins
        SET online = 0,
            offline_until = ?
        WHERE user_id = ?
    `).run(
        until.toISOString(),
        id
    );
}

// ================= ПОЛЬЗОВАТЕЛИ =================

function saveUser(id, username) {

    db.prepare(`
        INSERT OR IGNORE INTO users
        (user_id, username)
        VALUES (?, ?)
    `).run(id, username || null);

    if (username) {
        db.prepare(`
            UPDATE users
            SET username = ?
            WHERE user_id = ?
        `).run(username, id);
    }
}

function getUser(id) {

    return db.prepare(`
        SELECT *
        FROM users
        WHERE user_id = ?
    `).get(id);
}

// ================= ПОДПИСКА =================

function subscriptionActive(id) {

    const user = getUser(id);

    if (!user || !user.sub_until) {
        return false;
    }

    return new Date(user.sub_until) > new Date();
}

function giveSubscription(id, days) {

    const user = getUser(id);

    const now = new Date();

    let start = now;

    if (user && user.sub_until) {

        const current = new Date(user.sub_until);

        if (current > now) {
            start = current;
        }
    }

    const until = new Date(
        start.getTime() +
        days * 24 * 60 * 60 * 1000
    );

    db.prepare(`
        UPDATE users
        SET sub_until = ?
        WHERE user_id = ?
    `).run(
        until.toISOString(),
        id
    );

    return until;
}

// ================= ЗАКАЗ =================

function createOrder(id, tariffKey, name, email) {

    const tariff = TARIFFS[tariffKey];

    const orderId = crypto
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
        id,
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

function getPendingOrder(id) {

    return db.prepare(`
        SELECT *
        FROM payments
        WHERE user_id = ?
        AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1
    `).get(id);
}

// ================= СОСТОЯНИЯ =================

const userStates = new Map();
const adminWaiting = new Set();

// ================= ГЛАВНОЕ МЕНЮ =================

function mainMenu() {

    return {
        reply_markup: {
            keyboard: [
                [
                    { text: "🔑 Войти" },
                    { text: "🛒 Купить" }
                ],
                [
                    { text: "ℹ️ Помощь" },
                    { text: "🛠 Тех.поддержка" }
                ]
            ],
            resize_keyboard: true,
            is_persistent: true
        }
    };
}

// ================= ТАРИФЫ =================

function tariffMenu() {

    return {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "50 ₽ — 3 дня",
                        callback_data: "buy_50"
                    }
                ],
                [
                    {
                        text: "200 ₽ — 1 месяц",
                        callback_data: "buy_200"
                    }
                ],
                [
                    {
                        text: "600 ₽ — навсегда",
                        callback_data: "buy_600"
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

// ================= АДМИН МЕНЮ =================

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

// ================= КНОПКИ ЗАЯВКИ =================

function orderButtons(orderId) {

    return {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "✅ Подтвердить",
                        callback_data: `confirm_${orderId}`
                    },
                    {
                        text: "❌ Отклонить",
                        callback_data: `reject_${orderId}`
                    }
                ]
            ]
        }
    };
}

// ================= /START =================

bot.onText(/^\/start$/, async msg => {

    saveUser(
        msg.from.id,
        msg.from.username
    );

    const status = anyAdminOnline()
        ? "🟢 Администратор в онлайне"
        : "🔴 Администратор сейчас не может одобрить заявку.\nПожалуйста, подождите.";

    await bot.sendMessage(
        msg.chat.id,
        `👋 Добро пожаловать в J.A.R.V.I.S!\n\n` +
        `Это бот для покупки подписки.\n\n` +
        `Выберите действие.\n\n${status}`,
        mainMenu()
    );

    if (isAdmin(msg.from.id)) {

        await bot.sendMessage(
            msg.chat.id,
            `👨‍💼 Панель администратора\n\n` +
            `🟢 Администраторов онлайн: ${onlineCount()}/2`,
            adminMenu()
        );
    }
});

// ================= /ID =================

bot.onText(/^\/id$/, async msg => {

    await bot.sendMessage(
        msg.chat.id,
        `🆔 Ваш Telegram ID:\n\n${msg.from.id}`
    );
});

// ================= /ADMIN =================

bot.onText(/^\/admin$/, async msg => {

    if (!isAdmin(msg.from.id)) return;

    await bot.sendMessage(
        msg.chat.id,
        `👨‍💼 Панель администратора\n\n` +
        `🟢 Онлайн: ${onlineCount()}/2`,
        adminMenu()
    );
});

// ================= ТЕКСТОВЫЕ СООБЩЕНИЯ =================

bot.on("message", async msg => {

    if (!msg.text) return;

    const text = msg.text.trim();

    // ---------------- ADMIN TIME ----------------

    if (
        isAdmin(msg.from.id) &&
        adminWaiting.has(msg.from.id)
    ) {

        const match =
            text.match(/^(\d+)\s*(s|m|h|d)$/i);

        if (!match) {

            await bot.sendMessage(
                msg.chat.id,
                "❌ Неверный формат.\n\n" +
                "Примеры:\n" +
                "5s\n" +
                "5m\n" +
                "5h\n" +
                "5d\n\n" +
                "Максимум — 15 дней."
            );

            return;
        }

        const number = Number(match[1]);
        const unit = match[2].toLowerCase();

        let seconds = 0;

        if (unit === "s")
            seconds = number;

        if (unit === "m")
            seconds = number * 60;

        if (unit === "h")
            seconds = number * 3600;

        if (unit === "d")
            seconds = number * 86400;

        if (seconds > 15 * 86400) {

            await bot.sendMessage(
                msg.chat.id,
                "❌ Максимум — 15 дней."
            );

            return;
        }

        const until = new Date(
            Date.now() + seconds * 1000
        );

        setOffline(
            msg.from.id,
            until
        );

        adminWaiting.delete(
            msg.from.id
        );

        await bot.sendMessage(
            msg.chat.id,
            `🔴 Вы офлайн.\n\n` +
            `До: ${until.toLocaleString("ru-RU")}\n\n` +
            `Когда вернётесь, нажмите «🟢 Я онлайн».`,
            adminMenu()
        );

        return;
    }

    // ---------------- ONLINE ----------------

    if (
        isAdmin(msg.from.id) &&
        text === "🟢 Я онлайн"
    ) {

        setOnline(msg.from.id);

        await bot.sendMessage(
            msg.chat.id,
            "🟢 Вы снова онлайн!",
            adminMenu()
        );

        return;
    }

    // ---------------- OFFLINE ----------------

    if (
        isAdmin(msg.from.id) &&
        text === "🔴 Я не онлайн"
    ) {

        adminWaiting.add(
            msg.from.id
        );

        await bot.sendMessage(
            msg.chat.id,
            "⏱ Напишите время отсутствия:\n\n" +
            "5s — 5 секунд\n" +
            "5m — 5 минут\n" +
            "5h — 5 часов\n" +
            "5d — 5 дней\n\n" +
            "Максимум — 15 дней."
        );

        return;
    }

    // ---------------- SUPPORT ----------------

    if (
        text === "🛠 Тех.поддержка"
    ) {

        await bot.sendMessage(
            msg.chat.id,
            `🛠 Тех.поддержка:\n${SUPPORT}`,
            mainMenu()
        );

        return;
    }

    // ---------------- LOGIN ----------------

    if (
        text === "🔑 Войти"
    ) {

        if (!subscriptionActive(msg.from.id)) {

            await bot.sendMessage(
                msg.chat.id,
                "❌ У вас нет активной подписки.\n\n" +
                "Нажмите «🛒 Купить».",
                mainMenu()
            );

            return;
        }

        const user =
            getUser(msg.from.id);

        await bot.sendMessage(
            msg.chat.id,
            `✅ Подписка активна!\n\n` +
            `📅 До: ${new Date(user.sub_until).toLocaleString("ru-RU")}\n\n` +
            `🔑 Ваш ключ:\n\n` +
            `\`${msg.from.id}\``,
            {
                parse_mode: "Markdown",
                ...mainMenu()
            }
        );

        return;
    }

    // ---------------- BUY ----------------

    if (
        text === "🛒 Купить"
    ) {

        await bot.sendMessage(
            msg.chat.id,
            "🛒 Выберите тариф:",
            tariffMenu()
        );

        return;
    }

    // ---------------- HELP ----------------

    if (
        text === "ℹ️ Помощь"
    ) {

        const status = anyAdminOnline()
            ? "🟢 Администратор в онлайне"
            : "🔴 Администратор сейчас не может одобрить заявку.";

        await bot.sendMessage(
            msg.chat.id,
            `ℹ️ Помощь\n\n` +
            `🔑 Войти — получить ключ.\n` +
            `🛒 Купить — приобрести подписку.\n` +
            `🛠 Тех.поддержка — поддержка.\n\n` +
            `💳 Карта: ${CARD_NUMBER}\n` +
            `${CARD_HOLDER}\n\n` +
            status,
            mainMenu()
        );

        return;
    }

    // ---------------- NAME / EMAIL ----------------

    const state =
        userStates.get(msg.from.id);

    if (!state) return;

    if (state.step === "name") {

        const name = text;

        if (name.length < 2) {

            await bot.sendMessage(
                msg.chat.id,
                "❌ Введите нормальное имя."
            );

            return;
        }

        state.name = name;
        state.step = "email";

        userStates.set(
            msg.from.id,
            state
        );

        await bot.sendMessage(
            msg.chat.id,
            "📧 Теперь введите ваш email:"
        );

        return;
    }

    if (state.step === "email") {

        const email = text;

        const emailRegex =
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailRegex.test(email)) {

            await bot.sendMessage(
                msg.chat.id,
                "❌ Неверный email.\n\n" +
                "Пример:\n" +
                "example@gmail.com"
            );

            return;
        }

        const tariff =
            TARIFFS[state.tariffKey];

        const orderId =
            createOrder(
                msg.from.id,
                state.tariffKey,
                state.name,
                email
            );

        userStates.delete(
            msg.from.id
        );

        await bot.sendMessage(
            msg.chat.id,
            `🧾 ЗАКАЗ СОЗДАН\n\n` +
            `№ Заказа: \`${orderId}\`\n\n` +
            `👤 Имя: ${state.name}\n` +
            `📧 Email: ${email}\n\n` +
            `📦 Тариф: ${tariff.name}\n` +
            `💰 Сумма: ${tariff.price} ₽\n\n` +
            `💳 Реквизиты:\n\n` +
            `Карта: \`${CARD_NUMBER}\`\n` +
            `${CARD_HOLDER}\n\n` +
            `⚠️ В комментарии к переводу укажите номер заказа:\n\n` +
            `\`${orderId}\`\n\n` +
            `После оплаты нажмите «📷 Я оплатил».`,
            {
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "📷 Я оплатил",
                                callback_data: `paid_${orderId}`
                            }
                        ]
                    ]
                }
            }
        );

        return;
    }
});

// ================= CALLBACK =================

bot.on("callback_query", async query => {

    const data = query.data;
    const chatId = query.message.chat.id;

    // -------- ADMIN ONLINE --------

    if (data === "admin_online") {

        if (!isAdmin(query.from.id)) return;

        setOnline(query.from.id);

        await bot.answerCallbackQuery(
            query.id,
            { text: "🟢 Вы онлайн" }
        );

        await bot.sendMessage(
            chatId,
            "🟢 Вы снова онлайн!",
            adminMenu()
        );

        return;
    }

    // -------- ADMIN OFFLINE --------

    if (data === "admin_offline") {

        if (!isAdmin(query.from.id)) return;

        adminWaiting.add(
            query.from.id
        );

        await bot.answerCallbackQuery(
            query.id
        );

        await bot.sendMessage(
            chatId,
            "⏱ На сколько вы будете офлайн?\n\n" +
            "5s\n" +
            "5m\n" +
            "5h\n" +
            "5d\n\n" +
            "Максимум — 15 дней."
        );

        return;
    }

    // -------- BACK --------

    if (data === "back") {

        await bot.answerCallbackQuery(
            query.id
        );

        await bot.sendMessage(
            chatId,
            "📋 Главное меню:",
            mainMenu()
        );

        return;
    }

    // -------- BUY --------

    if (data.startsWith("buy_")) {

        const tariffKey =
            data.substring(4);

        const tariff =
            TARIFFS[tariffKey];

        if (!tariff) return;

        userStates.set(
            query.from.id,
            {
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
            `👤 Введите ваше имя:`
        );

        return;
    }

    // -------- PAID --------

    if (data.startsWith("paid_")) {

        const orderId =
            data.substring(5);

        const order =
            getOrder(orderId);

        if (!order) return;

        await bot.answerCallbackQuery(
            query.id
        );

        await bot.sendMessage(
            chatId,
            `📷 Отправьте чек оплаты.\n\n` +
            `🧾 Заказ: \`${orderId}\`\n` +
            `👤 Имя: ${order.name}\n` +
            `📧 Email: ${order.email}\n` +
            `📦 Тариф: ${TARIFFS[order.tariff].name}`,
            {
                parse_mode: "Markdown"
            }
        );

        return;
    }

    // -------- CONFIRM --------

    if (data.startsWith("confirm_")) {

        if (!isAdmin(query.from.id)) return;

        const orderId =
            data.substring(8);

        const order =
            getOrder(orderId);

        if (!order || order.status !== "pending") {

            await bot.answerCallbackQuery(
                query.id,
                {
                    text: "Заказ уже обработан",
                    show_alert: true
                }
            );

            return;
        }

        const until =
            giveSubscription(
                order.user_id,
                TARIFFS[order.tariff].days
            );

        db.prepare(`
            UPDATE payments
            SET status = 'paid',
                paid_at = ?
            WHERE order_id = ?
        `).run(
            new Date().toISOString(),
            orderId
        );

        db.prepare(`
            UPDATE users
            SET total_paid = total_paid + ?
            WHERE user_id = ?
        `).run(
            order.amount,
            order.user_id
        );

        await bot.answerCallbackQuery(
            query.id,
            {
                text: "Оплата подтверждена ✅"
            }
        );

        await bot.sendMessage(
            order.user_id,
            `🎉 Оплата подтверждена!\n\n` +
            `👤 Имя: ${order.name}\n` +
            `📧 Email: ${order.email}\n\n` +
            `📅 Подписка до:\n` +
            `${until.toLocaleString("ru-RU")}\n\n` +
            `🔑 Ваш ключ:\n` +
            `\`${order.user_id}\``,
            {
                parse_mode: "Markdown"
            }
        );

        return;
    }

    // -------- REJECT --------

    if (data.startsWith("reject_")) {

        if (!isAdmin(query.from.id)) return;

        const orderId =
            data.substring(7);

        const order =
            rejectOrder(orderId);

        if (!order) {

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
                text: "Отклонено ❌"
            }
        );

        await bot.sendMessage(
            order.user_id,
            "❌ Ваша оплата не была подтверждена.\n\n" +
            "Свяжитесь с техподдержкой:\n" +
            SUPPORT
        );

        return;
    }

    await bot.answerCallbackQuery(
        query.id
    );
});

// ================= ЧЕК — ФОТО =================

bot.on("photo", async msg => {

    const order =
        getPendingOrder(msg.from.id);

    if (!order) {

        await bot.sendMessage(
            msg.chat.id,
            "❌ У вас нет ожидающего заказа."
        );

        return;
    }

    await bot.sendMessage(
        msg.chat.id,
        `✅ Чек получен!\n\n` +
        `🧾 Заказ: ${order.order_id}\n\n` +
        `Ожидайте проверки администратора.`
    );

    const username =
        msg.from.username
            ? `@${msg.from.username}`
            : "нет";

    const text =
        `📩 НОВАЯ ЗАЯВКА\n\n` +
        `🧾 Заказ: ${order.order_id}\n\n` +
        `👤 Имя: ${order.name}\n` +
        `📧 Email: ${order.email}\n` +
        `🆔 User ID: ${order.user_id}\n` +
        `👤 Username: ${username}\n\n` +
        `📦 Тариф: ${TARIFFS[order.tariff].name}\n` +
        `💰 Сумма: ${order.amount} ₽`;

    for (const adminId of ADMIN_IDS) {

        try {

            await bot.sendMessage(
                adminId,
                text
            );

            await bot.forwardMessage(
                adminId,
                msg.chat.id,
                msg.message_id
            );

            await bot.sendMessage(
                adminId,
                `Выберите действие:\n` +
                `Заказ ${order.order_id}`,
                orderButtons(order.order_id)
            );

        } catch (error) {

            console.error(
                `Ошибка отправки админу ${adminId}:`,
                error.message
            );
        }
    }
});

// ================= ЧЕК — ДОКУМЕНТ =================

bot.on("document", async msg => {

    const order =
        getPendingOrder(msg.from.id);

    if (!order) {

        await bot.sendMessage(
            msg.chat.id,
            "❌ У вас нет ожидающего заказа."
        );

        return;
    }

    await bot.sendMessage(
        msg.chat.id,
        `✅ Чек получен!\n\n` +
        `🧾 Заказ: ${order.order_id}\n\n` +
        `Ожидайте проверки администратора.`
    );

    const username =
        msg.from.username
            ? `@${msg.from.username}`
            : "нет";

    const text =
        `📩 НОВАЯ ЗАЯВКА\n\n` +
        `🧾 Заказ: ${order.order_id}\n\n` +
        `👤 Имя: ${order.name}\n` +
        `📧 Email: ${order.email}\n` +
        `🆔 User ID: ${order.user_id}\n` +
        `👤 Username: ${username}\n\n` +
        `📦 Тариф: ${TARIFFS[order.tariff].name}\n` +
        `💰 Сумма: ${order.amount} ₽`;

    for (const adminId of ADMIN_IDS) {

        try {

            await bot.sendMessage(
                adminId,
                text
            );

            await bot.forwardMessage(
                adminId,
                msg.chat.id,
                msg.message_id
            );

            await bot.sendMessage(
                adminId,
                `Выберите действие:\n` +
                `Заказ ${order.order_id}`,
                orderButtons(order.order_id)
            );

        } catch (error) {

            console.error(
                `Ошибка отправки админу ${adminId}:`,
                error.message
            );
        }
    }
});

// ================= ЗАПУСК =================

console.log("=================================");
console.log("🤖 J.A.R.V.I.S BOT ЗАПУЩЕН");
console.log("👑 ADMIN 1:", ADMIN_IDS[0]);
console.log("👑 ADMIN 2:", ADMIN_IDS[1]);
console.log("🛠 SUPPORT:", SUPPORT);
console.log("💾 DATABASE:", DB_FILE);
console.log("=================================");
