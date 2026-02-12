require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { downloadFile } = require('./utils/downloader');

// Konfigurasi
const apiId = parseInt(process.env.API_ID);
const apiHash = process.env.API_HASH;
const botToken = process.env.BOT_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const sessionString = new StringSession(process.env.SESSION_STRING || '');

// ID Channel Database (Gudang File)
// Tambahkan -100 jika itu channel private/supergroup
const DUMP_CHAT_ID = BigInt('-1003638979264'); 

// Inisialisasi Supabase
const supabase = createClient(supabaseUrl, supabaseKey);

// Inisialisasi Telegram
const client = new TelegramClient(sessionString, apiId, apiHash, {
    connectionRetries: 5,
});

async function start() {
    console.log('🔄 Menghubungkan ke Telegram...');
    
    await client.start({
        botAuthToken: botToken,
    });
    
    console.log('✅ Bot Siap! Mode Gudang Aktif.');
    console.log(`📂 Target Upload: Channel ID ${DUMP_CHAT_ID}`);

    client.addEventHandler(async (event) => {
        const message = event.message;
        const text = message.text;
        
        if (text && text.startsWith('/add')) {
            const args = text.split(' ');
            if (args.length < 5) {
                return await client.sendMessage(message.chatId, { message: '❌ Format: `/add <slug> <eps> <res> <link>`' });
            }

            const slug = args[1];
            const episodeNum = parseInt(args[2]);
            const resolution = args[3]; 
            const url = args[4];

            if (!['360p', '480p', '720p', '1080p'].includes(resolution)) {
                return await client.sendMessage(message.chatId, { message: '❌ Resolusi salah!' });
            }

            const statusMsg = await client.sendMessage(message.chatId, { message: `⏳ **${slug}**Eps ${episodeNum} [${resolution}]
⬇️ Downloading...` });

            const tempFilePath = path.join(__dirname, `temp_${Date.now()}.mp4`);

            try {
                // 1. Download
                await downloadFile(url, tempFilePath);
                await client.editMessage(message.chatId, { message: statusMsg.id, text: '⬆️ Uploading to Channel...' });

                // 2. Upload ke Channel Database
                const uploadedMsg = await client.sendFile(DUMP_CHAT_ID, {
                    file: tempFilePath,
                    caption: `**${slug}** - Eps ${episodeNum} [${resolution}]
#${slug}`,
                    forceDocument: true
                });

                // 3. Generate Link Postingan
                // Format Link Private Channel: https://t.me/c/CHANNEL_ID/MSG_ID
                // Kita harus menghilangkan '-100' dari ID untuk link web
                const channelIdStr = DUMP_CHAT_ID.toString().replace('-100', '');
                const fileLink = `https://t.me/c/${channelIdStr}/${uploadedMsg.id}`;

                // 4. Update Supabase
                let { data: anime } = await supabase
                    .from('mikunime')
                    .select('*')
                    .eq('title', slug)
                    .single();

                if (!anime) {
                    const { data: newAnime } = await supabase
                        .from('mikunime')
                        .insert({ title: slug, episodes: [] })
                        .select()
                        .single();
                    anime = newAnime;
                }

                let episodes = anime.episodes || [];
                const epIndex = episodes.findIndex(e => e.episode == episodeNum);

                if (epIndex > -1) {
                    if (!episodes[epIndex].links) episodes[epIndex].links = {};
                    episodes[epIndex].links[resolution] = fileLink;
                } else {
                    episodes.push({
                        episode: episodeNum,
                        links: { [resolution]: fileLink }
                    });
                }
                episodes.sort((a, b) => a.episode - b.episode);

                await supabase
                    .from('mikunime')
                    .update({ episodes: episodes })
                    .eq('id', anime.id);

                await client.editMessage(message.chatId, { message: statusMsg.id, text: `✅ **SELESAI!**

📂 Disimpan di Channel
🔗 Link: ${fileLink}` });

            } catch (err) {
                console.error(err);
                await client.sendMessage(message.chatId, { message: `❌ Error: ${err.message}` });
            } finally {
                if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            }
        }
    }, new NewMessage({}));
}

start();