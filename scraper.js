const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// Konfigurasi Target
const BASE_URL = 'https://x3.sokuja.uk';
const LIST_URL = 'https://x3.sokuja.uk/anime/list-mode/';
const OUTPUT_DIR = path.join(__dirname, 'anime_data');

// Pastikan folder output ada
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
}

async function fetchHTML(url) {
    try {
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        return cheerio.load(data);
    } catch (err) {
        console.error(`❌ Gagal fetch URL: ${url} - ${err.message}`);
        return null;
    }
}

async function scrapeAnimeList() {
    console.log(`🔍 Memulai scraping dari: ${LIST_URL}`);
    const $ = await fetchHTML(LIST_URL);
    if (!$) return;

    // Selector mungkin berbeda tergantung struktur web. 
    // Asumsi: List Mode biasanya pakai <ul><li><a href="...">Judul</a></li></ul>
    // Tuan perlu cek inspect element jika ini gagal.
    // Berdasarkan sokuja biasanya ada di .soralist atau sejenisnya.
    
    // Kita coba ambil semua link yang ada di dalam konten utama
    let animeLinks = [];
    
    // Logika umum scraping list
    $('.soralist a.series').each((i, el) => {
        const link = $(el).attr('href');
        const title = $(el).text().trim();
        if (link && title) {
            animeLinks.push({ title, url: link });
        }
    });

    console.log(`✅ Ditemukan ${animeLinks.length} anime.`);

    // AMBIL 5 ANIME PERTAMA SAJA UNTUK TEST (Hapus .slice(0, 5) kalau mau semua)
    const targetAnimes = animeLinks.slice(0, 5); 

    for (const anime of targetAnimes) {
        await scrapeAnimeDetails(anime);
        // Jeda sopan biar gak dikira DDOS
        await new Promise(r => setTimeout(r, 2000));
    }
}

async function scrapeAnimeDetails(animeBasic) {
    console.log(`⏳ Mengambil detail: ${animeBasic.title}...`);
    const $ = await fetchHTML(animeBasic.url);
    if (!$) return;

    // Ambil Metadata (Sesuaikan selector dengan inspect element sokuja)
    const title = $('h1.entry-title').text().trim() || animeBasic.title;
    const poster = $('.thumb img').attr('src');
    const synopsis = $('.entry-content p').text().trim();
    
    // Ambil List Episode
    const episodes = [];
    $('.eplister ul li a').each((i, el) => {
        const epTitle = $(el).find('.epl-title').text().trim(); // Eps 1
        const epUrl = $(el).attr('href');
        const epNumStr = $(el).find('.epl-num').text().trim();
        const epNum = parseInt(epNumStr) || (episodes.length + 1);

        if (epUrl) {
            episodes.push({
                episode: epNum,
                url: epUrl, // Link Halaman Episode (Bukan link video langsung)
                scraped_at: new Date()
            });
        }
    });

    // Susun Data JSON
    const animeData = {
        title: title,
        slug: animeBasic.url.split('/').filter(Boolean).pop(), // Ambil slug dari URL
        url: animeBasic.url,
        poster: poster,
        synopsis: synopsis,
        episodes: episodes.reverse() // Biasanya urutan terbalik di web
    };

    // Simpan ke JSON
    const filename = path.join(OUTPUT_DIR, `${animeData.slug}.json`);
    fs.writeFileSync(filename, JSON.stringify(animeData, null, 2));
    console.log(`💾 Tersimpan: ${filename} (${episodes.length} Episode)`);
}

// Jalankan
scrapeAnimeList();