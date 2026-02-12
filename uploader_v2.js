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

// ==========================================
// 🚀 KONFIGURASI NGEBUT
// ==========================================
const MAX_PARALLEL_ANIME = 2;   // Proses 2 Judul Anime sekaligus
const MAX_PARALLEL_EPS = 2;     // Per Anime, proses 2 Episode sekaligus
// Total beban = 2 x 2 = 4 Upload bersamaan. (Aman buat 8 Core)

async function processEpisode(anime, ep, res, url, dbAnime, dbEpisodes) {
    if (url.includes('archive.org')) return; // Skip lambat

    const existingEpIndex = dbEpisodes.findIndex(e => e.episode === ep.episode);
    let existingEp = existingEpIndex > -1 ? dbEpisodes[existingEpIndex] : null;

    if (existingEp && existingEp.links && existingEp.links[res]) {
        return;
    }

    const tempFile = path.join(TEMP_DIR, `${anime.slug}-ep${ep.episode}-${res}-${Date.now()}.mp4`);
    console.log(`   ⬇️ [Start] ${anime.title} Eps ${ep.episode} [${res}]`);

    try {
        await downloadFile(url, tempFile);
        
        const stats = fs.statSync(tempFile);
        if (stats.size < 1000) throw new Error("File corrupt");

        console.log(`   ⬆️ [Upload] ${anime.title} Eps ${ep.episode} [${res}]`);
        const uniqueId = `${anime.slug}-ep${ep.episode}-${res}`;
        
        const uploadedMsg = await client.sendFile(DUMP_CHAT_ID, {
            file: tempFile,
            caption: `🎬 **${anime.title}**\n💿 Episode: ${ep.episode} [${res}]\n🆔 ID: \`${uniqueId}\`\n\n#${anime.slug}`,
            forceDocument: false,
            supportsStreaming: true,
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

        const cleanId = DUMP_CHAT_ID.toString().replace('-100', '');
        const fileLink = `https://t.me/c/${cleanId}/${uploadedMsg.id}`;

        // Update DB (Critical Section - hati-hati race condition)
        // Kita tarik data terbaru lagi biar aman
        const { data: latestAnime } = await supabase.from('mikunime').select('episodes').eq('id', dbAnime.id).single();
        let currentEpisodes = latestAnime.episodes || [];
        
        const epIdx = currentEpisodes.findIndex(e => e.episode === ep.episode);
        let currentEp = epIdx > -1 ? currentEpisodes[epIdx] : { episode: ep.episode, links: {} };
        
        if (!currentEp.links) currentEp.links = {};
        currentEp.links[res] = fileLink;

        if (epIdx > -1) currentEpisodes[epIdx] = currentEp;
        else currentEpisodes.push(currentEp);

        currentEpisodes.sort((a, b) => a.episode - b.episode);

        await supabase.from('mikunime').update({ episodes: currentEpisodes }).eq('id', dbAnime.id);
        
        console.log(`   ✅ [Done] ${anime.title} Eps ${ep.episode} [${res}]`);

    } catch (err) {
        console.error(`   ❌ Gagal ${anime.title} Eps ${ep.episode}: ${err.message}`);
    } finally {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
}

async function processAnime(filePath) {
    const rawData = fs.readFileSync(filePath);
    const anime = JSON.parse(rawData);
    
    console.log(`\n📂 Memulai Anime: ${anime.title}`);

    // Init DB
    let { data: dbAnime } = await supabase.from('mikunime').select('*').eq('title', anime.slug).single();
    if (!dbAnime) {
        const { data: newAnime } = await supabase
            .from('mikunime')
            .insert({ title: anime.slug, poster: anime.poster, synopsis: anime.synopsis, episodes: [] })
            .select().single();
        dbAnime = newAnime;
    }

    // Flatten Tasks (Semua episode & resolusi jadi satu array tugas)
    let tasks = [];
    for (const ep of anime.episodes) {
        for (const [res, url] of Object.entries(ep.streams)) {
            tasks.push(() => processEpisode(anime, ep, res, url, dbAnime, dbAnime.episodes));
        }
    }

    // Eksekusi Tasks dengan Limit (Batching)
    for (let i = 0; i < tasks.length; i += MAX_PARALLEL_EPS) {
        const batch = tasks.slice(i, i + MAX_PARALLEL_EPS);
        await Promise.all(batch.map(task => task()));
    }
}

console.log("🚀 Script dimulai...");

async function start() {
    try {
        console.log('🔄 Menginisialisasi Client...');
        await client.connect(); // Tambahan: Connect eksplisit
        console.log('🔄 Terhubung. Melakukan Login Bot...');
        
        await client.start({
            botAuthToken: BOT_TOKEN,
        });
        console.log('✅ Login Sukses. Mode: MULTI-THREADED SULTAN 🚀');
        
        // Validasi Channel
        try { 
            await client.getEntity(DUMP_CHAT_ID); 
            console.log('✅ Akses Channel OK');
        } 
        catch (e) { 
            console.log('❌ Gagal akses channel:', e.message); 
            // Jangan exit dulu, coba lanjut siapa tau bisa
        }

        const files = fs.readdirSync(JSON_DIR).filter(f => f.endsWith('.json'));
        console.log(`📦 Queue: ${files.length} Anime.`);

        // Parallel Anime Processing
        for (let i = 0; i < files.length; i += MAX_PARALLEL_ANIME) {
            const batchFiles = files.slice(i, i + MAX_PARALLEL_ANIME);
            console.log(`\n--- Batch Baru: Menggarap ${batchFiles.length} Anime Sekaligus ---`);
            await Promise.all(batchFiles.map(file => processAnime(path.join(JSON_DIR, file))));
        }

        console.log('🎉 SEMUA SELESAI!');
    } catch (err) {
        console.error("🔥 FATAL ERROR DI START:", err);
    }
}

start().catch(err => console.error("🔥 Unhandled Rejection:", err));