#!/bin/bash
# Single click launcher: starts the local server (if it is not already up) and
# opens the app in the default browser.
cd "$(dirname "$0")" || exit 1

PORT="${PORT:-8787}"
URL="http://localhost:${PORT}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установи Node 22+ (https://nodejs.org) и запусти снова."
  read -r -p "Enter — закрыть"
  exit 1
fi

# Already running? Just focus the page.
if curl -s -o /dev/null --max-time 2 "${URL}/api/status"; then
  echo "Приложение уже запущено — открываю ${URL}"
  open "${URL}"
  exit 0
fi

echo "Запускаю сервер на ${URL} …"
node --experimental-strip-types top-radio-app.ts --port "${PORT}" &
SERVER_PID=$!

# Wait for the server to answer before opening the browser
for _ in $(seq 1 40); do
  if curl -s -o /dev/null --max-time 1 "${URL}/api/status"; then break; fi
  sleep 0.25
done

open "${URL}"
echo "Готово. Это окно можно свернуть — закрытие останавливает сервер."
trap 'kill $SERVER_PID 2>/dev/null' EXIT
wait $SERVER_PID
