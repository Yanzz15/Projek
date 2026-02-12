require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const input = require('input'); // Library input manual

const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const sessionString = new StringSession(''); // Kosong buat login baru

async function login() {
    console.log("=== LOGIN MANUAL TELEGRAM ===");
    
    const client = new TelegramClient(sessionString, apiId, apiHash, {
        connectionRetries: 5,
    });

    await client.start({
        phoneNumber: async () => await input.text('Masukkan Nomor HP (+62...): '),
        password: async () => await input.text('Masukkan Password 2FA (jika ada): '),
        phoneCode: async () => await input.text('Masukkan Kode OTP dari Telegram: '),
        onError: (err) => console.log(err),
    });

    console.log("\n✅ LOGIN BERHASIL!");
    console.log("\n👇 COPY SESSION STRING DI BAWAH INI DAN MASUKKAN KE FILE .env 👇\n");
    console.log(client.session.save()); // INI STRING RAHASIA
    console.log("\n👆 👆 👆\n");
    
    process.exit(0);
}

login();
