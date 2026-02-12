const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ==========================================
// 💀 DAERAH HARDCODE (DILARANG UBAH KECUALI PAHAM)
// ==========================================

const API_ID = 38988077;
const API_HASH = '64eddd3cb9a135a49decd3e89674ab87';
const BOT_TOKEN = '8118729786:AAFEf6QFVAZQowlpTqB51J3-WeA7EQteeV4';

// Database Supabase
const SUPABASE_URL = 'https://ajeukqjcqweuofclpdjo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFqZXVrcWpjcXdldW9mY2xwZGpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA5MTA5NjMsImV4cCI6MjA4NjQ4Njk2M30.DfSpKC2u3u3MKynG9gkZsG_a4M5_AtQbs9QI1OYpwZQ';

// ID Channel Gudang (Format BigInt dengan -100 di depan)
// Dari link Tuan: -3638979264 -> -1003638979264
const DUMP_CHAT_ID = BigInt('-1003638979264'); 

// ==========================================

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, { 
    connectionRetries: 5,
    useWSS: false 
});

const JSON_DIR = path.join(__dirname, 'anime_json');
const TEMP_DIR = path.join(__dirname, 'temp_downloads');

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

async function downloadFile(url, filepath) {
    const writer = fs.createWriteStream(filepath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' // Biar gak diblokir
        }
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
    
    console.log(`\n📂 Anime: ${anime.title}`);

    // Cek/Buat Anime di DB
    let { data: dbAnime } = await supabase.from('mikunime').select('*').eq('title', anime.slug).single();
    
    if (!dbAnime) {
        // console.log(`   ✨ Anime baru di DB...`);
        const { data: newAnime } = await supabase
            .from('mikunime')
            .insert({
                title: anime.slug, 
                poster: anime.poster, 
                synopsis: anime.synopsis,
                episodes: [] 
            })
            .select()
            .single();
        dbAnime = newAnime;
    }

    let dbEpisodes = dbAnime.episodes || [];

    // Loop Episodes
    for (const ep of anime.episodes) {
        const existingEpIndex = dbEpisodes.findIndex(e => e.episode === ep.episode);
        let existingEp = existingEpIndex > -1 ? dbEpisodes[existingEpIndex] : null;

        // Loop Resolusi
        for (const [res, url] of Object.entries(ep.streams)) {
            // Skip jika link archive.org (biasanya lambat/mati)
            if (url.includes('archive.org')) continue;

            if (existingEp && existingEp.links && existingEp.links[res]) {
                // console.log(`   ⏭️Eps ${ep.episode} [${res}] Skip.`);
                continue;
            }

            console.log(`   ⬇️ DL Eps ${ep.episode} [${res}]...`);
            const tempFile = path.join(TEMP_DIR, `${anime.slug}-ep${ep.episode}-${res}.mp4`);

            try {
                await downloadFile(url, tempFile);
                
                // Cek ukuran file (0 byte = gagal)
                const stats = fs.statSync(tempFile);
                if (stats.size < 1000) {
                    throw new Error("File corrupt/kecil (mungkin link mati)");
                }

                console.log(`   ⬆️ Uploading...`);
                const uniqueId = `${anime.slug}-ep${ep.episode}-${res}`;
                const uploadedMsg = await client.sendFile(DUMP_CHAT_ID, {
                    file: tempFile,
                    caption: `🎬 **${anime.title}**\n💿 Episode: ${ep.episode} [${res}]\n🆔 ID: \`${uniqueId}\`\n\n#${anime.slug}`,
                    forceDocument: false, // JANGAN kirim sebagai dokumen
                    supportsStreaming: true, // AKTIFKAN Streaming
                    attributes: [
                        new Api.DocumentAttributeVideo({
                            duration: 0,
                            w: res === '720p' ? 1280 : 854,
                            h: res === '720p' ? 720 : 480,
                            supportsStreaming: true
                        })
                    ],
                    workers: 4
                });

                // Generate Link Public Channel
                // Rumus: https://t.me/c/ID_TANPA_-100/MSG_ID
                const cleanId = DUMP_CHAT_ID.toString().replace('-100', '');
                const fileLink = `https://t.me/c/${cleanId}/${uploadedMsg.id}`;

                // Update Array Local
                if (!existingEp) {
                    existingEp = { episode: ep.episode, links: {} };
                    dbEpisodes.push(existingEp);
                    // Re-sort
                    dbEpisodes.sort((a, b) => a.episode - b.episode);
                    // Refresh index
                    const newIndex = dbEpisodes.findIndex(e => e.episode === ep.episode);
                    existingEp = dbEpisodes[newIndex];
                }
                
                if (!existingEp.links) existingEp.links = {};
                existingEp.links[res] = fileLink;

                // Save ke Supabase
                await supabase.from('mikunime').update({ episodes: dbEpisodes }).eq('id', dbAnime.id);
                
                console.log(`   ✅ Done: ${fileLink}`);

                fs.unlinkSync(tempFile);

                // Anti-Flood Delay
                await new Promise(r => setTimeout(r, 5000)); 

            } catch (err) {
                console.error(`   ❌ Gagal: ${err.message}`);
                if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            }
        }
    }
}

async function start() {
    console.log('🔄 Menghubungkan Bot...');
    
    // Login Pake Bot Token
    await client.start({
        botAuthToken: BOT_TOKEN,
    });

    console.log('✅ Bot Login Sukses!');
    
    // Cek apakah Bot bisa akses Channel Gudang
    try {
        await client.getEntity(DUMP_CHAT_ID);
        console.log(`✅ Akses ke Channel Gudang (${DUMP_CHAT_ID}) OK!`);
    } catch (e) {
        console.log(`❌ ERROR: Bot tidak bisa akses Channel ${DUMP_CHAT_ID}`);
        console.log(`⚠️ Pastikan Bot @${(await client.getMe()).username} sudah jadi ADMIN di channel tersebut!`);
        process.exit(1);
    }

    const files = fs.readdirSync(JSON_DIR).filter(f => f.endsWith('.json'));
    console.log(`📦 Queue: ${files.length} Anime.`);

    for (const file of files) {
        await processAnime(path.join(JSON_DIR, file));
    }

    console.log('🎉 SELESAI!');
}

start();