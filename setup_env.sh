#!/bin/bash

echo "========================================"
echo "   SETTING UP MIKUNIME ENVIRONMENT"
echo "========================================"

echo "Masukkan API_ID (dari my.telegram.org):"
read api_id

echo "Masukkan API_HASH:"
read api_hash

echo "Masukkan BOT_TOKEN (dari @BotFather):"
read bot_token

echo "Masukkan SUPABASE_URL:"
read supabase_url

echo "Masukkan SUPABASE_KEY (service_role):"
read supabase_key

# Buat file .env
echo "Membuat file .env..."

cat > .env <<EOL
API_ID=$api_id
API_HASH=$api_hash
BOT_TOKEN=$bot_token
SUPABASE_URL=$supabase_url
SUPABASE_KEY=$supabase_key
SESSION_STRING=
EOL

echo "✅ File .env berhasil dibuat!"
echo "Sekarang jalankan 'npm install' lalu 'node uploader_v2.js'"