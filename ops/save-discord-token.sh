#!/usr/bin/env bash
# Saves the Orrery Discord bot token to ~/.secrets/orrery/discord-bot.txt (mode 600) without echoing it.
set -euo pipefail
dir="$HOME/.secrets/orrery"
install -d -m 700 "$dir"
read -rsp "Tempel Bot Token lalu tekan Enter: " token
echo
if [ -z "$token" ]; then echo "Token kosong, tidak ada yang disimpan."; exit 1; fi
umask 077
printf '%s' "$token" > "$dir/discord-bot.txt"
chmod 600 "$dir/discord-bot.txt"
unset token
echo "Tersimpan di $dir/discord-bot.txt (mode 600). Tab ini boleh ditutup."
