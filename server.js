const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const playwright = require('playwright');

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function createSupabaseAdmin() {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('Supabase service credentials are not configured.');
    }
    return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function parseRequestBody(body) {
    if (!body) return {};
    if (typeof body === 'string') {
        try {
            return JSON.parse(body);
        } catch (err) {
            console.error('Failed to parse request body:', err);
            return {};
        }
    }
    return body;
}
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Загружаем токен из переменных окружения

/**
 * Отправляет уведомление в Telegram с кнопкой-ссылкой на Web App.
 * @param {string} chatId - ID чата с пользователем (его telegram_user_id).
 * @param {string} text - Текст сообщения.
 * @param {string} webAppUrl - Ссылка на Web App для кнопки.
 */
async function sendTelegramNotification(chatId, text, webAppUrl) {
    if (!BOT_TOKEN) {
        console.error('Ошибка: TELEGRAM_BOT_TOKEN не установлен. Уведомление не отправлено.');
        return;
    }
    if (!chatId) {
        console.warn('Предупреждение: telegram_user_id для клиента не найден. Уведомление не отправлено.');
        return;
    }

    const apiUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = {
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML', // Разрешаем использовать HTML-теги для форматирования
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: '✍️ Открыть уведомления', // Текст на кнопке
                        web_app: { url: webAppUrl } // Ссылка, которую откроет кнопка
                    }
                ]
            ]
        }
    };

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        if (!result.ok) {
            console.error('Ошибка отправки сообщения в Telegram:', result.description);
        }
    } catch (error) {
        console.error('Сетевая ошибка при отправке сообщения в Telegram:', error);
    }
}

async function handleUpdateLocation({ userId, latitude, longitude }) {
    if (!userId || typeof latitude !== 'number' || typeof longitude !== 'number') {
        return { status: 400, body: { error: 'userId, latitude, and longitude are required.' } };
    }
    const supabaseAdmin = createSupabaseAdmin();
    const locationString = `POINT(${longitude} ${latitude})`;
    const { error } = await supabaseAdmin
        .from('clients')
        .update({ last_location: locationString })
        .eq('id', userId);

    if (error) {
        throw new Error('Failed to update location: ' + error.message);
    }

    return { status: 200, body: { message: 'Location updated successfully.' } };
}

async function handleVerifyToken({ token }) {
    if (!token) {
        return { status: 400, body: { error: 'token is required.' } };
    }
    const supabaseAdmin = createSupabaseAdmin();
    const { data: client, error } = await supabaseAdmin
        .from('clients')
        .select('id, name, auth_token')
        .eq('auth_token', token)
        .single();

    if (error || !client) {
        return { status: 401, body: { error: 'Invalid or expired token.' } };
    }

    return { status: 200, body: { userId: client.id, userName: client.name } };
}

async function handleGetPendingContracts({ userId }) {
    if (!userId) {
        return { status: 400, body: { error: 'userId is required.' } };
    }
    const supabaseAdmin = createSupabaseAdmin();
    const { data, error } = await supabaseAdmin
        .from('rentals')
        .select('id, status, bike_id, tariffs(title), bikes(*), extra_data')
        .eq('user_id', userId)
        .in('status', ['awaiting_contract_signing', 'awaiting_return_signature']);

    if (error) {
        throw new Error('Failed to fetch pending notifications: ' + error.message);
    }

    return { status: 200, body: { notifications: data || [] } };
}

async function handleGetContractDetails({ userId, rentalId }) {
    if (!userId || !rentalId) {
        return { status: 400, body: { error: 'userId and rentalId are required.' } };
    }
    const supabaseAdmin = createSupabaseAdmin();
    const { data, error } = await supabaseAdmin
        .from('rentals')
        .select(`
            id,
            extra_data,
            clients ( name, city, recognized_passport_data ),
            tariffs ( title ),
            bikes ( model_name, frame_number, battery_numbers, registration_number, iot_device_id, additional_equipment )
        `)
        .eq('id', rentalId)
        .eq('user_id', userId)
        .single();

    if (error) {
        throw new Error('Failed to fetch contract details: ' + error.message);
    }

    return { status: 200, body: { rental: data } };
}

async function handleGetActiveRental({ userId }) {
    if (!userId) {
        return { status: 400, body: { error: 'userId is required.' } };
    }
    const supabaseAdmin = createSupabaseAdmin();
    const { data, error } = await supabaseAdmin
        .from('rentals')
        .select('*, tariffs(*)')
        .eq('user_id', userId)
        .in('status', ['active', 'overdue', 'pending_return'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) {
        throw new Error('Failed to fetch active rental: ' + error.message);
    }

    return { status: 200, body: { rental: data } };
}

function generateContractHTML(rentalData) {
    const client = rentalData.clients;
    const bike = rentalData.bikes;
    const now = new Date();

    // --- ИСПРАВЛЕНИЕ: Добавляем парсинг JSON и используем правильные ключи ---
    let passport = {};
    if (client?.recognized_passport_data) {
        try {
            // Данные могут быть строкой или уже объектом, обработаем оба случая
            passport = typeof client.recognized_passport_data === 'string'
                ? JSON.parse(client.recognized_passport_data)
                : client.recognized_passport_data;
        } catch (e) {
            console.error("Server failed to parse passport data:", e);
        }
    }

    const batteryNumbers = Array.isArray(bike?.battery_numbers)
        ? bike.battery_numbers.join(', ')
        : (bike?.battery_numbers || 'N/A');

    return `
        <div style="text-align: center; font-weight: bold; font-size: 1.2em; margin-bottom: 20px;">
            Акт приема-передачи<br>
            (Приложение №1 к Договору проката)
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 0.9em;">
            <span>г. ${client?.city || 'Москва'}</span>
            <span>${now.toLocaleDateString('ru-RU')}</span>
        </div>
        <h4 style="margin-top: 20px; margin-bottom: 10px;">1. Оборудование</h4>
        <table border="1" style="width:100%; border-collapse: collapse; margin-bottom: 20px; text-align: left; font-size: 0.9em;">
            <tbody style="text-align: left;">
                <tr><th style="padding: 8px; width: 40%;">Наименование</th><td style="padding: 8px;">${bike?.model_name || 'N/A'}</td></tr>
                <tr><th style="padding: 8px;">Номер рамы</th><td style="padding: 8px;">${bike?.frame_number || 'N/A'}</td></tr>
                <tr><th style="padding: 8px;">Номера аккумуляторов</th><td style="padding: 8px;">${batteryNumbers}</td></tr>
                <tr><th style="padding: 8px;">Рег. номер</th><td style="padding: 8px;">${bike?.registration_number || 'N/A'}</td></tr>
                <tr><th style="padding: 8px;">Номер IOT</th><td style="padding: 8px;">${bike?.iot_device_id || 'N/A'}</td></tr>
                <tr><th style="padding: 8px;">Доп. оборудование</th><td style="padding: 8px;">${bike?.additional_equipment || 'N/A'}</td></tr>
            </tbody>
        </table>

        <h4 style="margin-top: 20px; margin-bottom: 10px;">2. Арендатор</h4>
        <table border="1" style="width:100%; border-collapse: collapse; margin-bottom: 20px; text-align: left; font-size: 0.9em;">
            <tbody style="text-align: left;">
                <tr><th style="padding: 8px; width: 40%;">ФИО</th><td style="padding: 8px;">${client?.name || 'N/A'}</td></tr>
                <tr><th style="padding: 8px;">Дата рождения</th><td style="padding: 8px;">${passport.birth_date || 'N/A'}</td></tr>
                <tr><th style="padding: 8px;">Паспорт</th><td style="padding: 8px;">${(passport.series || '') + ' ' + (passport.number || '')}</td></tr>
                <tr><th style="padding: 8px;">Кем выдан</th><td style="padding: 8px;">${passport.issuing_authority || 'N/A'}</td></tr>
                <tr><th style="padding: 8px;">Дата выдачи</th><td style="padding: 8px;">${passport.issue_date || 'N/A'}</td></tr>
                <tr><th style="padding: 8px;">Адрес регистрации</th><td style="padding: 8px;">${passport.registration_address || 'N/A'}</td></tr>
            </tbody>
        </table>

        <p style="font-size: 0.9em; margin-top: 20px;">Инструктаж пройден, с условиями согласен, техника и оборудование комплектны, на момент передачи исправны, нареканий нет.</p>
    `;
}

async function handleConfirmContract({ userId, rentalId, signatureData }) {
    if (!userId || !rentalId || !signatureData) {
        return { status: 400, body: { error: 'userId, rentalId, and signatureData are required.' } };
    }

    const supabaseAdmin = createSupabaseAdmin();
    let browser = null;

    try {
        const { data: rentalData, error: rentalError } = await supabaseAdmin
            .from('rentals')
            .select(`
                clients ( name, city, recognized_passport_data ),
                bikes ( model_name, frame_number, battery_numbers, registration_number, iot_device_id, additional_equipment )
            `)
            .eq('id', rentalId)
            .eq('user_id', userId)
            .single();

        if (rentalError) throw new Error('Failed to fetch rental data: ' + rentalError.message);

        const contractBodyHTML = generateContractHTML(rentalData);
        const fullHTML = `
            <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><style>
            body { font-family: 'DejaVu Sans', sans-serif; font-size: 11px; line-height: 1.4; color: #333; }
            table { width: 100%; border-collapse: collapse; margin: 15px 0; }
            th, td { border: 1px solid #ccc; padding: 6px; text-align: left; }
            th { background-color: #f2f2f2; font-weight: bold; width: 40%; }
            h2, h4 { text-align: center; }
            </style></head><body>
                ${contractBodyHTML}
                <div style="margin-top: 50px; page-break-inside: avoid; width: 400px;">
                    <div style="position: relative; height: 100px; text-align: left;">
                        <img src="${signatureData}" alt="Подпись" style="position: absolute; left: 0; bottom: 15px; width: 180px; height: auto; z-index: 10;"/>
                        <div style="position: absolute; left: 0; bottom: 10px; width: 100%; border-bottom: 1px solid #333;"></div>
                    </div>
                    <div style="text-align: right; font-size: 11px; color: #555;">
                        (Подпись Арендатора)
                    </div>
                </div>
            </body></html>
        `;

        browser = await playwright.chromium.launch();
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent(fullHTML, { waitUntil: 'load' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });

        const filePath = `signed/${userId}/rental_${rentalId}_signed.pdf`;
        const { error: uploadError } = await supabaseAdmin.storage
            .from('contracts')
            .upload(filePath, pdfBuffer, {
                contentType: 'application/pdf',
                upsert: true
            });

        if (uploadError) throw new Error('Failed to save PDF: ' + uploadError.message);

        const { data: { publicUrl } } = supabaseAdmin.storage.from('contracts').getPublicUrl(filePath);

        // Получаем текущие extra_data, чтобы не затереть их
        const { data: currentRental, error: fetchError } = await supabaseAdmin
            .from('rentals').select('extra_data').eq('id', rentalId).single();
        if (fetchError) throw new Error('Failed to get current rental data: ' + fetchError.message);

        const extraData = currentRental.extra_data || {};
        extraData.contract_document_url = publicUrl; // Добавляем новую ссылку

        const { error: updateError } = await supabaseAdmin
            .from('rentals')
            .update({
                status: 'active',
                extra_data: extraData // Сохраняем обновленный объект
            })
            .eq('id', rentalId)
            .eq('user_id', userId);

        if (updateError) throw new Error('Failed to activate rental: ' + updateError.message);

        return { status: 200, body: { message: 'Contract signed and rental activated' } };

    } catch (error) {
        console.error('Contract confirmation error:', error);
        return { status: 500, body: { error: 'Не удалось сгенерировать договор: ' + error.message } };
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function handleGetPaymentMethod({ userId }) {
    if (!userId) {
        return { status: 400, body: { error: 'userId is required.' } };
    }
    const supabaseAdmin = createSupabaseAdmin();
    const { data: client, error: clientError } = await supabaseAdmin
        .from('clients')
        .select('extra')
        .eq('id', userId)
        .single();

    if (clientError) throw new Error('Failed to get client data: ' + clientError.message);
    
    const paymentMethodDetails = client?.extra?.payment_method_details;

    if (!paymentMethodDetails) {
        return { status: 404, body: { error: 'No saved payment method found for this user.' } };
    }

    return { status: 200, body: { payment_method: paymentMethodDetails } };
}

function generateReturnActHTML(rentalData, defects = [], clientSignatureData = null, amount = 0) {
    const client = rentalData.clients;
    const bike = rentalData.bikes;
    const now = new Date();

    // Пытаемся распарсить паспортные данные из JSON-строки
    let passport = {};
    if (client?.recognized_passport_data) {
        try {
            // Если это уже объект, используем его. Если строка - парсим.
            passport = typeof client.recognized_passport_data === 'string'
                ? JSON.parse(client.recognized_passport_data)
                : client.recognized_passport_data;
        } catch (e) {
            console.error("Failed to parse passport data for return act:", e);
        }
    }

    const batteryNumbers = Array.isArray(bike?.battery_numbers)
        ? bike.battery_numbers.join(', ')
        : (bike?.battery_numbers || 'N/A');

    const defectsHTML = defects && defects.length > 0
        ? `
        <h4 style="margin-top: 20px; margin-bottom: 10px;">3. Выявленные неисправности</h4>
        <ul style="padding-left: 20px; margin-bottom: 20px; font-size: 0.9em;">
            ${defects.map(d => `<li>${d}</li>`).join('')}
        </ul>
        `
        : '<p style="font-size: 0.9em; margin-top: 20px;">Неисправности на момент сдачи не выявлены.</p>';

    const amountHTML = amount > 0
        ? `
        <h4 style="margin-top: 20px; margin-bottom: 10px;">4. Возмещение ущерба</h4>
        <p style="font-size: 0.9em;">Итоговая сумма к оплате за ущерб: <strong>${amount.toFixed(2)} ₽</strong></p>
        `
        : '';

    const clientSignatureHTML = clientSignatureData
        ? `<img src="${clientSignatureData}" alt="Подпись" style="position: absolute; left: 0; bottom: 15px; width: 180px; height: auto; z-index: 10;"/>`
        : '';

    const bodyHTML = `
        <div style="text-align: center; font-weight: bold; font-size: 1.2em; margin-bottom: 20px;">
            Акт приема-передачи (возврата)<br>
            (Приложение №2 к Договору проката)
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 0.9em;">
            <span>г. ${client?.city || 'Москва'}</span>
            <span>${now.toLocaleDateString('ru-RU')}</span>
        </div>
        <h4 style="margin-top: 20px; margin-bottom: 10px;">1. Оборудование</h4>
        <table>
            <tbody>
                <tr><th>Наименование</th><td>${bike?.model_name || 'N/A'}</td></tr>
                <tr><th>Номер рамы</th><td>${bike?.frame_number || 'N/A'}</td></tr>
                <tr><th>Номера аккумуляторов</th><td>${batteryNumbers}</td></tr>
                <tr><th>Рег. номер</th><td>${bike?.registration_number || 'N/A'}</td></tr>
                <tr><th>Номер IOT</th><td>${bike?.iot_device_id || 'N/A'}</td></tr>
                <tr><th>Доп. оборудование</th><td>${bike?.additional_equipment || 'N/A'}</td></tr>
            </tbody>
        </table>

        <!-- +++ ДОБАВЛЕНА ТАБЛИЦА С ДАННЫМИ АРЕНДАТОРА +++ -->
        <h4 style="margin-top: 20px; margin-bottom: 10px;">2. Арендатор</h4>
        <table>
            <tbody>
                <tr><th>ФИО</th><td>${client?.name || 'N/A'}</td></tr>
                <tr><th>Дата рождения</th><td>${passport.birth_date || 'N/A'}</td></tr>
                <tr><th>Паспорт</th><td>${(passport.series || '') + ' ' + (passport.number || '')}</td></tr>
                <tr><th>Кем выдан</th><td>${passport.issuing_authority || 'N/A'}</td></tr>
                <tr><th>Дата выдачи</th><td>${passport.issue_date || 'N/A'}</td></tr>
                <tr><th>Адрес регистрации</th><td>${passport.registration_address || 'N/A'}</td></tr>
            </tbody>
        </table>

        ${defectsHTML}
        ${amountHTML}

        <p style="font-size: 0.9em; margin-top: 20px;">Арендатор технику и оборудование передал. Арендодатель технику и оборудование получил. Претензий стороны друг к другу не имеют.</p>

        <!-- +++ ИСПРАВЛЕН БЛОК ПОДПИСИ +++ -->
        <div style="margin-top: 50px; page-break-inside: avoid; width: 400px;">
            <div style="position: relative; height: 100px; text-align: left;">
                ${clientSignatureHTML}
                <div style="position: absolute; left: 0; bottom: 10px; width: 100%; border-bottom: 1px solid #333;"></div>
            </div>
            <div style="text-align: right; font-size: 11px; color: #555;">
                (Подпись Арендатора)
            </div>
        </div>
    `;

    return `
        <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><style>
        body { font-family: 'DejaVu Sans', sans-serif; font-size: 11px; line-height: 1.4; color: #333; }
        table { width:100%; border-collapse: collapse; margin-bottom: 20px; text-align: left; font-size: 0.9em; }
        th, td { border: 1px solid #ccc; padding: 8px; }
        th { background-color: #f2f2f2; font-weight: bold; width: 40%; }
        h2, h4 { text-align: center; }
        </style></head><body>${bodyHTML}</body></html>
    `;
}

async function handleGenerateReturnAct({ userId, rentalId }) {
    if (!userId || !rentalId) {
        return { status: 400, body: { error: 'userId and rentalId are required.' } };
    }

    const supabaseAdmin = createSupabaseAdmin();
    let browser = null;

    try {
        const { data: rentalData, error: rentalError } = await supabaseAdmin
            .from('rentals')
            // ИЗМЕНЕНИЕ: Добавляем recognized_passport_data в запрос
            .select('extra_data, clients ( name, city, recognized_passport_data ), bikes ( * )')
            .eq('id', rentalId)
            .eq('user_id', userId)
            .single();

        if (rentalError) throw new Error('Failed to fetch rental data for Act: ' + rentalError.message);

        const defects = rentalData.extra_data?.defects || [];
        const amount = rentalData.extra_data?.damage_amount || 0;

        const fullHTML = generateReturnActHTML(rentalData, defects, null, amount);

        browser = await playwright.chromium.launch();
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent(fullHTML, { waitUntil: 'load' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });

        const filePath = `returns/${userId}/return_act_${rentalId}.pdf`;
        const { error: uploadError } = await supabaseAdmin.storage
            .from('contracts')
            .upload(filePath, pdfBuffer, {
                contentType: 'application/pdf',
                upsert: true
            });

        if (uploadError) throw new Error('Failed to save Return Act PDF: ' + uploadError.message);

        const { data: { publicUrl } } = supabaseAdmin.storage.from('contracts').getPublicUrl(filePath);

        return { status: 200, body: { message: 'Return Act generated successfully', publicUrl } };

    } catch (error) {
        console.error('Return Act generation error:', error);
        return { status: 500, body: { error: 'Не удалось сгенерировать акт сдачи: ' + error.message } };
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function handleConfirmReturnAct({ userId, rentalId, signatureData }) {
    if (!userId || !rentalId || !signatureData) {
        return { status: 400, body: { error: 'userId, rentalId, and signatureData are required.' } };
    }

    const supabaseAdmin = createSupabaseAdmin();
    let browser = null;

    try {
        const { data: rentalData, error: rentalError } = await supabaseAdmin
            .from('rentals')
            // ИЗМЕНЕНИЕ 1: Добавляем bike_id и recognized_passport_data в запрос
            .select('bike_id, extra_data, clients ( name, city, recognized_passport_data ), bikes ( * )')
            .eq('id', rentalId)
            .eq('user_id', userId)
            .single();

        if (rentalError) throw new Error('Failed to fetch rental data for Return Act signing: ' + rentalError.message);

        const defects = rentalData.extra_data?.defects || [];
        const amount = rentalData.extra_data?.damage_amount || 0;

        const fullHTML = generateReturnActHTML(rentalData, defects, signatureData, amount);

        browser = await playwright.chromium.launch();
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent(fullHTML, { waitUntil: 'load' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });

        const filePath = `returns/${userId}/return_act_${rentalId}_signed.pdf`;
        const { error: uploadError } = await supabaseAdmin.storage
            .from('contracts')
            .upload(filePath, pdfBuffer, {
                contentType: 'application/pdf',
                upsert: true
            });

        if (uploadError) throw new Error('Failed to save signed Return Act PDF: ' + uploadError.message);

        const { data: { publicUrl } } = supabaseAdmin.storage.from('contracts').getPublicUrl(filePath);

        // Получаем текущие extra_data
        const { data: currentRental, error: fetchError } = await supabaseAdmin
            .from('rentals').select('extra_data').eq('id', rentalId).single();
        if (fetchError) throw new Error('Failed to get current rental data: ' + fetchError.message);

        const extraData = currentRental.extra_data || {};
        extraData.return_act_url = publicUrl; // Добавляем ссылку на акт сдачи

        const { error: updateError } = await supabaseAdmin
            .from('rentals')
            .update({
                status: 'completed',
                extra_data: extraData // Сохраняем
            })
            .eq('id', rentalId);

        if (updateError) throw new Error('Failed to finalize rental after signing return act: ' + updateError.message);

        return { status: 200, body: { message: 'Return act signed successfully.' } };

    } catch (error) {
        console.error('Return Act confirmation error:', error);
        return { status: 500, body: { error: 'Не удалось подписать акт сдачи: ' + error.message } };
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function handleFinalizeReturn({ rental_id, new_bike_status, service_reason, return_act_url, defects }) {
    if (!rental_id || !new_bike_status) {
        return { status: 400, body: { error: 'rental_id и new_bike_status обязательны.' } };
    }
    if (new_bike_status === 'in_service' && !service_reason) {
        return { status: 400, body: { error: 'Причина ремонта обязательна, если велосипед отправляется в сервис.' } };
    }

    const supabaseAdmin = createSupabaseAdmin();

    // 1. Получаем ID велосипеда и ID клиента в Telegram из аренды
    const { data: rentalData, error: rentalError } = await supabaseAdmin
        .from('rentals')
        .select('bike_id, extra_data, clients ( telegram_user_id )') // <-- ИЗМЕНЕНИЕ: Запрашиваем telegram_user_id
        .eq('id', rental_id)
        .single();

    if (rentalError || !rentalData) {
        throw new Error('Аренда не найдена: ' + (rentalError?.message || ''));
    }
    const bike_id = rentalData.bike_id;
    const telegramUserId = rentalData.clients?.telegram_user_id; // <-- НОВОЕ: Получаем ID

    // 2. Обновляем статус аренды и добавляем данные в extra_data
    const extraData = rentalData.extra_data || {};
    extraData.return_act_url = return_act_url;
    extraData.defects = defects || [];

    const { error: updateRentalError } = await supabaseAdmin
        .from('rentals')
        .update({ status: 'awaiting_return_signature', extra_data: extraData })
        .eq('id', rental_id);

    if (updateRentalError) {
        throw new Error('Ошибка обновления статуса аренды: ' + updateRentalError.message);
    }

    // 3. Готовим данные для обновления велосипеда
    const bikeUpdatePayload = {
        status: new_bike_status,
        // Если велосипед исправен, очищаем причину ремонта. Если в ремонт - записываем причину.
        service_reason: new_bike_status === 'in_service' ? service_reason : null
    };

    // 4. Обновляем велосипед
    const { error: updateBikeError } = await supabaseAdmin
        .from('bikes')
        .update(bikeUpdatePayload)
        .eq('id', bike_id);

    if (updateBikeError) {
        // Не "ломаем" весь процесс, но сообщаем об ошибке
        console.error('Не удалось обновить статус велосипеда: ', updateBikeError.message);
        // Можно вернуть частичный успех, если это приемлемо
    }

    // --- НОВЫЙ БЛОК: ОТПРАВКА УВЕДОМЛЕНИЯ В TELEGRAM ---
    const messageText = 'Пожалуйста, подпишите акт сдачи электровелосипеда в личном кабинете, чтобы завершить аренду.';

    // ВАЖНО: Замените YOUR_BOT_USERNAME и YOUR_WEBAPP_SHORT_NAME на свои значения
    // Имя пользователя бота - это то, что вы задали в BotFather (например, MySuperBikeBot)
    // Короткое имя Web App - это то, что вы задали для кнопки Menu (например, app)
    const webAppUrl = 'https://t.me/YOUR_BOT_USERNAME/YOUR_WEBAPP_SHORT_NAME?startapp=notifications';

    await sendTelegramNotification(telegramUserId, messageText, webAppUrl);
    // --- КОНЕЦ НОВОГО БЛОКА ---

    return { status: 200, body: { message: 'Приемка оформлена, акт ожидает подписи клиента.' } };
}

// +++ ВСТАВИТЬ ЭТОТ БЛОК КОДА В server.js +++

async function handleUnbindPaymentMethod({ userId }) {
    if (!userId) {
        return { status: 400, body: { error: 'userId is required.' } };
    }

    const supabaseAdmin = createSupabaseAdmin();

    // 1. Получаем текущие extra данные, чтобы не удалить ничего лишнего
    const { data: client, error: fetchError } = await supabaseAdmin
        .from('clients')
        .select('extra')
        .eq('id', userId)
        .single();

    if (fetchError) {
        throw new Error('Не удалось найти клиента: ' + fetchError.message);
    }

    const extra = client.extra || {};
    // 2. Удаляем ключ с деталями платежного метода из объекта
    delete extra.payment_method_details;

    // 3. Обновляем запись в базе: очищаем ID метода и обновляем extra
    const { error: updateError } = await supabaseAdmin
        .from('clients')
        .update({
            yookassa_payment_method_id: null,
            extra: extra // Сохраняем объект extra без данных о карте
        })
        .eq('id', userId);

    if (updateError) {
        throw new Error('Ошибка при отвязке карты: ' + updateError.message);
    }

    return { status: 200, body: { message: 'Способ оплаты успешно отвязан.' } };
}
// НОВЫЙ ОБРАБОТЧИК ДЛЯ АДМИН-ПАНЕЛИ
// +++ ВСТАВИТЬ ЭТОТ БЛОК КОДА В server.js +++

/**
 * Устанавливает статус верификации для клиента и отправляет уведомление.
 */
async function handleSetVerificationStatus({ userId, status }) {
    if (!userId || !status) {
        return { status: 400, body: { error: 'userId и status обязательны.' } };
    }
    if (!['approved', 'rejected'].includes(status)) {
        return { status: 400, body: { error: 'Недопустимый статус.' } };
    }

    const supabaseAdmin = createSupabaseAdmin();

    // 1. Обновляем статус клиента в базе
    const { error: updateError } = await supabaseAdmin
        .from('clients')
        .update({ verification_status: status })
        .eq('id', userId);

    if (updateError) {
        throw new Error('Не удалось обновить статус клиента: ' + updateError.message);
    }

    // 2. Получаем telegram_user_id для отправки сообщения
    const { data: client, error: fetchError } = await supabaseAdmin
        .from('clients')
        .select('telegram_user_id, extra')
        .eq('id', userId)
        .single();

    if (fetchError || !client) {
        console.warn(`Не удалось найти клиента ${userId} для отправки уведомления.`);
        return { status: 200, body: { message: 'Статус обновлен, но уведомление не отправлено (клиент не найден).' } };
    }

    // 3. Формируем текст сообщения и ссылку для Web App
    let messageText = '';
    const botUsername = 'bikepark54bot'; // <-- УКАЖИТЕ ИМЯ ВАШЕГО БОТА
    const webAppName = 'app'; // <-- УКАЖИТЕ КОРОТКОЕ ИМЯ ВАШЕГО WEB APP
    const webAppUrl = `https://t.me/${botUsername}/${webAppName}`;

    if (status === 'approved') {
        messageText = '✅ Поздравляем! Ваш аккаунт был подтвержден. Теперь вы можете полноценно пользоваться приложением.';
    } else { // status === 'rejected'
        messageText = '❌ К сожалению, в верификации было отказано. Для уточнения деталей свяжитесь с поддержкой.';
    }

    // 4. Отправляем уведомление
    // (Убедитесь, что функция sendTelegramNotification уже есть в вашем файле)
    await sendTelegramNotification(client.telegram_user_id, messageText, webAppUrl);

    return { status: 200, body: { message: 'Статус успешно обновлен, уведомление отправлено.' } };
}
app.post('/api/admin', async (req, res) => {
    try {
        const body = req.body;
        const { action } = body;
        let result;

        switch (action) {
            case 'finalize-return':
                result = await handleFinalizeReturn(body);
                break;
            case 'set-verification-status':
                result = await handleSetVerificationStatus(body);
                break;
            // Здесь могут быть другие admin-действия в будущем
            default:
                result = { status: 400, body: { error: 'Invalid admin action' } };
                break;
        }
        res.status(result.status).json(result.body);
    } catch (error) {
        console.error('Admin handler error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/user', async (req, res) => {
    try {
        const body = req.body;
        const { action } = body;

        let result;
        switch (action) {
            case 'update-location':
                result = await handleUpdateLocation(body);
                break;
            case 'verify-token':
                result = await handleVerifyToken(body);
                break;
            case 'get-pending-contracts':
                result = await handleGetPendingContracts(body);
                break;
            case 'get-contract-details':
                result = await handleGetContractDetails(body);
                break;
            case 'confirm-contract':
                result = await handleConfirmContract(body);
                break;
            case 'get-active-rental':
                result = await handleGetActiveRental(body);
                break;
            case 'get-payment-method':
                result = await handleGetPaymentMethod(body);
                break;
            case 'generate-return-act':
                result = await handleGenerateReturnAct(body);
                break;
            case 'confirm-return-act':
                result = await handleConfirmReturnAct(body);
                break;
            case 'unbind-payment-method':
                result = await handleUnbindPaymentMethod(body);
                break;
            default:
                result = { status: 400, body: { error: 'Invalid action' } };
        }

        res.status(result.status).json(result.body);
    } catch (error) {
        console.error('User handler error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
