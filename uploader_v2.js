require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Konfigurasi
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const botToken = process.env.BOT_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const sessionString = new StringSession(process.env.SESSION_STRING || '');

// ID Channel Database (Gudang File)
const DUMP_CHAT_ID = BigInt('-1003638979264'); 

const supabase = createClient(supabaseUrl, supabaseKey);
const client = new TelegramClient(sessionString, apiId, apiHash, { connectionRetries: 5 });

const JSON_DIR = path.join(__dirname, 'anime_json');
const TEMP_DIR = path.join(__dirname, 'temp_downloads');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

async function downloadFile(url, filepath) {
    const writer = fs.createWriteStream(filepath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function processAnime(filePath) {
    const rawData = fs.readFileSync(filePath);
    const anime = JSON.parse(rawData);
    
    console.log(`\n📂 Memproses Anime: ${anime.title}`);

    // 1. Cek/Buat Anime di Database
    let { data: dbAnime } = await supabase.from('mikunime').select('*').eq('title', anime.slug).single();
    
    if (!dbAnime) {
        console.log(`   ✨ Anime baru! Menyimpan ke DB...`);
        const { data: newAnime } = await supabase
            .from('mikunime')
            .insert({ title: anime.slug, episodes: [], poster: anime.poster, synopsis: anime.synopsis })
            .select()
            .single();
        dbAnime = newAnime;
    }

    let dbEpisodes = dbAnime.episodes || [];

    // 2. Loop Episode
    for (const ep of anime.episodes) {
        // Cek apakah episode ini sudah lengkap di DB?
        const existingEpIndex = dbEpisodes.findIndex(e => e.episode === ep.episode);
        let existingEp = existingEpIndex > -1 ? dbEpisodes[existingEpIndex] : null;

        // Loop Resolusi (480p, 720p)
        for (const [res, url] of Object.entries(ep.streams)) {
            if (existingEp && existingEp.links && existingEp.links[res]) {
                console.log(`   ⏭️ Episode ${ep.episode} [${res}] sudah ada. Skip.`);
                continue;
            }

            console.log(`   ⬇️ Downloading Eps ${ep.episode} [${res}]...`);
            const tempFile = path.join(TEMP_DIR, `${anime.slug}-ep${ep.episode}-${res}.mp4`);

            try {
                await downloadFile(url, tempFile);
                console.log(`   ⬆️ Uploading ke Telegram...`);

                const uploadedMsg = await client.sendFile(DUMP_CHAT_ID, {
                    file: tempFile,
                    caption: `**${anime.title}**\nEpisode ${ep.episode} [${res}]\n\n#${anime.slug}`,
                    forceDocument: true,
                    workers: 4 // Parallel upload chunks
                });

                const channelIdStr = DUMP_CHAT_ID.toString().replace('-100', '');
                const fileLink = `https://t.me/c/${channelIdStr}/${uploadedMsg.id}`;

                // Update Local Array
                if (!existingEp) {
                    existingEp = { episode: ep.episode, links: {} };
                    dbEpisodes.push(existingEp);
                    // Re-sort biar rapi
                    dbEpisodes.sort((a, b) => a.episode - b.episode);
                    // Update index reference
                    const newIndex = dbEpisodes.findIndex(e => e.episode === ep.episode);
                    existingEp = dbEpisodes[newIndex];
                }
                
                if (!existingEp.links) existingEp.links = {};
                existingEp.links[res] = fileLink;

                // Simpan ke Supabase per satu file sukses (Safety save)
                await supabase.from('mikunime').update({ episodes: dbEpisodes }).eq('id', dbAnime.id);
                
                console.log(`   ✅ Selesai: ${fileLink}`);

                // Hapus File
                fs.unlinkSync(tempFile);

                // Jeda Anti-Flood (PENTING!)
                console.log(`   ⏳ Cooldown 20 detik...`);
                await new Promise(r => setTimeout(r, 20000));

            } catch (err) {
                console.error(`   ❌ GagalEps ${ep.episode} [${res}]: ${err.message}`);
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            }
        }
    }
}

async function start() {
    console.log('🔄 Login Telegram...');
    await client.start({ botAuthToken: botToken });
    console.log('✅ Bot Siap! Memulai Mass Upload...');

    const files = fs.readdirSync(JSON_DIR).filter(f => f.endsWith('.json'));
    console.log(`📦 Ditemukan ${files.length} file JSON.`);

    for (const file of files) {
        await processAnime(path.join(JSON_DIR, file));
    }

    console.log('🎉 SEMUA TUGAS SELESAI!');
}

start();
