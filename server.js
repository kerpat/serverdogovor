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
        .select('id, status, bike_id, tariffs(title), bikes(*)')
        .eq('user_id', userId)
        .eq('status', 'awaiting_contract_signing');

    if (error) {
        throw new Error('Failed to fetch pending contracts: ' + error.message);
    }

    return { status: 200, body: { rentals: data } };
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
    const passport = client?.recognized_passport_data || {};

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
                <tr><th style="padding: 8px;">Дата рождения</th><td style="padding: 8px;">${passport['Дата рождения'] || 'N/A'}</td></tr>
                <tr><th style="padding: 8px;">Паспорт</th><td style="padding: 8px;">${passport['Серия и номер паспорта'] || 'N/A'}</td></tr>
                <tr><th style="padding: 8px;">Кем выдан</th><td style="padding: 8px;">${passport['Кем выдан'] || 'N/A'}</td></tr>
                <tr><th style="padding: 8px;">Дата выдачи</th><td style="padding: 8px;">${passport['Дата выдачи'] || 'N/A'}</td></tr>
                <tr><th style="padding: 8px;">Адрес регистрации</th><td style="padding: 8px;">${passport['Адрес регистрации'] || 'N/A'}</td></tr>
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

        const { error: updateError } = await supabaseAdmin
            .from('rentals')
            .update({
                status: 'active',
                extra_data: { contract_document_url: publicUrl }
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

function generateReturnActHTML(rentalData, defects = []) {
    const client = rentalData.clients;
    const bike = rentalData.bikes;
    const now = new Date();

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

    return `
        <!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><style>
        body { font-family: 'DejaVu Sans', sans-serif; font-size: 11px; line-height: 1.4; color: #333; }
        table { width:100%; border-collapse: collapse; margin-bottom: 20px; text-align: left; font-size: 0.9em; }
        th, td { border: 1px solid #ccc; padding: 8px; }
        th { background-color: #f2f2f2; font-weight: bold; width: 40%; }
        h2, h4 { text-align: center; }
        </style></head><body>
            <div style="text-align: center; font-weight: bold; font-size: 1.2em; margin-bottom: 20px;">
                Акт приема-передачи<br>
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
            
            ${defectsHTML}

            <h4 style="margin-top: 40px; margin-bottom: 10px;">2. Подписи сторон</h4>
            <table style="width:100%; border: none; margin-top: 30px; font-size: 0.9em;">
                <tr style="vertical-align: bottom;">
                    <td style="width: 50%; padding-right: 20px; border: none;">
                        <p>Арендатор технику и оборудование передал.</p>
                        <div style="margin-top: 60px; border-bottom: 1px solid #333;"></div>
                        <p style="font-size: 0.8em;">(ФИО: ${client?.name || '________________'})</p>
                    </td>
                    <td style="width: 50%; padding-left: 20px; border: none;">
                        <p>Арендодатель технику и оборудование получил.</p>
                        <div style="margin-top: 60px; border-bottom: 1px solid #333;"></div>
                        <p style="font-size: 0.8em;">(ФИО: ________________)</p>
                    </td>
                </tr>
            </table>
        </body></html>
    `;
}

async function handleGenerateReturnAct({ userId, rentalId, defects }) {
    if (!userId || !rentalId) {
        return { status: 400, body: { error: 'userId and rentalId are required.' } };
    }

    const supabaseAdmin = createSupabaseAdmin();
    let browser = null;

    try {
        const { data: rentalData, error: rentalError } = await supabaseAdmin
            .from('rentals')
            .select('clients ( name, city ), bikes ( * )')
            .eq('id', rentalId)
            .eq('user_id', userId)
            .single();

        if (rentalError) throw new Error('Failed to fetch rental data for Act: ' + rentalError.message);

        const fullHTML = generateReturnActHTML(rentalData, defects);

        browser = await playwright.chromium.launch();
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent(fullHTML, { waitUntil: 'load' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });

        const filePath = `returns/${userId}/return_act_${rentalId}.pdf`;
        const { error: uploadError } = await supabaseAdmin.storage
            .from('contracts') // Using the same bucket for now
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